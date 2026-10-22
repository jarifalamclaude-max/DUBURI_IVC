/*
 * am_core.c - DUBURI acoustic modem core. See am_core.h for the overview.
 *
 * Only single-precision float math is used (ESP32 has a float FPU but does
 * double in software, which is ~10x slower).
 */
#include "am_core.h"
#include <math.h>
#include <string.h>

#define AM_PI_F      3.14159265358979f
#define AM_RING_MASK (AM_RING - 1)
#define AM_PEAK_HOPS 14            /* hops collected after a preamble trigger */
#define AM_NOISE_INIT_HOPS 40      /* hops averaged for the first noise floor  */
#define AM_NOISE_ALPHA (1.0f / 256.0f)
#define AM_NOISE_CLIP  8.0f        /* a hop may raise the floor by at most x8  */
#define AM_LLR_CLAMP   20.0f

/* Preamble: 10 different tones, chosen so that
 *  1. neighbouring slots are far apart in frequency;
 *  2. data slots of another packet can never match more than 2 of the 10
 *     slots (their hop sets, tone % 6, do not line up);
 *  3. the echo of a preamble tone is >= 6 slots (120 ms) old before the same
 *     hop set is used by a data slot of this packet. */
const uint8_t am_preamble[AM_PRE_LEN] = {0, 14, 6, 22, 9, 17, 4, 21, 5, 11};

static int32_t sdiff(uint32_t a, uint32_t b) { return (int32_t)(a - b); }

float am_tone_hz(int tone_index)
{
    return AM_F0 + AM_DF * (float)tone_index;
}

/* CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF. "123456789" -> 0x29B1 */
uint16_t am_crc16(const uint8_t *data, int len)
{
    uint16_t crc = 0xFFFF;
    for (int i = 0; i < len; i++) {
        crc ^= (uint16_t)data[i] << 8;
        for (int b = 0; b < 8; b++)
            crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
    }
    return crc;
}

/* ---- Convolutional code, K=7, rate 1/2, generators 171/133 (octal) -------
 * Shift register reg = [newest input | 6 older inputs]. Every input bit gives
 * two output bits = parity of (reg AND generator). Free distance 10: two
 * different messages always differ in at least 10 coded bits. */
#define AM_G0 0x79   /* 171 octal = 1111001 */
#define AM_G1 0x5B   /* 133 octal = 1011011 */
#define AM_NSTATES 64

static int parity7(unsigned v)
{
    v ^= v >> 4;
    v ^= v >> 2;
    v ^= v >> 1;
    return (int)(v & 1u);
}

void am_conv_encode(const uint8_t *bits, int n, uint8_t *coded)
{
    unsigned state = 0;                         /* 6 previous inputs */
    for (int t = 0; t < n; t++) {
        unsigned reg = ((unsigned)(bits[t] & 1) << 6) | state;
        coded[2 * t] = (uint8_t)parity7(reg & AM_G0);
        coded[2 * t + 1] = (uint8_t)parity7(reg & AM_G1);
        state = reg >> 1;
    }
}

/* Viterbi: keeps, for each of the 64 register states, the best-scoring path
 * so far (score = sum of +llr for expected 0 bits, -llr for expected 1 bits).
 * At the end the path that finishes in state 0 (because of the zero tail)
 * is traced back. */
void am_viterbi(const float *llr, int n, uint8_t *bits)
{
    uint64_t dec[AM_INFO_BITS];                 /* chosen predecessor bit per state */
    float pm[AM_NSTATES], npm[AM_NSTATES];
    if (n > AM_INFO_BITS) n = AM_INFO_BITS;
    for (int s = 0; s < AM_NSTATES; s++) pm[s] = -1e30f;
    pm[0] = 0.0f;
    for (int t = 0; t < n; t++) {
        const float l0 = llr[2 * t], l1 = llr[2 * t + 1];
        uint64_t d = 0;
        for (int ns = 0; ns < AM_NSTATES; ns++) {
            unsigned u = (unsigned)ns >> 5;                  /* input bit that led here */
            float best = -1e30f;
            int bestb = 0;
            for (int b = 0; b < 2; b++) {
                unsigned ps = (((unsigned)ns & 31u) << 1) | (unsigned)b;
                unsigned reg = (u << 6) | ps;
                float m = pm[ps] + (parity7(reg & AM_G0) ? -l0 : l0) + (parity7(reg & AM_G1) ? -l1 : l1);
                if (m > best) { best = m; bestb = b; }
            }
            npm[ns] = best;
            if (bestb) d |= (uint64_t)1 << ns;
        }
        dec[t] = d;
        memcpy(pm, npm, sizeof(pm));
    }
    unsigned s = 0;                                          /* zero tail -> end in state 0 */
    for (int t = n - 1; t >= 0; t--) {
        bits[t] = (uint8_t)(s >> 5);
        unsigned b = (unsigned)((dec[t] >> s) & 1u);
        s = ((s & 31u) << 1) | b;
    }
}

