"""
wiring.py - draws the breadboard wiring diagrams for the DUBURI air-acoustic
text modem and checks that every drawn connection matches the circuit.

    python3 docs/wiring/wiring.py

Writes (next to this file):
    tx_wiring.svg / .png        transmitter node (PC 1 side)
    rx_wiring.svg / .png        receiver node (PC 2 side)
    system_overview.svg / .png  the whole link
    placement.md                part-by-part hole list + wire list

The PNGs are rendered with Playwright Chromium (node `require('playwright')`).
If that is not available the SVGs are still written.

Every part leg, wire end and module pin is placed from the PLACEMENT data below.
Before drawing, the script rebuilds the connectivity (breadboard strips, rails,
wires, part pins) and compares it with the expected netlist of the circuit. Any
mismatch, two legs in one hole, or a leg in a rail position that has no hole
stops the script with an error.
"""
import json
import math
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))

P = 22.0                     # one breadboard pitch (2.54 mm) in px
FONT = "DejaVu Sans, Liberation Sans, Arial, sans-serif"
MONO = "DejaVu Sans Mono, Liberation Mono, monospace"

ROWS_TOP = "abcde"
ROWS_BOT = "fghij"
NCOLS = 30
RAIL_MISSING = {1, 7, 13, 19, 25}          # 400-point board: rail holes in groups of 5

BAND = {"black": "#1b1b1b", "brown": "#7a4a24", "red": "#d32f2f", "orange": "#f57c00",
        "yellow": "#f9c623", "green": "#388e3c", "blue": "#1976d2", "violet": "#7b1fa2",
        "grey": "#9e9e9e", "white": "#fafafa", "gold": "#c8a24a"}

WIRE = {"red": ("#e53935", "#9e1f1c"), "black": ("#2e2e2e", "#0d0d0d"),
        "orange": ("#f39c12", "#a86400"), "yellow": ("#f7d438", "#a68a10"),
        "green": ("#2fb35a", "#16733a"), "blue": ("#1e63c6", "#0f3a7a"),
        "grey": ("#505860", "#24282c")}


# ===========================================================================
# Small SVG helpers
# ===========================================================================
def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


class Svg:
    LAYERS = ("bg", "board", "under", "legs", "parts", "wires", "top", "labels")

    def __init__(self, w, h):
        self.w, self.h = w, h
        self.L = {k: [] for k in self.LAYERS}
        self.defs = []

    def add(self, layer, s):
        self.L[layer].append(s)

    def rect(self, layer, x, y, w, h, fill, stroke="none", sw=1.0, rx=0.0, extra=""):
        self.add(layer, f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="{rx:.1f}" '
                        f'fill="{fill}" stroke="{stroke}" stroke-width="{sw}" {extra}/>')

    def circle(self, layer, cx, cy, r, fill, stroke="none", sw=1.0, extra=""):
        self.add(layer, f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}" fill="{fill}" '
                        f'stroke="{stroke}" stroke-width="{sw}" {extra}/>')

    def line(self, layer, x1, y1, x2, y2, stroke, sw=1.0, extra=""):
        self.add(layer, f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
                        f'stroke="{stroke}" stroke-width="{sw}" stroke-linecap="round" {extra}/>')

    def path(self, layer, d, fill="none", stroke="none", sw=1.0, extra=""):
        self.add(layer, f'<path d="{d}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}" '
                        f'stroke-linejoin="round" stroke-linecap="round" {extra}/>')

    def text(self, layer, x, y, s, size=12, fill="#222", anchor="start", weight="normal",
             family=FONT, extra=""):
        self.add(layer, f'<text x="{x:.1f}" y="{y:.1f}" font-family="{family}" font-size="{size}" '
                        f'fill="{fill}" text-anchor="{anchor}" font-weight="{weight}" {extra}>{esc(s)}</text>')

    def svg(self):
        body = "\n".join(s for k in self.LAYERS for s in self.L[k])
        return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" height="{self.h}" '
                f'viewBox="0 0 {self.w} {self.h}">\n<defs>{"".join(self.defs)}</defs>\n'
                f'<rect width="100%" height="100%" fill="#ffffff"/>\n{body}\n</svg>\n')


def rounded_path(pts, r=12.0):
    """Polyline through pts with rounded corners (radius r)."""
    clean = [pts[0]]
    for q in pts[1:]:
        if math.hypot(q[0] - clean[-1][0], q[1] - clean[-1][1]) > 0.5:
            clean.append(q)
    pts = clean
    if len(pts) < 2:
        return ""
    d = f"M {pts[0][0]:.1f} {pts[0][1]:.1f}"
    for i in range(1, len(pts) - 1):
        x0, y0 = pts[i - 1]
        x1, y1 = pts[i]
        x2, y2 = pts[i + 1]
        l1 = math.hypot(x1 - x0, y1 - y0)
        l2 = math.hypot(x2 - x1, y2 - y1)
        rr = min(r, l1 / 2, l2 / 2)
        ax, ay = x1 - (x1 - x0) / l1 * rr, y1 - (y1 - y0) / l1 * rr
        bx, by = x1 + (x2 - x1) / l2 * rr, y1 + (y2 - y1) / l2 * rr
        d += f" L {ax:.1f} {ay:.1f} Q {x1:.1f} {y1:.1f} {bx:.1f} {by:.1f}"
    d += f" L {pts[-1][0]:.1f} {pts[-1][1]:.1f}"
    return d


def orth(start, moves, end=None):
    """Orthogonal route: moves = [('h', x) | ('v', y) | (x, y)]."""
    pts = [start]
    x, y = start
    for m in moves:
        if m[0] == "h":
            x = m[1]
        elif m[0] == "v":
            y = m[1]
        else:
            x, y = m
        pts.append((x, y))
    if end is not None:
        pts.append(end)
    return pts


# ===========================================================================
# Breadboard (400 points)
# ===========================================================================
class Breadboard:
    def __init__(self, x, y):
        self.x, self.y = x, y
        self.w = (NCOLS + 2.4) * P
        self.h = 18.2 * P
        self.ry = {"TR1": 1.0, "TR2": 2.0, "BR1": 16.2, "BR2": 17.2}
        for i, r in enumerate(ROWS_TOP):
            self.ry[r] = 3.6 + i
        for i, r in enumerate(ROWS_BOT):
            self.ry[r] = 10.6 + i

    def cx(self, col):
        return self.x + (col + 0.7) * P

    def rowy(self, row):
        return self.y + self.ry[row] * P

    @staticmethod
    def parse(h):
        """'c4' -> ('c', 4); 'TR2-8' -> ('TR2', 8)."""
        if "-" in h:
            r, c = h.split("-")
            return r, int(c)
        return h[0], int(h[1:])

    def valid(self, h):
        r, c = self.parse(h)
        if not 1 <= c <= NCOLS:
            return False
        if r in ("TR1", "TR2", "BR1", "BR2"):
            return c not in RAIL_MISSING
        return r in ROWS_TOP + ROWS_BOT

    def node(self, h):
        """Electrical node of a hole (strip or rail)."""
        r, c = self.parse(h)
        if r in ("TR1", "TR2", "BR1", "BR2"):
            return "rail:" + r
        return ("top:" if r in ROWS_TOP else "bot:") + str(c)

    def xy(self, h):
        r, c = self.parse(h)
        return self.cx(c), self.rowy(r)

    def draw(self, s):
        x, y, w, h = self.x, self.y, self.w, self.h
        s.rect("board", x + 3, y + 5, w, h, "#000", rx=8, extra='opacity="0.10"')
        s.rect("board", x, y, w, h, "#f4f3ef", "#cfcdc6", 1.2, rx=8)
        # centre channel
        s.rect("board", x + 0.5 * P, y + 8.55 * P, w - P, 1.1 * P, "#e2e0d9", "#d3d1ca", 0.8, rx=3)
        # rail stripes
        def stripe(yy, col):
            s.line("board", x + 1.2 * P, yy, x + w - 1.2 * P, yy, col, 2.2)
        stripe(self.rowy("TR1") - 0.62 * P, "#d93a32")
        stripe(self.rowy("TR2") + 0.55 * P, "#2f62c9")
        stripe(self.rowy("BR1") - 0.55 * P, "#2f62c9")
        stripe(self.rowy("BR2") + 0.62 * P, "#d93a32")
        for yy, sym, colr in ((self.rowy("TR1"), "+", "#d93a32"), (self.rowy("TR2"), "−", "#2f62c9"),
                              (self.rowy("BR1"), "−", "#2f62c9"), (self.rowy("BR2"), "+", "#d93a32")):
            s.text("board", x + 0.55 * P, yy + 5, sym, 15, colr, "middle", "bold")
            s.text("board", x + w - 0.55 * P, yy + 5, sym, 15, colr, "middle", "bold")
        # holes
        def hole(hx, hy):
            s.rect("board", hx - 3.6, hy - 3.6, 7.2, 7.2, "#3a3a3a", rx=1.4)
        for c in range(1, NCOLS + 1):
            for r in ROWS_TOP + ROWS_BOT:
                hole(self.cx(c), self.rowy(r))
            if c not in RAIL_MISSING:
                for r in ("TR1", "TR2", "BR1", "BR2"):
                    hole(self.cx(c), self.rowy(r))
        # numbers and letters
        for c in range(1, NCOLS + 1):
            fs = 8.5 if c % 5 else 9.5
            wt = "normal" if c % 5 else "bold"
            s.text("board", self.cx(c), y + 3.02 * P, str(c), fs, "#8a877f", "middle", wt)
            s.text("board", self.cx(c), y + 15.55 * P, str(c), fs, "#8a877f", "middle", wt)
        for r in ROWS_TOP + ROWS_BOT:
            s.text("board", x + 0.6 * P, self.rowy(r) + 3.5, r, 10, "#8a877f", "middle")
            s.text("board", x + w - 0.6 * P, self.rowy(r) + 3.5, r, 10, "#8a877f", "middle")


