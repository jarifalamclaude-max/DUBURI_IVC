/*
 * am_text.h - text messages on top of DUBURI packets (portable C99).
 *
 * A message (1..64 bytes, e.g. UTF-8 text) is cut into packets of 2 bytes.
 * Each packet is a normal DUBURI frame:
 *   dst, src   : as usual
 *   seq        : running packet counter mod 16 (never reset by the sender)
 *   flags      : AM_FLAG_TEXT, + AM_FLAG_FIRST on the first packet,
 *                + AM_FLAG_LAST on the last packet
 *   cmd, arg   : the 2 data bytes (odd length: last packet's arg = 0x00 pad)
 * Receiver: drops repeats (same seq as the previous packet from that sender),
 * fills seq gaps with "lost" bytes, and finishes a message at LAST, at a new
 * FIRST, or after AM_TEXT_TIMEOUT_MS of silence. See docs/SERIAL_PROTOCOL.md.
 */
#ifndef AM_TEXT_H
#define AM_TEXT_H

#include <stdint.h>
#include "am_core.h"

#ifdef __cplusplus
extern "C" {
#endif

#define AM_FLAG_TEXT        0x2   /* packet carries 2 bytes of a message     */
#define AM_FLAG_FIRST       0x8   /* (text only) first packet of a message   */
#define AM_FLAG_LAST        0x1   /* (text only) last packet of a message    */

#define AM_TEXT_MAX         64    /* bytes per message                       */
#define AM_TEXT_TIMEOUT_MS  8000  /* give up on a half message after this    */
#define AM_TEXT_DUP_MS      6000  /* same seq within this time = a repeat    */

/* ---- Sender ---- */
int  am_text_npackets(int len);                      /* ceil(len / 2)         */
/* Fill packet i (0-based) of a message. seq = (seq0 + i) & 15. */
void am_text_packet(const uint8_t *msg, int len, int i, uint8_t dst, uint8_t src,
                    uint8_t seq0, am_packet_t *p);
int  am_is_text(const am_packet_t *p);

/* ---- Receiver ---- */
typedef struct {
    uint8_t  src, dst;
    uint8_t  ok;                      /* 1 = FIRST..LAST, nothing missing    */
    uint8_t  lost;                    /* packets known to be missing         */
    uint8_t  len;                     /* bytes in data[]                     */
    uint8_t  data[AM_TEXT_MAX];
    uint8_t  lostmask[AM_TEXT_MAX];   /* 1 = this byte was lost              */
    float    q_db;                    /* mean link quality of the packets    */
} am_text_msg_t;

typedef struct {
    uint8_t  active;                  /* a message is being collected        */
    uint8_t  have_seq;                /* last_seq is valid                   */
    uint8_t  last_seq;
    uint8_t  started;                 /* this message began with FIRST       */
    uint32_t last_ms;
    float    q_sum;
    int      q_n;
    am_text_msg_t msg;
} am_text_slot_t;

typedef struct {
    am_text_slot_t s[16];             /* one per sender address              */
} am_text_rx_t;

void am_text_rx_init(am_text_rx_t *t);
/* Feed one decoded TEXT packet. Writes 0..2 finished messages to out[]
 * (a half message cut short by a new FIRST, then possibly a 1-packet
 * message). Returns how many. Returns -1 if the packet was a repeat. */
int  am_text_rx_feed(am_text_rx_t *t, const am_packet_t *p, float q_db,
                     uint32_t now_ms, am_text_msg_t out[2]);
/* Call often. Finishes one message that timed out; returns 1 if it did. */
int  am_text_rx_poll(am_text_rx_t *t, uint32_t now_ms, am_text_msg_t *out);

/* ---- Formatting for the serial protocol ----
 * Writes "MSG src=.. dst=.. ok=.. lost=.. len=.. q=.. hex=.. text=.." (no
 * newline) into buf. Returns the length. bufsize >= 360 is always enough. */
int  am_text_format_msg(const am_text_msg_t *m, char *buf, int bufsize);

/* Hex helpers: returns number of bytes, or -1 on bad input / too long. */
int  am_hex_decode(const char *hex, uint8_t *out, int maxlen);

#ifdef __cplusplus
}
#endif
#endif /* AM_TEXT_H */
