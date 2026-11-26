/*
 * The site's background work, done a piece at a time.
 *
 * Readying the journeys is heavy for the page: pictures put on the GPU, shaders made, frames drawn to measure the
 * machine. Done all at once it stutters whatever is moving. So each piece is a chore, queued here and done one at
 * a time (or, once a frame's share has begun, several back to back while a few ms last), the share begun in an
 * animation frame's callback, before the paint, or by a 50 ms timer if frames are late or absent (ADR-0004 6d.2), with
 * a few frames' rest after the heavy ones, and none at all until the painted part of the door's reveal is done (open). The network is not a chore: pictures are fetched (and decoded) as soon
 * as they are asked for, off the page's own thread; only what touches the page or the GPU waits its turn.
 *
 * When a journey is chosen, what that journey still needs is done straight away (hurry), a frame between each piece,
 * hidden in the journey's opening; everything else is put off until the journey is under way (the chores are
 * tagged by what they ready: "flight", "docs", "install", "info"), so nothing it does not need stalls it. The
 * measures (frames timed to fit the drawing to the machine: "measure") are never hurried, and the live door's wait
 * for the queue to be at rest (quiet) before they time anything. Where the browser compiles shaders on the page's
 * own thread (COMPILES_ASIDE false), every compile is a chore tagged "compile", and those alone may run from the
 * page's start (openCompiles), under the first light's ring, before the door is lit; the rest still wait for open.
 * A chore that promises to be frame-sized (soft: under ~5 ms, a band of a picture put on the GPU: upload.js) may run
 * sooner, from the moment the door is lit (openSoft), one a frame, during the reveal; the rest still wait for open.
 */
/**
 * @typedef {string | string[]} Tag what a chore readies ("flight", "docs", "install", "info", "sharp", "compile", "galaxy", "door", "measure", "rich"), or a list of them
 * @typedef {{ fn: () => unknown, resolve(value: unknown): void, reject(reason: unknown): void, rest: number, tag: Tag, soft: boolean }} Job
 *   (resolve and reject are methods so a promise's own resolver, of any value type, fits the one queue)
 */
/** @type {Job[]} */
const queue = [];
let open = false, soft = false, compiling = false, running = false, resting = false, /** @type {string[] | null} */ want = null, until = 0, wake = 0, started = 0, openedAt = 0;
/* when someone last typed (watchTyping): an unhurried chore waits while they are, so a texture upload never lands
   between a keystroke and its echo (Orbit's addition; settings.typingWait, 0 to never wait) */
let lastInput = -Infinity;
/* where the chores' time goes (noteChores): waiting for an idle moment, running, and when the first was queued (-1:
   none yet) */
let waited = 0, ran = 0, firstAt = -1, empty = 0, emptyAt = 0, held = 0, heldAt = 0;
/* and the rest of it, each span counted once (#101): held with nothing running (holdAt: held net of the soft chores
   and their rests), an unhurried chore waiting for a journey's opening or for typing to pause (blockAt, from when,
   blockOpening, which), the waits for an animation frame between chores (their number, total, longest and how many
   over 50 ms) and the setTimeout waits (their number, the ms asked for, the ms they took) */
let heldNet = 0, holdAt = 0, openingMs = 0, typingMs = 0, blockAt = 0, blockOpening = false;
let framesN = 0, framesMs = 0, framesMax = 0, framesSlow = 0, timersN = 0, timersAsked = 0, timersMs = 0;
/* and each chore: its tag, how long it waited to start, how long it ran, and the frame wait and the timer wait that
   followed it (ms) */
/** @type {{ tag: string, w: number, r: number, f: number, t: number }[]} */
const record = [];
/* the soft chores run during the reveal (before open): how many, and how long they ran */
let softN = 0, softMs = 0;
/* the reveal's share (before open, soft chores only): when it began (frameAt, a frame boundary), and whether a frame
   has been waited for and no chore has started since (fresh). During the reveal one soft chore runs a frame, a second
   only if the first fitted in REVEAL_SHARE of the share's start (#101: on a phone the browser paints between the frame
   callback and the hop, ~8 ms, so a share counted from the callback was spent before the first chore started) */
