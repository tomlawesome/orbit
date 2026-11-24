/*
 * WHAT THE GPU IS BUSY WITH, FOR THE FLIGHT WORLD'S VERDICT (#104). The verdict times whole frames (voyage.js:
 * quietFitness); a frame timed while another part of the site compiles a program or uploads a picture times that work
 * too (on Firefox every context on the page and in its workers shares one GPU process), and one such frame lost the
 * world for a visit. So every context the site makes is watched (watch): a shader or a program is "under way" from
 * compileShader / linkProgram until its status is read (COMPILE_STATUS, LINK_STATUS, or COMPLETION_STATUS_KHR answering
 * true) or it is deleted, and never longer than SPAN_CAP; every picture upload (texImage*, texSubImage*, compressed*,
 * generateMipmap) is a pulse, begun and ended at once.
 *
 * Each thread keeps its own ledger. A worker tells the page its own as it changes (page.busy, which the worker's adapter
 * posts as { type: "busy", n, gen }); the page tells each worker everyone else's (busyPeer: remote-flight.js, and a
 * host's own worker the same way), and hears theirs. quiet(): nothing under way here or anywhere heard of, and nothing
 * ended for SETTLE ms. mark(): a number that changes whenever anything here or heard of begins, ends or pulses, so a
 * timed frame whose mark changed (heard a little after it) is thrown away. own(fn): the timed frame's own calls, not
 * counted.
 */
import { page } from "./page.js";

/** ms after the last work ended before a frame may be timed: the GPU's tail of a call that has returned */
export const SETTLE = 100;
/** the longest a span is held open (COMPILE_WAIT's figure): a shader or program never asked about is taken as done */
export const SPAN_CAP = 5000;

/** @typedef {{ n: number, gen: number }} Busy  n: under way now; gen: a count that rises with every change */

const COMPILE_STATUS = 0x8B81, LINK_STATUS = 0x8B82, COMPLETION_STATUS_KHR = 0x91B1;
const UPLOADS = ["texImage2D", "texSubImage2D", "texImage3D", "texSubImage3D", "compressedTexImage2D", "compressedTexSubImage2D",
  "compressedTexImage3D", "compressedTexSubImage3D", "generateMipmap"];

/* this thread's own ledger; marks: every change, here or heard; gone: the gens of the sources gone, so a sum told on
   never falls back to one told before */
let n = 0, gen = 0, marks = 0, gone = 0, endedAt = -Infinity, owning = 0;
/** what other threads said, by source @type {Map<string, Busy>} */
const heard = new Map();
/** @type {Set<() => void>} */
const listeners = new Set();
const now = () => performance.now();

/* every change told at once to whoever listens here (a wait for quiet; the page's word to its workers): a compile holds
   the thread for its length, so a word put off to the end of the task would reach a worker after the frame it spoiled */
function told() {
  marks++;
  for (const fn of [...listeners]) { try { fn(); } catch { /* fine */ } }
}
/* this thread's own changed: also said to the page (from a worker, posted) */
function changed() {
  try { page.busy({ n, gen }); } catch { /* fine */ }
  told();
}

/** a span of work begun here; returns its end (once; ended at SPAN_CAP if never) @returns {() => void} */
function begin() {
  n++; gen++;
  let open = true;
  const end = () => {
    if (!open) return;
    open = false; clearTimeout(cap);
    n--; gen++; endedAt = now();
    changed();
  };
  const cap = setTimeout(end, SPAN_CAP);
  changed();
  return end;
}
/** work begun and ended at once (an upload; the verdict's own warm-up) */
export function pulse() {
  if (owning) return;
  gen++; endedAt = now();
  changed();
}

/** @param {unknown} v */
const count = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : 0; };
/** another thread's ledger, as it said it (a bad number is 0) @param {string} source @param {Partial<Busy> | null | undefined} b */
export function busyHeard(source, b) {
  const next = { n: count(b?.n), gen: count(b?.gen) };
  const was = heard.get(source);
  if (was && was.n === next.n && was.gen === next.gen) return;
  heard.set(source, next);
  endedAt = now();
  told();
}
/** a thread gone: nothing of it is under way any more @param {string} source */
export function busyGone(source) {
  const was = heard.get(source);
  if (!was) return;
  heard.delete(source);
  gone += was.gen + 1;
  if (was.n) endedAt = now();
  told();
}
/** everything this thread knows of but what `source` said (what is told to that source) @param {string} [source] @returns {Busy} */
export function busyExcept(source) {
  let bn = n, bg = gen + gone;
  for (const [k, v] of heard) if (k !== source) { bn += v.n; bg += v.gen; }
  return { n: bn, gen: bg };
}
/** fn on every change, here or heard; returns the stop @param {() => void} fn @returns {() => void} */
export function onBusy(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; }

