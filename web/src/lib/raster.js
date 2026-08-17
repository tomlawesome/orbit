/**
 * The GPU law's shared mechanism (§15) — rasterise a STATIC SVG filter graph
 * once, off the paint path, instead of leaving it live.
 *
 * Extracted from Grain.svelte (#499) so #501's dawn/dusk glows can reuse the
 * exact same decode/draw/cache dance rather than copy it a second time.
 * Nothing about the technique changed in the extraction: hand it a complete
 * SVG document (verbatim filter graph and all) plus the exact pixel
 * dimensions the caller wants back, and it decodes that SVG as an <img>,
 * blits it 1:1 onto a canvas of precisely that size (no resampling — the
 * canvas IS the image's native size), and hands back the PNG data URL.
 * Byte-identical output depends entirely on the caller building a
 * deterministic SVG (fixed seed, fixed region, fixed everything) at the
 * exact size it will be displayed at — this module does not police that, it
 * only does the once-per-key work and remembers the answer.
 *
 * The cache is shared across every caller in the tab (Grain, Dawn, Dusk, or
 * anything added later): callers namespace their own keys so two different
 * filter graphs at the same pixel size can never collide.
 */
const cache = new Map();

export async function rasteriseSvg(key, svg, w, h) {
  const hit = cache.get(key);
  if (hit) return hit;

  const img = new Image();
  const decoded = new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
  });
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await decoded;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  /* 1:1 — the image's own intrinsic size already matches the canvas, so this
     is a straight blit with no resampling to introduce drift. */
  ctx.drawImage(img, 0, 0, w, h);

  const url = canvas.toDataURL("image/png");
  cache.set(key, url);
  return url;
}

export function clearRasterCache() {
  cache.clear();
}
