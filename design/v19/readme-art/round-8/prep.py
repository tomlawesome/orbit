#!/usr/bin/env python3
"""
Round 8 of #1177 — Q's source: the ratified after-dark home screen.

The capture is design/v19/afterdark-plane.html (the after-dark home mockup,
§15 "after dark adopts the happy accident") taken with Playwright's Chromium
at a 1760×1000 viewport, device scale 2, after its sky has settled
(ROOM=/path/to/capture.png). The fixture app needs a server and seeded data
to show the same screen; the mockup is the ratified one, so it is the source.

The crop takes the centre of the 3520×2000 capture (3181×1670, scaled up
0.6% to 3200×1680), which leaves out the demo chrome: the DEMOS bar along the bottom, the account avatar top
right, the "degraded" tab on the left edge and the "key" tab on the right.
Then the whole screen is dimmed to 68% (the sun stays the brightest point),
so the mark and word lead. Nothing else is touched.
"""
import os
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOM = os.environ.get("ROOM", "/tmp/v19shots/afterdark-home-2x.png")
im = Image.open(ROOM).convert("RGB")
assert im.size == (3520, 2000), im.size
# the band between the avatar (top right) and the search field (bottom) is
# a few pixels shorter than 1680, so the window is 3181×1670 at the same
# aspect, scaled up by 0.6%
crop = im.crop((150, 126, 3331, 1796)).resize((3200, 1680), Image.LANCZOS)
a = np.asarray(crop, np.float32) / 255
bg = np.array([0x05, 0x07, 0x0d], np.float32) / 255
a = bg + (a - bg) * 0.68
out = Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB")
out.save(os.path.join(HERE, "q-room.jpg"), quality=86)
print("q-room.jpg", out.size)
