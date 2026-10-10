/*
 * The site's background work, done a piece at a time.
 *
 * Readying the journeys is heavy for the page: pictures put on the GPU, shaders made, frames drawn to measure the
 * machine. Done all at once it stutters whatever is moving. So each piece is a chore, queued here and done one at
 * a time, a frame apart (no sooner), with a few frames' rest between one and the next, and none at all until
 * the painted part of the door's reveal is done (open). The network is not a chore: pictures are fetched (and decoded) as soon
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
const queue = [];
let open = false, soft = false, compiling = false, running = false, want = null, until = 0, wake = 0, started = 0, openedAt = 0;
/* when someone last typed (watchTyping): an unhurried chore waits while they are, so a texture upload never lands
   between a keystroke and its echo (Orbit's addition; settings.typingWait, 0 to never wait) */
let lastInput = -Infinity;
/* where the chores' time goes (noteChores): waiting for an idle moment, running, and the first one's start */
let waited = 0, ran = 0, firstAt = 0, empty = 0, emptyAt = 0, held = 0, heldAt = 0;
/* and each chore: its tag, how long it waited to start, how long it ran (ms) */
const record = [];
/* the soft chores run during the reveal (before open): how many, and how long they ran */
let softN = 0, softMs = 0;
/* when the frame's share of chores began (a frame boundary): once the queue is open, or a journey is hurried, soft
   chores run back to back within this much of a frame (ms) before the next frame is waited for; during the reveal,
   one a frame and no more */
let frameAt = 0;
const SHARE = 8, REVEAL_SHARE = 4;
/* ?holdreveal: nothing during the reveal, as before (openSoft is never called, and upload.js puts each picture on the
   GPU whole): for the owner's A/B */
export const holdReveal = () => !!flag("holdreveal");

import { settings, flag } from "./settings.js";
/* whether this browser compiles shaders in the background (KHR_parallel_shader_compile). Where it does not (Firefox),
   every compile freezes the page for as long as it takes (measured: even the compositor's animations stall), so each
   is a chore tagged "compile", all of them done while the first light's ring runs, before the door is lit
   (openCompiles; dawn.js waits for them), where only the ring's runner can show the hitch. Asked of a context
   made for the purpose and let go at once (Safari keeps only a few). &mainthread: as if it did not (to try the Firefox
   path in another browser) */
let aside = null;
export function compilesAside() {
  if (aside !== null) return aside;
  try {
    if (flag("mainthread")) return (aside = false);
    const gl = document.createElement("canvas").getContext("webgl2"); if (!gl) return (aside = true);
    const ok = !!gl.getExtension("KHR_parallel_shader_compile"); gl.getExtension("WEBGL_lose_context")?.loseContext(); return (aside = ok);
  } catch { return (aside = true); }
}
/* (each chore used to wait for an idle moment, requestIdleCallback with a 120 ms timeout: while the door moves neither
   browser calls one, so each waited the whole 120 ms. Measured on the laptop, 8 October: 1.6 s of waiting in Firefox
   and 1.3 s in Edge before the flight was ready. Now a chore starts a frame after the last, and no sooner) */
/* the order the rest are done in, when no journey has been chosen: the compiles before anything (only where they
   freeze the page: compilesAside; elsewhere nothing is tagged so; and before open, nothing else), then the journeys
   (a visitor can do nothing until one is ready), then the live door (door3d.js: its picture is already on screen),
   the measures, the docs' galaxy where it compiles in the background (voyage.js: after the door is live; the docs'
   journey still hurries it), and last of all the rich clouds, which nothing waits for */
const ORDER = ["compile", "install", "flight", "docs", "info", "", "door", "measure", "galaxy", "rich"];
/* a chore's tag may be a list: ranked by its first ("compile"), hurried by any (the journey the compile is for) */
const tags = (tag) => [].concat(tag);
const rank = (tag) => { const i = ORDER.indexOf(tags(tag)[0]); return i < 0 ? ORDER.length : i; };

function pump() {
  if (running || !queue.length) return;
  const now = performance.now();
  /* what the chosen journey needs, first */
  let i = want ? queue.findIndex((j) => tags(j.tag).some((t) => want.includes(t))) : -1;
  const hurried = i >= 0;
  if (!hurried) {
    if (!open && !compiling && !soft) { if (!heldAt) heldAt = now; return; }
    /* the rest waits until the journey has had its opening */
    if (now < until) { clearTimeout(wake); wake = setTimeout(pump, until - now + 20); return; }
    /* and while someone is typing, until they pause */
    const typing = settings.typingWait - (now - lastInput);
    if (typing > 0) { clearTimeout(wake); wake = setTimeout(pump, typing + 20); return; }
    /* before open, only a compile (while they may run) or a soft chore (once the door is lit), or nothing ("compile"
       ranks first, so if there is one, it is this) */
    const may = (j) => open || (compiling && tags(j.tag)[0] === "compile") || (soft && j.soft);
    i = -1;
    for (let k = 0; k < queue.length; k++) if (may(queue[k]) && (i < 0 || rank(queue[k].tag) < rank(queue[i].tag))) i = k;
    if (i < 0) { if (!heldAt) heldAt = now; return; }
  }
  running = true;
  const asked = performance.now();
  const run = () => {
    const [job] = queue.splice(Math.min(i, queue.length - 1), 1);
    started++;
    /* a soft chore let through before open: one of the reveal's */
    const early = job.soft && !open && !hurried;
    const t0 = performance.now(); waited += t0 - asked; if (!firstAt) firstAt = t0;
    const rec = { tag: tags(job.tag).join("+") || "-", w: Math.round(t0 - asked), r: 0 }; record.push(rec);
    let out;
    try { out = job.fn(); } catch (e) { out = Promise.reject(e); }
    Promise.resolve(out).then(job.resolve, job.reject).finally(() => {
      running = false; rec.r = Math.round(performance.now() - t0); ran += performance.now() - t0; if (!queue.length) emptyAt = performance.now();
      if (early) { softN++; softMs += performance.now() - t0; }
      /* a rest between chores: a frame or so, so whatever is moving keeps moving (the measures keep their longer rest,
         so nothing heavy sits right beside them); hurried, still a frame; a soft one during the reveal, a frame and no
         more (it fits in a frame's slack, and the reveal is short) */
      /* (a soft one after the reveal, or hurried: the next at once while the frame's share lasts) */
      const frame = (ms) => requestAnimationFrame(() => { frameAt = performance.now(); setTimeout(pump, ms); });
      /* (during the reveal a smaller share, 4 ms: a second band in the frame when the first was quick) */
      if (job.soft && performance.now() - frameAt < (open || hurried ? SHARE : REVEAL_SHARE)) setTimeout(pump, 0);
      else if (hurried || (job.soft && !open)) frame(0);
      else frame(job.tag === "measure" ? job.rest : Math.min(job.rest, 20));
    });
  };
  setTimeout(run, 0);
}

