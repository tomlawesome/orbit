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

/*
 * MAY THIS PAGE USE THE GPU AT ALL (#1253): decided once a page, before any
 * other WebGL work, from ONE context. It is refused where the browser
 * itself says WebGL2 would be a major performance caveat, and where the
 * renderer is software (llvmpipe, softpipe, SwiftShader, Microsoft Basic
 * Render): such a machine draws without WebGL, and nothing else on the page
 * touches the GPU. Accepted, the context is kept and handed to the flight's
 * world (voyage.js), so the page never makes a second one for it. The
 * timed frame above is a different question, asked only when a flight
 * starts.
 */
const SOFTWARE = /llvmpipe|softpipe|swiftshader|microsoft basic render/i;
/** @typedef {{ canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, parallel: boolean }} Gpu */
/** @type {Gpu | null | undefined} */
let verdict;

/** the page's verdict, decided on first asking @returns {Gpu | null} */
export function gpu() {
  if (verdict !== undefined) return verdict;
  if (typeof document === "undefined") return null;
  verdict = null;
  try {
    const canvas = document.createElement("canvas");
    const gl = /** @type {WebGL2RenderingContext | null} */ (canvas.getContext("webgl2", {
      antialias: false, alpha: false, depth: false, powerPreference: "high-performance",
      failIfMajorPerformanceCaveat: true,
    }));
    if (gl) {
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
      if (SOFTWARE.test(renderer)) gl.getExtension("WEBGL_lose_context")?.loseContext();
      /* asked of this same context: whether shaders are made off the page's
         thread (KHR_parallel_shader_compile) */
      else verdict = { canvas, gl, parallel: !!gl.getExtension("KHR_parallel_shader_compile") };
    }
  } catch { /* refused */ }
  return verdict;
}

/** the renderer names that are refused, for tests @param {string} renderer */
export const isSoftware = (renderer) => SOFTWARE.test(renderer);
