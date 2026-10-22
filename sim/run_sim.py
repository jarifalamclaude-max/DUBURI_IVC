"""
run_sim.py - checks the modem core in a virtual pool and saves graphs/results.

    make -C tests          # builds sim/libamcore.so from the firmware C file
    python3 sim/run_sim.py # ~5 min on 4 cores -> sim/results/*.png, results.json
"""
import json
import os
import sys
import multiprocessing as mp
import numpy as np
import scipy.signal as sg
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pool_sim as ps

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results")
N = int(os.environ.get("SIM_N", "40"))      # packets per point

_cores = {}


def core(lib):
    if lib not in _cores:
        _cores[lib] = ps.Core(lib)
    return _cores[lib]


def job(args):
    seed, lib, rxlib, kw = args
    rng = np.random.default_rng(seed)
    c = core(lib)
    rc = core(rxlib) if rxlib else None
    r = ps.simulate_packet(c, rng, rx_core=rc, **kw)
    return r


def run_point(pool, kw, n=N, seed0=0, rxlib=None):
    args = [(seed0 * 100000 + i, "libamcore.so", rxlib, kw) for i in range(n)]
    res = pool.map(job, args)
    ok = sum(r["ok"] for r in res)
    det = sum(r["preambles"] > 0 for r in res)
    wrong = sum(r["wrong"] for r in res)
    qs = [r["q"] for r in res if r["q"] is not None]
    return dict(ok=ok, n=n, detected=det, wrong=wrong, q_med=float(np.median(qs)) if qs else None,
                q_all=qs)


def style(ax):
    ax.grid(True, color="#dddddd", lw=0.7)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)


def main():
    os.makedirs(OUT, exist_ok=True)
    results = {}
    with mp.Pool(max(1, os.cpu_count())) as pool:
        # 1) success vs SNR ---------------------------------------------------
        snrs = [-14, -12, -10, -9, -8, -7, -6, -5, -4, -2, 0, 3]
        curve = []
        for k, s in enumerate(snrs):
            r = run_point(pool, dict(snr_db=s), seed0=1000 + k)
            curve.append(dict(snr=s, **{x: r[x] for x in ("ok", "n", "detected", "wrong", "q_med")}))
            print(f"SNR {s:+} dB: ok {r['ok']}/{r['n']} detected {r['detected']} q_med {r['q_med']}")
        results["snr_curve"] = curve

        # 2) reverberation ------------------------------------------------------
        rev = []
        for k, rw in enumerate([0.5, 0.7, 0.85, 0.93]):
            r = run_point(pool, dict(snr_db=-3, r_wall=rw), seed0=2000 + k)
            rev.append(dict(r_wall=rw, ok=r["ok"], n=r["n"]))
            print(f"wall reflection {rw}: ok {r['ok']}/{r['n']}")
        results["reverb"] = rev

        # 3) ADC clock error / measurement error / timing tracker ----------------
        clk = []
        for k, (fe, rxlib) in enumerate([(0.0, None), (0.001, None), (0.003, None), (0.01, None),
                                         (0.003, "libamcore_notrack.so"), (0.001, "libamcore_notrack.so")]):
            r = run_point(pool, dict(snr_db=0, fs_true=51200.0, fs_err=fe), n=max(20, N // 2),
                          seed0=3000 + k, rxlib=rxlib)
            clk.append(dict(fs_err=fe, tracking=rxlib is None, ok=r["ok"], n=r["n"]))
            print(f"Fs estimate error {fe*100:.1f}% tracking={rxlib is None}: ok {r['ok']}/{r['n']}")
        results["clock"] = clk

        # 4) interference: strong thruster whine sitting on a data tone, pinger alias
        intf = []
        for k, (name, kw) in enumerate([("baseline", {}),
                                        ("ESC whine 5500 Hz", dict(whine_hz=5500.0)),
                                        ("pinger 35 kHz", dict(pinger_hz=35000.0)),
                                        ("no thrusters", dict(thrusters=False))]):
            r = run_point(pool, dict(snr_db=-3, **kw), seed0=4000 + k)
            intf.append(dict(case=name, ok=r["ok"], n=r["n"]))
            print(f"{name}: ok {r['ok']}/{r['n']}")
        results["interference"] = intf

    # 5) false alarms: 10 minutes of pool noise, no packets ----------------------
    rng = np.random.default_rng(99)
    c = core("libamcore.so")
    trig = pk = 0
    for i in range(30):
        n = ps.pool_noise(int(20 * ps.FA), rng, thrusters=True, whine_hz=5500, clicks=True, pinger_hz=35000.0)
        y = ps.preamp(n)
        x = ps.adc(y * 150 / np.std(y), 50600, rng)
        res, st = c.receive(x, 50610)
        trig += st.preambles
        pk += len(res)
    results["false_alarm"] = dict(seconds=600, preamble_triggers=trig, packets=pk)
    print("false alarm (600 s noise):", results["false_alarm"])

    with open(os.path.join(OUT, "results.json"), "w") as f:
        json.dump(results, f, indent=1)
    make_figures(results)


def make_figures(results):
    blue, orange = "#2a6fdb", "#e07b39"
    # success vs SNR
    cv = results["snr_curve"]
    fig, ax = plt.subplots(figsize=(6.4, 3.6))
    s = [p["snr"] for p in cv]
    ax.plot(s, [100 * p["ok"] / p["n"] for p in cv], "o-", color=blue, label="packet decoded correctly")
    ax.plot(s, [100 * p["detected"] / p["n"] for p in cv], "s--", color=orange, label="preamble found")
    ax.set_xlabel("in-band SNR at the ADC (dB, 3-9 kHz)")
    ax.set_ylabel("% of packets")
    ax.set_ylim(-3, 103)
    ax.legend(frameon=False, loc="lower right")
    style(ax)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "success_vs_snr.png"), dpi=160)
    plt.close(fig)

    # q reported vs SNR
    fig, ax = plt.subplots(figsize=(6.4, 3.2))
    pts = [(p["snr"], p["q_med"]) for p in cv if p["q_med"] is not None]
    ax.plot([a for a, _ in pts], [b for _, b in pts], "o-", color=blue)
    ax.set_xlabel("in-band SNR at the ADC (dB)")
    ax.set_ylabel("q printed by firmware (dB)")
    style(ax)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "q_vs_snr.png"), dpi=160)
    plt.close(fig)