void am_pack(const am_packet_t *p, uint8_t frame[AM_FRAME_BYTES])
{
    frame[0] = (uint8_t)(((p->dst & 0xF) << 4) | (p->src & 0xF));
    frame[1] = (uint8_t)(((p->seq & 0xF) << 4) | (p->flags & 0xF));
    frame[2] = p->cmd;
    frame[3] = p->arg;
    uint16_t crc = am_crc16(frame, AM_PAYLOAD_BYTES);
    frame[4] = (uint8_t)(crc >> 8);
    frame[5] = (uint8_t)(crc & 0xFF);
}

int am_unpack(const uint8_t frame[AM_FRAME_BYTES], am_packet_t *p)
{
    uint16_t crc = am_crc16(frame, AM_PAYLOAD_BYTES);
    p->dst = frame[0] >> 4;
    p->src = frame[0] & 0xF;
    p->seq = frame[1] >> 4;
    p->flags = frame[1] & 0xF;
    p->cmd = frame[2];
    p->arg = frame[3];
    return (frame[4] == (uint8_t)(crc >> 8)) && (frame[5] == (uint8_t)(crc & 0xFF));
}

/* Interleaver. Stream bits 2k (MSB) and 2k+1 (LSB) form slot k's 2-bit value;
 * slot k uses hop set k % 6. Coded bit c goes to slot (37*c) mod 54, MSB if
 * c < 54 else LSB. Neighbouring coded bits (which the Viterbi decoder needs
 * together) land >= 3 slots apart and in different hop sets, so one faded
 * frequency or one noise burst only produces scattered errors. */
int am_interleave(int c)
{
    int slot = (37 * c) % AM_DATA_SLOTS;
    return 2 * slot + (c >= AM_DATA_SLOTS ? 1 : 0);
}

static void frame_to_bits(const uint8_t frame[AM_FRAME_BYTES], uint8_t bits[AM_INFO_BITS])
{
    for (int i = 0; i < AM_FRAME_BYTES * 8; i++)
        bits[i] = (frame[i >> 3] >> (7 - (i & 7))) & 1;
    for (int i = AM_FRAME_BYTES * 8; i < AM_INFO_BITS; i++)
        bits[i] = 0;                                         /* tail */
}

void am_tx_build(const am_packet_t *p, uint8_t tones[AM_TOTAL_SLOTS])
{
    uint8_t frame[AM_FRAME_BYTES];
    uint8_t info[AM_INFO_BITS];
    uint8_t coded[AM_CODED_BITS];
    uint8_t stream[AM_CODED_BITS];

    am_pack(p, frame);
    frame_to_bits(frame, info);
    am_conv_encode(info, AM_INFO_BITS, coded);
    for (int c = 0; c < AM_CODED_BITS; c++)
        stream[am_interleave(c)] = coded[c];

    for (int i = 0; i < AM_PRE_LEN; i++)
        tones[i] = am_preamble[i];
    for (int k = 0; k < AM_DATA_SLOTS; k++) {
        int v = (stream[2 * k] << 1) | stream[2 * k + 1];
        tones[AM_PRE_LEN + k] = (uint8_t)((k % AM_NSETS) + AM_NSETS * v);
    }
}

/* ======================================================================= */
/*                               Receiver                                  */
/* ======================================================================= */

static void rx_configure(am_rx_t *rx, float fs)
{
    rx->fs = fs;
    rx->W = (int)lrintf(AM_T_WIN * fs);
    if (rx->W > AM_W_MAX) rx->W = AM_W_MAX;
    rx->H = (int)lrintf(AM_T_HOP * fs);
    rx->D = (int)lrintf(AM_T_TRACK * fs);
    rx->S = AM_T_SLOT * fs;
    for (int n = 0; n < rx->W; n++)
        rx->win[n] = 0.5f - 0.5f * cosf(2.0f * AM_PI_F * ((float)n + 0.5f) / (float)rx->W);
    for (int k = 0; k < AM_NTONES; k++)
        rx->coef[k] = 2.0f * cosf(2.0f * AM_PI_F * am_tone_hz(k) / fs);
    for (int j = 0; j < AM_PRE_LEN; j++)
        rx->pre_off[j] = (int)lrintf((float)(AM_PRE_LEN - 1 - j) * rx->S / (float)rx->H);
}

