/*
 * amcore_test.js - checks pc/amcore.js (JavaScript modem) against the C code.
 *   make -C tests && python3 pc/test/make_vectors.py && node pc/test/amcore_test.js
 *
 * 1. tones, CRC, Viterbi                       (same numbers as C)
 * 2. the SAME simulated room/pool recordings decoded by C and by JS
 * 3. laptop loopback in software: renderPacket() audio -> Rx -> text
 * 4. text layer behaves like am_text.c (repeat, loss, MSG line format)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const AM = require("../amcore.js");

let pass = 0, fail = 0;
function check(cond, name, extra) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name + (extra ? "  " + extra : "")); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pkt = (p) => [p.dst, p.src, p.seq, p.flags, p.cmd, p.arg];

/* ---- 1. basics -------------------------------------------------------- */
check(AM.crc16(Buffer.from("123456789")) === 0x29B1, "CRC-16/CCITT-FALSE check value 0x29B1");
{
  let ok = true;
  for (let trial = 0; trial < 50; trial++) {
    const bits = Array.from({ length: 54 }, (_, i) => (i < 48 ? (Math.random() < 0.5 ? 1 : 0) : 0));
    const coded = AM.convEncode(bits);
    const llr = Array.from(coded, (c) => (c ? -1 : 1) * (0.5 + Math.random()));
    for (let e = 0; e < 4; e++) { const k = Math.floor(Math.random() * 108); llr[k] = -llr[k]; }  /* 4 bit errors */
    if (!same(Array.from(AM.viterbi(llr, 54)), bits)) ok = false;
  }
  check(ok, "Viterbi corrects 4 scattered bit errors (50 random frames)");
}

/* ---- 2. same recordings as C ----------------------------------------- */
const VDIR = path.join(__dirname, "vectors");
if (!fs.existsSync(path.join(VDIR, "index.json"))) {
  console.log("FAIL no recordings: run  make -C tests && python3 pc/test/make_vectors.py");
  process.exit(1);
}
const index = JSON.parse(fs.readFileSync(path.join(VDIR, "index.json"), "utf8"));
let toneOk = true;
for (const v of index) v.sent.forEach((p, i) => {
  const t = AM.txBuild({ dst: p[0], src: p[1], seq: p[2], flags: p[3], cmd: p[4], arg: p[5] });
  if (!same(t, v.tones[i])) toneOk = false;
});
check(toneOk, "txBuild() gives the same 64 tones as C am_tx_build() for " + index.reduce((n, v) => n + v.sent.length, 0) + " packets");

let totC = 0, totJ = 0, totSent = 0;
for (const v of index) {
  const buf = fs.readFileSync(path.join(VDIR, v.name + ".u16"));
  const x = new Uint16Array(buf.buffer, buf.byteOffset, buf.length / 2);
  const rx = new AM.Rx(v.fs, v.mode);
  const got = [];
  for (let i = 0; i < x.length; i += 512) {
    rx.process(x.subarray(i, Math.min(x.length, i + 512)));
    let r;
    while ((r = rx.pop())) got.push(r);
  }
  const c = v.c_decoded.map((d) => d.pkt), j = got.map((r) => pkt(r.pkt));
  totC += c.length; totJ += j.length; totSent += v.sent.length;
  const wrong = j.filter((p) => !v.sent.some((s) => same(s, p))).length;
  let qdiff = 0;
  got.forEach((r) => { const m = v.c_decoded.find((d) => same(d.pkt, pkt(r.pkt))); if (m) qdiff = Math.max(qdiff, Math.abs(m.q - r.q_db)); });
  const label = `${v.name} (${v.room}, ${v.snr} dB): C ${c.length}/${v.sent.length}, JS ${j.length}/${v.sent.length}`;
  check(same(c, j) && wrong === 0 && qdiff < 0.5, label, `q diff ${qdiff.toFixed(2)} dB, JS preambles ${rx.stats.preambles} vs C ${v.c_stats.preambles}`);
}
console.log(`     total: C decoded ${totC}/${totSent}, JS decoded ${totJ}/${totSent}`);

