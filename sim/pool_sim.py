"""
pool_sim.py - small "virtual pool" used to check the modem code on a PC.

It is NOT a vehicle simulator. It only answers: "if the ESP32 receives this
kind of signal (echoes + pump/thruster noise + wrong ADC clock), does the
modem core still decode the packet?". The receiver is the real firmware C
file (firmware/DuburiModem/am_core.c) compiled as libamcore.so.

Signal path modelled:
  ESP32 LEDC square wave -> RC filter -> class-D amp -> speaker in box
  -> pool (image-method echoes) + noise -> piezo -> preamp band-pass
  -> ESP32 ADC (wrong clock, 12 bit, offset) -> am_core RX
"""
import ctypes
import os
import numpy as np
import scipy.signal as sg

FA = 200_000          # "analog" simulation rate (Hz)
C_SOUND = 1480.0      # speed of sound in water (m/s)
HERE = os.path.dirname(os.path.abspath(__file__))


# --------------------------------------------------------------------------
# ctypes wrapper around the real modem core
# --------------------------------------------------------------------------
class Packet(ctypes.Structure):
    _fields_ = [("dst", ctypes.c_uint8), ("src", ctypes.c_uint8), ("seq", ctypes.c_uint8),
                ("flags", ctypes.c_uint8), ("cmd", ctypes.c_uint8), ("arg", ctypes.c_uint8)]

    def tup(self):
        return (self.dst, self.src, self.seq, self.flags, self.cmd, self.arg)


class Result(ctypes.Structure):
    _fields_ = [("pkt", Packet), ("q_db", ctypes.c_float)]


class Stats(ctypes.Structure):
    _fields_ = [("preambles", ctypes.c_uint32), ("packets_ok", ctypes.c_uint32),
                ("crc_fail", ctypes.c_uint32), ("clipped", ctypes.c_uint32),
                ("last_q_db", ctypes.c_float), ("last_timing_adj", ctypes.c_float)]


class Core:
    TOTAL_SLOTS = 64
    T_SLOT = 0.020

    def __init__(self, lib="libamcore.so"):
        self.lib = ctypes.CDLL(os.path.join(HERE, lib))
        L = self.lib
        L.am_tone_hz.restype = ctypes.c_float
        L.am_tone_hz.argtypes = [ctypes.c_int]
        L.am_tx_build.argtypes = [ctypes.POINTER(Packet), ctypes.POINTER(ctypes.c_uint8)]
        L.am_rx_sizeof.restype = ctypes.c_int
        L.am_rx_init.argtypes = [ctypes.c_void_p, ctypes.c_float]
        L.am_rx_process.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint16), ctypes.c_int]
        L.am_rx_pop.argtypes = [ctypes.c_void_p, ctypes.POINTER(Result)]
        L.am_rx_pop.restype = ctypes.c_int
        L.am_rx_get_stats.argtypes = [ctypes.c_void_p, ctypes.POINTER(Stats)]
        L.am_rx_mute.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        self.tone_hz = np.array([L.am_tone_hz(i) for i in range(24)])

    def tx_tones(self, pkt_tuple):
        p = Packet(*pkt_tuple)
        out = (ctypes.c_uint8 * self.TOTAL_SLOTS)()
        self.lib.am_tx_build(ctypes.byref(p), out)
        return np.array(list(out), dtype=int)

    def receive(self, adc_samples, fs_rx, chunk=512):
        """Run the real receiver over a block of uint16 ADC samples."""
        buf = ctypes.create_string_buffer(self.lib.am_rx_sizeof())
        self.lib.am_rx_init(buf, ctypes.c_float(fs_rx))
        x = np.ascontiguousarray(adc_samples, dtype=np.uint16)
        ptr = x.ctypes.data_as(ctypes.POINTER(ctypes.c_uint16))
        results = []
        for i in range(0, len(x), chunk):
            n = min(chunk, len(x) - i)
            self.lib.am_rx_process(buf, ctypes.cast(ctypes.addressof(ptr.contents) + 2 * i,
                                                    ctypes.POINTER(ctypes.c_uint16)), n)
            r = Result()
            while self.lib.am_rx_pop(buf, ctypes.byref(r)):
                results.append((r.pkt.tup(), float(r.q_db), i))
        st = Stats()
        self.lib.am_rx_get_stats(buf, ctypes.byref(st))
        self.last_debug = None
        if hasattr(self.lib, "am_rx_debug"):
            llr = (ctypes.c_float * 108)()
            q = (ctypes.c_float * 54)()
            adj = ctypes.c_float()
            self.lib.am_rx_debug(buf, llr, q, ctypes.byref(adj))
            self.last_debug = (np.array(llr[:]), np.array(q[:]), adj.value)
        return results, st


