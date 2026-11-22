#!/usr/bin/env python3
"""Copy the COMMON CSS / COMMON JS blocks from sender.html into receiver.html.

Both pages must stay single self-contained files, so the shared code is
duplicated. Edit it in sender.html, then run:  python3 pc/sync_common.py
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


def main():
    src = open(os.path.join(HERE, "sender.html"), encoding="utf-8").read()
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
    open(path, "w", encoding="utf-8").write(dst)
    print("receiver.html updated")


if __name__ == "__main__":
    main()
