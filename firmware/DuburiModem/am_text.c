/*
 * am_text.c - text messages on top of DUBURI packets. See am_text.h.
 */
#include "am_text.h"
#include <stdio.h>
#include <string.h>

int am_text_npackets(int len)
{
    return (len <= 0) ? 0 : (len + 1) / 2;
}

void am_text_packet(const uint8_t *msg, int len, int i, uint8_t dst, uint8_t src,
                    uint8_t seq0, am_packet_t *p)
{
    int n = am_text_npackets(len);
    p->dst = dst & 0xF;
    p->src = src & 0xF;
    p->seq = (uint8_t)((seq0 + i) & 0xF);
    p->flags = AM_FLAG_TEXT;
    if (i == 0) p->flags |= AM_FLAG_FIRST;
    if (i == n - 1) p->flags |= AM_FLAG_LAST;
    p->cmd = msg[2 * i];
    p->arg = (2 * i + 1 < len) ? msg[2 * i + 1] : 0x00;   /* pad */
}

int am_is_text(const am_packet_t *p)
{
    return (p->flags & AM_FLAG_TEXT) != 0;
}

/* ---------------------------------------------------------------------- */

void am_text_rx_init(am_text_rx_t *t)
{
    memset(t, 0, sizeof(*t));
}

static void put_byte(am_text_slot_t *s, uint8_t b, int lost)
{
    if (s->msg.len >= AM_TEXT_MAX) return;
    s->msg.data[s->msg.len] = lost ? 0 : b;
    s->msg.lostmask[s->msg.len] = (uint8_t)(lost ? 1 : 0);
    s->msg.len++;
}

static void put_lost_packets(am_text_slot_t *s, int npk)
{
    for (int k = 0; k < npk; k++) {
        put_byte(s, 0, 1);
        put_byte(s, 0, 1);
    }
    s->msg.lost = (uint8_t)(s->msg.lost + npk);
}

static void start_msg(am_text_slot_t *s, const am_packet_t *p, int started)
{
    memset(&s->msg, 0, sizeof(s->msg));
    s->msg.src = p->src & 0xF;
    s->msg.dst = p->dst & 0xF;
    s->active = 1;
    s->started = (uint8_t)started;
    s->q_sum = 0.0f;
    s->q_n = 0;
}

static void finish_msg(am_text_slot_t *s, am_text_msg_t *out)
{
    s->msg.ok = (uint8_t)(s->started && s->msg.lost == 0);
    s->msg.q_db = (s->q_n > 0) ? s->q_sum / (float)s->q_n : 0.0f;
    *out = s->msg;
    s->active = 0;
}

int am_text_rx_feed(am_text_rx_t *t, const am_packet_t *p, float q_db,
                    uint32_t now_ms, am_text_msg_t out[2])
{
    if (!am_is_text(p)) return 0;
    am_text_slot_t *s = &t->s[p->src & 0xF];
    const uint8_t seq = p->seq & 0xF;
    const int recent = s->have_seq && (uint32_t)(now_ms - s->last_ms) < AM_TEXT_TIMEOUT_MS;
    int nout = 0;

    /* A repeat of the packet we just took (sender's "repeat" setting). */
    if (s->have_seq && seq == s->last_seq && (uint32_t)(now_ms - s->last_ms) < AM_TEXT_DUP_MS)
        return -1;

    if (p->flags & AM_FLAG_FIRST) {
        if (s->active) {                                 /* its LAST was lost */
            int missing = (seq - s->last_seq - 1) & 0xF;
            put_lost_packets(s, missing < 1 ? 1 : missing);
            finish_msg(s, &out[nout++]);
        }
        start_msg(s, p, 1);
    } else if (!s->active) {
        /* We missed the start of this message. If we heard the sender
         * recently, the seq gap tells how many packets we missed. */
        start_msg(s, p, 0);
        int missing = recent ? ((seq - s->last_seq - 1) & 0xF) : 1;
        if (missing < 1) missing = 1;
        put_lost_packets(s, missing);
    } else {
        int missing = (seq - ((s->last_seq + 1) & 0xF)) & 0xF;
        if (missing) put_lost_packets(s, missing);
    }

    put_byte(s, p->cmd, 0);
    if (!((p->flags & AM_FLAG_LAST) && p->arg == 0x00))  /* drop the pad */
        put_byte(s, p->arg, 0);
    s->q_sum += q_db;
    s->q_n++;
    s->last_seq = seq;
    s->have_seq = 1;
    s->last_ms = now_ms;

    if (p->flags & AM_FLAG_LAST) finish_msg(s, &out[nout++]);
    return nout;
}

int am_text_rx_poll(am_text_rx_t *t, uint32_t now_ms, am_text_msg_t *out)
{
    for (int i = 0; i < 16; i++) {
        am_text_slot_t *s = &t->s[i];
        if (s->active && (uint32_t)(now_ms - s->last_ms) > AM_TEXT_TIMEOUT_MS) {
            put_lost_packets(s, 1);                      /* at least the LAST */
            finish_msg(s, out);
            return 1;
        }
    }
    return 0;
}

/* ---------------------------------------------------------------------- */

int am_text_format_msg(const am_text_msg_t *m, char *buf, int bufsize)
{
    static const char hx[] = "0123456789ABCDEF";
    int n = snprintf(buf, (size_t)bufsize, "MSG src=%d dst=%d ok=%d lost=%d len=%d q=%.1f hex=",
                     m->src, m->dst, m->ok, m->lost, m->len, (double)m->q_db);
    if (n < 0 || n >= bufsize) return 0;
    for (int i = 0; i < m->len && n + 3 < bufsize; i++) {
        if (m->lostmask[i]) {
            buf[n++] = '_';
            buf[n++] = '_';
        } else {
            buf[n++] = hx[m->data[i] >> 4];
            buf[n++] = hx[m->data[i] & 0xF];
        }
    }
    const char *tt = " text=";
    for (int i = 0; tt[i] && n + 1 < bufsize; i++) buf[n++] = tt[i];
    for (int i = 0; i < m->len && n + 1 < bufsize; i++) {
        uint8_t b = m->data[i];
        if (m->lostmask[i]) b = '?';
        else if (b < 0x20 || b == 0x7F) b = '.';
        buf[n++] = (char)b;
    }
    buf[n] = 0;
    return n;
}

static int hexval(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

int am_hex_decode(const char *hex, uint8_t *out, int maxlen)
{
    int n = 0;
    while (hex[0] && hex[0] != ' ' && hex[0] != '\r' && hex[0] != '\n') {
        int hi = hexval(hex[0]);
        int lo = hex[1] ? hexval(hex[1]) : -1;
        if (hi < 0 || lo < 0 || n >= maxlen) return -1;
        out[n++] = (uint8_t)((hi << 4) | lo);
        hex += 2;
    }
    return n;
}
