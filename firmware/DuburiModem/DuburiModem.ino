/*
 * DuburiModem.ino - underwater acoustic link between two ROVs (ESP32).
 *
 * Board : "ESP32 Dev Module" (Arduino-ESP32 core 3.x, tested with 3.3.12)
 * Needs : no extra libraries.
 *
 * Same firmware on every vehicle; set NODE_ID in config.h.
 *
 * Serial Monitor (115200 baud, "Newline") commands:
 *   on [id]        turn LED on at vehicle id (default PEER_ID, 15 = all)
 *   off [id]       turn LED off
 *   toggle [id]    toggle LED
 *   ping [id]      ask for a reply, prints link quality
 *   send C A [id]  send command number C (0..255) with argument A (0..255)
 *   sweep          play every tone once (frequency response test)
 *   tone F MS      play F Hz for MS milliseconds
 *   scope          start/stop printing per-tone levels every 0.25 s
 *   stats          print counters, ADC level and measured sample rate
 *   help
 * Received packets are printed as:  RX src=2 dst=1 seq=3 cmd=1 arg=0 q=18.5dB
 * so a Jetson / Raspberry Pi can read the same serial port.
 */
#include <Arduino.h>
#include "config.h"
#include "am_core.h"
#include "esp_adc/adc_continuous.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "freertos/queue.h"

#if !defined(ESP_ARDUINO_VERSION_MAJOR) || ESP_ARDUINO_VERSION_MAJOR < 3
#error "Install Arduino-ESP32 core 3.x (Tools > Board > Boards Manager > esp32 by Espressif)"
#endif

/* Command numbers (you can add your own: 10..255 are free) */
enum {
  CMD_LED_ON = 1,
  CMD_LED_OFF = 2,
  CMD_LED_TOGGLE = 3,
  CMD_PING = 4,
};

