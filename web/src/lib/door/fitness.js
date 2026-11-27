/*
 * WHETHER THIS PAGE MAY USE THE GPU, AND WHETHER THIS MACHINE CAN DRAW THE FLIGHT'S WORLD (ADR-0002, #2; Orbit's
 * #1253). Ported from Orbit's web/src/lib/flight/fitness.js. The fitness test runs every visit, so a driver fix, a new
 * GPU or a busy moment is judged as it is now; its verdict is also kept on the device for a week (ADR-0002 6.4, owner
 * 19a, #116), so a later visit's ways in can open on a remembered pass while the test is taken again quietly.
 *
 * Two questions, asked at different times:
 *  - gpu(): once a page, before any other WebGL, from ONE context. Refused where the browser itself calls WebGL2 a
 *    major performance caveat, and where the renderer is software (llvmpipe, softpipe, SwiftShader, Microsoft Basic
 *    Render): such a machine draws without WebGL and nothing else on the page touches the GPU. Accepted, the context
 *    is kept and handed to the flight's world (voyage.js) and the probe (capability.js), so the page never makes a
 *    second one for them.
 *  - frameCost(): whole frames, timed with the GPU made to finish each, against a budget that leaves room for about
 *    30 frames a second. The back-to-back judgement the tests import; the flight world's own verdict is voyage.js
 *    quietFitness, the same frames and budget timed one at a time while the GPU is quiet (busy.js, #104), asked only when
 *    a flight proves its world, never on the door.
 *
 * WARM FIRST, THEN THE MEDIAN. The first frames at a new size carry the driver's last shader work, the pictures'
 * upload and the render targets' allocation; on Firefox (ANGLE, no parallel compile) that alone is past the budget on
 * a real GPU. So a couple of frames are drawn untimed first, and then a few are timed one by one and judged on their
 * median: one hitch is not a slow machine. It stops as soon as most of the timed frames have agreed.
 */
import { flag, settings } from "./settings.js";
import { page } from "./page.js";
import { watch } from "./busy.js";

/** a week, in milliseconds: how long a remembered verdict (rememberedFit) and the probe's (capability.js) are kept */
export const WEEK = 7 * 24 * 3600e3;
const DAY = 24 * 3600e3;

/** the most one frame may take, in milliseconds */
export const FIT_MS = 30;
/** frames drawn (and finished) before any is timed */
export const WARM_FRAMES = 2;
/** frames timed; the verdict is their median */
export const TIMED_FRAMES = 5;

/**
 * @param {{ readPixels(x: number, y: number, w: number, h: number, format: number, type: number, pixels: ArrayBufferView): void, RGBA: number, UNSIGNED_BYTE: number }} gl any WebGL context
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
    /* the median of the frames timed; stopped early, the lower middle one, which always lies on the side that decided it */
    const sorted = [...times].sort((a, b) => a - b);
    const ms = sorted[Math.floor((sorted.length - 1) / 2)] ?? Infinity;
    return { fit: ms <= FIT_MS, ms };
  } catch {
    return { fit: false, ms: Infinity };
  }
}

/** The one line that says whether the flight's world is drawn, and why. @param {string} verdict */
export function sayVerdict(verdict) {
  try { page.verdict(`orbit · flight world: ${verdict}`); } catch { /* fine */ }
}

const SOFTWARE = /llvmpipe|softpipe|swiftshader|microsoft basic render/i;
/** @typedef {{ canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, parallel: boolean, renderer: string }} Gpu */
/** @type {Gpu | null | undefined} */
let verdict;

/*
 * THE RENDERER'S NAME (Orbit's #1299). Firefox gives the real name through plain RENDERER and warns that
 * WEBGL_debug_renderer_info is deprecated and will be removed; Chromium and WebKit still answer RENDERER with the
 * masked "WebKit WebGL". So RENDERER first, and the extension only when that is masked or empty.
 */
const MASKED = /^(webkit webgl|mozilla)?$/i;
/** @param {WebGL2RenderingContext} gl */
function rendererOf(gl) {
  const plain = String(gl.getParameter(gl.RENDERER) ?? "").trim();
  if (!MASKED.test(plain)) return plain;
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : plain;
}

/**
 * The page's verdict, decided synchronously on first asking: the one WebGL2 context, or null. The host's flag
 * `gpu: "force"` takes the context without the performance-caveat check and skips the name check (the site's own live
 * check needs it on software GL); a debug switch, never granted by `level`.
 * @returns {Gpu | null}
 */
