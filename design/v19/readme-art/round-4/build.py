#!/usr/bin/env python3
"""
Round 4 of #1177 — K: round 2's E, with the two rulings applied, over a
photographic galactic plane.

Owner, 2026-10-01 (28d): "None of your new three are any good. I want an
ultra realistic galactic plane with glorious detail." And: "give me a version
of the original with the fixed ring and planet."

So: E's composition as it was — the river crossing at the plane's angle, the
mark over it, the word beside, "your year, in orbit" — with the standard mark
proportion (ring, planet, centre dot; owner ruling 23) and the gold planet
#d8b45a (ruling 24). The sky is sky.py's raster (3200×1680), embedded in the
SVG as JPEG; the mark and the outlined type are vector on top, so the mark
stays flat per CON-19 and the planet drifts once per 40s in the SVG.

Run:  python3 sky.py  then  FONT_DIR=... python3 build.py  then  node render.cjs
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

def banner_k():
    t = AD
    word, _ = text("orbit", "display", 200, 600, 700, 470, t["ink"], ls=0.015)
    tag, _ = text(TAGLINE, "ui", 46, 400, 706, 548, t["mid"])
    mis, _ = text("lights out, ink up · after dark", "mono", 18, 400, 708, 608, t["faint"], ls=0.1)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="Orbit — {TAGLINE}">
<image href="{data_uri('k-sky.jpg')}" x="0" y="0" width="{W}" height="{H}" preserveAspectRatio="xMidYMid slice"/>
<g transform="translate(160 180) scale(2.4)">{DRIFT}{live_mark(t['mid'], t['sun'], GOLD, sw=7, r_sun=7, r_planet=16)}</g>
{word}
{tag}
{mis}
</svg>"""

def logo_k():
    t = AD
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200" role="img" aria-label="Orbit">
<defs><clipPath id="tile"><rect width="200" height="200" rx="44"/></clipPath></defs>
<g clip-path="url(#tile)"><rect width="200" height="200" fill="{t['bg']}"/>
<image href="{data_uri('k-sky-tile.jpg')}" x="0" y="0" width="200" height="200" preserveAspectRatio="xMidYMid slice"/></g>
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
  <img class="banner" src="{k}-banner.png" alt="Orbit — {e(TAGLINE)}">
  <h2>What it is</h2>
  <p>Orbit keeps a household's recurring obligations — the boiler service, the MOT, the insurance renewal — on one calm chart of the year, and tells you what needs you next.</p>
  <hr>
  <p class="foot"><img src="{k}-logo.svg" width="52" alt=""> <strong>{e(TAGLINE)}</strong></p>
</div>"""

def index():
    css = open(os.path.join(HERE, "..", "round-1", "index.html")).read().split("<style>")[1].split("</style>")[0]
    sec = f"""
<section id="k">
  <header><span class="letter">K</span><h2>The original, fixed</h2><p>Round 2's E composition with the standard mark and the gold planet, over a photographic galactic plane rendered at 2× (sky.py).</p>
  <p class="files"><a href="k-logo.svg">k-logo.svg</a> · <a href="k-banner.svg">k-banner.svg</a> · <a href="k-banner.png">k-banner.png</a> · <a href="k-banner@2x.png">k-banner@2x.png</a></p></header>
  <div class="pair">
    <div class="page light" id="k-light">{readme_block('k')}</div>
    <div class="page dark" id="k-dark">{readme_block('k')}</div>
  </div>
</section>"""
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orbit — README art, round 4 (#1177)</title>
<style>{css}</style></head><body><main>
<h1 class="top">Orbit — README banner and logo, round 4 (#1177)</h1>
<p class="lead">One option: round 2's E with the fixed ring and planet, over a photographic plane. As the README would show it, on a white page and a dark page: header logo at 132px, the banner PNG, footer logo at 52px.</p>
{sec}
</main></body></html>"""

if __name__ == "__main__":
    write("k-banner.svg", banner_k()); write("k-logo.svg", logo_k()); write("index.html", index())
    print("wrote k-banner.svg, k-logo.svg, index.html")
