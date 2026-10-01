#!/usr/bin/env python3
"""
Round 8 of #1177 — three directions that break with "the mark over a star
field". Owner on round 7 (2026-10-01, 40): "Try something totally different."

  O  Terminator — the night side of a planet's limb across the lower third, a
     thin line of dawn along its edge with a faint atmosphere, the mark and
     word above it in the dark. From design/v19/dawn-terminator.html and the
     sign-in's "first light" (owner-decisions §9), kept dark.
  P  The year turns — the dial's own rule, in motion: a ring with twelve
     month ticks, bodies drifting inward toward the sun along the law's
     spiral (angle advances as the radius shrinks), one reaching perihelion
     and swinging back out to next year. CSS animation only, no script, so
     the SVG plays inside a README <img>; prefers-reduced-motion gets the
     still. The PNG is the still.
  Q  The chart room — the product itself: the ratified after-dark home
     screen (design/v19/afterdark-plane.html, captured at 2× by prep.py; the
     fixture app needs a server and data, the mockup is the ratified
     screen), cropped clear of its demo chrome and dimmed, the mark and word
     set over the quiet left.

All three: dark, the standard mark with the gold planet, "your year, in
orbit", the word plain (CON-19). Text outlined. Imports round 1's text
outliner, starfield and mark and round 2's drift and After Dark tokens.
Run:  python3 prep.py  then  FONT_DIR=... python3 build.py  then  node render.cjs  then  python3 jpeg.py
"""
import os, sys, math, html, base64, importlib.util
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "round-1"))
from build import text, star_tiles, mark  # noqa: E402
_spec = importlib.util.spec_from_file_location("build_r2", os.path.join(HERE, "..", "round-2", "build.py"))
r2 = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(r2)
AD, DRIFT, live_mark = r2.AD, r2.DRIFT, r2.live_mark

GOLD = "#d8b45a"
TAGLINE = "your year, in orbit"
W, H = 1600, 840
SVG = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" '
       'role="img" aria-label="{label}">')
OK, WARM_T, UP, OVER = "#4ade80", "#f0b429", "#7dd3fc", "#f87171"   # after dark's status tokens
DAWN_SUN = "#eda253"                                                 # dawn's --sun, the ember

def write(name, body):
    with open(os.path.join(HERE, name), "w") as f:
        f.write(body + "\n")

def the_mark(x, y, s):
    t = AD
    return (f'<g transform="translate({x - 100*s:.0f} {y - 100*s:.0f}) scale({s})">{DRIFT}'
            f'{live_mark(t["mid"], t["sun"], GOLD, sw=7, r_sun=7, r_planet=16)}</g>')

def sky(fade=0.72):
    t = AD
    return (f'<rect width="{W}" height="{H}" fill="{t["bg"]}"/>'
            f'<g transform="translate(0 -80)">{star_tiles(t["starfar"], t["starnear"], lambda x, y: fade)}</g>')

def tile_open(extra_defs=""):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200" role="img" aria-label="Orbit">'
            f'<defs><clipPath id="tile"><rect width="200" height="200" rx="44"/></clipPath>{extra_defs}</defs>')

TILE_MARK = lambda: mark(AD["mid"], AD["sun"], GOLD, sw=8, r_sun=6.5, r_planet=14.5, scale=62/72)