/* ------------------------------------------------------------------------ */
/* Receiver task (core 0): ADC DMA -> modem core -> queue                     */
/* ------------------------------------------------------------------------ */
static am_rx_t g_rx;                       /* ~40 kB, keep it off the stack */
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
  if (adc_continuous_io_to_channel(PIN_HYDROPHONE, &unit, &g_adc_chan) != ESP_OK || unit != ADC_UNIT_1) {
    Serial.println("ERROR: PIN_HYDROPHONE must be an ADC1 pin (32..39)");
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
static int64_t g_tx_allowed_at = 0;   /* heat guard */
static uint8_t g_seq = 0;
static bool g_scope = false;
static bool g_led = false;

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

/* Heat guard: after a transmission of T seconds the speaker must rest
 * T * (1 - duty) / duty seconds before the next one. */
static void heatGuard() {
  int64_t wait = g_tx_allowed_at - esp_timer_get_time();
  if (wait > 0) {
    Serial.printf("HEAT-GUARD wait %d ms\n", (int)(wait / 1000));
    waitUntil(g_tx_allowed_at);
  }
}

static void heatGuardUpdate(int64_t t_start, int64_t t_end) {
  float on = (float)(t_end - t_start);
  g_tx_allowed_at = t_end + (int64_t)(on * (1.0f - MAX_TX_DUTY) / MAX_TX_DUTY);
}

static void playTones(const uint8_t *tones, int count) {
  const int64_t slot_us = (int64_t)(AM_T_SLOT * 1e6f);
  heatGuard();
  uint32_t mute_ms = (uint32_t)(count * AM_T_SLOT * 1000.0f) + 40 + MUTE_TAIL_MS;
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
  heatGuardUpdate(t0, esp_timer_get_time());
}

static void sendPacket(const am_packet_t &p) {
  uint8_t tones[AM_TOTAL_SLOTS];
  am_tx_build(&p, tones);
  playTones(tones, AM_TOTAL_SLOTS);
}

/* ------------------------------------------------------------------------ */
/* Packet handling                                                          */
/* ------------------------------------------------------------------------ */
static int16_t g_last_seq[16];
static uint32_t g_last_seq_ms[16];

static void setLed(bool on) {
  g_led = on;
  digitalWrite(PIN_LED, on ? HIGH : LOW);
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
    while (millis() - t0 < ACK_TIMEOUT_MS) {
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

static void doSweep() {
  Serial.println("SWEEP: each tone 300 ms. Watch 'scope' on the other vehicle.");
  for (int i = 0; i < AM_NTONES; i++) {
    uint8_t t[15];
    for (int k = 0; k < 15; k++) t[k] = (uint8_t)i;
    Serial.printf("SWEEP tone %d = %.0f Hz\n", i, am_tone_hz(i));
    playTones(t, 15);
    delay(150);
  }
}

static void doTone(int hz, int ms) {
  if (hz < 100 || hz > 20000 || ms < 1 || ms > 5000) {
    Serial.println("usage: tone <100..20000 Hz> <1..5000 ms>");
    return;
  }
  heatGuard();
  muteRx((uint32_t)ms + MUTE_TAIL_MS);
  ampEnable(true);
  int64_t t0 = esp_timer_get_time();
  uint32_t real = ledcWriteTone(PIN_TX_AUDIO, (uint32_t)hz);
  Serial.printf("TONE %d Hz (real %lu Hz) for %d ms\n", hz, (unsigned long)real, ms);
  delay(ms);
  ledcWrite(PIN_TX_AUDIO, 0);
  ampEnable(false);
  heatGuardUpdate(t0, esp_timer_get_time());
}

static void printHelp() {
  Serial.println("Commands: on|off|toggle|ping [id] ; send <cmd> <arg> [id] ; sweep ; tone <Hz> <ms> ; scope ; stats ; help");
}

static void handleLine(char *line) {
  char *w = strtok(line, " \t");
  if (!w) return;
  char *a1 = strtok(NULL, " \t"), *a2 = strtok(NULL, " \t"), *a3 = strtok(NULL, " \t");
  int id = a1 ? atoi(a1) : PEER_ID;
  if (!strcmp(w, "on")) sendCommand(id, CMD_LED_ON, 0);
  else if (!strcmp(w, "off")) sendCommand(id, CMD_LED_OFF, 0);
  else if (!strcmp(w, "toggle")) sendCommand(id, CMD_LED_TOGGLE, 0);
  else if (!strcmp(w, "ping")) sendCommand(id, CMD_PING, 0);
  else if (!strcmp(w, "send") && a1 && a2) sendCommand(a3 ? atoi(a3) : PEER_ID, (uint8_t)atoi(a1), (uint8_t)atoi(a2));
  else if (!strcmp(w, "sweep")) doSweep();
  else if (!strcmp(w, "tone") && a1 && a2) doTone(atoi(a1), atoi(a2));
  else if (!strcmp(w, "scope")) g_scope = !g_scope;
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

  g_rx_lock = xSemaphoreCreateMutex();
  g_pkt_queue = xQueueCreate(8, sizeof(am_rx_result_t));
  am_rx_init(&g_rx, AM_FS_NOMINAL);
  if (!startAdc()) {
    Serial.println("ERROR: ADC start failed");
    for (;;) delay(1000);
  }
  /* core 0, above Arduino loop priority; it blocks on the ADC most of the time */
  xTaskCreatePinnedToCore(rxTask, "amrx", 6144, NULL, 5, NULL, 0);

  Serial.printf("\nDUBURI modem node %d ready. Tones %.0f..%.0f Hz, packet %.2f s\n",
                NODE_ID, am_tone_hz(0), am_tone_hz(AM_NTONES - 1), AM_TOTAL_SLOTS * AM_T_SLOT);
  printHelp();
}

void loop() {
  static char line[64];
  static int len = 0;
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      line[len] = 0;
      handleLine(line);
      len = 0;
    } else if (len < (int)sizeof(line) - 1) {
      line[len++] = c;
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
  pollPackets();
  delay(2);
}
