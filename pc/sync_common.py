#!/usr/bin/env python3
"""Copy the COMMON CSS / COMMON JS blocks from sender.html into receiver.html,
and put pc/amcore.js (the JavaScript modem) into both pages.

phone_receiver.html gets only amcore.js. All pages must stay single self-contained files, so the shared code is
duplicated. Edit it in sender.html / amcore.js, then run:  python3 pc/sync_common.py
"""
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
BLOCKS = [
    ("/* ===== COMMON CSS START", "/* ===== COMMON CSS END ===== */", "/*@@COMMON_CSS@@*/"),
    ("/* ===== COMMON JS START", "/* ===== COMMON JS END ===== */", "/*@@COMMON_JS@@*/"),
]


def block(text, start, end):
    i = text.index(start)
    j = text.index(end, i) + len(end)
    return i, j


AM_START, AM_END = "/* ===== AMCORE START", "/* ===== AMCORE END ===== */"


def put_amcore(text, core):
    if AM_START in text:
        a, b = block(text, AM_START, AM_END)
        return text[:a] + core + text[b:]
    i = text.index("/* ===== COMMON JS START")
    return text[:i] + core + "\n" + text[i:]


def main():
    core = open(os.path.join(HERE, "amcore.js"), encoding="utf-8").read()
    core = core[core.index(AM_START):core.index(AM_END) + len(AM_END)]
    spath = os.path.join(HERE, "sender.html")
    src = put_amcore(open(spath, encoding="utf-8").read(), core)
    open(spath, "w", encoding="utf-8").write(src)
    path = os.path.join(HERE, "receiver.html")
    dst = open(path, encoding="utf-8").read()
    for start, end, placeholder in BLOCKS:
        i, j = block(src, start, end)
        common = src[i:j]
        if placeholder in dst:
            dst = dst.replace(placeholder, common)
        else:
            a, b = block(dst, start, end)
            dst = dst[:a] + common + dst[b:]
    dst = put_amcore(dst, core)
    open(path, "w", encoding="utf-8").write(dst)
    ppath = os.path.join(HERE, "phone_receiver.html")        # phone page: only the modem
    phone = put_amcore(open(ppath, encoding="utf-8").read(), core)   # read first, then write
    open(ppath, "w", encoding="utf-8").write(phone)
    print("sender.html, receiver.html and phone_receiver.html updated")


if __name__ == "__main__":
    main()
