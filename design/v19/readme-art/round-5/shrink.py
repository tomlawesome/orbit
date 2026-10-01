#!/usr/bin/env python3
"""Round 5 of #1177 — bring l-banner.png under 1.5 MB after render.cjs.

The host has no pngquant; Pillow's optimiser alone leaves the 1600×840
star field at ~1.7 MB, so the PNG is quantised to a 256-colour palette with
Floyd–Steinberg dithering (~0.8 MB). Run after render.cjs, then retake the
index screenshots so they show the file the README would serve.
"""
import os
from PIL import Image
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "l-banner.png")
im = Image.open(p).convert("RGB")
im.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG).save(p, optimize=True)
print("l-banner.png", os.path.getsize(p) // 1024, "KB")
