# DUBURI IVC: পানির নিচে ROV-to-ROV acoustic communication

দুটো ROV শব্দ (tone) দিয়ে একে অপরকে ছোট command পাঠায়, যেমন "LED জ্বালাও"। চাইলে উত্তরে ACK-ও পাঠায়।

- **TX:** ESP32 → RC filter → PAM8403 class-D amp → car speaker (sealed box)
- **RX:** piezo disc hydrophone → op-amp preamp → ESP32 ADC (DMA, 50 kHz) → modem
- **Modem:** 24 tone (3–8.75 kHz), 4-FSK + frequency hopping, K=7 convolutional code + Viterbi, CRC-16. Packet 1.28 s, দূরত্ব 10–25 m।

**পুরো গাইড (বাংলা, A–Z, সব formula ও circuit সহ): [`docs/DUBURI_IVC_Guide.pdf`](docs/DUBURI_IVC_Guide.pdf)**

### নতুন: PC থেকে PC টেক্সট মডেম, AIR ও WATER মোড

PC 1-এর web page-এ লেখা টাইপ করো → speaker দিয়ে tone হয়ে যায় → PC 2-এর microphone শোনে → dashboard-এ লেখা দেখায়।
Firmware-এ দুই মোড: **AIR** (speaker → MAX9814 mic, ঘরের মধ্যে, 40 ms slot) আর **WATER** (পুল, 20 ms slot)।
কেনাকাটার তালিকা, breadboard wiring ছবি, ব্যবহার আর পরীক্ষার ধাপ: **[`docs/TEXT_MODEM_GUIDE.md`](docs/TEXT_MODEM_GUIDE.md)**।
**নতুনদের জন্য:** একটা অক্ষর (“L”) কীভাবে bit, packet, ভুল-সংশোধন হয়ে 64টা tone হয়, ধাপে ধাপে ছবি আর আসল সংখ্যা দিয়ে:
[`docs/L_theke_tone_BN.pdf`](docs/L_theke_tone_BN.pdf) (বাংলা), [`docs/L_to_tones_EN.pdf`](docs/L_to_tones_EN.pdf) (English)।
দুটোই তৈরি হয় `node docs/explainer/build_explainer.js` দিয়ে।

**Board ছাড়াই পরীক্ষা:** `pc/sender.html`-এ "Use this computer's speaker" আর `pc/receiver.html`-এ "Use this computer's microphone"
চাপলে ল্যাপটপের নিজের speaker/mic দিয়েই একই modem চলে (এক ল্যাপটপে দুই window-এ, বা দুই ল্যাপটপে)। গাইডের 6.1 দেখো।

## Folder

| Path | কী আছে |
|---|---|
| `firmware/DuburiModem/` | ESP32 Arduino sketch। শুধু `config.h` বদলাতে হয় (NODE_ID, PEER_ID, মোড, pin) |
| `firmware/DuburiModem/am_core.c/.h` | Modem-এর মূল code, সাধারণ C। একই file PC test-এ চলে |
| `firmware/DuburiModem/am_text.c/.h` | টেক্সট message ভাগ করা ও জোড়া লাগানো (2 byte/packet) |
| `pc/` | `sender.html` আর `receiver.html`: Chrome/Edge-এ USB দিয়ে board-এর সাথে, বা ল্যাপটপের speaker/mic দিয়ে সরাসরি; internet লাগে না |
| `pc/phone_receiver.html` | ফোনের mic দিয়ে receive (https link থেকে খুলতে হয়; গাইড অধ্যায় 6.2) |
| `pc/amcore.js` | Modem-এর JavaScript রূপ (am_core.c + am_text.c-এর হুবহু port), দুই page-এ ঢোকানো থাকে (`pc/sync_common.py`) |
| `tests/` | PC-তে unit test: `make -C tests && ./tests/test_core && ./tests/test_text` |
| `sim/` | Virtual pool: `python3 sim/run_sim.py`; virtual ঘর (AIR): `python3 sim/air_sim.py` |
| `docs/` | গাইডের উৎস, [`TEXT_MODEM_GUIDE.md`](docs/TEXT_MODEM_GUIDE.md), [`SERIAL_PROTOCOL.md`](docs/SERIAL_PROTOCOL.md), `wiring/` (breadboard ছবি) |

## দ্রুত শুরু

1. Arduino IDE 2.x → Boards Manager URL: `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
   → "esp32 by Espressif Systems" **3.x** install করো।
2. `firmware/DuburiModem/DuburiModem.ino` খোলো। Board হবে "ESP32 Dev Module"।
3. `config.h`-এ প্রথম ROV-এ `NODE_ID 1` / `PEER_ID 2`, দ্বিতীয়টায় উল্টো।
4. Upload করো। Serial Monitor 115200 baud, "Newline"। লিখে দেখো: `info`, `msg Hello`, `mode air`, `stats`, `scope`, `sweep`
   (`on`, `off`, `ping` ACK চায়, তাই দুই board-এ speaker আর mic দুটোই লাগে)।
5. অথবা Serial Monitor বন্ধ করে `pc/sender.html` / `pc/receiver.html` খোলো (Chrome/Edge)।

Wiring, speaker গরম হওয়ার সমাধান, piezo seal করার নিয়ম আর test-এর ধাপ: গাইডের অধ্যায় 5–10 ও 18।

## Rebuild

```bash
make -C tests && ./tests/test_core && ./tests/test_text   # unit tests + builds sim/libamcore.so
python3 sim/run_sim.py                  # ~5 min, writes sim/results/
python3 sim/air_sim.py                  # AIR timing sweep in virtual rooms (~4 min)
python3 sim/air_sim.py text             # multi-packet text messages, room + pool
node pc/test/ui_test.js                 # web page tests (Playwright + Chromium)
python3 pc/test/make_vectors.py && node pc/test/amcore_test.js   # JavaScript modem == C modem
node pc/test/audio_test.js              # laptop speaker/mic mode end to end (fake microphone)
node pc/test/phone_test.js              # phone page: fake microphone, Pixel 5 screen
python3 docs/wiring/wiring.py           # breadboard wiring pictures + connection check
python3 docs/figures.py                 # schematics + figures
python3 docs/build_pdf.py               # needs Chrome/Chromium (set CHROME=/path if not found)
```

Python packages: `numpy scipy matplotlib schemdraw`।

## Status

- Firmware (v2.0, AIR/WATER + টেক্সট) Arduino-ESP32 core 3.3.12-এ compile হয়, কোনো warning নেই।
- Unit test সব pass করে (core, দুই মোড, টেক্সট layer)।
- Virtual pool-এ ফল: in-band SNR −6 dB-এ 90%, 0 dB-এ 100% packet ঠিক আসে। 10 মিনিট noise-এ 0 false packet।
- Virtual ঘরে (AIR, 40 ms slot): 0 dB-এ 29–30/30, −4 dB-এ 26–30/30 packet। একটানা message-এ 60/60 packet।
- **আসল hardware, ঘর ও পানিতে এখনো test হয়নি।** [`docs/TEXT_MODEM_GUIDE.md`](docs/TEXT_MODEM_GUIDE.md)-এর অধ্যায় 7 আর মূল গাইডের অধ্যায় 18 ধরে test করো।
- Independent review-এর ফল: [`docs/VERIFICATION.md`](docs/VERIFICATION.md)।
