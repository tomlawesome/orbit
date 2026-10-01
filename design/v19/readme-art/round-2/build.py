#!/usr/bin/env python3
"""
Round 2 of #1177 — README banner and logo, dark only, bolder.

Owner verdicts on round 1 (2026-10-01): all three "super boring"; the light
looks don't fit the dark brand; the tagline is CON-11's "your year, in orbit".

This round draws on the moments that make the live app striking, each taken
from a ratified v19 surface and named on each option:
  D  the storm's lean-in (POL-10) and the heliosphere sun (home-heliosphere)
     with the bridge's HUD callout (home-bridge)
  E  after dark's galactic plane (afterdark-plane, §15)
  F  retrograde's neon dial and pink sun (pack-retrograde-refresh)
  G  the gravity well seen in depth: the 404 infall's hot rim and spiralling
     sky (404-infall-spiral), turned on the household's own orbit

The mark itself stays CON-19: three flat shapes, no gradient or glow ON the
mark. Everything behind it — sky, sun, dial, plane — may bloom, because the app
does. Text outlining, the seeded starfield and the mark come from round 1's
build.py (imported; round 1 is history and is not edited by this).

Run:  FONT_DIR=... python3 build.py   then   node render.cjs   (this folder's
      copy of round 1's renderer, lettered d–g).
"""
import os, sys, math, html
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "round-1"))
from build import text, star_tiles, park_miller, mark, SC  # noqa: E402

AD = dict(bg="#05070d", ink="#e7e9ee", mid="#9fa6b2", faint="#717c8e", accent="#7dd3fc",
          sun="#dbe9ff", suncore="#ffffff", line="#1c2434", linesoft="#151b28",
          planewarm="#ffcf94", planecool="#9fb0d6", planestar="#cfd9ee", planestarwarm="#ffdca6",
          planedust="#01020a", starfar="#e9edf8", starnear="#f4f0ff")
RG = dict(bg="#080a14", ink="#eef6ff", mid="#a9d8e6", faint="#6f9fb1", accent="#ff4fd8",
          sun="#ff4fd8", suncore="#fff0fb", line="#2a7f96", linesoft="#164b5c", upcoming="#2de2e6",
          ok="#3ef2a0", warm="#ffd23f", overdue="#ff3864", starfar="#9fd6e6", starnear="#ffffff")

TAGLINE = "your year, in orbit"
W, H = 1600, 840
SVG = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" '
       'role="img" aria-label="{label}">')
DRIFT = ('<style>@keyframes spinback{to{transform:rotate(360deg)}}'
         '.tr{animation:spinback 40s linear infinite;transform-origin:100px 100px}'
         '@media (prefers-reduced-motion:reduce){.tr{animation:none}}</style>')

def write(name, body):
    with open(os.path.join(HERE, name), "w") as f:
        f.write(body + "\n")

def live_mark(ring, sun, planet, sw=7, r_sun=7, r_planet=16):
    """The ratified mark with the one permitted motion: the planet drifts the
    ring once per 40s (CON-19). Local 200-unit coordinates; wrap in a <g>."""
    return (f'<circle cx="100" cy="100" r="72" fill="none" stroke="{ring}" stroke-width="{sw}"/>'
            f'<circle cx="100" cy="100" r="{r_sun}" fill="{sun}"/>'
            f'<g class="tr"><circle cx="163" cy="63.5" r="{r_planet}" fill="{planet}"/></g>')

# ---------------------------------------------------------------- the dial (home.html, tokenised)
BODY_DEFS = """<radialGradient id="p-ruby" cx="34%" cy="30%" r="72%"><stop offset="0%" stop-color="#ffb3ab"/><stop offset="42%" stop-color="#e0453e"/><stop offset="100%" stop-color="#7e1a1f"/></radialGradient>
<radialGradient id="p-jade" cx="34%" cy="30%" r="72%"><stop offset="0%" stop-color="#b8f5cf"/><stop offset="45%" stop-color="#2fae6a"/><stop offset="100%" stop-color="#12603a"/></radialGradient>
<radialGradient id="p-amber" cx="34%" cy="30%" r="72%"><stop offset="0%" stop-color="#ffe1a0"/><stop offset="45%" stop-color="#f0a52b"/><stop offset="100%" stop-color="#8a5a10"/></radialGradient>
<radialGradient id="p-sky" cx="34%" cy="30%" r="72%"><stop offset="0%" stop-color="#cfe4ff"/><stop offset="45%" stop-color="#6fa3ef"/><stop offset="100%" stop-color="#2a4f8f"/></radialGradient>"""

