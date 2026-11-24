"""
air_sim.py - "virtual room" for the AIR mode (speaker -> air -> MAX9814 mic).

Same idea as pool_sim.py: the receiver is the real firmware C file. Only the
channel and the front end change:

  ESP32 LEDC square wave -> RC filter -> PAM8403 -> small speaker (in air)
  -> room (image-method echoes, c = 343 m/s, all surfaces reflect)
  + room noise (fan, voices, hiss) -> electret mic + MAX9814 (flat)
  -> RC anti-alias 3.3k/4.7n -> ESP32 ADC (wrong clock) -> am_core RX

    make -C tests && python3 sim/air_sim.py            # timing sweep (AIR choice)
    python3 sim/air_sim.py text                         # multi-packet text test

The timing sweep compiles am_core.c with different AM_AIR_T_SLOT/AM_AIR_T_WIN
values, so it needs `cc` on the PC.
"""
import ctypes
import json
import multiprocessing as mp
import os
import subprocess
import sys

import numpy as np
import scipy.signal as sg

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pool_sim as ps  # noqa: E402

FA = ps.FA
C_AIR = 343.0
HERE = os.path.dirname(os.path.abspath(__file__))
CORE_C = os.path.join(HERE, "..", "firmware", "DuburiModem", "am_core.c")
OUT = os.path.join(HERE, "results")

ROOMS = {
    # name: (dims m, amplitude reflection of every surface)
    "furnished room": ((6.0, 4.5, 2.8), 0.87),   # RT60 ~0.45 s
    "bare tiled room": ((6.0, 4.5, 2.8), 0.93),  # RT60 ~0.8 s (concrete + tiles)
    "hall": ((15.0, 10.0, 4.0), 0.92),           # RT60 ~1.3 s
}


def rt60_sabine(dims, r):
    L, W, H = dims
    V = L * W * H
    S = 2 * (L * W + L * H + W * H)
    alpha = 1 - r * r
    return 0.161 * V / (S * alpha)


# --------------------------------------------------------------------------
class AirCore(ps.Core):
    """ps.Core + medium mode + variable slot length."""

    def __init__(self, lib="libamcore.so", mode=1, t_slot=None):
        super().__init__(lib)
        L = self.lib
        L.am_rx_set_mode.argtypes = [ctypes.c_void_p, ctypes.c_int]
        L.am_rx_set_mode.restype = ctypes.c_int
        self.mode = mode
        self.t_slot = t_slot

    def receive(self, adc_samples, fs_rx, chunk=512):
        buf = ctypes.create_string_buffer(self.lib.am_rx_sizeof())
        self.lib.am_rx_init(buf, ctypes.c_float(fs_rx))
        assert self.lib.am_rx_set_mode(buf, self.mode) == 1
        x = np.ascontiguousarray(adc_samples, dtype=np.uint16)
        base = x.ctypes.data
        results = []
        for i in range(0, len(x), chunk):
            n = min(chunk, len(x) - i)
            self.lib.am_rx_process(buf, ctypes.cast(base + 2 * i, ctypes.POINTER(ctypes.c_uint16)), n)
            r = ps.Result()
            while self.lib.am_rx_pop(buf, ctypes.byref(r)):
                results.append((r.pkt.tup(), float(r.q_db), i))
        st = ps.Stats()
        self.lib.am_rx_get_stats(buf, ctypes.byref(st))
        return results, st


def build_variant(t_slot, t_win):
    name = f"libamcore_air_{int(t_slot * 1000)}_{int(t_win * 1000)}.so"
    path = os.path.join(HERE, name)
    if not os.path.exists(path) or os.path.getmtime(path) < os.path.getmtime(CORE_C):
        subprocess.check_call(["cc", "-O2", "-std=c99", "-DAM_SIM", "-shared", "-fPIC",
                               f"-DAM_AIR_T_SLOT={t_slot}f", f"-DAM_AIR_T_WIN={t_win}f",
                               "-o", path, CORE_C, "-lm"])
    return name