# ===========================================================================
# Parts on the breadboard
# ===========================================================================
def leg(s, x1, y1, x2, y2):
    s.line("legs", x1, y1, x2, y2, "#8d9399", 2.4)
    s.circle("legs", x2, y2, 2.6, "#c7ccd1", "#6f757b", 0.8)


def resistor(s, p1, p2, bands):
    (x1, y1), (x2, y2) = p1, p2
    L = math.hypot(x2 - x1, y2 - y1)
    ang = math.degrees(math.atan2(y2 - y1, x2 - x1))
    bl = min(2.75 * P, L - 16)
    mx, my = (x1 + x2) / 2, (y1 + y2) / 2
    ux, uy = (x2 - x1) / L, (y2 - y1) / L
    leg(s, mx - ux * bl / 2, my - uy * bl / 2, x1, y1)
    leg(s, mx + ux * bl / 2, my + uy * bl / 2, x2, y2)
    g = [f'<g transform="translate({mx:.1f} {my:.1f}) rotate({ang:.1f})">']
    h, he = 0.56 * P, 0.74 * P
    e = bl * 0.2
    d = (f"M {-bl/2:.1f} 0 C {-bl/2:.1f} {-he/2:.1f} {-bl/2+e:.1f} {-he/2:.1f} {-bl/2+e:.1f} {-h/2:.1f} "
         f"L {bl/2-e:.1f} {-h/2:.1f} C {bl/2-e:.1f} {-he/2:.1f} {bl/2:.1f} {-he/2:.1f} {bl/2:.1f} 0 "
         f"C {bl/2:.1f} {he/2:.1f} {bl/2-e:.1f} {he/2:.1f} {bl/2-e:.1f} {h/2:.1f} "
         f"L {-bl/2+e:.1f} {h/2:.1f} C {-bl/2+e:.1f} {he/2:.1f} {-bl/2:.1f} {he/2:.1f} {-bl/2:.1f} 0 Z")
    g.append(f'<path d="{d}" fill="#e7cf9c" stroke="#a88a55" stroke-width="1"/>')
    for i, b in enumerate(bands):
        bx = -bl / 2 + bl * (0.2 + 0.15 * i) if i < 3 else bl / 2 - bl * 0.2
        g.append(f'<rect x="{bx - 2.6:.1f}" y="{-he/2 + 0.6:.1f}" width="5.2" height="{he - 1.2:.1f}" '
                 f'fill="{BAND[b]}"/>')
    g.append(f'<rect x="{-bl/2 + 6:.1f}" y="{-h/2 + 1.5:.1f}" width="{bl - 12:.1f}" height="2.2" '
             f'fill="#fff" opacity="0.35" rx="1"/>')
    g.append("</g>")
    s.add("parts", "".join(g))


def disc_cap(s, p1, p2, mark):
    (x1, y1), (x2, y2) = p1, p2
    mx, my = (x1 + x2) / 2 + 9, (y1 + y2) / 2
    r = 0.56 * P
    leg(s, mx - 4, my, x1, y1)
    leg(s, mx - 4, my, x2, y2)
    s.circle("parts", mx, my, r, "#e1a23a", "#9a6614", 1.1)
    s.circle("parts", mx - 3, my - 3, r * 0.45, "#fff", extra='opacity="0.18"')
    s.text("parts", mx, my + 3, mark, 8.5, "#3b2606", "middle", "bold")


def mlcc(s, p1, p2, mark):
    (x1, y1), (x2, y2) = p1, p2
    mx, my = (x1 + x2) / 2, (y1 + y2) / 2
    leg(s, mx - 9, my, x1, y1)
    leg(s, mx + 9, my, x2, y2)
    s.rect("parts", mx - 12, my - 9, 24, 18, "#2f6db5", "#1b4478", 1.1, rx=6)
    s.text("parts", mx, my + 3.5, mark, 9, "#ffffff", "middle", "bold")


def electrolytic(s, p_plus, p_minus, label, bw=30.0, bh=52.0, side=1):
    """Radial cap standing above the top rails, legs bent into TR1 (+) / TR2 (-)."""
    (xp, yp), (xm, ym) = p_plus, p_minus
    cx = xp + side * 0.9 * P
    yb = min(yp, ym) - 1.25 * P          # body bottom, just above the board edge
    x0, y0 = cx - bw / 2, yb - bh
    # legs
    s.line("legs", cx - 6, yb, xp, yp, "#8d9399", 2.4)
    s.circle("legs", xp, yp, 2.6, "#c7ccd1", "#6f757b", 0.8)
    s.path("legs", f"M {cx+6:.1f} {yb:.1f} L {xp + side*8:.1f} {yp + 6:.1f} L {xm:.1f} {ym:.1f}",
           stroke="#8d9399", sw=2.4)
    s.circle("legs", xm, ym, 2.6, "#c7ccd1", "#6f757b", 0.8)
    gid = "elg%d" % len(s.defs)
    s.defs.append(f'<linearGradient id="{gid}" x1="0" x2="1"><stop offset="0" stop-color="#1c2a52"/>'
                  f'<stop offset="0.45" stop-color="#3a5296"/><stop offset="1" stop-color="#16213f"/>'
                  f'</linearGradient>')
    s.rect("parts", x0, y0, bw, bh, f"url(#{gid})", "#0f1730", 1.0, rx=4)
    s.rect("parts", x0 + bw - 9, y0 + 1, 8, bh - 2, "#c9ccd6", rx=2)
    for k in range(3):
        s.text("parts", x0 + bw - 5, y0 + 15 + k * 14, "−", 10, "#16213f", "middle", "bold")
    s.add("parts", f'<ellipse cx="{cx:.1f}" cy="{y0 + 2:.1f}" rx="{bw/2 - 1:.1f}" ry="4" fill="#b8bec8" '
                   f'stroke="#7b818c" stroke-width="0.8"/>')
    s.text("parts", x0 + 4, y0 + bh / 2 + 3, "+", 11, "#f2f2f2", "start", "bold")
    return (cx, y0, bw, bh)


def trimmer(s, pins):
    """Blue multi-turn trimmer (3296W style); pins = [(x,y)]*3 in one row."""
    xs = [p[0] for p in pins]
    yp = pins[0][1]
    x0, x1 = min(xs) - 0.78 * P, max(xs) + 0.78 * P
    y1 = yp - 0.32 * P
    y0 = y1 - 1.45 * P
    for (x, y) in pins:
        s.line("legs", x, y1 - 2, x, y, "#8d9399", 2.6)
        s.circle("legs", x, y, 2.6, "#c7ccd1", "#6f757b", 0.8)
    s.rect("parts", x0 + 2, y0 + 3, x1 - x0, y1 - y0, "#000", rx=3, extra='opacity="0.15"')
    s.rect("parts", x0, y0, x1 - x0, y1 - y0, "#2b6fd6", "#163f80", 1.1, rx=3)
    s.rect("parts", x0 + 3, y0 + 2.5, x1 - x0 - 6, 3, "#fff", rx=1.5, extra='opacity="0.25"')
    sx, sy = x0 + 10, (y0 + y1) / 2
    s.circle("parts", sx, sy, 6.5, "#d8b25a", "#8c6a1f", 1)
    s.line("parts", sx - 4.2, sy - 2, sx + 4.2, sy + 2, "#6d5014", 1.6)
    s.text("parts", (x0 + x1) / 2 + 6, sy + 3.5, "103", 9, "#ffffff", "middle", "bold")
    return (x0, y0, x1, y1)


