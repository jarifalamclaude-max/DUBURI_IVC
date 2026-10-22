/*
 * test_core.c - unit + loopback tests for the modem core, run on a PC:
 *     make -C tests && ./tests/test_core
 * The modem core file is the SAME file that the ESP32 firmware compiles.
 */
#include "../firmware/DuburiModem/am_core.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int fails = 0;
#define CHECK(cond, ...)                                  \
    do {                                                  \
        if (!(cond)) {                                    \
            fails++;                                      \
            printf("FAIL %s:%d: ", __FILE__, __LINE__);   \
            printf(__VA_ARGS__);                          \
            printf("\n");                                 \
        }                                                 \
    } while (0)

static uint32_t rng = 12345;
static double urand(void) { rng = rng * 1664525u + 1013904223u; return ((double)(rng >> 8) + 0.5) / 16777216.0; }
static double grand(void) { return sqrt(-2.0 * log(urand())) * cos(6.283185307179586 * urand()); }

static void test_crc(void)
{
    const char *s = "123456789";
    CHECK(am_crc16((const uint8_t *)s, 9) == 0x29B1, "crc16 check value 0x%04X", am_crc16((const uint8_t *)s, 9));
}

static void test_conv(void)
{
    uint8_t bits[AM_INFO_BITS], coded[AM_CODED_BITS], out[AM_INFO_BITS];
    float llr[AM_CODED_BITS];
    for (int trial = 0; trial < 3000; trial++) {
        for (int i = 0; i < AM_INFO_BITS; i++) bits[i] = (i >= AM_INFO_BITS - 6) ? 0 : (urand() < 0.5);
        am_conv_encode(bits, AM_INFO_BITS, coded);
        int nerr = trial % 5;          /* 0..4 hard errors, at least 12 bits apart */
        for (int c = 0; c < AM_CODED_BITS; c++) llr[c] = coded[c] ? -1.0f : 1.0f;
        int base = (int)(urand() * 12);
        for (int e = 0; e < nerr; e++) {
            int c = base + e * 24;
            llr[c] = -llr[c];
        }
        am_viterbi(llr, AM_INFO_BITS, out);
        CHECK(memcmp(bits, out, sizeof(bits)) == 0, "viterbi trial %d with %d errors", trial, nerr);
    }
    /* free distance: flipping one info bit changes >= 10 coded bits */
    for (int i = 0; i < AM_INFO_BITS - 6; i++) {
        uint8_t a[AM_INFO_BITS] = {0}, ca[AM_CODED_BITS], cb[AM_CODED_BITS];
        am_conv_encode(a, AM_INFO_BITS, ca);
        a[i] = 1;
        am_conv_encode(a, AM_INFO_BITS, cb);
        int d = 0;
        for (int c = 0; c < AM_CODED_BITS; c++) d += ca[c] != cb[c];
        CHECK(d >= 10, "single input bit %d changes only %d coded bits", i, d);
    }
    /* interleaver is a permutation */
    int seen[AM_CODED_BITS] = {0};
    for (int c = 0; c < AM_CODED_BITS; c++) {
        int t = am_interleave(c);
        CHECK(t >= 0 && t < AM_CODED_BITS && !seen[t], "interleaver collision at %d", c);
        if (t >= 0 && t < AM_CODED_BITS) seen[t] = 1;
    }
    /* neighbouring coded bits land in different slots and hop sets */
    for (int c = 0; c + 1 < AM_CODED_BITS; c++) {
        int s0 = am_interleave(c) / 2, s1 = am_interleave(c + 1) / 2;
        CHECK(s0 != s1 && (s0 % AM_NSETS) != (s1 % AM_NSETS), "interleaver neighbours %d", c);
    }
}

