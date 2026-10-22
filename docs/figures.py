"""
figures.py - draws the schematics and explanation figures used in the guide.
    python3 docs/figures.py    -> docs/figures/*.svg / *.png
"""
import os
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import schemdraw
import schemdraw.elements as elm

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "figures")
os.makedirs(OUT, exist_ok=True)
BLUE, ORANGE, GREY = "#2a6fdb", "#e07b39", "#666666"


def vlabel(d, x, y1, y2, text, side="right", fontsize=None):
    """Label for a vertical part between y1 and y2 (schemdraw puts labels of
    vertical parts at awkward places, so place them by hand)."""
    dx = 0.75 if side == "right" else -0.75
    lab = elm.Label().at((x + dx, (y1 + y2) / 2)).label(text, loc=side)
    if fontsize:
        lab = elm.Label().at((x + dx, (y1 + y2) / 2)).label(text, loc=side, fontsize=fontsize)
    d += lab


def save(d, name):
    d.save(os.path.join(OUT, name + ".svg"))


# ---------------------------------------------------------------------------
def tx_schematic():
    from schemdraw import flow
    with schemdraw.Drawing(show=False) as d:
        d.config(fontsize=11, unit=2.5)
        d += elm.Dot(open=True).at((0, 0)).label("ESP32\nGPIO25", "left")
        d += elm.Resistor().at((0, 0)).to((3, 0)).label("R1  4.7 kΩ")
        d += elm.Dot().at((3, 0))
        d += elm.Capacitor().at((3, 0)).to((3, -2.5))
        vlabel(d, 3, 0, -2.5, "C1\n3.3 nF", "right")
        d += elm.Ground().at((3, -2.5))
        d += elm.Capacitor().at((3, 0)).to((6, 0)).label("C2  1 µF")
        d += elm.Dot().at((6, 0))
        pot = d.add(elm.Potentiometer().at((6, 0)).to((6, -3)))
        vlabel(d, 6, 0, -3, "RV1\n10 kΩ\nvolume", "left")
        d += elm.Ground().at((6, -3))
        y_in = pot.tap.y
        d += elm.Line().at(pot.tap).to((10, y_in))
        d += flow.Box(w=5, h=4.4).anchor("NW").at((10, 1.4)).label("PAM8403\nclass-D amp\n(5 V, BTL)", fontsize=10)
        d += elm.Label().at((10.15, y_in)).label("IN-L", loc="right", fontsize=9)
        d += elm.Line().at((10, -2.4)).to((9, -2.4))
        d += elm.Ground().at((9, -2.4))
        d += elm.Label().at((10.15, -2.4)).label("GND", loc="right", fontsize=9)
        d += elm.Line().at((12.5, 1.4)).to((12.5, 2.4))
        d += elm.Vdd().at((12.5, 2.4)).label("+5 V (own buck / LC filter)", fontsize=10)
        d += elm.Label().at((14.85, 0.6)).label("OUT+", loc="left", fontsize=9)
        d += elm.Label().at((14.85, -1.6)).label("OUT−", loc="left", fontsize=9)
        d += elm.Line().at((15, 0.6)).to((18, 0.6))
        d += elm.Line().at((15, -1.6)).to((18, -1.6))
        d += elm.Line().at((18, 0.6)).to((18, -0.1))
        d += elm.Line().at((18, -1.6)).to((18, -0.9))
        d += elm.Speaker().at((18, -0.1)).anchor("in1").right().label("car speaker\n4 Ω", "right", ofst=0.3)
        d += elm.Label().at((10, -3.9)).label("BTL output: both speaker wires float. NEVER join OUT− to GND.",
                                              loc="right", color="#c0392b", fontsize=9.5)
        save(d, "tx_schematic")


def _stage(d, x_in, label_u, rf_label, rg, cg, pot=False):
    """Non-inverting stage, + input on top at (x_in, 0). Returns op-amp element."""
    op = d.add(elm.Opamp(leads=True, flip=True).right().anchor("in2").at((x_in, 0)).label(label_u, "center", ofst=(0.4, 0)))
    yf = op.in1.y - 1.6
    d += elm.Line().at(op.in1).to((op.in1.x, yf))
    d += elm.Dot().at((op.in1.x, yf))
    if pot:
        d += elm.Potentiometer().at((op.in1.x, yf)).to((op.out.x, yf)).label(rf_label, "bottom", ofst=0.35)
    else:
        d += elm.Resistor().at((op.in1.x, yf)).to((op.out.x, yf)).label(rf_label, "bottom", ofst=0.35)
    d += elm.Line().at((op.out.x, yf)).to(op.out)
    d += elm.Resistor().at((op.in1.x, yf)).to((op.in1.x, yf - 2.6))
    vlabel(d, op.in1.x, yf, yf - 2.6, rg, "left")
    d += elm.Capacitor().at((op.in1.x, yf - 2.6)).to((op.in1.x, yf - 4.6))
    vlabel(d, op.in1.x, yf - 2.6, yf - 4.6, cg, "left")
    d += elm.Ground().at((op.in1.x, yf - 4.6))
    d += elm.Dot().at(op.out)
    return op


