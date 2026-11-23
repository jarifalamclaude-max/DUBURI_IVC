"""
frontend_sim.py - underwater receiver front end: LM358 2-stage preamp vs a MAX9814
module with its electret mic removed and the piezo hydrophone soldered to the mic pads.

Same arena as arena_sim.py (25 x 25 x 8 m pool, absolute levels, the real am_core.c
receiver in WATER mode). Both front ends get input-referred amplifier noise
(LM358 40 nV/rtHz, MAX9814 30 nV/rtHz). MAX9814: piezo capacitance into the module's
2.2 kOhm mic-bias resistor (kept or removed), flat gain 40-60 dB set by its AGC,
output limited to about 2 Vpp around 1.25 V, then the 3.3 k / 4.7 nF RC filter.

    make -C tests && python3 sim/frontend_sim.py          (range, ~3 min on 4 cores)
    python3 sim/frontend_sim.py stress                    (weaker source until it fails)
"""
import json, multiprocessing as mp, os, sys
import numpy as np, scipy.signal as sg
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import arena_sim as A
import pool_sim as ps

FA = ps.FA
CP = 20e-9            # piezo capacitance (27-35 mm disc / contact pickup: ~20-30 nF; 20 nF = worst case)

def hp1(x, fc):
    b, a = sg.bilinear([1 / (2 * np.pi * fc), 0], [1 / (2 * np.pi * fc), 1], FA); return sg.lfilter(b, a, x)
def lp1(x, fc):
    b, a = sg.bilinear([1.0], [1 / (2 * np.pi * fc), 1.0], FA); return sg.lfilter(b, a, x)
def white(n, rng, en):          # input-referred amplifier noise, V/sqrt(Hz)
    return rng.standard_normal(n) * en * np.sqrt(FA / 2)

FE = {
  # name: (input load R, amp noise, gain range dB, peak target V, output clip V, bias V)
  "LM358 2-stage":            dict(R=None,  en=40e-9, g=(30, 63), tgt=0.8, clip=None, bias=1.34),
  "MAX9814, 2.2k kept":       dict(R=1/(1/2.2e3+1/100e3), en=30e-9, g=(40, 60), tgt=1.0, clip=1.15, bias=1.25),
  "MAX9814, 2.2k removed":    dict(R=100e3, en=30e-9, g=(40, 60), tgt=1.0, clip=1.15, bias=1.25),
}

_core = {}
def one(args):
    seed, d, sl, nl, thr, fe = args
    f = FE[fe]
    if "c" not in _core: _core["c"] = ps.Core("libamcore.so")
    core = _core["c"]
    rng = np.random.default_rng(seed)
    pos = A.positions(rng, d)
    if pos is None: return None
    a, b = pos
    pkt = (2, 1, int(rng.integers(0, 16)), 0x2, int(rng.integers(32, 127)), int(rng.integers(32, 127)))
    tones = core.tx_tones(pkt)
    lead, tail = 1.0, 0.6
    s = ps.tx_chain(ps.tx_square(tones, core.tone_hz, rng, lead, tail), rng)
    i0, i1 = int(lead * FA), int((lead + len(tones) * ps.Core.T_SLOT) * FA)
    s *= 10 ** (sl / 20) / np.sqrt(ps.band_power(s[i0:i1]))
    p = sg.fftconvolve(s, ps.pool_ir(a, b, A.DIMS, A.R_WALL, A.R_WALL, A.R_SURF))[:len(s)]
    n = ps.pool_noise(len(p), rng, thrusters=thr, whine_hz=None, clicks=True, pinger_hz=None)
    n *= 10 ** (nl / 20) / np.sqrt(ps.band_power(n))
    vin = (p + n) * 10 ** (A.SENS / 20)                    # open-circuit piezo voltage
    rng2 = np.random.default_rng(seed + 7)                 # same amp-noise draw for every front end
    if f["R"] is None:
        shape = lambda x: ps.preamp(x)                     # LM358 band-pass (1.5-10 kHz) + RC
    else:
        fc = 1 / (2 * np.pi * f["R"] * CP)                 # piezo C into bias R / MICIN
        shape = lambda x: lp1(lp1(hp1(x, fc), 20e3), 10300)  # MAX9814 ~flat, then R3/C5 RC on the board
    v = shape(vin) + shape(white(len(vin), rng2, f["en"]))
    peak = np.percentile(np.abs(v[i0:i1]), 99.9)
    g = np.clip(f["tgt"] / max(peak, 1e-12), 10 ** (f["g"][0] / 20), 10 ** (f["g"][1] / 20))
    out = v * g
    clipped = float(np.mean(np.abs(out[i0:i1]) > f["clip"])) if f["clip"] else 0.0
    if f["clip"]: out = np.clip(out, -f["clip"], f["clip"])
    x = ps.adc(out / A.LSB_V, A.FS_ADC, rng, offset=f["bias"] / A.LSB_V)
    res, st = core.receive(x, A.FS_ADC * 1.0002)
    sig = shape(p * 10 ** (A.SENS / 20))[i0:i1] * g / A.LSB_V
    return dict(ok=any(r[0] == pkt for r in res), wrong=sum(r[0] != pkt for r in res),
                gain=20 * np.log10(g), adc=float(np.sqrt(np.mean(sig ** 2))), clipped=clipped)

