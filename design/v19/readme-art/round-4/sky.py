#!/usr/bin/env python3
"""
Round 4 of #1177 — the galactic plane as a long-exposure photograph.

Owner, 2026-10-01 (28d): "I want an ultra realistic galactic plane with
glorious detail." This renders After Dark's river as a raster at 2× the
banner (3200×1680) so the vector mark and type can be composited on top.

What is in the sky, in the order it is drawn:
  - a stellar population of ~120,000 stars: a thin uniform disk, a band whose
    density rises steeply toward the plane, and a core where it peaks.
    Magnitudes follow a power law (most faint, few bright); colour
    temperature runs blue-white → white → yellow → orange → red, bluer in the
    disk, yellower in the band, more orange at the core
  - haze: a cool band (--plane-cool), a wide warm bulge and a bright warm
    core (--plane-warm), and faint nebulosity from low-frequency noise
  - dust: a meandering main lane and ragged fractal patches, cut from the
    haze and dimming the stars behind them
  - fourteen bright foreground stars with soft bloom; the brightest six with
    faint diffraction spikes
  - film grain, so nothing is mathematically clean
The ground is the pack's --bg (#05070d); the haze colours are the pack's
--plane-* tokens (packs.css), so the sky still belongs to After Dark.

Outputs beside this file: k-sky.jpg (the 2× plane, embedded by build.py),
k-sky-tile.jpg (a 1:1 crop for the logo tile) and screenshots/sky-crop-*.png
(1:1 crops for the self-review). Seeded, so a run is reproducible.
"""
import os, math
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 3200, 1680
rng = np.random.default_rng(20260816)

BG = np.array([0x05, 0x07, 0x0d], np.float32) / 255
COOL = np.array([0x9f, 0xb0, 0xd6], np.float32) / 255     # --plane-cool
WARM = np.array([0xff, 0xcf, 0x94], np.float32) / 255     # --plane-warm
ROSE = np.array([0xe0, 0xa8, 0xa4], np.float32) / 255     # nebulosity tint, between warm and overdue

# ---------------------------------------------------------------- geometry of the band (E's river, ×2)
P0 = np.array([-200.0, 280.0]); P1 = np.array([3400.0, 1520.0])
L = float(np.linalg.norm(P1 - P0)); U = (P1 - P0) / L; N = np.array([-U[1], U[0]])
ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
T = (xs - P0[0]) * U[0] + (ys - P0[1]) * U[1]          # along the band
D = (xs - P0[0]) * N[0] + (ys - P0[1]) * N[1]          # across it
T_CORE = 0.66 * L

# ---------------------------------------------------------------- noise
def fbm(octaves, base=(6, 11), persistence=0.55, seed=1):
    r = np.random.default_rng(seed)
    out = np.zeros((H, W), np.float32); amp = 1.0; h, w = base
    for _ in range(octaves):
        g = r.random((h + 1, w + 1), dtype=np.float32)
        out += amp * np.asarray(Image.fromarray(g, "F").resize((W, H), Image.BICUBIC), np.float32)
        amp *= persistence; h *= 2; w *= 2
    out -= out.min(); out /= out.max()
    return out

def noise1d(n, octaves=4, base=5, seed=2):
    r = np.random.default_rng(seed)
    x = np.linspace(0, 1, n); out = np.zeros(n, np.float32); amp = 1.0; k = base
    for _ in range(octaves):
        knots = np.linspace(0, 1, k + 1)
        out += amp * np.interp(x, knots, r.random(k + 1)).astype(np.float32)
        amp *= 0.5; k *= 2
    out -= out.min(); out /= out.max()
    return out

# ---------------------------------------------------------------- dust
band = np.exp(-(D / 230.0) ** 2)
core = np.exp(-((T - T_CORE) / 900.0) ** 2 - (D / 170.0) ** 2)
bulge = np.exp(-((T - T_CORE) / 1500.0) ** 2 - (D / 420.0) ** 2)

