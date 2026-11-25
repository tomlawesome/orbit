/*
 * THE FLIGHT DRAWN IN A WORKER, AS THE PAGE SEES IT (ADR-0004 6a.3, 6a.4). The very surface createFlight returns
 * (engine.js), so the journey holds one engine whichever it is; behind it, the host's worker (settings.drawWorker,
 * running draw-worker.js) owns both canvases, handed over, and draws the flight and its world there. The page keeps the
 * timeline, the hooks and the body classes, and posts only what changes: a start, a stop, a size, a visibility.
 *
 * The usual worker RPC: asks carry an id and resolve on the reply with that id (any other is dropped); start, stop and
 * clear carry a sequence number, and a `frame` for a superseded one changes nothing.
 *
 * ONE FALLBACK for every failure (the worker's error event, `up` not ok, `dead`, and under the automatic rule no `up`
 * within WORKER_WAIT): #warp replaced by a fresh canvas with its attributes (a handed-over one never gives the page a
 * context again), #warpgl removed, the worker terminated, a page engine made on the new canvas, the pending asks asked
 * of it, and a flight under way picked up where it was (skip: its time so far). From then on everything is the page
 * engine's, and the worker is told nothing more.
 */
import { createFlight, wireProfile, EARTH_PICTURE } from "./engine.js";
import { PICTURE_PATHS, SIZED_PATHS } from "./voyage.js";
import { settings, image } from "./settings.js";
import { decodeAside, rememberedFit } from "./fitness.js";
import { page } from "./page.js";
import { onStatusGo } from "./status.js";
import { busyPeer } from "./busy.js";

/** @import { Profile } from "./engine.js" */
/** @typedef {ReturnType<typeof createFlight>} Engine */
/** @typedef {Omit<Engine, "withWorld">} Flight the engine's surface, as the journey holds it */
/** @typedef {Flight & { aside: () => Promise<boolean> }} RemoteFlight and whether the worker came up (ADR-0004 6b.6) */
/** @typedef {{ kind: "warm" | "warmDocs", prove: boolean, resolve: (v?: unknown) => void }} Ask */

/* the longest `up` is waited for under the automatic rule (COMPILE_WAIT's figure, a cap not a measurement): past it the
   page draws as it always has. Under draw=worker there is none, so a slow runner cannot turn a forced worker test into
   a page-path pass */
export const WORKER_WAIT = 5000;
/* each flight's worker a name of its own in the page's ledger (busy.js: busyPeer) */
let flights = 0;

/**
 * @param {HTMLCanvasElement} canvas #warp, handed to the worker
 * @param {{ now?: () => number, cap?: boolean }} [options] now: the journey's clock; cap: wait WORKER_WAIT for `up`
 * @returns {RemoteFlight}
 */
