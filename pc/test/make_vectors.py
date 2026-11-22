"""
make_vectors.py - recordings for pc/test/amcore_test.js.

Simulates text packets through a virtual room (AIR) and pool (WATER) with
sim/air_sim.py, decodes them with the C core (sim/libamcore.so) and writes
  pc/test/vectors/NAME.u16   raw ADC samples (uint16, little endian)
  pc/test/vectors/index.json fs, mode, packets sent, and what C decoded
    make -C tests && python3 pc/test/make_vectors.py
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "sim"))
import air_sim as a  # noqa: E402
import pool_sim as ps  # noqa: E402

OUT = os.path.join(HERE, "vectors")


class Capture(a.AirCore):
    """AirCore that also keeps the ADC samples it was given."""
    def receive(self, adc_samples, fs_rx, chunk=512):
        self.last_adc, self.last_fs = np.array(adc_samples, dtype=np.uint16), fs_rx
        return super().receive(adc_samples, fs_rx, chunk)


def text_pkts(msg, seq0):
    b = msg.encode()
    n = (len(b) + 1) // 2
    return [(2, 1, (seq0 + i) & 15, 0x2 | (0x8 if i == 0 else 0) | (0x1 if i == n - 1 else 0),
             b[2 * i], b[2 * i + 1] if 2 * i + 1 < len(b) else 0) for i in range(n)]


def main():
    os.makedirs(OUT, exist_ok=True)
    index = []
    air = Capture("libamcore.so", mode=1, t_slot=0.040)
    water = Capture("libamcore.so", mode=0, t_slot=0.020)
    cases = []
    for k, (room, snr) in enumerate([("furnished room", 10), ("furnished room", 0), ("bare tiled room", 3),
                                     ("bare tiled room", -3), ("hall", 0), ("furnished room", -5),
                                     ("bare tiled room", -8), ("hall", -9)]):
        cases.append(("air", f"air{k}", room, snr, 100 + k))
    for k, snr in enumerate([0, -4, -6, -9]):
        cases.append(("water", f"water{k}", "pool", snr, 200 + k))
    for mode, name, room, snr, seed in cases:
        rng = np.random.default_rng(seed)
        pk = text_pkts("Hi DUBURI!", seed % 16)
        if mode == "air":
            res, st, d = a.simulate(air, rng, pk, room=room, snr_db=snr, gap_s=0.4)
            core = air
        else:
            res, st, d = a.simulate_water(water, rng, pk, snr_db=snr)
            core = water
        core.last_adc.astype("<u2").tofile(os.path.join(OUT, name + ".u16"))
        index.append(dict(name=name, mode=mode, room=room, snr=snr, fs=float(core.last_fs), sent=pk,
                          tones=[[int(t) for t in core.tx_tones(p)] for p in pk],
                          c_decoded=[dict(pkt=list(r[0]), q=r[1]) for r in res],
                          c_stats=dict(preambles=st.preambles, ok=st.packets_ok, crc_fail=st.crc_fail)))
        print(name, room, snr, "dB:", len(res), "/", len(pk), "decoded by C")
    json.dump(index, open(os.path.join(OUT, "index.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