/** queue a piece of work for a journey (tag); resolves with what it returns (or what its promise resolves to).
    soft: it promises to take under ~5 ms, so it may run during the reveal (openSoft), one a frame */
export function chore(fn, rest = 60, tag = "", { soft: frameSized = false } = {}) {
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
/** a journey is chosen: what it needs (its tags) is done now, the rest after its opening (ms) */
export function hurryChores(tags, opening = 6000) {
  want = [].concat(tags || []);
  until = Math.max(until, performance.now() + opening);
  if (!open) openedAt = performance.now();
  open = true; pump();
}

/** the queue at rest: resolves once nothing is queued or running, and has stayed so for two animation frames, with
    calm(): whether it still is, and no chore has run since (a measure spread over frames asks at its end, and starts
    again if not) */
/* (the measures time the drawing alone: a chore beside them, an upload or a compile, is time that is not the
   drawing's, and a false measure lowers the drawing for the rest of the page view) */
export function quiet() {
  return new Promise((resolve) => {
    let at = -1, frames = 0;
    const look = () => {
      if (running || queue.length) { at = -1; frames = 0; }
      else if (at !== started) { at = started; frames = 0; }
      else if (++frames >= 2) { const was = started; resolve(() => !running && !queue.length && started === was); return; }
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
}
/** for the test only (?door3d, index.js: window.__chores): the queue as it is now */
export const choresNow = () => ({ queued: queue.map((j) => tags(j.tag).join("+")), running, started, open, soft, compiling, openedAt });

/* the pictures, fetched once for whatever wants them, and asked for as early as is wanted: the network is never a chore */
/* (keyed by the address resolved against the page, so a relative and an absolute spelling of one picture share
   the one fetch; off a page, by the string as given) */
const fetched = new Map();
const keyOf = (url) => { try { return new URL(url, document.baseURI).href; } catch { return url; } };
export function fetchOnce(url) {
  const key = keyOf(url);
  if (!fetched.has(key)) {
    const p = fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.blob(); });
    fetched.set(key, p);
    /* a failed fetch is forgotten, so the next ask tries the network again */
    p.catch(() => { if (fetched.get(key) === p) fetched.delete(key); });
  }
  return fetched.get(key);
}

/** where the chores' time has gone so far, in the console: running (a compile's wait in the background counts as
    running), waiting to start (a frame, or the opening a journey is given), the queue empty (nothing to do: the
    pictures still coming, or decoding), and the rests between */
export function noteChores(when) {
  const wall = firstAt ? performance.now() - firstAt : 0;
  /* (the soft chores ran inside the held time: counted once, as running) */
  note(`chores at ${when}: ${started} done, ran ${Math.round(ran)} ms, waited ${Math.round(waited)} ms to start, held ${Math.round(held)} ms for the reveal, of which ${softN} soft chores (${Math.round(softMs)} ms) during the reveal, empty ${Math.round(empty)} ms, resting ${Math.round(Math.max(0, wall - ran - waited - Math.max(0, held - softMs) - empty))} ms, over ${Math.round(wall)}`);
  /* each one: tag, waited/ran (?door3d only: a long line) */
  if (counting()) note(`chores, each (tag waited/ran ms): ${record.map((c) => `${c.tag} ${c.w}/${c.r}`).join(", ")}`);
}
/* how long the readying took, in the console (the first visit's GPU work differs greatly between machines and
   browsers: this says where the time went) */
export function note(what, since = 0) {
  try { console.info(`orbit · ${what}: ${Math.round(performance.now() - since)} ms${since ? "" : " after opening"}`); } catch { /* fine */ }
}
/* how many programs each part has linked (?door3d only: said in its notes, " (3 programs)", and summed by main.js) */
const counting = () => !!flag("door3d");
const links = {};
export function linked(label) { links[label] = (links[label] || 0) + 1; }
export const counted = (label) => (counting() ? ` (${links[label] || 0} program${links[label] === 1 ? "" : "s"})` : "");
/* all of them so far, and by part ("flight 3, world 2, …") */
export const programs = () => ({ n: Object.values(links).reduce((a, b) => a + b, 0), by: Object.entries(links).map(([k, v]) => `${k} ${v}`).join(", ") });
