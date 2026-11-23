"""
build_connection_guide.py - one offline HTML page that shows, for every node,
which pin connects to which, where each part goes on the breadboard, and a
tick-off build checklist.

    python3 docs/wiring/build_connection_guide.py   ->  docs/connection_guide.html

All parts, holes, wires and connections are read from wiring.py (the same data
that draws and verifies the wiring diagrams), so the page and the pictures can
never disagree. This file only adds plain-language names and explanations.
"""
import base64
import html
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wiring as W  # noqa: E402

OUT = os.path.join(HERE, "..", "connection_guide.html")

# ---------------------------------------------------------------- nodes
# prefix = the *_PARTS / *_WIRES / *_NETS names in wiring.py
NODES = [
    dict(key="txw", prefixes=("TXW", "TX_WATER", "TXWATER"), svg="tx_water_wiring.svg",
         title="Underwater transmitter", mode="WATER",
         intro="ESP32 → RC filter + volume → XH-M542 amplifier (12 V) → exciter glued inside a waterproof PVC tube window.",
         safety=["Power the XH-M542 at 12 V only (about 15 W into the 4 Ω exciter). Never a 4S battery directly or 24 V.",
                 "The two OUT terminals both carry signal: never connect either one to GND.",
                 "Before the first power-on turn RV1 and the board's VOL knob fully down.",
                 "Connect the exciter first, then the input, power last. A small pop at switch-on is normal."]),
    dict(key="rxw", prefixes=("RXW", "RX_WATER", "RXWATER"), svg="rx_water_wiring.svg",
         title="Underwater receiver", mode="WATER",
         intro="Piezo hydrophone → two-stage LM358 preamp (gain 30–63 dB, band ≈1.5–10 kHz) → RC filter → ESP32 D34.",
         safety=["The LM358 is powered from the ESP32 VIN pin (≈5 V from USB). VREF and the filter use 3.3 V.",
                 "Check the LM358 notch / pin-1 dot before inserting it: turned around it gets hot.",
                 "Electrolytic capacitors: the stripe (−) side goes to GND.",
                 "Top + rail = VREF (1.34 V), not a power rail. Bottom + rail = +5 V from VIN. Both − rails = GND.",
                 "RV2 is the receiver volume: raise it if the tone bars stay low, lower it if the level shows clipping.",
                 "Keep the hydrophone cable away from the amplifier and its power wires."]),
    dict(key="tx", prefixes=("TX",), svg="tx_wiring.svg", title="Air transmitter", mode="AIR",
         intro="ESP32 → RC filter + volume → PAM8403 amplifier (5 V adapter) → small speaker.",
         safety=["Never connect a speaker wire to GND: use only L+ and L− (bridged output).",
                 "The 5 V adapter powers only the amplifier. The ESP32 runs from USB; only the grounds are joined.",
                 "Start with RV1 fully down, then raise it until the tones are loud but not harsh.",
                 "C3 1000 µF: stripe (−) side to the blue (−) rail."]),
    dict(key="rx", prefixes=("RX",), svg="rx_wiring.svg", title="Air receiver", mode="AIR",
         intro="MAX9814 microphone module → RC filter → ESP32 D34. The mic runs from a filtered 3.3 V (3V3A).",
         safety=["Only 3.3 V on this breadboard: never put 5 V on these rails.",
                 "C4 100 µF: stripe (−) side to the blue (−) rail.",
                 "MAX9814 pin order differs between boards: follow the printed labels.",
                 "If the level shows clipping at short range, tie GAIN to GND (50 dB) or VDD (40 dB)."]),
]

