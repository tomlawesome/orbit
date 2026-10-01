#!/usr/bin/env python3
"""
Round 6 of #1177 — M: K's composition exactly (mark, word, tagline, mono
line), over ESO's "Majestic Milky Way" photograph (prep.py; CREDITS.md). The
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

def banner_m():
    t = AD
    word, _ = text("orbit", "display", 200, 600, 700, 470, t["ink"], ls=0.015)
    tag, _ = text(TAGLINE, "ui", 46, 400, 706, 548, t["mid"])
    mis, _ = text("lights out, ink up · after dark", "mono", 18, 400, 708, 608, t["faint"], ls=0.1)
    credit, cw = text("Photo: ESO/F. Char · CC BY 4.0", "mono", 15, 400, W - 28, H - 22, t["mid"], ls=0.06, anchor="end")
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="Orbit — {TAGLINE}">
<defs><filter id="shade" x="-5%" y="-20%" width="110%" height="150%"><feDropShadow dx="0" dy="1" stdDeviation="4" flood-color="#05070d" flood-opacity=".85"/></filter>
<filter id="soft" x="-30%" y="-40%" width="160%" height="180%"><feGaussianBlur stdDeviation="46"/></filter></defs>
<image href="{data_uri('m-sky.jpg')}" x="0" y="0" width="{W}" height="{H}" preserveAspectRatio="xMidYMid slice"/>
<g transform="translate(160 180) scale(2.4)">{DRIFT}{live_mark(t['mid'], t['sun'], GOLD, sw=7, r_sun=7, r_planet=16)}</g>
<rect x="690" y="300" width="560" height="340" rx="120" fill="{t['bg']}" opacity=".5" filter="url(#soft)"/>
<g filter="url(#shade)">{word}{tag}{mis}</g>
<g filter="url(#shade)" opacity=".9">{credit}</g>
</svg>"""

def logo_m():
    t = AD
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200" role="img" aria-label="Orbit">
<defs><clipPath id="tile"><rect width="200" height="200" rx="44"/></clipPath></defs>
<g clip-path="url(#tile)"><rect width="200" height="200" fill="{t['bg']}"/>
<image href="{data_uri('m-sky-tile.jpg')}" x="0" y="0" width="200" height="200" preserveAspectRatio="xMidYMid slice"/></g>
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
  <header><span class="letter">M</span><h2>The photograph</h2><p>K's composition exactly over ESO's "Majestic Milky Way" (La Silla; ESO/F. Char, CC BY 4.0), rotated to K's angle with the bulge on the right and graded lightly toward After Dark.</p>
  <p class="files"><a href="m-logo.svg">m-logo.svg</a> · <a href="m-banner.svg">m-banner.svg</a> · <a href="m-banner.jpg">m-banner.jpg</a> · <a href="m-banner@2x.jpg">m-banner@2x.jpg</a></p></header>
  <div class="pair">
    <div class="page light" id="m-light">{readme_block("m")}</div>
    <div class="page dark" id="m-dark">{readme_block("m")}</div>
  </div>
</section>"""
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orbit — README art, round 6 (#1177)</title>
<style>{css}</style></head><body><main>
<h1 class="top">Orbit — README banner and logo, round 6 (#1177)</h1>
<p class="lead">One option: K's composition over a real photograph of the plane. As the README would show it, on a white page and a dark page: header logo at 132px, the banner PNG, footer logo at 52px.</p>
{sec}
</main></body></html>"""

if __name__ == "__main__":
    write("m-banner.svg", banner_m()); write("m-logo.svg", logo_m()); write("index.html", index())
    print("wrote m-banner.svg, m-logo.svg, index.html")
