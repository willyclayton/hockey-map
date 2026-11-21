#!/usr/bin/env python3
"""Stamp a cache-busting ?v= on every stylesheet, script and module import so browsers never mix
old and new files after a deploy (GitHub Pages lets browsers cache for 10 minutes).
Every import of a module must use the same URL, or the browser loads it twice; this keeps them equal.

    python3 scripts/bump_version.py
"""
import glob, os, re, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
v = time.strftime("%Y%m%d%H%M")
pat = re.compile(r"""((?:href|src)="(?:css|js)/[\w.-]+\.(?:css|js)|from '\./[\w.-]+\.js)(\?v=\w+)?""")
for f in [os.path.join(ROOT, "index.html")] + glob.glob(os.path.join(ROOT, "js", "*.js")):
    s = open(f, encoding="utf-8").read()
    n = pat.sub(lambda m: f"{m.group(1)}?v={v}", s)
    if n != s:
        open(f, "w", encoding="utf-8").write(n)
print("version", v)
