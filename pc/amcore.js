/* ===== AMCORE START: JavaScript port of the modem core (generated into the pages by pc/sync_common.py) =====
 * amcore.js - DUBURI modem in JavaScript, a line-by-line port of
 *   firmware/DuburiModem/am_core.c  (tones, coding, receiver)
 *   firmware/DuburiModem/am_text.c  (text messages)
 * so a laptop's own speaker and microphone can talk to each other (or to an
 * ESP32 board) without any hardware. pc/test/amcore_test.js checks it against
 * the C code on the same recordings. Edit here, then run pc/sync_common.py.
 */
var AMCore = (function () {
  "use strict";
  const NTONES = 24, NSETS = 6, M = 4, PRE_LEN = 10, FRAME_BYTES = 6, PAYLOAD_BYTES = 4;
  const INFO_BITS = 54, CODED_BITS = 108, DATA_SLOTS = 54, TOTAL_SLOTS = 64;
  const T_HOP = 0.0025, T_TRACK = 0.001;
  const DET_SCORE_MIN = 0.14, DET_MATCH_MIN = 5;
  const PEAK_HOPS = 14, NOISE_INIT_HOPS = 40, NOISE_ALPHA = 1 / 256, NOISE_CLIP = 8, LLR_CLAMP = 20;
  const RING = 8192, RING_MASK = RING - 1, HIST = 256, OUTQ = 4;
  const PREAMBLE = [0, 14, 6, 22, 9, 17, 4, 21, 5, 11];
  const MODES = {
    water: { name: "water", slot: 0.020, win: 0.016 },
    air: { name: "air", slot: 0.040, win: 0.032 },
  };
  const F_TEXT = 0x2, F_FIRST = 0x8, F_LAST = 0x1, F_ACK_REQ = 0x8, F_IS_ACK = 0x4;
  const TEXT_MAX = 64, TEXT_TIMEOUT_MS = 8000, TEXT_DUP_MS = 6000;

  const toneHz = (k) => 3000 + 250 * k;
  const round = (x) => Math.round(x);

  function crc16(bytes) {
    let c = 0xFFFF;
    for (let i = 0; i < bytes.length; i++) {
      c ^= (bytes[i] & 255) << 8;
      for (let b = 0; b < 8; b++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
    }
    return c;
  }
  function parity7(v) { v ^= v >> 4; v ^= v >> 2; v ^= v >> 1; return v & 1; }
  function convEncode(bits) {
    const out = new Uint8Array(2 * bits.length);
    let st = 0;
    for (let t = 0; t < bits.length; t++) {
      const reg = ((bits[t] & 1) << 6) | st;
      out[2 * t] = parity7(reg & 0x79);
      out[2 * t + 1] = parity7(reg & 0x5B);
      st = reg >> 1;
    }
    return out;
  }
  /* Soft Viterbi, llr > 0 means bit 0; ends in state 0 (zero tail). */
  function viterbi(llr, n) {
    const dec = new Uint8Array(n * 64);
    let pm = new Float64Array(64).fill(-1e30), npm = new Float64Array(64);
    pm[0] = 0;
    for (let t = 0; t < n; t++) {
      const l0 = llr[2 * t], l1 = llr[2 * t + 1];
      for (let ns = 0; ns < 64; ns++) {
        const u = ns >> 5;
        let best = -1e30, bestb = 0;
        for (let b = 0; b < 2; b++) {
          const ps = ((ns & 31) << 1) | b;
          const reg = (u << 6) | ps;
          const m = pm[ps] + (parity7(reg & 0x79) ? -l0 : l0) + (parity7(reg & 0x5B) ? -l1 : l1);
          if (m > best) { best = m; bestb = b; }
        }
        npm[ns] = best;
        dec[t * 64 + ns] = bestb;
      }
      const tmp = pm; pm = npm; npm = tmp;
    }
    const bits = new Uint8Array(n);
    let s = 0;
    for (let t = n - 1; t >= 0; t--) {
      bits[t] = s >> 5;
      s = ((s & 31) << 1) | dec[t * 64 + s];
    }
    return bits;
  }
  const interleave = (c) => 2 * ((37 * c) % DATA_SLOTS) + (c >= DATA_SLOTS ? 1 : 0);

  function pack(p) {
    const f = [((p.dst & 15) << 4) | (p.src & 15), ((p.seq & 15) << 4) | (p.flags & 15), p.cmd & 255, p.arg & 255];
    const c = crc16(f);
    return f.concat([c >> 8, c & 255]);
  }
  function unpack(f) {
    const c = crc16(f.slice(0, PAYLOAD_BYTES));
    const p = { dst: f[0] >> 4, src: f[0] & 15, seq: f[1] >> 4, flags: f[1] & 15, cmd: f[2], arg: f[3] };
    return { p, ok: f[4] === (c >> 8) && f[5] === (c & 255) };
  }
  /* am_tx_build(): packet -> 64 tone indexes */
  function txBuild(p) {
    const frame = pack(p);
    const info = new Uint8Array(INFO_BITS);
    for (let i = 0; i < FRAME_BYTES * 8; i++) info[i] = (frame[i >> 3] >> (7 - (i & 7))) & 1;
    const coded = convEncode(info);
    const stream = new Uint8Array(CODED_BITS);
    for (let c = 0; c < CODED_BITS; c++) stream[interleave(c)] = coded[c];
    const t = PREAMBLE.slice();
    for (let k = 0; k < DATA_SLOTS; k++) t.push((k % NSETS) + NSETS * ((stream[2 * k] << 1) | stream[2 * k + 1]));
    return t;
  }

  /* ---------------------------------------------------------------- receiver */
  const ST_SEARCH = 0, ST_PEAK = 1, ST_DECODE = 2;

  class Rx {
    constructor(fs, mode) {
      this.ring = new Float64Array(RING);
      this.win = new Float64Array(4096);
      this.xw = new Float64Array(4096);
      this.coef = new Float64Array(NTONES);
      this.noise = new Float64Array(NTONES);
      this.scope = new Float64Array(NTONES);
      this.histFrac = new Float64Array(HIST * PRE_LEN);
      this.histAmax = new Uint8Array(HIST);
      this.pkScore = new Float64Array(24);
      this.pkEnd = new Float64Array(24);
      this.llr = new Float64Array(CODED_BITS);
      this.slotQ = new Float64Array(DATA_SLOTS);
      this.preOff = new Int32Array(PRE_LEN);
      this.n = 0; this.dc = -1; this.noiseInit = 0;
      this.out = [];
      this.stats = { preambles: 0, packets_ok: 0, crc_fail: 0, clipped: 0, last_q_db: 0, last_timing_adj: 0 };
      this.muteUntil = 0; this.muted = false;
      this.mode = MODES[mode] ? mode : "water";
      this._timing();
      this._configure(fs);
      this._resetSearch();
    }
    _timing() { this.tSlot = MODES[this.mode].slot; this.tWin = MODES[this.mode].win; }
    _configure(fs) {
      this.fs = fs;
      this.W = Math.min(round(this.tWin * fs), this.win.length);
      this.H = round(T_HOP * fs);
      this.D = round(T_TRACK * fs);
      this.S = this.tSlot * fs;
      for (let n = 0; n < this.W; n++) this.win[n] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (n + 0.5) / this.W);
      for (let k = 0; k < NTONES; k++) this.coef[k] = 2 * Math.cos(2 * Math.PI * toneHz(k) / fs);
      for (let j = 0; j < PRE_LEN; j++) this.preOff[j] = round((PRE_LEN - 1 - j) * this.S / this.H);
    }
    _resetSearch() { this.state = ST_SEARCH; this.hopCount = 0; this.pkN = 0; this.nextHop = this.n + this.H; }
    setMode(mode) {
      if (this.state !== ST_SEARCH || !MODES[mode]) return false;
      this.mode = mode; this._timing(); this._configure(this.fs);
      this.noiseInit = 0; this.noise.fill(0);
      this._resetSearch();
      return true;
    }
    mute(samples) { this.muteUntil = this.n + samples; this.muted = true; this.state = ST_SEARCH; }
    pop() { return this.out.shift() || null; }

    _energies(end, tones, E) {
      const W = this.W, start = end - W, ring = this.ring, win = this.win, xw = this.xw;
      for (let i = 0; i < W; i++) xw[i] = ring[(start + i) & RING_MASK] * win[i];
      for (let t = 0; t < tones.length; t++) {
        const c = this.coef[tones[t]];
        let s1 = 0, s2 = 0;
        for (let i = 0; i < W; i++) { const s0 = xw[i] + c * s1 - s2; s2 = s1; s1 = s0; }
        E[t] = s1 * s1 + s2 * s2 - c * s1 * s2 + 1e-3;
      }
    }
    _slotEnd(slot) { return this.syncBase + round(this.syncFrac + this.trackAdj + (slot + 1) * this.S); }

    _hop() {
      const E = new Float64Array(NTONES), z = new Float64Array(NTONES);
      this._energies(this.n, ALL_TONES, E);
      if (this.state === ST_SEARCH) {
        if (this.noiseInit < NOISE_INIT_HOPS) {
          const k = 1 / (this.noiseInit + 1);
          for (let i = 0; i < NTONES; i++) this.noise[i] += (E[i] - this.noise[i]) * k;
          this.noiseInit++;
          this.nextHop += this.H;
          return;
        }
        for (let i = 0; i < NTONES; i++) {
          let e = E[i];
          if (e > NOISE_CLIP * this.noise[i]) e = NOISE_CLIP * this.noise[i];
          this.noise[i] += (e - this.noise[i]) * NOISE_ALPHA;
        }
      }
      let sum = 0, zmax = 0, amax = 0;
      for (let i = 0; i < NTONES; i++) {
        z[i] = E[i] / this.noise[i];
        this.scope[i] = 10 * Math.log10(z[i]);
        sum += z[i];
        if (z[i] > zmax) { zmax = z[i]; amax = i; }
      }
      const hi = this.hopCount % HIST;
      for (let j = 0; j < PRE_LEN; j++) this.histFrac[hi * PRE_LEN + j] = z[PREAMBLE[j]] / sum;
      this.histAmax[hi] = amax;
      if (this.hopCount >= this.preOff[0]) {
        let score = 0, match = 0;
        for (let j = 0; j < PRE_LEN; j++) {
          const h = (this.hopCount - this.preOff[j]) % HIST;
          score += this.histFrac[h * PRE_LEN + j];
          match += this.histAmax[h] === PREAMBLE[j] ? 1 : 0;
        }
        score /= PRE_LEN;
        if (this.state === ST_SEARCH && score >= DET_SCORE_MIN && match >= DET_MATCH_MIN) {
          this.state = ST_PEAK; this.pkN = 0;
        }
        if (this.state === ST_PEAK) {
          this.pkScore[this.pkN] = score; this.pkEnd[this.pkN] = this.n; this.pkN++;
        }
      }
      this.hopCount++;
      this.nextHop += this.H;
      if (this.state === ST_PEAK && this.pkN >= PEAK_HOPS) this._finishPeak();
    }
    _finishPeak() {
      let m = 0;
      for (let i = 1; i < this.pkN; i++) if (this.pkScore[i] > this.pkScore[m]) m = i;
      const top = this.pkScore[m], lim = 0.85 * top;
      let l = m, r = m;
      while (l > 0 && this.pkScore[l - 1] >= lim) l--;
      while (r < this.pkN - 1 && this.pkScore[r + 1] >= lim) r++;
      const base = 0.7 * top;
      let wsum = 0, isum = 0;
      for (let i = l; i <= r; i++) { const w = this.pkScore[i] - base; wsum += w; isum += w * (i - l); }
      const c = wsum > 0 ? isum / wsum : 0;
      this.syncBase = this.pkEnd[l];
      this.syncFrac = c * this.H;
      this.trackAdj = 0;
      this.slot = 0;
      this.state = ST_DECODE;
      this.stats.preambles++;
      this.nextHop = this._slotEnd(0) + this.D;
    }
    _finishPacket() {
      const cl = new Float64Array(CODED_BITS);
      for (let c = 0; c < CODED_BITS; c++) cl[c] = this.llr[interleave(c)];
      const info = viterbi(cl, INFO_BITS);
      const frame = [0, 0, 0, 0, 0, 0];
      for (let i = 0; i < FRAME_BYTES * 8; i++) frame[i >> 3] |= info[i] << (7 - (i & 7));
      const q = Array.from(this.slotQ).sort((a, b) => a - b);
      const qmed = 0.5 * (q[DATA_SLOTS / 2 - 1] + q[DATA_SLOTS / 2]);
      const u = unpack(frame);
      if (u.ok) {
        this.stats.packets_ok++;
        this.stats.last_q_db = qmed;
        this.stats.last_timing_adj = this.trackAdj;
        if (this.out.length < OUTQ) this.out.push({ pkt: u.p, q_db: qmed, at: this.n });
      } else {
        this.stats.crc_fail++;
      }
      this._resetSearch();
    }
    _decodeSlot() {
      const i = this.slot, set = i % NSETS;
      const tones = [set, set + NSETS, set + 2 * NSETS, set + 3 * NSETS];
      const Ec = new Float64Array(M), z = new Float64Array(M), lz = new Float64Array(M);
      const e = this._slotEnd(i);
      this._energies(e, tones, Ec);
      let vhat = 0;
      for (let v = 0; v < M; v++) {
        z[v] = Ec[v] / this.noise[tones[v]];
        lz[v] = Math.log(z[v]);
        if (z[v] > z[vhat]) vhat = v;
      }
      const clamp = (x) => Math.max(-LLR_CLAMP, Math.min(LLR_CLAMP, x));
      this.llr[2 * i] = clamp(Math.max(lz[0], lz[1]) - Math.max(lz[2], lz[3]));
      this.llr[2 * i + 1] = clamp(Math.max(lz[0], lz[2]) - Math.max(lz[1], lz[3]));
      this.slotQ[i] = 10 * Math.log10(Math.max(z[vhat] - 1, 1e-3));
      if (z[vhat] > 4) {                       /* early/late timing tracking */
        const tv = [tones[vhat]], Ee = new Float64Array(1), El = new Float64Array(1);
        this._energies(e - this.D, tv, Ee);
        this._energies(e + this.D, tv, El);
        const err = (El[0] - Ee[0]) / (El[0] + Ee[0]);
        this.trackAdj += 0.25 * this.D * err;
        const lim = 0.25 * this.S;
        if (this.trackAdj > lim) this.trackAdj = lim;
        if (this.trackAdj < -lim) this.trackAdj = -lim;
      }
      this.slot++;
      if (this.slot >= DATA_SLOTS) this._finishPacket();
      else this.nextHop = this._slotEnd(this.slot) + this.D;
    }
    /* x: samples in ESP32 ADC counts (0..4095, any offset; floats allowed) */
    process(x) {
      for (let k = 0; k < x.length; k++) {
        const xf = x[k];
        if (xf <= 8 || xf >= 4087) this.stats.clipped++;
        if (this.dc < 0) this.dc = xf;
        this.dc += (xf - this.dc) * (1 / 1024);
        this.ring[this.n & RING_MASK] = xf - this.dc;
        this.n++;
        if (this.muted) {
          if (this.n < this.muteUntil) continue;
          this.muted = false; this._resetSearch(); continue;
        }
        while (this.n >= this.nextHop) {
          if (this.state === ST_DECODE) this._decodeSlot();
          else this._hop();
        }
      }
    }
  }
  const ALL_TONES = Array.from({ length: NTONES }, (_, i) => i);

  /* ------------------------------------------------------------ text layer */
  function textPacket(msg, i, dst, src, seq0) {
    const n = Math.ceil(msg.length / 2);
    let flags = F_TEXT;
    if (i === 0) flags |= F_FIRST;
    if (i === n - 1) flags |= F_LAST;
    return { dst: dst & 15, src: src & 15, seq: (seq0 + i) & 15, flags, cmd: msg[2 * i], arg: 2 * i + 1 < msg.length ? msg[2 * i + 1] : 0 };
  }
  const isText = (p) => (p.flags & F_TEXT) !== 0;

  class TextRx {
    constructor() { this.s = Array.from({ length: 16 }, () => ({ active: false, haveSeq: false, lastSeq: 0, lastMs: 0 })); }
    _start(s, p, started) {
      s.active = true; s.started = started; s.qSum = 0; s.qN = 0;
      s.msg = { src: p.src, dst: p.dst, ok: 0, lost: 0, data: [], lostmask: [], q_db: 0 };
    }
    _put(s, b, lost) { if (s.msg.data.length < TEXT_MAX) { s.msg.data.push(lost ? 0 : b); s.msg.lostmask.push(lost ? 1 : 0); } }
    _lostPk(s, n) { for (let k = 0; k < n; k++) { this._put(s, 0, 1); this._put(s, 0, 1); } s.msg.lost += n; }
    _finish(s) {
      s.msg.ok = s.started && s.msg.lost === 0 ? 1 : 0;
      s.msg.q_db = s.qN ? s.qSum / s.qN : 0;
      s.active = false;
      return s.msg;
    }
    /* returns -1 for a repeat, else a list of finished messages (0..2) */
    feed(p, q, now) {
      if (!isText(p)) return [];
      const s = this.s[p.src & 15], seq = p.seq & 15, out = [];
      const recent = s.haveSeq && now - s.lastMs < TEXT_TIMEOUT_MS;
      if (s.haveSeq && seq === s.lastSeq && now - s.lastMs < TEXT_DUP_MS) return -1;
      if (p.flags & F_FIRST) {
        if (s.active) { const miss = (seq - s.lastSeq - 1) & 15; this._lostPk(s, miss < 1 ? 1 : miss); out.push(this._finish(s)); }
        this._start(s, p, true);
      } else if (!s.active) {
        this._start(s, p, false);
        let miss = recent ? ((seq - s.lastSeq - 1) & 15) : 1;
        if (miss < 1) miss = 1;
        this._lostPk(s, miss);
      } else {
        const miss = (seq - ((s.lastSeq + 1) & 15)) & 15;
        if (miss) this._lostPk(s, miss);
      }
      this._put(s, p.cmd, 0);
      if (!((p.flags & F_LAST) && p.arg === 0)) this._put(s, p.arg, 0);
      s.qSum += q; s.qN++;
      s.lastSeq = seq; s.haveSeq = true; s.lastMs = now;
      if (p.flags & F_LAST) out.push(this._finish(s));
      return out;
    }
    poll(now) {
      for (const s of this.s) {
        if (s.active && now - s.lastMs > TEXT_TIMEOUT_MS) { this._lostPk(s, 1); return this._finish(s); }
      }
      return null;
    }
  }
  const HX = "0123456789ABCDEF";
  function formatMsg(m) {
    let hex = "", text = "";
    for (let i = 0; i < m.data.length; i++) {
      hex += m.lostmask[i] ? "__" : HX[m.data[i] >> 4] + HX[m.data[i] & 15];
    }
    const bytes = m.data.map((b, i) => (m.lostmask[i] ? 0x3F : b < 0x20 || b === 0x7F ? 0x2E : b));
    try { text = new TextDecoder().decode(new Uint8Array(bytes)); } catch (_) { text = ""; }
    return `MSG src=${m.src} dst=${m.dst} ok=${m.ok} lost=${m.lost} len=${m.data.length} q=${m.q_db.toFixed(1)} hex=${hex} text=${text}`;
  }

  /* ---------------------------------------------------- audio for a laptop */
  /* One packet as audio: a phase-continuous sine, one tone per slot, with a
   * 3 ms fade at the very start and end (no clicks). */
  function renderPacket(tones, fs, slotS, amp) {
    const n = Math.round(tones.length * slotS * fs);
    const out = new Float32Array(n), fade = Math.round(0.003 * fs);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const k = Math.min(tones.length - 1, Math.floor(i / (slotS * fs)));
      ph += 2 * Math.PI * toneHz(tones[k]) / fs;
      if (ph > 2 * Math.PI) ph -= 2 * Math.PI;
      let g = amp;
      if (i < fade) g *= i / fade;
      if (i > n - fade) g *= (n - i) / fade;
      out[i] = g * Math.sin(ph);
    }
    return out;
  }

  return {
    NTONES, PRE_LEN, TOTAL_SLOTS, DATA_SLOTS, PREAMBLE, MODES, TEXT_MAX,
    F_TEXT, F_FIRST, F_LAST, F_ACK_REQ, F_IS_ACK,
    toneHz, crc16, convEncode, viterbi, interleave, pack, unpack, txBuild,
    Rx, textPacket, isText, TextRx, formatMsg, renderPacket,
  };
})();
if (typeof module !== "undefined" && module.exports) module.exports = AMCore;
/* ===== AMCORE END ===== */
