#!/usr/bin/env python3
"""
The dial's sun, rendered once, here, into pictures — the way orbit-site's
tools/planets.py renders the door's planets: from real maps, supersampled,
lit in linear light, tone-mapped with the same film shoulder, the light
beyond the disc carried as alpha so it adds over the sky.

Three directions, three renderers (one of each per pack):

  photosphere  the Sun in white light: SDO/HMI's intensitygram of
               2024-05-10 12:10 UTC (sunspot group AR 3664 on the disc,
               the one that lit the May 2024 aurorae), its own limb
               darkening and spots; a thin chromosphere at the rim; the
               K-corona as a separate layer the page turns slowly.
  chromosphere the Sun in the light of helium: SDO/AIA 304 Å, three frames
               an hour apart (12:08, 13:07, 14:09 UTC), prominences kept
               beyond the limb; the page cross-fades them, so the sun's
               motion is the Sun's own.
  furnace      no photograph: a physically-based model (Pierce–Slaughter
               limb darkening, convective granulation, spots, faculae,
               chromosphere, streamer corona) written so the page's live
               shader draws the same thing, moving; this still is its
               reduced-motion and no-WebGL face.

Sources (NASA/SDO and the AIA and HMI science teams; NASA imagery is in
the public domain, credit requested):
  https://sdo.gsfc.nasa.gov/assets/img/browse/2024/05/10/20240510_121038_1024_HMII.jpg
  https://sdo.gsfc.nasa.gov/assets/img/browse/2024/05/10/20240510_120854_1024_0304.jpg
  https://sdo.gsfc.nasa.gov/assets/img/browse/2024/05/10/20240510_130730_1024_0304.jpg
  https://sdo.gsfc.nasa.gov/assets/img/browse/2024/05/10/20240510_140930_1024_0304.jpg
  https://sdo.gsfc.nasa.gov/assets/img/browse/2024/05/10/20240510_120710_1024_0171.jpg
  (kept in src/; the script reads them from there)

  python3 sun.py   → img/<direction>-<pack>[-<layer>].webp
"""
import numpy as np
from PIL import Image
from pathlib import Path
from scipy.ndimage import gaussian_filter

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
OUT = ROOT / "img"
OUT.mkdir(exist_ok=True)

S = 320          # the picture's side, px
RP = 36          # the disc's radius in it, px  (the page sizes the picture at S / (2 RP) times the disc)
SS = 3           # supersampling

# ── colour ───────────────────────────────────────────────────────────────
def hexc(h):
    h = h.lstrip("#"); return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)], np.float32)
def srgb_to_lin(c): return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
def lin_to_srgb(c): return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(np.maximum(c, 0), 1 / 2.4) - 0.055)
def lin(h): return srgb_to_lin(hexc(h))
def mix(a, b, t): t = np.asarray(t, np.float32)[..., None]; return a * (1 - t) + b * t

# the packs' suns: the tokens (--sun-core, --sun) and the deeper stops a photograph needs
PACKS = {
    "starchart": dict(light=False, core="#fff6e6", mid="#ffe9c4", limb="#f2b64a", rim="#ff6e3a",
                      corona=("#fff3dc", "#d8b45a", "#8a6cc0"), bloom="#ffe9c4", expo=1.05,
                      chromo=("#b86a14", "#f0b429", "#fff3dc")),
    "dawn": dict(light=True, core="#f3b060", mid="#e18a34", limb="#a8420c", rim="#7e2c0a",
                 haze="#eda253", expo=1.0, chromo=("#8e3408", "#dc8630", "#f3b060")),
    "retrograde": dict(light=False, core="#fff0fb", mid="#ff4fd8", limb="#c81e96", rim="#4fe3ff",
                       corona=("#ffd9f5", "#ff4fd8", "#6a3cff"), bloom="#ff4fd8", expo=1.05,
                       chromo=("#7a1060", "#ff4fd8", "#fff0fb")),
}

# ── the frame ────────────────────────────────────────────────────────────
n = S * SS
ys, xs = np.mgrid[0:n, 0:n].astype(np.float32)
X = ((xs + 0.5) / SS - S / 2) / RP; Y = ((ys + 0.5) / SS - S / 2) / RP     # in disc radii
R2 = X * X + Y * Y; Rr = np.sqrt(R2)
HIT = R2 < 1.0
MU = np.sqrt(np.maximum(0.0, 1.0 - R2))                                     # cos of the angle from the disc centre
ANG = np.arctan2(Y, X)
# the limb, smoothed: a pixel the edge passes through is covered by how much of it is inside
px = 1.0 / (RP * SS)
COVER = np.clip((1.0 - Rr) / px + 0.5, 0, 1)

