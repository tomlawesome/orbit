#!/usr/bin/env python3
"""
Round 3 of #1177 — three refinements of round 2's E (Galactic plane).

Owner, 2026-10-01: E chosen; "I'd like to see three more versions of E though,
more elegant, more polished. Each distinct though along the same identity."
Then two rulings (same day), recorded in design/owner-decisions.md §2 and the
CON-19 row of design/polish-register.md:
  - the ring is the standard mark proportion (ring, planet, centre dot, the
    word plain beside or under), not the sign-in's thin cut;
  - the planet is always gold #d8b45a outside the app's own themed screens:
    "The simple ring and planet is orbit's brand identity, and for something
    like this, it's always the gold colour."

So all three carry the same mark and vary on everything else:
  H  horizontal lockup left of centre; the river crosses gently behind
  I  stacked lockup, centred, the mark large; a steeper, denser river
  J  one quiet line, the mark small; a level river low on the sky, most air

Elegance here means restraint: the base starfield at three-quarter strength,
a river of a few hundred fine stars rather than seventeen hundred, haze built
from four soft strokes with small opacity steps, more air round the lockup,
the word smaller than round 2, Inter for the tagline and no mono line.

Imports the text outliner, starfield and mark from round 1, and the drift
and live mark from round 2 (both rounds are history; neither is changed).
Run:  FONT_DIR=... python3 build.py   then   node render.cjs
"""
import os, sys, math, html, importlib.util
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "round-1"))
from build import text, star_tiles, park_miller, mark  # noqa: E402  (round 1)
_spec = importlib.util.spec_from_file_location("build_r2", os.path.join(HERE, "..", "round-2", "build.py"))
r2 = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(r2)
AD, DRIFT, live_mark = r2.AD, r2.DRIFT, r2.live_mark

GOLD = "#d8b45a"          # star-chart --accent: the brand's planet, everywhere outside the app
TAGLINE = "your year, in orbit"
W, H = 1600, 840
SVG = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" '
       'role="img" aria-label="{label}">')

def write(name, body):
    with open(os.path.join(HERE, name), "w") as f:
        f.write(body + "\n")

def filters(k=1.0):
    """Blur filters with an absolute region: a near-level river has a tiny
    bounding box, and a percentage region would clip its haze into hard
    horizontal edges (seen in the first render of J)."""
    region = 'filterUnits="userSpaceOnUse" x="-400" y="-400" width="2400" height="1640"' if k == 1.0 else \
             'filterUnits="userSpaceOnUse" x="-100" y="-100" width="400" height="400"'
    return "".join(
        f'<filter id="b{n}" {region}><feGaussianBlur stdDeviation="{n*k:.1f}"/></filter>'
        for n in (70, 45, 30, 18))

def river(x0, y0, x1, y1, width, n=480, seed=20260816, scale=1.0):
    """After dark's plane, refined: four soft strokes in small opacity steps
    (cool wide, cool mid, warm core, dust lane) and a sparse, fine star
    population along the band."""
    t = AD
    rng = park_miller(seed)
    L = math.hypot(x1 - x0, y1 - y0); ux, uy = (x1 - x0) / L, (y1 - y0) / L; nx, ny = -uy, ux
    stars = []
    for _ in range(n):
        u = rng() * L
        v = (rng() + rng() + rng() - 1.5) / 1.5 * width * 0.5
        x, y = x0 + ux * u + nx * v, y0 + uy * u + ny * v
        r = (0.3 + rng() * 0.6) * scale
        o = 0.18 + rng() * 0.5
        warm = rng() < 0.25
        stars.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.2f}" opacity="{o:.2f}" '
                     f'fill="{t["planestarwarm"] if warm else t["planestar"]}"/>')
    d = f"M{x0} {y0} L{x1} {y1}"
    off = f'transform="translate({nx*width*0.1:.0f} {ny*width*0.1:.0f})"'
    return (f'<g fill="none">'
            f'<path d="{d}" stroke="{t["planecool"]}" stroke-opacity=".07" stroke-width="{width*2.0:.0f}" filter="url(#b70)"/>'
            f'<path d="{d}" stroke="{t["planecool"]}" stroke-opacity=".09" stroke-width="{width*1.1:.0f}" filter="url(#b45)"/>'
            f'<path d="{d}" stroke="{t["planewarm"]}" stroke-opacity=".10" stroke-width="{width*0.5:.0f}" filter="url(#b30)"/>'
            f'<path d="{d}" stroke="{t["planedust"]}" stroke-opacity=".5" stroke-width="{width*0.13:.0f}" filter="url(#b18)" {off}/>'
            f'</g><g>{"".join(stars)}</g>')

def sky(t=AD):
    return (f'<rect width="{W}" height="{H}" fill="{t["bg"]}"/>'
            f'<g transform="translate(0 -80)">{star_tiles(t["starfar"], t["starnear"], lambda x, y: 0.72)}</g>')

def the_mark(x, y, s):
    """CON-19's mark at its standard proportion, gold planet, drifting."""
    t = AD
    return (f'<g transform="translate({x - 100*s:.0f} {y - 100*s:.0f}) scale({s})">{DRIFT}'
            f'{live_mark(t["mid"], t["sun"], GOLD, sw=7, r_sun=7, r_planet=16)}</g>')

# ================================================================ H · beside, river crossing gently
def banner_h():
    t = AD
    word, _ = text("orbit", "display", 150, 600, 480, 472, t["ink"], ls=0.015)
    tag, _ = text(TAGLINE, "ui", 34, 400, 486, 540, t["mid"])
    return f"""{SVG.format(w=W, h=H, label="Orbit — " + TAGLINE)}
<defs>{filters()}</defs>
{sky()}
{river(-100, 200, 1700, 700, 220)}
{the_mark(330, 420, 1.3)}
{word}
{tag}
</svg>"""