# ---------------------------------------------------------------- names
PIN_NAMES = {
    "ESP32.D25": "ESP32 D25 (GPIO25, tone output; left side, 8th from top)",
    "ESP32.D34": "ESP32 D34 (GPIO34, ADC input; left side, 4th from top)",
    "ESP32.3V3": "ESP32 3V3 (right side, bottom pin)",
    "ESP32.VIN": "ESP32 VIN (≈5 V from USB; left side, bottom pin)",
    "ESP32.GND_R": "ESP32 GND (right side, 2nd from bottom)",
    "ESP32.GND_L": "ESP32 GND (left side, 2nd from bottom)",
    "ESP32.GND": "ESP32 GND",
    "AMP.L": "PAM8403 L (left input)", "AMP.G": "PAM8403 G (input ground)", "AMP.R": "PAM8403 R (right input, unused)",
    "AMP.+5V": "PAM8403 +5V (power)", "AMP.GND": "PAM8403 GND (power)",
    "AMP.L+": "PAM8403 L+ (speaker out)", "AMP.L−": "PAM8403 L− (speaker out)",
    "AMP.R+": "PAM8403 R+ (unused)", "AMP.R−": "PAM8403 R− (unused)",
    "DC.+": "DC jack screw terminal +", "DC.−": "DC jack screw terminal −",
    "SPK.+": "Speaker +", "SPK.−": "Speaker −",
    "MIC.OUT": "MAX9814 OUT (audio)", "MIC.VDD": "MAX9814 VDD (power)", "MIC.GND": "MAX9814 GND",
    "MIC.GAIN": "MAX9814 GAIN (open = 60 dB)", "MIC.AR": "MAX9814 AR (attack/release, open)",
    "XH.IN+": "XH-M542 IN + (signal input)", "XH.IN−": "XH-M542 IN − (input ground)",
    "XH.VCC+": "XH-M542 VCC + (12 V)", "XH.VCC−": "XH-M542 VCC − (ground)",
    "XH.OUT+": "XH-M542 OUT + (to exciter)", "XH.OUT−": "XH-M542 OUT − (to exciter, never GND)",
    "DC12.+": "12 V adapter + (DC jack terminal)", "DC12.−": "12 V adapter − (DC jack terminal)",
    "EXC.+": "Exciter wire 1 (in the tube)", "EXC.−": "Exciter wire 2 (in the tube)",
    "HYD.HOT": "Hydrophone cable core (signal)", "HYD.SHIELD": "Hydrophone cable shield (braid)",
}
PIN_WORD = {"1": "leg 1", "2": "leg 2", "3": "leg 3", "+": "+ leg", "-": "− leg (stripe)"}
TRIM_WORD = {"1": "end pin", "2": "middle pin (wiper)", "3": "end pin"}
CHIP_PINS = {"1": "pin 1 (OUT A)", "2": "pin 2 (IN− A)", "3": "pin 3 (IN+ A)", "4": "pin 4 (GND)",
             "5": "pin 5 (IN+ B)", "6": "pin 6 (IN− B)", "7": "pin 7 (OUT B)", "8": "pin 8 (V+)"}

ROLE = {   # by reference, falls back to value-based text
    "R1": "Smooths the ESP32 square wave (with C1)", "C1": "Smoothing capacitor to GND (with R1)",
    "C2": "Blocks DC so the amplifier and speaker stay cool", "RV1": "Transmit volume",
    "C3": "Reservoir for the amplifier's 5 V supply", "R2": "With C4, filters the ESP32's 3.3 V for the mic",
    "C4": "Reservoir for the clean 3.3 V (3V3A)", "R3": "Anti-alias filter resistor; protects the ADC pin",
    "C5": "Anti-alias filter capacitor to GND",
    "U1": "LM358 dual op-amp: stage 1 (pins 1-3) and stage 2 (pins 5-7) of the preamp",
    "Cin": "Couples the hydrophone in, blocks DC", "Rs": "Input series resistor",
    "Rb": "Holds the input at VREF (1.34 V)", "Rf1": "Stage 1 feedback: sets gain ×31 (with Rg1)",
    "Cf1": "Stage 1: cuts noise above ≈10 kHz", "Rg1": "Stage 1 gain resistor",
    "Cg1": "Stage 1: cuts low hum (pumps, motors)", "RV2": "Receiver gain knob (stage 2, ×1–46)",
    "Cf2": "Stage 2: cuts very high noise", "Rg2": "Stage 2 gain resistor", "Cg2": "Stage 2: cuts low hum",
    "Ro": "Output resistor: anti-alias filter + protects the ESP32 pin", "Caa": "Anti-alias filter capacitor to GND",
    "Cd": "Decoupling for the LM358's +5 V (right at the chip)", "Rp": "With Cp, filters the ESP32's 3.3 V",
    "Cp": "Reservoir for the clean 3.3 V (3V3A)", "Rt": "VREF divider, top (from 3V3A)",
    "Rd": "VREF divider, bottom (to GND)", "Cv": "Keeps VREF steady",
}
ROLE_BY_HINT = [  # (substring in ref or value, role) for the underwater parts
    ("U1", "LM358 dual op-amp: stage 1 and stage 2 of the preamp"),
    ("Cin", "Couples the hydrophone in, blocks DC"), ("Rs", "Input series resistor"),
    ("Rb", "Holds the input at VREF (1.34 V)"), ("Rf1", "Stage 1 feedback: gain ×31"),
    ("Cf1", "Stage 1: cuts very high noise"), ("Rg1", "Stage 1 gain resistor"),
    ("Cg1", "Stage 1: cuts low hum (pumps, motors)"), ("RV2", "Receiver gain (stage 2, ×1–46)"),
    ("Cf2", "Stage 2: cuts very high noise"), ("Rg2", "Stage 2 gain resistor"),
    ("Cg2", "Stage 2: cuts low hum"), ("Ro", "Output resistor: filter + protects the ESP32 pin"),
    ("Caa", "Anti-alias filter capacitor"), ("Cdec", "Decoupling right at the LM358 power pin"),
]