static void test_pack(void)
{
    for (int i = 0; i < 2000; i++) {
        am_packet_t p = {(uint8_t)(i & 15), (uint8_t)((i >> 4) & 15), (uint8_t)((i >> 8) & 15),
                         (uint8_t)(i % 13), (uint8_t)(i * 7), (uint8_t)(i * 31)};
        uint8_t f[AM_FRAME_BYTES];
        am_pack(&p, f);
        am_packet_t q;
        CHECK(am_unpack(f, &q) == 1, "unpack crc");
        CHECK(memcmp(&p, &q, sizeof(p)) == 0, "pack/unpack mismatch %d", i);
        f[i % AM_FRAME_BYTES] ^= (uint8_t)(1 << (i % 8));
        CHECK(am_unpack(f, &q) == 0, "crc must catch 1-bit error");
    }
}

/* interleaver is a permutation and spreads every codeword over 8 slots */
static void test_interleaver(void)
{
    /* recover the mapping by sending one-hot nibble patterns is awkward, so
     * check through the public TX: flipping one payload bit must change
     * the tones of several slots (the code spreads every bit). */
    am_packet_t p = {0, 0, 0, 0, 0, 0};
    uint8_t a[AM_TOTAL_SLOTS], b[AM_TOTAL_SLOTS];
    am_tx_build(&p, a);
    for (int bit = 0; bit < 32; bit++) {
        am_packet_t q = p;
        uint8_t *f = (uint8_t *)&q;
        (void)f;
        if (bit < 4) q.src = (uint8_t)(1 << bit);
        else if (bit < 8) q.dst = (uint8_t)(1 << (bit - 4));
        else if (bit < 12) q.flags = (uint8_t)(1 << (bit - 8));
        else if (bit < 16) q.seq = (uint8_t)(1 << (bit - 12));
        else if (bit < 24) q.cmd = (uint8_t)(1 << (bit - 16));
        else q.arg = (uint8_t)(1 << (bit - 24));
        am_tx_build(&q, b);
        int changed = 0;
        for (int k = AM_PRE_LEN; k < AM_TOTAL_SLOTS; k++) changed += (a[k] != b[k]);
        CHECK(changed >= 4, "payload bit %d changes only %d slots (needs spreading)", bit, changed);
    }
}

static void test_tx_build(void)
{
    am_packet_t p = {2, 1, 5, AM_FLAG_ACK_REQ, 3, 200};
    uint8_t t[AM_TOTAL_SLOTS];
    am_tx_build(&p, t);
    for (int i = 0; i < AM_PRE_LEN; i++) CHECK(t[i] == am_preamble[i], "preamble slot %d", i);
    for (int k = 0; k < AM_DATA_SLOTS; k++) {
        int tone = t[AM_PRE_LEN + k];
        CHECK(tone < AM_NTONES, "tone range");
        CHECK(tone % AM_NSETS == k % AM_NSETS, "slot %d uses wrong hop set", k);
    }
    /* preamble tones distinct; data of another packet can match <= 2 slots */
    for (int a = 0; a < AM_PRE_LEN; a++)
        for (int b = a + 1; b < AM_PRE_LEN; b++) CHECK(am_preamble[a] != am_preamble[b], "preamble repeats");
    for (int c = 0; c < AM_NSETS; c++) {
        int m = 0;
        for (int j = 0; j < AM_PRE_LEN; j++) m += (am_preamble[j] % AM_NSETS) == ((j + c) % AM_NSETS);
        CHECK(m <= 2, "preamble/data alignment %d matches %d slots", c, m);
    }
    /* echo rule: a preamble tone's hop set is not reused by data for 6 slots */
    for (int j = 0; j < AM_PRE_LEN; j++)
        for (int i = 0; i < AM_DATA_SLOTS; i++)
            if (i % AM_NSETS == am_preamble[j] % AM_NSETS)
                CHECK(i + AM_PRE_LEN - j >= AM_NSETS, "preamble slot %d echo hits data slot %d", j, i);
}