# ── noise (the shader has the same: value noise, three octaves) ───────────
def hash3(ix, iy, iz):
    v = np.sin(ix * 127.1 + iy * 311.7 + iz * 74.7) * 43758.5453
    return v - np.floor(v)
def vnoise(p):
    i = np.floor(p); f = p - i; f = f * f * (3 - 2 * f)
    def h(dx, dy, dz): return hash3(i[..., 0] + dx, i[..., 1] + dy, i[..., 2] + dz)
    x0 = h(0, 0, 0) * (1 - f[..., 0]) + h(1, 0, 0) * f[..., 0]; x1 = h(0, 1, 0) * (1 - f[..., 0]) + h(1, 1, 0) * f[..., 0]
    x2 = h(0, 0, 1) * (1 - f[..., 0]) + h(1, 0, 1) * f[..., 0]; x3 = h(0, 1, 1) * (1 - f[..., 0]) + h(1, 1, 1) * f[..., 0]
    y0 = x0 * (1 - f[..., 1]) + x1 * f[..., 1]; y1 = x2 * (1 - f[..., 1]) + x3 * f[..., 1]
    return y0 * (1 - f[..., 2]) + y1 * f[..., 2]
def smoothstep(a, b, x): t = np.clip((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t)

# ── the sources ──────────────────────────────────────────────────────────
def load_disc(name, cx, cy, rs):
    """an SDO browse image as a field over the frame: (x, y) in disc radii → the pixel there"""
    im = np.asarray(Image.open(SRC / name).convert("RGB"), np.float32) / 255.0
    h, w = im.shape[:2]
    u = cx + X * rs; v = cy + Y * rs
    x0 = np.clip(np.floor(u).astype(int), 0, w - 2); y0 = np.clip(np.floor(v).astype(int), 0, h - 2)
    fx = np.clip(u - x0, 0, 1)[..., None]; fy = np.clip(v - y0, 0, 1)[..., None]
    out = (im[y0, x0] * (1 - fx) + im[y0, x0 + 1] * fx) * (1 - fy) + (im[y0 + 1, x0] * (1 - fx) + im[y0 + 1, x0 + 1] * fx) * fy
    inside = (u >= 0) & (u < w - 1) & (v >= 0) & (v < h - 1)
    return out * inside[..., None]

# ── the light beyond the disc ────────────────────────────────────────────
def corona(P, seed=0.0, turn=0.0):
    """the K-corona: Baumbach's fall-off, streamers in two scales (angle × log r)"""
    r = np.maximum(Rr, 1.0); lr = np.log(r)
    a = ANG + turn
    n1 = vnoise(np.stack([np.cos(a) * 4.0, np.sin(a) * 4.0, lr * 1.4 + seed], -1))
    n2 = vnoise(np.stack([np.cos(a) * 11.0, np.sin(a) * 11.0, lr * 2.6 + 3.0 + seed], -1))
    stream = 0.62 + 0.55 * n1 * n1 + 0.22 * n2 * n2 * n2
    # Baumbach's two terms (1937), the outer one lifted as eclipse photographs are stretched, so the streamers read
    fall = 0.45 * r ** -2.5 + 0.35 * r ** -7.0
    c0, c1, c2 = (lin(h) for h in P["corona"])
    col = mix(mix(c0, c1, smoothstep(0.0, 1.6, lr)), c2, smoothstep(1.8, 3.6, lr))
    I = stream * fall * 0.9 * smoothstep(0.98, 1.05, Rr) * smoothstep(4.4, 2.6, Rr)
    return col * I[..., None]

def bloom_of(hdr):
    """the lens's glow: the disc's light blurred at two widths (as the app's feGaussianBlur did)"""
    b1 = np.stack([gaussian_filter(hdr[..., k], 0.22 * RP * SS) for k in range(3)], -1)
    b2 = np.stack([gaussian_filter(hdr[..., k], 0.85 * RP * SS) for k in range(3)], -1)
    return (b1 * 0.09 + b2 * 0.07) * smoothstep(4.4, 2.6, Rr)[..., None]

def film(rgb):
    return 1 - np.exp(-rgb * 1.6)

def write(name, rgb, a=None, light=False):
    """dark packs: light is carried as alpha (planets.py). light packs: a plain RGBA over paper."""
    if not light:
        rgb = film(rgb)
        lum = rgb.max(-1)
        a_out = np.maximum(a if a is not None else 0, np.clip(lum, 0, 1))
        rgb = rgb / np.maximum(a_out[..., None], 1e-4)
    else:
        a_out = a
    out = np.concatenate([lin_to_srgb(np.clip(rgb, 0, 1)), np.clip(a_out, 0, 1)[..., None]], -1)
    img = Image.fromarray((np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8), "RGBA").resize((S, S), Image.LANCZOS)
    path = OUT / f"{name}.webp"
    img.save(path, "WEBP", quality=86, method=6)
    print(f"wrote {path.relative_to(ROOT)}  {path.stat().st_size} B")

def tint(P, I, key=None):
    """the disc's colour by its brightness: limb → mid → core"""
    limb, mid, core = (lin(h) for h in (P[key] if key else (P["limb"], P["mid"], P["core"])))
    return mix(mix(limb, mid, smoothstep(0.15, 0.85, I)), core, smoothstep(0.7, 1.15, I))

def rim(P, width=0.03, k=1.0):
    """the chromosphere: a thin ring of its own colour just beyond the limb"""
    return lin(P["rim"]) * (np.exp(-((Rr - 1.0) / width) ** 2) * k * (1 - COVER))[..., None]

# ═════════════════════════════════════════════════════════════════════════
def photosphere(pack, P):
    hmi = load_disc("20240510_121038_1024_HMII.jpg", 511.0, 511.0, 463.0)[..., 0]
    centre = np.median(hmi[Rr < 0.15])
    I = np.clip(hmi / centre, 0, 1.3)                          # the Sun's own limb darkening and spots
    I = np.where(HIT, I, 0)
    # a touch more contrast in the spots and faculae than the jpeg kept
    I = I ** 2.2
    if P["light"]:
        # the sunrise sun: air-reddened, no corona, a warm haze on the paper. The disc keeps a low ember
        # at its heart (design/v19/home.html:150) so the mark holds against the pale ground.
        col = tint(P, I * 0.92)
        a = COVER
        rimk = np.exp(-((Rr - 1.0) / 0.035) ** 2) * (1 - COVER) * 0.9
        haze = lin(P["haze"])
        h = np.maximum(Rr - 1.0, 0)
        ha = (0.62 * np.exp(-h / 0.32) + 0.30 * np.exp(-h / 1.4)) * (1 - COVER) * smoothstep(4.4, 2.8, Rr)
        rgb = col * a[..., None] + lin(P["rim"]) * rimk[..., None] + haze * ((1 - rimk) * ha)[..., None]
        a_all = np.clip(a + rimk + (1 - rimk) * ha, 0, 1)
        rgb = rgb / np.maximum(a_all[..., None], 1e-4)
        write(f"photosphere-{pack}", rgb, a_all, light=True)
        write(f"photosphere-{pack}-corona", np.zeros_like(rgb), np.zeros_like(a_all), light=True)
        return
    disc = tint(P, I) * (I * P["expo"])[..., None] * COVER[..., None]
    disc_rgb = disc + rim(P, 0.02, 0.9)
    write(f"photosphere-{pack}", disc_rgb, COVER)
    cor = corona(P, seed=1.7) * 1.1 + bloom_of(disc)
    cor = cor * (1 - COVER)[..., None]                          # the page lays this under the disc
    write(f"photosphere-{pack}-corona", cor, np.zeros_like(COVER))

def chromosphere(pack, P):
    frames = ["20240510_120854_1024_0304.jpg", "20240510_130730_1024_0304.jpg", "20240510_140930_1024_0304.jpg"]
    aia171 = load_disc("20240510_120710_1024_0171.jpg", 512.0, 512.0, 453.0)
    loops = aia171 @ np.array([0.3, 0.5, 0.2], np.float32)
    loops = np.clip((loops - 0.05) / 0.9, 0, 1) ** 1.6 * (1 - COVER) * smoothstep(1.3, 1.02, Rr)
    for k, f in enumerate(frames):
        im = load_disc(f, 512.0, 512.0, 402.0)
        lum = im @ np.array([0.55, 0.35, 0.10], np.float32)     # the 304 false colour, read as brightness
        I = np.clip(lum / 0.72, 0, 1.4) ** 1.1
        I_disc = I * COVER
        I_prom = I * (1 - COVER) * smoothstep(1.4, 1.03, Rr)     # the prominences, beyond the limb
        if P["light"]:
            col = tint(P, np.clip(I_disc * 0.9, 0, 1), "chromo")
            pa = np.clip(I_prom * 2.4, 0, 1)
            haze = lin(P["haze"]); h = np.maximum(Rr - 1.0, 0)
            ha = (0.5 * np.exp(-h / 0.3) + 0.28 * np.exp(-h / 1.3)) * (1 - COVER) * smoothstep(4.4, 2.8, Rr)
            pcol = mix(lin(P["mid"]), lin(P["core"]), np.clip(I_prom, 0, 1))
            rgb = col * COVER[..., None] + pcol * pa[..., None] + haze * ((1 - pa) * ha)[..., None]
            a_all = np.clip(COVER + pa + (1 - pa) * ha, 0, 1)
            rgb = rgb / np.maximum(a_all[..., None], 1e-4)
            write(f"chromosphere-{pack}-{k}", rgb, a_all, light=True)
            continue
        disc = tint(P, I_disc * 1.05, "chromo") * (I_disc * P["expo"])[..., None]
        prom = mix(lin(P["chromo"][0]), lin(P["chromo"][2]), np.clip(I_prom * 1.2, 0, 1)) * (I_prom * P["expo"] * 3.2)[..., None]
        lp = mix(lin(P["corona"][1]), lin(P["corona"][0]), loops) * (loops * 1.1)[..., None]
        hdr = disc + prom + lp * 0.6 + corona(P, seed=4.2 + k * 0.15) * 0.7 + bloom_of(disc)
        write(f"chromosphere-{pack}-{k}", hdr, COVER)

def furnace(pack, P, t=0.0):
    """the model the shader draws live (the page's furnace.html carries the same formulas in GLSL)"""
    mu = MU
    # Pierce & Slaughter's limb darkening at 5500 Å
    ld = 1.0 - 0.66 * (1 - mu) - 0.10 * (1 - mu * mu)
    # granulation: cells parted by dark lanes, foreshortened to the limb, in two octaves
    q = np.stack([X, Y], -1) / 0.11
    dirv = np.stack([X, Y], -1) / np.maximum(Rr, 1e-3)[..., None]
    q = q + dirv * (np.sum(dirv * q, -1) * (1.0 / np.maximum(mu, 0.25) - 1.0) * 0.5)[..., None]
    q3 = lambda s, o, ts: np.concatenate([q * s + o, np.full(q.shape[:-1] + (1,), ts, np.float32)], -1)
    g1 = 1 - np.abs(vnoise(q3(1.0, 0.0, t * 0.5)) * 2 - 1); g2 = 1 - np.abs(vnoise(q3(2.7, 7.0, t * 0.9)) * 2 - 1)
    gran = smoothstep(0.25, 0.95, g1 * 0.7 + g2 * 0.3)
    # spots: a leading and a following spot with penumbrae, and a small one; faculae bright towards the limb
    spots = [(-0.42, 0.28, 0.11), (-0.22, 0.33, 0.07), (0.38, -0.47, 0.045)]
    dark = np.ones_like(Rr)
    for sx, sy, sr in spots:
        d = np.sqrt((X - sx) ** 2 + ((Y - sy) / max(mu.mean(), 0.3)) ** 2) if False else np.sqrt((X - sx) ** 2 + (Y - sy) ** 2)
        um = smoothstep(sr * 0.45, sr * 0.6, d); pen = smoothstep(sr * 0.9, sr * 1.25, d)
        dark *= 0.12 + 0.88 * um; dark *= 0.72 + 0.28 * pen
    fac = smoothstep(0.55, 0.9, vnoise(np.concatenate([q * 0.35 + 11.0, np.full(q.shape[:-1] + (1,), 2.0, np.float32)], -1))) * (1 - mu) ** 1.5 * 0.5
    I = ld * (0.8 + 0.32 * gran) * dark * (1 + fac)
    I = I * HIT
    if P["light"]:
        col = tint(P, I * 0.95)
        rimk = np.exp(-((Rr - 1.0) / 0.035) ** 2) * (1 - COVER) * 0.9
        haze = lin(P["haze"]); h = np.maximum(Rr - 1.0, 0)
        ha = (0.62 * np.exp(-h / 0.32) + 0.30 * np.exp(-h / 1.4)) * (1 - COVER) * smoothstep(4.4, 2.8, Rr)
        rgb = col * COVER[..., None] + lin(P["rim"]) * rimk[..., None] + haze * ((1 - rimk) * ha)[..., None]
        a_all = np.clip(COVER + rimk + (1 - rimk) * ha, 0, 1)
        rgb = rgb / np.maximum(a_all[..., None], 1e-4)
        write(f"furnace-{pack}", rgb, a_all, light=True)
        return
    disc = tint(P, I) * (I * P["expo"])[..., None] * COVER[..., None]
    hdr = disc + rim(P, 0.02, 0.9) + corona(P, seed=t * 0.1, turn=t * 0.02) + bloom_of(disc)
    write(f"furnace-{pack}", hdr, COVER)

if __name__ == "__main__":
    for pack, P in PACKS.items():
        photosphere(pack, P)
        chromosphere(pack, P)
        furnace(pack, P)