# --------------------------------------------------------------------------
# Transmitter side
# --------------------------------------------------------------------------
def ledc_real_freq(f):
    """ESP32 LEDC: 80 MHz / (divider with 8 fractional bits) / 1024 steps."""
    div = np.floor(80e6 * 256 / (f * 1024))
    return 80e6 * 256 / (div * 1024)


def tx_square(tones, tone_hz, rng, lead_s, tail_s, slot_jitter_us=30.0):
    """LEDC output: 0/1 square wave, frequency changes every 20 ms slot."""
    n_lead, n_tail = int(lead_s * FA), int(tail_s * FA)
    n_body = int(len(tones) * Core.T_SLOT * FA)
    f_inst = np.zeros(n_lead + n_body + n_tail)
    edges = (np.arange(len(tones) + 1) * Core.T_SLOT * FA).astype(int)
    edges[1:-1] += (rng.normal(0, slot_jitter_us * 1e-6 * FA, len(tones) - 1)).astype(int)
    for k, t in enumerate(tones):
        f_inst[n_lead + edges[k]:n_lead + edges[k + 1]] = ledc_real_freq(tone_hz[t])
    phase = np.cumsum(2 * np.pi * f_inst / FA)
    on = f_inst > 0
    return np.where(on, (np.sin(phase) >= 0).astype(float), 0.0)


def tx_chain(sq, rng, speaker="random"):
    """RC filter + amp + car speaker in a sealed box (unknown response)."""
    # RC low-pass on the board (4.7k + 3.3n, loaded by 10k trimmer): ~15 kHz
    b, a = sg.bilinear([1.0], [1 / (2 * np.pi * 15e3), 1.0], FA)
    x = sg.lfilter(b, a, sq - sq.mean())
    # Speaker + box wall + water coupling: band-pass with random +-5 dB ripple
    sos = sg.butter(2, [1500, 7000], btype="band", fs=FA, output="sos")
    x = sg.sosfilt(sos, x)
    if speaker == "random":
        n = 1025
        fpts = np.geomspace(500, 30000, 14)
        g_db = rng.uniform(-5, 5, len(fpts))
        freqs = np.linspace(0, FA / 2, n)
        mag = 10 ** (np.interp(np.log(np.maximum(freqs, 1)), np.log(fpts), g_db) / 20)
        h = sg.firwin2(513, freqs / (FA / 2), mag)
        x = sg.fftconvolve(x, h, mode="same")
    return x