let frameAt = 0, fresh = true;
/* the page's share once the queue is open or a journey is hurried (ADR-0004 6d.2): the window in which chores start,
   closing at windowEnd (performance.now()); it opens in an animation frame's callback (or the backstop's firing) and
   lasts the budget (SHARE, or REVEAL_SHARE while something moves on the page's thread: moving()). A chore that starts
   inside it runs whole; the next starts at once, in the microtask that ends the last, while the window is still open */
let windowEnd = 0, movers = 0;
/* and what the share costs, for the line: the hops (page.yield, or the worker's 0 ms timers) and the shares begun by
   the backstop rather than a frame */
let yieldsN = 0, yieldsMs = 0, backstopsN = 0;
/** @type {{ f: number } | null} the last chore's record, which a frame wait after it is counted against */
let lastRec = null;
const SHARE = 8, REVEAL_SHARE = 4;
/* the longest a frame is waited for before the share is begun without one (ms): a page drawing under 20 frames a second
   paints nothing worth waiting for, and a hidden tab has no frames at all; a healthy page never sees it fire */
const FRAME_WAIT = 50;
/* the longest a chore may hold the queue (ms): the longest real one is a texture upload or a compile, seconds on a slow GPU */
const CAP = 15000;
/* the queue's pace (pace): "page", every hold and rest here, so whatever moves on the page keeps moving; "none", a
   queue with no page to keep moving (a worker's, ADR-0004 6a.5): a chore runs the moment the last ends, whether or not
   the queue is open, a journey's opening is over or someone is typing, and a picture goes on the GPU whole (upload.js).
   The measures keep their rest: a chore beside one is still not the drawing's time */
let paced = true;
/** @param {"page" | "none"} how */
export function pace(how) { paced = how !== "none"; }
export const unpaced = () => !paced;
/* ?holdreveal: nothing during the reveal, as before (openSoft is never called, and upload.js puts each picture on the
   GPU whole): for the owner's A/B */
export const holdReveal = () => !!flag("holdreveal");

import { settings, flag } from "./settings.js";
import { gpu } from "./fitness.js";
import { page, decodeHere } from "./page.js";
/* whether this browser compiles shaders in the background (KHR_parallel_shader_compile). Where it does not (Firefox),
   every compile freezes the page for as long as it takes (measured: even the compositor's animations stall), so each
   is a chore tagged "compile", all of them done while the first light's ring runs, before the door is lit
   (openCompiles; dawn.js waits for them), where only the ring's runner can show the hitch. Asked of the page's one
   context (fitness.js: gpu(), which makes it on first asking, never a throwaway); true where the page may not use the
   GPU at all (nothing will compile). &mainthread: as if it did not (to try the Firefox path in another browser) */
/** @type {boolean | null} */
let aside = null;
/** @returns {boolean} */
export function compilesAside() {
  if (aside !== null) return aside;
  try {
    /* (no page on this thread, the worker's: nothing a compile can freeze, ADR-0004 6a.5) */
    if (!page.shared()) return (aside = true);
    if (flag("mainthread")) return (aside = false);
    const g = gpu();
    return (aside = g ? g.parallel : true);
  } catch { return (aside = true); }
}
/* (each chore used to wait for an idle moment, requestIdleCallback with a 120 ms timeout: while the door moves neither
   browser calls one, so each waited the whole 120 ms. Measured on the laptop, 8 October: 1.6 s of waiting in Firefox
   and 1.3 s in Edge before the flight was ready. Now a chore starts a frame after the last, and no sooner) */
