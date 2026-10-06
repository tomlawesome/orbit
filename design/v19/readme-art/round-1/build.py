#!/usr/bin/env python3
"""
Round 1 of #1177 — README banner and logo in the v19 look.

Generates every SVG in this folder plus index.html. Text is outlined with the
product's own fonts so nothing depends on a web font at render time:

  Space Grotesk (--display, the word)      SpaceGrotesk[wght].ttf
  Inter         (--ui, the tagline)        inter-latin-wght-normal.woff2
  JetBrains Mono (--mono, mission vocab)   jetbrains-mono-latin-wght-normal.woff2

The font files are not vendored here (OFL, but they already live in the
project's pnpm store: @fontsource-variable/inter, @fontsource-variable/
jetbrains-mono, and @fontsource/space-grotesk; a variable Space Grotesk sits
in tmp/fonts of the main checkout). Point FONT_DIR at a folder holding the
three files named above.

Run:  FONT_DIR=/path/to/fonts python3 build.py      (needs fonttools, brotli,
      uharfbuzz)  then  node render.mjs  for the PNGs and screenshots.

Sources carried verbatim, never redrawn:
  - the mark: design/owner-decisions.md §2 (CON-19) and
    design/mockups-brand-decision.html — ring cx100 cy100 r72 sw7, centre r7
    --sun, planet cx163 cy63.5 r16 --accent; heavier cuts for small sizes
    from the same page (44px "app chrome, README" cut: sw9 / r8 / r19).
  - the dial and its sample bodies: design/v19/home.html (the chrome group
    and the body circles, token names resolved to the star-chart pack).
  - the starfield: web/src/lib/sky.js (Park–Miller seed 17170812, the two
    TILED_LAYERS, drawn over the 1600×1000 tile).
  - colours: web/src/lib/packs.css (starchart, dawn) and the brand page's
    light "atlas paper" treatment.
"""
import os, io, math, html
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
import uharfbuzz as hb

HERE = os.path.dirname(os.path.abspath(__file__))
FONT_DIR = os.environ.get("FONT_DIR", "/tmp/fontenv/fonts")
FONTS = {
    "display": "SpaceGrotesk-wght.ttf",
    "ui": "inter-latin-wght-normal.woff2",
    "mono": "jetbrains-mono-latin-wght-normal.woff2",
}

# ---------------------------------------------------------------- text
_cache = {}

def _font(key, weight):
    k = (key, weight)
    if k not in _cache:
        path = os.path.join(FONT_DIR, FONTS[key])
        tt = TTFont(path)
        tt = instantiateVariableFont(tt, {"wght": weight}, inplace=False)
        # HarfBuzz shapes the same instanced font fontTools outlines from —
        # handed as plain SFNT bytes, because HarfBuzz cannot open WOFF2 and
        # would silently map every character to glyph 0.
        tt.flavor = None
        buf = io.BytesIO(); tt.save(buf)
        face = hb.Face(hb.Blob(buf.getvalue()))
        font = hb.Font(face)
        _cache[k] = (tt, font, tt["head"].unitsPerEm, tt.getGlyphOrder())
    return _cache[k]

def text(s, key, size, weight, x=0, y=0, fill="#000", ls=0.0, anchor="start", opacity=None, extra=""):
    """Outline `s` as one <path>. ls = letter-spacing in em. anchor: start|middle|end."""
    tt, font, upem, order = _font(key, weight)
    buf = hb.Buffer(); buf.add_str(s); buf.guess_segment_properties()
    hb.shape(font, buf)
    scale = size / upem
    infos, poss = buf.glyph_infos, buf.glyph_positions
    adv = sum(p.x_advance for p in poss) * scale + ls * size * (len(infos) - 1)
    if anchor == "middle": x -= adv / 2
    elif anchor == "end": x -= adv
    gs = tt.getGlyphSet()
    pen = SVGPathPen(gs)
    cx = x
    for info, pos in zip(infos, poss):
        name = order[info.codepoint]
        tp = TransformPen(pen, (scale, 0, 0, -scale, cx + pos.x_offset * scale, y - pos.y_offset * scale))
        gs[name].draw(tp)
        cx += pos.x_advance * scale + ls * size
    d = pen.getCommands()
    op = f' opacity="{opacity}"' if opacity is not None else ""
    return f'<path d="{d}" fill="{fill}"{op}{extra}/>', adv

# ---------------------------------------------------------------- sky
def park_miller(seed):
    s = seed % 2147483647
    if s <= 0: s += 2147483646
    def nxt():
        nonlocal s
        s = (s * 48271) % 2147483647
        return s / 2147483647
    return nxt