MONTHS = ["AUG", "SEP", "OCT", "NOV", "DEC", "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL"]
MPOS = [(190, 31), (271, 53), (330, 112), (352, 194), (330, 274), (271, 333), (190, 355), (109, 333),
        (50, 274), (28, 194), (50, 112), (109, 53)]

def dial(ox, oy, s, t, sun_r=13, label_size=9, ring_glow=None, sun_glow=None, upcoming=None, body_stroke=2):
    """home.html's dial chrome and sample bodies, in pack `t`, scaled `s` about
    its own origin. ring_glow / sun_glow add the pack's bloom BEHIND the chart
    (a blurred twin of the ring; a radial halo on the sun) — chart, not mark."""
    up = upcoming or t.get("upcoming", "#8fb8ff")
    ov = t.get("overdue", "#f87171"); wm = t.get("warm", "#f0b429"); ok = t.get("ok", "#4ade80")
    labels = "".join(text(m, "ui", label_size, 500, x, y, t["faint"], ls=0.04, anchor="middle")[0]
                     for m, (x, y) in zip(MONTHS, MPOS))
    glow = ""
    if ring_glow:
        glow += (f'<circle cx="190" cy="190" r="150" fill="none" stroke="{ring_glow}" stroke-opacity=".55" '
                 f'stroke-width="5" filter="url(#blur6)"/>')
    halo = ""
    if sun_glow:
        halo = f'<circle cx="190" cy="190" r="{sun_glow[1]}" fill="url(#{sun_glow[0]})"/>'
    return f"""<g transform="translate({ox} {oy}) scale({s})">
<defs><filter id="blur6" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="6"/></filter>
<filter id="sunf" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="9"/></filter>
<radialGradient id="danger4" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="{ov}" stop-opacity=".12"/><stop offset="55%" stop-color="{ov}" stop-opacity=".04"/><stop offset="85%" stop-color="{ov}" stop-opacity="0"/></radialGradient>
{BODY_DEFS}</defs>
{halo}
<g stroke="{t['linesoft']}" stroke-width=".5">
  <line x1="190" y1="14" x2="190" y2="34"/><line x1="314.5" y1="65.5" x2="300" y2="80"/>
  <line x1="366" y1="190" x2="346" y2="190"/><line x1="314.5" y1="314.5" x2="300" y2="300"/>
  <line x1="190" y1="366" x2="190" y2="346"/><line x1="65.5" y1="314.5" x2="80" y2="300"/>
  <line x1="14" y1="190" x2="34" y2="190"/><line x1="65.5" y1="65.5" x2="80" y2="80"/>
</g>
<circle cx="190" cy="190" r="168" fill="none" stroke="{t['linesoft']}" stroke-width=".5"/>
<polyline points="175.7,140 215.2,127.6 257.1,152.8" fill="none" stroke="{t['accent']}" stroke-opacity=".38" stroke-width="1" stroke-dasharray="1 5" stroke-linecap="round"/>
<circle cx="190" cy="190" r="62" fill="url(#danger4)"/>
<circle cx="190" cy="190" r="62" fill="none" stroke="{ov}" stroke-opacity=".35" stroke-width="1" stroke-dasharray="3 5"/>
<circle cx="190" cy="190" r="106" fill="none" stroke="{t['linesoft']}" stroke-width=".75"/>
{glow}
<circle cx="190" cy="190" r="150" fill="none" stroke="{t['line']}" stroke-width="1.5"/>
<g stroke="{t['line']}" stroke-width="1.5">
  <line x1="190" y1="40" x2="190" y2="47"/><line x1="265" y1="60.1" x2="261.5" y2="66.2"/>
  <line x1="319.9" y1="115" x2="313.8" y2="118.5"/><line x1="340" y1="190" x2="333" y2="190"/>
  <line x1="319.9" y1="265" x2="313.8" y2="261.5"/><line x1="265" y1="319.9" x2="261.5" y2="313.8"/>
  <line x1="190" y1="340" x2="190" y2="333"/><line x1="115" y1="319.9" x2="118.5" y2="313.8"/>
  <line x1="60.1" y1="265" x2="66.2" y2="261.5"/><line x1="40" y1="190" x2="47" y2="190"/>
  <line x1="60.1" y1="115" x2="66.2" y2="118.5"/><line x1="115" y1="60.1" x2="118.5" y2="66.2"/>
</g>
{labels}
<path d="M190 38 l5.5 9 h-11 Z" fill="{t['accent']}"/>
<g fill="none" stroke-linecap="round">
  <path d="M 169.7 142.1 A 52 52 0 0 1 173.1 140.8" stroke="{ov}" stroke-opacity=".5" stroke-width="2"/>
  <path d="M 200.3 124.9 A 65.872 65.872 0 0 1 204.8 125.8" stroke="{wm}" stroke-opacity=".5" stroke-width="2"/>
  <path d="M 207.4 125 A 67.324 67.324 0 0 1 211.9 126.3" stroke="{wm}" stroke-opacity=".5" stroke-width="2"/>
  <path d="M 250.1 146.3 A 74.342 74.342 0 0 1 253 150.6" stroke="{up}" stroke-opacity=".45" stroke-width="2"/>
</g>
<circle cx="190" cy="190" r="{sun_r}" fill="{t['sun']}" filter="url(#sunf)" opacity=".85"/>
<circle cx="190" cy="190" r="7" fill="{t['suncore']}"/>
<circle cx="175.7" cy="140" r="8" fill="none" stroke="{ov}" stroke-opacity=".45" stroke-width="1"/>
<circle cx="175.7" cy="140" r="6.3" stroke="{t['bg']}" stroke-width="{body_stroke}" fill="url(#p-ruby)"/>
<circle cx="174.44" cy="141.575" r="2.079" fill="rgba(255,255,255,.38)"/>
<circle cx="208.2" cy="126.7" r="5.2" stroke="{t['bg']}" stroke-width="{body_stroke}" fill="url(#p-amber)"/>
<circle cx="207.16" cy="128" r="1.716" fill="rgba(255,255,255,.38)"/>
<circle cx="215.2" cy="127.6" r="6" stroke="{t['bg']}" stroke-width="{body_stroke}" fill="url(#p-amber)"/>
<circle cx="214" cy="129.1" r="1.98" fill="rgba(255,255,255,.38)"/>
<circle cx="247.8" cy="143.2" r="8.5" fill="none" stroke="{t['accent']}" stroke-width="1.8"/>
<circle cx="247.8" cy="143.2" r="6" fill="{t['accent']}" opacity=".12"/>
<circle cx="257.1" cy="152.8" r="5.7" stroke="{up}" stroke-opacity=".25" stroke-width="2.6" fill="url(#p-sky)"/>
<circle cx="255.96" cy="154.225" r="1.881" fill="rgba(255,255,255,.38)"/>
<circle cx="267.6" cy="238.5" r="3.5" fill="url(#p-jade)"/>
<circle cx="222.9" cy="285.5" r="7" stroke="{ok}" stroke-opacity=".25" stroke-width="3" fill="url(#p-jade)"/>
<circle cx="221.5" cy="287.25" r="2.31" fill="rgba(255,255,255,.38)"/>
<ellipse cx="222.9" cy="285.5" rx="13.5" ry="4.6" transform="rotate(-24 222.9 285.5)" fill="none" stroke="{t['accent']}" stroke-width="1.3" opacity=".8"/>
</g>"""