tt = np.linspace(0, L, 512)
off = (noise1d(512, seed=3) - 0.5) * 220.0            # the main lane wanders about the centre line
wid = 40.0 + noise1d(512, seed=4) * 70.0
lane_off = np.interp(T, tt, off).astype(np.float32)
lane_wid = np.interp(T, tt, wid).astype(np.float32)
lane = np.exp(-((D - lane_off) / lane_wid) ** 2)
fine = fbm(8, base=(5, 10), persistence=0.58, seed=5)   # ragged edges
coarse = fbm(5, base=(4, 8), persistence=0.5, seed=6)   # patch placement
patches = np.clip((coarse * 0.55 + fine * 0.45 - 0.47) * 3.5, 0, 1)
dust = np.maximum(lane * np.clip((fine - 0.18) * 1.9, 0, 1), patches * 0.9)
finer = fbm(6, base=(12, 24), persistence=0.6, seed=9)   # the lanes' own fine grain
dust *= 0.65 + 0.5 * finer
dust *= np.exp(-(D / 300.0) ** 2)                      # dust lives in the plane
dust = np.clip(dust, 0, 1).astype(np.float32)

# ---------------------------------------------------------------- haze
neb = np.clip(fbm(5, base=(3, 6), persistence=0.5, seed=7) - 0.42, 0, 1) * band
cloud = 0.55 + 0.9 * fbm(6, base=(6, 12), persistence=0.55, seed=8)   # the haze is not smooth
lin = np.zeros((H, W, 3), np.float32)
lin += (band * 0.10 * cloud)[..., None] * COOL
lin += (bulge * 0.16 * cloud)[..., None] * WARM
lin += (core * 0.6)[..., None] * WARM
lin += (neb * 0.14)[..., None] * ROSE
lin *= (1.0 - 0.92 * dust)[..., None]

# ---------------------------------------------------------------- stars
STOPS = [(0.00, (160, 185, 255)), (0.25, (205, 215, 255)), (0.45, (255, 250, 240)),
         (0.65, (255, 232, 190)), (0.82, (255, 200, 140)), (1.00, (255, 150, 110))]
def colour(c):
    xs_ = np.array([s[0] for s in STOPS]); cols = np.array([s[1] for s in STOPS], np.float32) / 255
    return np.stack([np.interp(c, xs_, cols[:, i]) for i in range(3)], -1).astype(np.float32)

def magnitudes(n, lo, hi, a=0.5):
    u = rng.random(n)
    return lo + np.log10(1 + u * (10 ** (a * (hi - lo)) - 1)) / a

def population(n, kind):
    if kind == "disk":
        x = rng.random(n) * W; y = rng.random(n) * H
        c = rng.beta(2.2, 3.0, n)
    else:
        if kind == "band":
            t = rng.random(n) * (L + 1200) - 600
            d = rng.normal(0, 215, n)
        else:
            t = rng.normal(T_CORE, 650, n)
            d = rng.normal(0, 150, n)
        x = P0[0] + t * U[0] + d * N[0]; y = P0[1] + t * U[1] + d * N[1]
        c = rng.beta(3.2, 3.0, n) if kind == "band" else rng.beta(4.2, 2.6, n)
    m = magnitudes(n, 2.0, 9.0, a=0.5) if kind == "disk" else magnitudes(n, 3.5, 9.5, a=0.6)
    keep = (x >= 0) & (x < W) & (y >= 0) & (y < H)
    return x[keep], y[keep], c[keep], m[keep]

pops = [population(30000, "disk"), population(190000, "band"), population(90000, "core")]
X = np.concatenate([p[0] for p in pops]); Y = np.concatenate([p[1] for p in pops])
C = np.concatenate([p[2] for p in pops]); M = np.concatenate([p[3] for p in pops])
F0 = 7.0
flux = F0 * 10 ** (-0.4 * (M - 3.0))
# stars behind the dust are dimmed, in the plane only
flux *= 1.0 - 0.85 * dust[np.clip(Y.astype(int), 0, H - 1), np.clip(X.astype(int), 0, W - 1)]
RGB = colour(C)

stars = np.zeros((H, W, 3), np.float32)

def splat_bilinear(x, y, f, rgb):
    x0 = np.floor(x).astype(int); y0 = np.floor(y).astype(int)
    fx = (x - x0).astype(np.float32); fy = (y - y0).astype(np.float32)
    for dx, dy, wgt in ((0, 0, (1 - fx) * (1 - fy)), (1, 0, fx * (1 - fy)), (0, 1, (1 - fx) * fy), (1, 1, fx * fy)):
        xi = np.clip(x0 + dx, 0, W - 1); yi = np.clip(y0 + dy, 0, H - 1)
        for ch in range(3):
            np.add.at(stars[..., ch], (yi, xi), wgt * f * rgb[:, ch])

