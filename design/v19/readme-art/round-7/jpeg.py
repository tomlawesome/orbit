#!/usr/bin/env python3
"""Round 7 of #1177 — the banner as JPEG: 1600×840 under 600 KB and the 2×
under 1.5 MB (no PNG of a photograph). Converts render.cjs's screenshots,
stepping the quality down until each fits, and removes the PNGs."""
import os
from PIL import Image
HERE = os.path.dirname(os.path.abspath(__file__))
for png, jpg, limit in (("n-banner.png", "n-banner.jpg", 600 * 1024), ("n-banner@2x.png", "n-banner@2x.jpg", 1500 * 1024)):
    im = Image.open(os.path.join(HERE, png)).convert("RGB")
    for q in range(90, 50, -3):
        im.save(os.path.join(HERE, jpg), quality=q, optimize=True, subsampling=1)
        if os.path.getsize(os.path.join(HERE, jpg)) <= limit:
            break
    os.remove(os.path.join(HERE, png))
    print(jpg, "q", q, os.path.getsize(os.path.join(HERE, jpg)) // 1024, "KB")
