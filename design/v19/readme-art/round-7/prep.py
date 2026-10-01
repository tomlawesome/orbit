#!/usr/bin/env python3
"""
Round 7 of #1177 — the plane from a photograph.

Owner, 2026-10-01: "Photo 2 seems the best... and I quite like this version
you did earlier" (round 4's K composition). So the sky is ESO's "Majestic
Milky Way" over La Silla (ESO/F. Char, CC BY 4.0 — see CREDITS.md), cropped
and lightly graded; nothing is drawn on it.

The crop: the photograph's band rises left to right with the bulge top
centre-right. K's river falls left to right at about 19° with the core on
the right, so the photograph is ROTATED 37.4° clockwise (astrophotographs
have no up; a mirror would have changed the sky's handedness) and a
3200×1680 window taken at 1:1 photo pixels, placed so the bulge sits where
K's core did — about 72% along the banner, right of the tagline — and the
band runs behind the word.

The grade, hard, into After Dark (owner 37a, 2026-10-01: "keep the
photograph, grade it into Orbit's palette"): luminance mapped through a
duotone of the pack's own inks (--bg → --line → --ink-faint → --ink-mid →
--ink), the field darkened (gamma 1.45, ×0.9, soft knee) so the mark and
word lead, the bulge calmed by a soft mask and tinted toward --plane-cool so
its glow is cool, and a tenth of the photograph's own chroma kept so the
dust lanes are not a pure duotone. Stars and dust stay the photograph's.

Outputs: n-sky.jpg (the 2× crop, embedded by build.py), n-sky-tile.jpg (a
600px square from it for the logo tile), and the crop record printed for
CREDITS.md.
"""
import os, math
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.environ.get("MILKYWAY", "/tmp/milkyway/2-majestic.jpg")
W, H = 3200, 1680

src = Image.open(SRC).convert("RGB")
SW, SH = src.size                                           # 5000 × 3333
# the band in the photograph: from the lower left (0, 2167) to the upper right (5000, 500)
band_angle = math.degrees(math.atan2(500 - 2167, 5000 - 0))  # ≈ −18.4° (y down)
target_angle = math.degrees(math.atan2(760 - 140, 1700 + 100))   # K's river ≈ +19.0°
rot = target_angle - band_angle                             # ≈ +37.4°, clockwise on screen
th = math.radians(rot)

def plan(k):
    """Scale the photograph by k, rotate, and place the window so the bulge
    sits at K's core (2300, 1160 at 2×). Returns the box and whether every
    corner maps back inside the photograph (no black corners)."""
    sw, sh = SW * k, SH * k
    cx, cy = sw / 2, sh / 2
    bx, by = 3000 * k - cx, 1167 * k - cy
    rx, ry = cx + bx * math.cos(th) - by * math.sin(th), cy + bx * math.sin(th) + by * math.cos(th)
    ox, oy = int(round(rx - 2300)), int(round(ry - 1160))
    box = (ox, oy, ox + W, oy + H)
    def back(x, y):
        dx, dy = x - cx, y - cy
        return cx + dx * math.cos(-th) - dy * math.sin(-th), cy + dx * math.sin(-th) + dy * math.cos(-th)
    ok = all(0 <= px < sw and 0 <= py < sh for px, py in
             (back(x, y) for x, y in ((box[0], box[1]), (box[2], box[1]), (box[0], box[3]), (box[2], box[3]))))
    return box, ok, (rx, ry)

k = 1.0
while True:
    box, ok, (rx, ry) = plan(k)
    if ok: break
    k = round(k + 0.05, 2)
    assert k < 2.0, "no window fits"
im = src.resize((round(SW * k), round(SH * k)), Image.LANCZOS) if k != 1.0 else src
sw, sh = im.size
rotated = im.rotate(-rot, resample=Image.BICUBIC, expand=False, fillcolor=(5, 7, 13))
crop = rotated.crop(box)
a = np.asarray(crop, np.float32) / 255
# ---------------------------------------------------------------- the grade: into After Dark
# tokens, packs.css [data-theme=afterdark]
BG = np.array([0x05, 0x07, 0x0d], np.float32) / 255        # --bg
LINE = np.array([0x1c, 0x24, 0x34], np.float32) / 255      # --line
FAINT = np.array([0x71, 0x7c, 0x8e], np.float32) / 255     # --ink-faint
MID = np.array([0x9f, 0xa6, 0xb2], np.float32) / 255       # --ink-mid
INK = np.array([0xe7, 0xe9, 0xee], np.float32) / 255       # --ink
COOL = np.array([0x9f, 0xb0, 0xd6], np.float32) / 255      # --plane-cool
lum0 = 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]
lum = lum0.copy()
# calm the bulge: a soft mask about the core (at 2×: 2300, 1160), the brightest area
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
calm = np.exp(-(((xx - 2300) / 620) ** 2 + ((yy - 1160) / 380) ** 2))
lum = lum * (1.0 - 0.45 * calm)
# darken the field so the mark and word lead; keep the bright points (stars)
lum = np.clip(lum, 0, 1) ** 1.45 * 0.9
lum = lum / (1.0 + 0.35 * lum)                              # soft knee on highlights
# duotone through the pack's inks: --bg → --line → --ink-faint → --ink-mid → --ink
stops = np.array([0.0, 0.22, 0.5, 0.78, 1.0], np.float32)
cols = np.stack([BG, LINE, FAINT, MID, INK])
tone = np.stack([np.interp(lum, stops, cols[:, i]) for i in range(3)], -1).astype(np.float32)
# the core's glow is cool, not warm: lift toward --plane-cool where the mask is
tone = tone + (calm * 0.10)[..., None] * (COOL - tone)
# a little of the photograph's own hue survives, desaturated hard, so the dust is not pure duotone
chroma = a - lum0[..., None]
a = np.clip(tone + 0.10 * chroma, 0, 1)
out = Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB")
out.save(os.path.join(HERE, "n-sky.jpg"), quality=84, subsampling=0)
# the tile crop: a square on the rich part of the band, left of the bulge
tx, ty = 1500, 760
out.crop((tx - 300, ty - 300, tx + 300, ty + 300)).save(os.path.join(HERE, "n-sky-tile.jpg"), quality=86)
print(f"photo scaled x{k}; rotation {rot:.1f} deg clockwise; crop box {box} of the rotated {sw}x{sh}; bulge at ({rx:.0f},{ry:.0f})")
