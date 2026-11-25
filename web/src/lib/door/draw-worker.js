/*
 * THE FLIGHT DRAWN IN A WORKER (ADR-0004 6a): the worker's entry, made by the host (settings.drawWorker, a module
 * worker) and spoken to by remote-flight.js on the page. Both canvases are handed over; the engine (engine.js) and its
 * world (voyage.js) run here as the modules they are, on this thread's own frames, with page.js answering for the page
 * from what the page last said. The handshake: `hello` (the settings, the pictures' addresses, the fonts, the size),
 * then `canvases`; once both contexts are made and the fonts loaded, `up`, and the world is made at once: there is no
 * page here to freeze, so no compile is spaced or held (6a.5). Every console line goes to the page as a `note`. Where
 * the `hello` says `decode: "page"` the pictures are decoded by the page (6e.2): a `decode` posted up, a `decoded` back.
 *
 * What arrives before `up` waits for it, in order. An exception handling a message is `dead`: the page falls back.
 */
import { setPage, page, askedOnce, stoppedAt } from "./page.js";
import { configure } from "./settings.js";
import { createFlight, unwireProfile } from "./engine.js";
import { fetchBitmap, askPage, openChores, pace } from "./chores.js";
import { gpu } from "./fitness.js";
import { statusGo } from "./status.js";
import { busyHeard } from "./busy.js";

/** @typedef {{ add(face: FontFace): unknown }} FontSet */
/**
 * What this file uses of a dedicated worker's global scope (the folder's one tsconfig has the dom lib, not webworker)
 * @typedef {object} WorkerScope
 * @property {(message: unknown) => void} postMessage
 * @property {((e: MessageEvent) => void) | null} onmessage
 * @property {() => void} close
 * @property {FontSet} fonts
 */
const scope = /** @type {WorkerScope} */ (/** @type {unknown} */ (self));
/** @param {object} m */
const post = (m) => scope.postMessage(m);

let size = { W: 0, H: 0, dpr: 1 }, hidden = false;
/** @type {Set<() => void>} */
const shown = new Set();
/** @type {Promise<unknown>} */
let fontsIn = Promise.resolve();
/** @type {{ warp: HTMLCanvasElement, warpgl: HTMLCanvasElement } | null} */
let canvases = null;
/** @type {ReturnType<typeof createFlight> | null} */
let engine = null;
/* the start whose first frame is still to be said (its seq), and the current seq */
let want = 0, current = 0, ready = false, gone = false;
/** @type {any[]} */
const waiting = [];
/** @type {WebGL2RenderingContext | null} */
let glNow = null;
/** @type {ReturnType<typeof askPage> | null} */
let asker = null;

/* a lost context where the canvas says nothing of it (OffscreenCanvas fires webglcontextlost from Firefox 125): looked
   at before every frame and every message, and told to the world as the event would have (voyage.js) */
let lostSaid = false;
/* the world's context lost and not restored: an ask settling meanwhile is answered not ok (as after `destroy`) */
let dark = false;
const backstop = () => {
  if (!glNow || lostSaid || !glNow.isContextLost()) return;
  lostSaid = true;
  canvases?.warpgl.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
};

/** @param {any} m the page's `hello` */
function hello(m) {
  const images = /** @type {Record<string, string>} */ (m.images || {});
  size = m.size; hidden = !!m.hidden;
  asker = m.decode === "page" ? askPage(post) : null;
  setPage({
    size: () => size,
    /* (the page styles both canvases itself on every size) */
    css() {},
    hidden: () => hidden,
    onVisible(fn) { shown.add(fn); return () => { shown.delete(fn); }; },
    frame: (fn) => requestAnimationFrame((t) => { backstop(); fn(t); }),
    picture(url, loaded) {
      /** @type {ImageBitmap | null} */
      let bitmap = null, done = false;
      const settled = fetchBitmap(url)
        .then((b) => { bitmap = b; loaded(b, b.width, b.height); }, () => {}).finally(() => { done = true; });
      return { settled, done: () => done, drawable: () => bitmap };
    },
    ...(asker ? { decode: asker.decode } : {}),
    canvas: (w, h) => /** @type {HTMLCanvasElement} */ (/** @type {unknown} */ (new OffscreenCanvas(w, h))),
    /* (the world's context, on the canvas handed over; the page's gate has judged already) */
    gate: () => (canvases ? { canvas: canvases.warpgl, check: false } : null),
    canPlace: () => true,
    mount() {},
    unmount() {},
    baseURI: () => m.baseURI,
    note(line) { post({ type: "note", line, kind: "note" }); },
    verdict(line) { post({ type: "note", line, kind: "verdict" }); },
    /* (the memory of the verdict is the page's, ADR-0002 6.12: the page keeps it, and opens its ways in on it) */
    judged(v) { post({ type: "verdict", fit: v.fit, ms: v.ms, skipped: !!v.skipped, how: v.how }); },
    shared: () => false,
    /* (this thread's compiles and uploads, for the page's ledger: busy.js) */
    busy(b) { post({ type: "busy", n: b.n, gen: b.gen }); },
  });
  configure({ flags: m.flags || {}, image: (p) => images[p] ?? p, typingWait: 0, settle: m.settle });
  /* the worker's own queue: open from the start, nothing in it waiting for the page */
  pace("none");
  openChores();
  const faces = /** @type {{ family: string, weight: number | string, url: string }[]} */ (m.fonts || []);
  fontsIn = Promise.all(faces.map((f) => {
    const face = new FontFace(f.family, `url(${JSON.stringify(f.url)})`, { weight: String(f.weight) });
    scope.fonts.add(face);
    return face.load();
  }));
}