export function gpu() {
  if (verdict !== undefined) return verdict;
  const gate = page.gate();
  if (!gate) return null;
  verdict = null;
  /* (a gate that is not checked: the worker's canvas, the page's gate having judged already) */
  const force = flag("gpu") === "force" || !gate.check;
  try {
    const { canvas } = gate;
    const gl = /** @type {WebGL2RenderingContext | null} */ (canvas.getContext("webgl2", {
      antialias: false, alpha: false, depth: false, powerPreference: "high-performance",
      ...(force ? {} : { failIfMajorPerformanceCaveat: true }),
    }));
    if (gl) {
      const renderer = rendererOf(gl);
      if (!force && SOFTWARE.test(renderer)) {
        gl.getExtension("WEBGL_lose_context")?.loseContext();
        sayVerdict(`off: software renderer (${renderer})`);
      }
      /* asked of this same context: whether shaders are made off the page's thread (KHR_parallel_shader_compile) */
      else {
        /* (its compiles and uploads counted, for the flight world's verdict: busy.js) */
        watch(gl);
        const got = { canvas, gl, parallel: !!gl.getExtension("KHR_parallel_shader_compile"), renderer };
        /* A lost context can come back (Khronos, HandlingContextLost): cancelling the event is what lets the browser
           restore it. While it is lost the page stays 2D (voyage.js makes no world on a lost context); once restored
           the same canvas and gl serve the next world, built from scratch by whoever asks, with no second test and no
           second context. Extensions are asked for again, as the restored context starts without them. */
        canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); });
        canvas.addEventListener("webglcontextrestored", () => { try { got.parallel = !!gl.getExtension("KHR_parallel_shader_compile"); } catch { /* fine */ } });
        verdict = got;
      }
    } else sayVerdict("off: no WebGL2 here, or the browser calls it a major performance caveat");
  } catch { sayVerdict("off: WebGL2 refused"); }
  return verdict;
}

/** the renderer names that are refused, for tests @param {string} renderer */
export const isSoftware = (renderer) => SOFTWARE.test(renderer);

/*
 * THE VERDICT REMEMBERED (ADR-0002 6.4, #116): a cached capability verdict with a time to live, revalidated each visit.
 * One key, `<storagePrefix>-fit <renderer> <width>x<height>@<pixel ratio>` (the renderer names the GPU and its driver,
 * and the test's cost scales with the screen), value { t, fit, ms }, valid for a week (WEEK, the probe's rule: never
 * from the future). Read once a page, on the page (never in a worker: the page's engine or remote-flight.js asks it at
 * the first warm), and written at every judgement that measured, a pass or an unfit, with the fresh figures. Neither
 * read nor written under `fit: "skip"` (its pass measures nothing) or save-data (no world there, 6.9); `gpu: "force"`
 * changes nothing here. A remembered pass lets the ways in open before the test; a remembered unfit opens nothing
 * (engine.js: verdict), and is only said.
 */
const saving = () => !!(/** @type {Navigator & { connection?: { saveData?: boolean } }} */ (globalThis.navigator ?? {})).connection?.saveData;
/** the key the verdict is kept under, or null where the GPU was refused (nothing to remember) @returns {string | null} */
export function fitKey() {
  const g = gpu();
  if (!g) return null;
  return `${settings.storagePrefix}-fit ${g.renderer} ${screen.width}x${screen.height}@${globalThis.devicePixelRatio || 1}`;
}
/** @type {{ t: number, fit: boolean, ms: number } | null | undefined} */
let kept;
/**
 * The verdict this device was given within the week, or null: read once a page (the console says what was found, once).
 * @returns {{ t: number, fit: boolean, ms: number } | null}
 */
export function rememberedFit() {
  if (flag("fit") === "skip" || saving()) return null;
  if (kept !== undefined) return kept;
  kept = null;
  try {
    const key = fitKey();
    if (!key) return kept;
    const v = JSON.parse(localStorage.getItem(key) || "null");
    const now = Date.now();
    if (v && typeof v.t === "number" && typeof v.fit === "boolean" && typeof v.ms === "number" && v.t <= now && now - v.t < WEEK) {
      kept = { t: v.t, fit: v.fit, ms: v.ms };
      sayVerdict(v.fit ? `remembered on (frame ${Math.round(v.ms)} ms, ${Math.floor((now - v.t) / DAY)} d ago)` : `remembered off (frame ${Math.round(v.ms)} ms), tested again`);
    }
  } catch { /* nothing remembered: this visit's test decides */ }
  return kept;
}
/**
 * A judgement kept for the next visits: only one that measured (not skipped, not a failure or a refusal, a frame's
 * time to tell), never under `fit: "skip"` or save-data.
 * @param {{ fit: boolean, ms: number, skipped?: boolean, how?: string }} v
 */