# ================================================================ I · stacked, the mark large, steeper denser river
def banner_i():
    t = AD
    cx = 800
    word, _ = text("orbit", "display", 120, 600, cx, 650, t["ink"], ls=0.015, anchor="middle")
    tag, _ = text(TAGLINE, "ui", 30, 400, cx, 712, t["mid"], anchor="middle")
    return f"""{SVG.format(w=W, h=H, label="Orbit — " + TAGLINE)}
<defs>{filters()}</defs>
{sky()}
{river(-100, 40, 1700, 760, 260, n=820, scale=1.1)}
{the_mark(cx, 330, 2.0)}
{word}
{tag}
</svg>"""

# ================================================================ J · one quiet line, the mark small, level river low
def banner_j():
    t = AD
    word, w = text("orbit", "display", 120, 600, 0, 0, t["ink"], ls=0.015)   # measure only
    gap, ms = 56, 0.95                                                       # mark ring r 68
    total = 144 * ms + gap + w
    x0 = (W - total) / 2
    word, _ = text("orbit", "display", 120, 600, x0 + 144 * ms + gap, 404, t["ink"], ls=0.015)
    tag, _ = text(TAGLINE, "ui", 28, 400, 800, 480, t["faint"], anchor="middle", ls=0.02)
    return f"""{SVG.format(w=W, h=H, label="Orbit — " + TAGLINE)}
<defs>{filters()}</defs>
{sky()}
{river(-100, 690, 1700, 620, 170, n=300, seed=17170812, scale=0.9)}
{the_mark(x0 + 72 * ms, 362, ms)}
{word}
{tag}
</svg>"""

# ================================================================ logos — after-dark tiles, each option's river
def tile(river_args, seed, n=120):
    t = AD
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200" role="img" aria-label="Orbit">
<defs><clipPath id="tile"><rect width="200" height="200" rx="44"/></clipPath>{filters(0.22)}</defs>
<g clip-path="url(#tile)"><rect width="200" height="200" fill="{t['bg']}"/>{river(*river_args, n=n, seed=seed, scale=0.55)}</g>
{mark(t["mid"], t["sun"], GOLD, sw=8, r_sun=6.5, r_planet=14.5, scale=62/72)}
</svg>"""

def logo_h(): return tile((-30, 60, 230, 150, 60), 4242)
def logo_i(): return tile((-30, 10, 230, 200, 66), 4343, n=180)
def logo_j(): return tile((-30, 168, 230, 158, 44), 4444, n=80)

# ================================================================ index
OPTIONS = [
    ("h", "Beside", "The horizontal lockup left of centre, the mark at a third again its home size; the river crosses gently behind it."),
    ("i", "Stacked", "The mark large and centred over the word, the login's stacked composition; a steeper, denser river runs through the ring."),
    ("j", "One line", "The quietest: a small mark and the word on one centred line, the tagline faint beneath, and the river level and low on the sky."),
]

def readme_block(k):
    e = html.escape
    return f"""
<div class="readme">
  <p class="c"><img src="{k}-logo.svg" width="132" alt="Orbit logo"></p>
  <h1 class="c">Orbit</h1>
  <p class="c"><strong>{e(TAGLINE)}</strong></p>
  <p class="c"><a>Features</a> · <a>Quick start</a> · <a>Documentation</a> · <a>Licence</a></p>
  <img class="banner" src="{k}-banner.svg" alt="Orbit — {e(TAGLINE)}">
  <h2>What it is</h2>
  <p>Orbit keeps a household's recurring obligations — the boiler service, the MOT, the insurance renewal — on one calm chart of the year, and tells you what needs you next.</p>
  <hr>
  <p class="foot"><img src="{k}-logo.svg" width="52" alt=""> <strong>{e(TAGLINE)}</strong></p>
</div>"""

def index():
    secs = []
    for k, title, blurb in OPTIONS:
        secs.append(f"""
<section id="{k}">
  <header><span class="letter">{k.upper()}</span><h2>{html.escape(title)}</h2><p>{html.escape(blurb)}</p>
  <p class="files"><a href="{k}-logo.svg">{k}-logo.svg</a> · <a href="{k}-banner.svg">{k}-banner.svg</a> · <a href="{k}-banner.png">{k}-banner.png</a></p></header>
  <div class="pair">
    <div class="page light" id="{k}-light">{readme_block(k)}</div>
    <div class="page dark" id="{k}-dark">{readme_block(k)}</div>
  </div>
</section>""")
    css = open(os.path.join(HERE, "..", "round-1", "index.html")).read().split("<style>")[1].split("</style>")[0]
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orbit — README art, round 3 (#1177)</title>
<style>{css}</style></head><body><main>
<h1 class="top">Orbit — README banner and logo, round 3 (#1177)</h1>
<p class="lead">Three refinements of round 2's E, the galactic plane, all on the standard mark with the gold planet. Each as the README would show it, on a white page and a dark page: header logo at 132px, banner, footer logo at 52px. Text outlined; the banner SVGs drift the planet once per 40s, the PNGs are stills.</p>
{"".join(secs)}
</main></body></html>"""

if __name__ == "__main__":
    for k, fb, fl in (("h", banner_h, logo_h), ("i", banner_i, logo_i), ("j", banner_j, logo_j)):
        write(f"{k}-banner.svg", fb()); write(f"{k}-logo.svg", fl())
    write("index.html", index())
    print("wrote 6 svg + index.html")
