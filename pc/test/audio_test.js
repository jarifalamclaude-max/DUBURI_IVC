/*
 * audio_test.js - "no board" mode, end to end in a real Chromium:
 *   1. receiver.html + "Use this computer's microphone": Chromium's fake
 *      microphone plays a WAV of a message (made with amcore.js, with room
 *      echo and hiss); the page must show the message.
 *   2. sender.html + "Use this computer's speaker": send a message; the audio
 *      the page scheduled on the speaker must decode back to the same packets.
 *   node pc/test/audio_test.js
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");
const AM = require("../amcore.js");

let pass = 0, fail = 0;
const check = (c, n, x) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n + (x ? "  " + x : "")); } };

function makeWav(file, text, mode, fsr) {
  const bytes = Array.from(Buffer.from(text, "utf8")), n = Math.ceil(bytes.length / 2), slot = AM.MODES[mode].slot;
  const parts = [new Float32Array(Math.round(1.5 * fsr))];
  for (let i = 0; i < n; i++) {
    parts.push(AM.renderPacket(AM.txBuild(AM.textPacket(bytes, i, 2, 1, 7)), fsr, slot, 0.3));
    parts.push(new Float32Array(Math.round(0.4 * fsr)));
  }
  parts.push(new Float32Array(Math.round(3 * fsr)));
  const len = parts.reduce((a, p) => a + p.length, 0), sig = new Float32Array(len);
  let off = 0;
  for (const p of parts) { sig.set(p, off); off += p.length; }
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pcm = Buffer.alloc(44 + 2 * len);
  const echoes = [[0.009, 0.5], [0.023, 0.35], [0.041, 0.25], [0.07, 0.15]];   /* small room */
  for (let i = 0; i < len; i++) {
    let s = sig[i];
    for (const [dt, g] of echoes) { const d = Math.round(dt * fsr); if (i >= d) s += g * sig[i - d]; }
    s += 0.01 * (rnd() - 0.5) * 2;                                             /* mic hiss */
    pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(s * 32767))), 44 + 2 * i);
  }
  pcm.write("RIFF", 0); pcm.writeUInt32LE(36 + 2 * len, 4); pcm.write("WAVE", 8); pcm.write("fmt ", 12);
  pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22); pcm.writeUInt32LE(fsr, 24);
  pcm.writeUInt32LE(2 * fsr, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write("data", 36); pcm.writeUInt32LE(2 * len, 40);
  fs.writeFileSync(file, pcm);
  return len / fsr;
}

(async () => {
  const pc = path.join(__dirname, "..");
  const wav = path.join(os.tmpdir(), "duburi_mic_test.wav");
  const text = "Hi DUBURI! আমি";
  const secs = makeWav(wav, text, "air", 48000);
  console.log(`made ${secs.toFixed(1)} s test recording: "${text}" in AIR mode`);

  /* ---- 1. receiver page listens to the fake microphone ---- */
  const browser = await chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${wav}%noloop`, "--autoplay-policy=no-user-gesture-required"],
  });
  const ctx = await browser.newContext({ permissions: ["microphone"] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto("file://" + path.join(pc, "receiver.html"));
  await page.click("#btnAudio");
  await page.waitForFunction(() => conn.state === "audio", null, { timeout: 10000 });
  check(true, "receiver: microphone opened, state = audio");
  check(await page.isVisible("#audioBanner"), "receiver: 'no board' banner shown");
  check((await page.textContent("#connPill")).includes("Computer audio"), "receiver: pill says Computer audio");
  const t0 = Date.now();
  await page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout: (secs + 15) * 1000 }).catch(() => {});
  const body = await page.innerText("body");
  check(body.includes(text), `receiver: decoded "${text}" from the microphone in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const st = await page.evaluate(() => { const b = conn.link.board; return { fs: b.fs, pre: b.rx.stats.preambles, ok: b.rx.stats.packets_ok, crc: b.rx.stats.crc_fail }; });
  check(st.ok === Math.ceil(Buffer.byteLength(text) / 2) && st.crc === 0, `receiver: ${st.ok} packets OK, ${st.crc} damaged, ${st.pre} preambles (AudioContext ${st.fs} Hz)`);
  await page.click("#btnScope");
  await page.waitForTimeout(800);
  const bars = await page.evaluate(() => document.querySelectorAll("#scopeBars *").length);
  check(bars >= 24, "receiver: live tone bars run from the microphone");
  await page.click("#btnDisconnect");
  check(await page.evaluate(() => conn.state === "off"), "receiver: disconnect stops the microphone");
  check(errors.length === 0, "receiver: no console errors", errors.join(" | "));
  await page.screenshot({ path: path.join(os.tmpdir(), "duburi_receiver_audio.png") });

  /* ---- 2. sender page plays on the speaker ---- */
  const sp = await ctx.newPage();
  const errs2 = [];
  sp.on("pageerror", (e) => errs2.push(String(e)));
  sp.on("console", (m) => { if (m.type() === "error") errs2.push(m.text()); });
  await sp.goto("file://" + path.join(pc, "sender.html"));
  await sp.click("#btnAudio");
  await sp.waitForFunction(() => conn.state === "audio" && conn.mode === "air", null, { timeout: 10000 });
  check(true, "sender: speaker ready, INFO says mode air");
  await sp.fill("#msg", "Hello");
  await sp.click("#btnSend");
  await sp.waitForFunction(() => /TXDONE/.test(document.getElementById("logBox").textContent), null, { timeout: 30000 }).catch(() => {});
  const log = await sp.textContent("#logBox");
  check(/TXMSG dst=2 len=5 n=3 rep=1/.test(log) && (log.match(/TXPKT/g) || []).length === 3 && /TXDONE n=3/.test(log),
    "sender: TXMSG, 3 × TXPKT, TXDONE in the log");
  const dec = await sp.evaluate(() => {
    const b = conn.link.board, rx = new AMCore.Rx(b.fs, "air"), got = [];
    const pad = new Float32Array(Math.round(0.5 * b.fs));
    for (const a of [pad, ...b.sent.flatMap((x) => [x, pad])]) {
      rx.process(Array.from(a, (v) => 2048 + 1500 * v));
      let r; while ((r = rx.pop())) got.push(r.pkt);
    }
    return got.map((p) => [p.dst, p.src, p.flags, p.cmd, p.arg]);
  });
  check(JSON.stringify(dec) === JSON.stringify([[2, 1, 10, 72, 101], [2, 1, 2, 108, 108], [2, 1, 3, 111, 0]]),
    "sender: the audio it played decodes to the 3 packets of \"Hello\"", JSON.stringify(dec));
  await sp.click('.segbtn[data-mode="water"]');
  await sp.waitForFunction(() => conn.mode === "water", null, { timeout: 5000 }).catch(() => {});
  check(await sp.evaluate(() => conn.mode === "water" && conn.info.slot_ms === "20"), "sender: mode switch to WATER works");
  check(errs2.length === 0, "sender: no console errors", errs2.join(" | "));
  await sp.screenshot({ path: path.join(os.tmpdir(), "duburi_sender_audio.png") });
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