# ===========================================================================
# Off-board parts
# ===========================================================================
def esp32(s, x0, y0, highlight=()):
    """ESP32 DevKit V1 (DOIT, 30 pin). Returns dict pin -> (x, y)."""
    W, H = 11.2 * P, 20.3 * P
    left = ["EN", "VP", "VN", "D34", "D35", "D32", "D33", "D25", "D26", "D27", "D14", "D12", "D13",
            "GND", "VIN"]
    right = ["D23", "D22", "TX0", "RX0", "D21", "D19", "D18", "D5", "TX2", "RX2", "D4", "D2", "D15",
             "GND", "3V3"]
    s.rect("parts", x0 + 4, y0 + 6, W, H, "#000", rx=10, extra='opacity="0.13"')
    s.rect("parts", x0, y0, W, H, "#1c232c", "#0b0f14", 1.4, rx=10)
    # module
    mx0, mx1 = x0 + 2.05 * P, x0 + 9.15 * P
    s.rect("parts", mx0, y0 + 0.25 * P, mx1 - mx0, 10.3 * P, "#262b33", "#111", 1, rx=3)
    zig = []
    for k in range(9):
        xx = mx0 + 0.6 * P + k * (mx1 - mx0 - 1.2 * P) / 8
        zig.append((xx, y0 + (0.65 if k % 2 == 0 else 2.0) * P))
    s.path("parts", "M " + " L ".join(f"{a:.1f} {b:.1f}" for a, b in zig), stroke="#c9a54a", sw=2)
    gid = "can%d" % len(s.defs)
    s.defs.append(f'<linearGradient id="{gid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" '
                  f'stop-color="#e6e8eb"/><stop offset="0.6" stop-color="#b9bec5"/><stop offset="1" '
                  f'stop-color="#9aa0a8"/></linearGradient>')
    s.rect("parts", mx0 + 0.25 * P, y0 + 2.75 * P, mx1 - mx0 - 0.5 * P, 7.55 * P, f"url(#{gid})",
           "#80868e", 1, rx=2)
    s.text("parts", (mx0 + mx1) / 2, y0 + 6.0 * P, "ESP-WROOM-32", 10.5, "#4a5058", "middle", "bold")
    s.text("parts", (mx0 + mx1) / 2, y0 + 7.0 * P, "Wi-Fi + BT", 9, "#5a6068", "middle")
    # lower board parts
    cxm = x0 + W / 2
    s.rect("parts", cxm - 0.9 * P, y0 + 12.4 * P, 1.8 * P, 1.8 * P, "#15181c", "#000", 1, rx=1)
    s.text("parts", cxm, y0 + 13.45 * P, "CP2102", 6.5, "#9aa0a8", "middle")
    s.text("parts", cxm, y0 + 15.5 * P, "ESP32 DEVKIT V1", 8.5, "#d7dce2", "middle", "bold")
    s.rect("parts", cxm - 1.2 * P, y0 + 16.2 * P, 2.4 * P, 0.9 * P, "#15181c", rx=1)
    s.circle("parts", x0 + 3.2 * P, y0 + 14.2 * P, 3, "#ff4d4d")
    s.circle("parts", x0 + 8.0 * P, y0 + 14.2 * P, 3, "#4da3ff")
    for bx, lab in ((x0 + 2.9 * P, "EN"), (x0 + 8.3 * P, "BOOT")):
        s.rect("parts", bx - 0.75 * P, y0 + 17.65 * P, 1.5 * P, 1.5 * P, "#d4d7db", "#777", 1, rx=2)
        s.circle("parts", bx, y0 + 18.4 * P, 0.42 * P, "#2a2d31")
        s.text("parts", bx, y0 + 17.45 * P, lab, 7.5, "#d7dce2", "middle", "bold")
    # micro USB
    s.rect("parts", cxm - 1.05 * P, y0 + 19.45 * P, 2.1 * P, 1.35 * P, "#c3c8ce", "#7a8087", 1.1, rx=2)
    s.rect("parts", cxm - 0.7 * P, y0 + 19.75 * P, 1.4 * P, 0.45 * P, "#3a3f45", rx=1)
    pins = {}
    for col, names, xx, anchor, dx in ((0, left, x0 + 0.6 * P, "start", 0.62 * P),
                                       (1, right, x0 + 10.6 * P, "end", -0.62 * P)):
        for i, nm in enumerate(names):
            yy = y0 + (3.4 + i) * P
            hl = nm in highlight
            s.rect("parts", xx - 5.5, yy - 5.5, 11, 11, "#d8a62a", "#8a6510", 0.8, rx=1.5)
            s.circle("parts", xx, yy, 2.4, "#3a2b05")
            s.text("parts", xx + dx, yy + 3.4, nm, 9 if not hl else 9.5,
                   "#ffe680" if hl else "#e9edf1", anchor, "bold")
            key = nm if nm != "GND" else ("GND_L" if col == 0 else "GND_R")
            pins[key] = (xx, yy)
    pins["USB"] = (cxm, y0 + 20.8 * P)
    return pins


def laptop(s, x, y, title, lines, w=300.0, port_side="right"):
    h = 0.62 * w
    s.rect("parts", x + 4, y + 6, w, h, "#000", rx=10, extra='opacity="0.12"')
    s.rect("parts", x, y, w, h, "#2b2f36", "#15181c", 1.2, rx=10)
    sx, sy, sw_, sh = x + 12, y + 12, w - 24, h - 24
    s.rect("parts", sx, sy, sw_, sh, "#f7f9fc", rx=3)
    s.rect("parts", sx, sy, sw_, 18, "#dfe5ee", rx=3)
    for k, c in enumerate(("#ff5f57", "#febc2e", "#28c840")):
        s.circle("parts", sx + 10 + k * 11, sy + 9, 3.6, c)
    s.rect("parts", sx + 44, sy + 4, sw_ - 54, 10, "#ffffff", rx=5)
    s.text("parts", sx + 50, sy + 12, title, 7.5, "#5a6472", "start", family=MONO)
    for k, (txt, size, col, wt) in enumerate(lines):
        s.text("parts", sx + 12, sy + 40 + k * 21, txt, size, col, "start", wt,
               family=MONO if k else FONT)
    # base
    s.path("parts", f"M {x - 22:.1f} {y + h + 2:.1f} L {x + w + 22:.1f} {y + h + 2:.1f} "
                    f"L {x + w + 8:.1f} {y + h + 20:.1f} L {x - 8:.1f} {y + h + 20:.1f} Z",
           fill="#c9ced6", stroke="#8e959f", sw=1.2)
    s.rect("parts", x + w / 2 - 34, y + h + 4, 68, 5, "#a8afba", rx=2)
    port = (x + w + 15, y + h + 11) if port_side == "right" else (x - 15, y + h + 11)
    s.rect("parts", port[0] - 3, port[1] - 3, 7, 6, "#555b63", rx=1)
    return port


def usb_cable(s, pts):
    d = rounded_path(pts, 22)
    s.path("wires", d, stroke="#1b1d20", sw=9)
    s.path("wires", d, stroke="#3d4248", sw=6.5)
    x, y = pts[0]
    s.rect("wires", x - 9, y - 2, 18, 20, "#2b2f35", "#111", 1, rx=3)
    s.rect("wires", x - 6, y - 7, 12, 6, "#c3c8ce", "#7a8087", 0.8, rx=1)


def header_pins(s, xs, y_edge, labels, label_color="#ffffff", pin_len=16.0):
    """Male header along the bottom edge of a module; pins point down. Returns tip coords."""
    x0, x1 = min(xs) - P / 2, max(xs) + P / 2
    s.rect("parts", x0, y_edge - 2, x1 - x0, 9, "#1e1e1e", rx=1.5)
    tips = []
    for x, lab in zip(xs, labels):
        s.rect("parts", x - 2.2, y_edge + 4, 4.4, pin_len, "#d4a52b", "#8a6510", 0.6)
        s.circle("parts", x, y_edge - 12, 4.6, "#d8b04a", "#8a6510", 0.8)
        s.circle("parts", x, y_edge - 12, 1.8, "#3a2b05")
        s.text("parts", x + 3.2, y_edge - 20, lab, 8.5, label_color, "start", "bold",
               extra=f'transform="rotate(-90 {x + 3.2:.1f} {y_edge - 20:.1f})"')
        tips.append((x, y_edge + 4 + pin_len))
    return tips


def pam8403(s, x0, y0, w, h, header_xs):
    """PAM8403 class-D module. Header (+5V GND R G L) along the bottom, outputs on the right."""
    s.rect("parts", x0 + 4, y0 + 6, w, h, "#000", rx=8, extra='opacity="0.13"')
    s.rect("parts", x0, y0, w, h, "#1f7a3e", "#0f4a24", 1.4, rx=8)
    for hx, hy in ((x0 + 9, y0 + 9), (x0 + w - 9, y0 + 9), (x0 + 9, y0 + h - 9), (x0 + w - 9, y0 + h - 9)):
        s.circle("parts", hx, hy, 4.2, "#e9e2c4", "#b9ae80", 1)
    s.text("parts", x0 + 16, y0 + 25, "PAM8403", 13, "#f1f5f1", "start", "bold")
    s.text("parts", x0 + 16, y0 + 40, "5 V  class-D  3 W x 2", 8.5, "#d7eadc", "start")
    cx, cy = x0 + w * 0.42, y0 + h * 0.52
    s.rect("parts", cx - 26, cy - 14, 52, 28, "#16181b", "#000", 1, rx=2)
    for k in range(8):
        for sgn in (-1, 1):
            s.rect("parts", cx - 23 + k * 6.4, cy + sgn * 14 - (3 if sgn < 0 else 0), 2.6, 3, "#c0c4c8")
    s.text("parts", cx, cy + 3, "PAM8403", 7, "#9aa0a8", "middle", "bold")
    for k, (dx, dy) in enumerate(((-44, -22), (-44, 18), (36, -24), (40, 16))):
        s.rect("parts", cx + dx, cy + dy, 10, 6, "#c9a46b", "#8a6a35", 0.6, rx=1)
    pins = {}
    tips = header_pins(s, header_xs, y0 + h, ["+5V", "GND", "R", "G", "L"])
    for nm, t in zip(["+5V", "GND", "R", "G", "L"], tips):
        pins[nm] = t
    outs = ["L+", "L−", "R−", "R+"]
    for i, nm in enumerate(outs):
        py = y0 + 34 + i * 26
        px = x0 + w
        s.rect("parts", px - 22, py - 9, 22, 18, "#2a2a2a", rx=2)
        s.circle("parts", px - 9, py, 5.2, "#d8b04a", "#8a6510", 1)
        s.circle("parts", px - 9, py, 2, "#3a2b05")
        s.text("parts", px - 27, py + 3.5, nm, 9.5, "#ffffff", "end", "bold")
        pins[nm] = (px, py)
    return pins


