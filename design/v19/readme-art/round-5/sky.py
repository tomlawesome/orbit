#!/usr/bin/env python3
"""
Round 5 of #1177 — the galactic plane, stars first.

Owner on round 4 (2026-10-01): "Looks like a big blob. I'd say it's worse
now." Then 29b: same composition, more contrast and visible structure at
README size. Round 4 drew the band as haze with sub-pixel stars summed into
it; at README width that is a smear. This one draws the band OUT OF STARS
sized to register at the banner's 1600px (2–4px there, so 4–8px here at 2×),
with almost no haze, and cuts it with a crisp dark rift.

Structural reference (described, not copied): ESO's 360° Milky Way panorama
(Serge Brunier, 2009) around the galactic centre — the bright, broad bulge
at the core; the Great Rift, a dark dust river that splits the band
lengthwise from Cygnus through Aquila to Sagittarius, with ragged edges; the
smaller dark nebulae near the core (the Pipe, the Coalsack's kind); the band
narrowing and fading away from the core on both sides.

In drawing order:
  - stars: a sparse field (disk), a dense band whose width and density peak
    at the core, and a core population; peak brightness on a power law
    (most faint, few bright), colour temperature blue-white → red, bluer in
    the field, yellower in the band, orange at the core. Stars are drawn
    with UNNORMALISED gaussians so a faint star is still a visible dot, not
    a fraction of a pixel
  - the rift: a wandering main lane and four small rifts, each a hard-edged
    mask cut from fractal noise; stars inside are removed (not dimmed), so
    the dark is the background's own black-blue with resolved edges
  - haze: a thin warm glow at the core only, also cut by the rift
  - forty bright foreground stars with small tight bloom; three with short
    spikes
  - light grain
Ground --bg #05070d; the glow is --plane-warm (packs.css). Seeded.
Outputs l-sky.jpg (2×, embedded by build.py) and l-sky-tile.jpg.
"""
import os, math
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 3200, 1680
rng = np.random.default_rng(20261001)

BG = np.array([0x05, 0x07, 0x0d], np.float32) / 255
WARM = np.array([0xff, 0xcf, 0x94], np.float32) / 255

# band geometry (E's river, ×2)
P0 = np.array([-200.0, 280.0]); P1 = np.array([3400.0, 1520.0])
L = float(np.linalg.norm(P1 - P0)); U = (P1 - P0) / L; N = np.array([-U[1], U[0]])
ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
T = (xs - P0[0]) * U[0] + (ys - P0[1]) * U[1]
D = (xs - P0[0]) * N[0] + (ys - P0[1]) * N[1]
T_CORE = 0.74 * L

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
        out += amp * np.interp(x, np.linspace(0, 1, k + 1), r.random(k + 1)).astype(np.float32)
        amp *= 0.5; k *= 2
    out -= out.min(); out /= out.max()
    return out

def smoothstep(a, b, x):
    x = np.clip((x - a) / (b - a), 0, 1); return x * x * (3 - 2 * x)

# ---------------------------------------------------------------- the rift (hard-edged masks)
tt = np.linspace(0, L, 512)
off = (noise1d(512, seed=3) - 0.5) * 200.0
wid = 45.0 + noise1d(512, seed=4) * 70.0
lane = np.exp(-((D - np.interp(T, tt, off)) / np.interp(T, tt, wid)) ** 2)
fine = fbm(8, base=(6, 12), persistence=0.6, seed=5)
rift = smoothstep(0.42, 0.58, lane * (0.55 + 0.9 * fine))
# small rifts near the core, placed like the dark nebulae beside the bulge
for (dt, dd, a, b, sd) in ((-520, 150, 190, 70, 11), (-180, -210, 140, 60, 12), (260, 190, 170, 55, 13), (640, -120, 120, 50, 14)):
    blob = np.exp(-((T - (T_CORE + dt)) / a) ** 2 - ((D - dd) / b) ** 2)
    rift = np.maximum(rift, smoothstep(0.40, 0.56, blob * (0.5 + 1.0 * fbm(6, base=(8, 16), persistence=0.6, seed=sd))))
rift *= np.exp(-(D / 420.0) ** 2)                           # the rift lives in the band
rift = rift.astype(np.float32)

# ---------------------------------------------------------------- stars
STOPS = [(0.00, (165, 190, 255)), (0.25, (210, 220, 255)), (0.45, (255, 250, 240)),
         (0.65, (255, 232, 190)), (0.82, (255, 200, 140)), (1.00, (255, 150, 110))]
def colour(c):
    xs_ = np.array([s[0] for s in STOPS]); cols = np.array([s[1] for s in STOPS], np.float32) / 255
    return np.stack([np.interp(c, xs_, cols[:, i]) for i in range(3)], -1).astype(np.float32)

def powerlaw(n, lo, hi, a):
    """peak amplitudes: most near lo, few near hi (slope a per decade)."""
    u = rng.random(n)
    m = np.log10(1 + u * (10 ** (a * 3.0) - 1)) / a       # 0 .. 3, most near 3
    return lo * (hi / lo) ** (1 - m / 3.0)                  # m=3 → lo, m=0 → hi

def band_sample(n, width_core, width_far, density_far):
    """t along the band, weighted toward the core; d across it, narrower
    away from the core."""
    t = rng.random(n * 2) * (L + 1200) - 600
    w_t = width_far + (width_core - width_far) * np.exp(-((t - T_CORE) / 1500.0) ** 2)
    dens = density_far + (1 - density_far) * np.exp(-((t - T_CORE) / 1800.0) ** 2)
    keep = rng.random(n * 2) < dens
    t = t[keep][:n]; w_t = w_t[keep][:n]
    d = rng.normal(0, 1, len(t)) * w_t
    return P0[0] + t * U[0] + d * N[0], P0[1] + t * U[1] + d * N[1]

