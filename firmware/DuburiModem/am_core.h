/*
 * am_core.h - DUBURI acoustic modem core (portable C99, no Arduino/ESP32 code).
 *
 * The same file is compiled into the ESP32 firmware AND into the PC test
 * harness (tests/ and sim/), so what we test on the PC is exactly what runs
 * on the vehicle.
 *
 * Signal design (see the PDF guide for the "why"):
 *   - 24 tones, 3000 Hz ... 8750 Hz, 250 Hz apart.
 *   - Time is cut into 20 ms "slots"; exactly one tone plays per slot.
 *   - Preamble: 10 slots, fixed tone pattern (used to find the packet start).
 *   - Data: 54 slots. Slot i uses hop-set (i % 6); each hop-set has 4 tones,
 *     so one slot carries 2 bits (4-FSK with frequency hopping).
 *   - 4 payload bytes + CRC-16 = 48 bits, + 6 zero "tail" bits = 54 bits,
 *     protected by a rate-1/2, K=7 convolutional code (the classic 171/133
 *     code used by Wi-Fi and space probes) -> 108 coded bits -> 54 slots.
 *   - The receiver uses soft-decision Viterbi decoding.
 *   - Coded bits are interleaved (spread in time and frequency) so that one
 *     faded tone or one noisy slot only damages scattered bits.
 */
#ifndef AM_CORE_H
#define AM_CORE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---------------- Fixed signal parameters (TX and RX must match) -------- */
#define AM_FS_NOMINAL     50000.0f  /* RX ADC sample rate we ask for (Hz)   */
#define AM_T_SLOT         0.020f    /* one symbol slot (s)                  */
#define AM_T_WIN          0.016f    /* analysis window inside a slot (s)    */
#define AM_T_HOP          0.0025f   /* preamble search step (s)             */
#define AM_T_TRACK        0.001f    /* early/late offset for timing (s)     */

#define AM_F0             3000.0f   /* lowest tone (Hz)                     */
#define AM_DF             250.0f    /* tone spacing (Hz)                    */
#define AM_NTONES         24        /* tones 0..23 -> 3000..8750 Hz         */
#define AM_NSETS          6         /* frequency-hopping sets               */
#define AM_M              4         /* tones per set (2 bits per slot)      */

#define AM_PRE_LEN        10        /* preamble slots                       */
#define AM_PAYLOAD_BYTES  4
#define AM_FRAME_BYTES    6         /* payload + CRC16                      */
#define AM_K              7         /* convolutional code constraint length */
#define AM_INFO_BITS      (AM_FRAME_BYTES * 8 + AM_K - 1)  /* 54 incl. tail */
#define AM_CODED_BITS     (2 * AM_INFO_BITS)                /* 108          */
#define AM_DATA_SLOTS     (AM_CODED_BITS / 2)               /* 54           */
#define AM_TOTAL_SLOTS    (AM_PRE_LEN + AM_DATA_SLOTS)   /* 64 -> 1.28 s     */

/* ---------------- Receiver tuning (validated by sim/run_sim.py) --------- */
#ifndef AM_DET_SCORE_MIN
#define AM_DET_SCORE_MIN  0.14f     /* preamble score threshold (0..1)      */
#endif
#ifndef AM_DET_MATCH_MIN
#define AM_DET_MATCH_MIN  5         /* preamble slots whose tone must win   */
#endif
#ifndef AM_TRACK_ENABLE
#define AM_TRACK_ENABLE   1         /* early/late timing tracking on/off    */
#endif

/* ---------------- Buffers (sized for Fs up to ~60 kHz) ------------------ */
#define AM_RING           4096      /* power of two                         */
#define AM_W_MAX          1024
#define AM_HIST           128       /* preamble search history (hops)       */
#define AM_OUTQ           4         /* decoded packets waiting to be read   */

/* ---------------- Packet ------------------------------------------------ */
#define AM_ADDR_BROADCAST 15
#define AM_FLAG_ACK_REQ   0x8       /* sender wants an ACK back             */
#define AM_FLAG_IS_ACK    0x4       /* this packet IS an ACK                */

typedef struct {
    uint8_t dst;    /* 0..15 (15 = everyone)               */
    uint8_t src;    /* 0..15                               */
    uint8_t seq;    /* 0..15, used to drop repeats         */
    uint8_t flags;  /* 0..15, AM_FLAG_*                    */
    uint8_t cmd;    /* 0..255, your command number         */
    uint8_t arg;    /* 0..255, command argument            */
} am_packet_t;