def max9814(s, x0, y0, w, h, header_xs):
    """MAX9814 electret microphone amplifier module (AR OUT GAIN VDD GND)."""
    s.rect("parts", x0 + 4, y0 + 6, w, h, "#000", rx=8, extra='opacity="0.13"')
    s.rect("parts", x0, y0, w, h, "#3b2357", "#21122f", 1.4, rx=8)
    for hx, hy in ((x0 + 9, y0 + 9), (x0 + w - 9, y0 + 9)):
        s.circle("parts", hx, hy, 4.2, "#e9e2c4", "#b9ae80", 1)
    mcx, mcy, r = x0 + w * 0.36, y0 + h * 0.40, 30
    gid = "mic%d" % len(s.defs)
    s.defs.append(f'<radialGradient id="{gid}"><stop offset="0" stop-color="#3a3a3a"/>'
                  f'<stop offset="1" stop-color="#101010"/></radialGradient>')
    s.circle("parts", mcx, mcy, r + 3, "#c8ccd2", "#808690", 1.2)
    s.circle("parts", mcx, mcy, r - 2, f"url(#{gid})")
    for i in range(-3, 4):
        for j in range(-3, 4):
            if i * i + j * j <= 9:
                s.circle("parts", mcx + i * 7, mcy + j * 7, 1.4, "#555")
    s.text("parts", x0 + w - 12, y0 + 26, "MAX9814", 12, "#f2ecf8", "end", "bold")
    s.text("parts", x0 + w - 12, y0 + 40, "mic + AGC", 8.5, "#d9cce8", "end")
    s.rect("parts", x0 + w - 44, y0 + 54, 26, 26, "#16181b", "#000", 1, rx=2)
    s.text("parts", x0 + w - 31, y0 + 70, "AGC", 6.5, "#9aa0a8", "middle")
    names = ["AR", "OUT", "GAIN", "VDD", "GND"]
    tips = header_pins(s, header_xs, y0 + h, names)
    return dict(zip(names, tips)), (mcx, mcy, r)


def speaker(s, cx, cy, r):
    s.circle("parts", cx + 4, cy + 6, r, "#000", extra='opacity="0.13"')
    s.circle("parts", cx, cy, r, "#3a3d42", "#1d1f22", 1.5)
    for k in range(4):
        a = math.radians(45 + 90 * k)
        s.circle("parts", cx + math.cos(a) * r * 0.86, cy + math.sin(a) * r * 0.86, 4, "#d0d3d7", "#777", 1)
    s.circle("parts", cx, cy, r * 0.78, "#5a5e65", "#2a2c30", 1)
    gid = "cone%d" % len(s.defs)
    s.defs.append(f'<radialGradient id="{gid}" cx="0.45" cy="0.4"><stop offset="0" stop-color="#8d939b"/>'
                  f'<stop offset="1" stop-color="#26292e"/></radialGradient>')
    s.circle("parts", cx, cy, r * 0.68, f"url(#{gid})", "#202226", 1)
    s.circle("parts", cx, cy, r * 0.25, "#1d1f23", "#0c0d0f", 1)
    s.circle("parts", cx - r * 0.06, cy - r * 0.07, r * 0.09, "#fff", extra='opacity="0.18"')
    # terminals on the left of the frame
    pins = {}
    for nm, dy, col, ly in (("+", -16, "#e53935", -10), ("−", 16, "#2e2e2e", 20)):
        tx, ty = cx - r - 2, cy + dy
        s.rect("parts", tx - 10, ty - 6, 16, 12, "#d0d3d7", "#7a8087", 1, rx=2)
        s.circle("parts", tx - 4, ty, 2.4, "#555")
        s.text("parts", tx + 2, ty + ly, nm, 12, col, "middle", "bold")
        pins[nm] = (tx - 10, ty)
    return pins


def dc_terminal(s, x0, y_plus, y_minus):
    """DC barrel jack -> 2-way screw terminal adapter. Wire entries face left."""
    w, h = 74, (y_minus - y_plus) + 40
    y0 = y_plus - 20
    s.rect("parts", x0 + 3, y0 + 5, w, h, "#000", rx=5, extra='opacity="0.13"')
    s.rect("parts", x0, y0, 30, h, "#26a65b", "#13693a", 1.2, rx=3)
    for yy in (y_plus, y_minus):
        s.rect("parts", x0 - 4, yy - 6, 10, 12, "#7b8088", "#4c5157", 0.8, rx=1)
        s.circle("parts", x0 + 17, yy, 6.5, "#cfd3d8", "#7a8087", 1)
        s.line("parts", x0 + 12.5, yy - 4.5, x0 + 21.5, yy + 4.5, "#5b6168", 1.6)
    s.rect("parts", x0 + 30, y0 + 2, w - 30, h - 4, "#1d1f22", "#000", 1, rx=4)
    s.circle("parts", x0 + w - 8, (y_plus + y_minus) / 2, 8, "#0d0e10", "#555", 1.2)
    s.circle("parts", x0 + w - 8, (y_plus + y_minus) / 2, 2.4, "#c3c8ce")
    s.text("parts", x0 + 15, y_plus - 22 - 2, "+", 13, "#e53935", "middle", "bold")
    s.text("parts", x0 + 15, y_minus + 34, "−", 15, "#2e2e2e", "middle", "bold")
    return {"+": (x0 - 4, y_plus), "−": (x0 - 4, y_minus), "jack": (x0 + w, (y_plus + y_minus) / 2)}


def wall_adapter(s, x0, y0, plug_to):
    w, h = 110, 92
    s.rect("parts", x0 + 4, y0 + 6, w, h, "#000", rx=10, extra='opacity="0.13"')
    s.rect("parts", x0, y0, w, h, "#222428", "#0e0f11", 1.2, rx=10)
    for dy in (-16, 16):
        s.rect("parts", x0 + w, y0 + h / 2 + dy - 4, 22, 8, "#c9cdd2", "#7a8087", 1, rx=1.5)
    s.text("parts", x0 + w / 2, y0 + 38, "5 V  2 A", 13, "#f1f1f1", "middle", "bold")
    s.text("parts", x0 + w / 2, y0 + 56, "wall adapter", 9.5, "#b8bcc2", "middle")
    s.text("parts", x0 + w / 2, y0 + 72, "(barrel plug)", 8.5, "#9aa0a8", "middle")
    # cable to barrel plug
    px, py = plug_to
    pts = [(x0, y0 + h / 2), (x0 - 30, y0 + h / 2), (x0 - 30, py), (px + 34, py)]
    d = rounded_path(pts, 16)
    s.path("wires", d, stroke="#0d0d0d", sw=7)
    s.path("wires", d, stroke="#2a2c30", sw=5)
    s.rect("wires", px + 4, py - 7, 30, 14, "#2a2c30", "#0d0d0d", 1, rx=3)
    s.rect("wires", px - 2, py - 4, 8, 8, "#c3c8ce", "#7a8087", 0.8, rx=1)


# ===========================================================================
# Wires
# ===========================================================================
def draw_wire(s, pts, color, plug_start=True, plug_end=True, width=6.0):
    main, dark = WIRE[color]
    d = rounded_path(pts, 12)
    s.path("wires", d, stroke=dark, sw=width + 2.4)
    s.path("wires", d, stroke=main, sw=width)
    s.path("wires", d, stroke="#ffffff", sw=1.6, extra='opacity="0.30"')
    for end, ok in ((0, plug_start), (-1, plug_end)):
        if not ok:
            continue
        x, y = pts[end]
        s.rect("top", x - 4.6, y - 4.6, 9.2, 9.2, "#2b2b2b", "#000", 0.8, rx=1.6)
        s.rect("top", x - 1.6, y - 1.6, 3.2, 3.2, "#c7ccd1", rx=0.6)


def tag(s, x, y, lines, anchor_pt=None, w=None, align="middle"):
    """Label box (white) centred at (x, y) with optional leader line to anchor_pt."""
    size = 10.5
    lh = 13.5
    width = w or max(len(t) for t, *_ in lines) * 6.4 + 16
    hgt = len(lines) * lh + 8
    x0, y0 = x - width / 2, y - hgt / 2
    if anchor_pt is not None:
        ax, ay = anchor_pt
        s.line("labels", x, y, ax, ay, "#555b63", 1.1, 'stroke-dasharray="3 2"')
        s.circle("labels", ax, ay, 2.6, "#555b63")
    s.rect("labels", x0, y0, width, hgt, "#ffffff", "#9aa0a8", 1.0, rx=5, extra='opacity="0.96"')
    for i, item in enumerate(lines):
        t = item[0]
        col = item[1] if len(item) > 1 else "#1f2328"
        wt = item[2] if len(item) > 2 else ("bold" if i == 0 else "normal")
        s.text("labels", x, y0 + 4 + lh * (i + 0.78), t, size if i == 0 else 9.5, col, "middle", wt)