def inside(x, y):
    return (x >= 0) & (x < W) & (y >= 0) & (y < H)

# field
fx_, fy_ = rng.random(16000) * W, rng.random(16000) * H
fc_ = rng.beta(2.0, 3.2, 16000); fa_ = powerlaw(16000, 0.10, 3.0, 0.9)
# band
bx_, by_ = band_sample(130000, 300.0, 140.0, 0.28)
bc_ = rng.beta(3.2, 3.0, len(bx_)); ba_ = powerlaw(len(bx_), 0.14, 2.6, 0.85)
# core
ct = rng.normal(T_CORE, 520, 60000); cd = rng.normal(0, 150, 60000)
cx_, cy_ = P0[0] + ct * U[0] + cd * N[0], P0[1] + ct * U[1] + cd * N[1]
cc_ = rng.beta(4.4, 2.6, 60000); ca_ = powerlaw(60000, 0.14, 2.8, 0.85)

X = np.concatenate([fx_, bx_, cx_]); Y = np.concatenate([fy_, by_, cy_])
C = np.concatenate([fc_, bc_, cc_]); A = np.concatenate([fa_, ba_, ca_])
ok = inside(X, Y); X, Y, C, A = X[ok], Y[ok], C[ok], A[ok]
# the rift removes the stars behind it (crisp), with a little leakage
r_here = rift[np.clip(Y.astype(int), 0, H - 1), np.clip(X.astype(int), 0, W - 1)]
ok = rng.random(len(X)) > r_here * 0.96
X, Y, C, A = X[ok], Y[ok], C[ok], A[ok]
RGB = colour(C)

img = np.zeros((H, W, 3), np.float32)

def splat(x, y, a, rgb, sigma, r):
    xi = np.round(x).astype(int); yi = np.round(y).astype(int)
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            wgt = math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma))
            if wgt < 0.01: continue
            xx = np.clip(xi + dx, 0, W - 1); yy = np.clip(yi + dy, 0, H - 1)
            for ch in range(3):
                np.add.at(img[..., ch], (yy, xx), wgt * a * rgb[:, ch])

faint = A < 0.45; mid = (A >= 0.45) & (A < 1.4); bright = A >= 1.4
splat(X[faint], Y[faint], A[faint], RGB[faint], 1.35, 3)
splat(X[mid], Y[mid], A[mid], RGB[mid], 1.7, 4)
splat(X[bright], Y[bright], A[bright], RGB[bright], 2.1, 5)

def bloom(x, y, a, rgb, spikes=False):
    R = 14
    yy, xx = np.mgrid[-R:R + 1, -R:R + 1]; rr = np.sqrt(xx * xx + yy * yy)
    window = np.clip(1.0 - (rr / R) ** 2, 0, 1) ** 2
    halo = np.exp(-rr / 3.2) * 0.28 * a ** 0.5
    if spikes:
        for ax, perp in ((xx, yy), (yy, xx)):
            halo += np.exp(-np.abs(ax) / 7.0) * np.exp(-(perp ** 2) / 0.9) * 0.10 * a ** 0.5
    halo *= window
    x0, y0 = int(round(x)), int(round(y))
    ya, yb = max(0, y0 - R), min(H, y0 + R + 1); xa, xb = max(0, x0 - R), min(W, x0 + R + 1)
    ka, kb = ya - (y0 - R), yb - (y0 - R); la, lb = xa - (x0 - R), xb - (x0 - R)
    img[ya:yb, xa:xb] += halo[ka:kb, la:lb, None] * rgb

nf = 40
gx = rng.random(nf) * W; gy = rng.random(nf) * H
ga = rng.uniform(2.5, 7.0, nf); gc = rng.beta(2.0, 2.6, nf); grgb = colour(gc)
order = np.argsort(ga)[::-1]
for k, i in enumerate(order):
    splat(gx[i:i + 1], gy[i:i + 1], ga[i:i + 1], grgb[i:i + 1], 2.3, 6)
    bloom(gx[i], gy[i], ga[i], grgb[i], spikes=(k < 3))

# ---------------------------------------------------------------- the core's thin glow, nothing else
core = np.exp(-((T - T_CORE) / 420.0) ** 2 - (D / 150.0) ** 2) * 0.34
core += np.exp(-((T - T_CORE) / 900.0) ** 2 - (D / 320.0) ** 2) * 0.05
img += (core * (1.0 - 0.9 * rift))[..., None] * WARM

# ---------------------------------------------------------------- tone, grain
mapped = 1.0 - np.exp(-img * 1.0)
out = BG + (1 - BG) * mapped
out += rng.normal(0, 0.55 / 255, (H, W, 1)).astype(np.float32)   # light grain: heavier grain doubles the PNG
out = np.clip(out, 0, 1)
im = Image.fromarray((out * 255 + 0.5).astype(np.uint8), "RGB")
im.save(os.path.join(HERE, "l-sky.jpg"), quality=86)
cx, cy = int(P0[0] + 0.56 * L * U[0]), int(P0[1] + 0.56 * L * U[1])
im.crop((cx - 300, cy - 300, cx + 300, cy + 300)).save(os.path.join(HERE, "l-sky-tile.jpg"), quality=86)
print("sky written", im.size, "stars", len(X) + nf)