export function createRemoteFlight(canvas, { now = () => performance.now(), cap = true } = {}) {
  let warp = canvas;
  /** @type {HTMLCanvasElement | null} */
  let gl = null;
  /* the page's own engine, once fallen back: everything is asked of it from then on */
  /** @type {Engine | null} */
  let engine = null;
  let up = false, handed = false, destroyed = false, ids = 0, seq = 0;
  /** @type {Map<number, Ask>} */
  const pending = new Map();
  /* the flight last started and not stopped: what a fallback picks up */
  /** @type {{ P: Profile, at?: number, since: number } | null} */
  let live = null;
  /** @type {(v: unknown) => void} */
  let compiledIs = () => {};
  const compiled = new Promise((r) => { compiledIs = r; });
  /* the verdict on the world (ADR-0002 6.3, 6.12): a pass remembered on this device, read here on the page at the first
     warm (the worker reads nothing remembered), or the worker's `verdict`, which the page keeps (page.judged); handed to
     the page engine on a fallback, as compiled() is */
  /** @type {(v: unknown) => void} */
  let verdictIs = () => {};
  /** @type {Promise<any>} */
  const verdict = new Promise((r) => { verdictIs = r; });
  let decided = false, remembered = false;
  /** @param {unknown} v */
  const decide = (v) => { if (!decided) { decided = true; verdictIs(v); } };
  /* true once the worker said `up`; false once the flight is on the page before it did (a fallback, or destroyed) */
  /** @type {(v: boolean) => void} */
  let asideIs = () => {};
  const aside = new Promise((r) => { asideIs = r; });
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {Worker | null} */
  let worker = null;
  /** @param {object} m @param {Transferable[]} [transfer] */
  const post = (m, transfer = []) => { if (!(worker && !engine)) return false; worker.postMessage(m, transfer); return true; };
  /* the worker's compiles and uploads kept in the page's ledger, and everyone else's told to it as they change, for its
     verdict's quiet (busy.js, #104); until unlisten */
  /** @type {ReturnType<typeof busyPeer> | null} */
  let busy = null;
  const style = () => { const { W, H } = page.size(); for (const c of [warp, gl]) if (c) page.css(c, W, H); };
  const sizeNow = () => { const { W, H, dpr } = page.size(); return { W, H, dpr }; };
  const onVisibility = () => post({ type: "visible", hidden: page.hidden() });

  /** @param {MessageEvent} e */
  const hear = (e) => {
    const m = e.data;
    if (engine || destroyed || !m || typeof m !== "object") return;
    switch (m.type) {
      case "up": if (m.ok) { up = true; clearTimeout(timer); asideIs(true); } else fallBack(String(m.why || "the worker cannot draw here")); break;
      /* (the worker's console lines, printed as they come: every line reads as it does on the page) */
      case "note": if (m.kind === "verdict") page.verdict(String(m.line)); else page.note(String(m.line)); break;
      case "compiled": compiledIs(!!m.ok); break;
      /* the worker's judgement (draw-worker.js: judged): kept here, where the memory is, and the verdict if none is in */
      case "verdict": {
        const v = { fit: !!m.fit, ms: Number(m.ms), skipped: !!m.skipped, how: String(m.how || (m.skipped ? "skipped" : "tested")) };
        page.judged(v);
        decide({ fit: v.fit, ms: v.ms, how: v.how });
        break;
      }
      /* a picture's bytes from the worker, decoded here by the image loader and handed back, transferred (ADR-0004 6e.2) */
      case "decode":
        if (!m.blob) { post({ type: "decoded", id: m.id, error: "no picture" }); break; }
        page.decode(m.blob, m.options).then((bitmap) => post({ type: "decoded", id: m.id, bitmap }, [bitmap]) || bitmap.close(),  // gone meanwhile: let it go
          (e) => post({ type: "decoded", id: m.id, error: String(e?.message || e) }));
        break;
      case "warmed": { const ask = pending.get(m.id); if (ask) { pending.delete(m.id); ask.resolve(); } break; }
      case "frame": if (m.seq === seq) warp.dataset.drawn = String(m.seq); break;
      case "lost": page.note("orbit · flight: the world's context was lost in the worker"); break;
      case "dead": fallBack(`the worker stopped (${String(m.why || "no reason given")})${m.at ? ` at ${String(m.at).split("\n")[0]}` : ""}`); break;
      /* the worker's compiles and uploads, kept in the page's ledger (busy.js) */
      case "busy": busy?.heard(m); break;
    }
  };
  const failed = () => fallBack(up ? "the worker failed" : "the worker failed to load");
  const unreadable = () => fallBack("a message from the worker could not be read");
  /* the host's word, told on to the worker (status.js; set after the `hello`, so a word already given reaches a
     worker made late); stopped with the rest at a fallback or destroy */
  let unword = () => {};
  const unlisten = () => {
    clearTimeout(timer);
    unword();
    busy?.gone(); busy = null;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    worker?.removeEventListener("message", hear);
    worker?.removeEventListener("error", failed);
    worker?.removeEventListener("messageerror", unreadable);
  };

  /** @param {string} why */
  function fallBack(why) {
    if (engine) return;
    unlisten();
    try { worker?.terminate(); } catch { /* gone already */ }
    /* (a canvas never handed over is kept; a handed-over one is replaced, its attributes but the worker's mark copied) */
    if (handed) {
      const fresh = document.createElement("canvas");
      for (const n of warp.getAttributeNames()) if (n !== "data-drawn") fresh.setAttribute(n, /** @type {string} */ (warp.getAttribute(n)));
      warp.replaceWith(fresh);
      warp = fresh;
    }
    gl?.remove(); gl = null;
    const mine = engine = createFlight(warp, { now });
    asideIs(false);
    page.note(`orbit · flight: drawn on the page: ${why}`);
    if (destroyed) { mine.destroy(); return; }
    for (const ask of pending.values()) (ask.kind === "warmDocs" ? mine.warmDocs({ prove: ask.prove }) : mine.warm({ prove: ask.prove })).then(ask.resolve);
    pending.clear();
    compiledIs(mine.compiled());
    decide(mine.verdict());
    /* a flight under way goes on painted from the next frame, from where it was, rather than ending blank */
    if (live) {
      const { P, at, since } = live;
      if (typeof at === "number") mine.start(P, { at });
      else {
        const t = (now() - since) * (P.rate || 1) + (P.skip || 0);
        if (t < (P.dur ?? Infinity) + 400) mine.start({ ...P, skip: t });
      }
    }
  }

  try {
    worker = settings.drawWorker?.() ?? null;
    if (!worker) throw new Error("no worker");
    worker.addEventListener("message", hear);
    worker.addEventListener("error", failed);
    worker.addEventListener("messageerror", unreadable);
    /* (absolute, because a relative URL in a module worker resolves against the worker's own file, not the page) */
    const base = page.baseURI(), abs = (/** @type {string} */ u) => new URL(u, base).href;
    const images = Object.fromEntries([...Object.values(PICTURE_PATHS), ...SIZED_PATHS, EARTH_PICTURE].map((p) => [p, abs(image(p))]));
    const flags = Object.fromEntries(Object.entries(settings.flags || {}).filter(([k]) => k !== "door3d"));
    const fonts = (settings.fonts || []).map((f) => ({ family: f.family, weight: f.weight, url: abs(f.url) }));
    post({ type: "hello", decode: decodeAside() ? "page" : "here", flags, images, fonts, baseURI: base, settle: settings.settle, size: sizeNow(), hidden: page.hidden() });
    unword = onStatusGo(() => { post({ type: "status" }); });
    /* #warpgl made and placed beneath #warp, both styled, then both handed over */
    gl = document.createElement("canvas");
    page.mount(gl, warp);
    style();
    const a = warp.transferControlToOffscreen();
    handed = true;
    const b = gl.transferControlToOffscreen();
    post({ type: "canvases", warp: a, warpgl: b, size: sizeNow() }, [a, b]);
    busy = busyPeer(`flight ${++flights}`, post);
    document.addEventListener("visibilitychange", onVisibility);
    if (cap) timer = setTimeout(() => { if (!up) fallBack(`no answer in ${WORKER_WAIT} ms`); }, WORKER_WAIT);
  } catch (e) {
    fallBack(worker ? `the canvases could not be handed over (${/** @type {Error} */ (e).message})` : "the host made no worker");
  }

  /** @param {"warm" | "warmDocs"} kind @param {boolean} prove @returns {Promise<any>} */
  const ask = (kind, prove) => {
    if (engine) return kind === "warmDocs" ? engine.warmDocs({ prove }) : engine.warm({ prove });
    if (destroyed) return Promise.resolve();
    if (!remembered) { remembered = true; const kept = rememberedFit(); if (kept?.fit) decide({ fit: true, ms: kept.ms, how: "remembered" }); }
    const id = ++ids;
    return new Promise((resolve) => { pending.set(id, { kind, prove, resolve }); post({ type: "warm", id, kind, prove }); });
  };
  return {
    compiled() { return engine ? engine.compiled() : compiled; },
    verdict() { return engine ? engine.verdict() : verdict; },
    /* the journey's hold gave up on the world (journey.js: WORLD_FAILED): the worker's engine is told, and the verdict, if
       none is in, is failed here too, as the page engine's abandon fails it: a worker that has stalled answers nothing,
       and the gate and the backs wait on the verdict */
    abandon() {
      if (engine) { engine.abandon(); return; }
      post({ type: "abandon" });
      decide({ fit: false, ms: Infinity, how: "failed" });
    },
    aside() { return aside; },
    /* (a world in a worker cannot stall the page: the journey keeps real time, 6a.3) */
    get drawingWorld() { return engine ? engine.drawingWorld : false; },
    warm({ prove = true } = {}) { return ask("warm", prove); },
    warmDocs({ prove = true } = {}) { return ask("warmDocs", prove); },
    /** @param {Profile} P @param {{ at?: number }} [options] */
    start(P, { at } = {}) {
      if (engine) { engine.start(P, { at }); return; }
      const profile = wireProfile(P);
      seq++;
      /* (the mark is the new start's once its first frame is said, as on the page) */
      delete warp.dataset.drawn;
      live = { P, at, since: now() };
      post({ type: "start", seq, profile, ...(typeof at === "number" ? { at } : {}) });
    },
    stop() { if (engine) { engine.stop(); return; } seq++; live = null; post({ type: "stop", seq }); },
    clear() { if (engine) { engine.clear(); return; } seq++; live = null; post({ type: "clear", seq }); },
    destroy() {
      if (engine) { engine.destroy(); return; }
      if (destroyed) return;
      destroyed = true; live = null;
      post({ type: "destroy" });
      unlisten();
      try { worker?.terminate(); } catch { /* gone already */ }
      /* (what was asked settles: nothing more will answer it) */
      for (const a of pending.values()) a.resolve();
      pending.clear();
      compiledIs(false);
      asideIs(false);
    },
    resize() { if (engine) { engine.resize(); return; } style(); post({ type: "size", ...sizeNow() }); },
    get running() {
      if (engine) return engine.running;
      if (!live) return false;
      const { P, at, since } = live;
      return typeof at !== "number" && (now() - since) * (P.rate || 1) + (P.skip || 0) < (P.dur ?? Infinity) + 400;
    },
  };
}