def stress():
    """Weaker and weaker source at 32 m: thrusters on (water-noise limited) and quiet pool."""
    N = int(os.environ.get("SIM_N", "20"))
    rows = []
    with mp.Pool() as pool:
        for nname, nl, thr, sls, seed0 in (("thrusters on", 118.0, True, (132.6, 122.6, 117.6), 61000),
                                           ("quiet pool", 90.0, False, (107.6, 102.6, 97.6), 71000)):
            for sl in sls:
                for fe in FE:
                    r = [x for x in pool.map(one, [(seed0 + i, 32, sl, nl, thr, fe) for i in range(N)]) if x]
                    ok = sum(x["ok"] for x in r)
                    rows.append(dict(noise=nname, sl=sl, d=32, fe=fe, ok=ok, n=len(r)))
                    print(f"{nname:13s} SL {sl:5.1f} dB  32 m  {fe:22s} {ok:2d}/{len(r)}", flush=True)
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results", "frontend_stress.json")
    json.dump(rows, open(out, "w"), indent=1)


def main():
    N = int(os.environ.get("SIM_N", "20"))
    D = [1, 2, 5, 15, 32]
    out = []
    with mp.Pool() as pool:
        for sname, sl in A.SOURCES.items():
            for nname, (nl, thr) in A.NOISE.items():
                for fe in FE:
                    pts = []
                    for d in D:
                        r = [x for x in pool.map(one, [(41000 + 997 * d + i, d, sl, nl, thr, fe) for i in range(N)]) if x]
                        pts.append(dict(d=d, ok=sum(x["ok"] for x in r), n=len(r), wrong=sum(x["wrong"] for x in r),
                                        gain=float(np.median([x["gain"] for x in r])),
                                        adc=float(np.median([x["adc"] for x in r])),
                                        clip=float(np.max([x["clipped"] for x in r]))))
                    out.append(dict(source=sname, noise=nname, fe=fe, points=pts))
                    print(f"{sname[:12]:12s} | {nname[:24]:24s} | {fe:22s} | " +
                          "  ".join(f"{p['d']}m {p['ok']}/{p['n']} g{p['gain']:.0f} adc{p['adc']:.0f}"
                                    + (f" clip{100*p['clip']:.1f}%" if p['clip'] else "") for p in pts), flush=True)
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results", "frontend_range.json")
    json.dump(out, open(path, "w"), indent=1)


if __name__ == "__main__":
    stress() if len(sys.argv) > 1 and sys.argv[1] == "stress" else main()