/* the order the rest are done in, when no journey has been chosen: the compiles before anything (only where they
   freeze the page: compilesAside; elsewhere nothing is tagged so; and before open, nothing else), then the journeys
   (a visitor can do nothing until one is ready; the docs' before the flight's: owner, #101, 13a, so the docs open first on a
   slow device), the docs' galaxy where it compiles in the background (voyage.js:
   one chore that only starts its compiles, so it costs the door nothing, and the docs' way in opens with the others',
   #49; the docs' journey still hurries it), then the live door (door3d.js: its picture is already on screen), the
   measures, and last of all the rich clouds, which nothing waits for. The flight's maps' larger sizes ("sharp", #148)
   come behind every journey's readying and are never hurried: the gate opens on the smallest sizes */
const ORDER = ["compile", "install", "docs", "flight", "info", "sharp", "", "galaxy", "door", "measure", "rich"];
/* a chore's tag may be a list: ranked by its first ("compile"), hurried by any (the journey the compile is for) */
/** @param {Tag} tag @returns {string[]} */
const tags = (tag) => /** @type {string[]} */ ([]).concat(tag);
/** @param {Tag} tag */
const rank = (tag) => { const i = ORDER.indexOf(tags(tag)[0]); return i < 0 ? ORDER.length : i; };

/* the next task, with no clamp, where the queue is paced (the page): its own yield (page.js), or, from a host's page
   adapter without one, a 0 ms timer. Unpaced (a worker, pace("none")) the hop stays a 0 ms timer: there the host's
   own messages (a frame, a size) share the task queue with a yield, and a chore hopping ahead of them drew the
   flight's first frame before its size had come (draw-pixels P1, 2026-10-30); the worker's hops were never the wait.
   The page's queue hops only in the reveal (the share in a frame's callback needs none, 6d.2); each hop is timed for the line */
/** @param {() => void} fn */
const hop = (fn) => {
  const t = performance.now();
  const done = () => { yieldsN++; yieldsMs += performance.now() - t; fn(); };
  if (paced && typeof page.yield === "function") page.yield(done); else setTimeout(done, 0);
};

/** something moves on the page's thread (a flight's own loop, drawn there): the share is the smaller REVEAL_SHARE
    until it is released. Counted, so loops may overlap; the release is safe to call twice
    @returns {() => void} */
export function moving() {
  movers++;
  let held = true;
  return () => { if (held) { held = false; movers--; } };
}

/* a frame wait over (by a frame or the backstop): counted against the chore before it */
/** @param {number} d */
const framed = (d) => {
  framesN++; framesMs += d;
  if (lastRec) lastRec.f += d;
  if (d > framesMax) framesMax = d;
  if (d > 50) framesSlow++;
};

/* the page's share begins in the next animation frame's callback or, if that is FRAME_WAIT late, a timer's: whichever
   fires first runs it and cancels the other, exactly one share a wait (React's scheduler, 2018:
   requestAnimationFrameWithTimeout). The window opens at the firing, and `go` runs in it */
/** `blocked`: the share follows a wait for a journey's opening (true) or for typing to pause (false), and the frame wait
    that ends it is counted as that wait, so the span from the block to the chore's start is counted once
    @param {(at: number) => void} go @param {boolean | null} [blocked] */
function shareFrame(go, blocked = null) {
  const f0 = performance.now();
  let live = true, id = 0, timer = /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined);
  /** @param {boolean} late */
  const fire = (late) => {
    if (!live) return;
    live = false;
    if (late) { try { page.cancelFrame(id); } catch { /* a page adapter with no cancel */ } backstopsN++; } else clearTimeout(timer);
    const at = performance.now();
    if (blocked === null) framed(at - f0); else if (blocked) openingMs += at - f0; else typingMs += at - f0;
    windowEnd = at + (movers > 0 ? REVEAL_SHARE : SHARE);
    go(at);
  };
  id = page.frame(() => fire(false));
  timer = setTimeout(() => fire(true), FRAME_WAIT);
}