def note_box(s, x, y, w, title, items, title_col="#1f2328", fill="#f6f8fa", stroke="#d0d7de",
             size=11.5, lh=19.0, col2=170):
    h = 34 + lh * len(items) + 6
    s.rect("labels", x, y, w, h, fill, stroke, 1.2, rx=8)
    s.text("labels", x + 14, y + 23, title, 13, title_col, "start", "bold")
    for i, it in enumerate(items):
        if isinstance(it, list):
            t, col, wt = it, "#24292f", "normal"
        elif isinstance(it, tuple):
            t, col, wt = it
        else:
            t, col, wt = it, "#24292f", "normal"
        if isinstance(t, list):
            s.text("labels", x + 14, y + 34 + lh * (i + 0.75), t[0], size, col, "start", wt)
            s.text("labels", x + 14 + col2, y + 34 + lh * (i + 0.75), t[1], size, "#0b4f8a", "start", "bold"
                   if wt == "normal" else wt, family=MONO)
        else:
            t = t.replace("  ", "\u00a0\u00a0")
            s.text("labels", x + 14, y + 34 + lh * (i + 0.75), t, size, col, "start", wt)
    return h


# ===========================================================================
# Connectivity check
# ===========================================================================
class Netcheck:
    def __init__(self, bb):
        self.bb = bb
        self.parent = {}
        self.occ = {}            # hole/pin -> who
        self.pins = {}           # pin name -> node id

    def _f(self, a):
        self.parent.setdefault(a, a)
        while self.parent[a] != a:
            self.parent[a] = self.parent[self.parent[a]]
            a = self.parent[a]
        return a

    def _u(self, a, b):
        self.parent[self._f(a)] = self._f(b)

    def point(self, p, who):
        """p = hole name ('c4', 'TR2-8') or off-board pin ('AMP.L'). Returns node id."""
        if p in self.occ:
            raise SystemExit(f"CHECK FAILED: {who} and {self.occ[p]} both use {p}")
        self.occ[p] = who
        if "." in p:
            return "pin:" + p
        if not self.bb.valid(p):
            raise SystemExit(f"CHECK FAILED: {who} uses {p}, which is not a hole on the board")
        return self.bb.node(p)

    def part_pin(self, name, where):
        n = self.point(where, name)
        self.pins[name] = n
        self._f(n)

    def offboard_pin(self, name):
        self.pins[name] = "pin:" + name
        self._f("pin:" + name)

    def wire(self, a, b, who):
        na = self.point(a, who) if not (a.startswith("pin:")) else a
        nb = self.point(b, who) if not (b.startswith("pin:")) else b
        self._u(na, nb)

    def verify(self, expected, label):
        got = {}
        for name, n in self.pins.items():
            got.setdefault(self._f(n), set()).add(name)
        got_sets = sorted(sorted(v) for v in got.values())
        exp_sets = sorted(sorted(v) for v in expected)
        named = set().union(*expected)
        missing = named - set(self.pins)
        if missing:
            raise SystemExit(f"CHECK FAILED ({label}): pins never placed: {sorted(missing)}")
        if got_sets != exp_sets:
            print(f"CHECK FAILED ({label})")
            print("  expected:", json.dumps(exp_sets))
            print("  got     :", json.dumps(got_sets))
            raise SystemExit(1)
        print(f"{label}: {len(exp_sets)} nets match the circuit, {len(self.occ)} holes/pins used, "
              f"no shared holes")


# ===========================================================================
# Transmitter
# ===========================================================================
BBX, BBY = 440.0, 300.0
CANVAS = (1800, 1080)

TX_PARTS = [
    # ref, kind, value, marking/bands, pins
    ("R1", "resistor", "4.7 kΩ", ["yellow", "violet", "red", "gold"], {"1": "c4", "2": "c8"}),
    ("C1", "disc", "3.3 nF", "332", {"1": "a8", "2": "TR2-8"}),
    ("C2", "mlcc", "1 µF", "105", {"1": "b8", "2": "b12"}),
    ("RV1", "trimmer", "10 kΩ", "103", {"1": "d12", "2": "d13", "3": "d14"}),
    ("C3", "elko", "1000 µF 16 V", "", {"+": "TR1-6", "-": "TR2-6"}),
]
# wire list: (from, to, colour, description). 'X.Y' = off-board pin.
TX_WIRES = [
    ("ESP32.D25", "a4", "orange", "tone signal"),
    ("ESP32.GND_R", "TR2-2", "black", "common ground"),
    ("a14", "TR2-14", "black", "RV1 low end to ground"),
    ("AMP.L", "a13", "yellow", "volume wiper to amp input"),
    ("AMP.G", "TR2-12", "black", "amp input ground"),
    ("AMP.+5V", "TR1-9", "red", "amp power +5 V"),
    ("AMP.GND", "TR2-10", "black", "amp power ground"),
    ("DC.+", "TR1-30", "red", "adapter +5 V to top + rail"),
    ("DC.−", "TR2-30", "black", "adapter ground to top − rail"),
    ("AMP.L+", "SPK.+", "red", "speaker +"),
    ("AMP.L−", "SPK.−", "black", "speaker −"),
]
TX_NETS = [
    {"ESP32.D25", "R1.1"},
    {"R1.2", "C1.1", "C2.1"},
    {"C2.2", "RV1.1"},
    {"RV1.2", "AMP.L"},
    {"ESP32.GND_R", "C1.2", "RV1.3", "AMP.G", "AMP.GND", "C3.-", "DC.−"},
    {"AMP.+5V", "C3.+", "DC.+"},
    {"AMP.L+", "SPK.+"},
    {"AMP.L−", "SPK.−"},
    {"AMP.R"}, {"AMP.R+"}, {"AMP.R−"},
]

RX_PARTS = [
    ("R2", "resistor", "10 Ω", ["brown", "black", "black", "gold"], {"1": "c4", "2": "c8"}),
    ("C4", "elko", "100 µF 16 V", "", {"+": "TR1-10", "-": "TR2-10"}),
    ("R3", "resistor", "3.3 kΩ", ["orange", "orange", "red", "gold"], {"1": "c15", "2": "c20"}),
    ("C5", "disc", "4.7 nF", "472", {"1": "a20", "2": "TR2-20"}),
]
RX_WIRES = [
    ("ESP32.3V3", "a4", "red", "3.3 V from ESP32"),
    ("ESP32.GND_R", "TR2-2", "black", "common ground"),
    ("a8", "TR1-8", "red", "filtered 3.3 V (3V3A) to top + rail"),
    ("MIC.OUT", "b15", "yellow", "audio out"),
    ("MIC.VDD", "TR1-17", "red", "mic power 3V3A"),
    ("MIC.GND", "TR2-18", "black", "mic ground"),
    ("d20", "ESP32.D34", "green", "to ADC GPIO34"),
]
RX_NETS = [
    {"ESP32.3V3", "R2.1"},
    {"R2.2", "C4.+", "MIC.VDD"},
    {"ESP32.GND_R", "C4.-", "MIC.GND", "C5.2"},
    {"MIC.OUT", "R3.1"},
    {"R3.2", "C5.1", "ESP32.D34"},
    {"MIC.AR"}, {"MIC.GAIN"},
]


def check(parts, wires, offboard, nets, label):
    bb = Breadboard(BBX, BBY)
    nc = Netcheck(bb)
    for ref, kind, value, mark, pins in parts:
        for pn, hole in pins.items():
            nc.part_pin(f"{ref}.{pn}", hole)
    for p in offboard:
        nc.offboard_pin(p)
    for a, b, col, desc in wires:
        ea = ("pin:" + a) if "." in a else a
        eb = ("pin:" + b) if "." in b else b
        for e in (a, b):
            if "." in e:
                if e not in offboard:
                    raise SystemExit(f"CHECK FAILED ({label}): wire end {e} is not a known pin")
                if e in nc.occ:
                    raise SystemExit(f"CHECK FAILED ({label}): two wires on pin {e}")
                nc.occ[e] = f"wire {a}->{b}"
        nc.wire(ea, eb, f"wire {a}->{b}")
    nc.verify(nets, label)


def hole_xy(bb, h):
    return bb.xy(h)


def draw_board_parts(s, bb, parts):
    info = {}
    for ref, kind, value, mark, pins in parts:
        xy = {k: bb.xy(v) for k, v in pins.items()}
        if kind == "resistor":
            resistor(s, xy["1"], xy["2"], mark)
            info[ref] = ((xy["1"][0] + xy["2"][0]) / 2, xy["1"][1])
        elif kind == "disc":
            disc_cap(s, xy["1"], xy["2"], mark)
            info[ref] = ((xy["1"][0] + xy["2"][0]) / 2 + 9, (xy["1"][1] + xy["2"][1]) / 2)
        elif kind == "mlcc":
            mlcc(s, xy["1"], xy["2"], mark)
            info[ref] = ((xy["1"][0] + xy["2"][0]) / 2, xy["1"][1])
        elif kind == "trimmer":
            box = trimmer(s, [xy["1"], xy["2"], xy["3"]])
            info[ref] = box
        elif kind == "elko":
            box = electrolytic(s, xy["+"], xy["-"], value)
            info[ref] = box
    return info


def rail_legend(s, bb, plus_text):
    x = bb.cx(30) + 8
    y = bb.rowy("TR1") - 19
    gnd = "top − rail = GND"
    s.text("labels", x, y, gnd, 10, "#2f62c9", "end", "bold")
    s.text("labels", x - len(gnd) * 6.3 - 18, y, "top + rail = " + plus_text, 10, "#d93a32", "end", "bold")