# ================================================================ O · Terminator
def banner_o():
    t = AD
    R, cx = 3000.0, 800.0
    top = 560.0                                   # the limb's highest point
    cy = top + R
    word, _ = text("orbit", "display", 150, 600, 690, 382, t["ink"], ls=0.015)
    tag, _ = text(TAGLINE, "ui", 34, 400, 696, 446, t["mid"])
    # the planet's night side, its limb, and the dawn along the edge
    return f"""{SVG.format(w=W, h=H, label="Orbit — " + TAGLINE)}
<defs>
  <linearGradient id="dawn" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="{DAWN_SUN}" stop-opacity="0"/><stop offset=".45" stop-color="{DAWN_SUN}" stop-opacity=".25"/>
    <stop offset=".74" stop-color="#ffe3b0" stop-opacity="1"/><stop offset=".9" stop-color="{DAWN_SUN}" stop-opacity=".5"/>
    <stop offset="1" stop-color="{DAWN_SUN}" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="scatter" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="{UP}" stop-opacity="0"/><stop offset=".5" stop-color="{UP}" stop-opacity=".10"/>
    <stop offset=".75" stop-color="#ffcf94" stop-opacity=".26"/><stop offset="1" stop-color="{UP}" stop-opacity="0"/>
  </linearGradient>
  <radialGradient id="firstlight" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#ffd9a3" stop-opacity=".55"/><stop offset=".4" stop-color="{DAWN_SUN}" stop-opacity=".14"/><stop offset="1" stop-color="{DAWN_SUN}" stop-opacity="0"/></radialGradient>
  <filter id="b6" filterUnits="userSpaceOnUse" x="-200" y="-200" width="2000" height="1240"><feGaussianBlur stdDeviation="6"/></filter>
  <filter id="b28" filterUnits="userSpaceOnUse" x="-200" y="-200" width="2000" height="1240"><feGaussianBlur stdDeviation="28"/></filter>
  <clipPath id="above"><rect x="0" y="0" width="{W}" height="{H}"/></clipPath>
</defs>
{sky(0.8)}
<ellipse cx="1190" cy="{top + 40:.0f}" rx="520" ry="150" fill="url(#firstlight)"/>
<circle cx="{cx}" cy="{cy}" r="{R}" fill="none" stroke="url(#scatter)" stroke-width="90" filter="url(#b28)"/>
<circle cx="{cx}" cy="{cy}" r="{R}" fill="#02030a"/>
<circle cx="{cx}" cy="{cy}" r="{R}" fill="none" stroke="url(#dawn)" stroke-width="9" filter="url(#b6)" opacity=".8"/>
<circle cx="{cx}" cy="{cy}" r="{R}" fill="none" stroke="url(#dawn)" stroke-width="2.2"/>
{the_mark(560, 332, 1.2)}
{word}
{tag}
</svg>"""

def logo_o():
    t = AD
    return f"""{tile_open('''<linearGradient id="dawn" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#eda253" stop-opacity=".1"/><stop offset=".7" stop-color="#ffe3b0"/><stop offset="1" stop-color="#eda253" stop-opacity=".2"/></linearGradient>
<filter id="b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="4"/></filter>''')}
<g clip-path="url(#tile)"><rect width="200" height="200" fill="{t['bg']}"/>
<g fill="{t['starfar']}"><circle cx="30" cy="34" r="1.2" opacity=".55"/><circle cx="150" cy="22" r=".9" opacity=".5"/><circle cx="176" cy="70" r="1" opacity=".4"/><circle cx="24" cy="118" r=".8" opacity=".4"/></g>
<circle cx="100" cy="760" r="600" fill="none" stroke="url(#dawn)" stroke-width="10" filter="url(#b)" opacity=".7"/>
<circle cx="100" cy="760" r="600" fill="#02030a"/>
<circle cx="100" cy="760" r="600" fill="none" stroke="url(#dawn)" stroke-width="1.6"/></g>
{mark(t["mid"], t["sun"], GOLD, sw=8, r_sun=6.5, r_planet=14.5, scale=56/72, cy=92)}
</svg>"""

# ================================================================ P · The year turns
YEAR = 60      # seconds per year
RMAX, RMIN = 300, 118

def body(phase, colour, r=8):
    """One body at phase p of its year (0 = just entered, 1 = back out).
    Inline transforms give the still; the animations override them."""
    ang = 360 * phase
    rad = RMAX - (RMAX - RMIN) * min(phase / 0.92, 1.0) if phase < 0.92 else RMIN + (RMAX - RMIN) * (phase - 0.92) / 0.08
    return (f'<g class="orbit" style="transform:rotate({ang:.0f}deg);animation-delay:-{YEAR*phase:.1f}s">'
            f'<g class="fall" style="transform:translateX({rad:.0f}px);animation-delay:-{YEAR*phase:.1f}s">'
            f'<circle r="{r}" fill="{colour}"/></g></g>')