function pump() {
  if (running || resting || !queue.length) return;
  const now = performance.now();
  /* (any wait there was is over: it is begun again below if it goes on) */
  const blocked = blockAt ? blockOpening : null;
  if (holdAt) { heldNet += now - holdAt; holdAt = 0; }
  if (blockAt) { if (blockOpening) openingMs += now - blockAt; else typingMs += now - blockAt; blockAt = 0; }
  /* what the chosen journey needs, first */
  let i = want ? queue.findIndex((j) => tags(j.tag).some((t) => /** @type {string[]} */ (want).includes(t))) : -1;
  if (want && i < 0 && now >= until) want = null;
  const hurried = i >= 0;
  if (!hurried) {
    if (paced && !open && !compiling && !soft) { if (!heldAt) heldAt = now; holdAt = now; return; }
    /* the rest waits until the journey has had its opening */
    if (paced && now < until) { blockAt = now; blockOpening = true; clearTimeout(wake); wake = setTimeout(pump, until - now + 20); return; }
    /* and while someone is typing, until they pause */
    const typing = paced ? settings.typingWait - (now - lastInput) : 0;
    if (typing > 0) { blockAt = now; blockOpening = false; clearTimeout(wake); wake = setTimeout(pump, typing + 20); return; }
    /* before open, only a compile (while they may run) or a soft chore (once the door is lit), or nothing ("compile"
       ranks first, so if there is one, it is this) */
    /** @param {Job} j */
    const may = (j) => !paced || open || (compiling && tags(j.tag)[0] === "compile") || (soft && j.soft);
    i = -1;
    for (let k = 0; k < queue.length; k++) if (may(queue[k]) && (i < 0 || rank(queue[k].tag) < rank(queue[i].tag))) i = k;
    if (i < 0) { if (!heldAt) heldAt = now; holdAt = now; return; }
  }
  running = true;
  const job = queue[i];
  /* a soft chore let through before open: one of the reveal's (untouched by the share: one a frame, a hop after it) */
  const early = job.soft && !open && !hurried, reveal = paced && early;
  /** @param {number} asked */
  const run = (asked) => {
    queue.splice(Math.max(0, queue.indexOf(job)), 1);
    started++;
    const t0 = performance.now(); waited += t0 - asked; if (fresh) { frameAt = t0; fresh = false; }
    const rec = { tag: tags(job.tag).join("+") || "-", w: Math.round(t0 - asked), r: 0, f: 0, t: 0 }; record.push(rec); lastRec = rec;
    let out;
    try { out = job.fn(); } catch (e) { out = Promise.reject(e); }
    /* a job that never settles must not hold the queue for ever: after CAP the queue goes on. The chore's own promise
       is left as it was (settling by what the job does, if it ever does): a caller waiting on it has its own limit, and
       one that ignored the promise would otherwise be given a rejection nobody handles */
    let over = false, cap = 0;
    const end = () => {
      if (over) return;
      over = true; clearTimeout(cap);
      const t1 = performance.now();
      running = false; rec.r = Math.round(t1 - t0); ran += t1 - t0;
      if (early) { softN++; softMs += t1 - t0; }
      /* (the queue is empty from the end of the chore, or of its rest: the rest is counted as a rest, #101) */
      const next = () => { resting = false; if (!queue.length) emptyAt = performance.now(); pump(); };
      /* (the waits are timed, for the line: a timer asked for ms, counted against the chore before it) */
      /** @param {number} ms */
      const timer = (ms) => {
        const t2 = performance.now(); timersN++; timersAsked += ms;
        resting = true;
        setTimeout(() => { const d = performance.now() - t2; timersMs += d; rec.t += d; next(); }, ms);
      };
      if (!paced) {
        /* (unpaced: the next at once, and nothing but a measure rests) */
        resting = true;
        if (job.tag === "measure" && job.rest > 0) timer(job.rest); else hop(next);
      } else if (reveal) {
        /* (the reveal: a second band in the frame when the first was quick, else the next frame, and a hop after it) */
        resting = true;
        if (t1 - frameAt < REVEAL_SHARE) hop(next);
        else {
          const f0 = performance.now();
          page.frame(() => { fresh = true; framed(performance.now() - f0); next(); });
        }
      } else if (job.soft) {
        /* (a soft one: the next at once, in this microtask, while the window lasts; else pump asks a frame) */
        if (!queue.length) emptyAt = t1;
        pump();
      } else {
        /* (a hard one shuts the window: its rest is a timer, where one is asked, and then a frame, so the next share
           lands in a callback; a hurried one keeps no rest, as before, and a measure its own) */
        windowEnd = 0;
        const ms = job.tag === "measure" ? job.rest : hurried ? 0 : Math.min(job.rest, 20);
        if (ms > 0) timer(ms); else next();
      }
    };
    cap = setTimeout(end, CAP);
    Promise.resolve(out).then(job.resolve, job.reject).finally(end);
  };
  const asked = performance.now();
  if (!paced || reveal) hop(() => run(performance.now()));
  /* a chore may start while the window is open, in a microtask of its own, never synchronously (a caller of chore() gets
     its promise first); outside it, in the next frame's callback */
  else if (asked < windowEnd) Promise.resolve().then(() => run(asked));
  else shareFrame(run, blocked);
}

