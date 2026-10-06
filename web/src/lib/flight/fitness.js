/*
 * WHETHER THIS MACHINE CAN DRAW IT (#1253): one whole frame, timed with the
 * GPU made to finish it, against a budget that leaves room for about 30
 * frames a second. A GPU that cannot (software rendering, a remote desktop)
 * would make every frame a long stall, so whatever fails this is drawn
 * without WebGL instead. The flight's world (voyage.js) and the dial's sun
 * (lib/sun/furnace.js) both ask it, so there is one rule, not two.
 */

/** the most one frame may take, in milliseconds */
export const FIT_MS = 30;

/**
 * @param {WebGLRenderingContext | WebGL2RenderingContext} gl
 * @param {() => void} draw  draws the heaviest frame the caller will ask for
 * @returns {boolean}
 */
export function fitsFrame(gl, draw) {
  let ms = Infinity;
  try {
    const t0 = performance.now();
    draw(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    ms = performance.now() - t0;
  } catch { /* unfit */ }
  return ms <= FIT_MS;
}
