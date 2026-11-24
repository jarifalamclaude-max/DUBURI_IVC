/*
 * build_explainer.js - PDF: how the letter "L" becomes 64 tones (Bangla + English).
 * Every number comes from pc/amcore.js (the same modem as the firmware).
 *   node docs/explainer/build_explainer.js
 *     -> docs/L_theke_tone_BN.pdf   (Bangla, Noto Sans Bengali)
 *     -> docs/L_to_tones_EN.pdf     (English)
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");
const AM = require("../../pc/amcore.js");

const ROOT = path.join(__dirname, "..", "..");
const FONTS = "file://" + path.join(ROOT, "docs", "fonts");
const OUTS = { bn: path.join(ROOT, "docs", "L_theke_tone_BN.pdf"), en: path.join(ROOT, "docs", "L_to_tones_EN.pdf") };

/* ---------------- real numbers ---------------- */
const LETTER = "L";
const byte = LETTER.charCodeAt(0);                         /* 76 */
const pkt = { dst: 2, src: 1, seq: 0, flags: AM.F_TEXT | AM.F_FIRST | AM.F_LAST, cmd: byte, arg: 0 };
const frame = AM.pack(pkt);                                /* 6 bytes */
const crc = (frame[4] << 8) | frame[5];
const crcM = AM.crc16([frame[0], frame[1], byte + 1, 0]);  /* if L had become M */
const info = [];
for (const b of frame) for (let i = 7; i >= 0; i--) info.push((b >> i) & 1);
for (let i = 0; i < 6; i++) info.push(0);
const coded = Array.from(AM.convEncode(info));
const stream = new Array(108).fill(0);
coded.forEach((v, c) => { stream[AM.interleave(c)] = v; });
const tones = AM.txBuild(pkt);
const hz = (k) => AM.toneHz(k);
const hex2 = (b) => b.toString(16).toUpperCase().padStart(2, "0");
const bin8 = (b) => b.toString(2).padStart(8, "0");

/* convolutional code, first 8 steps */
const convSteps = [];
{
  let st = 0;
  for (let t = 0; t < 8; t++) {
    const reg = (info[t] << 6) | st;
    const r = reg.toString(2).padStart(7, "0");
    const a = [...r].map((c, i) => ("1111001"[i] === "1" ? c : "·")).join("");
    const b = [...r].map((c, i) => ("1011011"[i] === "1" ? c : "·")).join("");
    const o0 = [...a].filter((c) => c === "1").length % 2, o1 = [...b].filter((c) => c === "1").length % 2;
    convSteps.push({ t, bit: info[t], r, a, b, o0, o1 });
    st = reg >> 1;
  }
}
const slots = [];
for (let k = 0; k < 54; k++) {
  const b1 = stream[2 * k], b0 = stream[2 * k + 1], v = (b1 << 1) | b0;
  slots.push({ k, bits: "" + b1 + b0, v, set: k % 6, tone: tones[10 + k] });
}

/* ---------------- helpers ---------------- */
const GROUP_COL = ["#2a6fdb", "#e07b39", "#1d9a6c", "#b4479a", "#c9a227", "#5b6ad0"];
const chips = (bits, cls) => [...bits].map((c) => `<span class="bit ${cls || ""} b${c}">${c}</span>`).join("");