/**
 * queue a piece of work for a journey (tag); resolves with what it returns (or what its promise resolves to).
 * soft: it promises to take under ~5 ms, so it may run during the reveal (openSoft), one a frame
 * @template T
 * @param {() => T | Promise<T>} fn
 * @param {number} [rest]
 * @param {Tag} [tag]
 * @param {{ soft?: boolean }} [options]
 * @returns {Promise<T>}
 */
export function chore(fn, rest = 60, tag = "", { soft: frameSized = false } = {}) {
  if (firstAt < 0) firstAt = performance.now();
  if (emptyAt) { empty += performance.now() - emptyAt; emptyAt = 0; }
  return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject, rest, tag, soft: frameSized }); pump(); });
}
/** the keyboard watched (index.js), once however often the door is made, and never off a page (a server has no
    keyboard): capture, so a field that stops propagation still counts as typing */
let watching = false;
export function watchTyping() {
  if (watching || typeof addEventListener !== "function") return;
  watching = true;
  for (const type of ["keydown", "input", "compositionupdate"]) addEventListener(type, () => { lastInput = performance.now(); }, { capture: true, passive: true });
}
/* the door is lit and the painted part of its reveal done: the chores may begin (the rest is carried by the compositor) */
export function openChores() { if (!open) openedAt = performance.now(); if (heldAt) { held += performance.now() - heldAt; heldAt = 0; } open = true; pump(); }
/* the door is lit and its reveal begins (main.js: light; never with ?holdreveal): the soft chores may run now, one a
   frame, and nothing else (but the compiles, where they may) until openChores */
export function openSoft() { soft = true; pump(); }
/** the soft chores run during the reveal so far: how many, and how long they ran (ms) */
export const softRan = () => ({ n: softN, ms: softMs });
/* the page has started, where compiles freeze it (main.js, COMPILES_ASIDE false): the "compile" chores may run now,
   while the first light's ring runs, and nothing else until openChores */
export function openCompiles() { compiling = true; pump(); }
/** a journey is chosen: what it needs (its tags) is done now, the rest after its opening (ms). A call made while the
    opening of the last still runs adds to what is wanted (a flight to the docs hurries ["flight", "docs"], and its
    proving warm() then "flight" again); one made after it starts afresh. What is wanted ends with its need: once the
    opening is over and nothing queued has a wanted tag, nothing is wanted, so a tag hurried once (the install's, on
    arriving there) does not skip the opening of every later journey
    @param {Tag | null} [tags]
    @param {number} [opening] */
export function hurryChores(tags, opening = 6000) {
  const now = performance.now();
  want = [...new Set([...(want && now < until ? want : []), .../** @type {string[]} */ ([]).concat(tags || [])])];
  until = Math.max(until, now + opening);
  if (!open) openedAt = performance.now();
  open = true; pump();
}

