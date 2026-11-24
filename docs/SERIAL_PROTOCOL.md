# DUBURI modem: USB serial protocol (PC ⇄ ESP32)

115200 baud, 8N1. Every line ends with `\n` (`\r` is ignored). The same firmware
runs on every board, so the sender page and the receiver page talk the same
protocol. Lines the PC does not understand must be ignored (the firmware also
prints human-readable text).

## Commands (PC → board)

| Line | What it does |
|---|---|
| `info` | Board answers with one `INFO` line. |
| `msg <text>` | Send the rest of the line (raw UTF-8 bytes) as a text message to `PEER_ID`. |
| `msghex <dst> <repeats> <hex>` | Send bytes given as hex (`48656C6C6F`) to node `dst` (1..15, 15 = all), each packet sent `repeats` times (1..3). This is what the web pages use. |
| `!` | Abort a text message that is being sent (checked between packets). |
| `mode air` / `mode water` | Switch the medium. Saved in flash. Board answers with `INFO`. Both boards must use the same mode. |
| `scope on` / `scope off` / `scope` | Start / stop / toggle `SCOPE` lines every 0.25 s. |
| `stats` | Board answers with `STATS`, `ADC`, `LEVEL` lines. |
| `on [id]`, `off [id]`, `toggle [id]`, `ping [id]`, `send C A [id]` | Old ROV commands (LED etc.). They wait for an ACK, so they need a speaker *and* a hydrophone on both boards. |
| `sweep`, `tone <Hz> <ms>`, `help` | Test tools. |

Text limits: 1..64 bytes, no byte `0x00`. Bangla letters are 3 bytes each in UTF-8,
so 64 bytes is about 21 Bangla letters or 64 English letters.

## Lines from the board (board → PC)

Fields are `key=value`, separated by single spaces. `text=` is always the last field
and runs to the end of the line.

### Always
```
INFO node=1 peer=2 fw=2.0 mode=air text_max=64 slot_ms=40 pkt_ms=2560 duty=0.75 burst_s=10.0
ERR <human readable reason>
HEAT-GUARD wait 1234 ms
```
`INFO` is also printed once after boot and after every `mode` command.

| mode | slot | one packet | gap between text packets | heat guard (duty / burst) |
|---|---|---|---|---|
| `air` | 40 ms (32 ms window) | 2.56 s | 0.40 s | 75 % / 10 s |
| `water` | 20 ms (16 ms window) | 1.28 s | 0.40 s | 50 % / 6 s |

Heat guard: a bucket fills by (1 − duty) per second of sound and empties by duty per
second of silence; a packet may start when bucket + pkt·(1 − duty) ≤ burst·(1 − duty),
otherwise the board prints `HEAT-GUARD wait … ms` and waits.

### While sending a text message
```
TXMSG dst=2 len=11 n=6 rep=1
TXPKT i=1 n=6 try=1 seq=3 flags=A data=4865 tones=0,14,6,22,9,17,4,21,5,11,...
TXDONE n=6 ms=15360
TXABORT i=3 n=6
```
* `TXPKT` is printed just before the packet starts playing. `i` is 1-based, `try`
  counts repeats (1..rep). `data` is the 1 or 2 payload bytes in hex. `tones` are
  the 64 tone indexes (0..23, tone k = 3000 + 250·k Hz), one per slot (`slot_ms`): the
  first 10 are the preamble, the other 54 carry the coded bits.
* After `TXDONE` or `TXABORT` the board accepts commands again. Anything sent to
  the board while a message is going out is ignored, except `!`.

### While receiving
```
DET n=12
CRCFAIL n=3
TXT src=1 dst=2 seq=3 first=1 last=0 data=4865 q=12.3
REPEAT src=1 seq=3 (dropped)
MSG src=1 dst=2 ok=1 lost=0 len=11 q=12.3 hex=48656C6C6F20776F726C64 text=Hello world
RX src=2 dst=1 seq=3 cmd=1 arg=0 flags=8 q=18.5dB
ACK src=2 seq=3 cmd=1 state=1 q=18.5dB
SCOPE 3 5 0 -1 ... (24 numbers, dB above each tone's noise floor)  rms=40
STATS node=1 preambles=12 ok=10 crc_fail=2 last_q=12.3dB timing_adj=0.4
ADC fs_measured=50612.3 fs_used=50612.0 overflows=0 clipped=0 rx_cpu=31% peak=34% (want overflows=0, rx_cpu<70%)
LEVEL mean=1650 rms=42.0 min=1400 max=1900 (want rms 20..300, min>100, max<3900)
```
* `DET`: a preamble was heard, a packet is coming (its data part lasts 54 slots:
  2.16 s in AIR, 1.08 s in WATER).
  `n` is the running count of preambles.
* `CRCFAIL`: a packet arrived but was damaged; `n` is the running count.
* `ADC ... rx_cpu`: share of ESP32 core 0 the receiver used over the last ~2 s
  (`peak` = highest since power-on). `overflows` counts ADC samples lost because
  the receiver fell behind; it must stay 0. Older firmware prints no `rx_cpu`.
* `TXT`: one text packet decoded correctly. `q` is link quality in dB
  (≥ 10 good, 7–10 OK, < 7 weak).
* `REPEAT`: a packet the sender repeated (`rep` > 1) was dropped; adds no bytes.
* `MSG`: a whole message is finished. A `MSG` that closes an older unfinished message
  may come right before a `TXT … first=1` of the next message. `ok=1` means every packet arrived.
  `lost` = number of packets known to be missing. In `hex`, a lost byte is `__`.
  `q` is the average `q` of the packets that arrived. `text` is for humans
  (Serial Monitor): lost bytes are `?`, control bytes are `.`. Pages should decode
  `hex` as UTF-8 instead.

## Text packet format (on the air)

A text message is cut into packets of 2 bytes. Each packet is a normal 4-byte
DUBURI frame (+ CRC-16, + convolutional code, 64 slots), with:

| Field | Value |
|---|---|
| dst / src | destination / sender node (4 bits each) |
| seq | running packet counter mod 16 (never reset, so repeats can be dropped) |
| flags | `0x2` TEXT, `0x8` FIRST (first packet of a message), `0x1` LAST |
| cmd, arg | the 2 data bytes; if the message length is odd, the LAST packet's 2nd byte is `0x00` padding |

The receiver drops a packet whose `seq` equals the previous one from the same
sender (a repeat), fills gaps in `seq` with lost bytes, and finishes the message at
LAST, at a new FIRST, or after 8 s of silence.
