/*
 * DuburiModem.ino - acoustic text/command link between two boards (ESP32).
 *                   AIR mode (speaker -> mic) or WATER mode (speaker -> hydrophone).
 *
 * Board : "ESP32 Dev Module" (Arduino-ESP32 core 3.x, tested with 3.3.12)
 * Needs : no extra libraries.
 *
 * Same firmware on every board; set NODE_ID / PEER_ID in config.h.
 * Use it from the web pages in pc/ (sender.html, receiver.html) or from the
 * Arduino Serial Monitor (115200 baud, "Newline"):
 *   msg <text>     send a text message (UTF-8, up to 64 bytes) to PEER_ID
 *   msghex D R H   send hex bytes H to node D, every packet R times (web pages)
 *   !              stop a message that is being sent
 *   mode air|water switch medium (saved in flash; both boards must match)
 *   info           one-line summary of this board
 *   on|off|toggle|ping [id]  LED commands (need two-way hardware, they wait for ACK)
 *   send C A [id]  send command number C (0..255) with argument A (0..255)
 *   sweep          play every tone once (frequency response test)
 *   tone F MS      play F Hz for MS milliseconds
 *   scope [on|off] print per-tone levels every 0.25 s
 *   stats          counters, ADC level and measured sample rate
 * Every line the board prints is described in docs/SERIAL_PROTOCOL.md.
 */
#include <Arduino.h>
#include <Preferences.h>
#include "config.h"
#include "am_core.h"
#include "am_text.h"
#include "esp_adc/adc_continuous.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "freertos/queue.h"

#if !defined(ESP_ARDUINO_VERSION_MAJOR) || ESP_ARDUINO_VERSION_MAJOR < 3
#error "Install Arduino-ESP32 core 3.x (Tools > Board > Boards Manager > esp32 by Espressif)"
#endif

#define FW_VERSION "2.0"

/* Command numbers (you can add your own: 10..255 are free) */
enum {
  CMD_LED_ON = 1,
  CMD_LED_OFF = 2,
  CMD_LED_TOGGLE = 3,
  CMD_PING = 4,
};

/* ------------------------------------------------------------------------ */
/* Medium mode                                                              */
/* ------------------------------------------------------------------------ */
static Preferences g_prefs;
static int g_mode = DEFAULT_MODE;

static float slotS() { return am_mode_info(g_mode)->t_slot; }
static uint32_t packetMs() { return (uint32_t)lrintf(AM_TOTAL_SLOTS * slotS() * 1000.0f); }
static uint32_t muteTailMs() { return g_mode == AM_MODE_AIR ? AIR_MUTE_TAIL_MS : WATER_MUTE_TAIL_MS; }
static uint32_t textGapMs() { return TEXT_GAP_MS; }
static float txDuty() { return g_mode == AM_MODE_AIR ? AIR_TX_DUTY : WATER_TX_DUTY; }
static float burstS() { return g_mode == AM_MODE_AIR ? AIR_BURST_S : WATER_BURST_S; }
static uint32_t ackTimeoutMs() { return packetMs() + TURNAROUND_MS + 1000; }

/* ------------------------------------------------------------------------ */
/* Receiver task (core 0): ADC DMA -> modem core -> queue                     */
/* ------------------------------------------------------------------------ */
static am_rx_t g_rx;                       /* ~45 kB, keep it off the stack */
static SemaphoreHandle_t g_rx_lock;
static QueueHandle_t g_pkt_queue;
static adc_continuous_handle_t g_adc;
static adc_channel_t g_adc_chan;
static volatile uint32_t g_adc_overflows = 0;

/* measured ADC sample rate */
static volatile float g_fs_measured = AM_FS_NOMINAL;
/* ADC level (raw counts) over the last ~0.5 s */
static volatile float g_lvl_rms = 0, g_lvl_mean = 0;
static volatile uint16_t g_lvl_min = 0, g_lvl_max = 0;