TILED_LAYERS = [
    dict(count=95, rMin=0.4, rSpan=0.5, oMin=0.12, oSpan=0.23),
    dict(count=46, rMin=0.8, rSpan=0.7, oMin=0.3, oSpan=0.4),
]
TILED_SEED = 17170812

def star_tiles(far, near, fade=None):
    """The product's own field: far then near, one seeded stream, 1600×1000."""
    rng = park_miller(TILED_SEED)
    out = []
    for fill, L in ((far, TILED_LAYERS[0]), (near, TILED_LAYERS[1])):
        g = []
        for _ in range(L["count"]):
            cx = round(rng() * 1600, 1); cy = round(rng() * 1000, 1)
            r = round(L["rMin"] + rng() * L["rSpan"], 2)
            o = round(L["oMin"] + rng() * L["oSpan"], 2)
            if fade:
                o = round(o * fade(cx, cy), 2)
                if o <= 0.02: continue
            g.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" opacity="{o}"/>')
        out.append(f'<g fill="{fill}">{"".join(g)}</g>')
    return "".join(out)

# ---------------------------------------------------------------- the mark
def mark(ring, sun, planet, sw=7, r_sun=7, r_planet=16, scale=1.0, cx=100, cy=100):
    """CON-19: ring, centre, planet. Three flat shapes, in token colours.
    Scaled about the ring's centre; the planet keeps its −30° station."""
    s = scale
    px, py = cx + 63 * s, cy - 36.5 * s
    return (f'<circle cx="{cx}" cy="{cy}" r="{72*s:g}" fill="none" stroke="{ring}" stroke-width="{sw*s:g}"/>'
            f'<circle cx="{cx}" cy="{cy}" r="{r_sun*s:g}" fill="{sun}"/>'
            f'<circle cx="{px:g}" cy="{py:g}" r="{r_planet*s:g}" fill="{planet}"/>')

# tokens (packs.css)
SC = dict(bg="#060b1c", ink="#e9edf8", mid="#8791b3", faint="#737e9e", accent="#d8b45a",
          sun="#ffe9c4", suncore="#fff6e6", line="#243259", linesoft="#17203f",
          ok="#4ade80", warm="#f0b429", overdue="#f87171", upcoming="#8fb8ff",
          starfar="#e9edf8", starnear="#f4f0ff")
DAWN = dict(sky=["#b0bed6", "#c2cad9", "#d7d5cf", "#eedfc8", "#f8e9d2"], ink="#18202f",
            mid="#343d51", faint="#414d62", accent="#1f7ac2", sun="#eda253", suncore="#9c4a10")
PAPER = dict(bg="#f4f1e8", ink="#1c2b4a", ring="#5d6a87", planet="#b4842c")

TAGLINE = "Everything in your orbit, on track."
MISSION = "orbital period · 1 year"
W, H = 1600, 840
SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="{label}">'

def write(name, body):
    with open(os.path.join(HERE, name), "w") as f:
        f.write(body + "\n")

