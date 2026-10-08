#!/usr/bin/env python3
"""Writes the round's three pages from one scaffold: python3 build.py"""
from pathlib import Path
import math

ROOT = Path(__file__).resolve().parent
S, RP = 320, 36                 # sun.py's picture: side and disc radius, px
RD = 9.5                        # the disc's radius on the dial, units (today: core r=7 in a r=13 glow; pocket r=8 in r=16)
SIDE = RD * S / RP              # the picture's side in dial units
DESK, PHONE = 640 / 380, 358 / 380      # px per unit
VB = (95, 112, 190, 166)        # the crop: dial units 95–285 × 112–278

PACKS = [
    ("starchart", "Star chart (dark, default)", False),
    ("dawn", "Dawn (light)", True),
    ("retrograde", "Retrograde (dark)", False),
]
NAMES = [("short", "The Lawsons", ["The Lawsons"]),
         ("long", "The Fitzwilliam-Hargreaves Household", ["The Fitzwilliam-", "Hargreaves Household"])]

STARS = """<g aria-hidden="true"><circle cx="104" cy="120" r="0.5" fill="var(--star)" opacity="0.22"/><circle cx="131" cy="247" r="0.7" fill="var(--star)" opacity="0.3"/><circle cx="276" cy="131" r="0.6" fill="var(--star)" opacity="0.28"/><circle cx="238" cy="258" r="0.45" fill="var(--star)" opacity="0.2"/><circle cx="99" cy="190" r="0.8" fill="var(--star)" opacity="0.33"/><circle cx="262" cy="120" r="0.5" fill="var(--star)" opacity="0.25"/><circle cx="150" cy="125" r="0.55" fill="var(--star)" opacity="0.2"/><circle cx="281" cy="215" r="0.7" fill="var(--star)" opacity="0.31"/></g>"""
DIAL = """<circle cx="190" cy="190" r="62" fill="url(#danger4)"/>
  <circle class="r62" cx="190" cy="190" r="62" fill="none" stroke="var(--overdue)" stroke-opacity=".3" stroke-width="1" stroke-dasharray="3 5"/>
  <circle class="r106" cx="190" cy="190" r="106" fill="none" stroke="var(--chart-line-soft)" stroke-width=".75"/>
  <g class="body-link" aria-hidden="true">
    <circle cx="152" cy="166" r="4.5" fill="url(#p-ruby)"/><circle class="spec" cx="151.1" cy="167.1" r="1.5" fill="rgba(255,255,255,.38)"/>
    <circle cx="248" cy="148" r="6" fill="url(#p-jade)"/><circle class="spec" cx="246.8" cy="149.5" r="2" fill="rgba(255,255,255,.38)"/>
    <circle cx="266" cy="238" r="5" fill="url(#p-amber)"/><circle class="spec" cx="265" cy="239.2" r="1.65" fill="rgba(255,255,255,.38)"/>
  </g>"""