# --------------------------------------------------------------------------
def tx_square(tone_lists, tone_hz, rng, t_slot, lead_s, gap_s, tail_s, slot_jitter_us=30.0):
    """Several packets back to back (gap_s of silence between them)."""
    pieces = [np.zeros(int(lead_s * FA))]
    for k, tones in enumerate(tone_lists):
        n_body = int(round(len(tones) * t_slot * FA))
        f_inst = np.zeros(n_body)
        edges = np.round(np.arange(len(tones) + 1) * t_slot * FA).astype(int)
        edges[1:-1] += rng.normal(0, slot_jitter_us * 1e-6 * FA, len(tones) - 1).astype(int)
        for j, t in enumerate(tones):
            f_inst[edges[j]:edges[j + 1]] = ps.ledc_real_freq(tone_hz[t])
        phase = np.cumsum(2 * np.pi * f_inst / FA) + rng.uniform(0, 6.28)
        pieces.append((np.sin(phase) >= 0).astype(float))
        if k < len(tone_lists) - 1:
            pieces.append(np.zeros(int(gap_s * FA)))
    pieces.append(np.zeros(int(tail_s * FA)))
    sq = np.concatenate(pieces)
    on = np.concatenate([np.zeros(int(lead_s * FA))] +
                        sum([[np.ones(int(round(len(t) * t_slot * FA)))] +
                             ([np.zeros(int(gap_s * FA))] if k < len(tone_lists) - 1 else [])
                             for k, t in enumerate(tone_lists)], []) +
                        [np.zeros(int(tail_s * FA))])
    return sq, on[:len(sq)]


def tx_chain_air(sq, on, rng):
    """RC filter (DC block + 15 kHz) + PAM8403 + small speaker in air."""
    b, a = sg.bilinear([1.0], [1 / (2 * np.pi * 15e3), 1.0], FA)
    x = sg.lfilter(b, a, (sq - 0.5) * on)
    sos = sg.butter(2, [400, 12000], btype="band", fs=FA, output="sos")
    x = sg.sosfilt(sos, x)
    n = 1025
    fpts = np.geomspace(300, 30000, 16)
    g_db = rng.uniform(-6, 6, len(fpts))           # cheap speaker: bumpy response
    freqs = np.linspace(0, FA / 2, n)
    mag = 10 ** (np.interp(np.log(np.maximum(freqs, 1)), np.log(fpts), g_db) / 20)
    h = sg.firwin2(513, freqs / (FA / 2), mag)
    return sg.fftconvolve(x, h, mode="same")


def room_ir(src, rcv, dims, r, tmax=None, rng=None):
    """Image method, rigid room: every surface reflects with amplitude r."""
    L, W, H = dims
    if tmax is None:
        tmax = min(0.8, 0.75 * rt60_sabine(dims, r))  # ~45 dB of decay
    rmax = tmax * C_AIR
    nx, ny, nz = int(rmax / (2 * L)) + 2, int(rmax / (2 * W)) + 2, int(rmax / (2 * H)) + 2
    ir = np.zeros(int(tmax * FA) + 1)
    mx = np.arange(-nx, nx + 1)[:, None, None]
    my = np.arange(-ny, ny + 1)[None, :, None]
    mz = np.arange(-nz, nz + 1)[None, None, :]
    for px in (0, 1):
        for py in (0, 1):
            for pz in (0, 1):
                ix = (1 - 2 * px) * src[0] + 2 * mx * L
                iy = (1 - 2 * py) * src[1] + 2 * my * W
                iz = (1 - 2 * pz) * src[2] + 2 * mz * H
                d = np.sqrt((ix - rcv[0]) ** 2 + (iy - rcv[1]) ** 2 + (iz - rcv[2]) ** 2)
                nref = (np.abs(mx - px) + np.abs(mx)) + (np.abs(my - py) + np.abs(my)) + \
                       (np.abs(mz - pz) + np.abs(mz))
                amp = np.broadcast_to(r ** nref / np.maximum(d, 0.3), d.shape)
                idx = np.round(d / C_AIR * FA).astype(int)
                ok = idx < len(ir)
                np.add.at(ir, idx[ok], amp[ok])
    return ir