def banner_p():
    t = AD
    cx, cy = 1130, 420
    word, _ = text("orbit", "display", 150, 600, 420, 452, t["ink"], ls=0.015)
    tag, _ = text(TAGLINE, "ui", 34, 400, 426, 516, t["mid"])
    ticks = "".join(
        f'<line x1="{cx + RMAX*math.cos(a):.1f}" y1="{cy + RMAX*math.sin(a):.1f}" x2="{cx + (RMAX-12)*math.cos(a):.1f}" y2="{cy + (RMAX-12)*math.sin(a):.1f}"/>'
        for a in (math.radians(i * 30 - 90) for i in range(12)))
    bodies = "".join([body(0.97, OK, 7), body(0.86, WARM_T, 9), body(0.62, UP, 8), body(0.38, OK, 6), body(0.15, UP, 7)])
    return f"""{SVG.format(w=W, h=H, label="Orbit — " + TAGLINE)}
<style>
@keyframes spinback{{to{{transform:rotate(360deg)}}}}
.tr{{animation:spinback 40s linear infinite;transform-origin:100px 100px}}
@keyframes turn{{to{{transform:rotate(360deg)}}}}
@keyframes fall{{0%{{transform:translateX({RMAX}px)}}92%{{transform:translateX({RMIN}px)}}100%{{transform:translateX({RMAX}px)}}}}
.orbit{{animation:turn {YEAR}s linear infinite;transform-origin:0 0}}
.fall{{animation:fall {YEAR}s linear infinite}}
@media (prefers-reduced-motion:reduce){{.tr,.orbit,.fall{{animation:none}}}}
</style>
<defs><filter id="sunf" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="9"/></filter></defs>
{sky(0.85)}
<g transform="translate({cx} {cy})">
  <circle r="{RMAX}" fill="none" stroke="{t['faint']}" stroke-opacity=".7" stroke-width="1.5"/>
  <circle r="{RMIN}" fill="none" stroke="{OVER}" stroke-opacity=".35" stroke-width="1" stroke-dasharray="3 6"/>
  <path d="M0 {-RMAX-2} l6 9 h-12 Z" fill="{t['accent']}"/>
  <circle r="13" fill="{t['sun']}" filter="url(#sunf)" opacity=".85"/>
  <circle r="7" fill="{t['suncore']}"/>
  {bodies}
</g>
<g stroke="{t['faint']}" stroke-opacity=".7" stroke-width="1.5">{ticks}</g>
{the_mark(280, 400, 1.1)}
{word}
{tag}
</svg>"""

def logo_p():
    t = AD
    return f"""{tile_open()}
<g clip-path="url(#tile)"><rect width="200" height="200" fill="{t['bg']}"/>
<g fill="{t['starfar']}"><circle cx="34" cy="28" r="1.3" opacity=".6"/><circle cx="150" cy="22" r="1" opacity=".5"/><circle cx="22" cy="120" r="1" opacity=".45"/><circle cx="60" cy="172" r="1.4" opacity=".55"/><circle cx="178" cy="60" r=".9" opacity=".4"/><circle cx="118" cy="40" r=".8" opacity=".4"/><circle cx="168" cy="166" r="1.1" opacity=".5"/></g></g>
{TILE_MARK()}
</svg>"""

# ================================================================ Q · The chart room
def data_uri(name):
    with open(os.path.join(HERE, name), "rb") as f:
        return "data:image/jpeg;base64," + base64.b64encode(f.read()).decode("ascii")

