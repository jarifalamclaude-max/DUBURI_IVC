"""
build_pdf.py - builds docs/DUBURI_IVC_Guide.pdf (Bangla) from guide_bn.html.

    python3 docs/figures.py      # schematics + explanation figures
    python3 sim/run_sim.py       # virtual pool results + graphs
    python3 docs/build_pdf.py    # -> docs/DUBURI_IVC_Guide.pdf

Numbers from the simulation and the source code listings are inserted
automatically, so the PDF always matches the code in this repository.
"""
import html
import json
import os
import shutil
import subprocess
import sys

DOCS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(DOCS)
FW = os.path.join(ROOT, "firmware", "DuburiModem")
RES = os.path.join(ROOT, "sim", "results")

CHROME_CANDIDATES = [
    os.environ.get("CHROME", ""),
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    shutil.which("chromium") or "",
    shutil.which("chromium-browser") or "",
    shutil.which("google-chrome") or "",
]


def code_block(path, title):
    with open(path, encoding="utf-8") as f:
        src = f.read()
    lines = src.rstrip("\n").split("\n")
    body = "\n".join(f'<span class="ln">{i + 1:4d}</span>  {html.escape(l)}' for i, l in enumerate(lines))
    return f'<h3 class="code-title">{html.escape(title)}</h3><pre class="code">{body}</pre>'


def results_table(res):
    rows = []
    for p in res["snr_curve"]:
        q = "—" if p["q_med"] is None else f'{p["q_med"]:.1f} dB'
        rows.append(f'<tr><td>{p["snr"]:+d} dB</td><td>{p["detected"]}/{p["n"]}</td>'
                    f'<td><b>{p["ok"]}/{p["n"]}</b> ({100 * p["ok"] / p["n"]:.0f}%)</td><td>{q}</td></tr>')
    return "\n".join(rows)


def small_table(items, key, fmt):
    return "\n".join(f"<tr><td>{fmt(it)}</td><td><b>{it['ok']}/{it['n']}</b></td></tr>" for it in items)


def main():
    with open(os.path.join(DOCS, "guide_bn.html"), encoding="utf-8") as f:
        page = f.read()
    with open(os.path.join(RES, "results.json")) as f:
        res = json.load(f)

    rep = {
        "{{SNR_TABLE}}": results_table(res),
        "{{REVERB_TABLE}}": small_table(res["reverb"], "r_wall", lambda it: f"দেয়ালের reflection = {it['r_wall']}"),
        "{{CLOCK_TABLE}}": small_table(res["clock"], "fs_err",
                                       lambda it: f"Fs মাপার ভুল {it['fs_err'] * 100:.1f}% , timing tracker "
                                                  f"{'চালু' if it['tracking'] else 'বন্ধ'}"),
        "{{INTF_TABLE}}": small_table(res["interference"], "case", lambda it: it["case"]),
        "{{FA_SECONDS}}": str(res["false_alarm"]["seconds"]),
        "{{FA_TRIG}}": str(res["false_alarm"]["preamble_triggers"]),
        "{{FA_PKTS}}": str(res["false_alarm"]["packets"]),
        "{{CODE_CONFIG}}": code_block(os.path.join(FW, "config.h"), "firmware/DuburiModem/config.h"),
        "{{CODE_INO}}": code_block(os.path.join(FW, "DuburiModem.ino"), "firmware/DuburiModem/DuburiModem.ino"),
        "{{CODE_CORE_H}}": code_block(os.path.join(FW, "am_core.h"), "firmware/DuburiModem/am_core.h"),
        "{{CODE_CORE_C}}": code_block(os.path.join(FW, "am_core.c"), "firmware/DuburiModem/am_core.c"),
        "{{FIG}}": "figures",
        "{{RES}}": "../sim/results",
    }
    for k, v in rep.items():
        page = page.replace(k, v)
    out_html = os.path.join(DOCS, "_build_guide.html")
    with open(out_html, "w", encoding="utf-8") as f:
        f.write(page)

    chrome = next((c for c in CHROME_CANDIDATES if c and os.path.exists(c)), None)
    if not chrome:
        sys.exit("Chrome/Chromium not found; set CHROME=/path/to/chrome")
    out_pdf = os.path.join(DOCS, "DUBURI_IVC_Guide.pdf")
    subprocess.run([chrome, "--headless", "--no-sandbox", "--disable-gpu", "--no-pdf-header-footer",
                    "--allow-file-access-from-files", "--virtual-time-budget=20000",
                    f"--print-to-pdf={out_pdf}", "file://" + out_html], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.remove(out_html)
    print("wrote", out_pdf)


if __name__ == "__main__":
    main()