def title(s, t, sub):
    s.text("labels", 40, 46, t, 24, "#1f2328", "start", "bold")
    s.text("labels", 40, 72, sub, 13, "#57606a", "start")


def build_tx():
    s = Svg(*CANVAS)
    bb = Breadboard(BBX, BBY)
    bb.draw(s)
    title(s, "DUBURI text modem — TRANSMITTER (PC 1)",
          "ESP32 → RC filter + volume → PAM8403 amplifier → speaker.  400-point breadboard, no soldering.")
    info = draw_board_parts(s, bb, TX_PARTS)

    # off-board parts --------------------------------------------------------
    e = esp32(s, 70, BBY, highlight=("D25", "GND"))
    hx = [bb.cx(c) for c in (9, 10, 11, 12, 13)]
    amp = pam8403(s, bb.cx(9) - 20, 116, 212, 150, hx)
    spk = speaker(s, 1000, 186, 86)
    dc = dc_terminal(s, 1190, bb.rowy("TR1"), bb.rowy("TR2"))
    wall_adapter(s, 1330, 288, dc["jack"])

    # wires ------------------------------------------------------------------
    H = lambda h: bb.xy(h)
    a4 = H("a4")
    draw_wire(s, orth(e["D25"], [("h", 46), ("v", 262), ("h", a4[0])], a4), "orange")
    t2 = H("TR2-2")
    draw_wire(s, orth(e["GND_R"], [("h", 405), ("v", t2[1])], t2), "black")
    draw_wire(s, [H("a14"), H("TR2-14")], "black")
    draw_wire(s, [amp["L"], H("a13")], "yellow")
    draw_wire(s, [amp["G"], H("TR2-12")], "black")
    draw_wire(s, [amp["+5V"], H("TR1-9")], "red")
    draw_wire(s, [amp["GND"], H("TR2-10")], "black")
    draw_wire(s, [dc["+"], H("TR1-30")], "red")
    draw_wire(s, [dc["−"], H("TR2-30")], "black")
    lp, lm = amp["L+"], amp["L−"]
    draw_wire(s, orth(lp, [("h", lp[0] + 40), ("v", spk["+"][1])], spk["+"]), "red", width=5)
    draw_wire(s, orth(lm, [("h", lm[0] + 24), ("v", spk["−"][1])], spk["−"]), "black", width=5)

    # USB + laptop
    port = laptop(s, 40, 838, "file:///.../pc/sender.html",
                  [("DUBURI Sender", 13, "#1f2328", "bold"),
                   ("Text : Hello", 10, "#24292f", "normal"),
                   ("Bits : 01001000 01100101 ...", 9, "#0b6bcb", "normal"),
                   ("[ Send ]   packet 1/3  ######..", 9, "#1a7f37", "normal")], w=290)
    usb_cable(s, [e["USB"], (e["USB"][0], 812), (port[0] + 26, 812), (port[0] + 26, port[1]),
                  (port[0], port[1])])
    s.text("labels", 196, 830, "USB cable (data + power for ESP32)", 10, "#57606a", "middle")

    # labels -----------------------------------------------------------------
    r1 = info["R1"]
    tag(s, r1[0] - 18, bb.rowy("g"), [("R1  4.7 kΩ",), ("yellow-violet-red-gold", "#57606a")],
        (r1[0], r1[1] + 7))
    c1 = info["C1"]
    tag(s, bb.cx(9) + 4, bb.rowy("i") + 4, [("C1  3.3 nF",), ("ceramic, marked 332", "#57606a")],
        (c1[0] + 4, c1[1] + 10))
    c2 = info["C2"]
    tag(s, bb.cx(16) + 6, bb.rowy("g") - 4, [("C2  1 µF",), ("ceramic, marked 105", "#57606a")],
        (c2[0] + 4, c2[1] + 9))
    rv = info["RV1"]
    tag(s, bb.cx(22) + 10, bb.rowy("i") + 4, [("RV1  10 kΩ trimmer = volume",),
                                              ("pins d12 · d13 (wiper) · d14", "#57606a")],
        ((rv[0] + rv[2]) / 2 + 20, rv[3]))
    c3 = info["C3"]
    tag(s, c3[0] - 112, 214, [("C3  1000 µF 16 V",), ("stripe (−) to − rail", "#57606a")],
        (c3[0] - c3[2] / 2, c3[1] + 16), w=132)
    rail_legend(s, bb, "+5 V")
    s.text("labels", 1000, 94, "Speaker  4 Ω  3 W", 12, "#1f2328", "middle", "bold")
    s.text("labels", 1245, 410, "DC jack → screw terminal", 10, "#57606a", "middle")

    # warning + notes ----------------------------------------------------------
    s.rect("labels", 1112, 104, 646, 112, "#fff1f0", "#e5534b", 1.6, rx=8)
    s.text("labels", 1130, 132, "Never connect a speaker wire to GND (BTL output).", 14, "#c62828",
           "start", "bold")
    s.text("labels", 1130, 156, "Use only L+ and L−. Both speaker wires float.", 13, "#c62828", "start",
           "bold")
    s.text("labels", 1130, 186, "Start with RV1 turned all the way down,", 12.5, "#8a1c1c", "start")
    s.text("labels", 1130, 204, "then raise it until the tones are loud but not harsh.", 12.5, "#8a1c1c",
           "start")

    note_box(s, 1196, 452, 562, "Parts and holes (transmitter)", [
        ["ESP32 DevKit V1 (30 pin)", "USB cable to PC 1"],
        ["R1  4.7 kΩ", "c4 ↔ c8"],
        ["C1  3.3 nF  (332)", "a8 ↔ top − rail"],
        ["C2  1 µF  (105)", "b8 ↔ b12"],
        ["RV1  10 kΩ trimmer", "d12 · d13 (wiper) · d14"],
        ["jumper (black)", "a14 → top − rail"],
        ["C3  1000 µF 16 V", "top + / top − rail, col 6"],
        ["PAM8403  L  (yellow)", "← a13"],
        ["PAM8403  G, GND (black)", "→ top − rail"],
        ["PAM8403  +5V  (red)", "→ top + rail"],
        ["Speaker 4 Ω 3 W", "PAM8403 L+ and L− only"],
        ["5 V 2 A adapter", "+ / − rail, col 30"],
        ["ESP32 D25  (orange)", "→ a4"],
        ["ESP32 GND  (black)", "→ top − rail, col 2"],
    ], size=11, lh=19, col2=190)
    note_box(s, 440, 760, 724, "How it is powered", [
        "• Top + rail = 5 V from the wall adapter.  Top − rail = GND.",
        "• The ESP32 is powered by the USB cable from PC 1. Do NOT feed the adapter's",
        "  5 V into the ESP32. Only the grounds are joined (ESP32 GND → − rail).",
        "• PAM8403 pin order differs between boards: follow the printed labels.",
        "• R input of the PAM8403 stays unused. Speaker: 4–8 Ω, 3–5 W is fine.",
    ], size=11.5, lh=20)
    return s


