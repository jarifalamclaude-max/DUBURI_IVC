/*
 * ui_test.js - browser tests for pc/sender.html and pc/receiver.html.
 *
 *   node pc/test/ui_test.js            (uses the preinstalled Playwright Chromium)
 *   SHOTS=/some/dir node pc/test/ui_test.js   also saves screenshots there
 *
 * A fake navigator.serial is injected so the REAL Web Serial code path of the
 * pages is tested (separate from the pages' own Demo mode, which is tested too).
 */
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const SENDER = "file://" + path.join(ROOT, "pc", "sender.html");
const RECEIVER = "file://" + path.join(ROOT, "pc", "receiver.html");
const SHOTS = process.env.SHOTS || "";

let passed = 0, failed = 0;
function check(cond, name, extra) {
  if (cond) { passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

/* ---------- independent reference implementation (not copied from the page) ---------- */
function crcRef(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    for (let i = 7; i >= 0; i--) {
      const bit = ((b >> i) & 1) ^ ((crc >> 15) & 1);
      crc = (crc << 1) & 0xffff;
      if (bit) crc ^= 0x1021;
    }
  }
  return crc;
}
function refPackets(text, dst, src, seq0) {
  const b = Array.from(Buffer.from(text, "utf8"));
  const n = Math.ceil(b.length / 2);
  const out = [];
  for (let i = 0; i < n; i++) {
    const flags = 0x2 | (i === 0 ? 0x8 : 0) | (i === n - 1 ? 0x1 : 0);
    const seq = (seq0 + i) % 16;
    const fr = [dst * 16 + src, seq * 16 + flags, b[2 * i], 2 * i + 1 < b.length ? b[2 * i + 1] : 0];
    out.push({ seq, flags, crc: crcRef(fr), frame: fr });
  }
  return { bytes: b, packets: out };
}
const hexOf = (s) => Buffer.from(s, "utf8").toString("hex").toUpperCase();

/* ---------- mock Web Serial port ---------- */
const MOCK = () => {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const st = { written: [], signals: [], ctl: null, buf: "", opened: false, baud: 0 };
  const port = {
    readable: null, writable: null,
    async open(o) {
      st.opened = true; st.baud = o.baudRate;
      port.readable = new ReadableStream({ start(c) { st.ctl = c; }, cancel() { st.ctl = null; } });
      port.writable = new WritableStream({
        write(chunk) {
          st.buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = st.buf.indexOf("\n")) >= 0) { st.written.push(st.buf.slice(0, i)); st.buf = st.buf.slice(i + 1); }
        },
      });
    },
    async close() { st.opened = false; },
    async setSignals(s) { st.signals.push(s); },
    getInfo() { return { usbVendorId: 0x10c4, usbProductId: 0xea60 }; },
    addEventListener() {}, removeEventListener() {},
  };
  window.__mock = {
    st,
    push(line) { if (st.ctl) st.ctl.enqueue(enc.encode(line + "\n")); },
    pushRaw(text) { if (st.ctl) st.ctl.enqueue(enc.encode(text)); },
    unplug() { const c = st.ctl; st.ctl = null; port.readable = null; if (c) c.error(new DOMException("The device has been lost.", "NetworkError")); },
  };
  Object.defineProperty(navigator, "serial", {
    configurable: true,
    value: { requestPort: async () => port, getPorts: async () => [port], addEventListener() {}, removeEventListener() {} },
  });
};

async function newPage(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1, colorScheme: opts.dark ? "dark" : "light", acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  if (opts.mock !== false) await page.addInitScript(MOCK);
  return { ctx, page, errors };
}
const written = (page) => page.evaluate(() => window.__mock.st.written.slice());
const push = (page, ...lines) => page.evaluate((ls) => ls.forEach((l) => window.__mock.push(l)), lines);
const txt = (page, sel) => page.textContent(sel);
async function waitFor(fn, ms = 5000, step = 50) {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return true; } catch (_) { /* retry */ }
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}
async function connect(page) {
  await page.click("#btnConnect");
  return waitFor(async () => (await written(page)).includes("info"), 3000);
}