def rx_schematic():
    with schemdraw.Drawing(show=False) as d:
        d.config(fontsize=10, unit=2.4)
        d += elm.Crystal().at((0, -2.4)).to((0, 0))
        vlabel(d, 0, -2.4, 0, "piezo\ndisc", "left")
        d += elm.Ground().at((0, -2.4))
        d += elm.Capacitor().at((0, 0)).to((2.6, 0)).label("Cin 100 nF")
        d += elm.Resistor().at((2.6, 0)).to((5.2, 0)).label("Rs 10 kΩ")
        d += elm.Dot().at((5.2, 0))
        d += elm.Resistor().at((5.2, 0)).to((5.2, 2.6))
        vlabel(d, 5.2, 0, 2.6, "Rb\n1 MΩ", "left")
        d += elm.Label().at((5.2, 2.6)).label("VREF", loc="top")
        d += elm.Line().at((5.2, 0)).to((6.4, 0))
        op1 = _stage(d, 6.4, "U1A", "Rf1 100 kΩ ∥ Cf1 150 pF", "Rg1\n3.3 kΩ", "Cg1\n33 nF")
        x2 = op1.out.x + 2.2
        d += elm.Line().at(op1.out).to((x2, op1.out.y))
        d += elm.Line().at((x2, op1.out.y)).to((x2, 0))
        op2 = _stage(d, x2, "U1B", "RV2 100 kΩ (gain) ∥ 100 pF", "Rg2\n2.2 kΩ", "Cg2\n47 nF", pot=True)
        d += elm.Resistor().at(op2.out).to((op2.out.x + 2.6, op2.out.y)).label("Ro 3.3 kΩ")
        xo = op2.out.x + 2.6
        d += elm.Dot().at((xo, op2.out.y))
        d += elm.Capacitor().at((xo, op2.out.y)).to((xo, op2.out.y - 2.4))
        vlabel(d, xo, op2.out.y, op2.out.y - 2.4, "Caa\n4.7 nF", "right")
        d += elm.Ground().at((xo, op2.out.y - 2.4))
        d += elm.Line().at((xo, op2.out.y)).to((xo + 1.4, op2.out.y))
        d += elm.Dot(open=True).at((xo + 1.4, op2.out.y)).label("ESP32\nGPIO34", "right")
        d += elm.Label().at((0, -9.6)).label(
            "U1 = MCP6002 (3.3 V, best) or LM358 (power it from 5 V). Pin 8 = V+, pin 4 = GND, 100 nF across them.",
            loc="right", fontsize=9)
        save(d, "rx_schematic")


def vref_schematic():
    with schemdraw.Drawing(show=False) as d:
        d.config(fontsize=10, unit=2.2)
        d += elm.Vdd().at((0, 0)).label("ESP32 3V3")
        d += elm.Resistor().at((0, 0)).to((0, -2.5))
        vlabel(d, 0, 0, -2.5, "10 Ω", "left")
        d += elm.Dot().at((0, -2.5)).label("3V3A", "left")
        d += elm.Capacitor(polar=True).at((0, -2.5)).to((0, -5))
        vlabel(d, 0, -2.5, -5, "100 µF", "left")
        d += elm.Ground().at((0, -5))
        d += elm.Line().at((0, -2.5)).to((8, -2.5))
        d += elm.Dot().at((3.5, -2.5))
        d += elm.Resistor().at((3.5, -2.5)).to((3.5, -5))
        vlabel(d, 3.5, -2.5, -5, "10 kΩ", "left")
        d += elm.Dot().at((3.5, -5))
        d += elm.Resistor().at((3.5, -5)).to((3.5, -7.5))
        vlabel(d, 3.5, -5, -7.5, "6.8 kΩ", "left")
        d += elm.Ground().at((3.5, -7.5))
        d += elm.Line().at((3.5, -5)).to((6, -5))
        d += elm.Dot().at((6, -5)).label("VREF ≈ 1.34 V", "right")
        d += elm.Capacitor().at((6, -5)).to((6, -7.5))
        vlabel(d, 6, -5, -7.5, "10 µF", "right")
        d += elm.Ground().at((6, -7.5))
        d += elm.Dot(open=True).at((8, -2.5)).label("op-amp pin 8 (+100 nF)", "right")
        save(d, "vref_schematic")