# ================================================================ A · chart-room
def dial(ox, oy, s):
    """design/v19/home.html's dial, chrome and sample bodies verbatim (380 viewBox)."""
    t = SC
    months = ["AUG", "SEP", "OCT", "NOV", "DEC", "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL"]
    pos = [(190, 31), (271, 53), (330, 112), (352, 194), (330, 274), (271, 333), (190, 355), (109, 333),
           (50, 274), (28, 194), (50, 112), (109, 53)]
    labels = "".join(text(m, "ui", 9, 500, x, y, t["faint"], ls=0.04, anchor="middle")[0]
                     for m, (x, y) in zip(months, pos))
    defs = """<defs>
  <filter id="sun" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="9"/></filter>
  <radialGradient id="p-ruby" cx="34%" cy="30%" r="72%"><stop offset="0%" stop-color="#ffb3ab"/><stop offset="42%" stop-color="#e0453e"/><stop offset="100%" stop-color="#7e1a1f"/></radialGradient>
  <radialGradient id="p-jade" cx="34%" cy="30%" r="72%"><stop offset="0%" stop-color="#b8f5cf"/><stop offset="45%" stop-color="#2fae6a"/><stop offset="100%" stop-color="#12603a"/></radialGradient>
  <radialGradient id="p-amber" cx="34%" cy="30%" r="72%"><stop offset="0%" stop-color="#ffe1a0"/><stop offset="45%" stop-color="#f0a52b"/><stop offset="100%" stop-color="#8a5a10"/></radialGradient>
  <radialGradient id="p-sky" cx="34%" cy="30%" r="72%"><stop offset="0%" stop-color="#cfe4ff"/><stop offset="45%" stop-color="#6fa3ef"/><stop offset="100%" stop-color="#2a4f8f"/></radialGradient>
  <radialGradient id="danger4" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#f87171" stop-opacity=".10"/><stop offset="55%" stop-color="#f87171" stop-opacity=".035"/><stop offset="85%" stop-color="#f87171" stop-opacity="0"/></radialGradient>
</defs>"""
    return f"""<g transform="translate({ox} {oy}) scale({s})">{defs}
<g stroke="{t['linesoft']}" stroke-width=".5">
  <line x1="190" y1="14" x2="190" y2="34"/><line x1="314.5" y1="65.5" x2="300" y2="80"/>
  <line x1="366" y1="190" x2="346" y2="190"/><line x1="314.5" y1="314.5" x2="300" y2="300"/>
  <line x1="190" y1="366" x2="190" y2="346"/><line x1="65.5" y1="314.5" x2="80" y2="300"/>
  <line x1="14" y1="190" x2="34" y2="190"/><line x1="65.5" y1="65.5" x2="80" y2="80"/>
</g>
<circle cx="190" cy="190" r="168" fill="none" stroke="{t['linesoft']}" stroke-width=".5"/>
<polyline points="175.7,140 215.2,127.6 257.1,152.8" fill="none" stroke="{t['accent']}" stroke-opacity=".38" stroke-width="1" stroke-dasharray="1 5" stroke-linecap="round"/>
<circle cx="190" cy="190" r="62" fill="url(#danger4)"/>
<circle cx="190" cy="190" r="62" fill="none" stroke="{t['overdue']}" stroke-opacity=".3" stroke-width="1" stroke-dasharray="3 5"/>
<circle cx="190" cy="190" r="106" fill="none" stroke="{t['linesoft']}" stroke-width=".75"/>
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
  <path d="M 169.7 142.1 A 52 52 0 0 1 173.1 140.8" stroke="{t['overdue']}" stroke-opacity=".5" stroke-width="2"/>
  <path d="M 200.3 124.9 A 65.872 65.872 0 0 1 204.8 125.8" stroke="{t['warm']}" stroke-opacity=".5" stroke-width="2"/>
  <path d="M 207.4 125 A 67.324 67.324 0 0 1 211.9 126.3" stroke="{t['warm']}" stroke-opacity=".5" stroke-width="2"/>
  <path d="M 250.1 146.3 A 74.342 74.342 0 0 1 253 150.6" stroke="{t['upcoming']}" stroke-opacity=".45" stroke-width="2"/>
</g>
<circle cx="190" cy="190" r="13" fill="{t['sun']}" filter="url(#sun)" opacity=".8"/>
<circle cx="190" cy="190" r="7" fill="{t['suncore']}"/>
<circle cx="175.7" cy="140" r="6.3" stroke="{t['bg']}" stroke-width="2" fill="url(#p-ruby)"/>
<circle cx="174.44" cy="141.575" r="2.079" fill="rgba(255,255,255,.38)"/>
<circle cx="208.2" cy="126.7" r="5.2" stroke="{t['bg']}" stroke-width="2" fill="url(#p-amber)"/>
<circle cx="207.16" cy="128" r="1.716" fill="rgba(255,255,255,.38)"/>
<circle cx="215.2" cy="127.6" r="6" stroke="{t['bg']}" stroke-width="2" fill="url(#p-amber)"/>
<circle cx="214" cy="129.1" r="1.98" fill="rgba(255,255,255,.38)"/>
<circle cx="247.8" cy="143.2" r="8.5" fill="none" stroke="{t['accent']}" stroke-width="1.8"/>
<circle cx="247.8" cy="143.2" r="6" fill="{t['accent']}" opacity=".12"/>
<circle cx="257.1" cy="152.8" r="5.7" stroke="{t['upcoming']}" stroke-opacity=".25" stroke-width="2.6" fill="url(#p-sky)"/>
<circle cx="255.96" cy="154.225" r="1.881" fill="rgba(255,255,255,.38)"/>
<circle cx="267.6" cy="238.5" r="3.5" fill="url(#p-jade)"/>
<circle cx="222.9" cy="285.5" r="7" stroke="{t['ok']}" stroke-opacity=".25" stroke-width="3" fill="url(#p-jade)"/>
<circle cx="221.5" cy="287.25" r="2.31" fill="rgba(255,255,255,.38)"/>
<ellipse cx="222.9" cy="285.5" rx="13.5" ry="4.6" transform="rotate(-24 222.9 285.5)" fill="none" stroke="{t['accent']}" stroke-width="1.3" opacity=".8"/>
</g>"""

