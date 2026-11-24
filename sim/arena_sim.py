"""
arena_sim.py - WATER-mode range in the 25 m x 25 m x 8 m test pool of the
"Subsea 5-Thruster Open-Arena Simulator v4" (fresh water, AUV at ~2.5 m depth).

Unlike run_sim.py (which sweeps SNR), this uses ABSOLUTE levels, so it answers
"how far does it work" for the real hardware chain:

  exciter tube (XH-M542, ~15 W) --SL--> pool (image-method echoes, walls,
  floor, surface) + noise (quiet / pump / own thrusters) --> piezo hydrophone
  (sensitivity) --> 2-stage preamp (gain set like RV2) --> ESP32 ADC (12 bit)
  --> the real am_core.c receiver (WATER mode)

    make -C tests && python3 sim/arena_sim.py          (~5 min on 4 cores)
"""
import json
import multiprocessing as mp
import os
import sys

import numpy as np
import scipy.signal as sg

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pool_sim as ps  # noqa: E402

FA = ps.FA
DIMS = (25.0, 25.0, 8.0)                   # arena: 25 x 25 m, 8 m deep
R_WALL, R_FLOOR, R_SURF = 0.85, 0.85, -0.9  # tiled concrete, calm surface
SENS = -200.0                              # piezo hydrophone, dB re 1 V/uPa
LSB_V = 0.00075                            # ESP32 ADC, 12 dB attenuation
VREF_LSB = 1.34 / LSB_V
FS_ADC = 50600.0

# Source level of the exciter tube, dB re 1 uPa at 1 m:
# SL = 170.8 + 10 log10(efficiency x electrical W), XH-M542 at 12 V into 4 ohm ~ 15 W
SOURCES = {"expected (0.1 % efficient)": 170.8 + 10 * np.log10(0.001 * 15),
           "pessimistic (0.01 %)": 170.8 + 10 * np.log10(0.0001 * 15)}
# In-band (2.9-8.9 kHz) noise at the hydrophone, dB re 1 uPa
NOISE = {"quiet pool (pump off, vehicles hovering)": (90.0, False),
         "pool pump running": (100.0, False),
         "receiver's own thrusters running": (118.0, True)}
DISTANCES = [5, 10, 15, 20, 25, 30, 32]   # 32 m ~ corner to corner (0.8 m from the walls)


def positions(rng, d):
    """Two vehicles at 1.5-3.5 m depth, horizontal distance ~d, inside the pool."""
    L, W, D = DIMS
    if d > 24:                       # only fits along a diagonal: start near a corner
        for _ in range(10000):
            a = np.array([rng.uniform(0.8, 1.3), rng.uniform(0.8, 1.3), rng.uniform(1.5, 3.5)])
            ang = np.pi / 4 + rng.uniform(-0.03, 0.03)
            b = a + np.array([d * np.cos(ang), d * np.sin(ang), 0.0])
            b[2] = rng.uniform(1.5, 3.5)
            if 0.8 <= b[0] <= L - 0.8 and 0.8 <= b[1] <= W - 0.8:
                return a, b
        return None
    for _ in range(10000):
        a = np.array([rng.uniform(0.8, L - 0.8), rng.uniform(0.8, W - 0.8), rng.uniform(1.5, 3.5)])
        ang = rng.uniform(0, 2 * np.pi)
        b = a + np.array([d * np.cos(ang), d * np.sin(ang), 0.0])
        b[2] = rng.uniform(1.5, 3.5)
        if 0.8 <= b[0] <= L - 0.8 and 0.8 <= b[1] <= W - 0.8:
            return a, b
    return None


_core = {}