export function rememberFit({ fit, ms, skipped = false, how = "tested" }) {
  if (skipped || how !== "tested" || !Number.isFinite(ms) || flag("fit") === "skip" || saving()) return;
  try {
    const key = fitKey();
    if (key) localStorage.setItem(key, JSON.stringify({ t: Date.now(), fit, ms }));
  } catch { /* this visit only */ }
}

/*
 * WHERE THE FLIGHT IS DRAWN (ADR-0004 6a.4): in a worker (draw-worker.js, through remote-flight.js) or on the page.
 * Decided once a page, at the journey's first need (after the gate has run), and said once when the host gave a
 * worker: `flight: drawn in a worker` / `flight: drawn on the page: <why>`. `draw: "page"` keeps the page;
 * `draw: "worker"` takes the worker wherever the host gave drawWorker and fonts, whatever the rest says. Otherwise all
 * of: the gate accepted the page and compiles on its thread (parallel false: the measured Firefox tell); no
 * navigator.userAgentData (Chromium on a software renderer reports no parallel compile too, and Chromium keeps the page
 * by decision); the gate not forced (gpu: "force" is the live tests' bed: they keep the page path); a Worker, an
 * OffscreenCanvas and a canvas that can be handed over; not under save-data.
 */
/** @type {boolean | undefined} */
let drawn;
/** @returns {string | null} why the page draws it, or null for the worker */
function drawnWhy() {
  if (!settings.fonts?.length) return "the host gave the worker no fonts to write with";
  const asked = flag("draw");
  if (asked === "page") return "asked for (draw=page)";
  if (asked === "worker") return null;
  const nav = /** @type {Navigator & { connection?: { saveData?: boolean } }} */ (globalThis.navigator ?? {});
  /* (before the gate: under save-data the GPU is not asked at all, ADR-0002 6.9) */
  if (nav.connection?.saveData) return "save-data is on";
  const g = gpu();
  if (!g) return "the GPU gate refused this page";
  if (g.parallel) return "this browser compiles shaders in the background (parallel)";
  if ("userAgentData" in nav) return "a Chromium browser (navigator.userAgentData), which keeps the page";
  if (flag("gpu") === "force") return "the GPU gate was forced (gpu=force)";
  if (typeof Worker === "undefined") return "no Worker here";
  if (typeof OffscreenCanvas === "undefined") return "no OffscreenCanvas here";
  if (typeof HTMLCanvasElement === "undefined" || !("transferControlToOffscreen" in HTMLCanvasElement.prototype)) return "a canvas cannot be handed to a worker here";
  return null;
}
/** whether the flight is drawn in a worker @returns {boolean} */
export function drawnAside() {
  if (drawn !== undefined) return drawn;
  if (!settings.drawWorker) return (drawn = false);
  const why = drawnWhy();
  drawn = why === null;
  page.note(drawn ? "orbit · flight: drawn in a worker" : `orbit · flight: drawn on the page: ${why}`);
  return drawn;
}

/*
 * WHERE THE PICTURES ARE DECODED (ADR-0004 6e.1). Firefox decodes a blob's picture (createImageBitmap(blob)) on the page's
 * thread, whichever thread asked, and stalls it for the decode's length; its own image loader (an <img> and decode())
 * does the same work on its decode pool. So where the family tell says Firefox, the pictures go through the loader
 * (page.js: decode); everywhere else, today's route. Decided once a page and said once when taken. `decode: "img"` takes
 * the loader whatever the rest says, `decode: "blob"` keeps today's route (the A/B control, and the tests' forced paths).
 * Otherwise the tell of drawnWhy, without the worker's clauses: the gate accepted the page (forced or not), it compiles
 * on its thread (parallel false), and no navigator.userAgentData.
 */
/** @type {boolean | undefined} */
let decoded;
/** whether the pictures are decoded by the browser's image loader @returns {boolean} */
export function decodeAside() {
  if (decoded !== undefined) return decoded;
  const asked = flag("decode");
  let take = asked === "img";
  if (!asked) {
    const g = gpu();
    take = !!g && !g.parallel && !("userAgentData" in (globalThis.navigator ?? {}));
  }
  decoded = take;
  if (take) page.note("orbit · pictures: decoded by the image loader");
  return take;
}