/** the painted animations done: resolves once every finite animation on the page that is painted (not only composited:
    a transform or an opacity is the compositor's, a colour or a size is the page's) has finished, so work that touches
    the GPU never runs under a reveal still being drawn (the door's first light; journey.js: later) */
const COMPOSITED = new Set(["transform", "opacity", "offset", "easing", "composite", "computedOffset"]);
/** @param {Animation & { transitionProperty?: string }} a */
const painted = (a) => {
  try {
    const t = /** @type {KeyframeEffect} */ (a.effect).target;
    if (typeof SVGElement === "function" && t instanceof SVGElement && !(t instanceof SVGSVGElement)) return true;
    const props = a.transitionProperty ? [a.transitionProperty] : /** @type {KeyframeEffect} */ (a.effect).getKeyframes().flatMap(Object.keys);
    return props.some((k) => !COMPOSITED.has(k));
  } catch { return true; }
};
/** @param {number} [cap] @returns {Promise<unknown>} */
export function drawnIn(cap = 10000) {
  try {
    const ends = document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime) && painted(a));
    /* (never past cap ms: an animation that does not end, or a hidden tab's that does not run, holds nothing for long) */
    return Promise.race([Promise.all(ends.map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, cap))]);
  } catch { return Promise.resolve([]); }
}

/** the queue at rest: resolves once nothing is queued or running, and has stayed so for two animation frames, with
    calm(): whether it still is, and no chore has run since (a measure spread over frames asks at its end, and starts
    again if not)
    @returns {Promise<() => boolean>} */
/* (the measures time the drawing alone: a chore beside them, an upload or a compile, is time that is not the
   drawing's, and a false measure lowers the drawing for the rest of the page view) */
export function quiet() {
  return new Promise((resolve) => {
    let at = -1, frames = 0;
    const look = () => {
      if (running || queue.length) { at = -1; frames = 0; }
      else if (at !== started) { at = started; frames = 0; }
      else if (++frames >= 2) { const was = started; resolve(() => !running && !queue.length && started === was); return; }
      page.frame(look);
    };
    page.frame(look);
  });
}
/** for the test only (?door3d, index.js: window.__chores; tools/ci/freeze.mjs): the queue as it is now (queuedSoft:
    whether each queued one is soft, beside queued; moving: how many loops hold the smaller share, moving()) */
export const choresNow = () => ({ queued: queue.map((j) => tags(j.tag).join("+")), queuedSoft: queue.map((j) => j.soft), running, started, open, soft, compiling, openedAt, moving: movers });

/* the pictures, fetched once for whatever wants them, and asked for as early as is wanted: the network is never a chore */
/* (keyed by the address resolved against the page, so a relative and an absolute spelling of one picture share
   the one fetch; off a page, by the string as given) */
/** @type {Map<string, Promise<Blob>>} */
const fetched = new Map();
/** @param {string} url */
const keyOf = (url) => { try { return new URL(url, page.baseURI()).href; } catch { return url; } };
/* the longest a picture is waited for (its answer and its body both): a download that opens and never delivers is
   given up on and forgotten like a failed one, so the flight is never held flat by it and the next ask tries again.
   Shorter than the journey's backstop (WORLD_FAILED, 30 s, journey.js), which waits past it, as past COMPILE_WAIT, below */
export const PICTURE_WAIT = 20000;
/** @param {string} url @returns {Promise<Blob>} */
export function fetchOnce(url) {
  const key = keyOf(url);
  if (!fetched.has(key)) {
    const ac = typeof AbortController === "undefined" ? null : new AbortController();
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    /** @type {Promise<never>} */
    const limit = new Promise((_, no) => { timer = setTimeout(() => { ac?.abort(); no(new Error(`${url}: no answer in ${PICTURE_WAIT} ms`)); }, PICTURE_WAIT); });
    const got = fetch(url, ac ? { signal: ac.signal } : undefined).then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.blob(); });
    const p = Promise.race([got, limit]).finally(() => clearTimeout(timer));
    fetched.set(key, p);
    /* a failed fetch is forgotten, so the next ask tries the network again */
    p.catch(() => { if (fetched.get(key) === p) fetched.delete(key); });
  }
  return /** @type {Promise<Blob>} */ (fetched.get(key));
}

