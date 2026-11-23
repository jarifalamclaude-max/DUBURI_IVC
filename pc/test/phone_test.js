/*
 * phone_test.js - phone_receiver.html in Chromium with a phone screen (Pixel 5):
 *   1. served over http://localhost (a secure context, like an https link):
 *      the fake microphone plays a message made with amcore.js; it must appear.
 *   2. "This phone is node" = 5: the same message (for node 2) is ignored.
 *   3. served from a LAN address over plain http (not secure, like a file on a
 *      phone): the page must say the microphone needs an https link.
 *   node pc/test/phone_test.js
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { chromium, devices } = require("playwright");
const AM = require("../amcore.js");

let pass = 0, fail = 0;
const check = (c, n, x) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n + (x ? "  " + x : "")); } };

function makeWav(file, text, mode, fsr, dst) {
  const bytes = Array.from(Buffer.from(text, "utf8")), n = Math.ceil(bytes.length / 2), slot = AM.MODES[mode].slot;
  const parts = [new Float32Array(Math.round(1.5 * fsr))];
  for (let i = 0; i < n; i++) {
    parts.push(AM.renderPacket(AM.txBuild(AM.textPacket(bytes, i, dst, 1, 3)), fsr, slot, 0.25));
    parts.push(new Float32Array(Math.round(0.4 * fsr)));
  }
  parts.push(new Float32Array(Math.round(3 * fsr)));
  const len = parts.reduce((a, p) => a + p.length, 0), sig = new Float32Array(len);
  let off = 0;
  for (const p of parts) { sig.set(p, off); off += p.length; }
  let seed = 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pcm = Buffer.alloc(44 + 2 * len);
  const echoes = [[0.007, 0.5], [0.019, 0.3], [0.037, 0.2], [0.06, 0.12]];
  for (let i = 0; i < len; i++) {
    let s = sig[i];
    for (const [dt, g] of echoes) { const d = Math.round(dt * fsr); if (i >= d) s += g * sig[i - d]; }
    s += 0.02 * (rnd() - 0.5) * 2;                                             /* phone mic hiss */
    pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(s * 32767))), 44 + 2 * i);
  }
  pcm.write("RIFF", 0); pcm.writeUInt32LE(36 + 2 * len, 4); pcm.write("WAVE", 8); pcm.write("fmt ", 12);
  pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22); pcm.writeUInt32LE(fsr, 24);
  pcm.writeUInt32LE(2 * fsr, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write("data", 36); pcm.writeUInt32LE(2 * len, 40);
  fs.writeFileSync(file, pcm);
  return len / fsr;
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === "IPv4" && !a.internal) return a.address;
  return null;
}

(async () => {
  const page = fs.readFileSync(path.join(__dirname, "..", "phone_receiver.html"));
  const server = http.createServer((q, r) => { r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); r.end(page); });
  await new Promise((ok) => server.listen(0, "0.0.0.0", ok));
  const port = server.address().port;
  const wav = path.join(os.tmpdir(), "duburi_phone_mic.wav");
  const text = "Hello from DUBURI 👋 আমি";
  const secs = makeWav(wav, text, "air", 48000, 2);
  console.log(`made ${secs.toFixed(1)} s test recording: "${text}" (AIR, to node 2)`);
  const browser = await chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}%noloop`],
  });
  const phone = { ...devices["Pixel 5"], permissions: ["microphone"] };

  /* ---- 1. secure context: the message must appear ---- */
  const ctx = await browser.newContext(phone);
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  p.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await p.goto(`http://localhost:${port}/`);
  check(await p.evaluate(() => window.isSecureContext && !document.querySelector("#alert .alert")), "localhost page is a secure context, no warning");
  check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no sideways scroll at phone width");
  await p.tap("#go");
  await p.waitForFunction(() => document.getElementById("state").textContent.startsWith("Listening") || document.getElementById("state").textContent.startsWith("Receiving"), null, { timeout: 10000 });
  check(true, "microphone opened after the tap");
  const t0 = Date.now();
  await p.waitForFunction((t) => document.getElementById("msgs").innerText.includes(t), text, { timeout: (secs + 15) * 1000 }).catch(() => {});
  const msgs = await p.innerText("#msgs");
  check(msgs.includes(text), `decoded "${text}" in ${((Date.now() - t0) / 1000).toFixed(1)} s`, msgs.slice(0, 200));
  check(/complete/.test(msgs) && /from node 1/.test(msgs), "message marked complete, from node 1");
  check((await p.textContent("#lvlTxt")).length > 1, "level meter shows a reading: " + (await p.textContent("#lvlTxt")));
  await p.screenshot({ path: path.join(os.tmpdir(), "duburi_phone_receiver.png") });
  await p.tap("#go");
  check((await p.textContent("#state")) === "Not listening", "Stop listening stops the microphone");
  check(errors.length === 0, "no console errors", errors.join(" | "));
  await ctx.close();

  /* ---- 2. a different node id ignores the message ---- */
  const ctx2 = await browser.newContext(phone);
  const p2 = await ctx2.newPage();
  await p2.goto(`http://localhost:${port}/`);
  await p2.selectOption("#node", "5");
  await p2.tap("#go");
  await p2.waitForFunction(() => /ignored/.test(document.getElementById("log").textContent), null, { timeout: (secs + 15) * 1000 }).catch(() => {});
  check(/packet for node 2 \(this phone is 5\): ignored/.test(await p2.textContent("#log")) && !(await p2.innerText("#msgs")).includes("Hello"),
    "node 5 ignores a message for node 2");
  await ctx2.close();

  /* ---- 3. not secure (plain http on a LAN address, like a file on a phone) ---- */
  const lan = lanAddress();
  if (lan) {
    const ctx3 = await browser.newContext(phone);
    const p3 = await ctx3.newPage();
    await p3.goto(`http://${lan}:${port}/`);
    const warn = await p3.evaluate(() => [window.isSecureContext, document.getElementById("alert").innerText]);
    check(!warn[0] && /https/.test(warn[1]), "insecure page warns that the microphone needs an https link");
    await p3.tap("#go");
    check(/not opened from an https/.test(await p3.innerText("#alert")), "Start listening explains instead of failing silently");
    await ctx3.close();
  } else console.log("SKIP insecure-context test (no LAN address)");

  await browser.close(); server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