def halo_def(id_, color, a0=.38, a1=.10, mid=.3):
    return (f'<radialGradient id="{id_}" cx="50%" cy="50%" r="50%">'
            f'<stop offset="0" stop-color="{color}" stop-opacity="{a0}"/>'
            f'<stop offset="{mid}" stop-color="{color}" stop-opacity="{a1}"/>'
            f'<stop offset="1" stop-color="{color}" stop-opacity="0"/></radialGradient>')

def rays(cx, cy, r0, r1, n, color, opacity, seed=7):
    """The heliosphere's faint radial rays, blurred — sky, not mark."""
    rng = park_miller(seed)
    out = []
    for i in range(n):
        a = math.radians(i * 360 / n + rng() * 8)
        L = r1 * (0.55 + rng() * 0.45)
        out.append(f'<line x1="{cx + r0*math.cos(a):.1f}" y1="{cy + r0*math.sin(a):.1f}" '
                   f'x2="{cx + L*math.cos(a):.1f}" y2="{cy + L*math.sin(a):.1f}"/>')
    return (f'<g stroke="{color}" stroke-opacity="{opacity}" stroke-width="2" stroke-linecap="round" '
            f'filter="url(#blur8)">{"".join(out)}</g>')

# ================================================================ D · Perihelion
def banner_d():
    t = SC
    cx, cy, s = 1250, 440, 4.0
    word, _ = text("orbit", "display", 170, 600, 110, 330, t["ink"], ls=0.015)
    tag, _ = text(TAGLINE, "ui", 44, 400, 114, 400, t["mid"])
    mis, _ = text("perihelion · T−16d", "mono", 18, 400, 114, 462, t["faint"], ls=0.08)
    # the bridge's HUD callout (home-bridge.html's voice) on the Car MOT body
    bx, by = cx + (208.2 - 190) * s, cy + (126.7 - 190) * s
    hx = 1010
    hud1, w1 = text("CAR MOT — VOLVO V60", "mono", 15, 500, hx, 92, t["accent"], ls=0.12)
    hud2, w2 = text("NEXT APPROACH T−16D · BRG 016° · 29 AUG", "mono", 13, 400, hx, 116, t["faint"], ls=0.12)
    hud = (f'{hud1}{hud2}<g stroke="{t["accent"]}" stroke-opacity=".7" stroke-width="1" fill="none">'
           f'<path d="M{hx - 4} 126 H{hx + max(w1, w2):.0f}"/><path d="M{bx:.0f} 126 V{by - 30:.0f}"/></g>')
    return f"""{SVG.format(w=W, h=H, label="Orbit — " + TAGLINE)}
<defs>{halo_def("helio", t["sun"], .42, .08, .25)}<filter id="blur8" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="8"/></filter>
<filter id="blur30" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="30"/></filter></defs>
<rect width="{W}" height="{H}" fill="{t['bg']}"/>
<g transform="translate(0 -80)">{star_tiles(t['starfar'], t['starnear'])}</g>
{rays(cx, cy, 80, 520, 36, t['sun'], .10)}
{dial(cx - 190*s, cy - 190*s, s, t, sun_r=14, label_size=8, sun_glow=("helio", 118), body_stroke=0.8)}
{hud}
<g transform="translate(110 110) scale(.46)">{DRIFT}{live_mark(t['mid'], t['sun'], t['accent'])}</g>
{word}
{tag}
{mis}
</svg>"""