/** @param {string} why */
const no = (why) => { gone = true; post({ type: "up", ok: false, why }); };

/* both contexts made and the fonts loaded: `up`, the world made at once, then what waited */
function bringUp() {
  if (gone || !canvases) return;
  const g = gpu();
  if (!g) return no("no WebGL2 in a worker here");
  if (!g.gl.getExtension("EXT_color_buffer_float")) return no("no float colour buffers");
  glNow = g.gl;
  const { warp, warpgl } = canvases;
  const ctx = warp.getContext("2d");
  if (!ctx || ctx.letterSpacing === undefined) return no("the 2D context has no letterSpacing");
  warpgl.addEventListener("webglcontextlost", () => { dark = true; post({ type: "lost" }); });
  warpgl.addEventListener("webglcontextrestored", () => { lostSaid = false; dark = false; });
  const mine = engine = createFlight(warp, { requestFrame: (fn) => page.frame((t) => { fn(t); drew(); }) });
  ready = true;
  post({ type: "up", ok: true, renderer: g.renderer });
  mine.warm({ prove: false });
  mine.compiled().then((ok) => post({ type: "compiled", ok: !!ok }), () => post({ type: "compiled", ok: false }));
  for (const m of waiting.splice(0)) handle(m);
}

/* the first frame of the current start is on its canvas */
function drew() {
  if (!want || want !== current || !engine) return;
  want = 0;
  post({ type: "frame", seq: current, world: engine.withWorld });
}

/** @param {any} m */
function handle(m) {
  const e = /** @type {ReturnType<typeof createFlight>} */ (engine);
  switch (m.type) {
    case "warm": {
      const { id } = m, how = { prove: m.prove !== false };
      (m.kind === "warmDocs" ? e.warmDocs(how) : e.warm(how)).then(() => post({ type: "warmed", id, ok: !gone && !dark }), () => post({ type: "warmed", id, ok: false }));
      break;
    }
    case "start": {
      /* (a flight started is the host's first work done: its world's shaders are asked for now, status.js) */
      statusGo();
      current = m.seq;
      const P = unwireProfile(m.profile);
      if (typeof m.at === "number") { want = 0; e.start(P, { at: m.at }); post({ type: "frame", seq: m.seq, world: e.withWorld }); }
      else { want = m.seq; e.start(P); }
      break;
    }
    case "stop": current = m.seq; want = 0; e.stop(); break;
    case "clear": current = m.seq; want = 0; e.clear(); break;
    case "abandon": e.abandon(); break;
  }
}

/* (an exception outside a frame: the worker cannot go on, and the page draws instead) */
/** @param {() => void} fn */
const guard = (fn) => {
  try { fn(); } catch (e) { gone = true; post({ type: "dead", why: String(/** @type {Error} */ (e)?.message || e), at: stoppedAt(e) }); }
};

/** @param {MessageEvent} ev */
scope.onmessage = (ev) => guard(() => {
  const m = ev.data;
  if (!m || typeof m !== "object") return;
  backstop();
  switch (m.type) {
    case "hello": hello(m); break;
    case "canvases": canvases = { warp: askedOnce(m.warp), warpgl: askedOnce(m.warpgl) }; size = m.size || size; fontsIn.then(() => guard(bringUp), () => no("the fonts did not load")); break;
    case "size": size = { W: m.W, H: m.H, dpr: m.dpr }; engine?.resize(); break;
    /* (an answer is heard at once: the pictures it holds are what the flight waits for) */
    case "decoded": asker?.heard(m); break;
    /* the host's word that its first work is done (status.js): heard at once, made or not */
    case "status": statusGo(); break;
    /* (what the page and the other workers have under way, for the verdict's quiet: busy.js) */
    case "busy": busyHeard("page", m); break;
    case "visible": hidden = !!m.hidden; if (!hidden) for (const fn of [...shown]) fn(); break;
    case "destroy": gone = true; engine?.destroy(); scope.close(); break;
    default: if (gone) break; if (ready) handle(m); else waiting.push(m);
  }
});