function buildHtml(lang) {
  const L = (bn, en) => (lang === "bn" ? bn : en);

  function pianoRoll() {
    const cw = 10.4, rh = 8.6, x0 = 46, y0 = 14, W = x0 + 64 * cw + 8, H = y0 + 24 * rh + 30;
    let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg">`;
    s += `<rect x="${x0}" y="${y0}" width="${10 * cw}" height="${24 * rh}" fill="#fff1e3"/>`;
    s += `<rect x="${x0 + 10 * cw}" y="${y0}" width="${6 * cw}" height="${24 * rh}" fill="#eef4ff"/>`;
    for (let r = 0; r <= 24; r++) s += `<line x1="${x0}" x2="${x0 + 64 * cw}" y1="${y0 + r * rh}" y2="${y0 + r * rh}" stroke="#e3e6ea" stroke-width="0.6"/>`;
    for (let c = 0; c <= 64; c += 1) s += `<line y1="${y0}" y2="${y0 + 24 * rh}" x1="${x0 + c * cw}" x2="${x0 + c * cw}" stroke="${c % 6 === 4 ? "#d5d9de" : "#eef0f2"}" stroke-width="0.6"/>`;
    for (const k of [0, 4, 8, 12, 16, 20, 23]) {
      const y = y0 + (23 - k) * rh + rh * 0.7;
      s += `<text x="${x0 - 4}" y="${y}" font-size="7.5" text-anchor="end" fill="#555">${(hz(k) / 1000).toFixed(2).replace(/0$/, "")}k</text>`;
    }
    tones.forEach((t, i) => {
      const col = i < 10 ? "#d96a1d" : GROUP_COL[(i - 10) % 6];
      s += `<rect x="${x0 + i * cw + 1}" y="${y0 + (23 - t) * rh + 1}" width="${cw - 2}" height="${rh - 2}" rx="1.5" fill="${col}"/>`;
    });
    s += `<text x="${x0 + 5 * cw}" y="${H - 14}" font-size="9" text-anchor="middle" fill="#b85614">${L("শুরুর সংকেত (10)", "start signal (10)")}</text>`;
    s += `<text x="${x0 + 13 * cw}" y="${H - 14}" font-size="9" text-anchor="middle" fill="#2a6fdb">${L("ধাপ 6-এর টেবিল", "step 6 table")}</text>`;
    s += `<text x="${x0 + 40 * cw}" y="${H - 14}" font-size="9" text-anchor="middle" fill="#444">${L("data: 54টা tone (প্রতিটা 2 bit)", "data: 54 tones (2 bits each)")}</text>`;
    s += `<text x="${x0 + 32 * cw}" y="${H - 2}" font-size="8" text-anchor="middle" fill="#777">${L("সময় →  (প্রতিটা ঘর = এক slot: AIR-এ 40 ms, WATER-এ 20 ms)", "time →  (each column = one slot: 40 ms in AIR, 20 ms in WATER)")}</text>`;
    s += `<text x="10" y="${y0 + 12 * rh}" font-size="8" fill="#777" transform="rotate(-90 10 ${y0 + 12 * rh})" text-anchor="middle">pitch (Hz)</text>`;
    return s + "</svg>";
  }

  const groupTable = Array.from({ length: 6 }, (_, g) =>
    `<tr><td><span class="dot" style="background:${GROUP_COL[g]}"></span> group ${g}</td>` +
    [0, 1, 2, 3].map((v) => `<td>${g + 6 * v} → <b>${hz(g + 6 * v)}</b></td>`).join("") + "</tr>").join("");
  const slotRows = slots.slice(0, 6).map((s) =>
    `<tr><td>${s.k}</td><td>${chips(s.bits)}</td><td>${s.v}</td><td><span class="dot" style="background:${GROUP_COL[s.set]}"></span> ${s.set}</td>` +
    `<td>${s.set} + 6 × ${s.v} = <b>${s.tone}</b></td><td class="big">${hz(s.tone)} Hz</td></tr>`).join("");
  const allSlots = slots.map((s) =>
    `<div class="cell"><div class="n">${s.k}</div>${chips(s.bits, "sm")}<div class="f" style="color:${GROUP_COL[s.set]}">${(hz(s.tone) / 1000).toFixed(2)}k</div></div>`).join("");
  const convRows = convSteps.map((s) =>
    `<tr><td>${s.t + 1}</td><td>${chips(String(s.bit))}</td><td class="mono">${s.r.slice(0, 1)}<span class="old">${s.r.slice(1)}</span></td>` +
    `<td class="mono">${s.a}</td><td>${s.o0}</td><td class="mono">${s.b}</td><td>${s.o1}</td><td>${chips("" + s.o0 + s.o1, "out")}</td></tr>`).join("");
  const frameRows = [
    ["1", L("কাকে / কে পাঠাচ্ছে", "to whom / from whom"), L("node 2-কে, node 1 থেকে", "to node 2, from node 1"), "0010 | 0001"],
    ["2", L("packet নম্বর / ধরন", "packet number / type"), L("নম্বর 0 | text + প্রথম + শেষ", "number 0 | text + first + last"), "0000 | 1011"],
    ["3", L("তোমার অক্ষর", "your letter"), "L", bin8(frame[2])],
    ["4", L("দ্বিতীয় অক্ষরের জায়গা", "room for a 2nd letter"), L("খালি (একটাই অক্ষর)", "empty (only one letter)"), bin8(frame[3])],
    ["5", L("আঙুলের ছাপ (CRC)", "fingerprint (CRC)"), L("হিসাব করে বের করা", "calculated"), bin8(frame[4])],
    ["6", L("আঙুলের ছাপ (CRC)", "fingerprint (CRC)"), "", bin8(frame[5])],
  ].map((r, i) => `<tr class="f${i}"><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td class="mono">${hex2(frame[i])}</td><td class="mono">${r[3]}</td></tr>`).join("");
  const interRows = [0, 1, 2, 3, 4, 54].map((c) => {
    const p = AM.interleave(c);
    return `<tr><td>${c}</td><td>(37 × ${c}) mod 54 = <b>${p >> 1}</b></td><td>${p & 1 ? L("দ্বিতীয়", "second") : L("প্রথম", "first")}</td></tr>`;
  }).join("");
  const STEP = L("ধাপ", "Step");

  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${L("L থেকে tone", "From L to tones")}</title><style>
@font-face { font-family: "Noto Sans Bengali"; src: url("${FONTS}/NotoSansBengali.woff2") format("woff2"); font-weight: 100 900; }
@font-face { font-family: "Noto Sans"; src: url("${FONTS}/NotoSans.woff2") format("woff2"); font-weight: 100 900; }
@font-face { font-family: "Noto Sans Mono"; src: url("${FONTS}/NotoSansMono.woff2") format("woff2"); font-weight: 100 900; }
@page { size: A4; margin: 14mm 14mm 16mm; }
* { box-sizing: border-box; }
body { font-family: ${L('"Noto Sans Bengali", "Noto Sans"', '"Noto Sans", "Noto Sans Bengali"')}, sans-serif; font-size: 10.6pt; line-height: ${L("1.62", "1.5")}; color: #1d2329; margin: 0; }
h1 { font-size: 21pt; line-height: 1.3; margin: 0 0 4px; color: #123a73; }
h2 { font-size: 14pt; margin: 18px 0 6px; color: #123a73; border-bottom: 2px solid #dbe4f3; padding-bottom: 3px; break-after: avoid; }
h2 .no { display: inline-block; background: #2a6fdb; color: #fff; border-radius: 6px; padding: 0 8px; margin-right: 6px; font-size: 12pt; }
p { margin: 5px 0; }
.sub { color: #555; font-size: 10.5pt; }
.mono, code { font-family: "Noto Sans Mono", monospace; font-size: 9.6pt; }
table { border-collapse: collapse; width: 100%; margin: 6px 0 8px; font-size: 9.8pt; break-inside: avoid; }
th, td { border: 1px solid #d6dbe1; padding: 4px 6px; text-align: left; vertical-align: middle; }
th { background: #f1f4f8; font-weight: 700; }
td.big { font-weight: 700; font-size: 11pt; color: #123a73; }
svg, .keep { break-inside: avoid; }
.box { border-radius: 10px; padding: 9px 12px; margin: 8px 0; break-inside: avoid; }
.idea { background: #eef5ff; border: 1px solid #c9dbf7; }
.why { background: #fff6e8; border: 1px solid #f1d6a6; }
.ok { background: #ecf8f0; border: 1px solid #bfe3cb; }
.box b.t { display: block; margin-bottom: 2px; }
.bit { display: inline-block; min-width: 15px; text-align: center; font-family: "Noto Sans Mono", monospace; font-size: 9.5pt; border-radius: 3px; margin: 0 1px; padding: 0 2px; }
.bit.b1 { background: #2a6fdb; color: #fff; } .bit.b0 { background: #e6ebf2; color: #345; }
.bit.out.b1 { background: #1d9a6c; } .bit.sm { min-width: 10px; font-size: 8pt; margin: 0; padding: 0 1px; }
.dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; vertical-align: 0; }
.flow { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin: 8px 0 4px; }
.flow .st { border: 1.5px solid #2a6fdb; border-radius: 8px; padding: 3px 8px; text-align: center; font-size: 9.6pt; line-height: 1.35; background: #fff; }
.flow .st small { display: block; color: #5b6570; font-size: 8pt; }
.flow .ar { color: #2a6fdb; font-weight: 700; }
.weights td { text-align: center; } .weights tr.w td { color: #777; font-size: 8.6pt; }
tr.f0 td:first-child, tr.f1 td:first-child { border-left: 5px solid #8e9aab; }
tr.f2 td:first-child { border-left: 5px solid #2a6fdb; } tr.f3 td:first-child { border-left: 5px solid #c5ced9; }
tr.f4 td:first-child, tr.f5 td:first-child { border-left: 5px solid #b4479a; }
.old { color: #8a96a3; }
.grid { display: grid; grid-template-columns: repeat(9, 1fr); gap: 3px; margin: 6px 0; break-inside: avoid; }
.cell { border: 1px solid #e0e4e9; border-radius: 5px; text-align: center; padding: 2px 0 1px; font-size: 8pt; line-height: 1.3; }
.cell .n { color: #8a96a3; font-size: 7.4pt; } .cell .f { font-weight: 700; font-size: 8.4pt; }
.cols { display: grid; grid-template-columns: 1.35fr 1fr; gap: 12px; }
.foot { color: #7a848e; font-size: 8.6pt; margin-top: 14px; border-top: 1px solid #e3e6ea; padding-top: 5px; }
ol, ul { margin: 4px 0 6px 18px; padding: 0; } li { margin: 2px 0; }
</style></head><body>

<h1>${L("একটা অক্ষর কীভাবে শব্দ হয়", "How one letter becomes sound")}</h1>
<div class="sub">${L(
    "DUBURI acoustic modem: “L” লিখলে board ঠিক কোন কোন pitch বাজায়, ধাপে ধাপে। সব সংখ্যা আসল firmware-এর হিসাব থেকে নেওয়া।",
    "DUBURI acoustic modem: exactly which pitches the board plays when you type “L”, step by step. Every number comes from the real firmware's calculation.")}</div>

<div class="flow">
  <div class="st"><b>L</b><small>${L("অক্ষর", "letter")}</small></div><span class="ar">→</span>
  <div class="st"><b>76</b><small>${L("সংখ্যা", "number")}</small></div><span class="ar">→</span>
  <div class="st"><b>8 bit</b><small>01001100</small></div><span class="ar">→</span>
  <div class="st"><b>48 bit</b><small>${L("খাম + আঙুলের ছাপ", "envelope + fingerprint")}</small></div><span class="ar">→</span>
  <div class="st"><b>108 bit</b><small>${L("ভুল-সংশোধন", "error correction")}</small></div><span class="ar">→</span>
  <div class="st"><b>${L("এলোমেলো", "shuffle")}</b><small>interleave</small></div><span class="ar">→</span>
  <div class="st"><b>${L("54 জোড়া", "54 pairs")}</b><small>${L("2 bit করে", "2 bits each")}</small></div><span class="ar">→</span>
  <div class="st"><b>64 tone${L("", "s")}</b><small>${L("10 শুরু + 54 data", "10 start + 54 data")}</small></div><span class="ar">→</span>
  <div class="st"><b>🔊</b><small>speaker</small></div>
</div>

<div class="box idea"><b class="t">${L("মূল ধারণা", "The big idea")}</b>${L(
    "পুরো জিনিসটা একটা গোপন চিঠি পাঠানোর মতো: অক্ষরকে সংখ্যা বানাও, খামে ভরো, খামে একটা “আঙুলের ছাপ” দাও যাতে নষ্ট হলে ধরা যায়, কিছু “ইঙ্গিত” যোগ করো যাতে একটু নষ্ট হলেও ঠিক করা যায়, তারপর প্রতিটা ছোট টুকরোকে একটা সুর (pitch) দিয়ে বাজাও। Receiver ঠিক উল্টো ক্রমে কাজ করে।",
    "It works like posting a letter: turn the character into a number, put it in an envelope, add a “fingerprint” so damage can be detected, add some “hints” so small damage can be repaired, then play each small piece as a musical pitch. The receiver does everything in reverse.")}</div>

<h2><span class="no">${STEP} 1</span>${L("অক্ষর → সংখ্যা → bit", "Letter → number → bits")}</h2>
<p>${L(
    `Computer অক্ষর চেনে না, শুধু সংখ্যা চেনে। প্রতিটা অক্ষরের একটা নির্দিষ্ট নম্বর আছে (UTF-8 নিয়ম)। <b>L = ${byte}</b> (hex-এ <span class="mono">${hex2(byte)}</span>)। এই সংখ্যাকে 8টা ঘরে 0/1 দিয়ে লেখা হয়, প্রতিটা ঘরের একটা মান আছে। যেসব ঘরে 1, তাদের মান যোগ করলে সংখ্যাটা পাওয়া যায়:`,
    `A computer doesn't know letters, only numbers. Every character has a fixed number (the UTF-8 rule). <b>L = ${byte}</b> (<span class="mono">${hex2(byte)}</span> in hex). That number is written with 0s and 1s in 8 boxes, and each box has a value. Add up the values of the boxes that hold a 1 and you get the number back:`)}</p>
<table class="weights">
<tr class="w"><td>128</td><td>64</td><td>32</td><td>16</td><td>8</td><td>4</td><td>2</td><td>1</td><td rowspan="2" style="text-align:left">64 + 8 + 4 = <b>${byte}</b> ✔</td></tr>
<tr>${[...bin8(byte)].map((c) => `<td>${chips(c)}</td>`).join("")}</tr>
</table>
<p>${L(
    `একটা 0 বা 1 = <b>1 bit</b>। 8টা bit = <b>1 byte</b>। ইংরেজি অক্ষর 1 byte, বাংলা অক্ষর 3 byte (যেমন “আ” = <span class="mono">E0 A6 86</span>)।`,
    `One 0 or 1 = <b>1 bit</b>. 8 bits = <b>1 byte</b>. An English letter is 1 byte; a Bangla letter is 3 bytes (for example “আ” = <span class="mono">E0 A6 86</span>).`)}</p>

<h2><span class="no">${STEP} 2</span>${L("খামে ভরা (packet)", "Into an envelope (packet)")}</h2>
<p>${L(
    "শুধু অক্ষর পাঠালে receiver জানবে না কার চিঠি, কাকে পাঠানো, কোনটা আগে। তাই অক্ষরটাকে 4 byte-এর একটা খামে ভরা হয়, সাথে 2 byte আঙুলের ছাপ:",
    "If only the letter were sent, the receiver wouldn't know who sent it, who it's for, or what order it came in. So the letter goes into a 4-byte envelope, plus a 2-byte fingerprint:")}</p>
<table><tr><th>byte</th><th>${L("কী আছে", "what it holds")}</th><th>${L("“L”-এর বেলায়", "for “L”")}</th><th>hex</th><th>bit</th></tr>${frameRows}</table>
<p>${L(
    `দ্বিতীয় byte-এর শেষ 4 bit (<span class="mono">1011</span>) তিনটা পতাকা: <b>8</b> = প্রথম packet, <b>2</b> = এটা লেখা (text), <b>1</b> = শেষ packet। “L” একাই একটা packet, তাই প্রথমও, শেষও। মোট <b>6 byte = 48 bit</b>।`,
    `The last 4 bits of byte 2 (<span class="mono">1011</span>) are three flags: <b>8</b> = first packet, <b>2</b> = this is text, <b>1</b> = last packet. “L” fits in one packet, so it is both first and last. Total <b>6 bytes = 48 bits</b>.`)}</p>

<h2><span class="no">${STEP} 3</span>${L("আঙুলের ছাপ (CRC-16)", "The fingerprint (CRC-16)")}</h2>
<p>${L(
    `প্রথম 4 byte থেকে একটা নির্দিষ্ট গাণিতিক নিয়মে (CRC-16) একটা 16 bit-এর সংখ্যা বের করা হয়: <b class="mono">${hex2(frame[4])}${hex2(frame[5])}</b>। Receiver নিজেও একই হিসাব করে। মিললে চিঠি ঠিক আছে, না মিললে নষ্ট, ফেলে দেয়।`,
    `A fixed mathematical rule (CRC-16) turns the first 4 bytes into a 16-bit number: <b class="mono">${hex2(frame[4])}${hex2(frame[5])}</b>. The receiver does the same calculation. If it matches, the packet is fine; if not, it was damaged and is thrown away.`)}</p>
<div class="box why"><b class="t">${L("উদাহরণ: পথে একটা মাত্র bit উল্টে গেলে", "Example: one single bit flips on the way")}</b>${L(
    `L-এর শেষ bit 0 থেকে 1 হলে অক্ষরটা হয়ে যায় <b>M</b>। তখন ছাপ হওয়ার কথা <span class="mono">${crcM.toString(16).toUpperCase()}</span>, কিন্তু খামে লেখা <span class="mono">${crc.toString(16).toUpperCase()}</span>। মেলে না, তাই receiver ভুল “M” দেখায় না। ভুল অক্ষর দেখানোর চেয়ে কিছু না দেখানো ভালো।`,
    `If the last bit of L changes from 0 to 1, the letter becomes <b>M</b>. Its fingerprint should then be <span class="mono">${crcM.toString(16).toUpperCase()}</span>, but the envelope says <span class="mono">${crc.toString(16).toUpperCase()}</span>. They don't match, so the receiver never shows a wrong “M”. Showing nothing is better than showing the wrong letter.`)}</div>

<h2><span class="no">${STEP} 4</span>${L("ভুল-সংশোধনের ইঙ্গিত যোগ (convolutional code)", "Adding repair hints (convolutional code)")}</h2>
<p>${L(
    "পানিতে বা বাতাসে কিছু bit নষ্ট হবেই। তাই প্রতিটা bit থেকে <b>2টা bit</b> বানানো হয়, এমনভাবে যে প্রতিটা নতুন bit আগের 6টা bit-এর সাথে জড়িয়ে থাকে। ফলে একটা bit হারালেও আশেপাশের bit থেকে সেটা আন্দাজ করা যায়।",
    "In water or air some bits will get damaged. So every bit is turned into <b>2 bits</b>, in a way that ties each new bit to the 6 bits before it. If one bit is lost, it can be worked out from its neighbours.")}</p>
<div class="box idea"><b class="t">${L("যন্ত্রটা কীভাবে কাজ করে", "How the machine works")}</b>${L(
    `একটা 7 ঘরের সারি আছে। প্রতিবার নতুন bit বাঁ দিক থেকে ঢোকে, সবচেয়ে পুরনোটা ডান দিক দিয়ে বেরিয়ে যায়। তারপর দুটো আলাদা “ছাঁকনি” দিয়ে কিছু ঘর বেছে নেওয়া হয় আর তাদের মধ্যে কয়টা 1 আছে গোনা হয়: বিজোড় হলে 1, জোড় হলে 0। ছাঁকনি A নেয় ঘর <span class="mono">1111001</span>, ছাঁকনি B নেয় <span class="mono">1011011</span> (Wi-Fi আর মহাকাশযানে ব্যবহৃত বিখ্যাত “171/133” code)।`,
    `There is a row of 7 boxes. Each new bit enters on the left and the oldest falls off the right. Two different “filters” then pick some boxes and count how many 1s they hold: odd → 1, even → 0. Filter A uses boxes <span class="mono">1111001</span>, filter B uses <span class="mono">1011011</span> (the famous “171/133” code used in Wi-Fi and by space probes).`)}</div>
<table><tr><th>#</th><th>${L("নতুন bit", "new bit")}</th><th>${L("7 ঘরের সারি (নতুন → পুরনো)", "7-box row (new → old)")}</th><th>${L("ছাঁকনি A", "filter A")}</th><th>A</th><th>${L("ছাঁকনি B", "filter B")}</th><th>B</th><th>${L("বেরোল", "out")}</th></tr>${convRows}</table>
<p>${L(
    "48টা bit + শেষে 6টা 0 (সারি খালি করার জন্য) = 54 bit ঢুকে <b>108 bit</b> বেরোয়। এই code-এর বিশেষত্ব: যেকোনো দুটো আলাদা চিঠির 108 bit কমপক্ষে <b>10 জায়গায়</b> আলাদা। তাই কয়েকটা bit নষ্ট হলেও receiver বুঝতে পারে আসল চিঠি কোনটা ছিল (সবচেয়ে কাছের বৈধ চিঠি বেছে নেয়, এর নাম Viterbi decoder)।",
    "48 bits + 6 zeros at the end (to empty the row) = 54 bits go in and <b>108 bits</b> come out. The special property of this code: the 108 bits of any two different messages differ in at least <b>10 places</b>. So even if a few bits are damaged, the receiver can tell which message was really sent (it picks the closest valid message; this is called the Viterbi decoder).")}</p>

<h2><span class="no">${STEP} 5</span>${L("এলোমেলো করা (interleave)", "Shuffling (interleave)")}</h2>
<p>${L(
    "শব্দে সাধারণত একসাথে কয়েকটা জিনিস নষ্ট হয় (একটা হঠাৎ আওয়াজ, বা একটা pitch দুর্বল)। পাশাপাশি bit একসাথে নষ্ট হলে ভুল-সংশোধন পারে না। তাই 108 bit-কে একটা নির্দিষ্ট নিয়মে ছড়িয়ে দেওয়া হয়: bit নম্বর c যায় slot <b>(37 × c) mod 54</b>-এ (c &lt; 54 হলে slot-এর প্রথম bit, নাহলে দ্বিতীয়)।",
    "With sound, damage usually comes in clumps (a sudden noise, or one weak pitch). If neighbouring bits are damaged together, error correction can't fix them. So the 108 bits are spread out by a fixed rule: bit number c goes to slot <b>(37 × c) mod 54</b> (the slot's first bit if c &lt; 54, otherwise its second).")}</p>
<div class="cols"><div><table><tr><th>${L("coded bit c", "coded bit c")}</th><th>${L("কোন slot-এ", "goes to slot")}</th><th>${L("slot-এর কোন bit", "which bit of the slot")}</th></tr>${interRows}</table></div>
<div class="box ok"><b class="t">${L("ফল", "Result")}</b>${L(
    "পাশাপাশি bit (0, 1, 2…) চলে যায় slot 0, 37, 20… তে, অর্থাৎ সময়ে অনেক দূরে আর আলাদা pitch-group-এ। এখন একটা আওয়াজ বা একটা দুর্বল pitch শুধু ছড়ানো-ছিটানো কয়েকটা bit নষ্ট করে, যা ধাপ 4-এর ইঙ্গিত দিয়ে ঠিক হয়ে যায়।",
    "Neighbouring bits (0, 1, 2…) land in slots 0, 37, 20…, far apart in time and in different pitch groups. Now one noise burst or one weak pitch only damages a few scattered bits, which the step 4 hints can repair.")}</div></div>

<h2><span class="no">${STEP} 6</span>${L("2টা bit → একটা pitch", "2 bits → one pitch")}</h2>
<p>${L(
    "এখন 108 bit-কে 2টা করে নেওয়া হয় → <b>54টা জোড়া = 54টা slot</b>। 2 bit-এর 4 রকম হতে পারে, তাই প্রতিটা slot-এ 4টা pitch-এর একটা বাজে:",
    "Now the 108 bits are taken 2 at a time → <b>54 pairs = 54 slots</b>. A pair can be 4 different things, so each slot plays one of 4 pitches:")}</p>
<table style="width:60%"><tr><th>${L("bit জোড়া", "bit pair")}</th><td>${chips("00")}</td><td>${chips("01")}</td><td>${chips("10")}</td><td>${chips("11")}</td></tr>
<tr><th>${L("মান (value)", "value")}</th><td>0</td><td>1</td><td>2</td><td>3</td></tr></table>
<p>${L(
    "মোট 24টা pitch আছে, 6টা group-এ ভাগ করা (প্রতি group-এ 4টা)। Slot 0 group 0 ব্যবহার করে, slot 1 group 1, … slot 6 আবার group 0। প্রতিটা group পুরো 3–8.75 kHz জুড়ে ছড়ানো, যাতে একটা frequency দুর্বল হলে সব bit নষ্ট না হয়।",
    "There are 24 pitches, split into 6 groups of 4. Slot 0 uses group 0, slot 1 group 1, … slot 6 group 0 again. Every group is spread across the whole 3–8.75 kHz band, so one weak frequency can't ruin all the bits.")}</p>
<div class="box idea"><b class="t">${L("দুটো সূত্র", "Two formulas")}</b>
<span class="mono">${L("tone নম্বর", "tone number")} = group + 6 × value</span> &nbsp;&nbsp;&nbsp;
<span class="mono">pitch = 3000 + 250 × ${L("tone নম্বর", "tone number")} (Hz)</span></div>
<table><tr><th>group</th><th>value 0</th><th>value 1</th><th>value 2</th><th>value 3</th></tr>${groupTable}</table>
<div class="keep"><p><b>${L("“L”-এর প্রথম 6টা slot:", "The first 6 slots of “L”:")}</b></p>
<table><tr><th>slot</th><th>${L("bit জোড়া", "bit pair")}</th><th>value</th><th>group</th><th>${L("tone নম্বর", "tone number")}</th><th>pitch</th></tr>${slotRows}</table></div>
<div class="keep"><p>${L("সব 54টা slot (ছোট সংখ্যা = slot, নিচে bit জোড়া আর pitch):", "All 54 slots (small number = slot, then its bit pair and pitch):")}</p>
<div class="grid">${allSlots}</div></div>

<h2><span class="no">${STEP} 7</span>${L("শুরুর সংকেত আর পুরো ছবি", "The start signal and the full picture")}</h2>
<p>${L(
    `Data-র আগে সবসময় একই <b>10টা pitch</b> বাজে: ${tones.slice(0, 10).map(hz).join(", ")} Hz। এটা “মনোযোগ দাও, চিঠি শুরু হচ্ছে” বলার মতো। Receiver এই নকশা খুঁজে পেলে বোঝে packet ঠিক কখন শুরু, আর প্রতিটা slot কখন। নকশাটা এমনভাবে বাছা যে অন্য packet-এর data কখনো এর 2টার বেশি ঘরের সাথে মেলে না, আর পাশাপাশি pitch অনেক দূরে।`,
    `Before the data, the same <b>10 pitches</b> always play: ${tones.slice(0, 10).map(hz).join(", ")} Hz. It's like saying “attention, a message starts now”. When the receiver finds this pattern, it knows exactly when the packet starts and when each slot begins. The pattern is chosen so that another packet's data can never match more than 2 of its slots, and neighbouring pitches are far apart.`)}</p>
<div class="keep"><p><b>${L("“L”-এর পুরো 64টা tone", "All 64 tones of “L”")}</b> ${L("(প্রতিটা রঙিন ঘর = এক slot-এ যে pitch বাজে; data-র রং = তার group):", "(each coloured box = the pitch played in one slot; data colour = its group):")}</p>
${pianoRoll()}</div>
<table><tr><th></th><th>${L("AIR মোড (ঘর)", "AIR mode (room)")}</th><th>${L("WATER মোড (পুল)", "WATER mode (pool)")}</th></tr>
<tr><td>${L("এক slot", "one slot")}</td><td>40 ms</td><td>20 ms</td></tr>
<tr><td>${L("“L”-এর 64 tone", "64 tones of “L”")}</td><td><b>${L("2.56 সেকেন্ড", "2.56 seconds")}</b></td><td><b>${L("1.28 সেকেন্ড", "1.28 seconds")}</b></td></tr></table>
<p>${L(
    "খামের byte 4 (দ্বিতীয় অক্ষরের জায়গা) খালি ছিল। “Lo” লিখলে o সেখানে বসত, তাই একই 2.56 সেকেন্ডে 2টা অক্ষর যেত।",
    "Byte 4 of the envelope (room for a 2nd letter) was empty. Typing “Lo” would put the o there, so 2 letters would go in the same 2.56 seconds.")}</p>

<h2><span class="no">${STEP} 8</span>${L("Receiver: উল্টো দিকে", "The receiver: in reverse")}</h2>
<ol>
<li>${L("<b>শুরুর সংকেত খোঁজা:</b> প্রতি 2.5 ms-এ 24টা pitch-এর প্রতিটার জোর মাপে (প্রতিটা pitch-এর জন্য যেন আলাদা একটা কান)। 10টা শুরুর pitch ঠিক ক্রমে পেলে ঘড়ি মিলিয়ে নেয়।",
    "<b>Find the start signal:</b> every 2.5 ms it measures how strong each of the 24 pitches is (like a separate ear for each pitch). When the 10 start pitches arrive in the right order, it sets its clock.")}</li>
<li>${L("<b>প্রতিটা slot-এ:</b> সেই slot-এর group-এর 4টা pitch-এর মধ্যে কোনটা সবচেয়ে জোরে, দেখে। সেটা থেকে 2 bit, সাথে “কতটা নিশ্চিত” সেই তথ্যও রাখে।",
    "<b>In each slot:</b> it checks which of the slot's group's 4 pitches is loudest. That gives 2 bits, and it also keeps how sure it is.")}</li>
<li>${L("<b>এলোমেলো উল্টানো:</b> 108 bit আবার আগের ক্রমে সাজায়।", "<b>Un-shuffle:</b> puts the 108 bits back in their original order.")}</li>
<li>${L("<b>ভুল ঠিক করা (Viterbi):</b> সবচেয়ে সম্ভাব্য আসল 48 bit বের করে, কম নিশ্চিত bit-গুলোকে কম গুরুত্ব দিয়ে।", "<b>Repair (Viterbi):</b> finds the most likely original 48 bits, giving less weight to bits it was unsure about.")}</li>
<li>${L("<b>আঙুলের ছাপ মেলানো:</b> CRC মিললে খাম খোলে → “node 1 থেকে: <b>L</b>”। না মিললে “damaged packet”।", "<b>Check the fingerprint:</b> if the CRC matches, it opens the envelope → “from node 1: <b>L</b>”. If not → “damaged packet”.")}</li>
</ol>
<div class="box ok"><b class="t">${L("q (link quality) কী?", "What is q (link quality)?")}</b>${L(
    "প্রতিটা slot-এ জেতা pitch-টা তার স্বাভাবিক পটভূমির আওয়াজের চেয়ে কত জোরে, সেটা dB-তে। সব slot-এর মাঝামাঝি মানটাই q। q ≥ 10 dB নিশ্চিন্ত, 7–10 dB চলবে, 7-এর নিচে packet হারাতে শুরু করে।",
    "How much louder the winning pitch in each slot is than that pitch's normal background noise, in dB. q is the middle value over all slots. q ≥ 10 dB is safe, 7–10 dB works, below 7 dB packets start getting lost.")}</div>
<div class="box why"><b class="t">${L("“প্রতি অক্ষরে একটা pitch দিলেই তো দ্রুত হতো?”", "“Wouldn't one pitch per letter be faster?”")}</b>${L(
    "হতো, কিন্তু একটা echo বা আওয়াজে <b>ভুল অক্ষর আসত, কেউ টেরও পেত না</b>। আমাদের পদ্ধতি ভুল <b>ধরে</b> (CRC) আর <b>ঠিক করে</b> (ভুল-সংশোধন), যেকোনো ভাষা পাঠাতে পারে (সবই byte), আর কার থেকে কাকে তাও জানায়। গতি কিছুটা কম, কিন্তু নির্ভরযোগ্য।",
    "Yes, but then one echo or noise burst would deliver <b>a wrong letter, and nobody would know</b>. Our method <b>detects</b> mistakes (CRC) and <b>repairs</b> them (error correction), works for any language (everything is bytes), and also says who it's from and to. A bit slower, but reliable.")}</div>

<div class="foot">${L(
    "DUBURI IVC · firmware/DuburiModem/am_core.c, am_text.c · এই PDF তৈরি: docs/explainer/build_explainer.js (সব সংখ্যা pc/amcore.js দিয়ে হিসাব করা, যা firmware-এর C code-এর হুবহু রূপ)",
    "DUBURI IVC · firmware/DuburiModem/am_core.c, am_text.c · made by docs/explainer/build_explainer.js (every number computed with pc/amcore.js, an exact port of the firmware's C code)")}</div>
</body></html>`;
}

(async () => {
  const browser = await chromium.launch();
  for (const lang of ["bn", "en"]) {
    const tmp = path.join(os.tmpdir(), `duburi_explainer_${lang}.html`);
    fs.writeFileSync(tmp, buildHtml(lang));
    const page = await browser.newPage();
    await page.goto("file://" + tmp);
    await page.evaluate(() => document.fonts.ready);
    await page.pdf({ path: OUTS[lang], format: "A4", printBackground: true, preferCSSPageSize: true,
      displayHeaderFooter: true, headerTemplate: "<span></span>",
      footerTemplate: '<div style="font-size:8px;color:#888;width:100%;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>' });
    await page.close();
    console.log("wrote", OUTS[lang]);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