/* ---- 3. laptop loopback in software ---------------------------------- */
function loopback(text, mode, fs, opt) {
  const o = Object.assign({ amp: 0.5, gain: 1500, noise: 20, echo: 0 }, opt || {});
  const bytes = Array.from(Buffer.from(text, "utf8"));
  const n = Math.ceil(bytes.length / 2), slot = AM.MODES[mode].slot;
  const parts = [new Float32Array(Math.round(0.6 * fs))];
  for (let i = 0; i < n; i++) {
    parts.push(AM.renderPacket(AM.txBuild(AM.textPacket(bytes, i, 2, 1, 3)), fs, slot, o.amp));
    parts.push(new Float32Array(Math.round(0.4 * fs)));
  }
  parts.push(new Float32Array(Math.round(0.8 * fs)));
  const len = parts.reduce((s, p) => s + p.length, 0), sig = new Float32Array(len);
  let off = 0;
  for (const p of parts) { sig.set(p, off); off += p.length; }
  /* microphone: gain, a room echo, hiss, then "ADC" units like the board */
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const d = Math.round(0.011 * fs), x = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const s = sig[i] + (i >= d ? o.echo * sig[i - d] : 0);
    x[i] = 2048 + o.gain * s + o.noise * gauss();
  }
  const rx = new AM.Rx(fs, opt && opt.rxMode ? opt.rxMode : mode), trx = new AM.TextRx(), msgs = [];
  let got = 0;
  for (let i = 0; i < len; i += 1024) {
    rx.process(x.subarray(i, Math.min(len, i + 1024)));
    let r;
    while ((r = rx.pop())) {
      got++;
      const out = trx.feed(r.pkt, r.q_db, Math.round((r.at / fs) * 1000));
      if (out !== -1) msgs.push(...out);
    }
  }
  return { got, n, msgs, text: msgs.length ? Buffer.from(msgs[0].data).toString("utf8") : null, rx };
}
for (const [mode, fsr] of [["air", 48000], ["air", 44100], ["water", 48000], ["water", 44100]]) {
  const r = loopback("Hi DUBURI!", mode, fsr);
  check(r.got === r.n && r.msgs.length === 1 && r.msgs[0].ok === 1 && r.text === "Hi DUBURI!",
    `loopback ${mode.toUpperCase()} at ${fsr} Hz: "Hi DUBURI!" ${r.got}/${r.n} packets`);
}
{
  const r = loopback("আমি ডুবুরি", "air", 48000, { echo: 0.6, noise: 400 });
  check(r.text === "আমি ডুবুরি" && r.msgs[0].ok === 1, `loopback AIR, Bangla, with room echo + hiss: ${r.got}/${r.n} packets, q ${r.msgs[0] ? r.msgs[0].q_db.toFixed(1) : "-"} dB`);
}
{
  const r = loopback("Hi", "air", 48000, { rxMode: "water" });
  check(r.got === 0, "AIR sender, WATER receiver: nothing decoded (modes must match)");
}
{
  const r = loopback("Hi", "air", 48000, { amp: 0.0, noise: 30 });
  check(r.got === 0 && r.rx.stats.packets_ok === 0, "silence + hiss: no packets");
}

/* ---- 4. text layer like am_text.c ------------------------------------ */
{
  const bytes = Array.from(Buffer.from("Hello world"));
  const pk = [0, 1, 2, 3, 4, 5].map((i) => AM.textPacket(bytes, i, 2, 1, 5));
  const t = new AM.TextRx();
  let out = [];
  pk.forEach((p, i) => { if (i !== 2) { const o = t.feed(p, 9.0, 1500 * (i + 1)); if (o !== -1) out = out.concat(o); } });
  check(out.length === 1 && AM.formatMsg(out[0]) === "MSG src=1 dst=2 ok=0 lost=1 len=11 q=9.0 hex=48656C6C____776F726C64 text=Hell??world",
    "lost middle packet -> same MSG line as the C test", out[0] && AM.formatMsg(out[0]));
  const t2 = new AM.TextRx();
  let reps = 0, done = null;
  pk.forEach((p, i) => { for (let k = 0; k < 2; k++) { const o = t2.feed(p, 10, 3000 * i + 1000 * k); if (o === -1) reps++; else if (o.length) done = o[0]; } });
  check(reps === 6 && done && done.ok === 1 && Buffer.from(done.data).toString() === "Hello world", "repeats dropped, message complete");
  const t3 = new AM.TextRx();
  pk.slice(0, 5).forEach((p, i) => t3.feed(p, 9, 1000 * i));
  const m = t3.poll(4000 + 8100);
  check(m && m.ok === 0 && m.data.length === 12 && m.lostmask[10] === 1, "lost LAST -> timeout gives message with lost tail");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