def banner_a():
    t = SC
    word, ww = text("orbit", "display", 150, 600, 320, 388, t["ink"], ls=0.015)
    tag, _ = text(TAGLINE, "ui", 34, 400, 150, 486, t["mid"])
    mis, _ = text(MISSION, "mono", 20, 400, 150, 548, t["faint"], ls=0.1)
    return f"""{SVG.format(w=W, h=H, label="Orbit — " + TAGLINE)}
<rect width="{W}" height="{H}" fill="{t['bg']}"/>
<g transform="translate(0 -80)">{star_tiles(t['starfar'], t['starnear'])}</g>
{dial(850, 60, 1.9)}
<g transform="translate(150 265) scale(.7)">{mark(t['mid'], t['sun'], t['accent'])}</g>
{word}
{tag}
{mis}
</svg>"""

def logo_a():
    t = SC
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200" role="img" aria-label="Orbit">
<rect width="200" height="200" rx="44" fill="{t['bg']}"/>
{mark(t['mid'], t['sun'], t['accent'], sw=8, r_sun=6.5, r_planet=14.5, scale=62/72)}
</svg>"""

# ================================================================ B · one ink
def banner_b():
    p = PAPER
    cx, cy = 560, 400
    word, ww = text("orbit", "display", 190, 600, 790, 462, p["ink"], ls=0.015)
    tag, _ = text(TAGLINE, "ui", 36, 400, 794, 530, p["ring"])
    mis, _ = text(MISSION.upper(), "mono", 17, 400, 796, 584, p["ring"], ls=0.14)
    ticks = "".join(
        f'<line x1="{cx + 600*math.cos(a):.1f}" y1="{cy + 600*math.sin(a):.1f}" x2="{cx + 586*math.cos(a):.1f}" y2="{cy + 586*math.sin(a):.1f}"/>'
        for a in (math.radians(i * 30 - 90) for i in range(12)))
    return f"""{SVG.format(w=W, h=H, label="Orbit — " + TAGLINE)}
<rect width="{W}" height="{H}" fill="{p['bg']}"/>
<g stroke="{p['ink']}" stroke-opacity=".11" fill="none">
  <circle cx="{cx}" cy="{cy}" r="190" stroke-width=".75"/>
  <circle cx="{cx}" cy="{cy}" r="300" stroke-width=".75"/>
  <circle cx="{cx}" cy="{cy}" r="600" stroke-width="1"/>
  <g stroke-width="1" stroke-opacity=".22">{ticks}</g>
</g>
<rect x="40.5" y="40.5" width="{W-81}" height="{H-81}" fill="none" stroke="{p['ink']}" stroke-opacity=".18"/>
<g transform="translate({cx-150} {cy-150}) scale(1.5)">{mark(p['ink'], p['ink'], p['ink'], sw=7, r_sun=7, r_planet=16)}</g>
{word}
{tag}
{mis}
</svg>"""

def logo_b():
    ink = SC["faint"]
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200" role="img" aria-label="Orbit">
{mark(ink, ink, ink, sw=9, r_sun=8, r_planet=19)}
</svg>"""

# ================================================================ C · daybreak
def sky_grad(id_):
    stops = "".join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in zip((0, .3, .55, .8, 1), DAWN["sky"]))
    return f'<linearGradient id="{id_}" x1="0" y1="0" x2="0" y2="1">{stops}</linearGradient>'

def banner_c():
    d = DAWN
    word, _ = text("orbit", "display", 150, 600, 800, 585, d["ink"], ls=0.015, anchor="middle")
    tag, _ = text(TAGLINE, "ui", 34, 400, 800, 652, d["mid"], anchor="middle")
    mis, _ = text(MISSION, "mono", 19, 400, 800, 712, d["faint"], ls=0.1, anchor="middle")
    fade = lambda x, y: max(0.0, 1 - (y - 80) / 480)
    return f"""{SVG.format(w=W, h=H, label="Orbit — " + TAGLINE)}
<defs>{sky_grad("sky")}
<radialGradient id="ember" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="{d['sun']}" stop-opacity=".55"/><stop offset=".45" stop-color="{d['sun']}" stop-opacity=".18"/><stop offset="1" stop-color="{d['sun']}" stop-opacity="0"/></radialGradient></defs>
<rect width="{W}" height="{H}" fill="url(#sky)"/>
<g transform="translate(0 -80)">{star_tiles(d['ink'], d['ink'], fade)}</g>
<ellipse cx="800" cy="900" rx="760" ry="330" fill="url(#ember)"/>
<g transform="translate(640 140) scale(1.6)">{mark(d['faint'], d['sun'], d['accent'])}</g>
{word}
{tag}
{mis}
</svg>"""