def logo_d():
    t = SC
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200" role="img" aria-label="Orbit">
<defs><clipPath id="tile"><rect width="200" height="200" rx="44"/></clipPath>{halo_def("g", t["sun"], .55, .14, .3)}</defs>
<g clip-path="url(#tile)"><rect width="200" height="200" fill="{t['bg']}"/>
<circle cx="168" cy="178" r="150" fill="url(#g)"/>
<g fill="{t['starfar']}"><circle cx="34" cy="28" r="1.3" opacity=".6"/><circle cx="150" cy="22" r="1" opacity=".5"/><circle cx="22" cy="120" r="1" opacity=".45"/><circle cx="60" cy="172" r="1.4" opacity=".55"/><circle cx="178" cy="60" r=".9" opacity=".4"/><circle cx="118" cy="40" r=".8" opacity=".4"/></g></g>
{mark(t['mid'], t['sun'], t['accent'], sw=8, r_sun=6.5, r_planet=14.5, scale=62/72)}
</svg>"""

# ================================================================ E · Galactic plane
def plane(x0, y0, x1, y1, width, seed=20260816, n=900, scale=1.0):
    """After dark's river: cool haze, warm core, a dust lane, and its own star
    population scattered along the band (afterdark-plane.html, carried in
    spirit; the pack's materials from packs.css)."""
    t = AD
    rng = park_miller(seed)
    L = math.hypot(x1 - x0, y1 - y0); ux, uy = (x1 - x0) / L, (y1 - y0) / L; nx, ny = -uy, ux
    stars = []
    for _ in range(n):
        u = rng() * L
        # roughly gaussian offset across the band
        v = (rng() + rng() + rng() - 1.5) / 1.5 * width * 0.55
        x, y = x0 + ux * u + nx * v, y0 + uy * u + ny * v
        r = (0.4 + rng() * 1.1) * scale
        o = 0.25 + rng() * 0.6
        warm = rng() < 0.3
        stars.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.2f}" opacity="{o:.2f}" fill="{t["planestarwarm"] if warm else t["planestar"]}"/>')
    d = f"M{x0} {y0} L{x1} {y1}"
    return (f'<path d="{d}" stroke="{t["planecool"]}" stroke-opacity=".22" stroke-width="{width*1.6:.0f}" fill="none" filter="url(#blur60)"/>'
            f'<path d="{d}" stroke="{t["planewarm"]}" stroke-opacity=".2" stroke-width="{width*0.7:.0f}" fill="none" filter="url(#blur40)"/>'
            f'<path d="{d}" stroke="{t["planedust"]}" stroke-opacity=".7" stroke-width="{width*0.18:.0f}" fill="none" filter="url(#blur20)" transform="translate({nx*width*0.12:.0f} {ny*width*0.12:.0f})"/>'
            f'<g>{"".join(stars)}</g>')