def build_rx():
    s = Svg(*CANVAS)
    bb = Breadboard(BBX, BBY)
    bb.draw(s)
    title(s, "DUBURI text modem — RECEIVER (PC 2)",
          "MAX9814 microphone module → RC filter → ESP32 GPIO34 (ADC).  400-point breadboard, no soldering.")
    info = draw_board_parts(s, bb, RX_PARTS)

    e = esp32(s, 70, BBY, highlight=("D34", "3V3", "GND"))
    hx = [bb.cx(c) for c in (14, 15, 16, 17, 18)]
    mic, mpos = max9814(s, bb.cx(14) - 30, 118, 190, 148, hx)

    H = lambda h: bb.xy(h)
    a4, t2 = H("a4"), H("TR2-2")
    draw_wire(s, orth(e["3V3"], [("h", 420), ("v", a4[1])], a4), "red")
    draw_wire(s, orth(e["GND_R"], [("h", 405), ("v", t2[1])], t2), "black")
    draw_wire(s, [H("a8"), H("TR1-8")], "red")
    draw_wire(s, [mic["OUT"], H("b15")], "yellow")
    draw_wire(s, [mic["VDD"], H("TR1-17")], "red")
    draw_wire(s, [mic["GND"], H("TR2-18")], "black")
    d20 = H("d20")
    draw_wire(s, orth(d20, [("v", 784), ("h", 44), ("v", e["D34"][1])], e["D34"]), "green")

    port = laptop(s, 40, 838, "file:///.../pc/receiver.html",
                  [("DUBURI Receiver", 13, "#1f2328", "bold"),
                   ("From node 1:  Hello", 10, "#24292f", "normal"),
                   ("q = 14.2 dB   packets 3/3", 9, "#1a7f37", "normal"),
                   ("SCOPE  ▂▃▅▇▅▃▂▁", 9, "#0b6bcb", "normal")], w=290)
    usb_cable(s, [e["USB"], (e["USB"][0], 812), (port[0] + 26, 812), (port[0] + 26, port[1]),
                  (port[0], port[1])])
    s.text("labels", 196, 830, "USB cable (data + power for ESP32)", 10, "#57606a", "middle")

    # sound arriving
    mcx, mcy, mr = mpos
    ca, sa = math.cos(math.radians(35)), math.sin(math.radians(35))
    for k in range(3):
        rr = 84 + k * 14
        s.path("labels", f"M {mcx - rr*ca:.1f} {mcy - rr*sa:.1f} A {rr:.1f} {rr:.1f} 0 0 0 "
                         f"{mcx - rr*ca:.1f} {mcy + rr*sa:.1f}",
               stroke="#2f81f7", sw=2.4, extra=f'opacity="{0.9 - 0.25*k:.2f}"')
    s.text("labels", mcx - 124, mcy - 44, "tones from the speaker", 10.5, "#2f81f7", "end", "bold")
    s.text("labels", mcx - 124, mcy - 29, "3 – 8.75 kHz, through air", 10, "#2f81f7", "end")

    r2 = info["R2"]
    tag(s, r2[0] - 10, bb.rowy("g"), [("R2  10 Ω",), ("brown-black-black-gold", "#57606a")],
        (r2[0], r2[1] + 7))
    c4 = info["C4"]
    tag(s, c4[0] - 104, 214, [("C4  100 µF 16 V",), ("stripe (−) to − rail", "#57606a")],
        (c4[0] - c4[2] / 2, c4[1] + 16), w=128)
    r3 = info["R3"]
    tag(s, bb.cx(15) - 4, bb.rowy("g"), [("R3  3.3 kΩ",), ("orange-orange-red-gold", "#57606a")],
        (r3[0], r3[1] + 7))
    c5 = info["C5"]
    tag(s, bb.cx(26) + 6, bb.rowy("g") - 6, [("C5  4.7 nF",), ("ceramic, marked 472", "#57606a")],
        (c5[0] + 4, c5[1] + 10))
    rail_legend(s, bb, "3V3A")
    s.text("labels", 640, 774, "green wire: d20 → ESP32 D34 (GPIO34, ADC input)", 10.5, "#16733a", "middle",
           "bold")

    note_box(s, 1196, 300, 562, "Parts and holes (receiver)", [
        ["ESP32 DevKit V1 (30 pin)", "USB cable to PC 2"],
        ["R2  10 Ω", "c4 ↔ c8"],
        ["jumper (red)", "a8 → top + rail (3V3A)"],
        ["C4  100 µF 16 V", "top + / top − rail, col 10"],
        ["MAX9814  OUT  (yellow)", "→ b15"],
        ["MAX9814  VDD  (red)", "→ top + rail"],
        ["MAX9814  GND  (black)", "→ top − rail"],
        ["MAX9814  GAIN, AR", "not connected"],
        ["R3  3.3 kΩ", "c15 ↔ c20"],
        ["C5  4.7 nF  (472)", "a20 ↔ top − rail"],
        ["ESP32 3V3  (red)", "→ a4"],
        ["ESP32 GND  (black)", "→ top − rail, col 2"],
        ["ESP32 D34  (green)", "← d20"],
    ], size=11, lh=19, col2=190)
    note_box(s, 1196, 612, 562, "Microphone tips", [
        "• GAIN open = 60 dB (most sensitive).",
        "• If the signal clips at short range: GAIN → GND = 50 dB,",
        "  GAIN → VDD = 40 dB.",
        "• Pin order differs between MAX9814 boards —",
        "  follow the printed labels, not the position.",
        "• Point the mic at the speaker, away from fans.",
    ], size=11.5, lh=20)
    note_box(s, 440, 820, 724, "How it is powered", [
        "• ESP32 3V3 pin → 10 Ω → top + rail. With the 100 µF this is a filtered",
        "  supply (3V3A) for the microphone, so USB noise stays out of the audio.",
        "• Top − rail = GND. Only 3.3 V here: never put 5 V on these rails.",
        "• R3 + C5 (3.3 kΩ, 4.7 nF) is the anti-alias filter in front of the ADC.",
    ], size=11.5, lh=20)
    return s


# ===========================================================================
# System overview
# ===========================================================================
def mini_esp(s, x, y):
    s.rect("parts", x, y, 64, 112, "#1c232c", "#0b0f14", 1.2, rx=6)
    s.rect("parts", x + 12, y + 6, 40, 52, "#c3c8ce", "#80868e", 1, rx=2)
    s.text("parts", x + 32, y + 36, "ESP32", 9, "#4a5058", "middle", "bold")
    for k in range(10):
        s.rect("parts", x + 3, y + 64 + k * 4.4, 4, 2.4, "#d8a62a")
        s.rect("parts", x + 57, y + 64 + k * 4.4, 4, 2.4, "#d8a62a")
    s.rect("parts", x + 24, y + 104, 16, 10, "#c3c8ce", "#7a8087", 1, rx=1)


def node_box(s, x, y, w, h, title_, col):
    s.rect("bg", x + 4, y + 6, w, h, "#000", rx=14, extra='opacity="0.08"')
    s.rect("bg", x, y, w, h, "#ffffff", col, 2, rx=14)
    s.rect("bg", x, y, w, 34, col, rx=14)
    s.rect("bg", x, y + 20, w, 14, col)
    s.text("bg", x + w / 2, y + 23, title_, 14, "#ffffff", "middle", "bold")


def build_overview():
    s = Svg(1800, 640)
    s.text("labels", 40, 46, "DUBURI text modem — how the link works", 24, "#1f2328", "start", "bold")
    s.text("labels", 40, 72, "Type on PC 1, the ESP32 turns the text into sound, the other ESP32 hears it "
                             "and PC 2 shows it. Same firmware on both boards.", 13, "#57606a")
    blue, orange = "#2f6fdb", "#d9822b"
    # PC 1
    p1 = laptop(s, 40, 170, "file:///.../pc/sender.html",
                [("DUBURI Sender", 13, "#1f2328", "bold"), ("Text : Hello", 10, "#24292f", "normal"),
                 ("01001000 01100101 ...", 9, "#0b6bcb", "normal"), ("[ Send ]", 9, "#1a7f37", "bold")],
                w=250)
    # TX node
    node_box(s, 380, 140, 300, 240, "TRANSMITTER node", blue)
    mini_esp(s, 400, 196)
    s.rect("parts", 490, 214, 76, 58, "#1f7a3e", "#0f4a24", 1.2, rx=5)
    s.text("parts", 528, 240, "PAM8403", 9.5, "#fff", "middle", "bold")
    s.text("parts", 528, 254, "amp", 9, "#d7eadc", "middle")
    s.text("parts", 528, 300, "RC filter", 9.5, "#57606a", "middle")
    s.text("parts", 528, 313, "+ volume", 9.5, "#57606a", "middle")
    s.line("parts", 466, 243, 490, 243, "#f39c12", 3)
    sp = speaker(s, 760, 260, 58)
    s.line("parts", 566, 243, 640, 243, "#e53935", 3)
    s.path("parts", f"M 640 243 L 690 243 L 690 {sp['+'][1]:.1f} L {sp['+'][0]:.1f} {sp['+'][1]:.1f}",
           stroke="#e53935", sw=3)
    s.path("parts", f"M 566 255 L 680 255 L 680 {sp['−'][1]:.1f} L {sp['−'][0]:.1f} {sp['−'][1]:.1f}",
           stroke="#2e2e2e", sw=3)
    # waves
    for k in range(4):
        rr = 78 + k * 26
        s.path("labels", f"M {760 + rr*0.72:.1f} {260 - rr*0.69:.1f} A {rr:.1f} {rr:.1f} 0 0 1 "
                         f"{760 + rr*0.72:.1f} {260 + rr*0.69:.1f}", stroke=blue, sw=3,
               extra=f'opacity="{0.9 - 0.18*k:.2f}"')
    for k in range(3):
        rr = 60 + k * 26
        s.path("labels", f"M {1110 - rr*0.72:.1f} {260 - rr*0.69:.1f} A {rr:.1f} {rr:.1f} 0 0 0 "
                         f"{1110 - rr*0.72:.1f} {260 + rr*0.69:.1f}", stroke=orange, sw=3,
               extra=f'opacity="{0.9 - 0.22*k:.2f}"')
    s.path("labels", "M 880 372 L 1032 372", stroke="#57606a", sw=1.6)
    s.path("labels", "M 888 366 L 880 372 L 888 378 M 1024 366 L 1032 372 L 1024 378", stroke="#57606a",
           sw=1.6)
    s.text("labels", 956, 168, "through AIR", 15, "#1f2328", "middle", "bold")
    s.text("labels", 956, 188, "1 – 5 m", 13, "#57606a", "middle")
    s.text("labels", 956, 404, "24 tones, 3 – 8.75 kHz", 11.5, "#57606a", "middle")
    s.text("labels", 956, 420, "2.56 s per packet (2 bytes), AIR mode", 11.5, "#57606a", "middle")
    # RX node
    node_box(s, 1080, 140, 300, 240, "RECEIVER node", orange)
    s.rect("parts", 1100, 210, 92, 74, "#3b2357", "#21122f", 1.2, rx=6)
    s.circle("parts", 1132, 247, 22, "#c8ccd2", "#808690", 1)
    s.circle("parts", 1132, 247, 18, "#161616")
    s.text("parts", 1170, 230, "MAX", 8, "#f2ecf8", "middle", "bold")
    s.text("parts", 1170, 241, "9814", 8, "#f2ecf8", "middle", "bold")
    s.text("parts", 1146, 304, "mic + AGC", 9.5, "#57606a", "middle")
    s.line("parts", 1192, 247, 1290, 247, "#f7d438", 3)
    s.text("parts", 1236, 240, "RC", 9, "#57606a", "middle")
    mini_esp(s, 1296, 196)
    # PC 2
    p2 = laptop(s, 1500, 170, "file:///.../pc/receiver.html",
                [("DUBURI Receiver", 13, "#1f2328", "bold"), ("From 1:  Hello", 10, "#24292f", "normal"),
                 ("q = 14.2 dB", 9, "#1a7f37", "normal"), ("3/3 packets OK", 9, "#0b6bcb", "normal")],
                w=250, port_side="left")
    # USB cables
    def cable(pts):
        d = rounded_path(pts, 18)
        s.path("wires", d, stroke="#1b1d20", sw=8)
        s.path("wires", d, stroke="#3d4248", sw=5.5)
    cable([p1, (p1[0] + 30, p1[1]), (p1[0] + 30, 320), (432, 320), (432, 308)])
    cable([(1328, 308), (1328, 340), (1450, 340), (1450, p2[1]), (p2[0], p2[1])])
    s.text("labels", 372, 398, "USB", 11, "#57606a", "middle", "bold")
    s.text("labels", 1440, 362, "USB", 11, "#57606a", "middle", "bold")
    # steps
    steps = [
        (175, "1. Type a message", "sender.html in Chrome / Edge", "sends it over USB (Web Serial)"),
        (530, "2. Text → bits → tones", "2 bytes + CRC per packet, error-", "correction code, 64 tones each"),
        (900, "3. Sound through the air", "speaker plays the tones,", "microphone hears them"),
        (1260, "4. Tones → bits → text", "ESP32 finds the packet, decodes,", "checks the CRC, joins the parts"),
        (1625, "5. Dashboard", "receiver.html shows the message,", "link quality and live levels"),
    ]
    for x, a, b, c in steps:
        s.rect("labels", x - 160, 470, 320, 104, "#f6f8fa", "#d0d7de", 1.2, rx=10)
        s.text("labels", x, 500, a, 14, "#1f2328", "middle", "bold")
        s.text("labels", x, 526, b, 12, "#57606a", "middle")
        s.text("labels", x, 546, c, 12, "#57606a", "middle")
    return s