/**
 * A thread the page talks to (a worker), by a name of its own: what it says is heard (heard), and everyone else's work
 * is posted to it as it changes, never its own back; gone() drops what it said and posts nothing more
 * @param {string} source @param {(m: { type: "busy", n: number, gen: number }) => void} post
 * @returns {{ heard(m: Partial<Busy>): void, gone(): void }}
 */
export function busyPeer(source, post) {
  let last = busyExcept(source), on = true;
  const tell = () => {
    const b = busyExcept(source);
    if (b.n === last.n && b.gen === last.gen) return;
    last = b;
    post({ type: "busy", n: b.n, gen: b.gen });
  };
  /* (a worker starts knowing of nothing under way: told only if something is) */
  if (last.n) post({ type: "busy", n: last.n, gen: last.gen });
  listeners.add(tell);
  return {
    heard(m) { if (on) busyHeard(source, m); },
    gone() { if (!on) return; on = false; listeners.delete(tell); busyGone(source); },
  };
}

/** the mark: changes whenever anything begins, ends or pulses, here or heard */
export const mark = () => marks;
/** nothing under way anywhere known, and nothing ended for SETTLE ms */
export const quiet = () => busyExcept().n === 0 && now() - endedAt >= SETTLE;
/** ms until nothing will have ended for SETTLE (0: that is so now) */
export const settling = () => Math.max(0, SETTLE - (now() - endedAt));
/** fn run with this thread's own calls not counted (the verdict's timed frame), even if it throws @template T @param {() => T} fn @returns {T} */
export function own(fn) {
  owning++;
  try { return fn(); } finally { owning--; }
}

/** @type {WeakSet<object>} */
const watched = new WeakSet();
/**
 * A context watched (once, however often asked): its compiles and uploads counted here. Returns what it was given;
 * null and undefined pass through
 * @template {WebGLRenderingContext | WebGL2RenderingContext | null | undefined} G @param {G} gl @returns {G}
 */
export function watch(gl) {
  if (!gl || watched.has(gl)) return gl;
  watched.add(gl);
  const g = /** @type {any} */ (gl);
  /** @type {WeakMap<object, () => void>} */
  const spans = new WeakMap();
  /** @type {WeakMap<object, object[]>} */
  const attached = new WeakMap();
  const start = (/** @type {object | null} */ o) => { if (o && !owning && !spans.has(o)) spans.set(o, begin()); };
  const end = (/** @type {object | null} */ o) => { const e = o && spans.get(o); if (e) { spans.delete(/** @type {object} */ (o)); e(); } };
  /* the status names as the context gives them, and as the spec numbers them */
  const linked = new Set([LINK_STATUS, g.LINK_STATUS]), compiled = new Set([COMPILE_STATUS, g.COMPILE_STATUS]);
  /** @typedef {(...a: any[]) => any} Call */
  /** @param {string} name @param {(real: Call) => Call} fn */
  const wrap = (name, fn) => { const real = g[name]; if (typeof real === "function") g[name] = fn(real.bind(gl)); };
  wrap("compileShader", (real) => (s) => { start(s); return real(s); });
  wrap("attachShader", (real) => (p, s) => { if (p && s) attached.set(p, [...(attached.get(p) || []), s]); return real(p, s); });
  /* (the shaders' compile folds into the program's: whatever is left of it is done by the link; the program's span
     opened first, so the count never touches 0 between them) */
  wrap("linkProgram", (real) => (p) => { start(p); for (const s of attached.get(p) || []) end(s); return real(p); });
  wrap("getProgramParameter", (real) => (p, pname) => {
    const v = real(p, pname);
    if (linked.has(pname) || (pname === COMPLETION_STATUS_KHR && v)) end(p);
    return v;
  });
  wrap("getShaderParameter", (real) => (s, pname) => {
    const v = real(s, pname);
    if (compiled.has(pname) || (pname === COMPLETION_STATUS_KHR && v)) end(s);
    return v;
  });
  wrap("deleteProgram", (real) => (p) => { end(p); return real(p); });
  wrap("deleteShader", (real) => (s) => { end(s); return real(s); });
  for (const name of UPLOADS) wrap(name, (real) => (...a) => { const v = real(...a); pulse(); return v; });
  return gl;
}