/* ---- loopback: synthesise the waveform the ESP32 would receive ---------- */
static void synth(const uint8_t *tones, int nslots, double fs_true, double amp, double noise,
                  int lead, int tail, uint16_t **out, int *n_out, int square)
{
    int n = lead + (int)(nslots * (double)AM_T_SLOT * fs_true) + tail;
    uint16_t *x = malloc(sizeof(uint16_t) * n);
    double ph = 0;
    for (int i = 0; i < n; i++) {
        double t = (i - lead) / fs_true;
        double s = 0;
        if (i >= lead) {
            int k = (int)floor(t / (double)AM_T_SLOT);
            if (k < nslots) {
                ph += 2 * 3.141592653589793 * (double)am_tone_hz(tones[k]) / fs_true;
                s = square ? (sin(ph) >= 0 ? 1.0 : -1.0) * 0.785 : sin(ph);
            }
        }
        double v = 1600 + amp * s + noise * grand();
        if (v < 0) v = 0;
        if (v > 4095) v = 4095;
        x[i] = (uint16_t)lrint(v);
    }
    *out = x;
    *n_out = n;
}

static int run_loopback(double fs_true, double fs_rx, double amp, double noise, int chunk, int square)
{
    static am_rx_t rx;
    am_rx_init(&rx, (float)fs_rx);
    am_packet_t p = {1, 2, 9, AM_FLAG_ACK_REQ, 1, 77};
    uint8_t t[AM_TOTAL_SLOTS];
    am_tx_build(&p, t);
    uint16_t *x;
    int n;
    synth(t, AM_TOTAL_SLOTS, fs_true, amp, noise, 30000, 20000, &x, &n, square);
    for (int i = 0; i < n; i += chunk) am_rx_process(&rx, x + i, (n - i < chunk) ? n - i : chunk);
    free(x);
    am_rx_result_t r;
    int ok = am_rx_pop(&rx, &r) && memcmp(&r.pkt, &p, sizeof(p)) == 0;
    return ok;
}

int main(void)
{
    test_crc();
    test_conv();
    test_pack();
    test_tx_build();
    test_interleaver();

    CHECK(run_loopback(50000, 50000, 300, 3, 512, 0), "clean loopback");
    CHECK(run_loopback(50000, 50000, 300, 3, 1, 0), "clean loopback, 1-sample chunks");
    CHECK(run_loopback(50000, 50000, 300, 3, 777, 1), "square-wave loopback");
    CHECK(run_loopback(50750, 50750, 300, 3, 512, 0), "ADC 1.5%% fast, measured");
    CHECK(run_loopback(50750, 50750 * 1.0005, 300, 3, 512, 0), "Fs estimate 0.05%% off");
    CHECK(run_loopback(48000, 48000, 300, 3, 512, 0), "Fs 48 kHz");
    CHECK(run_loopback(50000, 50000, 20, 60, 512, 0), "noisy loopback (~0 dB wideband SNR)");

    /* sanity: no packet out of pure noise */
    {
        static am_rx_t rx;
        am_rx_init(&rx, 50000);
        uint16_t buf[1000];
        int bad = 0;
        for (int s = 0; s < 50000 * 60 / 1000; s++) {   /* 60 s of noise */
            for (int i = 0; i < 1000; i++) buf[i] = (uint16_t)lrint(1600 + 40 * grand());
            am_rx_process(&rx, buf, 1000);
            am_rx_result_t r;
            while (am_rx_pop(&rx, &r)) bad++;
        }
        CHECK(bad == 0, "packets out of noise: %d", bad);
        printf("noise-only 60 s: %u preamble triggers (CRC rejected all)\n", rx.stats.preambles);
    }

    printf("sizeof(am_rx_t) = %d bytes\n", am_rx_sizeof());
    printf(fails ? "\n%d TEST(S) FAILED\n" : "\nALL TESTS PASSED\n", fails);
    return fails ? 1 : 0;
}