def logo_c():
    d = DAWN
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200" role="img" aria-label="Orbit">
<defs>{sky_grad("sky")}</defs>
<circle cx="100" cy="100" r="100" fill="url(#sky)"/>
{mark(d['faint'], d['sun'], d['accent'], sw=8, r_sun=6.5, r_planet=14.5, scale=62/72)}
</svg>"""

# ================================================================ index
OPTIONS = [
    ("a", "Chart-room", "The instrument is the picture: the gravity-well dial from the home screen, the lockup beside it, on the star-chart void."),
    ("b", "One ink", "The printed plate: one navy ink on atlas paper, the horizontal lockup, chart-sheet rules. The logo is the bare mark in chart ink."),
    ("c", "Daybreak", "The dawn pack's horizon: the stacked lockup over the warming sky, the ember below. The logo is the mark on a sky disc."),
]

def readme_block(k, title):
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
    <div class="page light" id="{k}-light">{readme_block(k, title)}</div>
    <div class="page dark" id="{k}-dark">{readme_block(k, title)}</div>
  </div>
</section>""")
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orbit — README art, round 1 (#1177)</title>
<style>
*{{box-sizing:border-box}}
body{{margin:0;background:#2a2d35;color:#d7dbe3;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}}
main{{max-width:1680px;margin:0 auto;padding:28px 24px 80px}}
h1.top{{font-size:20px;margin:0 0 4px}}
p.lead{{margin:0 0 28px;color:#aab0bc;max-width:820px}}
section{{margin:0 0 56px}}
section header{{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;align-items:baseline;margin:0 0 14px}}
section header h2{{margin:0;font-size:18px}}
section header p{{grid-column:2;margin:0;color:#aab0bc;max-width:860px}}
.letter{{font:600 12px ui-monospace,monospace;background:#3b3f4a;border-radius:6px;padding:3px 7px;color:#fff}}
.files a{{color:#8fb8ff;text-decoration:none}}
.pair{{display:grid;grid-template-columns:1fr 1fr;gap:16px}}
/* the two page themes the README is read on */
.page{{padding:32px 40px 36px;border-radius:8px}}
.page.light{{background:#ffffff;color:#1f2328}}
.page.dark{{background:#0d1117;color:#e6edf3}}
.readme{{max-width:720px;margin:0 auto}}
.readme h1{{font-size:32px;font-weight:600;padding-bottom:.3em;margin:8px 0 10px;border-bottom:1px solid #d1d9e0}}
.dark .readme h1,.dark .readme hr{{border-color:#3d444d}}
.readme h2{{font-size:22px;font-weight:600;margin:24px 0 12px}}
.readme p{{margin:0 0 14px}}
.readme .c{{text-align:center}}
.readme a{{color:#0969da}} .dark .readme a{{color:#4493f8}}
.readme img{{vertical-align:middle;max-width:100%}}
.readme .banner{{width:100%;display:block;margin:18px 0 8px}}
.readme hr{{border:0;border-top:1px solid #d1d9e0;margin:24px 0 20px}}
.readme .foot{{text-align:center}}
.readme .foot img{{margin-right:8px}}
@media (prefers-reduced-motion: reduce){{*{{animation:none!important}}}}
</style></head><body><main>
<h1 class="top">Orbit — README banner and logo, round 1 (#1177)</h1>
<p class="lead">Each option as the README would show it, on a white page and a dark page: the header logo at 132px, the banner, and the footer logo at 52px. Every piece of text in the art is outlined, so nothing here depends on a web font.</p>
{"".join(secs)}
</main></body></html>"""

if __name__ == "__main__":
    write("a-logo.svg", logo_a()); write("a-banner.svg", banner_a())
    write("b-logo.svg", logo_b()); write("b-banner.svg", banner_b())
    write("c-logo.svg", logo_c()); write("c-banner.svg", banner_c())
    write("index.html", index())
    print("wrote 6 svg + index.html")
