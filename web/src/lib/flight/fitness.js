/*
 * WHETHER THIS MACHINE CAN DRAW IT (#1253): whole frames, timed with the
 * GPU made to finish each, against a budget that leaves room for about 30
 * frames a second. A GPU that cannot (software rendering, a remote desktop)
 * would make every frame a long stall, so whatever fails this is drawn
 * without WebGL instead. The flight's world (voyage.js) asks it.
 *
 * WARM FIRST, THEN THE MEDIAN. The first frames at a new size carry the
 * driver's last shader work, the pictures' upload and the render targets'
 * allocation; on Firefox (ANGLE, no parallel compile) that alone is past
 * the budget on a real GPU, which then flew the canvas flight. So a couple
 * of frames are drawn untimed first, and then a few are timed one by one
 * and judged on their median: one hitch is not a slow machine. It stops as
 * soon as most of the timed frames have agreed.
 */

/** the most one frame may take, in milliseconds */
export const FIT_MS = 30;
/** frames drawn (and finished) before any is timed */
export const WARM_FRAMES = 2;
/** frames timed; the verdict is their median */
export const TIMED_FRAMES = 5;

/**
 * @param {Pick<WebGLRenderingContext, "readPixels" | "RGBA" | "UNSIGNED_BYTE">} gl
 * @param {() => void} draw  draws the heaviest frame the caller will ask for
 * @param {{ now?: () => number, warm?: number, timed?: number }} [how]
 * @returns {{ fit: boolean, ms: number }}  ms: the median timed frame
 */
export function frameCost(gl, draw, { now = () => performance.now(), warm = WARM_FRAMES, timed = TIMED_FRAMES } = {}) {
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  try {
    for (let i = 0; i < warm; i++) { draw(); sync(); }
    /** @type {number[]} */
    const times = [];
    let over = 0;
    for (let i = 0; i < timed; i++) {
      const t0 = now();
      draw(); sync();
      const ms = now() - t0;
      times.push(ms);
      if (ms > FIT_MS) over++;
      /* the median is settled once more than half lie on one side */
      if (over > timed / 2 || times.length - over > timed / 2) break;
    }
    /* the median of the frames timed; stopped early, the lower middle one,
       which always lies on the side that decided it */
    const sorted = [...times].sort((a, b) => a - b);
    const ms = sorted[Math.floor((sorted.length - 1) / 2)] ?? Infinity;
    return { fit: ms <= FIT_MS, ms };
  } catch {
    return { fit: false, ms: Infinity };
  }
}

/** The one line that says whether the flight's world is drawn, and why. @param {string} verdict */
export function sayVerdict(verdict) {
  try { console.info(`orbit · flight world: ${verdict}`); } catch { /* fine */ }
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
/** @typedef {{ canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, parallel: boolean, renderer: string }} Gpu */
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
      const renderer = rendererOf(gl);
      if (SOFTWARE.test(renderer)) {
        gl.getExtension("WEBGL_lose_context")?.loseContext();
        sayVerdict(`off: software renderer (${renderer})`);
      }
      /* asked of this same context: whether shaders are made off the page's
         thread (KHR_parallel_shader_compile) */
      else verdict = { canvas, gl, parallel: !!gl.getExtension("KHR_parallel_shader_compile"), renderer };
    } else sayVerdict("off: no WebGL2 here, or the browser calls it a major performance caveat");
  } catch { sayVerdict("off: WebGL2 refused"); }
  return verdict;
}

/*
 * THE RENDERER'S NAME (#1299). Firefox gives the real name through plain
 * RENDERER and warns that WEBGL_debug_renderer_info is deprecated and will
 * be removed; Chromium and WebKit still answer RENDERER with the masked
 * "WebKit WebGL". So RENDERER first, and the extension only when that is
 * masked or empty.
 */
const MASKED = /^(webkit webgl|mozilla)?$/i;
/** @param {Pick<WebGL2RenderingContext, "getParameter" | "getExtension" | "RENDERER">} gl */
function rendererOf(gl) {
  const plain = String(gl.getParameter(gl.RENDERER) ?? "").trim();
  if (!MASKED.test(plain)) return plain;
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : plain;
}

/** the renderer names that are refused, for tests @param {string} renderer */
export const isSoftware = (renderer) => SOFTWARE.test(renderer);

/*
 * THE VERDICT, REMEMBERED (#1310). The timed frames above cost the climb a
 * few hundred milliseconds on a browser that makes its shaders on the page's
 * own thread (Firefox), and they come after the compile, just before the
 * world is ready. The same GPU running the same build draws the same frame
 * in the same time, so the verdict is kept in localStorage under the
 * renderer's name and the build, and a later flight on both skips the test.
 * A new build asks again, so no verdict, failing or passing, outlives the
 * build it was measured on; nor does one from a frame that failed to draw
 * at all (no time measured), which says nothing about the GPU.
 */
/** localStorage key: the last fitness verdict, with the GPU and build it was measured on */
export const FIT_KEY = "orbit-flight-fitness";

/**
 * The verdict remembered for this GPU and build, or null when there is none.
 * @param {Pick<Storage, "getItem"> | undefined} storage
 * @param {string} renderer @param {string} build
 * @returns {{ fit: boolean, ms: number } | null}
 */
export function rememberedFit(storage, renderer, build) {
  try {
    if (!storage || !renderer || !build) return null;
    const got = JSON.parse(storage.getItem(FIT_KEY) || "null");
    if (!got || got.renderer !== renderer || got.build !== build) return null;
    if (typeof got.fit !== "boolean" || !Number.isFinite(got.ms)) return null;
    return { fit: got.fit, ms: got.ms };
  } catch { return null; }
}

/**
 * Keep a measured verdict for this GPU and build (one entry: a new GPU or
 * build replaces it).
 * @param {Pick<Storage, "setItem"> | undefined} storage
 * @param {string} renderer @param {string} build @param {{ fit: boolean, ms: number }} verdict
 */
export function rememberFit(storage, renderer, build, { fit, ms }) {
  try {
    if (!storage || !renderer || !build || !Number.isFinite(ms)) return;
    storage.setItem(FIT_KEY, JSON.stringify({ renderer, build, fit, ms: Math.round(ms * 10) / 10 }));
  } catch { /* not remembered: the next flight measures again */ }
}