def power_schematic():
    from schemdraw import flow
    with schemdraw.Drawing(show=False) as d:
        d.config(fontsize=10, unit=2.4)
        d += elm.BatteryCell().at((0, -2.4)).to((0, 0))
        vlabel(d, 0, -2.4, 0, "ROV battery\n12-16.8 V", "left")
        d += elm.Ground().at((0, -2.4))
        d += elm.Fuse().at((0, 0)).to((2.6, 0)).label("fuse 3 A")
        d += elm.Dot().at((3.6, 0))
        d += elm.Line().at((2.6, 0)).to((5, 0))
        d += flow.Box(w=3.6, h=1.8).anchor("W").at((5, 0)).label("BUCK #1  5 V", fontsize=10)
        d += elm.Line().at((8.6, 0)).to((12, 0))
        d += elm.Dot(open=True).at((12, 0)).label("ESP32 5V/VIN pin\n(3V3 for preamp from ESP32)", "right")
        d += elm.Line().at((3.6, 0)).to((3.6, -4))
        d += elm.Line().at((3.6, -4)).to((5, -4))
        d += flow.Box(w=3.6, h=1.8).anchor("W").at((5, -4)).label("BUCK #2\n5 V or 12 V", fontsize=10)
        d += elm.Inductor().at((8.6, -4)).to((11, -4)).label("ferrite / 10 µH", ofst=0.25)
        d += elm.Dot().at((11, -4))
        d += elm.Capacitor(polar=True).at((11, -4)).to((11, -6.4))
        vlabel(d, 11, -4, -6.4, "1000 µF", "right")
        d += elm.Ground().at((11, -6.4))
        d += elm.Line().at((11, -4)).to((12.6, -4))
        d += elm.Dot(open=True).at((12.6, -4)).label("amp VCC", "right")
        d += elm.Label().at((0, -8)).label("All grounds meet at ONE point (battery −): star ground.", loc="right", fontsize=9)
        save(d, "power_schematic")


# ---------------------------------------------------------------------------
def block_diagram():
    fig, ax = plt.subplots(figsize=(9.0, 3.2))
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 36)
    ax.axis("off")

    def box(x, y, w, h, text, col):
        ax.add_patch(plt.Rectangle((x, y), w, h, fc=col, ec="#333333", lw=1.0))
        ax.text(x + w / 2, y + h / 2, text, ha="center", va="center", fontsize=8.5)

    def arrow(x1, y1, x2, y2):
        ax.annotate("", xy=(x2, y2), xytext=(x1, y1), arrowprops=dict(arrowstyle="->", lw=1.2))

    tx = "#dce8fb"
    rx = "#fde6d6"
    ax.text(1, 33.5, "ROV A (sender)", fontsize=10, weight="bold", color=BLUE)
    box(1, 22, 14, 9, "ESP32\n(packet ->\ntones)", tx)
    box(19, 22, 12, 9, "RC filter\n+ volume", tx)
    box(35, 22, 12, 9, "class-D amp\nPAM8403", tx)
    box(51, 22, 13, 9, "car speaker\nin sealed box", tx)
    for x1, x2 in ((15, 19), (31, 35), (47, 51)):
        arrow(x1, 26.5, x2, 26.5)
    ax.text(66, 27.5, "~~~ water ~~~\n10-25 m, echoes,\npump + thruster noise", fontsize=8.5, color=GREY, va="center")
    ax.text(1, 15.5, "ROV B (receiver)", fontsize=10, weight="bold", color=ORANGE)
    box(84, 3, 14, 9, "piezo disc\nhydrophone", rx)
    box(66, 3, 14, 9, "preamp +\nband-pass\n1.5-10 kHz", rx)
    box(48, 3, 14, 9, "ESP32 ADC\n50 kHz DMA", rx)
    box(26, 3, 18, 9, "modem core:\nGoertzel, preamble,\nViterbi, CRC", rx)
    box(6, 3, 16, 9, "action:\nLED / command\n(+ optional ACK)", rx)
    for x1, x2 in ((84, 80), (66, 62), (48, 44), (26, 22)):
        arrow(x1, 7.5, x2, 7.5)
    arrow(80, 22, 91, 12)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "block_diagram.png"), dpi=170)
    plt.close(fig)