/* tones from the real C core, if sim/libamcore.so is built */
function cTones(pkts) {
  const lib = path.join(ROOT, "sim", "libamcore.so");
  if (!fs.existsSync(lib)) return null;
  const py = `
import ctypes, json, sys
class P(ctypes.Structure):
    _fields_ = [(n, ctypes.c_uint8) for n in ("dst", "src", "seq", "flags", "cmd", "arg")]
L = ctypes.CDLL(sys.argv[1])
out = []
for p in json.loads(sys.argv[2]):
    t = (ctypes.c_uint8 * 64)()
    L.am_tx_build(ctypes.byref(P(*p)), t)
    out.append(list(t))
print(json.dumps(out))`;
  try { return JSON.parse(execFileSync("python3", ["-I", "-c", py, lib, JSON.stringify(pkts)]).toString()); }
  catch (e) { return null; }
}

function commonBlock(file, start, end) {
  const s = fs.readFileSync(file, "utf8");
  const i = s.indexOf(start), j = s.indexOf(end);
  return i >= 0 && j > i ? s.slice(i, j) : null;
}

(async () => {
  const browser = await chromium.launch();

  /* ---- 0. file:// gives Web Serial? common blocks identical? ---- */
  {
    const { page, ctx } = await newPage(browser, { mock: false });
    await page.goto(SENDER);
    const has = await page.evaluate(() => "serial" in navigator);
    console.log("INFO file:// page: 'serial' in navigator = " + has + ", isSecureContext = " + (await page.evaluate(() => isSecureContext)));
    check(has, "Web Serial API present on a file:// page in this Chromium");
    check(await page.isHidden("#noSerialBanner"), "no 'unsupported browser' banner when Web Serial exists");
    await ctx.close();
    for (const [a, b] of [["COMMON CSS START", "COMMON CSS END"], ["COMMON JS START", "COMMON JS END"]]) {
      const x = commonBlock(path.join(ROOT, "pc", "sender.html"), a, b), y = commonBlock(path.join(ROOT, "pc", "receiver.html"), a, b);
      check(x && x === y, `${a.split(" START")[0]} block identical in both pages`);
    }
  }

  /* ---- 0b. banner when Web Serial is missing ---- */
  {
    const { page, ctx } = await newPage(browser, { mock: false });
    await page.addInitScript(() => { delete Navigator.prototype.serial; });
    await page.goto(SENDER);
    check(await page.isVisible("#noSerialBanner"), "banner shown when navigator.serial is missing");
    check(await page.isDisabled("#btnConnect"), "Connect disabled without Web Serial");
    await ctx.close();
  }

  /* ---- 1. sender over (mock) serial ---- */
  {
    const { page, ctx, errors } = await newPage(browser);
    await page.goto(SENDER);
    check(await connect(page), "sender: connect opens port and sends 'info'");
    check((await page.evaluate(() => window.__mock.st.baud)) === 115200, "sender: 115200 baud");
    await push(page, "DUBURI modem node 1 ready. Tones 3000..8750 Hz, packet 1.28 s",
      "INFO node=1 peer=2 fw=2.0 mode=water text_max=64 slot_ms=20 pkt_ms=1280 duty=0.50 burst_s=6.0");
    await waitFor(async () => (await txt(page, "#connPill")).includes("node 1"));
    check((await txt(page, "#connPill")).includes("Connected · node 1"), "sender: pill shows node from INFO", await txt(page, "#connPill"));
    check((await page.inputValue("#dst")) === "2", "sender: destination defaults to peer from INFO");

    // partial line handling: a line split over two chunks
    await page.evaluate(() => { window.__mock.pushRaw("ERR split "); });
    await page.evaluate(() => { window.__mock.pushRaw("line ok\n"); });
    await waitFor(async () => !(await page.isHidden("#txErr")));
    check((await txt(page, "#txErr")).includes("ERR split line ok") || (await txt(page, "#txErr")).includes("split line ok"), "sender: line split across chunks is joined", await txt(page, "#txErr"));

    const msg = "Hi DUBURI";
    await page.fill("#msg", msg);
    const ref = refPackets(msg, 2, 1, 0);
    check((await txt(page, "#bytesCount")).startsWith("9 / 64"), "sender: byte counter for 'Hi DUBURI'", await txt(page, "#bytesCount"));
    check((await txt(page, "#pktCount")) === "5 packets", "sender: packet count 5", await txt(page, "#pktCount"));
    const crcs = await page.$$eval("#pktBody tr", (rows) => rows.map((r) => r.children[4].textContent.trim()));
    check(JSON.stringify(crcs) === JSON.stringify(ref.packets.map((p) => p.crc.toString(16).toUpperCase().padStart(4, "0"))), "sender: CRC-16 of every packet matches reference", { crcs });
    const flags = await page.$$eval("#pktBody tr", (rows) => rows.map((r) => r.children[2].textContent.split("·")[1].trim().slice(0, 1)));
    check(flags.join("") === "A2223", "sender: flags FIRST/TEXT/LAST", flags);
    const lastData = await page.$eval("#pktBody tr:last-child td:nth-child(4)", (td) => td.textContent);
    check(lastData.includes("49") && lastData.includes("pad"), "sender: odd length -> last packet padded", lastData);
    check((await txt(page, "#airBig")).startsWith("≈ "), "sender: airtime estimate shown", await txt(page, "#airBig"));
    const air = parseFloat((await txt(page, "#airBig")).slice(2));
    check(Math.abs(air - (5 * 1.28 + 4 * 0.40)) < 0.05, "sender: WATER airtime 5 packets = 8.0 s (no rest needed)", air);
    check((await txt(page, "#modeDesc")).includes("WATER") && (await page.getAttribute("#modeWater", "class")).includes("active"), "sender: WATER badge from INFO", await txt(page, "#modeDesc"));
    await page.click("#modeAir");
    await waitFor(async () => (await written(page)).includes("mode air"));
    check((await written(page)).includes("mode air"), "sender: AIR button sends 'mode air'");
    check((await txt(page, "#modeDesc")).includes("Switching"), "sender: mode switch pending", await txt(page, "#modeDesc"));
    await push(page, "ERR busy receiving, try again");
    await waitFor(async () => !(await txt(page, "#modeDesc")).includes("Switching"));
    check((await txt(page, "#modeDesc")).includes("WATER"), "sender: ERR busy keeps WATER", await txt(page, "#modeDesc"));
    await page.click("#modeAir");
    await push(page, "INFO node=1 peer=2 fw=2.0 mode=air text_max=64 slot_ms=40 pkt_ms=2560 duty=0.75 burst_s=10.0");
    await waitFor(async () => (await txt(page, "#modeDesc")).includes("AIR"));
    check((await txt(page, "#modeDesc")).includes("AIR") && (await txt(page, "#modeDesc")).includes("2.56 s"), "sender: AIR badge after mode INFO", await txt(page, "#modeDesc"));
    const airA = parseFloat((await txt(page, "#airBig")).slice(2));
    check(Math.abs(airA - (5 * 2.56 + 4 * 0.40)) < 0.05, "sender: AIR airtime 5 packets = 14.4 s", airA);
    check((await txt(page, "#fecTones")).includes("2.56 s"), "sender: packet length from INFO", await txt(page, "#fecTones"));
    await page.fill("#msg", "x".repeat(40));
    const air40 = parseFloat((await txt(page, "#airBig")).slice(2));
    const expect40 = (() => { const d = 0.75, B = 10 * (1 - d), T = 2.56; let h = 0, t = 0; for (let k = 0; k < 20; k++) { if (k) { t += 0.4; h = Math.max(0, h - 0.4 * d); } const need = h + T * (1 - d) - B; if (need > 0) { t += need / d; h -= need; } h += T * (1 - d); t += T; } return t; })();
    check(Math.abs(air40 - expect40) < 0.05 && (await txt(page, "#airDetail")).includes("heat guard"), "sender: AIR 20-packet estimate includes heat-guard rest", [air40, expect40]);
    await page.fill("#msg", msg);
    await page.click("#modeWater");
    await push(page, "INFO node=1 peer=2 fw=2.0 mode=water text_max=64 slot_ms=20 pkt_ms=1280 duty=0.50 burst_s=6.0");
    await waitFor(async () => (await txt(page, "#modeDesc")).includes("WATER"));
    check((await page.$$eval("#chars .cchip", (e) => e.length)) === 9, "sender: 9 letter boxes");

    // CRC check value
    check((await page.evaluate(() => crc16(Array.from(new TextEncoder().encode("123456789"))).toString(16))) === "29b1", "sender: CRC-16/CCITT-FALSE check value 0x29B1");

    // tones: page JS vs the real C core
    const pk = [[2, 1, 0, 0xA, 0x48, 0x69], [2, 1, 4, 0x3, 0x49, 0], [15, 7, 9, 0x2, 0xE0, 0xA6], [1, 2, 13, 0xB, 0x53, 0x4F]];
    const cref = cTones(pk);
    if (cref) {
      const js = await page.evaluate((pk) => pk.map((p) => amTones(amFrame(...p))), pk);
      check(JSON.stringify(js) === JSON.stringify(cref), "sender: JS tone builder == C am_tx_build() for 4 packets");
    } else console.log("SKIP C tone cross-check (sim/libamcore.so not built)");

    // send
    await page.click("#btnSend");
    await waitFor(async () => (await written(page)).some((l) => l.startsWith("msghex")));
    const w = (await written(page)).filter((l) => l.startsWith("msghex")).pop();
    check(w === "msghex 2 1 " + hexOf(msg), "sender: exact msghex line", w);
    check(await page.isDisabled("#btnSend"), "sender: Send disabled while sending");
    check(await page.isDisabled("#modeAir"), "sender: mode switch locked while sending");
    check(!(await page.isDisabled("#btnStop")), "sender: Stop enabled while sending");
    await push(page, "TXMSG dst=2 len=9 n=5 rep=1");
    await waitFor(async () => (await txt(page, "#txTitle")).includes("Sending 9 bytes"));
    check((await txt(page, "#txTitle")).includes("Sending 9 bytes in 5 packets to node 2"), "sender: TXMSG shown", await txt(page, "#txTitle"));
    const tones = await page.evaluate(() => amTones(amFrame(2, 1, 3, 0xA, 0x48, 0x69)));
    await push(page, `TXPKT i=1 n=5 try=1 seq=3 flags=A data=4869 tones=${tones.join(",")}`);
    await waitFor(async () => (await txt(page, "#txTitle")).startsWith("Packet 1 of 5"));
    check((await txt(page, "#txTitle")).includes("Packet 1 of 5") && (await txt(page, "#txTitle")).includes("seq 3"), "sender: TXPKT progress", await txt(page, "#txTitle"));
    await page.waitForTimeout(300);
    const f = await txt(page, "#nowFreq");
    check(/^\d{4} Hz$/.test(f), "sender: piano roll playhead shows current frequency", f);
    check((await txt(page, "#txData")).includes("01001000"), "sender: packet data bits shown", await txt(page, "#txData"));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "sender_light.png"), fullPage: true });
    await push(page, "HEAT-GUARD wait 1500 ms");
    await waitFor(async () => await page.isVisible("#heat"));
    check((await txt(page, "#heat")).includes("next packet in"), "sender: heat guard countdown", await txt(page, "#heat"));
    await page.click("#btnStop");
    await waitFor(async () => (await written(page)).includes("!"));
    check((await written(page)).includes("!"), "sender: Stop writes '!'");
    await push(page, "TXPKT i=5 n=5 try=1 seq=7 flags=3 data=49 tones=" + tones.join(","), "TXDONE n=5 ms=9000");
    await waitFor(async () => (await txt(page, "#sendStatus")).includes("Done"));
    check((await txt(page, "#sendStatus")).includes("Done"), "sender: TXDONE re-enables", await txt(page, "#sendStatus"));
    check(!(await page.isDisabled("#btnSend")), "sender: Send enabled after TXDONE");
    check((await txt(page, "#seqNote")).includes("should start at 8"), "sender: seq prediction from last TXPKT", await txt(page, "#seqNote"));

    // Bangla
    const bn = "আমি";
    await page.fill("#msg", bn);
    const rb = refPackets(bn, 2, 1, 8);
    check((await txt(page, "#bytesCount")).startsWith("9 / 64"), "sender: Bangla 'আমি' = 9 bytes", await txt(page, "#bytesCount"));
    check((await page.$$eval("#chars .cchip", (e) => e.length)) === 3, "sender: Bangla 3 letter boxes");
    const crcBn = await page.$$eval("#pktBody tr", (rows) => rows.map((r) => r.children[4].textContent.trim()));
    check(JSON.stringify(crcBn) === JSON.stringify(rb.packets.map((p) => p.crc.toString(16).toUpperCase().padStart(4, "0"))), "sender: Bangla CRCs with predicted seq 8", crcBn);
    await page.click("#btnSend");
    await waitFor(async () => (await written(page)).filter((l) => l.startsWith("msghex")).length === 2);
    check((await written(page)).filter((l) => l.startsWith("msghex")).pop() === "msghex 2 1 " + hexOf(bn), "sender: Bangla msghex line");
    await push(page, "ERR usage: mode air|water (now water)");
    await waitFor(async () => (await txt(page, "#txErr")).includes("usage: mode"));
    check((await txt(page, "#txErr")).includes("usage: mode"), "sender: ERR from a bad command shown");
    check(!(await page.isDisabled("#btnSend")), "sender: an ERR during a send ends it (Send enabled again)");
    await page.fill("#msg", bn);
    await page.click("#btnSend");
    await waitFor(async () => (await written(page)).filter((l) => l.startsWith("msghex")).length === 3);
    await push(page, "ERR too long (max 64 bytes)");
    await waitFor(async () => (await txt(page, "#sendStatus")).includes("Board error"));
    check((await txt(page, "#sendStatus")).includes("too long"), "sender: ERR ends the send and is shown", await txt(page, "#sendStatus"));
    check(await page.isVisible("#txErr"), "sender: ERR box visible");

    // repeats + destination
    await page.fill("#msg", "OK");
    await page.selectOption("#rep", "2");
    await page.selectOption("#dst", "15");
    await page.click("#btnSend");
    await waitFor(async () => (await written(page)).filter((l) => l.startsWith("msghex")).length === 4);
    check((await written(page)).filter((l) => l.startsWith("msghex")).pop() === "msghex 15 2 4F4B", "sender: repeat 2 + broadcast");
    await push(page, "TXABORT i=1 n=1");
    await waitFor(async () => (await txt(page, "#sendStatus")).includes("Stopped"));
    check((await txt(page, "#sendStatus")).includes("Stopped"), "sender: TXABORT handled");

    // limits
    await page.fill("#msg", "x".repeat(70));
    check(await page.isDisabled("#btnSend"), "sender: > 64 bytes disables Send");
    check((await txt(page, "#sendStatus")).includes("Too long"), "sender: too-long message explained");

    // reset button pulses RTS
    await page.click("#btnReset");
    await page.waitForTimeout(250);
    const sig = await page.evaluate(() => window.__mock.st.signals);
    check(sig.length >= 2 && sig[0].requestToSend === true && sig[0].dataTerminalReady === false && sig[1].requestToSend === false, "sender: Reset does the EN pulse", sig);

    // unplug
    await page.evaluate(() => window.__mock.unplug());
    await waitFor(async () => (await txt(page, "#connPill")).includes("disconnected"));
    check((await txt(page, "#connPill")).includes("Board disconnected"), "sender: unplug detected", await txt(page, "#connPill"));
    check(await page.isVisible("#connError"), "sender: unplug banner shown");
    check(await page.isVisible("#btnConnect"), "sender: Connect button back after unplug");
    check(errors.length === 0, "sender: no console errors", errors);
    await ctx.close();
  }

  /* ---- 2. receiver over (mock) serial ---- */
  {
    const { page, ctx, errors } = await newPage(browser);
    await page.goto(RECEIVER);
    check(await connect(page), "receiver: connect sends 'info'");
    await push(page, "INFO node=2 peer=1 fw=2.0 mode=air text_max=64 slot_ms=40 pkt_ms=2560 duty=0.75 burst_s=10.0");
    check(await waitFor(async () => (await written(page)).includes("stats"), 3000), "receiver: polls 'stats'");
    await waitFor(async () => (await txt(page, "#modeDesc")).includes("AIR"));
    check((await txt(page, "#modeDesc")).includes("AIR") && (await txt(page, "#pktSub")).includes("2.56 s"), "receiver: AIR mode + packet length from INFO", await txt(page, "#pktSub"));
    await push(page, "DET n=1");
    await waitFor(async () => (await txt(page, "#arriveText")).includes("arriving"));
    check((await txt(page, "#arriveText")).includes("arriving"), "receiver: DET shows packet arriving");
    check((await page.$eval("#arriveBar", (e) => e.style.transition)).includes("2160ms"), "receiver: arrival bar lasts 54 slots (2.16 s in AIR)", await page.$eval("#arriveBar", (e) => e.style.transition));
    await push(page, "TXT src=1 dst=2 seq=3 first=1 last=0 data=4869 q=12.3");
    await waitFor(async () => (await txt(page, "#partialText")).includes("Hi"));
    check((await txt(page, "#partialText")) === "Hi", "receiver: TXT starts the live message", await txt(page, "#partialText"));
    check((await txt(page, "#lastPkt")).includes("q 12.3 dB") && (await txt(page, "#lastPkt")).includes("01001000"), "receiver: last packet q and bits", await txt(page, "#lastPkt"));
    await push(page, "DET n=2", "TXT src=1 dst=2 seq=4 first=0 last=0 data=2044 q=9.0", "TXT src=1 dst=2 seq=4 first=0 last=0 data=2044 q=9.1");
    await waitFor(async () => (await txt(page, "#partialText")) === "Hi D");
    check((await txt(page, "#partialText")) === "Hi D", "receiver: repeated packet ignored in the live text", await txt(page, "#partialText"));
    await push(page, "DET n=2", "REPEAT src=1 seq=4 (dropped)");
    await waitFor(async () => (await txt(page, "#arriveText")).includes("Repeated copy"));
    check((await txt(page, "#arriveText")).includes("Repeated copy") && (await txt(page, "#partialText")) === "Hi D", "receiver: REPEAT line adds no bytes", await txt(page, "#partialText"));
    await push(page, "DET n=3", "CRCFAIL n=1", "DET n=4", "TXT src=1 dst=2 seq=6 first=0 last=1 data=5249 q=10.1");
    await waitFor(async () => (await txt(page, "#partialText")).endsWith("RI"));
    check((await page.$$eval("#partialText .lost", (e) => e.length)) === 2 && (await txt(page, "#partialText")) === "Hi D??RI", "receiver: seq gap shows 2 lost bytes", await txt(page, "#partialText"));
    check((await txt(page, "#cBad")) === "1", "receiver: damaged counter", await txt(page, "#cBad"));
    await push(page, "MSG src=1 dst=2 ok=0 lost=1 len=9 q=10.5 hex=48692044____5249 text=Hi D??RI");
    await waitFor(async () => (await page.$$("#msgList .msg")).length === 1);
    const first = await page.$eval("#msgList .msg .mtext", (e) => ({ t: e.textContent, lost: e.querySelectorAll(".lost").length }));
    check(first.t === "Hi D??RI" && first.lost === 2, "receiver: MSG with lost bytes rendered", first);
    check((await page.$eval("#msgList .msg .mhead", (e) => e.textContent)).includes("1 packet lost"), "receiver: '1 packet lost' chip");
    check((await txt(page, "#partialText")).includes("Nothing yet"), "receiver: live area cleared after MSG");
    const bn = "ডুবুরি";
    await push(page, `MSG src=1 dst=2 ok=1 lost=0 len=${Buffer.from(bn).length} q=13.0 hex=${hexOf(bn)} text=${bn}`);
    await waitFor(async () => (await page.$$("#msgList .msg")).length === 2);
    check((await page.$eval("#msgList .msg .mtext", (e) => e.textContent)) === bn, "receiver: Bangla MSG decoded from hex (newest on top)");
    check((await page.$eval("#msgList .msg .mhead", (e) => e.textContent)).includes("complete"), "receiver: complete chip");
    await push(page, "MSG src=1 dst=2 ok=1 lost=0 len=2 q=11.0 hex=E0A6 text=..");
    await waitFor(async () => (await page.$$("#msgList .msg")).length === 3);
    check((await page.$eval("#msgList .msg .mtext", (e) => e.textContent)).includes("�"), "receiver: invalid UTF-8 -> replacement char");
    check((await txt(page, "#cMsgs")) === "3" && (await txt(page, "#cOk")) === "5" && (await txt(page, "#cDet")) === "5", "receiver: counters", [await txt(page, "#cMsgs"), await txt(page, "#cOk"), await txt(page, "#cDet")]);
    check((await txt(page, "#cPct")).replace(/\s/g, "") === "83%", "receiver: success % = 5/(5+1)", await txt(page, "#cPct"));
    // a MSG closing an older unfinished message right before the next FIRST packet; lost tail
    await push(page, "TXT src=1 dst=2 seq=10 first=1 last=0 data=4F4B q=9.5");
    await waitFor(async () => (await txt(page, "#partialText")) === "OK");
    await push(page, "MSG src=1 dst=2 ok=0 lost=1 len=4 q=9.5 hex=4F4B____ text=OK??", "TXT src=1 dst=2 seq=12 first=1 last=0 data=5945 q=11.0");
    await waitFor(async () => (await txt(page, "#partialText")) === "YE");
    check((await txt(page, "#partialText")) === "YE", "receiver: new FIRST after closing MSG starts a fresh live message", await txt(page, "#partialText"));
    const tail = await page.$eval("#msgList .msg .mtext", (e) => ({ t: e.textContent, lost: e.querySelectorAll(".lost").length }));
    check(tail.t === "OK??" && tail.lost === 2, "receiver: MSG with lost tail ____", tail);
    // a Bangla letter split over two packets must not flash a replacement char
    await push(page, "TXT src=3 dst=2 seq=0 first=1 last=0 data=E0A6 q=12.0");
    await waitFor(async () => (await txt(page, "#partialLabel")).includes("node 3"));
    check(!(await txt(page, "#partialText")).includes("\uFFFD") && (await txt(page, "#partialText")) === "", "receiver: unfinished UTF-8 letter held back", await txt(page, "#partialText"));
    await push(page, "TXT src=3 dst=2 seq=1 first=0 last=0 data=A1E0 q=12.0");
    await waitFor(async () => (await txt(page, "#partialText")) === "ড");
    check((await txt(page, "#partialText")) === "ড", "receiver: letter appears when its last byte arrives", await txt(page, "#partialText"));
    await push(page, "ERR usage: mode air|water (now air)");
    await waitFor(async () => await page.isVisible("#boardErr"));
    check((await txt(page, "#boardErr")).includes("usage: mode"), "receiver: board ERR shown in a banner", await txt(page, "#boardErr"));
    const scope = [0, 1, 2, 0, -1, 22, 0, 1, 0, 0, 3, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1, 0];
    await push(page, "SCOPE " + scope.join(" ") + "  rms=150");
    await waitFor(async () => (await page.$$("#scopeBars .bar.hot")).length === 1);
    check((await page.$$eval("#scopeBars .bar", (e) => e.length)) === 24, "receiver: 24 tone bars");
    check((await page.$eval("#scopeBars .bar.hot", (e) => e.title)).startsWith("4250 Hz"), "receiver: hot bar is tone 5 = 4250 Hz");
    check((await txt(page, "#btnScope")).includes("Stop"), "receiver: SCOPE lines switch the button to Stop");
    await page.click("#btnScope");
    check((await written(page)).includes("scope off"), "receiver: scope off sent");
    await page.click("#btnScope");
    check((await written(page)).includes("scope on"), "receiver: scope on sent");
    await push(page, "LEVEL mean=1650 rms=42.0 min=1400 max=1900 (want rms 20..300, min>100, max<3900)");
    await waitFor(async () => (await txt(page, "#levelStatus")) === "OK");
    check((await txt(page, "#levelStatus")) === "OK", "receiver: level OK", await txt(page, "#levelStatus"));
    await push(page, "LEVEL mean=2000 rms=900.0 min=50 max=4095 (want rms 20..300, min>100, max<3900)");
    await waitFor(async () => (await txt(page, "#levelStatus")) === "clipping");
    check((await txt(page, "#levelStatus")) === "clipping", "receiver: level clipping");
    await push(page, "LEVEL mean=1650 rms=5.0 min=1630 max=1670 (want rms 20..300, min>100, max<3900)");
    await waitFor(async () => (await txt(page, "#levelStatus")) === "too quiet");
    check((await txt(page, "#levelStatus")) === "too quiet", "receiver: level too quiet");
    await push(page, "STATS node=2 preambles=12 ok=10 crc_fail=2 last_q=12.3dB timing_adj=0.4");
    await waitFor(async () => (await txt(page, "#boardTotals")).includes("12 heard"));
    check((await txt(page, "#boardTotals")).includes("12 heard"), "receiver: STATS totals");
    await push(page, "RX src=1 dst=2 seq=3 cmd=1 arg=0 flags=8 q=18.5dB");
    await waitFor(async () => (await txt(page, "#arriveText")).includes("command packet"));
    check((await txt(page, "#arriveText")).includes("cmd 1"), "receiver: command packet noted");
    if (SHOTS) { await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, "receiver_light.png"), fullPage: true }); }
    await page.click("#modeWater");
    await waitFor(async () => (await written(page)).includes("mode water"));
    check((await written(page)).includes("mode water"), "receiver: WATER button sends 'mode water'");
    await push(page, "INFO node=2 peer=1 fw=2.0 mode=water text_max=64 slot_ms=20 pkt_ms=1280 duty=0.50 burst_s=6.0", "DET n=9");
    await waitFor(async () => (await page.$eval("#arriveBar", (e) => e.style.transition)).includes("1080ms"));
    check((await page.$eval("#arriveBar", (e) => e.style.transition)).includes("1080ms"), "receiver: WATER arrival bar 1.08 s");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#btnCsv")]);
    const csv = fs.readFileSync(await dl.path(), "utf8");
    check(csv.charCodeAt(0) === 0xfeff && csv.includes("time,from,to,complete") && csv.includes(bn) && csv.includes("48692044____5249"), "receiver: CSV download", csv.slice(0, 200));
    check(errors.length === 0, "receiver: no console errors", errors);
    await ctx.close();
  }

  /* ---- 3. demo mode, both pages ---- */
  {
    const { page, ctx, errors } = await newPage(browser, { mock: false });
    await page.goto(SENDER);
    await page.evaluate(() => { window.__demoSpeed = 25; });
    await page.click("label.switch");
    await waitFor(async () => (await txt(page, "#connPill")).includes("node 1"));
    check((await txt(page, "#connPill")).includes("Demo board · node 1"), "demo sender: pill", await txt(page, "#connPill"));
    check((await txt(page, "#modeDesc")).includes("AIR"), "demo sender: starts in AIR", await txt(page, "#modeDesc"));
    await page.click("#modeWater");
    check(await waitFor(async () => (await txt(page, "#modeDesc")).includes("WATER")), "demo sender: switch to WATER", await txt(page, "#modeDesc"));
    await page.click("#modeAir");
    check(await waitFor(async () => (await txt(page, "#modeDesc")).includes("AIR")), "demo sender: back to AIR");
    check(await page.isVisible("#demoBanner"), "demo sender: banner visible");
    await page.fill("#msg", "Hello DUBURI test");
    await page.click("#btnSend");
    const ok = await waitFor(async () => (await txt(page, "#sendStatus")).includes("Done"), 15000);
    check(ok, "demo sender: message sent end to end", await txt(page, "#sendStatus"));
    check((await txt(page, "#txTitle")).startsWith("Sent 9 packets"), "demo sender: 9 packets", await txt(page, "#txTitle"));
    const log = await txt(page, "#logBox");
    check(log.includes("HEAT-GUARD"), "demo sender: heat guard kicked in for a long message");
    await page.click("label.switch");
    await waitFor(async () => (await txt(page, "#connPill")) === "Not connected");
    check((await txt(page, "#connPill")) === "Not connected", "demo sender: switch off");
    check(errors.length === 0, "demo sender: no console errors", errors);
    await ctx.close();
  }
  {
    const { page, ctx, errors } = await newPage(browser, { mock: false });
    await page.goto(RECEIVER);
    await page.evaluate(() => { window.__demoSpeed = 25; });
    await page.click("label.switch");
    const ok = await waitFor(async () => (await page.$$("#msgList .msg")).length >= 2, 20000);
    check(ok, "demo receiver: messages arrive");
    check(Number(await txt(page, "#cOk")) > 0 && Number(await txt(page, "#cDet")) > 0, "demo receiver: counters move");
    await page.click("#btnScope");
    check(await waitFor(async () => (await page.$$("#scopeBars .bar")).length === 24 && (await txt(page, "#btnScope")).includes("Stop"), 3000), "demo receiver: scope bars");
    check(await waitFor(async () => (await txt(page, "#levelStatus")) !== "no data yet", 8000), "demo receiver: level meter fills");
    check(errors.length === 0, "demo receiver: no console errors", errors);
    await ctx.close();
  }

  /* ---- 4. screenshots (dark + narrow) ---- */
  if (SHOTS) {
    for (const dark of [true]) {
      const { page, ctx } = await newPage(browser, { dark });
      await page.goto(SENDER);
      await connect(page);
      await push(page, "INFO node=1 peer=2 fw=2.0 mode=air text_max=64 slot_ms=40 pkt_ms=2560 duty=0.75 burst_s=10.0");
      await page.fill("#msg", "Hello ডুবুরি");
      await page.click("#btnSend");
      await push(page, "TXMSG dst=2 len=15 n=8 rep=1");
      const tones = await page.evaluate(() => amTones(amFrame(2, 1, 4, 0x2, 0x6C, 0x6F)));
      await push(page, "TXPKT i=3 n=8 try=1 seq=4 flags=2 data=6C6F tones=" + tones.join(","));
      await page.waitForTimeout(1300);
      await page.screenshot({ path: path.join(SHOTS, "sender_dark.png"), fullPage: true });
      await ctx.close();
      const r = await newPage(browser, { dark });
      await r.page.goto(RECEIVER);
      await r.page.evaluate(() => { window.__demoSpeed = 25; });
      await r.page.click("label.switch");
      await waitFor(async () => (await r.page.$$("#msgList .msg")).length >= 3, 30000);
      await r.page.click("#btnScope");
      await r.page.waitForTimeout(800);
      await r.page.screenshot({ path: path.join(SHOTS, "receiver_dark.png"), fullPage: true });
      await r.ctx.close();
    }
    const n = await browser.newContext({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 1 });
    const np = await n.newPage();
    await np.addInitScript(MOCK);
    await np.goto(SENDER);
    await np.fill("#msg", "Hi DUBURI");
    await np.screenshot({ path: path.join(SHOTS, "sender_900px.png"), fullPage: true });
    await np.goto(RECEIVER);
    await np.screenshot({ path: path.join(SHOTS, "receiver_900px.png"), fullPage: true });
    await n.close();
  }

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