# ===========================================================================
# Placement table (markdown)
# ===========================================================================
def pretty(p):
    names = {"ESP32.GND_R": "ESP32 GND (right side, 2nd from bottom)", "ESP32.D25": "ESP32 D25",
             "ESP32.D34": "ESP32 D34 (GPIO34)", "ESP32.3V3": "ESP32 3V3", "AMP.": "PAM8403 ",
             "MIC.": "MAX9814 ", "DC.": "DC terminal ", "SPK.": "speaker "}
    if p in names:
        return names[p]
    for k, v in names.items():
        if k.endswith(".") and p.startswith(k):
            return v + p[len(k):]
    if "-" in p:
        r, c = p.split("-")
        return {"TR1": "top + rail", "TR2": "top − rail"}.get(r, r) + f" col {c} (`{p}`)"
    return f"`{p}`"


def wire_md(wires):
    out = ["| From | To | Colour | What it is |", "|---|---|---|---|"]
    for a, b, col, desc in wires:
        out.append(f"| {pretty(a)} | {pretty(b)} | {col} | {desc} |")
    return "\n".join(out)


def placement_md():
    def holes(p):
        return " ↔ ".join(f"`{v}`" for v in p.values())
    tx = [
        "| Part | Value / marking | Holes |", "|---|---|---|",
        "| R1 | 4.7 kΩ (yellow-violet-red-gold) | `c4` ↔ `c8` |",
        "| C1 | 3.3 nF ceramic, marked `332` | `a8` ↔ top − rail col 8 (`TR2-8`) |",
        "| C2 | 1 µF ceramic, marked `105` | `b8` ↔ `b12` |",
        "| RV1 | 10 kΩ trimmer, marked `103` | `d12` (end) · `d13` (wiper) · `d14` (end) |",
        "| C3 | 1000 µF 16 V electrolytic | + leg top + rail col 6 (`TR1-6`), − leg (stripe) top − rail col 6 (`TR2-6`) |",
        "| PAM8403 module | 5 V class-D amp | off the board, wired (see wires) |",
        "| Speaker | 4 Ω, 3 W (4–8 Ω, 3–5 W OK) | PAM8403 `L+` and `L−` only |",
        "| 5 V 2 A adapter + DC-jack-to-screw-terminal | | `+` → `TR1-30`, `−` → `TR2-30` |",
    ]
    rx = [
        "| Part | Value / marking | Holes |", "|---|---|---|",
        "| R2 | 10 Ω (brown-black-black-gold) | `c4` ↔ `c8` |",
        "| C4 | 100 µF 16 V electrolytic | + leg top + rail col 10 (`TR1-10`), − leg (stripe) top − rail col 10 (`TR2-10`) |",
        "| MAX9814 module | mic amplifier with AGC | off the board, wired (see wires); `GAIN`, `AR` not connected |",
        "| R3 | 3.3 kΩ (orange-orange-red-gold) | `c15` ↔ `c20` |",
        "| C5 | 4.7 nF ceramic, marked `472` | `a20` ↔ top − rail col 20 (`TR2-20`) |",
    ]
    return f"""# Breadboard placement: DUBURI air-acoustic text modem

Generated by `wiring.py` (the script also checks every connection against the
circuit). Board: 400-point half breadboard. Columns 1–30 from left to right. Rows
`a`–`e` are the top half (`a` next to the top rails), `f`–`j` the bottom half. Each
column of `a`–`e` is one connected strip. Top rails: `TR1` = outer row with the red
line (+), `TR2` = inner row with the blue line (−). On these small boards the rail
has no hole at columns 1, 7, 13, 19 and 25.

ESP32 DevKit V1 (DOIT, 30 pins) and the modules sit next to the breadboard and are
joined with jumper wires (male-to-female for module pins and ESP32 pins).

![Transmitter](tx_wiring.png)

## Transmitter node (PC 1)

Top + rail = 5 V from the wall adapter, top − rail = GND. The ESP32 is powered by
its USB cable; only its GND is joined to the − rail.

{chr(10).join(tx)}

### Wires

{wire_md(TX_WIRES)}

Safety: the PAM8403 output is bridge-tied (BTL). Never connect `L+` or `L−` to GND
and never join two output pins. Start with RV1 turned all the way down.

![Receiver](rx_wiring.png)

## Receiver node (PC 2)

Top + rail = 3V3A: the ESP32 `3V3` pin through the 10 Ω resistor, smoothed by the
100 µF capacitor. Top − rail = GND. Only 3.3 V on this board.

{chr(10).join(rx)}

### Wires

{wire_md(RX_WIRES)}

MAX9814 gain: `GAIN` open = 60 dB, `GAIN` to GND = 50 dB, `GAIN` to VDD = 40 dB.
Use a lower gain if the signal clips (the firmware's `stats` command shows the ADC
level). Pin order differs between MAX9814 boards: follow the printed labels.

![How the link works](system_overview.png)
"""


# ===========================================================================
def render_png(svgs):
    js = r"""
const { chromium } = require('playwright');
(async () => {
  const jobs = JSON.parse(process.argv[2]);
  const browser = await chromium.launch();
  for (const j of jobs) {
    const page = await browser.newPage({ viewport: { width: j.w, height: j.h }, deviceScaleFactor: 2 });
    await page.goto('file://' + j.svg);
    await page.screenshot({ path: j.png, clip: { x: 0, y: 0, width: j.w, height: j.h } });
    await page.close();
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
"""
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(js)
        jsf = f.name
    try:
        r = subprocess.run(["node", jsf, json.dumps(svgs)], capture_output=True, text=True, timeout=180)
        if r.returncode != 0:
            print("PNG render failed (SVGs are fine):", r.stderr.strip()[:400])
            return False
        return True
    finally:
        os.unlink(jsf)


def main():
    tx_off = ["ESP32.D25", "ESP32.GND_R", "AMP.L", "AMP.G", "AMP.R", "AMP.+5V", "AMP.GND", "AMP.L+",
              "AMP.L−", "AMP.R+", "AMP.R−", "DC.+", "DC.−", "SPK.+", "SPK.−"]
    rx_off = ["ESP32.3V3", "ESP32.GND_R", "ESP32.D34", "MIC.AR", "MIC.OUT", "MIC.GAIN", "MIC.VDD",
              "MIC.GND"]
    check(TX_PARTS, TX_WIRES, tx_off, TX_NETS, "transmitter")
    check(RX_PARTS, RX_WIRES, rx_off, RX_NETS, "receiver")

    jobs = []
    for name, builder in (("tx_wiring", build_tx), ("rx_wiring", build_rx),
                          ("system_overview", build_overview)):
        s = builder()
        p = os.path.join(HERE, name + ".svg")
        with open(p, "w", encoding="utf-8") as f:
            f.write(s.svg())
        jobs.append(dict(svg=p, png=os.path.join(HERE, name + ".png"), w=s.w, h=s.h))
    with open(os.path.join(HERE, "placement.md"), "w", encoding="utf-8") as f:
        f.write(placement_md())
    ok = render_png(jobs)
    print("wrote:", ", ".join(os.path.basename(j["svg"]) for j in jobs),
          "+ PNGs" if ok else "(no PNG)", "+ placement.md")
    print("OK")


if __name__ == "__main__":
    main()