# --------------------------------------------------------------------------
# Pool (image method) - rectangular box, hard walls, pressure-release surface
# --------------------------------------------------------------------------
def pool_ir(src, rcv, dims=(50.0, 25.0, 5.0), r_wall=0.85, r_bottom=0.85, r_surface=-0.9,
            tmax=0.35, rng=None):
    L, W, D = dims
    rmax = tmax * C_SOUND
    nx = int(rmax / (2 * L)) + 2
    ny = int(rmax / (2 * W)) + 2
    nz = int(rmax / (2 * D)) + 2
    ir = np.zeros(int(tmax * FA) + 1)
    sx, sy, sz = src  # z = depth below surface (surface at z=0, bottom at z=D)
    for px in (0, 1):
        for py in (0, 1):
            for pz in (0, 1):
                mx = np.arange(-nx, nx + 1)[:, None, None]
                my = np.arange(-ny, ny + 1)[None, :, None]
                mz = np.arange(-nz, nz + 1)[None, None, :]
                ix = (1 - 2 * px) * sx + 2 * mx * L
                iy = (1 - 2 * py) * sy + 2 * my * W
                iz = (1 - 2 * pz) * sz + 2 * mz * D
                d = np.sqrt((ix - rcv[0]) ** 2 + (iy - rcv[1]) ** 2 + (iz - rcv[2]) ** 2)
                n_wx = np.abs(mx - px) + np.abs(mx)
                n_wy = np.abs(my - py) + np.abs(my)
                n_surf = np.abs(mz)               # reflections at z=0
                n_bot = np.abs(mz - pz)           # reflections at z=D
                amp = (r_wall ** (n_wx + n_wy)) * (r_surface ** n_surf) * (r_bottom ** n_bot) / np.maximum(d, 0.5)
                amp = np.broadcast_to(amp, d.shape)
                ok = d < rmax
                idx = np.round(d[ok] / C_SOUND * FA).astype(int)
                np.add.at(ir, idx, amp[ok])
    return ir


# --------------------------------------------------------------------------
# Noise at the hydrophone
# --------------------------------------------------------------------------
def shaped_noise(n, rng, f_lo, f_hi, order=2):
    sos = sg.butter(order, [f_lo, f_hi], btype="band", fs=FA, output="sos")
    return sg.sosfilt(sos, rng.standard_normal(n))


def pool_noise(n, rng, thrusters=True, whine_hz=None, clicks=True, pinger_hz=30000.0):
    t = np.arange(n) / FA
    parts = {}
    # pool pump / filtration: strong, low frequency
    pump = shaped_noise(n, rng, 20, 1200) * 30
    for h in range(1, 12):
        pump += 3 * np.sin(2 * np.pi * 100 * h * t + rng.uniform(0, 6.3))
    parts["pump"] = pump
    # broadband background in our band (reference level = 1)
    parts["background"] = shaped_noise(n, rng, 200, 40000)
    if thrusters:
        thr = shaped_noise(n, rng, 300, 12000) * 3
        thr *= 1 + 0.5 * np.sin(2 * np.pi * 45 * t)            # blade-rate modulation
        if whine_hz:
            thr += 2.0 * np.sin(2 * np.pi * whine_hz * t)        # ESC/motor whine tone
        parts["thrusters"] = thr
    if clicks:
        c = np.zeros(n)
        k = rng.poisson(2.0 * n / FA)                           # ~2 clicks per second
        for pos in rng.integers(0, n - 200, k):
            c[pos:pos + 40] += rng.standard_normal(40) * 60
        parts["clicks"] = c
    if pinger_hz:
        p = np.zeros(n)
        start = rng.uniform(0, 2.0)
        while start < n / FA:
            i0 = int(start * FA)
            i1 = min(n, i0 + int(0.004 * FA))
            p[i0:i1] = 40 * np.sin(2 * np.pi * pinger_hz * t[i0:i1])
            start += 2.0
        parts["pinger"] = p
    return sum(parts.values())


# --------------------------------------------------------------------------
# Receiver analog front end + ADC
# --------------------------------------------------------------------------
def preamp(x):
    """Two op-amp stages (HP ~1.5 kHz, LP ~10.6 kHz each) + RC 10.3 kHz."""
    y = x
    for fh, fl in ((1460, 10600), (1540, 14500)):
        b, a = sg.bilinear([1 / (2 * np.pi * fh), 0], [1 / (2 * np.pi * fh), 1], FA)
        y = sg.lfilter(b, a, y)
        b, a = sg.bilinear([1.0], [1 / (2 * np.pi * fl), 1.0], FA)
        y = sg.lfilter(b, a, y)
    b, a = sg.bilinear([1.0], [1 / (2 * np.pi * 10300), 1.0], FA)
    return sg.lfilter(b, a, y)