def room_noise(n, rng):
    t = np.arange(n) / FA
    fan = ps.shaped_noise(n, rng, 60, 1500) * 6
    for h in range(1, 10):
        fan += 1.5 * np.sin(2 * np.pi * 50 * h * t + rng.uniform(0, 6.3))
    hiss = ps.shaped_noise(n, rng, 100, 20000)                 # reference level
    voice = ps.shaped_noise(n, rng, 250, 4000) * 4
    env = np.clip(np.sin(2 * np.pi * 3.5 * t + rng.uniform(0, 6.3)), 0, None) ** 2
    talk = rng.random() < 0.5                                  # half the runs: people talking
    return fan + hiss + (voice * env if talk else 0)


def mic_frontend(x):
    """MAX9814: flat in our band (HP ~ 100 Hz); then RC 3.3k/4.7n = 10.3 kHz."""
    sos = sg.butter(1, 100, btype="high", fs=FA, output="sos")
    y = sg.sosfilt(sos, x)
    b, a = sg.bilinear([1.0], [1 / (2 * np.pi * 10300), 1.0], FA)
    return sg.lfilter(b, a, y)


def random_pos(rng, dims, dist_range):
    L, W, H = dims
    while True:
        a = np.array([rng.uniform(0.5, L - 0.5), rng.uniform(0.5, W - 0.5), rng.uniform(0.7, 1.6)])
        b = np.array([rng.uniform(0.5, L - 0.5), rng.uniform(0.5, W - 0.5), rng.uniform(0.7, 1.6)])
        if dist_range[0] <= np.linalg.norm(a - b) <= dist_range[1]:
            return a, b


def simulate(core, rng, pkts, room="furnished room", snr_db=10.0, dist=(1.0, 5.0),
             gap_s=0.4, fs_true=50600.0, fs_err=0.0002, signal_rms_lsb=150.0, lead_s=0.8, tail_s=1.0):
    """Send pkts (list of 6-tuples) back to back; return decoded list + stats."""
    dims, r = ROOMS[room]
    tone_lists = [core.tx_tones(p) for p in pkts]
    sq, on = tx_square(tone_lists, core.tone_hz, rng, core.t_slot, lead_s, gap_s, tail_s)
    s_tx = tx_chain_air(sq, on, rng)
    a, b = random_pos(rng, dims, dist)
    ir = room_ir(a, b, dims, r)
    s_rx = sg.fftconvolve(s_tx, ir)[:len(s_tx)]
    noise = room_noise(len(s_rx), rng)
    m = on[:len(s_rx)] > 0
    ps_ = ps.band_power(s_rx[m]) if m.any() else 1.0
    pn = ps.band_power(noise[m])
    noise *= np.sqrt(ps_ / pn / 10 ** (snr_db / 10))
    y_s = mic_frontend(s_rx)
    y = y_s + mic_frontend(noise)
    g = signal_rms_lsb / np.sqrt(np.mean(y_s[m] ** 2))
    x_adc = ps.adc(y * g, fs_true, rng, offset=1550.0)
    results, st = core.receive(x_adc, fs_true * (1 + fs_err))
    return results, st, float(np.linalg.norm(a - b))


# --------------------------------------------------------------------------
_cache = {}


def _job(args):
    lib, t_slot, room, snr, seed = args
    key = (lib, t_slot)
    if key not in _cache:
        _cache[key] = AirCore(lib, mode=1, t_slot=t_slot)
    core = _cache[key]
    rng = np.random.default_rng(seed)
    pkt = tuple(int(v) for v in (rng.integers(0, 15), rng.integers(0, 15), rng.integers(0, 16),
                                 rng.integers(0, 16), rng.integers(0, 256), rng.integers(0, 256)))
    res, st, d = simulate(core, rng, [pkt], room=room, snr_db=snr)
    ok = any(x[0] == pkt for x in res)
    wrong = sum(1 for x in res if x[0] != pkt)
    return ok, wrong


def sweep(n=30):
    variants = [(0.020, 0.016), (0.030, 0.024), (0.040, 0.032)]
    libs = [(build_variant(s, w), s, w) for s, w in variants]
    out = []
    with mp.Pool() as pool:
        for room in ROOMS:
            for snr in (6.0, 0.0, -4.0):
                for lib, s, w in libs:
                    args = [(lib, s, room, snr, 7000 + i) for i in range(n)]
                    res = pool.map(_job, args)
                    ok = sum(r[0] for r in res)
                    wrong = sum(r[1] for r in res)
                    row = dict(room=room, rt60=round(rt60_sabine(*ROOMS[room]), 2), snr=snr,
                               slot_ms=int(s * 1000), win_ms=int(w * 1000), ok=ok, n=n, wrong=wrong)
                    out.append(row)
                    print(row, flush=True)
    return out