static void rx_reset_search(am_rx_t *rx)
{
    rx->state = AM_ST_SEARCH;
    rx->hop_count = 0;
    rx->pk_n = 0;
    rx->next_hop = rx->n + (uint32_t)rx->H;
}

void am_rx_init(am_rx_t *rx, float fs)
{
    memset(rx, 0, sizeof(*rx));
    rx_configure(rx, fs);
    rx->dc = -1.0f;                 /* "not started": first sample sets it */
    rx_reset_search(rx);
}

int am_rx_set_fs(am_rx_t *rx, float fs)
{
    if (rx->state != AM_ST_SEARCH || fs < 20000.0f || fs > 62000.0f)
        return 0;
    rx_configure(rx, fs);
    rx_reset_search(rx);
    return 1;
}

int am_rx_sizeof(void) { return (int)sizeof(am_rx_t); }
int am_rx_state(const am_rx_t *rx) { return rx->state; }
void am_rx_get_stats(const am_rx_t *rx, am_stats_t *out) { *out = rx->stats; }

void am_rx_mute(am_rx_t *rx, uint32_t samples)
{
    rx->mute_until = rx->n + samples;
    rx->muted = 1;
    rx->state = AM_ST_SEARCH;       /* abandon anything half-received */
}

int am_rx_pop(am_rx_t *rx, am_rx_result_t *out)
{
    if (rx->out_count == 0) return 0;
    *out = rx->outq[rx->out_head];
    rx->out_head = (rx->out_head + 1) % AM_OUTQ;
    rx->out_count--;
    return 1;
}

/* Goertzel energy of `nt` tones over the W samples that end at sample `end`. */
static void rx_energies(am_rx_t *rx, uint32_t end, const uint8_t *tones, int nt, float *E)
{
    const int W = rx->W;
    uint32_t start = end - (uint32_t)W;
    for (int i = 0; i < W; i++)
        rx->xw[i] = rx->ring[(start + (uint32_t)i) & AM_RING_MASK] * rx->win[i];
    for (int t = 0; t < nt; t++) {
        const float c = rx->coef[tones[t]];
        float s1 = 0.0f, s2 = 0.0f;
        for (int i = 0; i < W; i++) {
            float s0 = rx->xw[i] + c * s1 - s2;
            s2 = s1;
            s1 = s0;
        }
        E[t] = s1 * s1 + s2 * s2 - c * s1 * s2 + 1e-3f;
    }
}

static const uint8_t all_tones[AM_NTONES] = {
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23};

static void rx_finish_peak(am_rx_t *rx);
static void rx_decode_slot(am_rx_t *rx);

static uint32_t rx_slot_end(const am_rx_t *rx, int slot)
{
    return rx->sync_base + (uint32_t)(int32_t)lrintf(rx->sync_frac + rx->track_adj + (float)(slot + 1) * rx->S);
}