def banner_e():
    t = AD
    word, _ = text("orbit", "display", 200, 600, 760, 470, t["ink"], ls=0.015)
    tag, _ = text(TAGLINE, "ui", 46, 400, 766, 548, t["mid"])
    mis, _ = text("lights out, ink up · after dark", "mono", 18, 400, 768, 608, t["faint"], ls=0.1)
    return f"""{SVG.format(w=W, h=H, label="Orbit — " + TAGLINE)}
<defs><filter id="blur60" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="60"/></filter>
<filter id="blur40" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="40"/></filter>
<filter id="blur20" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="20"/></filter></defs>
<rect width="{W}" height="{H}" fill="{t['bg']}"/>
<g transform="translate(0 -80)">{star_tiles(t['starfar'], t['starnear'])}</g>
{plane(-100, 140, 1700, 760, 280, n=1700, scale=1.15)}
<g transform="translate(10 0) scale(4.2)">{DRIFT}{live_mark(t['mid'], t['sun'], t['accent'], sw=1.6, r_sun=3.5, r_planet=6)}</g>
{word}
{tag}
{mis}
</svg>"""

def logo_e():
    t = AD
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200" role="img" aria-label="Orbit">
<defs><clipPath id="tile"><rect width="200" height="200" rx="44"/></clipPath>
<filter id="blur60" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="14"/></filter>
<filter id="blur40" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="9"/></filter>
<filter id="blur20" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="5"/></filter></defs>
<g clip-path="url(#tile)"><rect width="200" height="200" fill="{t['bg']}"/>{plane(-30, 30, 230, 180, 70, seed=4242, n=160, scale=0.6)}</g>
{mark(t['mid'], t['sun'], t['accent'], sw=8, r_sun=6.5, r_planet=14.5, scale=62/72)}
</svg>"""

# ================================================================ F · Retrograde
def banner_f():
    t = RG
    cx, cy, s = 1130, 430, 2.25
    word, _ = text("orbit", "display", 170, 600, 320, 420, t["ink"], ls=0.015)
    tag, _ = text(TAGLINE, "ui", 44, 400, 120, 500, t["mid"])
    mis, _ = text("retrograde · the sun burns pink", "mono", 18, 400, 124, 560, t["faint"], ls=0.1)
    return f"""{SVG.format(w=W, h=H, label="Orbit — " + TAGLINE)}
