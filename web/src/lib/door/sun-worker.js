/*
 * The door's sun, painted and encoded here so the page's thread is held by neither (#119; glows.js: paintSun asks for it
 * through the host's `sunWorker`). One picture per worker: it is told { w, h } and answers { blob } (the PNG), or
 * { error } and why it could not. The pixels are sun.js's, the very routine the page paints with. Imports nothing but
 * that module: no page, no settings, nothing fetched.
 */
import { sunBand, sunDiscs, sunRows } from "./sun.js";

/** @param {number} w @param {number} h @returns {Promise<Blob>} */
async function paint(w, h) {
  const canvas = new OffscreenCanvas(w, h), ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext("2d"));
  const discs = sunDiscs(), s = w / 1600, rows = sunRows(w);
  for (let y0 = 0; y0 < h; y0 += rows) {
    const n = Math.min(rows, h - y0), im = ctx.createImageData(w, n);
    sunBand(discs, s, w, y0, n, im.data);
    ctx.putImageData(im, 0, y0);
  }
  return canvas.convertToBlob({ type: "image/png" });
}

self.onmessage = async (/** @type {MessageEvent<{ w: number, h: number }>} */ e) => {
  try { self.postMessage({ blob: await paint(e.data.w, e.data.h) }); }
  catch (err) { self.postMessage({ error: String(err) }); }
};