def hydrophone_figure():
    fig, ax = plt.subplots(figsize=(8.6, 3.4))
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 40)
    ax.axis("off")
    # left: epoxy potted
    ax.add_patch(plt.Rectangle((5, 8), 36, 22, fc="#e9f3e1", ec="#5b8a3c", lw=1.2))
    ax.add_patch(plt.Rectangle((10, 18), 26, 1.6, fc="#c9a227", ec="k", lw=0.6))      # brass
    ax.add_patch(plt.Rectangle((15, 19.6), 16, 1.2, fc="#d9d9d9", ec="k", lw=0.6))    # ceramic
    ax.plot([23, 23, 41, 50], [20.8, 26, 26, 26], color="k", lw=1)
    ax.plot([11, 11, 41, 50], [18, 12, 12, 12], color="k", lw=1)
    ax.text(23, 33, "A. potted in epoxy / PU / silicone\n(NO air bubbles)", ha="center", fontsize=8.5)
    ax.text(23, 4, "2-3 mm layer << wavelength (300 mm @ 5 kHz)", ha="center", fontsize=8, color=GREY)
    ax.text(45, 28, "shielded\ncable", fontsize=8)
    ax.annotate("brass (shield/GND)", xy=(12, 18.5), xytext=(6, 36), fontsize=7.5, arrowprops=dict(arrowstyle="-", lw=0.6))
    ax.annotate("ceramic (signal)", xy=(28, 20.6), xytext=(30, 36), fontsize=7.5, arrowprops=dict(arrowstyle="-", lw=0.6))
    # right: oil filled
    ax.add_patch(plt.Circle((76, 19), 13, fc="#fff3c9", ec="#b38b00", lw=1.2))
    ax.add_patch(plt.Rectangle((63, 18), 26, 1.6, fc="#c9a227", ec="k", lw=0.6))
    ax.add_patch(plt.Rectangle((68, 19.6), 16, 1.2, fc="#d9d9d9", ec="k", lw=0.6))
    ax.add_patch(plt.Rectangle((73, 30), 6, 7, fc="#333333"))
    ax.text(76, 1.5, "B. inside an oil-filled balloon / finger-cot,\nneck sealed with heat-shrink + epoxy",
            ha="center", fontsize=8.5)
    ax.text(90, 30, "mineral /\nbaby oil", fontsize=8, color="#7a5c00")
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "hydrophone_build.png"), dpi=170)
    plt.close(fig)


def speaker_box_figure():
    fig, ax = plt.subplots(figsize=(8.6, 3.3))
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 38)
    ax.axis("off")
    ax.add_patch(plt.Rectangle((0, 0), 100, 38, fc="#e8f3fb", ec="none"))
    ax.text(2, 34, "water", color="#2a6fdb", fontsize=9)
    ax.add_patch(plt.Rectangle((20, 6), 50, 26, fc="#f7f7f7", ec="k", lw=2))         # box
    ax.add_patch(plt.Rectangle((70, 8), 1.6, 22, fc="#9ecae1", ec="k", lw=0.8))       # window
    ax.plot([56, 66, 66, 56], [10, 14, 24, 28], color="k", lw=1.5)                   # cone
    ax.add_patch(plt.Rectangle((48, 15), 8, 8, fc="#555555"))                        # magnet
    ax.annotate("thin window: 3 mm acrylic\n(4-5 mm if deeper than 3 m)", xy=(71, 26), xytext=(74, 33),
                fontsize=8, arrowprops=dict(arrowstyle="->", lw=0.7))
    ax.annotate("gap >= 10 mm\n(window bends\ninward with depth)", xy=(68, 19), xytext=(74, 12), fontsize=8,
                arrowprops=dict(arrowstyle="->", lw=0.7))
    ax.annotate("magnet: bolt an aluminium\nstrip from magnet to wall\n= heat path", xy=(52, 15), xytext=(22, 1.5),
                fontsize=8, arrowprops=dict(arrowstyle="->", lw=0.7))
    ax.text(24, 27, "sealed box\n(rigid, O-ring)", fontsize=8.5)
    ax.annotate("", xy=(95, 19), xytext=(73, 19), arrowprops=dict(arrowstyle="->", lw=1.5, color="#2a6fdb"))
    ax.text(80, 21, "sound", color="#2a6fdb", fontsize=9)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "speaker_box.png"), dpi=170)
    plt.close(fig)


