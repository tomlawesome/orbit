#!/usr/bin/env python3
"""
Round 5 of #1177 — L: K's composition exactly (mark, word, tagline, river
angle), over sky.py's stars-first plane. Owner on K (2026-10-01): "Looks like
a big blob. I'd say it's worse now."; 29b: iterate, same composition, more
contrast and visible structure at README size.

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

def banner_l():
    t = AD
    word, _ = text("orbit", "display", 200, 600, 700, 470, t["ink"], ls=0.015)
    tag, _ = text(TAGLINE, "ui", 46, 400, 706, 548, t["mid"])
    mis, _ = text("lights out, ink up · after dark", "mono", 18, 400, 708, 608, t["faint"], ls=0.1)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="Orbit — {TAGLINE}">
<defs><filter id="shade" x="-5%" y="-20%" width="110%" height="150%"><feDropShadow dx="0" dy="1" stdDeviation="4" flood-color="#05070d" flood-opacity=".85"/></filter></defs>
<image href="{data_uri('l-sky.jpg')}" x="0" y="0" width="{W}" height="{H}" preserveAspectRatio="xMidYMid slice"/>
<g transform="translate(160 180) scale(2.4)">{DRIFT}{live_mark(t['mid'], t['sun'], GOLD, sw=7, r_sun=7, r_planet=16)}</g>
<g filter="url(#shade)">{word}{tag}{mis}</g>
</svg>"""

def logo_l():
    t = AD
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200" role="img" aria-label="Orbit">
<defs><clipPath id="tile"><rect width="200" height="200" rx="44"/></clipPath></defs>
<g clip-path="url(#tile)"><rect width="200" height="200" fill="{t['bg']}"/>
<image href="{data_uri('l-sky-tile.jpg')}" x="0" y="0" width="200" height="200" preserveAspectRatio="xMidYMid slice"/></g>
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
  <header><span class="letter">L</span><h2>Stars first</h2><p>K's composition exactly; the sky rebuilt out of stars sized to read at README width, a crisp dark rift, a thin core glow, high contrast (sky.py).</p>
  <p class="files"><a href="l-logo.svg">l-logo.svg</a> · <a href="l-banner.svg">l-banner.svg</a> · <a href="l-banner.png">l-banner.png</a></p></header>
  <div class="pair">
    <div class="page light" id="l-light">{readme_block("l")}</div>
    <div class="page dark" id="l-dark">{readme_block("l")}</div>
  </div>
</section>"""
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orbit — README art, round 5 (#1177)</title>
<style>{css}</style></head><body><main>
<h1 class="top">Orbit — README banner and logo, round 5 (#1177)</h1>
<p class="lead">One option: K's composition, the sky rebuilt stars-first for contrast and structure at README size. As the README would show it, on a white page and a dark page: header logo at 132px, the banner PNG, footer logo at 52px.</p>
{sec}
</main></body></html>"""

if __name__ == "__main__":
    write("l-banner.svg", banner_l()); write("l-logo.svg", logo_l()); write("index.html", index())
    print("wrote l-banner.svg, l-logo.svg, index.html")