def adc(x, fs_true, rng, offset=1600.0, noise_lsb=1.5):
    """Sample the analog signal at the ESP32's real (not nominal) rate."""
    t_end = (len(x) - 2) / FA
    ts = np.arange(0, t_end, 1.0 / fs_true)
    v = np.interp(ts * FA, np.arange(len(x)), x)
    v = v + offset + rng.normal(0, noise_lsb, len(v))
    return np.clip(np.round(v), 0, 4095).astype(np.uint16)


def band_power(x, lo=2900, hi=8900):
    sos = sg.butter(4, [lo, hi], btype="band", fs=FA, output="sos")
    y = sg.sosfilt(sos, x)
    return float(np.mean(y ** 2))


# --------------------------------------------------------------------------
# One complete transmission
# --------------------------------------------------------------------------
def random_positions(rng, dims, dist_range=(10, 25)):
    L, W, D = dims
    while True:
        a = np.array([rng.uniform(1, L - 1), rng.uniform(1, W - 1), rng.uniform(0.5, D - 0.5)])
        b = np.array([rng.uniform(1, L - 1), rng.uniform(1, W - 1), rng.uniform(0.5, D - 0.5)])
        if dist_range[0] <= np.linalg.norm(a - b) <= dist_range[1]:
            return a, b


def simulate_packet(core, rng, snr_db=-8.0, pkt=None, dims=(50.0, 25.0, 5.0), r_wall=0.85,
                    fs_true=50600.0, fs_err=0.0002, thrusters=True, whine_hz=None, clicks=True,
                    pinger_hz=30000.0, signal_rms_lsb=120.0, track_lib=None, speaker="random",
                    lead_s=1.0, tail_s=0.6, rx_core=None):
    """Returns dict(ok, wrong, q, preambles, snr_tone...)."""
    if pkt is None:
        pkt = (int(rng.integers(0, 15)), int(rng.integers(0, 15)), int(rng.integers(0, 16)),
               int(rng.integers(0, 16)), int(rng.integers(0, 256)), int(rng.integers(0, 256)))
    tones = core.tx_tones(pkt)
    sq = tx_square(tones, core.tone_hz, rng, lead_s, tail_s)
    s_tx = tx_chain(sq, rng, speaker)
    a, b = random_positions(rng, dims)
    ir = pool_ir(a, b, dims, r_wall, r_wall, -0.9)
    s_rx = sg.fftconvolve(s_tx, ir)[:len(s_tx)]
    n = pool_noise(len(s_rx), rng, thrusters, whine_hz, clicks, pinger_hz)

    # scale noise for the requested in-band SNR (measured where the packet is)
    i0, i1 = int(lead_s * FA), int((lead_s + len(tones) * Core.T_SLOT) * FA)
    ps = band_power(s_rx[i0:i1])
    pn = band_power(n[i0:i1])
    n *= np.sqrt(ps / pn / 10 ** (snr_db / 10))

    y_s = preamp(s_rx)
    y = y_s + preamp(n)
    g = signal_rms_lsb / np.sqrt(np.mean(y_s[i0:i1] ** 2))
    x_adc = adc(y * g, fs_true, rng)
    rc = rx_core or core
    results, st = rc.receive(x_adc, fs_true * (1 + fs_err))
    ok = any(r[0] == pkt for r in results)
    sym_err = None
    if rc.last_debug is not None and st.preambles > 0:
        llr = rc.last_debug[0]
        v = tones[10:] // 6
        bits = np.stack([v >> 1, v & 1], axis=1).ravel()
        sym_err = int(np.sum((llr < 0).astype(int) != bits))
    wrong = sum(1 for r in results if r[0] != pkt)
    q = [r[1] for r in results if r[0] == pkt]
    return dict(ok=ok, wrong=wrong, bit_err=sym_err, q=q[0] if q else None, preambles=st.preambles,
                crc_fail=st.crc_fail, clipped=st.clipped, dist=float(np.linalg.norm(a - b)))