static bool IRAM_ATTR onAdcOverflow(adc_continuous_handle_t, const adc_continuous_evt_data_t *, void *) {
  g_adc_overflows = g_adc_overflows + 1;
  return false;
}

static bool startAdc() {
  adc_unit_t unit;
  if (adc_continuous_io_to_channel(PIN_RX_AUDIO, &unit, &g_adc_chan) != ESP_OK || unit != ADC_UNIT_1) {
    Serial.println("ERR PIN_RX_AUDIO must be an ADC1 pin (32..39)");
    return false;
  }
  adc_continuous_handle_cfg_t hcfg = {};
  hcfg.max_store_buf_size = 16384;         /* 8192 samples = 164 ms of slack */
  hcfg.conv_frame_size = 1024;             /* 512 samples per read (~10 ms) */
  if (adc_continuous_new_handle(&hcfg, &g_adc) != ESP_OK) return false;

  adc_digi_pattern_config_t pat = {};
  pat.atten = ADC_ATTEN_DB_12;             /* ~0.15 .. 2.45 V usable */
  pat.channel = (uint8_t)g_adc_chan;
  pat.unit = ADC_UNIT_1;
  pat.bit_width = SOC_ADC_DIGI_MAX_BITWIDTH;

  adc_continuous_config_t cfg = {};
  cfg.pattern_num = 1;
  cfg.adc_pattern = &pat;
  cfg.sample_freq_hz = (uint32_t)AM_FS_NOMINAL;
  cfg.conv_mode = ADC_CONV_SINGLE_UNIT_1;
  cfg.format = ADC_DIGI_OUTPUT_FORMAT_TYPE1;
  if (adc_continuous_config(g_adc, &cfg) != ESP_OK) return false;

  adc_continuous_evt_cbs_t cbs = {};
  cbs.on_pool_ovf = onAdcOverflow;
  adc_continuous_register_event_callbacks(g_adc, &cbs, NULL);
  return adc_continuous_start(g_adc) == ESP_OK;
}