<defs>{halo_def("pink", t["sun"], .5, .12, .3)}{halo_def("pinkwide", t["sun"], .16, .05, .4)}</defs>
<rect width="{W}" height="{H}" fill="{t['bg']}"/>
<g transform="translate(0 -80)">{star_tiles(t['starfar'], t['starnear'])}</g>
<circle cx="{cx}" cy="{cy}" r="520" fill="url(#pinkwide)"/>
{dial(cx - 190*s, cy - 190*s, s, t, sun_r=16, label_size=9, ring_glow=t['upcoming'], sun_glow=("pink", 150))}
<g transform="translate(120 230) scale(.8)">{DRIFT}{live_mark(t['upcoming'], t['suncore'], t['accent'])}</g>
{word}
{tag}
{mis}
</svg>"""

def logo_f():
    t = RG
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200" role="img" aria-label="Orbit">
<defs><clipPath id="tile"><rect width="200" height="200" rx="44"/></clipPath>{halo_def("pk", t["sun"], .6, .16, .3)}</defs>
<g clip-path="url(#tile)"><rect width="200" height="200" fill="{t['bg']}"/><circle cx="26" cy="24" r="150" fill="url(#pk)"/>
<g fill="{t['starfar']}"><circle cx="160" cy="30" r="1.2" opacity=".6"/><circle cx="176" cy="150" r="1" opacity=".5"/><circle cx="40" cy="176" r="1.1" opacity=".5"/><circle cx="120" cy="184" r=".8" opacity=".4"/></g></g>
{mark(t['upcoming'], t['suncore'], t['accent'], sw=8, r_sun=6.5, r_planet=14.5, scale=62/72)}
</svg>"""

# ================================================================ G · Gravity well
def spiral_sky(cx, cy, n=110, seed=404):
    """The infall's spiralling sky: short arcs of star-light around the well."""
    rng = park_miller(seed)
    out = []
    for _ in range(n):
        r = 120 + rng() * 820
        a = rng() * math.tau
        sweep = (0.04 + rng() * 0.10) * (1 - (r - 120) / 900)
        x1, y1 = cx + r * math.cos(a), cy + r * math.sin(a)
        x2, y2 = cx + r * math.cos(a + sweep), cy + r * math.sin(a + sweep)
        o = 0.10 + rng() * 0.35
        out.append(f'<path d="M{x1:.1f} {y1:.1f} A{r:.0f} {r:.0f} 0 0 1 {x2:.1f} {y2:.1f}" opacity="{o:.2f}"/>')
    return f'<g fill="none" stroke="#e9edf8" stroke-width="1" stroke-linecap="round">{"".join(out)}</g>'