def one(args):
    seed, d, sl, nl, thr = args[:5]
    r_wall = args[5] if len(args) > 5 else R_WALL
    if "c" not in _core:
        _core["c"] = ps.Core("libamcore.so")
    core = _core["c"]
    rng = np.random.default_rng(seed)
    pos = positions(rng, d)
    if pos is None:
        return None
    a, b = pos
    pkt = (2, 1, int(rng.integers(0, 16)), 0x2, int(rng.integers(32, 127)), int(rng.integers(32, 127)))
    tones = core.tx_tones(pkt)
    lead, tail = 1.0, 0.6
    sq = ps.tx_square(tones, core.tone_hz, rng, lead, tail)
    s = ps.tx_chain(sq, rng)
    i0, i1 = int(lead * FA), int((lead + len(tones) * ps.Core.T_SLOT) * FA)
    s *= 10 ** (sl / 20) / np.sqrt(ps.band_power(s[i0:i1]))      # uPa at 1 m, in band
    ir = ps.pool_ir(a, b, DIMS, r_wall, r_wall, R_SURF)              # includes 1/distance
    p = sg.fftconvolve(s, ir)[:len(s)]                              # uPa at the hydrophone
    n = ps.pool_noise(len(p), rng, thrusters=thr, whine_hz=None, clicks=True, pinger_hz=None)
    n *= 10 ** (nl / 20) / np.sqrt(ps.band_power(n))
    v = ps.preamp((p + n) * 10 ** (SENS / 20))                     # volts, preamp shape
    # RV2: the highest gain (30..63 dB) that keeps peaks inside the ADC range
    peak = np.percentile(np.abs(v[i0:i1]), 99.9)
    g = np.clip(0.8 / max(peak, 1e-12), 10 ** (30 / 20), 10 ** (63 / 20))
    x = ps.adc(v * g / LSB_V, FS_ADC, rng, offset=VREF_LSB)
    res, st = core.receive(x, FS_ADC * 1.0002)
    sig_rms = np.sqrt(np.mean((ps.preamp(p * 10 ** (SENS / 20))[i0:i1] * g / LSB_V) ** 2))
    snr = 10 * np.log10(ps.band_power(p[i0:i1]) / ps.band_power(n[i0:i1]))
    return dict(ok=any(r[0] == pkt for r in res), wrong=sum(r[0] != pkt for r in res),
                gain_db=20 * np.log10(g), adc_rms=float(sig_rms), snr=float(snr),
                dist=float(np.linalg.norm(a - b)))


def main():
    n = int(os.environ.get("SIM_N", "20"))
    out = []
    with mp.Pool() as pool:
        for sname, sl in SOURCES.items():
            for nname, (nl, thr) in NOISE.items():
                row = dict(source=sname, sl=round(sl, 1), noise=nname, nl=nl, points=[])
                for d in DISTANCES:
                    args = [(31000 + 997 * d + i, d, sl, nl, thr) for i in range(n)]
                    r = [x for x in pool.map(one, args) if x]
                    ok = sum(x["ok"] for x in r)
                    pt = dict(d=d, ok=ok, n=len(r), wrong=sum(x["wrong"] for x in r),
                              snr=float(np.median([x["snr"] for x in r])),
                              gain=float(np.median([x["gain_db"] for x in r])),
                              adc=float(np.median([x["adc_rms"] for x in r])))
                    row["points"].append(pt)
                    print(f"{sname:28s} | {nname:42s} | {d:2d} m: {ok:2d}/{len(r)}  "
                          f"SNR {pt['snr']:5.1f} dB  RV2 gain {pt['gain']:4.1f} dB  ADC {pt['adc']:5.0f} LSB", flush=True)
                out.append(row)
    os.makedirs(os.path.join(os.path.dirname(__file__), "results"), exist_ok=True)
    with open(os.path.join(os.path.dirname(__file__), "results", "arena_range.json"), "w") as f:
        json.dump(out, f, indent=1)


def stress():
    """How much worse can it get before packets are lost? (receiver's thrusters on)"""
    n = int(os.environ.get("SIM_N", "20"))
    rows = []
    with mp.Pool() as pool:
        for r_w in (0.85, 0.93):
            for sl in (142.6, 132.6, 122.6, 117.6):
                for d in (10, 20, 32):
                    args = [(51000 + 991 * d + i, d, sl, 118.0, True, r_w) for i in range(n)]
                    r = [x for x in pool.map(one, args) if x]
                    ok = sum(x["ok"] for x in r)
                    snr = float(np.median([x["snr"] for x in r]))
                    rows.append(dict(r_wall=r_w, sl=sl, d=d, ok=ok, n=len(r), snr=snr))
                    print(f"walls r={r_w}  SL {sl:5.1f} dB  thrusters on  {d:2d} m: {ok:2d}/{len(r)}  SNR {snr:5.1f} dB", flush=True)
    with open(os.path.join(os.path.dirname(__file__), "results", "arena_stress.json"), "w") as f:
        json.dump(rows, f, indent=1)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "stress":
        stress()
    else:
        main()