static void rxTask(void *) {
  static uint8_t raw[1024];
  static uint16_t smp[512];
  uint64_t total = 0;
  int64_t t_ref = 0;
  uint64_t n_ref = 0;
  int64_t t_last_fs = 0;
  /* level meter accumulators */
  double acc = 0, acc2 = 0;
  uint32_t accn = 0;
  uint16_t mn = 4095, mx = 0;

  for (;;) {
    uint32_t got = 0;
    esp_err_t r = adc_continuous_read(g_adc, raw, sizeof(raw), &got, 200);
    if (r != ESP_OK) continue;
    int64_t now = esp_timer_get_time();
    int n = 0;
    for (uint32_t i = 0; i + 1 < got; i += SOC_ADC_DIGI_RESULT_BYTES) {
      adc_digi_output_data_t *d = (adc_digi_output_data_t *)&raw[i];
      if (d->type1.channel != g_adc_chan) continue;
      uint16_t v = d->type1.data;
      smp[n++] = v;
      acc += v;
      acc2 += (double)v * v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    accn += n;
    total += n;

    xSemaphoreTake(g_rx_lock, portMAX_DELAY);
    am_rx_process(&g_rx, smp, n);
    am_rx_result_t res;
    while (am_rx_pop(&g_rx, &res)) xQueueSend(g_pkt_queue, &res, 0);
    xSemaphoreGive(g_rx_lock);

    /* Measure the real ADC rate against the CPU clock. The longer we run
     * the more exact it gets (DMA timing jitter / elapsed time). */
    if (t_ref == 0 && total > 25000) { t_ref = now; n_ref = total; t_last_fs = now; }
    if (t_ref != 0 && now - t_last_fs > 2000000) {
      t_last_fs = now;
      double fs = (double)(total - n_ref) * 1e6 / (double)(now - t_ref);
      if (fs > 20000.0 && fs < 62000.0) {
        g_fs_measured = (float)fs;
        xSemaphoreTake(g_rx_lock, portMAX_DELAY);
        if (fabsf(g_rx.fs - (float)fs) > 0.0002f * (float)fs) am_rx_set_fs(&g_rx, (float)fs);
        xSemaphoreGive(g_rx_lock);
      }
    }
    if (accn >= 25000) {
      double m = acc / accn;
      g_lvl_mean = (float)m;
      g_lvl_rms = (float)sqrt(fmax(acc2 / accn - m * m, 0.0));
      g_lvl_min = mn;
      g_lvl_max = mx;
      acc = acc2 = 0;
      accn = 0;
      mn = 4095;
      mx = 0;
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Transmitter                                                              */
/* ------------------------------------------------------------------------ */
static uint8_t g_seq = 0;        /* command sequence number              */
static uint8_t g_text_seq = 0;   /* text packet counter (never reset)    */
static bool g_scope = false;
static bool g_led = false;
static volatile bool g_abort = false;

static void ampEnable(bool on) {
#if PIN_AMP_ENABLE >= 0
  digitalWrite(PIN_AMP_ENABLE, on ? AMP_ENABLE_LEVEL : !AMP_ENABLE_LEVEL);
  if (on) delay(20);
#else
  (void)on;
#endif
}

static void muteRx(uint32_t ms) {
  xSemaphoreTake(g_rx_lock, portMAX_DELAY);
  am_rx_mute(&g_rx, (uint32_t)((float)ms * g_fs_measured / 1000.0f));
  xSemaphoreGive(g_rx_lock);
}

static void waitUntil(int64_t t_us) {
  for (;;) {
    int64_t left = t_us - esp_timer_get_time();
    if (left <= 0) return;
    if (left > 3000) vTaskDelay(1);   /* sleep in 1 ms steps, spin the rest */
  }
}

/* While a message is going out, the only input we accept is '!' (stop). */
static void pollAbort() {
  while (Serial.available()) {
    if (Serial.read() == '!') g_abort = true;
  }
}

static void sleepAbortable(uint32_t ms) {
  uint32_t t0 = millis();
  while (millis() - t0 < ms) {
    pollAbort();
    delay(5);
  }
}

/* Heat bucket (seconds). Sound fills it at (1 - duty)/s, silence empties it
 * at duty/s. Long-run on-time is <= duty; a burst of BURST_S is allowed. */
static float g_heat = 0.0f;
static int64_t g_heat_t = 0;

static void heatCool(int64_t now) {
  g_heat -= (float)(now - g_heat_t) * 1e-6f * txDuty();
  if (g_heat < 0.0f) g_heat = 0.0f;
  g_heat_t = now;
}

/* Wait until the speaker may play for `seconds`. Returns false if aborted. */
static bool heatGuard(float seconds, bool abortable) {
  const float d = txDuty();
  heatCool(esp_timer_get_time());
  float need = g_heat + seconds * (1.0f - d) - burstS() * (1.0f - d);
  if (need <= 0.0f) return true;
  uint32_t wait_ms = (uint32_t)(need / d * 1000.0f) + 1;
  Serial.printf("HEAT-GUARD wait %lu ms\n", (unsigned long)wait_ms);
  if (abortable) {
    sleepAbortable(wait_ms);
    if (g_abort) return false;
  } else {
    delay(wait_ms);
  }
  heatCool(esp_timer_get_time());
  return true;
}

static void heatAdd(int64_t t_start, int64_t t_end) {
  heatCool(t_start);
  g_heat += (float)(t_end - t_start) * 1e-6f * (1.0f - txDuty());
  g_heat_t = t_end;
}

/* Plays tones[i] for one slot each. The caller has passed the heat guard. */
static void playTones(const uint8_t *tones, int count) {
  const int64_t slot_us = (int64_t)lrintf(slotS() * 1e6f);
  uint32_t mute_ms = (uint32_t)(count * slotS() * 1000.0f) + 40 + muteTailMs();
  muteRx(mute_ms);
  ampEnable(true);
  int64_t t0 = esp_timer_get_time() + 2000;
  waitUntil(t0);
  for (int i = 0; i < count; i++) {
    ledcWriteTone(PIN_TX_AUDIO, (uint32_t)lrintf(am_tone_hz(tones[i])));
    waitUntil(t0 + (int64_t)(i + 1) * slot_us);
  }
  ledcWrite(PIN_TX_AUDIO, 0);
  ampEnable(false);
  heatAdd(t0, esp_timer_get_time());
}

static void sendPacket(const am_packet_t &p) {
  uint8_t tones[AM_TOTAL_SLOTS];
  am_tx_build(&p, tones);
  heatGuard(AM_TOTAL_SLOTS * slotS(), false);
  playTones(tones, AM_TOTAL_SLOTS);
}

/* Send a text message (bytes) as packets of 2 bytes. */
static void sendText(uint8_t dst, const uint8_t *msg, int len, int repeats) {
  const int n = am_text_npackets(len);
  const uint8_t seq0 = g_text_seq;
  g_abort = false;
  uint32_t t_start = millis();
  Serial.printf("TXMSG dst=%d len=%d n=%d rep=%d\n", dst, len, n, repeats);
  for (int i = 0; i < n; i++) {
    am_packet_t p;
    am_text_packet(msg, len, i, dst, NODE_ID, seq0, &p);
    uint8_t tones[AM_TOTAL_SLOTS];
    am_tx_build(&p, tones);
    for (int k = 1; k <= repeats; k++) {
      pollAbort();
      if (g_abort || !heatGuard(AM_TOTAL_SLOTS * slotS(), true)) {
        Serial.printf("TXABORT i=%d n=%d\n", i + 1, n);
        g_text_seq = (uint8_t)((seq0 + i) & 0xF);
        return;
      }
      Serial.printf("TXPKT i=%d n=%d try=%d seq=%d flags=%X data=%02X", i + 1, n, k, p.seq, p.flags, p.cmd);
      if (!((p.flags & AM_FLAG_LAST) && p.arg == 0)) Serial.printf("%02X", p.arg);
      Serial.print(" tones=");
      for (int s = 0; s < AM_TOTAL_SLOTS; s++) Serial.printf(s ? ",%d" : "%d", tones[s]);
      Serial.println();
      Serial.flush();
      playTones(tones, AM_TOTAL_SLOTS);
      if (i < n - 1 || k < repeats) sleepAbortable(textGapMs());
    }
  }
  g_text_seq = (uint8_t)((seq0 + n) & 0xF);
  Serial.printf("TXDONE n=%d ms=%lu\n", n, (unsigned long)(millis() - t_start));
}

/* ------------------------------------------------------------------------ */
/* Packet handling                                                          */
/* ------------------------------------------------------------------------ */
static int16_t g_last_seq[16];
static uint32_t g_last_seq_ms[16];
static am_text_rx_t g_text;

static void setLed(bool on) {
  g_led = on;
  digitalWrite(PIN_LED, on ? HIGH : LOW);
}

static void printMsg(const am_text_msg_t &m) {
  static char line[400];
  am_text_format_msg(&m, line, sizeof(line));
  Serial.println(line);
}

static void handleText(const am_rx_result_t &r) {
  const am_packet_t &p = r.pkt;
  am_text_msg_t out[2];
  int k = am_text_rx_feed(&g_text, &p, r.q_db, millis(), out);
  if (k < 0) {
    Serial.printf("REPEAT src=%d seq=%d (dropped)\n", p.src, p.seq);
    return;
  }
  /* A FIRST packet may close an older, unfinished message: print that first. */
  int before = ((p.flags & AM_FLAG_FIRST) && (k == 2 || (k == 1 && !(p.flags & AM_FLAG_LAST)))) ? 1 : 0;
  for (int i = 0; i < before; i++) printMsg(out[i]);
  Serial.printf("TXT src=%d dst=%d seq=%d first=%d last=%d data=%02X", p.src, p.dst, p.seq,
                (p.flags & AM_FLAG_FIRST) ? 1 : 0, (p.flags & AM_FLAG_LAST) ? 1 : 0, p.cmd);
  if (!((p.flags & AM_FLAG_LAST) && p.arg == 0)) Serial.printf("%02X", p.arg);
  Serial.printf(" q=%.1f\n", r.q_db);
  for (int i = before; i < k; i++) printMsg(out[i]);
}

static void sendAck(const am_packet_t &in) {
  am_packet_t a = {};
  a.dst = in.src;
  a.src = NODE_ID;
  a.seq = in.seq;
  a.flags = AM_FLAG_IS_ACK;
  a.cmd = in.cmd;
  a.arg = g_led ? 1 : 0;
  delay(TURNAROUND_MS);
  sendPacket(a);
  Serial.printf("TX ack to=%d seq=%d\n", a.dst, a.seq);
}

/* Returns true if this was the ACK we are waiting for. */
static bool handlePacket(const am_rx_result_t &r, int wait_src, int wait_seq) {
  const am_packet_t &p = r.pkt;
  if (p.dst != NODE_ID && p.dst != AM_ADDR_BROADCAST) {
    Serial.printf("RX (not for me) src=%d dst=%d q=%.1fdB\n", p.src, p.dst, r.q_db);
    return false;
  }
  if (am_is_text(&p)) {          /* text first: it reuses the ACK flag bits */
    handleText(r);
    return false;
  }
  if (p.flags & AM_FLAG_IS_ACK) {
    Serial.printf("ACK src=%d seq=%d cmd=%d state=%d q=%.1fdB\n", p.src, p.seq, p.cmd, p.arg, r.q_db);
    return (p.src == wait_src && p.seq == wait_seq);
  }
  Serial.printf("RX src=%d dst=%d seq=%d cmd=%d arg=%d flags=%X q=%.1fdB\n",
                p.src, p.dst, p.seq, p.cmd, p.arg, p.flags, r.q_db);

  uint32_t now = millis();
  bool repeat = (g_last_seq[p.src] == p.seq) && (now - g_last_seq_ms[p.src] < DEDUP_MS);
  g_last_seq[p.src] = p.seq;
  g_last_seq_ms[p.src] = now;
  if (!repeat) {
    switch (p.cmd) {
      case CMD_LED_ON: setLed(true); break;
      case CMD_LED_OFF: setLed(false); break;
      case CMD_LED_TOGGLE: setLed(!g_led); break;
      case CMD_PING: break;
      default: break; /* add your own commands here */
    }
  } else {
    Serial.println("   (repeat - action already done)");
  }
  /* Reply even to repeats: our earlier reply may have been lost. */
  if (USE_ACK && (p.flags & AM_FLAG_ACK_REQ) && p.dst == NODE_ID) sendAck(p);
  return false;
}

static void pollPackets() {
  am_rx_result_t r;
  while (xQueueReceive(g_pkt_queue, &r, 0) == pdTRUE) handlePacket(r, -1, -1);
  am_text_msg_t m;
  while (am_text_rx_poll(&g_text, millis(), &m)) printMsg(m);
}

/* Prints DET / CRCFAIL when the receiver hears a preamble / a damaged packet. */
static void pollEvents() {
  static uint32_t last_pre = 0, last_crc = 0;
  static uint32_t t_last = 0;
  if (millis() - t_last < 20) return;
  t_last = millis();
  xSemaphoreTake(g_rx_lock, portMAX_DELAY);
  uint32_t pre = g_rx.stats.preambles, crc = g_rx.stats.crc_fail;
  xSemaphoreGive(g_rx_lock);
  if (pre != last_pre) Serial.printf("DET n=%lu\n", (unsigned long)pre);
  if (crc != last_crc) Serial.printf("CRCFAIL n=%lu\n", (unsigned long)crc);
  last_pre = pre;
  last_crc = crc;
}

static void sendCommand(int dst, uint8_t cmd, uint8_t arg) {
  am_packet_t p = {};
  p.dst = (uint8_t)dst;
  p.src = NODE_ID;
  p.seq = g_seq = (uint8_t)((g_seq + 1) & 0xF);
  p.cmd = cmd;
  p.arg = arg;
  bool want_ack = USE_ACK && dst != AM_ADDR_BROADCAST;
  if (want_ack) p.flags = AM_FLAG_ACK_REQ;

  for (int attempt = 1; attempt <= TX_RETRIES; attempt++) {
    Serial.printf("TX to=%d seq=%d cmd=%d arg=%d (try %d/%d)\n", dst, p.seq, cmd, arg, attempt, TX_RETRIES);
    sendPacket(p);
    if (!want_ack) {
      if (attempt < TX_RETRIES) delay(REPEAT_GAP_MS);
      continue;
    }
    uint32_t t0 = millis();
    while (millis() - t0 < ackTimeoutMs()) {
      am_rx_result_t r;
      if (xQueueReceive(g_pkt_queue, &r, pdMS_TO_TICKS(20)) == pdTRUE && handlePacket(r, dst, p.seq)) {
        Serial.printf("OK delivered to %d (try %d)\n", dst, attempt);
        return;
      }
    }
    Serial.println("   no reply");
  }
  if (want_ack) Serial.printf("FAIL no reply from %d\n", dst);
}

/* ------------------------------------------------------------------------ */
/* Diagnostics                                                              */
/* ------------------------------------------------------------------------ */
static void printInfo() {
  Serial.printf("INFO node=%d peer=%d fw=%s mode=%s text_max=%d slot_ms=%lu pkt_ms=%lu duty=%.2f burst_s=%.1f\n",
                NODE_ID, PEER_ID, FW_VERSION, am_mode_info(g_mode)->name, AM_TEXT_MAX,
                (unsigned long)lrintf(slotS() * 1000.0f), (unsigned long)packetMs(), txDuty(), burstS());
}

static void printStats() {
  xSemaphoreTake(g_rx_lock, portMAX_DELAY);
  am_stats_t s = g_rx.stats;
  float fs_used = g_rx.fs;
  xSemaphoreGive(g_rx_lock);
  Serial.printf("STATS node=%d preambles=%lu ok=%lu crc_fail=%lu last_q=%.1fdB timing_adj=%.1f\n",
                NODE_ID, (unsigned long)s.preambles, (unsigned long)s.packets_ok,
                (unsigned long)s.crc_fail, s.last_q_db, s.last_timing_adj);
  Serial.printf("ADC fs_measured=%.1f fs_used=%.1f overflows=%lu clipped=%lu\n",
                g_fs_measured, fs_used, (unsigned long)g_adc_overflows, (unsigned long)s.clipped);
  Serial.printf("LEVEL mean=%.0f rms=%.1f min=%u max=%u (want rms 20..300, min>100, max<3900)\n",
                g_lvl_mean, g_lvl_rms, g_lvl_min, g_lvl_max);
}

static void printScope() {
  float db[AM_NTONES];
  xSemaphoreTake(g_rx_lock, portMAX_DELAY);
  memcpy(db, g_rx.scope_db, sizeof(db));
  xSemaphoreGive(g_rx_lock);
  Serial.print("SCOPE");
  for (int i = 0; i < AM_NTONES; i++) Serial.printf(" %d", (int)lrintf(db[i]));
  Serial.printf("  rms=%.0f\n", g_lvl_rms);
}

static void playTest(const uint8_t *t, int count) {
  heatGuard(count * slotS(), false);
  playTones(t, count);
}

static void doSweep() {
  int per = (int)lrintf(0.3f / slotS());          /* ~300 ms per tone */
  if (per > 16) per = 16;
  Serial.println("SWEEP: each tone ~300 ms. Watch 'scope' on the other board.");
  for (int i = 0; i < AM_NTONES; i++) {
    uint8_t t[16];
    for (int k = 0; k < per; k++) t[k] = (uint8_t)i;
    Serial.printf("SWEEP tone %d = %.0f Hz\n", i, am_tone_hz(i));
    playTest(t, per);
    delay(150);
  }
}

static void doTone(int hz, int ms) {
  if (hz < 100 || hz > 20000 || ms < 1 || ms > 5000) {
    Serial.println("ERR usage: tone <100..20000 Hz> <1..5000 ms>");
    return;
  }
  heatGuard(ms / 1000.0f, false);
  muteRx((uint32_t)ms + muteTailMs());
  ampEnable(true);
  int64_t t0 = esp_timer_get_time();
  uint32_t real = ledcWriteTone(PIN_TX_AUDIO, (uint32_t)hz);
  Serial.printf("TONE %d Hz (real %lu Hz) for %d ms\n", hz, (unsigned long)real, ms);
  delay(ms);
  ledcWrite(PIN_TX_AUDIO, 0);
  ampEnable(false);
  heatAdd(t0, esp_timer_get_time());
}

static bool setMode(int mode) {
  for (int tries = 0; tries < 400; tries++) {     /* wait up to ~4 s for a packet to finish */
    xSemaphoreTake(g_rx_lock, portMAX_DELAY);
    int ok = am_rx_set_mode(&g_rx, mode);
    xSemaphoreGive(g_rx_lock);
    if (ok) {
      g_mode = mode;
      g_prefs.putUChar("mode", (uint8_t)mode);
      return true;
    }
    delay(10);
  }
  return false;
}

static void printHelp() {
  Serial.println("Commands: msg <text> ; msghex <dst> <rep> <hex> ; ! ; mode air|water ; info ; "
                 "on|off|toggle|ping [id] ; send <cmd> <arg> [id] ; sweep ; tone <Hz> <ms> ; scope [on|off] ; stats ; help");
}

/* Checks and sends a text message given as raw bytes. */
static void startText(int dst, int repeats, const uint8_t *b, int len) {
  if (len < 1 || len > AM_TEXT_MAX) {
    Serial.printf("ERR message must be 1..%d bytes (got %d)\n", AM_TEXT_MAX, len);
    return;
  }
  for (int i = 0; i < len; i++)
    if (b[i] == 0) {
      Serial.println("ERR message may not contain byte 00");
      return;
    }
  if (dst < 1 || dst > 15) {
    Serial.println("ERR destination must be 1..15 (15 = all)");
    return;
  }
  if (repeats < 1 || repeats > 3) {
    Serial.println("ERR repeats must be 1..3");
    return;
  }
  sendText((uint8_t)dst, b, len, repeats);
}

static void handleLine(char *line) {
  /* "msg <text>": everything after the first space is the message */
  if (!strncmp(line, "msg ", 4)) {
    startText(PEER_ID, TEXT_REPEATS, (const uint8_t *)line + 4, (int)strlen(line + 4));
    return;
  }
  char *w = strtok(line, " \t");
  if (!w) return;
  char *a1 = strtok(NULL, " \t"), *a2 = strtok(NULL, " \t"), *a3 = strtok(NULL, " \t");
  int id = a1 ? atoi(a1) : PEER_ID;
  if (!strcmp(w, "msghex")) {
    static uint8_t b[AM_TEXT_MAX + 1];
    int len = (a1 && a2 && a3) ? am_hex_decode(a3, b, AM_TEXT_MAX) : -1;
    if (len < 0) Serial.printf("ERR usage: msghex <dst> <repeats> <hex, up to %d bytes>\n", AM_TEXT_MAX);
    else startText(atoi(a1), atoi(a2), b, len);
  } else if (!strcmp(w, "!")) {
    /* nothing is being sent right now */
  } else if (!strcmp(w, "mode")) {
    int m = !a1 ? -1 : !strcmp(a1, "air") ? AM_MODE_AIR : !strcmp(a1, "water") ? AM_MODE_WATER : -1;
    if (m < 0) Serial.printf("ERR usage: mode air|water (now %s)\n", am_mode_info(g_mode)->name);
    else if (!setMode(m)) Serial.println("ERR busy receiving, try again");
    printInfo();
  } else if (!strcmp(w, "info")) printInfo();
  else if (!strcmp(w, "on")) sendCommand(id, CMD_LED_ON, 0);
  else if (!strcmp(w, "off")) sendCommand(id, CMD_LED_OFF, 0);
  else if (!strcmp(w, "toggle")) sendCommand(id, CMD_LED_TOGGLE, 0);
  else if (!strcmp(w, "ping")) sendCommand(id, CMD_PING, 0);
  else if (!strcmp(w, "send") && a1 && a2) sendCommand(a3 ? atoi(a3) : PEER_ID, (uint8_t)atoi(a1), (uint8_t)atoi(a2));
  else if (!strcmp(w, "sweep")) doSweep();
  else if (!strcmp(w, "tone") && a1 && a2) doTone(atoi(a1), atoi(a2));
  else if (!strcmp(w, "scope")) g_scope = a1 ? !strcmp(a1, "on") : !g_scope;
  else if (!strcmp(w, "stats")) printStats();
  else printHelp();
}

/* ------------------------------------------------------------------------ */
void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(300);
  pinMode(PIN_LED, OUTPUT);
  setLed(false);
  pinMode(PIN_BUTTON, INPUT_PULLUP);
#if PIN_AMP_ENABLE >= 0
  pinMode(PIN_AMP_ENABLE, OUTPUT);
  ampEnable(false);
#endif
  ledcAttach(PIN_TX_AUDIO, 5000, 10);
  ledcWrite(PIN_TX_AUDIO, 0);
  for (int i = 0; i < 16; i++) g_last_seq[i] = -1;
  am_text_rx_init(&g_text);

  g_prefs.begin("duburi", false);
  g_mode = g_prefs.getUChar("mode", (uint8_t)DEFAULT_MODE);
  if (g_mode != AM_MODE_AIR && g_mode != AM_MODE_WATER) g_mode = DEFAULT_MODE;

  g_rx_lock = xSemaphoreCreateMutex();
  g_pkt_queue = xQueueCreate(8, sizeof(am_rx_result_t));
  am_rx_init(&g_rx, AM_FS_NOMINAL);
  am_rx_set_mode(&g_rx, g_mode);
  if (!startAdc()) {
    Serial.println("ERR ADC start failed");
    for (;;) delay(1000);
  }
  /* core 0, above Arduino loop priority; it blocks on the ADC most of the time */
  xTaskCreatePinnedToCore(rxTask, "amrx", 6144, NULL, 5, NULL, 0);
  g_heat_t = esp_timer_get_time();

  Serial.printf("\nDUBURI modem node %d ready. Mode %s, tones %.0f..%.0f Hz, packet %.2f s\n",
                NODE_ID, am_mode_info(g_mode)->name, am_tone_hz(0), am_tone_hz(AM_NTONES - 1),
                packetMs() / 1000.0f);
  printInfo();
  printHelp();
}

void loop() {
  static char line[320];
  static int len = 0;
  static bool overflow = false;
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      line[len] = 0;
      if (overflow) Serial.println("ERR line too long");
      else handleLine(line);
      len = 0;
      overflow = false;
    } else if (len < (int)sizeof(line) - 1) {
      line[len++] = c;
    } else {
      overflow = true;
    }
  }

  static uint32_t btn_ms = 0;
  if (digitalRead(PIN_BUTTON) == LOW && millis() - btn_ms > 500) {
    btn_ms = millis();
    sendCommand(PEER_ID, CMD_LED_TOGGLE, 0);
  }

  static uint32_t scope_ms = 0;
  if (g_scope && millis() - scope_ms > 250) {
    scope_ms = millis();
    printScope();
  }
  pollEvents();
  pollPackets();
  delay(2);
}
