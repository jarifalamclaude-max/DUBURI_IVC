# DUBURI IVC: পানির নিচে ROV-to-ROV acoustic communication

দুটো ROV শব্দ (tone) দিয়ে একে অপরকে ছোট command পাঠায়, যেমন "LED জ্বালাও"। চাইলে উত্তরে ACK-ও পাঠায়।

- **TX:** ESP32 → RC filter → PAM8403 class-D amp → car speaker (sealed box)
- **RX:** piezo disc hydrophone → op-amp preamp → ESP32 ADC (DMA, 50 kHz) → modem
- **Modem:** 24 tone (3–8.75 kHz), 4-FSK + frequency hopping, K=7 convolutional code + Viterbi, CRC-16. Packet 1.28 s, দূরত্ব 10–25 m।

**পুরো গাইড (বাংলা, A–Z, সব formula ও circuit সহ): [`docs/DUBURI_IVC_Guide.pdf`](docs/DUBURI_IVC_Guide.pdf)**

## Folder

| Path | কী আছে |
|---|---|
| `firmware/DuburiModem/` | ESP32 Arduino sketch। শুধু `config.h` বদলাতে হয় (NODE_ID, pin) |
| `firmware/DuburiModem/am_core.c/.h` | Modem-এর মূল code, সাধারণ C। একই file PC test-এ চলে |
| `tests/` | PC-তে unit test: `make -C tests && ./tests/test_core` |
| `sim/` | Virtual pool simulation: `python3 sim/run_sim.py` (আগে `make -C tests`) |
| `docs/` | গাইডের উৎস (`guide_bn.html`), চিত্র (`figures.py`), PDF build (`build_pdf.py`) |

## দ্রুত শুরু

1. Arduino IDE 2.x → Boards Manager URL: `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
   → "esp32 by Espressif Systems" **3.x** install করো।
2. `firmware/DuburiModem/DuburiModem.ino` খোলো। Board হবে "ESP32 Dev Module"।
3. `config.h`-এ প্রথম ROV-এ `NODE_ID 1` / `PEER_ID 2`, দ্বিতীয়টায় উল্টো।
4. Upload করো। Serial Monitor 115200 baud, "Newline"। লিখে দেখো: `on`, `off`, `ping`, `stats`, `scope`, `sweep`।

Wiring, speaker গরম হওয়ার সমাধান, piezo seal করার নিয়ম আর test-এর ধাপ: গাইডের অধ্যায় 5–10 ও 18।

## Rebuild

```bash
make -C tests && ./tests/test_core      # unit tests + builds sim/libamcore.so
python3 sim/run_sim.py                  # ~5 min, writes sim/results/
python3 docs/figures.py                 # schematics + figures
python3 docs/build_pdf.py               # needs Chrome/Chromium (set CHROME=/path if not found)
```

Python packages: `numpy scipy matplotlib schemdraw`।

## Status

- Firmware Arduino-ESP32 core 3.3.12-এ compile হয়, কোনো warning নেই।
- Unit test সব pass করে।
- Virtual pool-এ ফল: in-band SNR −6 dB-এ 90%, 0 dB-এ 100% packet ঠিক আসে। 10 মিনিট noise-এ 0 false packet।
- **আসল hardware ও পানিতে এখনো test হয়নি।** গাইডের অধ্যায় 18 ধরে test করো।
- Independent review-এর ফল: [`docs/VERIFICATION.md`](docs/VERIFICATION.md)।