NET_INFO = [  # (a pin in the net, name, colour, what it is)
    ("ESP32.D25", "Tone signal", "#e07b39", "Square wave from the ESP32, one tone per slot."),
    ("R1.2", "Smoothed tone", "#c9a227", "After R1/C1: sharp edges removed."),
    ("C2.2", "Tone without DC", "#1d9a6c", "After C2: only the audio, no DC."),
    ("RV1.2", "Volume-set tone", "#2a6fdb", "Wiper of RV1: goes to the amplifier input."),
    ("AMP.+5V", "+5 V amplifier power", "#d32f2f", "From the 5 V adapter, through the top + rail."),
    ("AMP.L+", "Speaker +", "#b4479a", "Amplifier output (bridged)."),
    ("AMP.L−", "Speaker −", "#7a4ac4", "Amplifier output (bridged), never GND."),
    ("ESP32.3V3", "3.3 V from ESP32", "#d32f2f", "Raw 3.3 V before the filter."),
    ("R2.2", "3V3A (clean 3.3 V)", "#e5534b", "Filtered 3.3 V on the top + rail."),
    ("MIC.OUT", "Mic audio", "#c9a227", "Audio from the MAX9814 (sits at ≈1.25 V)."),
    ("ESP32.D34", "Audio to ADC", "#1d9a6c", "Filtered audio into ESP32 GPIO34."),
    ("XH.VCC+", "+12 V amplifier power", "#d32f2f", "From the 12 V adapter straight to the XH-M542 (not through the breadboard)."),
    ("XH.OUT+", "Exciter wire 1", "#b4479a", "Amplifier output (bridged) through the 2-core cable."),
    ("XH.OUT−", "Exciter wire 2", "#7a4ac4", "Amplifier output (bridged): never connect to GND."),
    ("ESP32.VIN", "+5 V for the LM358", "#d32f2f", "From the ESP32 VIN pin (USB 5 V), on the bottom + rail."),
    ("Rp.2", "3V3A (clean 3.3 V)", "#e5534b", "ESP32 3.3 V after the 10 Ω / 100 µF filter; feeds the VREF divider."),
    ("Rt.2", "VREF ≈ 1.34 V", "#8e44ad", "The middle voltage the audio swings around. On the top + rail: NOT a power rail."),
    ("HYD.HOT", "Hydrophone signal", "#c9a227", "A few µV to mV from the piezo, straight from the cable core."),
    ("Cin.2", "Input after Cin", "#d4a017", "Hydrophone signal without DC, on its way to the LM358."),
    ("U1.3", "Stage 1 input (IN+ A)", "#e07b39", "Hydrophone signal sitting on VREF, into the first stage."),
    ("U1.2", "Stage 1 feedback (IN− A)", "#2a6fdb", "Sets stage 1 gain (Rf1 / Rg1) and its bandwidth."),
    ("U1.1", "Stage 1 out → stage 2 in", "#1d9a6c", "First stage output (×31), straight into the second stage."),
    ("Rg1.2", "Stage 1 hum cut (G1)", "#5b6ad0", "Between Rg1 and Cg1: removes low hum from the gain."),
    ("U1.6", "Stage 2 feedback (IN− B)", "#2a6fdb", "Sets stage 2 gain with RV2 / Rg2."),
    ("U1.7", "Stage 2 output (OUT B)", "#0a7c76", "Amplified audio (30–63 dB total) before the ADC filter."),
    ("Rg2.2", "Stage 2 hum cut (G2)", "#5b6ad0", "Between Rg2 and Cg2: removes low hum from the gain."),
]
GND_COLOR = "#3b4350"


def module_name(ref, pins):
    """Name an off-board module from its pins, so the XH-M542 is never called PAM8403."""
    p = {x.split(".", 1)[1].replace("−", "-") for x in pins}
    if ref == "ESP32":
        return "ESP32 DevKit V1"
    if {"L+", "L-"} & p or "+5V" in p:
        return "PAM8403 amplifier (5 V)"
    if {"IN+", "IN-", "VCC+", "VCC-"} & p or ref.upper().startswith(("XH", "TPA")):
        return "XH-M542 amplifier (TPA3116D2, 12 V)"
    if "OUT" in p and "VDD" in p and ("GAIN" in p or ref.upper() == "MIC"):
        return "MAX9814 mic module"
    u = ref.upper()
    if u.startswith(("EXC", "EX", "TUBE", "XDCR", "TRANS")):
        return "Exciter in the waterproof tube"
    if u.startswith(("HYD", "PZ", "PIEZO", "HP")):
        return "Piezo hydrophone (sealed)"
    if u.startswith("SPK"):
        return "Speaker"
    if u.startswith("DC12") or u.startswith("V12"):
        return "DC jack (12 V 3 A adapter)"
    if u.startswith(("DC", "ADP", "PSU")):
        return "DC jack (from the adapter)"
    return ref