def splat_gauss(x, y, f, rgb, sigma, r):
    xi = np.round(x).astype(int); yi = np.round(y).astype(int)
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            wgt = math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma)) / (2 * math.pi * sigma * sigma)
            xx = np.clip(xi + dx, 0, W - 1); yy = np.clip(yi + dy, 0, H - 1)
            for ch in range(3):
                np.add.at(stars[..., ch], (yy, xx), wgt * f * rgb[:, ch])

faint = flux < 0.35; mid = (flux >= 0.35) & (flux < 4.0); bright = flux >= 4.0
splat_bilinear(X[faint], Y[faint], flux[faint], RGB[faint])
splat_gauss(X[mid], Y[mid], flux[mid], RGB[mid], 0.85, 3)
splat_gauss(X[bright], Y[bright], flux[bright], RGB[bright], 1.25, 5)

def bloom(x, y, f, rgb, spikes=False):
    """A bright star's soft halo, and optionally four faint diffraction spikes."""
    R = int(min(48, 8 + 4.5 * f ** 0.5))
    yy, xx = np.mgrid[-R:R + 1, -R:R + 1]
    rr = np.sqrt(xx * xx + yy * yy)
    window = np.clip(1.0 - (rr / R) ** 2, 0, 1) ** 2            # to zero at the edge: no square
    halo = (np.exp(-rr / (0.25 * R)) * 0.09 + np.exp(-(rr / (0.6 * R)) ** 2) * 0.012) * f ** 0.65
    if spikes:
        for ax, perp in ((xx, yy), (yy, xx)):
            halo += np.exp(-np.abs(ax) / (0.5 * R)) * np.exp(-(perp ** 2) / 1.1) * 0.035 * f ** 0.5
    halo *= window
    x0, y0 = int(round(x)), int(round(y))
    ya, yb = max(0, y0 - R), min(H, y0 + R + 1); xa, xb = max(0, x0 - R), min(W, x0 + R + 1)
    ka, kb = ya - (y0 - R), yb - (y0 - R); la, lb = xa - (x0 - R), xb - (x0 - R)
    stars[ya:yb, xa:xb] += halo[ka:kb, la:lb, None] * rgb

# the brightest of the field bloom a little
for i in np.argsort(flux)[-90:]:
    bloom(X[i], Y[i], flux[i], RGB[i])
# foreground stars: few, bright, blooming, the brightest with spikes
nf = 12
fx = rng.random(nf) * W; fy = rng.random(nf) * H
fm = rng.uniform(0.2, 2.2, nf); fc = rng.beta(2.0, 2.4, nf)
ff = F0 * 10 ** (-0.4 * (fm - 3.0)); frgb = colour(fc)
order = np.argsort(ff)[::-1]
for k, i in enumerate(order):
    splat_gauss(fx[i:i + 1], fy[i:i + 1], ff[i:i + 1], frgb[i:i + 1], 1.5, 6)
    bloom(fx[i], fy[i], ff[i], frgb[i], spikes=(k < 5))

# ---------------------------------------------------------------- compose, tone, grain
lin += stars
mapped = 1.0 - np.exp(-lin * 0.9)
out = BG + (1 - BG) * mapped
grain = rng.normal(0, 1.4 / 255, (H, W, 1)).astype(np.float32) + rng.normal(0, 0.6 / 255, (H, W, 3)).astype(np.float32)
out = np.clip(out + grain, 0, 1)
img = Image.fromarray((out * 255 + 0.5).astype(np.uint8), "RGB")
img.save(os.path.join(HERE, "k-sky.jpg"), quality=93, subsampling=0)

# the logo tile's crop: a 1:1 window on the plane, where the band is rich
cx, cy = int(P0[0] + 0.57 * L * U[0]), int(P0[1] + 0.57 * L * U[1])
img.crop((cx - 300, cy - 300, cx + 300, cy + 300)).save(os.path.join(HERE, "k-sky-tile.jpg"), quality=92, subsampling=0)

# review crops at 1:1
os.makedirs(os.path.join(HERE, "screenshots"), exist_ok=True)
ccx, ccy = int(P0[0] + T_CORE * U[0]), int(P0[1] + T_CORE * U[1])
img.crop((ccx - 450, ccy - 250, ccx + 450, ccy + 250)).save(os.path.join(HERE, "screenshots", "sky-crop-core.png"))
img.crop((500, 150, 1400, 650)).save(os.path.join(HERE, "screenshots", "sky-crop-dust.png"))
print("sky written", img.size, "stars", len(X) + nf)