/**
 * A picture fetched once (fetchOnce) and decoded by this thread's route (page.js: decode; ADR-0004 6e): the browser's image
 * loader where fitness.js says so, createImageBitmap(blob, options) elsewhere, a worker's page asked in a worker. A
 * decode is never a chore, as a download is not; the caller's chore is what puts the bitmap on the GPU.
 * @param {string} url @param {ImageBitmapOptions} [options] @returns {Promise<ImageBitmap>}
 */
export function fetchBitmap(url, options) { return fetchOnce(url).then((blob) => page.decode(blob, options)); }
/** a blob this thread has, decoded as fetchBitmap does (a host answering a worker's ask) @param {Blob} blob @param {ImageBitmapOptions} [options] */
export const decodeBlob = (blob, options) => page.decode(blob, options);

/**
 * A worker's way to the page's decoder (ADR-0004 6e.2): `decode` for page.decode (setPage) posts the blob up as a `decode`
 * ask and resolves on the page's `decoded` answer (the bitmap, transferred); `heard` is given each `decoded` message. An
 * error answer, no answer in PICTURE_WAIT (the bound a download has) or an answer with no bitmap is made good in the
 * worker, by createImageBitmap(blob, options); an answer for an ask no longer waiting changes nothing.
 * @param {(message: object) => void} post
 */
export function askPage(post) {
  let ids = 0;
  /** @type {Map<number, (m: { bitmap?: ImageBitmap }) => void>} */
  const waiting = new Map();
  return {
    /** @param {Blob} blob @param {ImageBitmapOptions} [options] @returns {Promise<ImageBitmap>} */
    decode: (blob, options) => new Promise((resolve) => {
      const id = ++ids;
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const end = () => { waiting.delete(id); clearTimeout(timer); };
      const here = () => { end(); resolve(decodeHere(blob, options)); };
      waiting.set(id, (m) => { if (m.bitmap) { end(); resolve(m.bitmap); } else here(); });
      timer = setTimeout(here, PICTURE_WAIT);
      post({ type: "decode", id, blob, options });
    }),
    /** @param {{ id: number, bitmap?: ImageBitmap }} m */
    heard(m) { const f = waiting.get(m.id); if (f) f(m); else m.bitmap?.close?.(); },  // a late or second answer: let its bitmap go
  };
}

/** where the chores' time has gone so far, in the console: running (a compile's wait in the background counts as
    running), waiting to start (the hop before a chore), held for the reveal, the queue empty (nothing to do: the
    pictures still coming, or decoding; the span still open now included), the waits between chores (for an animation
    frame; for a timer: asked for, and what it took, the difference being the browser's clamping or throttling), an
    unhurried chore waiting for a journey's opening, and for typing to pause. `resting` is what none of those explain,
    and should be near 0 (#101: it was a remainder that read a frame-rate crawl as a pause)
    @param {string} when */
export function noteChores(when) {
  const now = performance.now();
  const wall = firstAt < 0 ? 0 : now - firstAt;
  const idle = empty + (emptyAt ? now - emptyAt : 0);
  /* (the soft chores ran inside the held time, so held is taken net of the time something ran or rested in it: heldNet) */
  /* (not clamped: below 0 means a span was counted twice, which is as much a finding as a gap above it) */
  const rest = wall - ran - waited - heldNet - idle - framesMs - yieldsMs - timersMs - openingMs - typingMs;
  note(`chores at ${when}: ${started} done, ran ${Math.round(ran)} ms, waited ${Math.round(waited)} ms to start, held ${Math.round(held)} ms for the reveal, of which ${softN} soft chores (${Math.round(softMs)} ms) during the reveal, empty ${Math.round(idle)} ms, frames ${framesN}, ${Math.round(framesMs)} ms (longest ${Math.round(framesMax)} ms, ${framesSlow} over 50 ms), yields ${yieldsN}, ${Math.round(yieldsMs)} ms, backstops ${backstopsN}, timers ${timersN}, asked ${Math.round(timersAsked)} ms, took ${Math.round(timersMs)} ms, opening ${Math.round(openingMs)} ms, typing ${Math.round(typingMs)} ms, resting ${Math.round(rest)} ms, over ${Math.round(wall)}`);
  /* each one: tag, waited/ran, and the frame wait and the timer wait after it (?door3d only: a long line) */
  if (counting()) note(`chores, each (tag waited/ran/frame/timer): ${record.map((c) => `${c.tag} ${c.w}/${c.r}/${Math.round(c.f)}/${Math.round(c.t)} ms`).join(", ")}`);
}
/** how long the readying took, in the console (the first visit's GPU work differs greatly between machines and
   browsers: this says where the time went)
   @param {string} what @param {number} [since] */