def pin_name(pid, mods):
    if pid in PIN_NAMES and not pid.startswith("AMP."):
        return PIN_NAMES[pid]
    ref, pin = pid.split(".", 1)
    mname = module_name(ref, mods.get(ref, {pid}))
    if mname.startswith("PAM8403") and pid in PIN_NAMES:
        return PIN_NAMES[pid]
    short = mname.split(" (")[0]
    return f"{short} {pin}"


def find_data(prefixes):
    for p in prefixes:
        parts, wires, nets = (getattr(W, p + s, None) for s in ("_PARTS", "_WIRES", "_NETS"))
        if parts is not None and wires is not None and nets is not None:
            return parts, wires, nets
    return None


def hole_text(h):
    if h.startswith(("TR", "BR")):
        top = h.startswith("T")
        k, col = h[:3], h.split("-")[1]
        plus = k[2] == "1" if top else k[2] == "2"
        rail = ("top " if top else "bottom ") + ("+ rail (red line)" if plus else "− rail (blue line)")
        return f"{rail}, column {col}"
    row, col = h[0], h[1:]
    half = "abcde" if row in "abcde" else "fghij"
    return f"hole {h} (column {col}: {half[0]}{col}–{half[-1]}{col} are connected)"


def pin_label(ref, pn, kind):
    if ref in ("U1",) or kind in ("dip8", "chip", "ic", "opamp"):
        return CHIP_PINS.get(pn, "pin " + pn)
    if kind == "trimmer":
        return TRIM_WORD.get(pn, "pin " + pn)
    return PIN_WORD.get(pn, pn)


def role_of(ref, value):
    if ref in ROLE:
        return ROLE[ref]
    for hint, text in ROLE_BY_HINT:
        if ref.startswith(hint) or hint == ref:
            return text
    return ""


def node_data(cfg):
    found = find_data(cfg["prefixes"])
    if not found:
        return None
    parts, wires, nets = found
    kinds = {p[0]: p[1] for p in parts}
    hole_of = {}
    part_list = []
    for prt in parts:
        ref, kind, value, mark, pins = prt[:5]
        bands = mark if isinstance(mark, list) else None
        marking = "-".join(mark) if isinstance(mark, list) else (mark or "")
        plist = []
        for pn, hole in pins.items():
            pid = f"{ref}.{pn}"
            hole_of[pid] = hole
            plist.append(dict(id=pid, label=pin_label(ref, pn, kind), hole=hole, where=hole_text(hole)))
        part_list.append(dict(ref=ref, kind=kind, value=value, marking=marking, bands=bands or [],
                              role=role_of(ref, value), pins=plist, onboard=True))
    # off-board modules: collect their pins from wires + nets
    mods = {}
    for a, b, col, desc in wires:
        for e, other in ((a, b), (b, a)):
            if "." in e:
                mods.setdefault(e.split(".")[0], set()).add(e)
    for n in nets:
        for e in n:
            m = e.split(".")[0]
            if m not in kinds:
                mods.setdefault(m, set()).add(e)
    wire_of = {}
    for a, b, col, desc in wires:
        if "." in a:
            wire_of[a] = (b, col, desc)
        if "." in b:
            wire_of[b] = (a, col, desc)
    for m, pins in sorted(mods.items(), key=lambda kv: (kv[0] != "ESP32", kv[0])):
        mname = module_name(m, pins)
        plist = []
        for pid in sorted(pins):
            w = wire_of.get(pid)
            where = ""
            if w:
                to, col, desc = w
                where = ("wire (" + col + ") to " + (hole_text(to) if "." not in to else pin_name(to, mods)))
            plist.append(dict(id=pid, label=pin_name(pid, mods), hole="", where=where or "not connected"))
        part_list.append(dict(ref=m, kind="module", value=mname, marking="", bands=[],
                              role="Off the breadboard, joined with jumper wires", pins=plist, onboard=False))
    # nets
    net_list = []
    for i, n in enumerate(nets):
        members = sorted(n)
        if len(members) == 1:
            net_list.append(dict(id=f"n{i}", name="Not connected", color="#9aa4ae",
                                 desc="Leave this pin free.", pins=members, nc=True))
            continue
        name, color, desc = None, None, ""
        if any(m.startswith("ESP32.GND") for m in members) or any(m.endswith(".GND") for m in members):
            name, color, desc = "GND (common ground)", GND_COLOR, "Everything that must share one ground."
        for pin, nm, colr, d in NET_INFO:
            if name is None and pin in n:
                name, color, desc = nm, colr, d
        if name is None:
            name, color, desc = "Connection " + str(i + 1), "#5b6ad0", ""
        net_list.append(dict(id=f"n{i}", name=name, color=color, desc=desc, pins=members, nc=False))
    # checklist: parts first, then wires
    steps = []
    for p in part_list:
        if not p["onboard"]:
            continue
        legs = ", ".join(f"{q['label']} → {q['hole']}" for q in p["pins"])
        extra = f" ({p['marking']})" if p["marking"] else ""
        steps.append(dict(id="p:" + p["ref"], text=f"Insert {p['ref']} {p['value']}{extra}: {legs}"))
    for a, b, col, desc in wires:
        na = pin_name(a, mods) if "." in a else a
        nb = pin_name(b, mods) if "." in b else b
        steps.append(dict(id="w:" + a + ">" + b, text=f"Wire ({col}): {na} → {nb}  ·  {desc}"))
    svg_path = os.path.join(HERE, cfg["svg"])
    img = ""
    if os.path.exists(svg_path):
        img = "data:image/svg+xml;base64," + base64.b64encode(open(svg_path, "rb").read()).decode()
    return dict(key=cfg["key"], title=cfg["title"], mode=cfg["mode"], intro=cfg["intro"], safety=cfg["safety"],
                parts=part_list, nets=net_list, steps=steps, img=img, pinNames={**PIN_NAMES})