def heat_figure():
    """Where the power goes: old single-transistor square drive vs amp + sine-ish drive."""
    V, R = 12.0, 4.0
    total = 0.5 * V ** 2 / R
    dc = (V / 2) ** 2 / R
    fund = (2 * V / np.pi) ** 2 / 2 / R
    harm = total - dc - fund
    amp_fund = (5.0 * 0.8) ** 2 / 2 / R
    fig, ax = plt.subplots(figsize=(6.6, 3.0))
    labels = ["new: PAM8403 5 V,\nno clipping, 50% duty", "old: 12 V transistor\non/off, 100% time"]
    ax.barh([1], [dc], color="#c0392b", label="DC (pure heat, no sound)")
    ax.barh([1], [harm], left=[dc], color="#e07b39", label="harmonics")
    ax.barh([1], [fund], left=[dc + harm], color=BLUE, label="useful tone")
    ax.barh([0], [amp_fund * 0.5], color=BLUE)
    ax.set_yticks([0, 1])
    ax.set_yticklabels(labels, fontsize=8.5)
    ax.set_xlabel("average electrical power into the 4 Ω voice coil (W)")
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    ax.legend(frameon=False, fontsize=8, loc="lower right")
    ax.text(total + 0.2, 1, f"{total:.0f} W", va="center", fontsize=9)
    ax.text(amp_fund * 0.5 + 0.2, 0, f"{amp_fund * 0.5:.1f} W", va="center", fontsize=9)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "heat_power.png"), dpi=170)
    plt.close(fig)
    return dict(total=total, dc=dc, fund=fund, harm=harm, amp=amp_fund)


def filter_response_figure():
    import scipy.signal as sg
    f = np.geomspace(100, 60000, 600)
    w = 2 * np.pi * f
    s = 1j * w

    def hp(fc): return (s / (2 * np.pi * fc)) / (1 + s / (2 * np.pi * fc))
    def lp(fc): return 1 / (1 + s / (2 * np.pi * fc))
    H = 31.3 * hp(1460) * lp(10600) * 23.7 * hp(1540) * lp(15900) * lp(10300)
    fig, ax = plt.subplots(figsize=(6.6, 3.0))
    ax.semilogx(f, 20 * np.log10(np.abs(H)), color=BLUE)
    ax.axvspan(3000, 8750, color="#2a6fdb", alpha=0.08)
    ax.text(5100, 20 * np.log10(np.abs(H)).max() + 2, "our tones", ha="center", fontsize=8, color=BLUE)
    for fx, lab in ((100, "pump hum"), (35000, "pinger\n25-40 kHz")):
        ax.axvline(fx, color=ORANGE, ls="--", lw=0.8)
        ax.text(fx * 1.08, 20, lab, fontsize=8, color=ORANGE)
    ax.set_xlabel("frequency (Hz)")
    ax.set_ylabel("preamp gain (dB), RV2 at middle")
    ax.grid(True, which="both", color="#eeeeee")
    for sp in ("top", "right"):
        ax.spines[sp].set_visible(False)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "preamp_response.png"), dpi=170)
    plt.close(fig)


def goertzel_figure():
    fs, N = 50000, 800
    n = np.arange(N)
    win = 0.5 - 0.5 * np.cos(2 * np.pi * (n + 0.5) / N)
    x = np.sin(2 * np.pi * 4500 * n / fs) + 0.8 * np.random.default_rng(1).standard_normal(N)
    freqs = 3000 + 250 * np.arange(24)
    E = []
    for fk in freqs:
        c = 2 * np.cos(2 * np.pi * fk / fs)
        s1 = s2 = 0.0
        for v in x * win:
            s0 = v + c * s1 - s2
            s2, s1 = s1, s0
        E.append(s1 * s1 + s2 * s2 - c * s1 * s2)
    E = np.array(E)
    fig, ax = plt.subplots(figsize=(6.6, 2.8))
    ax.bar(freqs, 10 * np.log10(E / np.median(E)), width=180, color=[ORANGE if f == 4500 else BLUE for f in freqs])
    ax.set_xlabel("tone (Hz)")
    ax.set_ylabel("Goertzel energy (dB\nabove median)")
    for sp in ("top", "right"):
        ax.spines[sp].set_visible(False)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "goertzel_demo.png"), dpi=170)
    plt.close(fig)


if __name__ == "__main__":
    tx_schematic()
    rx_schematic()
    vref_schematic()
    power_schematic()
    block_diagram()
    hydrophone_figure()
    speaker_box_figure()
    print(heat_figure())
    filter_response_figure()
    goertzel_figure()
    print("figures in", OUT)