def text_test(n_msgs=12, slot=None):
    """Multi-packet messages back to back through the real core (AIR + WATER timing)."""
    core = AirCore("libamcore.so", mode=1, t_slot=slot or 0.040)
    rng = np.random.default_rng(42)
    tot = okc = 0
    for m in range(n_msgs):
        npk = int(rng.integers(3, 9))
        pkts = [(2, 1, (m * 9 + k) & 15, 0x2 | (0x8 if k == 0 else 0) | (0x1 if k == npk - 1 else 0),
                 int(rng.integers(32, 127)), int(rng.integers(32, 127))) for k in range(npk)]
        res, st, d = simulate(core, rng, pkts, room="furnished room", snr_db=10.0, gap_s=0.4)
        got = [x[0] for x in res]
        hit = sum(1 for p in pkts if p in got)
        tot += npk
        okc += hit
        print(f"msg {m}: {hit}/{npk} packets, dist {d:.1f} m, preambles {st.preambles}, crc_fail {st.crc_fail}")
    print(f"TOTAL {okc}/{tot} packets")
    return okc, tot


def simulate_water(core, rng, pkts, snr_db=-4.0, gap_s=0.4, fs_true=50600.0, fs_err=0.0002,
                   lead_s=1.0, tail_s=0.6):
    """WATER mode: several packets back to back through pool_sim's pool."""
    tone_lists = [core.tx_tones(p) for p in pkts]
    sq, on = tx_square(tone_lists, core.tone_hz, rng, 0.020, lead_s, gap_s, tail_s)
    s_tx = ps.tx_chain(sq * on, rng)
    a, b = ps.random_positions(rng, (50.0, 25.0, 5.0))
    ir = ps.pool_ir(a, b, (50.0, 25.0, 5.0), 0.85, 0.85, -0.9)
    s_rx = sg.fftconvolve(s_tx, ir)[:len(s_tx)]
    n = ps.pool_noise(len(s_rx), rng, True, None, True, 30000.0)
    m = on[:len(s_rx)] > 0
    n *= np.sqrt(ps.band_power(s_rx[m]) / ps.band_power(n[m]) / 10 ** (snr_db / 10))
    y_s = ps.preamp(s_rx)
    y = y_s + ps.preamp(n)
    g = 120.0 / np.sqrt(np.mean(y_s[m] ** 2))
    x_adc = ps.adc(y * g, fs_true, rng)
    results, st = core.receive(x_adc, fs_true * (1 + fs_err))
    return results, st, float(np.linalg.norm(a - b))


def text_test_water(n_msgs=12):
    core = AirCore("libamcore.so", mode=0, t_slot=0.020)
    rng = np.random.default_rng(43)
    tot = okc = 0
    for m in range(n_msgs):
        npk = int(rng.integers(3, 9))
        pkts = [(2, 1, (m * 9 + k) & 15, 0x2 | (0x8 if k == 0 else 0) | (0x1 if k == npk - 1 else 0),
                 int(rng.integers(32, 127)), int(rng.integers(32, 127))) for k in range(npk)]
        res, st, d = simulate_water(core, rng, pkts)
        got = [x[0] for x in res]
        hit = sum(1 for p in pkts if p in got)
        tot += npk
        okc += hit
        print(f"water msg {m}: {hit}/{npk} packets, dist {d:.1f} m, preambles {st.preambles}, crc_fail {st.crc_fail}")
    print(f"WATER TOTAL {okc}/{tot} packets (in-band SNR -4 dB)")
    return okc, tot


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    if len(sys.argv) > 1 and sys.argv[1] == "text":
        text_test()
        text_test_water()
    else:
        rows = sweep(int(os.environ.get("SIM_N", "30")))
        with open(os.path.join(OUT, "air_timing.json"), "w") as f:
            json.dump(rows, f, indent=1)
