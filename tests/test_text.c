/*
 * test_text.c - PC unit tests for the text-message layer (am_text.c).
 *   make -C tests && ./tests/test_text
 */
#include <stdio.h>
#include <string.h>
#include "../firmware/DuburiModem/am_core.h"
#include "../firmware/DuburiModem/am_text.h"

static int fails = 0;
#define CHECK(c) do { if (!(c)) { printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #c); fails++; } } while (0)

/* Build all packets of a message, optionally through the real frame coder
 * (pack -> CRC -> unpack), which is what goes over the air. */
static int make_packets(const char *msg, int len, uint8_t seq0, am_packet_t *p)
{
    int n = am_text_npackets(len);
    for (int i = 0; i < n; i++) {
        am_packet_t a;
        uint8_t frame[AM_FRAME_BYTES];
        am_text_packet((const uint8_t *)msg, len, i, 2, 1, seq0, &a);
        am_pack(&a, frame);
        CHECK(am_unpack(frame, &p[i]) == 1);
        CHECK(memcmp(&a, &p[i], sizeof(a)) == 0);
    }
    return n;
}

static void test_packets(void)
{
    CHECK(am_text_npackets(0) == 0);
    CHECK(am_text_npackets(1) == 1);
    CHECK(am_text_npackets(2) == 1);
    CHECK(am_text_npackets(3) == 2);
    CHECK(am_text_npackets(64) == 32);
    am_packet_t p[40];
    int n = make_packets("Hello", 5, 14, p);
    CHECK(n == 3);
    CHECK(p[0].seq == 14 && p[1].seq == 15 && p[2].seq == 0);          /* wraps */
    CHECK(p[0].flags == (AM_FLAG_TEXT | AM_FLAG_FIRST));
    CHECK(p[1].flags == AM_FLAG_TEXT);
    CHECK(p[2].flags == (AM_FLAG_TEXT | AM_FLAG_LAST));
    CHECK(p[2].cmd == 'o' && p[2].arg == 0x00);                        /* pad */
    n = make_packets("Hi", 2, 3, p);
    CHECK(n == 1 && p[0].flags == (AM_FLAG_TEXT | AM_FLAG_FIRST | AM_FLAG_LAST));
    CHECK(p[0].cmd == 'H' && p[0].arg == 'i');
    /* text flag never collides with what the old commands use */
    am_packet_t c = {2, 1, 3, AM_FLAG_ACK_REQ, 1, 0};
    CHECK(!am_is_text(&c));
}

static void test_roundtrip(const char *msg)
{
    int len = (int)strlen(msg);
    am_packet_t p[40];
    am_text_rx_t rx;
    am_text_msg_t out[2];
    am_text_rx_init(&rx);
    int n = make_packets(msg, len, 7, p), got = 0;
    for (int i = 0; i < n; i++) {
        int k = am_text_rx_feed(&rx, &p[i], 12.0f, 1000u + 1500u * (uint32_t)i, out);
        if (i < n - 1) CHECK(k == 0);
        else got = k;
    }
    CHECK(got == 1);
    CHECK(out[0].ok == 1 && out[0].lost == 0 && out[0].len == len);
    CHECK(memcmp(out[0].data, msg, (size_t)len) == 0);
    CHECK(out[0].src == 1 && out[0].dst == 2);
    CHECK(out[0].q_db > 11.9f && out[0].q_db < 12.1f);
}

static void test_repeats(void)
{
    const char *msg = "Hello world";
    am_packet_t p[40];
    am_text_rx_t rx;
    am_text_msg_t out[2];
    am_text_rx_init(&rx);
    int n = make_packets(msg, 11, 0, p), done = 0;
    uint32_t t = 0;
    for (int i = 0; i < n; i++) {
        int k1 = am_text_rx_feed(&rx, &p[i], 10.0f, t += 1500, out);
        if (k1 == 1) done = 1;
        int k2 = am_text_rx_feed(&rx, &p[i], 10.0f, t += 1500, out);   /* the repeat */
        CHECK(k2 == -1);
    }
    CHECK(done == 1);
    /* first copy lost, second copy arrives: still fine */
    am_text_rx_init(&rx);
    done = 0;
    for (int i = 0; i < n; i++) {
        if (i != 2) {
            int k1 = am_text_rx_feed(&rx, &p[i], 10.0f, t += 1500, out);
            CHECK(k1 >= 0);
            if (k1 == 1) done = 1;
        }
        int k = am_text_rx_feed(&rx, &p[i], 10.0f, t += 1500, out);
        if (i == 2) CHECK(k == 0);
        else CHECK(k == -1);
        if (k == 1) done = 1;
    }
    CHECK(done == 1 && out[0].ok == 1 && memcmp(out[0].data, msg, 11) == 0);
}