/* One preamble-search step: called every H samples. */
static void rx_hop(am_rx_t *rx)
{
    float E[AM_NTONES], z[AM_NTONES];
    rx_energies(rx, rx->n, all_tones, AM_NTONES, E);

    /* Noise floor per tone. Learned only while nothing is being received. */
    if (rx->state == AM_ST_SEARCH) {
        if (rx->noise_init < AM_NOISE_INIT_HOPS) {
            float k = 1.0f / (float)(rx->noise_init + 1);
            for (int i = 0; i < AM_NTONES; i++)
                rx->noise[i] += (E[i] - rx->noise[i]) * k;
            rx->noise_init++;
            rx->next_hop += (uint32_t)rx->H;
            return;
        }
        for (int i = 0; i < AM_NTONES; i++) {
            float e = E[i];
            if (e > AM_NOISE_CLIP * rx->noise[i]) e = AM_NOISE_CLIP * rx->noise[i];
            rx->noise[i] += (e - rx->noise[i]) * AM_NOISE_ALPHA;
        }
    }

    /* Whitening: each tone compared with its own noise floor. */
    float sum = 0.0f, zmax = 0.0f;
    int amax = 0;
    for (int i = 0; i < AM_NTONES; i++) {
        z[i] = E[i] / rx->noise[i];
        rx->scope_db[i] = 10.0f * log10f(z[i]);
        sum += z[i];
        if (z[i] > zmax) { zmax = z[i]; amax = i; }
    }

    int hi = (int)(rx->hop_count % AM_HIST);
    for (int j = 0; j < AM_PRE_LEN; j++)
        rx->hist_frac[hi][j] = z[am_preamble[j]] / sum;
    rx->hist_amax[hi] = (uint8_t)amax;
    rx->hist_end[hi] = rx->n;

    if (rx->hop_count >= (uint32_t)rx->pre_off[0]) {
        float score = 0.0f;
        int match = 0;
        for (int j = 0; j < AM_PRE_LEN; j++) {
            int h = (int)((rx->hop_count - (uint32_t)rx->pre_off[j]) % AM_HIST);
            score += rx->hist_frac[h][j];
            match += (rx->hist_amax[h] == am_preamble[j]);
        }
        score *= 1.0f / (float)AM_PRE_LEN;

        if (rx->state == AM_ST_SEARCH && score >= AM_DET_SCORE_MIN && match >= AM_DET_MATCH_MIN) {
            rx->state = AM_ST_PEAK;
            rx->pk_n = 0;
        }
        if (rx->state == AM_ST_PEAK) {
            rx->pk_score[rx->pk_n] = score;
            rx->pk_end[rx->pk_n] = rx->n;
            rx->pk_n++;
        }
    }
    rx->hop_count++;
    rx->next_hop += (uint32_t)rx->H;

    if (rx->state == AM_ST_PEAK && rx->pk_n >= AM_PEAK_HOPS)
        rx_finish_peak(rx);
}

/* The score is flat-topped around the true start; use the centre of the top. */
static void rx_finish_peak(am_rx_t *rx)
{
    int m = 0;
    for (int i = 1; i < rx->pk_n; i++)
        if (rx->pk_score[i] > rx->pk_score[m]) m = i;
    float top = rx->pk_score[m];
    float lim = 0.85f * top;
    int l = m, r = m;
    while (l > 0 && rx->pk_score[l - 1] >= lim) l--;
    while (r < rx->pk_n - 1 && rx->pk_score[r + 1] >= lim) r++;
    float base = 0.7f * top, wsum = 0.0f, isum = 0.0f;
    for (int i = l; i <= r; i++) {
        float w = rx->pk_score[i] - base;
        wsum += w;
        isum += w * (float)(i - l);
    }
    float c = (wsum > 0.0f) ? isum / wsum : 0.0f;

    rx->sync_base = rx->pk_end[l];
    rx->sync_frac = c * (float)rx->H;
    rx->track_adj = 0.0f;
    rx->slot = 0;
    rx->state = AM_ST_DECODE;
    rx->stats.preambles++;
    rx->next_hop = rx_slot_end(rx, 0) + (uint32_t)rx->D;
}

static float maxf(float a, float b) { return a > b ? a : b; }

static void rx_finish_packet(am_rx_t *rx)
{
    float cl[AM_CODED_BITS];
    uint8_t info[AM_INFO_BITS];
    uint8_t frame[AM_FRAME_BYTES] = {0};
    for (int c = 0; c < AM_CODED_BITS; c++)
        cl[c] = rx->llr[am_interleave(c)];
    am_viterbi(cl, AM_INFO_BITS, info);
    for (int i = 0; i < AM_FRAME_BYTES * 8; i++)
        frame[i >> 3] |= (uint8_t)(info[i] << (7 - (i & 7)));

    /* median of per-slot quality (insertion sort, 48 values) */
    float q[AM_DATA_SLOTS];
    memcpy(q, rx->slot_q, sizeof(q));
    for (int i = 1; i < AM_DATA_SLOTS; i++) {
        float v = q[i];
        int j = i - 1;
        while (j >= 0 && q[j] > v) { q[j + 1] = q[j]; j--; }
        q[j + 1] = v;
    }
    float qmed = 0.5f * (q[AM_DATA_SLOTS / 2 - 1] + q[AM_DATA_SLOTS / 2]);

    am_packet_t p;
    if (am_unpack(frame, &p)) {
        rx->stats.packets_ok++;
        rx->stats.last_q_db = qmed;
        rx->stats.last_timing_adj = rx->track_adj;
        if (rx->out_count < AM_OUTQ) {
            int idx = (rx->out_head + rx->out_count) % AM_OUTQ;
            rx->outq[idx].pkt = p;
            rx->outq[idx].q_db = qmed;
            rx->out_count++;
        }
    } else {
        rx->stats.crc_fail++;
    }
    rx_reset_search(rx);
}