/* ---------------- Coding helpers (used by TX and RX) -------------------- */
float    am_tone_hz(int tone_index);
uint16_t am_crc16(const uint8_t *data, int len);       /* CRC-16/CCITT-FALSE */
/* Convolutional code: n info bits -> 2n coded bits (encoder starts in state 0). */
void     am_conv_encode(const uint8_t *bits, int n, uint8_t *coded);
/* Soft Viterbi: llr[2n] (llr>0 means bit=0) -> n bits; assumes zero tail. */
void     am_viterbi(const float *llr, int n, uint8_t *bits);
/* Interleaver: coded bit c (0..107) -> stream position (2*slot + 0 MSB/1 LSB). */
int      am_interleave(int c);
void     am_pack(const am_packet_t *p, uint8_t frame[AM_FRAME_BYTES]);
int      am_unpack(const uint8_t frame[AM_FRAME_BYTES], am_packet_t *p); /* 1 = CRC ok */
extern const uint8_t am_preamble[AM_PRE_LEN];

/* ---------------- Transmitter -------------------------------------------
 * Fills tones[] with the tone index (0..23) to play in each 20 ms slot.
 * The firmware plays am_tone_hz(tones[i]) for slot i.
 */
void am_tx_build(const am_packet_t *p, uint8_t tones[AM_TOTAL_SLOTS]);

/* ---------------- Receiver ---------------------------------------------- */
enum { AM_ST_SEARCH = 0, AM_ST_PEAK = 1, AM_ST_DECODE = 2 };

typedef struct {
    uint32_t preambles;     /* preamble detections                         */
    uint32_t packets_ok;    /* CRC passed                                  */
    uint32_t crc_fail;      /* preamble found but CRC failed               */
    uint32_t clipped;       /* ADC samples near 0 or 4095                  */
    float    last_q_db;     /* link quality of last packet (dB)            */
    float    last_timing_adj; /* samples moved by timing tracker           */
} am_stats_t;

typedef struct {
    am_packet_t pkt;
    float       q_db;       /* median per-slot SNR of the decided tones    */
} am_rx_result_t;

typedef struct {
    /* configuration derived from the sample rate */
    float    fs;
    int      W, H, D;               /* window, hop, early/late offset      */
    float    S;                     /* samples per slot (not an integer)   */
    float    coef[AM_NTONES];       /* Goertzel 2cos(w)                    */
    float    win[AM_W_MAX];         /* Hann window                         */
    int      pre_off[AM_PRE_LEN];   /* hop offset of each preamble slot    */

    /* input conditioning */
    float    ring[AM_RING];
    uint32_t n;                     /* total samples received              */
    float    dc;
    float    xw[AM_W_MAX];          /* scratch: windowed samples           */

    /* noise floor per tone (for whitening) */
    float    noise[AM_NTONES];
    uint32_t noise_init;
    float    scope_db[AM_NTONES];   /* last whitened levels (for debug)    */

    /* preamble search */
    int      state;
    uint32_t next_hop;
    uint32_t hop_count;
    float    hist_frac[AM_HIST][AM_PRE_LEN];
    uint8_t  hist_amax[AM_HIST];
    uint32_t hist_end[AM_HIST];
    float    pk_score[24];
    uint32_t pk_end[24];
    int      pk_n;
    float    pk_best;
    int      pk_below;

    /* decoding */
    uint32_t sync_base;             /* sample index of end of last preamble window */
    float    sync_frac;
    int      slot;
    float    llr[AM_CODED_BITS];
    float    slot_q[AM_DATA_SLOTS];
    float    track_adj;

    /* mute (while we transmit ourselves) */
    uint32_t mute_until;
    int      muted;

    /* output */
    am_rx_result_t outq[AM_OUTQ];
    int      out_head, out_count;
    am_stats_t stats;
} am_rx_t;

void am_rx_init(am_rx_t *rx, float fs);
/* Change the sample rate estimate (firmware measures the real ADC rate).
 * Ignored while a packet is being decoded; returns 1 if applied. */
int  am_rx_set_fs(am_rx_t *rx, float fs);
/* Feed raw 12-bit ADC samples (0..4095). */
void am_rx_process(am_rx_t *rx, const uint16_t *x, int count);
/* Ignore the next `samples` input samples (use while we transmit). */
void am_rx_mute(am_rx_t *rx, uint32_t samples);
/* Get one decoded packet; returns 1 if there was one. */
int  am_rx_pop(am_rx_t *rx, am_rx_result_t *out);
int  am_rx_state(const am_rx_t *rx);
void am_rx_get_stats(const am_rx_t *rx, am_stats_t *out);

/* For ctypes in the PC simulator */
int  am_rx_sizeof(void);

#ifdef __cplusplus
}
#endif
#endif /* AM_CORE_H */