HEAD = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Orbit #1250 · {title}</title>
<style>
@font-face{{font-family:'Inter Variable';font-weight:100 900;font-display:block;src:url(fonts/inter-latin-wght-normal.woff2) format('woff2')}}
@font-face{{font-family:'JetBrains Mono Variable';font-weight:100 800;font-display:block;src:url(fonts/jetbrains-mono-latin-wght-normal.woff2) format('woff2')}}
@font-face{{font-family:'Space Grotesk';font-weight:600;font-display:block;src:url(fonts/space-grotesk-latin-600-normal.woff2) format('woff2')}}
*{{box-sizing:border-box}}
:root{{--mono:'JetBrains Mono Variable',ui-monospace,Menlo,monospace;--ui:'Inter Variable',Inter,system-ui,sans-serif;--display:'Space Grotesk',var(--ui)}}
html,body{{margin:0;background:#0c1020;color:#dfe3ee;font:14px/1.5 var(--ui)}}
header{{padding:18px 24px 8px;max-width:1240px;margin:0 auto}}
header h1{{font:600 20px var(--display);margin:0 0 2px;letter-spacing:.01em}}
header p{{margin:0 0 6px;color:#9aa3bd;max-width:78ch}}
header p b{{color:#dfe3ee;font-weight:600}}
main{{max-width:1240px;margin:0 auto;padding:8px 24px 40px;display:grid;gap:18px}}
.pack>h2{{margin:6px 0 10px;font:500 11px var(--mono);letter-spacing:.18em;text-transform:uppercase;color:#9aa3bd}}
.cells{{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end}}
figure{{margin:0}}
figcaption{{font:11px var(--mono);letter-spacing:.08em;color:#7d879f;margin-top:5px;text-transform:uppercase}}
.stage{{position:relative;border-radius:10px;background:var(--ground);overflow:hidden}}
.stage svg{{display:block}}
.stage canvas{{position:absolute;pointer-events:none;display:none}}
/* The dial's own grammar (home.css): rings thicken on paper, no specular, and only the sun glows there. */
.light .r106{{stroke-width:1.1}}
.light .r62{{stroke-width:1.4}}
.light .spec{{fill:transparent}}
.sun-link{{cursor:pointer}}
.sun-link text{{font-family:var(--ui);fill:var(--ink-mid);transition:fill .3s}}
.sun-link:is(:hover,:focus-visible) text{{fill:var(--ink)}}
.sun-link:is(:hover,:focus-visible) image{{filter:brightness(1.12)}}
.sun-link image{{transition:filter .3s}}
.sun image{{transform-box:fill-box;transform-origin:50% 50%}}
{css}
@media (prefers-reduced-motion:reduce){{.sun *{{animation:none!important}}.lapse .f1,.lapse .f2{{display:none}}}}
@media (max-width:900px){{.desk{{display:none}}header,main{{padding-left:16px;padding-right:16px}}}}

/* Tokens copied from web/src/lib/packs.css — only what the crop paints. */
[data-theme=starchart]{{--bg:#060b1c;--ink:#e9edf8;--ink-mid:#8791b3;--overdue:#f87171;--chart-line-soft:#17203f;--ground:var(--bg);--star:#e9edf8}}
[data-theme=dawn]{{--sky-2:#c2cad9;--sky-3:#d7d5cf;--ink:#18202f;--ink-mid:#343d51;--overdue:#c22a63;--chart-line-soft:rgba(26,34,51,.24);--ground:linear-gradient(180deg,var(--sky-2),var(--sky-3));--star:#18202f}}
[data-theme=retrograde]{{--bg:#080a14;--ink:#eef6ff;--ink-mid:#a9d8e6;--overdue:#ff3864;--chart-line-soft:#164b5c;--ground:var(--bg);--star:#eef6ff}}
</style></head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <radialGradient id="danger4" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#f87171" stop-opacity=".16"/><stop offset="85%" stop-color="#f87171" stop-opacity="0"/></radialGradient>
  <radialGradient id="p-ruby" cx="34%" cy="30%" r="72%"><stop offset="0%" stop-color="#ffb3ab"/><stop offset="42%" stop-color="#e0453e"/><stop offset="100%" stop-color="#7e1a1f"/></radialGradient>
  <radialGradient id="p-jade" cx="34%" cy="30%" r="72%"><stop offset="0%" stop-color="#b8f5cf"/><stop offset="45%" stop-color="#2fae6a"/><stop offset="100%" stop-color="#12603a"/></radialGradient>
  <radialGradient id="p-amber" cx="34%" cy="30%" r="72%"><stop offset="0%" stop-color="#ffe1a0"/><stop offset="45%" stop-color="#f0a52b"/><stop offset="100%" stop-color="#8a5a10"/></radialGradient>
</defs></svg>
<header><h1>{title}</h1><p><b>#1250, round 2.</b> {blurb}</p><p>{motion}</p></header>
<main>"""

DIRECTIONS = {
    "photosphere": dict(
        title="Photosphere — the Sun in white light",
        blurb="The disc is the Sun itself: SDO/HMI's white-light picture of 10 May 2024 (the sunspot group AR 3664 low right, the one that lit that month's aurorae), with its own limb darkening, graded to each pack's sun. A thin chromosphere at the rim; beyond it the K-corona (Baumbach's fall-off, streamers) and the lens's bloom, as a second picture laid underneath. On dawn it is the sunrise sun — air-reddened, no corona, a warm haze on the paper — so it stays the one thing allowed to glow there, with an ember at its heart.",
        motion="Life: the corona turns once in three minutes and breathes at the app's 4.2 s; the disc never spins (a spinning sun reads as a coin). Reduced motion: both still. Ships as two pictures per pack (3 KB disc + 16–19 KB corona; dawn 15 KB, one picture); per frame, one compositor transform and one opacity.",
        css=""".sun .corona{animation:turn 180s linear infinite,breathe 4.2s ease-in-out infinite}
@keyframes turn{to{transform:rotate(360deg)}}
@keyframes breathe{0%,100%{opacity:1}50%{opacity:.62}}
.sun-link:is(:hover,:focus-visible) .corona{opacity:1;animation-play-state:paused}"""),
    "chromosphere": dict(
        title="Chromosphere — the Sun in the light of helium",
        blurb="The disc is SDO/AIA's 304 Å picture of the same day: the chromosphere's bright network, active regions, dark filaments, and prominences lifting off both limbs, kept beyond the disc as light; the inner corona's loops from AIA 171 Å beneath the streamers. Three frames an hour apart (12:08, 13:07, 14:09 UTC) are cross-faded, so what moves on the sun is the Sun's own motion. Graded to each pack: gold on the chart, amber ember on dawn, magenta on retrograde.",
        motion="Life: a 36 s loop of the three frames, each fade 2.2 s. Reduced motion: the first frame only. Ships as three pictures per pack (17–20 KB each; dawn 15 KB); per frame, two compositor opacities.",
        css=""".lapse image{animation:lapse 36s ease-in-out infinite}
.lapse .f1{animation-delay:-24s}.lapse .f2{animation-delay:-12s}
@keyframes lapse{0%,27%{opacity:1}33%,94%{opacity:0}100%{opacity:1}}
.lapse .f0{animation-name:none;opacity:1}"""),
    "furnace": dict(
        title="Furnace — a star, modelled and alive",
        blurb="No photograph: a physically-based model of a G-type star, drawn live by a small shader at the dial's centre — Pierce & Slaughter's limb darkening, convective granulation (bright cells parted by dark lanes, foreshortened to the limb, churning), a spot group with penumbrae, faculae brightening towards the limb, a chromosphere at the rim, a streamer corona drifting, the film's bloom and tone curve. The same formulas, run once in sun.py, make the still that stands in where motion is reduced or WebGL is missing.",
        motion="Life: granules convect and the streamers drift, continuously. Per frame: one quad the picture's size (at most 256 px square at 2×), about forty noise lookups a pixel; nothing else redraws. Reduced motion or no WebGL: the still (16–20 KB; dawn 16 KB).",
        css=""".stage.live .still{visibility:hidden}.stage.live canvas{display:block}"""),
}

GLSL = r"""
precision highp float;
uniform vec2 uRes; uniform float uT, uPx, uExpo, uLight;
uniform vec3 uLimb, uMid, uCore, uRim, uC0, uC1, uC2, uHaze;
float hash3(vec3 i){ return fract(sin(dot(i, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vnoise(vec3 p){ vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float x0 = mix(hash3(i), hash3(i + vec3(1,0,0)), f.x), x1 = mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x);
  float x2 = mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x), x3 = mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x);
  return mix(mix(x0, x1, f.y), mix(x2, x3, f.y), f.z); }
vec3 tint(float I){ return mix(mix(uLimb, uMid, smoothstep(0.15, 0.85, I)), uCore, smoothstep(0.7, 1.15, I)); }
vec3 toSrgb(vec3 c){ return mix(c * 12.92, 1.055 * pow(max(c, 0.0), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main(){
  vec2 p = (gl_FragCoord.xy - uRes * 0.5) / (uRes.x * UNIT); p.y = -p.y;
  float r2 = dot(p, p), r = sqrt(r2), mu = sqrt(max(0.0, 1.0 - r2));
  float cover = clamp((1.0 - r) / uPx + 0.5, 0.0, 1.0);
  float t = uT;
  /* the photosphere: Pierce & Slaughter at 5500 Å; granules in two octaves; spots; faculae */
  float ld = 1.0 - 0.66 * (1.0 - mu) - 0.10 * (1.0 - mu * mu);
  vec2 q = p / 0.11; vec2 dir = p / max(r, 1e-3);
  q += dir * dot(dir, q) * (1.0 / max(mu, 0.25) - 1.0) * 0.5;
  float g1 = 1.0 - abs(vnoise(vec3(q, t * 0.5)) * 2.0 - 1.0), g2 = 1.0 - abs(vnoise(vec3(q * 2.7 + 7.0, t * 0.9)) * 2.0 - 1.0);
  float gran = smoothstep(0.25, 0.95, g1 * 0.7 + g2 * 0.3);
  float dark = 1.0;
  vec3 sp[3]; sp[0] = vec3(-0.42, 0.28, 0.11); sp[1] = vec3(-0.22, 0.33, 0.07); sp[2] = vec3(0.38, -0.47, 0.045);
  for (int k = 0; k < 3; k++){ float d = length(p - sp[k].xy), sr = sp[k].z;
    dark *= 0.12 + 0.88 * smoothstep(sr * 0.45, sr * 0.6, d); dark *= 0.72 + 0.28 * smoothstep(sr * 0.9, sr * 1.25, d); }
  float fac = smoothstep(0.55, 0.9, vnoise(vec3(q * 0.35 + 11.0, 2.0))) * pow(1.0 - mu, 1.5) * 0.5;
  float I = ld * (0.8 + 0.32 * gran) * dark * (1.0 + fac) * step(r2, 1.0);
  float h = max(r - 1.0, 0.0);
  if (uLight > 0.5){
    /* paper: the sunrise sun, a warm haze; no corona */
    vec3 col = tint(I * 0.95);
    float rimk = exp(-pow((r - 1.0) / 0.035, 2.0)) * (1.0 - cover) * 0.9;
    float ha = (0.62 * exp(-h / 0.32) + 0.30 * exp(-h / 1.4)) * (1.0 - cover) * smoothstep(4.4, 2.8, r);
    vec3 rgb = col * cover + uRim * rimk + uHaze * (1.0 - rimk) * ha;
    float a = clamp(cover + rimk + (1.0 - rimk) * ha, 0.0, 1.0);
    gl_FragColor = vec4(toSrgb(rgb / max(a, 1e-4)) * a, a); return;
  }
  vec3 disc = tint(I) * I * uExpo * cover;
  vec3 hdr = disc + uRim * exp(-pow((r - 1.0) / 0.02, 2.0)) * 0.9 * (1.0 - cover);
  /* the corona: Baumbach's fall-off, streamers in two scales, drifting */
  float rr = max(r, 1.0), lr = log(rr), a = atan(p.y, p.x) + t * 0.02;
  float n1 = vnoise(vec3(cos(a) * 4.0, sin(a) * 4.0, lr * 1.4 + t * 0.1)), n2 = vnoise(vec3(cos(a) * 11.0, sin(a) * 11.0, lr * 2.6 + 3.0 + t * 0.1));
  float stream = 0.62 + 0.55 * n1 * n1 + 0.22 * n2 * n2 * n2;
  float fall = 0.45 * pow(rr, -2.5) + 0.35 * pow(rr, -7.0);
  vec3 ccol = mix(mix(uC0, uC1, smoothstep(0.0, 1.6, lr)), uC2, smoothstep(1.8, 3.6, lr));
  float edge = smoothstep(4.4, 2.6, r);
  hdr += ccol * stream * fall * 0.9 * smoothstep(0.98, 1.05, r) * edge;
  /* the bloom, as the still has it (two gaussians of the disc), in closed form */
  vec3 bl = tint(0.8) * uExpo * 0.72;
  hdr += bl * (0.09 * exp(-h * h / 0.1) + 0.07 * exp(-h * h / 1.45) * 0.55) * edge;
  vec3 rgb = 1.0 - exp(-hdr * 1.6);
  float lum = max(rgb.r, max(rgb.g, rgb.b));
  float aOut = max(cover, clamp(lum, 0.0, 1.0));
  gl_FragColor = vec4(toSrgb(clamp(rgb / max(aOut, 1e-4), 0.0, 1.0)) * aOut, aOut);
}"""

FURNACE_JS = r"""
<script>
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return;
  const lin = h => [1, 3, 5].map(i => { const c = parseInt(h.slice(i, i + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  const PACKS = {
    starchart: { light: 0, expo: 1.05, limb: '#f2b64a', mid: '#ffe9c4', core: '#fff6e6', rim: '#ff6e3a', c0: '#fff3dc', c1: '#d8b45a', c2: '#8a6cc0', haze: '#000000' },
    dawn: { light: 1, expo: 1.0, limb: '#a8420c', mid: '#e18a34', core: '#f3b060', rim: '#7e2c0a', c0: '#000000', c1: '#000000', c2: '#000000', haze: '#eda253' },
    retrograde: { light: 0, expo: 1.05, limb: '#c81e96', mid: '#ff4fd8', core: '#fff0fb', rim: '#4fe3ff', c0: '#ffd9f5', c1: '#ff4fd8', c2: '#6a3cff', haze: '#000000' },
  };
  const FS = `GLSL_HERE`.replace('UNIT', String(UNIT_HERE));
  const VS = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  const live = [];
  for (const stage of document.querySelectorAll('.stage[data-sun]')) {
    const cv = stage.querySelector('canvas'); const P = PACKS[stage.dataset.sun];
    const gl = cv.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false });
    if (!gl) continue;
    const dpr = Math.min(devicePixelRatio || 1, 2); const w = Math.round(parseFloat(cv.style.width) * dpr);
    cv.width = w; cv.height = w;
    const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
    const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr); gl.useProgram(pr);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = n => gl.getUniformLocation(pr, n);
    gl.uniform2f(u('uRes'), w, w); gl.uniform1f(u('uPx'), 1 / (w * UNIT_HERE)); gl.uniform1f(u('uExpo'), P.expo); gl.uniform1f(u('uLight'), P.light);
    for (const k of ['limb', 'mid', 'core', 'rim', 'c0', 'c1', 'c2', 'haze']) gl.uniform3fv(u('u' + k[0].toUpperCase() + k.slice(1)), lin(P[k]));
    gl.viewport(0, 0, w, w);
    live.push({ gl, uT: u('uT') }); stage.classList.add('live');
  }
  const t0 = performance.now();
  const frame = () => { const t = (performance.now() - t0) / 1000; for (const { gl, uT } of live) { gl.uniform1f(uT, t); gl.drawArrays(gl.TRIANGLES, 0, 3); } requestAnimationFrame(frame); };
  if (live.length) requestAnimationFrame(frame);
})();
</script>"""


def sun_markup(direction, pack, light):
    x0 = 190 - SIDE / 2
    img = lambda href, cls: f'<image class="{cls}" href="{href}" x="{x0:.2f}" y="{x0:.2f}" width="{SIDE:.2f}" height="{SIDE:.2f}"/>'
    if direction == "photosphere":
        cor = "" if light else img(f"img/photosphere-{pack}-corona.webp", "corona")
        return f'<g class="sun">{cor}{img(f"img/photosphere-{pack}.webp", "disc")}</g>'
    if direction == "chromosphere":
        return '<g class="sun lapse">' + "".join(img(f"img/chromosphere-{pack}-{k}.webp", f"f{k}") for k in range(3)) + "</g>"
    return f'<g class="sun">{img(f"img/furnace-{pack}.webp", "still")}</g>'


def cell(direction, pack, light, scale, kind, name, lines):
    vx, vy, vw, vh = VB
    W, H = vw * scale, vh * scale
    if kind == "desk":
        fs, y0, lh = 10, 212, 12.5
    else:
        fs, y0, lh = 15, 218, 17
        if len(lines) > 1: lines = ["The Fitzwilliam-", "Hargreaves", "Household"]
    tspans = "".join(f'<tspan x="190" y="{y0 + i * lh:.1f}">{l}</tspan>' for i, l in enumerate(lines))
    x0 = 190 - SIDE / 2
    canvas = ""
    attrs = ""
    if direction == "furnace":
        attrs = f' data-sun="{pack}"'
        canvas = f'<canvas style="left:{(x0 - vx) * scale:.2f}px;top:{(x0 - vy) * scale:.2f}px;width:{SIDE * scale:.2f}px;height:{SIDE * scale:.2f}px" aria-hidden="true"></canvas>'
    return f"""<figure class="{'desk' if kind == 'desk' else 'pocket'}">
<div class="stage{' light' if light else ''}" style="width:{W:.1f}px;height:{H:.1f}px"{attrs}>
<svg viewBox="{vx} {vy} {vw} {vh}" width="{W:.1f}" height="{H:.1f}" role="img" aria-label="{name} under the sun, {kind} scale">
  {STARS}
  {DIAL}
  <a class="sun-link" href="#" aria-label="Open {name}">
    {sun_markup(direction, pack, light)}
    <text font-size="{fs}" text-anchor="middle">{tspans}</text>
  </a>
</svg>{canvas}
</div>
<figcaption>{'desk 640px dial' if kind == 'desk' else 'phone 358px dial'} · {'short' if len(lines) == 1 else 'long'}</figcaption>
</figure>
"""


def page(direction):
    D = DIRECTIONS[direction]
    out = [HEAD.format(title=D["title"], blurb=D["blurb"], motion=D["motion"], css=D["css"])]
    for pack, label, light in PACKS:
        out.append(f'<section class="pack" data-theme="{pack}"><h2>{label}</h2><div class="cells">')
        for kind, scale in (("desk", DESK), ("phone", PHONE)):
            for _, name, lines in NAMES:
                out.append(cell(direction, pack, light, scale, kind, name, lines))
        out.append("</div></section>")
    out.append("</main>")
    if direction == "furnace":
        out.append(FURNACE_JS.replace("GLSL_HERE", GLSL).replace("UNIT_HERE", f"{RP / S:.6f}"))
    out.append("</body></html>\n")
    (ROOT / f"{direction}.html").write_text("".join(out))
    print("wrote", f"{direction}.html")


if __name__ == "__main__":
    for d in DIRECTIONS:
        page(d)