static void rx_decode_slot(am_rx_t *rx)
{
    const int i = rx->slot;
    const int set = i % AM_NSETS;
    uint8_t tones[AM_M];
    float Ec[AM_M], Ee[AM_M], El[AM_M], z[AM_M], lz[AM_M];
    for (int v = 0; v < AM_M; v++)
        tones[v] = (uint8_t)(set + AM_NSETS * v);

    uint32_t e = rx_slot_end(rx, i);
    rx_energies(rx, e, tones, AM_M, Ec);
    int vhat = 0;
    for (int v = 0; v < AM_M; v++) {
        z[v] = Ec[v] / rx->noise[tones[v]];
        lz[v] = logf(z[v]);
        if (z[v] > z[vhat]) vhat = v;
    }

    float l1 = maxf(lz[0], lz[1]) - maxf(lz[2], lz[3]);  /* MSB: 0 for v=0,1 */
    float l0 = maxf(lz[0], lz[2]) - maxf(lz[1], lz[3]);  /* LSB: 0 for v=0,2 */
    if (l1 > AM_LLR_CLAMP) l1 = AM_LLR_CLAMP;
    if (l1 < -AM_LLR_CLAMP) l1 = -AM_LLR_CLAMP;
    if (l0 > AM_LLR_CLAMP) l0 = AM_LLR_CLAMP;
    if (l0 < -AM_LLR_CLAMP) l0 = -AM_LLR_CLAMP;
    rx->llr[2 * i] = l1;
    rx->llr[2 * i + 1] = l0;
    rx->slot_q[i] = 10.0f * log10f(maxf(z[vhat] - 1.0f, 1e-3f));

#if AM_TRACK_ENABLE
    /* Early/late gate: if the window shifted 1 ms later catches more of the
     * winning tone than the one shifted 1 ms earlier, we are a bit early. */
    if (z[vhat] > 4.0f) {
        uint8_t tv = tones[vhat];
        rx_energies(rx, e - (uint32_t)rx->D, &tv, 1, Ee);
        rx_energies(rx, e + (uint32_t)rx->D, &tv, 1, El);
        float err = (El[0] - Ee[0]) / (El[0] + Ee[0]);
        rx->track_adj += 0.25f * (float)rx->D * err;
        float lim = 0.25f * rx->S;
        if (rx->track_adj > lim) rx->track_adj = lim;
        if (rx->track_adj < -lim) rx->track_adj = -lim;
    }
#else
    (void)Ee;
    (void)El;
#endif

    rx->slot++;
    if (rx->slot >= AM_DATA_SLOTS)
        rx_finish_packet(rx);
    else
        rx->next_hop = rx_slot_end(rx, rx->slot) + (uint32_t)rx->D;
}

void am_rx_process(am_rx_t *rx, const uint16_t *x, int count)
{
    for (int k = 0; k < count; k++) {
        uint16_t raw = x[k];
        if (raw <= 8 || raw >= 4087) rx->stats.clipped++;
        float xf = (float)raw;
        if (rx->dc < 0.0f) rx->dc = xf;
        rx->dc += (xf - rx->dc) * (1.0f / 1024.0f);
        rx->ring[rx->n & AM_RING_MASK] = xf - rx->dc;
        rx->n++;

        if (rx->muted) {
            if (sdiff(rx->n, rx->mute_until) < 0) continue;
            rx->muted = 0;
            rx_reset_search(rx);
            continue;
        }
        while (sdiff(rx->n, rx->next_hop) >= 0) {
            if (rx->state == AM_ST_DECODE) rx_decode_slot(rx);
            else rx_hop(rx);
        }
    }
}

#ifdef AM_SIM
/* PC simulator only: copy out the soft bits and slot qualities of the last packet. */
void am_rx_debug(const am_rx_t *rx, float llr[AM_CODED_BITS], float slot_q[AM_DATA_SLOTS], float *track_adj)
{
    memcpy(llr, rx->llr, sizeof(rx->llr));
    memcpy(slot_q, rx->slot_q, sizeof(rx->slot_q));
    *track_adj = rx->track_adj;
}
#endif