def banner_g():
    t = SC
    cx, cy, rx, ry = 800, 380, 600, 165
    word, _ = text("orbit", "display", 130, 600, 800, 700, t["ink"], ls=0.015, anchor="middle")
    tag, _ = text(TAGLINE, "ui", 40, 400, 800, 760, t["mid"], anchor="middle")
    # bodies on the tilted ring: angle, size, material. Lower half is nearer.
    bodies = [(200, 9, "p-ruby"), (236, 11, "p-amber"), (250, 12, "p-amber"), (292, 13, "p-sky"),
              (330, 10, "p-jade"), (28, 16, "p-jade"), (70, 15, "p-amber"), (120, 12, "p-ruby")]
    far, near = [], []
    for ang, r, mat in bodies:
        a = math.radians(ang)
        x, y = cx + rx * math.cos(a), cy + ry * math.sin(a)
        depth = (math.sin(a) + 1) / 2          # 0 far, 1 near
        rr = r * (0.7 + 0.6 * depth)
        el = (f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{rr:.1f}" fill="url(#{mat})" stroke="{t["bg"]}" stroke-width="2"/>'
              f'<circle cx="{x - rr*.2:.1f}" cy="{y + rr*.25:.1f}" r="{rr*.33:.1f}" fill="rgba(255,255,255,.38)"/>')
        (near if math.sin(a) > 0 else far).append(el)
    ring_far = f'<path d="M{cx-rx} {cy} A{rx} {ry} 0 0 1 {cx+rx} {cy}"'
    ring_near = f'<path d="M{cx+rx} {cy} A{rx} {ry} 0 0 1 {cx-rx} {cy}"'
    return f"""{SVG.format(w=W, h=H, label="Orbit — " + TAGLINE)}
<defs>{BODY_DEFS}{halo_def("corona", t["sun"], .9, .22, .22)}{halo_def("wide", t["accent"], .22, .06, .35)}
<filter id="blur10" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="10"/></filter>
<filter id="blur3" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3"/></filter>
<radialGradient id="dusk" cx="50%" cy="45%" r="60%"><stop offset="0" stop-color="#1b1a2e"/><stop offset=".6" stop-color="#0a0f22"/><stop offset="1" stop-color="{t['bg']}"/></radialGradient></defs>
<rect width="{W}" height="{H}" fill="url(#dusk)"/>
{spiral_sky(cx, cy)}
<g transform="translate(0 -80)">{star_tiles(t['starfar'], t['starnear'])}</g>
<circle cx="{cx}" cy="{cy}" r="520" fill="url(#wide)"/>
<g fill="none">
  {ring_far} stroke="{t['accent']}" stroke-opacity=".35" stroke-width="18" filter="url(#blur10)"/>
  {ring_far} stroke="{t['mid']}" stroke-opacity=".55" stroke-width="2.5"/>
</g>
{"".join(far)}
<ellipse cx="{cx}" cy="{cy}" rx="240" ry="66" fill="none" stroke="{t['overdue']}" stroke-opacity=".45" stroke-width="1.2" stroke-dasharray="4 7"/>
<circle cx="{cx}" cy="{cy}" r="260" fill="url(#corona)"/>
<circle cx="{cx}" cy="{cy}" r="40" fill="{t['sun']}" filter="url(#blur10)"/>
<circle cx="{cx}" cy="{cy}" r="24" fill="{t['suncore']}"/>
<g fill="none">
  {ring_near} stroke="{t['accent']}" stroke-opacity=".7" stroke-width="22" filter="url(#blur10)"/>
  {ring_near} stroke="{t['sun']}" stroke-opacity=".9" stroke-width="3"/>
</g>
{"".join(near)}
{word}
{tag}
</svg>"""

def logo_g():
    t = SC
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200" role="img" aria-label="Orbit">
<defs><clipPath id="tile"><rect width="200" height="200" rx="44"/></clipPath>{halo_def("c", t["sun"], .5, .12, .3)}
<filter id="b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="5"/></filter></defs>
<g clip-path="url(#tile)"><rect width="200" height="200" fill="{t['bg']}"/>
<circle cx="100" cy="100" r="120" fill="url(#c)"/>
<path d="M-20 118 Q100 150 220 118" stroke="{t['accent']}" stroke-opacity=".55" stroke-width="10" fill="none" filter="url(#b)"/>
<path d="M-20 118 Q100 150 220 118" stroke="{t['sun']}" stroke-opacity=".7" stroke-width="1.5" fill="none"/></g>
{mark(t['mid'], t['sun'], t['accent'], sw=8, r_sun=6.5, r_planet=14.5, scale=62/72)}
</svg>"""

# ================================================================ index
OPTIONS = [
    ("d", "Perihelion", "The storm's lean-in: the dial at four times its size, cropped by the banner, the heliosphere sun blazing, the bridge's HUD calling out the next approach."),
    ("e", "Galactic plane", "After dark's river of stars crossing the banner behind a big, thick-ringed lockup in the pack's ice-blue."),
    ("f", "Retrograde", "The neon pack: cyan ring glowing, the sun burning pink, the whole dial in view beside the lockup."),
    ("g", "Gravity well", "The orbit seen in depth: a tilted glowing ring around a blazing sun, bodies nearer and larger as they come round, the sky spiralling in."),
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
<title>Orbit — README art, round 2 (#1177)</title>
<style>{css}</style></head><body><main>
<h1 class="top">Orbit — README banner and logo, round 2 (#1177)</h1>
<p class="lead">Dark only, after round 1's verdicts. Each option as the README would show it, on a white page and a dark page: the header logo at 132px, the banner, and the footer logo at 52px. All text is outlined. The banner SVGs carry the mark's one permitted motion (the planet drifts once per 40s); the PNGs are stills.</p>
{"".join(secs)}
</main></body></html>"""

if __name__ == "__main__":
    for k, fn_b, fn_l in (("d", banner_d, logo_d), ("e", banner_e, logo_e), ("f", banner_f, logo_f), ("g", banner_g, logo_g)):
        write(f"{k}-banner.svg", fn_b()); write(f"{k}-logo.svg", fn_l())
    write("index.html", index())
    print("wrote 8 svg + index.html")