export function note(what, since = 0) {
  try { page.note(`orbit · ${what}: ${Math.round(performance.now() - since)} ms${since ? "" : " after opening"}`); } catch { /* fine */ }
}
/* the longest a compile in the background is waited for (KHR_parallel_shader_compile's COMPLETION_STATUS_KHR, polled):
   past it, as on a lost context, the compile is taken as never coming and its part goes on without it (#49: a status
   that never turned true left the docs, and with the probe the whole door, waiting for ever). Over twice the slowest
   background compile measured (the laptop's flight, 1.8 s: CAPABILITIES.md) */
export const COMPILE_WAIT = 5000;
/** programs compiled in the background (par: the extension), waited for: true once every one says it is done, false
    if the context is lost, the caller stops waiting (stop()) or COMPILE_WAIT passes first (the caller then goes on
    without them); true at once where there is no extension (the browser compiles on the page's own thread)
    @param {WebGLRenderingContext | WebGL2RenderingContext} gl
    @param {KHR_parallel_shader_compile | null} par
    @param {WebGLProgram[]} list
    @param {number} [every]
    @param {() => boolean} [stop]
    @returns {Promise<boolean>} */
export const compiledWithin = (gl, par, list, every = 40, stop = () => false) => new Promise((resolve) => {
  if (!par) { resolve(true); return; }
  /* (only the time the page is seen counts: a hidden tab's compiles and timers may be held back by the browser, so a
     phone tab put in the background mid-compile does not lose its world for the visit) */
  /* (#123: a span between two polls counts only if the page was seen at both and not shown again in between, so the
     first poll after the tab comes back does not credit the time it was away; page.onVisible, which the draw worker
     answers too) */
  let seen = 0, last = performance.now(), was = !page.hidden(), away = false;
  const unsee = page.onVisible(() => { away = true; });
  /** @param {boolean} ok */
  const done = (ok) => { unsee(); resolve(ok); };
  const poll = () => {
    const now = performance.now(), shown = !page.hidden();
    if (shown && was && !away) seen += now - last;
    was = shown; away = false; last = now;
    if (gl.isContextLost() || stop()) done(false);
    else if (list.every((p) => gl.getProgramParameter(p, par.COMPLETION_STATUS_KHR))) done(true);
    else if (seen > COMPILE_WAIT) done(false);
    else setTimeout(poll, every);
  };
  poll();
});
/* how many programs each part has linked (?door3d only: said in its notes, " (3 programs)", and summed by main.js) */
const counting = () => !!flag("door3d");
/** @type {Record<string, number>} */
const links = {};
/** @param {string} label */
export function linked(label) { links[label] = (links[label] || 0) + 1; }
/** @param {string} label */
export const counted = (label) => (counting() ? ` (${links[label] || 0} program${links[label] === 1 ? "" : "s"})` : "");
/* all of them so far, and by part ("flight 3, world 2, …") */
export const programs = () => ({ n: Object.values(links).reduce((a, b) => a + b, 0), by: Object.entries(links).map(([k, v]) => `${k} ${v}`).join(", ") });