static void test_losses(void)
{
    const char *msg = "Hello world";          /* packets: He ll o_ wo rl d */
    am_packet_t p[40];
    am_text_rx_t rx;
    am_text_msg_t out[2];
    uint32_t t = 0;

    /* middle packet lost */
    am_text_rx_init(&rx);
    int n = make_packets(msg, 11, 5, p), k = 0;
    for (int i = 0; i < n; i++)
        if (i != 2) k = am_text_rx_feed(&rx, &p[i], 9.0f, t += 1500, out);
    CHECK(k == 1 && out[0].ok == 0 && out[0].lost == 1 && out[0].len == 11);
    CHECK(out[0].lostmask[4] == 1 && out[0].lostmask[5] == 1 && out[0].lostmask[6] == 0);
    CHECK(memcmp(out[0].data, "Hell", 4) == 0 && memcmp(out[0].data + 6, "world", 5) == 0);

    char line[400];
    am_text_format_msg(&out[0], line, sizeof line);
    CHECK(strcmp(line, "MSG src=1 dst=2 ok=0 lost=1 len=11 q=9.0 hex=48656C6C____776F726C64 text=Hell??world") == 0);
    if (fails) printf("   got: %s\n", line);

    /* LAST lost -> finished by timeout */
    am_text_rx_init(&rx);
    for (int i = 0; i < n - 1; i++) CHECK(am_text_rx_feed(&rx, &p[i], 9.0f, t += 1500, out) == 0);
    CHECK(am_text_rx_poll(&rx, t + 1000, out) == 0);
    CHECK(am_text_rx_poll(&rx, t + AM_TEXT_TIMEOUT_MS + 10, out) == 1);
    CHECK(out[0].ok == 0 && out[0].lost == 1 && out[0].len == 12);
    CHECK(out[0].lostmask[9] == 0 && out[0].lostmask[10] == 1 && out[0].lostmask[11] == 1);
    CHECK(am_text_rx_poll(&rx, t + AM_TEXT_TIMEOUT_MS + 20, out) == 0);

    /* LAST lost, next message's FIRST arrives -> old one finished first */
    am_text_rx_init(&rx);
    t = 0;
    for (int i = 0; i < n - 1; i++) am_text_rx_feed(&rx, &p[i], 9.0f, t += 1500, out);
    am_packet_t q[4];
    make_packets("OK", 2, (uint8_t)((5 + n) & 15), q);
    k = am_text_rx_feed(&rx, &q[0], 9.0f, t += 1500, out);
    CHECK(k == 2);
    CHECK(out[0].ok == 0 && out[0].lost == 1 && out[0].len == 12 && out[0].lostmask[10] == 1);
    CHECK(out[1].ok == 1 && out[1].len == 2 && memcmp(out[1].data, "OK", 2) == 0);

    /* FIRST lost, but we heard the previous message: gap gives the count */
    am_text_rx_init(&rx);
    t = 0;
    k = am_text_rx_feed(&rx, &q[0], 9.0f, t += 1500, out);   /* "OK", seq s */
    CHECK(k == 1);
    am_packet_t r[40];
    int m = make_packets(msg, 11, (uint8_t)((q[0].seq + 1) & 15), r);
    for (int i = 2; i < m; i++) k = am_text_rx_feed(&rx, &r[i], 9.0f, t += 1500, out);
    CHECK(k == 1 && out[0].ok == 0 && out[0].lost == 2 && out[0].len == 11);
    CHECK(out[0].lostmask[0] && out[0].lostmask[3] && !out[0].lostmask[4]);
    CHECK(memcmp(out[0].data + 4, "o world", 7) == 0);
}

static void test_two_senders(void)
{
    am_packet_t a[40], b[40];
    am_text_rx_t rx;
    am_text_msg_t out[2];
    am_text_rx_init(&rx);
    int na = make_packets("AAAA", 4, 0, a);
    int nb = make_packets("BBBBBB", 6, 0, b);
    for (int i = 0; i < nb; i++) b[i].src = 3;
    int ka = 0, kb = 0;
    char ga[8] = {0}, gb[8] = {0};
    for (int i = 0; i < 3; i++) {
        if (i < na) { ka = am_text_rx_feed(&rx, &a[i], 1, 1000u * (uint32_t)i, out); if (ka == 1) memcpy(ga, out[0].data, out[0].len); }
        if (i < nb) { kb = am_text_rx_feed(&rx, &b[i], 1, 1000u * (uint32_t)i + 500u, out); if (kb == 1) memcpy(gb, out[0].data, out[0].len); }
    }
    CHECK(strcmp(ga, "AAAA") == 0 && strcmp(gb, "BBBBBB") == 0);
}

static void test_hex(void)
{
    uint8_t b[70];
    CHECK(am_hex_decode("48656c6C6f", b, 64) == 5 && memcmp(b, "Hello", 5) == 0);
    CHECK(am_hex_decode("486", b, 64) == -1);
    CHECK(am_hex_decode("48zz", b, 64) == -1);
    CHECK(am_hex_decode("4848", b, 1) == -1);
    CHECK(am_hex_decode("", b, 64) == 0);
    CHECK(am_hex_decode("4142 rest", b, 64) == 2);
}

int main(void)
{
    test_packets();
    test_roundtrip("A");
    test_roundtrip("Hi");
    test_roundtrip("Hello DUBURI, this is the AIR link test 123!");
    test_roundtrip("\xe0\xa6\x86\xe0\xa6\xae\xe0\xa6\xbf \xe0\xa6\xa1\xe0\xa7\x81\xe0\xa6\xac\xe0\xa7\x81\xe0\xa6\xb0\xe0\xa6\xbf"); /* "আমি ডুবুরি" */
    char big[65];
    for (int i = 0; i < 64; i++) big[i] = (char)('a' + i % 26);
    big[64] = 0;
    test_roundtrip(big);
    test_repeats();
    test_losses();
    test_two_senders();
    test_hex();
    if (fails) {
        printf("%d TEXT TEST(S) FAILED\n", fails);
        return 1;
    }
    printf("ALL TEXT TESTS PASSED\n");
    return 0;
}