def main():
    nodes = [d for d in (node_data(c) for c in NODES) if d]
    missing = [c["title"] for c in NODES if not find_data(c["prefixes"])]
    page = TEMPLATE.replace("/*@@DATA@@*/", "const NODES = " + json.dumps(nodes, ensure_ascii=False) + ";")
    page = page.replace("@@MISSING@@", html.escape(", ".join(missing)))
    full = ('<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
            + page.replace("</style>\n<header>", "</style></head><body>\n<header>", 1) + '\n</body></html>\n')
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(full)
    if len(sys.argv) > 2 and sys.argv[1] == "--artifact":
        with open(sys.argv[2], "w", encoding="utf-8") as f:   # page content only; the viewer adds the skeleton
            f.write(page)
        print("wrote artifact page", sys.argv[2])
    print("wrote", os.path.normpath(OUT), "nodes:", ", ".join(n["title"] for n in nodes),
          ("(missing: " + ", ".join(missing) + ")") if missing else "")


TEMPLATE = r"""<title>DUBURI connection guide</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
:root { --bg:#f5f7fa; --panel:#fff; --ink:#1d2329; --muted:#5d6874; --line:#dfe4ea; --soft:#eef2f7;
  --accent:#0a7c76; --accent-soft:#dff1ef; --warn:#a86a0c; --warn-soft:#fbefd6; --bad:#c0362c; --bad-soft:#fbe1de;
  --sel:#fff4c2; --shadow:0 1px 2px rgba(20,30,40,.06),0 2px 10px rgba(20,30,40,.05); }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#0f1418; --panel:#171d23; --ink:#e3e8ee;
  --muted:#9aa6b2; --line:#2a333c; --soft:#1e262e; --accent:#2bb5ab; --accent-soft:#123532; --warn:#e3a23b;
  --warn-soft:#362710; --bad:#f0675b; --bad-soft:#3a1714; --sel:#3a3413; --shadow:none; color-scheme:dark; } }
:root[data-theme="dark"] { --bg:#0f1418; --panel:#171d23; --ink:#e3e8ee;
  --muted:#9aa6b2; --line:#2a333c; --soft:#1e262e; --accent:#2bb5ab; --accent-soft:#123532; --warn:#e3a23b;
  --warn-soft:#362710; --bad:#f0675b; --bad-soft:#3a1714; --sel:#3a3413; --shadow:none; color-scheme:dark; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",sans-serif; }
body::before { content:""; position:fixed; inset:0 0 auto; height:env(safe-area-inset-top, 0px); z-index:10; background:var(--panel); }
header { position:sticky; top:env(safe-area-inset-top, 0px); z-index:5; background:var(--panel); border-bottom:1px solid var(--line);
  padding-block:12px 0; padding-left:max(16px, env(safe-area-inset-left, 0px)); padding-right:max(16px, env(safe-area-inset-right, 0px)); }
h1 { margin:0; font-size:20px; } .sub { color:var(--muted); font-size:13px; margin:2px 0 10px; }
.tabs { display:flex; gap:6px; flex-wrap:wrap; }
.tab { border:1px solid var(--line); border-bottom:none; background:var(--soft); color:var(--ink); padding:8px 14px;
  border-radius:10px 10px 0 0; cursor:pointer; font:inherit; font-weight:600; }
.tab.on { background:var(--bg); border-color:var(--line); color:var(--accent); }
.tab .mode { font-size:11px; font-weight:700; margin-left:6px; padding:1px 6px; border-radius:6px; background:var(--accent-soft); color:var(--accent); }
main { padding-block:16px 40px; padding-left:max(16px, env(safe-area-inset-left, 0px)); padding-right:max(16px, env(safe-area-inset-right, 0px)); max-width:1500px; margin:0 auto; }
.tablewrap { overflow-x:auto; }
.tab:focus-visible, .btn:focus-visible, .part:focus-visible, .chip:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:14px 16px; box-shadow:var(--shadow); }
.grid { display:grid; grid-template-columns:minmax(0,1.25fr) minmax(0,1fr); gap:16px; align-items:start; }
@media (max-width: 1000px) { .grid { grid-template-columns:1fr; } }
h2 { font-size:16px; margin:0 0 8px; } h3 { font-size:14px; margin:12px 0 6px; }
.intro { margin:0 0 12px; }
.safety { background:var(--warn-soft); border:1px solid color-mix(in srgb,var(--warn) 35%,transparent); border-radius:12px; padding:10px 14px; margin-bottom:16px; }
.safety b { color:var(--warn); } .safety ul { margin:4px 0 0 18px; padding:0; }
.pic img { width:100%; height:auto; border:1px solid var(--line); border-radius:10px; background:#fff; cursor:zoom-in; display:block; }
.pic .hint { color:var(--muted); font-size:12px; margin-top:4px; }
.toolbar { display:flex; gap:8px; align-items:center; margin:0 0 10px; flex-wrap:wrap; }
input[type=search] { flex:1; min-width:180px; padding:8px 10px; border:1px solid var(--line); border-radius:9px; background:var(--panel); color:var(--ink); font:inherit; }
.btn { border:1px solid var(--line); background:var(--panel); color:var(--ink); border-radius:9px; padding:7px 12px; cursor:pointer; font:inherit; }
.btn:hover { border-color:var(--accent); }
.parts { display:flex; flex-direction:column; gap:6px; max-height:460px; overflow:auto; padding-right:4px; }
.part { border:1px solid var(--line); border-radius:10px; padding:7px 10px; cursor:pointer; display:grid; grid-template-columns:auto 1fr; gap:2px 10px; background:var(--panel); }
.part:hover { border-color:var(--accent); } .part.sel { background:var(--sel); border-color:var(--warn); }
.ref { font-weight:800; min-width:52px; } .val { font-weight:600; } .role { grid-column:2; color:var(--muted); font-size:13px; }
.mark { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12px; color:var(--muted); margin-left:6px; }
.bands { display:inline-flex; gap:2px; vertical-align:middle; margin-left:6px; } .bands i { width:7px; height:14px; border-radius:2px; display:inline-block; border:1px solid rgba(0,0,0,.15); }
.detail { margin-top:14px; } .detail table { width:100%; border-collapse:collapse; font-size:14px; }
.detail th, .detail td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
.detail th { color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.03em; }
.chip { display:inline-flex; align-items:center; gap:5px; border-radius:999px; padding:2px 9px; font-size:13px; margin:2px 4px 2px 0; border:1px solid var(--line); cursor:pointer; background:var(--soft); color:var(--ink); }
.chip i { width:9px; height:9px; border-radius:50%; display:inline-block; }
.chip:hover { border-color:var(--accent); }
.nets { display:grid; grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr)); gap:10px; }
.net { border:1px solid var(--line); border-left:6px solid; border-radius:10px; padding:9px 11px; background:var(--panel); }
.net.sel { background:var(--sel); } .net h4 { margin:0; font-size:14px; } .net p { margin:2px 0 6px; color:var(--muted); font-size:13px; }
.net li { font-size:13.5px; margin:2px 0; } .net ul { margin:0; padding-left:16px; }
.net .where { color:var(--muted); font-size:12px; }
.check { margin-top:16px; } .bar { height:8px; background:var(--soft); border-radius:6px; overflow:hidden; margin:6px 0 10px; }
.bar > div { height:100%; background:var(--accent); width:0; transition:width .2s; }
.steps { list-style:none; margin:0; padding:0; counter-reset:s; }
.steps li { display:flex; gap:10px; align-items:flex-start; padding:7px 4px; border-bottom:1px solid var(--line); counter-increment:s; }
.steps li::before { content:counter(s); min-width:22px; color:var(--muted); font-size:12px; padding-top:2px; text-align:right; }
.steps li.done span { color:var(--muted); text-decoration:line-through; }
.steps input { width:18px; height:18px; margin-top:2px; accent-color:var(--accent); }
.empty { color:var(--muted); font-style:italic; }
.missing { background:var(--soft); border:1px dashed var(--line); padding:8px 12px; border-radius:10px; color:var(--muted); font-size:13px; margin-bottom:12px; }
.zoom { position:fixed; inset:0; background:rgba(10,14,18,.85); display:none; z-index:20; overflow:auto; cursor:zoom-out; }
.zoom img { width:1800px; max-width:none; display:block; margin:20px auto; background:#fff; border-radius:8px; }
.sec { margin-top:16px; }
@media print { header { position:static; } .toolbar, .tabs .tab:not(.on), .zoom { display:none !important; } .parts { max-height:none; } }
</style>
<header>
  <h1>DUBURI connection guide</h1>
  <div class="sub">Click any part to see where each of its legs goes and what it connects to. Click a coloured connection to see everything on it. Tick the checklist as you build.</div>
  <nav class="tabs" id="tabs"></nav>
</header>
<main>
  <div class="missing" id="missing" hidden>Not in this file yet: @@MISSING@@ (their wiring pictures are still being drawn).</div>
  <div id="view"></div>
</main>
<div class="zoom" id="zoom"><img id="zoomImg" alt="wiring picture, full size"></div>
<script>
/*@@DATA@@*/
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const BAND = { black:"#1b1b1b", brown:"#7a4a24", red:"#d32f2f", orange:"#f57c00", yellow:"#f9d71c", green:"#2e7d32",
  blue:"#1565c0", violet:"#7b1fa2", grey:"#8e8e8e", gray:"#8e8e8e", white:"#fafafa", gold:"#c9a227", silver:"#b0b0b0" };
let cur = 0, selPart = null, selNet = null, query = "";
const store = { get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (_) { return null; } },
                set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* private mode */ } } };

function tabs() {
  $("tabs").innerHTML = NODES.map((n, i) => `<button class="tab ${i === cur ? "on" : ""}" data-i="${i}">${esc(n.title)}<span class="mode">${n.mode}</span></button>`).join("");
  for (const b of document.querySelectorAll(".tab")) b.onclick = () => { cur = +b.dataset.i; selPart = selNet = null; query = ""; store.set("duburi-tab", cur); render(); };
}
function node() { return NODES[cur]; }
function partOf(pid) { const ref = pid.split(".")[0]; return node().parts.find((p) => p.ref === ref); }
function pinInfo(pid) { for (const p of node().parts) { const q = p.pins.find((x) => x.id === pid); if (q) return { part: p, pin: q }; } return null; }
function netOf(pid) { return node().nets.find((n) => n.pins.includes(pid)); }
function pinName(pid) {
  const pi = pinInfo(pid); if (!pi) return pid;
  return pi.part.onboard ? `${pi.part.ref} ${pi.pin.label}` : pi.pin.label;
}
function chip(pid) {
  const n = netOf(pid);
  return `<span class="chip" data-part="${esc(pid.split(".")[0])}"><i style="background:${n ? n.color : "#999"}"></i>${esc(pinName(pid))}</span>`;
}
function bands(p) { return p.bands.length ? `<span class="bands">${p.bands.map((b) => `<i style="background:${BAND[b] || "#ccc"}"></i>`).join("")}</span>` : ""; }

function render() {
  tabs();
  const n = node();
  const q = query.toLowerCase();
  const matchP = (p) => !q || (p.ref + " " + p.value + " " + p.role + " " + p.marking + " " + p.pins.map((x) => x.label).join(" ")).toLowerCase().includes(q);
  const matchN = (x) => !q || (x.name + " " + x.desc + " " + x.pins.map(pinName).join(" ")).toLowerCase().includes(q);
  const done = new Set(store.get("duburi-steps-" + n.key) || []);
  $("view").innerHTML = `
    <p class="intro">${esc(n.intro)}</p>
    <div class="safety"><b>Before you power it</b><ul>${n.safety.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>
    <div class="grid">
      <div class="card pic"><h2>Wiring picture</h2>${n.img ? `<img id="pic" src="${n.img}" alt="${esc(n.title)} wiring picture">
        <div class="hint">Click the picture to see it full size.</div>` : `<p class="empty">Picture not available yet.</p>`}</div>
      <div class="card">
        <h2>Parts</h2>
        <div class="toolbar"><input type="search" id="q" placeholder="Search: LM358, GND, D34, 10k…" value="${esc(query)}"></div>
        <div class="parts">${n.parts.filter(matchP).map((p) => `
          <div class="part ${selPart === p.ref ? "sel" : ""}" data-ref="${esc(p.ref)}">
            <span class="ref">${esc(p.ref)}</span><span class="val">${esc(p.value)}${p.marking && !p.bands.length ? `<span class="mark">“${esc(p.marking)}”</span>` : ""}${bands(p)}</span>
            <span class="role">${esc(p.role)}</span></div>`).join("") || `<p class="empty">No part matches.</p>`}</div>
        <div class="detail" id="detail">${detail()}</div>
      </div>
    </div>
    <div class="card sec"><h2>Connections</h2>
      <div class="nets">${n.nets.filter(matchN).map((x) => `
        <div class="net ${selNet === x.id ? "sel" : ""}" style="border-left-color:${x.color}" data-net="${x.id}">
          <h4>${esc(x.name)}</h4>${x.desc ? `<p>${esc(x.desc)}</p>` : ""}
          <ul>${x.pins.map((pid) => { const pi = pinInfo(pid); const w = pi ? (pi.pin.hole || pi.pin.where) : "";
            return `<li>${chip(pid)} <span class="where">${esc(w)}</span></li>`; }).join("")}</ul></div>`).join("") || `<p class="empty">No connection matches.</p>`}</div>
    </div>
    <div class="card sec check"><h2>Build checklist <span style="font-weight:400;color:var(--muted);font-size:13px">(power off while wiring)</span></h2>
      <div class="bar"><div id="bar"></div></div><div id="count" style="font-size:13px;color:var(--muted)"></div>
      <ol class="steps">${n.steps.map((s) => `<li class="${done.has(s.id) ? "done" : ""}"><input type="checkbox" data-step="${esc(s.id)}" ${done.has(s.id) ? "checked" : ""}><span>${esc(s.text)}</span></li>`).join("")}
        <li><input type="checkbox" disabled><span>Check every connection against the list above, then power up with the volume knobs at minimum.</span></li></ol>
      <div class="toolbar" style="margin-top:10px"><button class="btn" id="reset">Clear ticks</button></div>
    </div>`;
  wire();
  progress();
}
function detail() {
  const n = node();
  if (selNet) {
    const x = n.nets.find((k) => k.id === selNet);
    return `<h3><span class="chip"><i style="background:${x.color}"></i>${esc(x.name)}</span></h3><p style="margin:0 0 6px;color:var(--muted)">${esc(x.desc)}</p>
      <div class="tablewrap"><table><tr><th>Pin</th><th>Where</th></tr>${x.pins.map((pid) => { const pi = pinInfo(pid);
        return `<tr><td>${chip(pid)}</td><td>${esc(pi ? (pi.pin.where || "") : "")}</td></tr>`; }).join("")}</table></div>`;
  }
  if (!selPart) return `<p class="empty">Click a part above to see its legs and connections.</p>`;
  const p = n.parts.find((k) => k.ref === selPart);
  return `<h3>${esc(p.ref)} · ${esc(p.value)} ${p.marking ? `<span class="mark">${esc(p.marking)}</span>` : ""}</h3>
    ${p.role ? `<p style="margin:0 0 6px;color:var(--muted)">${esc(p.role)}</p>` : ""}
    <div class="tablewrap"><table><tr><th>Leg / pin</th><th>Goes to</th><th>Connected with</th></tr>${p.pins.map((q) => {
      const x = netOf(q.id); const others = x ? x.pins.filter((o) => o !== q.id) : [];
      return `<tr><td><b>${esc(q.label)}</b></td><td>${esc(q.where)}</td><td>${x && !x.nc ? `<span class="chip" data-net="${x.id}"><i style="background:${x.color}"></i>${esc(x.name)}</span><br>` : ""}${others.length ? others.map(chip).join("") : `<span class="empty">nothing (leave free)</span>`}</td></tr>`;
    }).join("")}</table></div>`;
}
function wire() {
  for (const el of document.querySelectorAll(".part")) el.onclick = () => { selPart = el.dataset.ref; selNet = null; render(); };
  for (const el of document.querySelectorAll("[data-net]")) el.onclick = (e) => { e.stopPropagation(); selNet = el.dataset.net; selPart = null; render(); $("detail").scrollIntoView({ block: "nearest" }); };
  for (const el of document.querySelectorAll(".chip[data-part]")) el.onclick = (e) => { e.stopPropagation(); selPart = el.dataset.part; selNet = null; render(); $("detail").scrollIntoView({ block: "nearest" }); };
  const qi = $("q"); if (qi) qi.oninput = (e) => { query = e.target.value; const pos = e.target.selectionStart; render(); const q2 = $("q"); q2.focus(); q2.setSelectionRange(pos, pos); };
  for (const el of document.querySelectorAll("input[data-step]")) el.onchange = () => {
    const k = "duburi-steps-" + node().key, s = new Set(store.get(k) || []);
    el.checked ? s.add(el.dataset.step) : s.delete(el.dataset.step); store.set(k, [...s]);
    el.closest("li").classList.toggle("done", el.checked); progress();
  };
  const r = $("reset"); if (r) r.onclick = () => { store.set("duburi-steps-" + node().key, []); render(); };
  const pic = $("pic"); if (pic) pic.onclick = () => { $("zoomImg").src = pic.src; $("zoom").style.display = "block"; };
}
function progress() {
  const boxes = [...document.querySelectorAll("input[data-step]")], d = boxes.filter((b) => b.checked).length;
  $("bar").style.width = (boxes.length ? (100 * d / boxes.length) : 0) + "%";
  $("count").textContent = `${d} of ${boxes.length} steps done`;
}
$("zoom").onclick = () => { $("zoom").style.display = "none"; };
const saved = store.get("duburi-tab"); if (Number.isInteger(saved) && saved < NODES.length) cur = saved;
if ("@@MISSING@@".trim() && !"@@MISSING@@".startsWith("@@")) $("missing").hidden = false;
render();
</script>
"""

if __name__ == "__main__":
    main()