def banner_q():
    t = AD
    word, _ = text("orbit", "display", 120, 600, 260, 540, t["ink"], ls=0.015, anchor="middle")
    tag, _ = text(TAGLINE, "ui", 30, 400, 260, 596, t["mid"], anchor="middle")
    return f"""{SVG.format(w=W, h=H, label="Orbit — " + TAGLINE)}
<defs><filter id="shade" x="-5%" y="-20%" width="110%" height="150%"><feDropShadow dx="0" dy="1" stdDeviation="4" flood-color="#05070d" flood-opacity=".85"/></filter>
<filter id="soft" filterUnits="userSpaceOnUse" x="-200" y="-200" width="2000" height="1240"><feGaussianBlur stdDeviation="50"/></filter></defs>
<image href="{data_uri('q-room.jpg')}" x="0" y="0" width="{W}" height="{H}" preserveAspectRatio="xMidYMid slice"/>
{the_mark(260, 330, 1.0)}
<g filter="url(#shade)">{word}{tag}</g>
</svg>"""

# ================================================================ index
OPTIONS = [
    ("o", "Terminator", "The night side of a planet's limb across the lower third, a thin line of dawn along its edge with a faint atmosphere; the mark and word rise above it in the dark.", "o-banner.png"),
    ("p", "The year turns", "The dial's rule in motion: twelve month ticks, bodies drifting inward along the law's spiral, one reaching perihelion and swinging back out to next year. The SVG animates (CSS only); the PNG is the still.", "p-banner.svg"),
    ("q", "The chart room", "The product itself: the ratified after-dark home screen, cropped clear of its chrome and dimmed, the mark and word over its quiet left.", "q-banner.jpg"),
]

def readme_block(k, banner):
    e = html.escape
    return f"""
<div class="readme">
  <p class="c"><img src="{k}-logo.svg" width="132" alt="Orbit logo"></p>
  <h1 class="c">Orbit</h1>
  <p class="c"><strong>{e(TAGLINE)}</strong></p>
  <p class="c"><a>Features</a> · <a>Quick start</a> · <a>Documentation</a> · <a>Licence</a></p>
  <img class="banner" src="{banner}" alt="Orbit — {e(TAGLINE)}">
  <h2>What it is</h2>
  <p>Orbit keeps a household's recurring obligations — the boiler service, the MOT, the insurance renewal — on one calm chart of the year, and tells you what needs you next.</p>
  <hr>
  <p class="foot"><img src="{k}-logo.svg" width="52" alt=""> <strong>{e(TAGLINE)}</strong></p>
</div>"""

def index():
    css = open(os.path.join(HERE, "..", "round-1", "index.html")).read().split("<style>")[1].split("</style>")[0]
    secs = []
    for k, title, blurb, banner in OPTIONS:
        files = {"o": "o-logo.svg · o-banner.svg · o-banner.png", "p": "p-logo.svg · p-banner.svg (animated) · p-banner.png (still)",
                 "q": "q-logo.svg (N's tile, unchanged) · q-banner.svg · q-banner.jpg · q-banner@2x.jpg"}[k]
        secs.append(f"""
<section id="{k}">
  <header><span class="letter">{k.upper()}</span><h2>{html.escape(title)}</h2><p>{html.escape(blurb)}</p>
  <p class="files">{html.escape(files)}</p></header>
  <div class="pair">
    <div class="page light" id="{k}-light">{readme_block(k, banner)}</div>
    <div class="page dark" id="{k}-dark">{readme_block(k, banner)}</div>
  </div>
</section>""")
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orbit — README art, round 8 (#1177)</title>
<style>{css}</style></head><body><main>
<h1 class="top">Orbit — README banner and logo, round 8 (#1177)</h1>
<p class="lead">Three directions that break with the mark over a star field. Each as the README would show it, on a white page and a dark page: header logo at 132px, the banner, footer logo at 52px. P's banner is the animated SVG; it plays here as it would on GitHub.</p>
{"".join(secs)}
</main></body></html>"""

if __name__ == "__main__":
    write("o-banner.svg", banner_o()); write("o-logo.svg", logo_o())
    write("p-banner.svg", banner_p()); write("p-logo.svg", logo_p())
    write("q-banner.svg", banner_q())
    with open(os.path.join(HERE, "..", "round-7", "n-logo.svg")) as f:   # Q reuses N's tile, unchanged
        write("q-logo.svg", f.read().rstrip("\n"))
    write("index.html", index())
    print("wrote o/p/q")
