#!/usr/bin/env python3
"""
Round 7 of #1177 — N: M's crop and composition (mark, word, tagline), over ESO's "Majestic Milky Way" photograph (prep.py; CREDITS.md). The
text sits on a soft local darkening so it reads over the dense band, and the
photograph's credit is set small in the bottom-right corner.

Run:  python3 prep.py  then  FONT_DIR=... python3 build.py  then  node render.cjs
      then  python3 jpeg.py
"""
import os, sys, html, base64, importlib.util
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "round-1"))
from build import text, mark  # noqa: E402  (round 1)
_spec = importlib.util.spec_from_file_location("build_r2", os.path.join(HERE, "..", "round-2", "build.py"))
r2 = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(r2)
AD, DRIFT, live_mark = r2.AD, r2.DRIFT, r2.live_mark

GOLD = "#d8b45a"
TAGLINE = "your year, in orbit"
W, H = 1600, 840

def data_uri(name):
    with open(os.path.join(HERE, name), "rb") as f:
        return "data:image/jpeg;base64," + base64.b64encode(f.read()).decode("ascii")

def write(name, body):
    with open(os.path.join(HERE, name), "w") as f:
        f.write(body + "\n")

def banner_n():
    t = AD
    word, _ = text("orbit", "display", 200, 600, 700, 470, t["ink"], ls=0.015)
    tag, _ = text(TAGLINE, "ui", 46, 400, 706, 548, t["mid"])
    credit, cw = text("Photo: ESO/F. Char · CC BY 4.0", "mono", 15, 400, W - 28, H - 22, t["mid"], ls=0.06, anchor="end")
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="Orbit — {TAGLINE}">
<defs><filter id="shade" x="-5%" y="-20%" width="110%" height="150%"><feDropShadow dx="0" dy="1" stdDeviation="4" flood-color="#05070d" flood-opacity=".85"/></filter>
<filter id="soft" x="-30%" y="-40%" width="160%" height="180%"><feGaussianBlur stdDeviation="46"/></filter></defs>
<image href="{data_uri('n-sky.jpg')}" x="0" y="0" width="{W}" height="{H}" preserveAspectRatio="xMidYMid slice"/>
<g transform="translate(160 180) scale(2.4)">{DRIFT}{live_mark(t['mid'], t['sun'], GOLD, sw=7, r_sun=7, r_planet=16)}</g>
<rect x="690" y="300" width="560" height="290" rx="120" fill="{t['bg']}" opacity=".35" filter="url(#soft)"/>
<g filter="url(#shade)">{word}{tag}</g>
<g filter="url(#shade)" opacity=".9">{credit}</g>
</svg>"""

def logo_n():
    t = AD
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200" role="img" aria-label="Orbit">
<defs><clipPath id="tile"><rect width="200" height="200" rx="44"/></clipPath></defs>
<g clip-path="url(#tile)"><rect width="200" height="200" fill="{t['bg']}"/>
<image href="{data_uri('n-sky-tile.jpg')}" x="0" y="0" width="200" height="200" preserveAspectRatio="xMidYMid slice"/></g>
{mark(t["mid"], t["sun"], GOLD, sw=8, r_sun=6.5, r_planet=14.5, scale=62/72)}
</svg>"""

def readme_block(k):
    e = html.escape
    return f"""
<div class="readme">
  <p class="c"><img src="{k}-logo.svg" width="132" alt="Orbit logo"></p>
  <h1 class="c">Orbit</h1>
  <p class="c"><strong>{e(TAGLINE)}</strong></p>
  <p class="c"><a>Features</a> · <a>Quick start</a> · <a>Documentation</a> · <a>Licence</a></p>
  <img class="banner" src="{k}-banner.jpg" alt="Orbit — {e(TAGLINE)}">
  <h2>What it is</h2>
  <p>Orbit keeps a household's recurring obligations — the boiler service, the MOT, the insurance renewal — on one calm chart of the year, and tells you what needs you next.</p>
  <hr>
  <p class="foot"><img src="{k}-logo.svg" width="52" alt=""> <strong>{e(TAGLINE)}</strong></p>
</div>"""

def index():
    css = open(os.path.join(HERE, "..", "round-1", "index.html")).read().split("<style>")[1].split("</style>")[0]
    sec = f"""
<section id="k">
  <header><span class="letter">N</span><h2>Into the palette</h2><p>M's crop and composition; the photograph graded hard into After Dark's inks — desaturated to the pack's black-blue, field darkened, core calmed to a cool glow — with its stars and dust lanes kept. The mono line is dropped.</p>
  <p class="files"><a href="n-logo.svg">n-logo.svg</a> · <a href="n-banner.svg">n-banner.svg</a> · <a href="n-banner.jpg">n-banner.jpg</a> · <a href="n-banner@2x.jpg">n-banner@2x.jpg</a></p></header>
  <div class="pair">
    <div class="page light" id="n-light">{readme_block("n")}</div>
    <div class="page dark" id="n-dark">{readme_block("n")}</div>
  </div>
</section>"""
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orbit — README art, round 7 (#1177)</title>
<style>{css}</style></head><body><main>
<h1 class="top">Orbit — README banner and logo, round 7 (#1177)</h1>
<p class="lead">One option: M's photograph graded into Orbit's After Dark palette. As the README would show it, on a white page and a dark page: header logo at 132px, the banner PNG, footer logo at 52px.</p>
{sec}
</main></body></html>"""

if __name__ == "__main__":
    write("n-banner.svg", banner_n()); write("n-logo.svg", logo_n()); write("index.html", index())
    print("wrote n-banner.svg, n-logo.svg, index.html")
