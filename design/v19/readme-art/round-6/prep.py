#!/usr/bin/env python3
"""
Round 6 of #1177 — the plane from a photograph.

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

The grade, light: channels pulled toward After Dark's cool black-blue (R
×0.80, G ×0.88, B ×1.00), blacks lifted to the pack's --bg #05070d, a touch
of contrast. The photograph stays unmistakably a photograph.

Outputs: m-sky.jpg (the 2× crop, embedded by build.py), m-sky-tile.jpg (a
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
# the grade
a *= np.array([0.80, 0.88, 1.00], np.float32)               # cooler, a little darker
a = np.clip((a - 0.5) * 1.12 + 0.5, 0, 1)                   # a touch of contrast
bg = np.array([0x05, 0x07, 0x0d], np.float32) / 255
a = bg + (1 - bg) * a                                       # blacks sit on the pack's ground
out = Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB")
out.save(os.path.join(HERE, "m-sky.jpg"), quality=84, subsampling=0)
# the tile crop: a square on the rich part of the band, left of the bulge
tx, ty = 1500, 760
out.crop((tx - 300, ty - 300, tx + 300, ty + 300)).save(os.path.join(HERE, "m-sky-tile.jpg"), quality=86)
print(f"photo scaled x{k}; rotation {rot:.1f} deg clockwise; crop box {box} of the rotated {sw}x{sh}; bulge at ({rx:.0f},{ry:.0f})")