def extra_figures():
    """Pictures for the guide: one packet's spectrogram, pool echo decay."""
    os.makedirs(OUT, exist_ok=True)
    rng = np.random.default_rng(5)
    c = core("libamcore.so")
    tones = c.tx_tones((2, 1, 3, 8, 1, 0))
    # time-frequency plan of the packet
    fig, ax = plt.subplots(figsize=(7.0, 3.0))
    for k, t in enumerate(tones):
        col = "#e07b39" if k < 10 else "#2a6fdb"
        ax.add_patch(plt.Rectangle((k * 20, c.tone_hz[t] - 90), 20, 180, color=col))
    for f in c.tone_hz:
        ax.axhline(f, color="#eeeeee", lw=0.6, zorder=0)
    ax.set_xlim(0, len(tones) * 20)
    ax.set_ylim(2800, 9000)
    ax.set_xlabel("time (ms)  -  orange = preamble, blue = data")
    ax.set_ylabel("tone (Hz)")
    style(ax)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "packet_plan.png"), dpi=160)
    plt.close(fig)

    # received spectrogram in the virtual pool
    sq = ps.tx_square(tones, c.tone_hz, rng, 0.2, 0.3)
    s_tx = ps.tx_chain(sq, rng)
    a, b = ps.random_positions(rng, (50.0, 25.0, 5.0))
    ir = ps.pool_ir(a, b)
    s_rx = sg.fftconvolve(s_tx, ir)[:len(s_tx)]
    n = ps.pool_noise(len(s_rx), rng)
    i0, i1 = int(0.2 * ps.FA), int((0.2 + 1.28) * ps.FA)
    n *= np.sqrt(ps.band_power(s_rx[i0:i1]) / ps.band_power(n[i0:i1]) / 10 ** (0 / 10))
    y = ps.preamp(s_rx + n)
    x = ps.adc(y * 150 / np.std(y), 50600, rng).astype(float)
    f, t, S = sg.spectrogram(x - x.mean(), fs=50600, nperseg=1024, noverlap=896)
    fig, ax = plt.subplots(figsize=(7.0, 3.2))
    sel = (f > 1000) & (f < 12000)
    ax.pcolormesh(t * 1000, f[sel], 10 * np.log10(S[sel] + 1e-9), shading="auto", cmap="magma")
    ax.set_xlabel("time (ms)")
    ax.set_ylabel("Hz")
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "rx_spectrogram.png"), dpi=160)
    plt.close(fig)

    # echo decay of the pool model
    ir = ps.pool_ir(np.array([10.0, 12.0, 2.0]), np.array([30.0, 10.0, 3.0]))
    e = np.cumsum(ir[::-1] ** 2)[::-1]
    t = np.arange(len(e)) / ps.FA * 1000
    fig, ax = plt.subplots(figsize=(6.4, 3.0))
    ax.plot(t, 10 * np.log10(e / e.max() + 1e-12), color="#2a6fdb")
    ax.axvline(120, color="#e07b39", ls="--", lw=1)
    ax.text(124, -5, "same tone set re-used\nafter 120 ms", color="#e07b39", fontsize=8, va="top")
    ax.set_xlabel("time after the direct sound (ms)")
    ax.set_ylabel("echo energy left (dB)")
    ax.set_ylim(-60, 2)
    style(ax)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "pool_echo_decay.png"), dpi=160)
    plt.close(fig)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "figures":
        extra_figures()
    else:
        main()
        extra_figures()
