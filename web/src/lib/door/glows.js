/*
 * The dawn's and the dusk's glows, rasterised once (Orbit's #501/#502).
 *
 * Every blurred or turbulence-filtered shape on the two flight surfaces is
 * static: nothing under a filter ever changes shape frame to frame. What
 * moves is a CSS opacity (the cone, the scattering, the sun's breath) or a
 * rigid CSS rotation (the two fans of rays), and both composite over a
 * picture exactly as they would over a live filter. WebKit re-rasterises a
 * live SVG filter on the CPU on every repaint regardless, so each group is
 * drawn once, offscreen, with its own copy of the identical filter graph,
 * and set on a plain <image> in the same 1600×1000 frame it came from.
 * The soft groups are pictures now (tools/glows.cjs draws them from the
 * graphs below); only the sun's own glows are still painted here, per size,
 * dithered (paintSun), and mountRasters keeps the rays turning about the
 * sunrise point.
 */

/**
 * @typedef {{ defs: string, body: string }} Group a glow: its filter and gradient definitions, and what is drawn
 * @typedef {import("./sun.js").SunDisc} SunDisc one radial gradient of the sun
 */
import { SUN, sunBand, sunDiscs, sunRows } from "./sun.js";
import { settings, flag } from "./settings.js";

export { SUN };

const F_B6L = '<filter id="b6l" filterUnits="userSpaceOnUse" x="-40" y="-40" width="1680" height="1080"><feGaussianBlur stdDeviation="6"/></filter>';
const F_B20L = '<filter id="b20l" filterUnits="userSpaceOnUse" x="-100" y="-100" width="1800" height="1200"><feGaussianBlur stdDeviation="20"/></filter>';
const F_RAYROUGH = '<filter id="rayrough" x="-30%" y="-30%" width="160%" height="160%"><feTurbulence type="fractalNoise" baseFrequency="0.004 0.03" numOctaves="2" seed="9" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="22"/><feGaussianBlur stdDeviation="17"/></filter>';
const G_ZOD = '<radialGradient id="zod" cx="50%" cy="88%" r="75%"><stop offset="0%" stop-color="#f6d489" stop-opacity=".13"/><stop offset="55%" stop-color="#e8b25e" stop-opacity=".045"/><stop offset="100%" stop-opacity="0"/></radialGradient>';
const G_RAYG = '<linearGradient id="rayg" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#ffe4a8" stop-opacity=".26"/><stop offset="55%" stop-color="#f4c05a" stop-opacity=".07"/><stop offset="100%" stop-opacity="0"/></linearGradient>';

export const DAWN = {
  zod: { defs: F_B20L + G_ZOD, body: '<ellipse cx="800" cy="640" rx="300" ry="480" fill="url(#zod)" filter="url(#b20l)"/>' },
  sway1: {
    defs: F_RAYROUGH + G_RAYG,
    body: '<g fill="url(#rayg)" filter="url(#rayrough)">' +
      '<path d="M 800 924 L 736 356 L 772 362 Z"/><path d="M 800 924 L 852 528 L 892 548 Z"/><path d="M 800 924 L 508 620 L 556 588 Z"/>' +
      '<path d="M 800 924 L 1096 448 L 1052 428 Z"/><path d="M 800 924 L 320 690 L 360 646 Z" opacity=".8"/><path d="M 800 924 L 1290 670 L 1244 630 Z" opacity=".8"/></g>',
  },
  sway2: {
    defs: F_RAYROUGH + G_RAYG,
    body: '<g fill="url(#rayg)" filter="url(#rayrough)" opacity=".7">' +
      '<path d="M 800 924 L 646 404 L 680 390 Z"/><path d="M 800 924 L 962 560 L 928 544 Z"/><path d="M 800 924 L 404 610 L 448 574 Z"/><path d="M 800 924 L 1200 596 L 1156 562 Z"/></g>',
  },
  sunpt: { defs: F_B6L, body: '<circle cx="800" cy="919" r="20" fill="#fffdf6" filter="url(#b6l)"/>' },
  /* the sun's three glows, which the door drew live: eight-bit radial
     gradients with nothing to break their steps, so they rang about the sun;
     drawn here, they are dithered with the rest */
};

const F_DB6 = '<filter id="d-b6" filterUnits="userSpaceOnUse" x="-40" y="-40" width="1680" height="1080"><feGaussianBlur stdDeviation="6"/></filter>';
const F_DB14 = '<filter id="d-b14" filterUnits="userSpaceOnUse" x="-80" y="-80" width="1760" height="1160"><feGaussianBlur stdDeviation="14"/></filter>';
const F_DB24 = '<filter id="d-b24" filterUnits="userSpaceOnUse" x="-120" y="-120" width="1840" height="1240"><feGaussianBlur stdDeviation="24"/></filter>';
const G_DRIM = '<linearGradient id="d-rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#f0a35a"/><stop offset="100%" stop-color="#7a2c18"/></linearGradient>';
const G_DGLOW = '<radialGradient id="d-glow" cx="50%" cy="100%" r="60%"><stop offset="0%" stop-color="#e2772b" stop-opacity=".28"/><stop offset="60%" stop-color="#7a2c18" stop-opacity=".08"/><stop offset="100%" stop-opacity="0"/></radialGradient>';
const G_DBELT = '<linearGradient id="d-belt" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#5a3a7a" stop-opacity="0"/><stop offset="50%" stop-color="#a24d6a" stop-opacity=".18"/><stop offset="100%" stop-color="#e2772b" stop-opacity="0"/></linearGradient>';

export const DUSK = {
  glow: { defs: F_DB24 + G_DGLOW, body: '<ellipse cx="800" cy="960" rx="900" ry="380" fill="url(#d-glow)" filter="url(#d-b24)"/>' },
  belt: { defs: F_DB24 + G_DBELT, body: '<rect x="0" y="560" width="1600" height="360" fill="url(#d-belt)" filter="url(#d-b24)"/>' },
  afterglow: {
    defs: F_DB24 + F_DB14 + F_DB6,
    body: '<circle cx="800" cy="3920" r="3080" fill="none" stroke="#7a2c18" stroke-opacity=".14" stroke-width="120" filter="url(#d-b24)"/>' +
      '<circle cx="800" cy="3920" r="3030" fill="none" stroke="#c2571f" stroke-opacity=".18" stroke-width="44" filter="url(#d-b14)"/>' +
      '<circle cx="800" cy="3920" r="3008" fill="none" stroke="#f0a35a" stroke-opacity=".28" stroke-width="10" filter="url(#d-b6)"/>',
  },
  rim: { defs: F_DB6 + G_DRIM, body: '<circle cx="800" cy="3920" r="3000" fill="none" stroke="url(#d-rim)" stroke-width="5" stroke-opacity=".3" filter="url(#d-b6)"/>' },
};

/* The heavily blurred groups carry no edge a second device pixel could
   sharpen, so they are drawn at CSS resolution; only the thin ones (the sun's
   core, the dusk's rim) are drawn at device resolution. */
/* (the sun's glows too: their core is sharp-ish, but eighty-six units wide,
   not two) */
const SOFT = new Set(["zod", "sway1", "sway2", "glow", "belt", "afterglow", "sun"]);
/* and the softest of them — nothing in them narrower than a 12-unit blur —
   at half of that, which a blur that wide cannot tell apart */
const SOFTEST = new Set(["zod", "sway1", "sway2", "glow", "belt"]);
/** @type {Map<string, string>} */
const cache = new Map();
/* a picture of a size no longer current: out of the cache, its blob: URL revoked (a data: URL holds nothing) */
/** @param {string} key */
function forget(key) {
  const url = cache.get(key);
  cache.delete(key);
  if (typeof url === "string" && url.startsWith("blob:")) URL.revokeObjectURL(url);
}
/** @param {string} svg @returns {Promise<HTMLImageElement>} */
function decodeSvg(svg) {
  const img = new Image();
  const done = new Promise((resolve, reject) => { img.onload = () => resolve(img); img.onerror = reject; });
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return done;
}
/** @param {string} key @param {string} svg @param {number} w @param {number} h */
async function rasterise(key, svg, w, h) {
  const hit = cache.get(key);
  if (hit) return hit;
  const img = await decodeSvg(svg);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  /* a new canvas has no other context, so the 2D one is never null (HTML spec, getContext) */
  /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d")).drawImage(img, 0, 0, w, h);
  return keep(key, canvas);
}
/* encoded off the main thread where the browser allows it, so the page keeps answering while the light lands */
/** @param {string} key @param {HTMLCanvasElement} canvas */
async function keep(key, canvas) {
  /** @type {Blob | null} */ const blob = await new Promise((r) => { try { canvas.toBlob(r, "image/png"); } catch { r(null); } });
  const url = blob ? URL.createObjectURL(blob) : canvas.toDataURL("image/png");
  /* (two builds of one size under way at once: the first picture kept, the second let go, so none is left unrevoked) */
  const had = cache.get(key);
  if (had) { if (url.startsWith("blob:")) URL.revokeObjectURL(url); return had; }
  cache.set(key, url);
  return url;
}
/* the sun painted and encoded by the host's worker (settings.sunWorker, running sun-worker.js), off the page's thread.
   Resolves with the PNG, or null where the page is to paint it: no sunWorker, no Worker or OffscreenCanvas, ?sun=page,
   the host's worker null or throwing, and every way a worker fails (an error, an unreadable message, a reply with no
   picture, no reply within the backstop). The worker is ended however it ends, and what it says later is let go. `ends`,
   if given, is handed a function that ends it at once with null (a stopped or superseded build: mountRasters). */
const SUN_BACKSTOP_MS = 20000;
/** @param {number} w @param {number} h @param {Set<() => void>} [ends] @returns {Promise<Blob | null>} */
function sunInWorker(w, h, ends) {
  const make = settings.sunWorker;
  if (!make || flag("sun") === "page" || typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") return Promise.resolve(null);
  /** @type {Worker | null} */ let worker = null;
  try { worker = make(); } catch { /* the page paints it */ }
  const w1 = worker;
  if (!w1) return Promise.resolve(null);
  return new Promise((resolve) => {
    let over = false;
    /** @param {Blob | null} blob */
    const end = (blob) => {
      if (over) return;
      over = true;
      ends?.delete(abort);
      clearTimeout(timer);
      try { w1.terminate(); } catch { /* gone already */ }
      resolve(blob);
    };
    const abort = () => end(null);
    ends?.add(abort);
    const timer = setTimeout(abort, SUN_BACKSTOP_MS);
    w1.addEventListener("message", (e) => end(e.data?.blob ?? null));
    w1.addEventListener("error", (e) => { e.preventDefault?.(); end(null); });
    w1.addEventListener("messageerror", () => end(null));
    try { w1.postMessage({ w, h }); } catch { end(null); }
  });
}
/** @param {string} key @param {number} w @param {number} h @param {() => boolean} [live] @param {Set<() => void>} [ends] @returns {Promise<string | null>} */
async function paintSun(key, w, h, live = () => true, ends) {
  const hit = cache.get(key);
  if (hit) return hit;
  const blob = await sunInWorker(w, h, ends);
  if (!blob && !live()) return null;   /* (its worker ended with the build: the page paints nothing for it) */
  if (blob) {
    /* a build that a newer size has superseded makes nothing; two builds of one size: the first picture kept, the second let go */
    if (!live()) return null;
    const had = cache.get(key);
    if (had) return had;
    const url = URL.createObjectURL(blob);
    cache.set(key, url);
    return url;
  }
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d")), s = w / 1600; // new canvas: never null
  const discs = sunDiscs(), rows = sunRows(w);
  for (let y0 = 0; y0 < h; y0 += rows) {
    const n = Math.min(rows, h - y0), im = ctx.createImageData(w, n);
    sunBand(discs, s, w, y0, n, im.data);
    ctx.putImageData(im, 0, y0);
    if (y0 + rows < h) {
      await new Promise((r) => setTimeout(r, 0));
      /* a build that a newer size has superseded stops painting between bands (nothing is made for it) */
      if (!live()) return null;
    }
  }
  return keep(key, canvas);
}
/** @param {string} defs @param {string} body @param {number} w @param {number} h */
const frame = (defs, body, w, h) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 1600 1000"><defs>${defs}</defs>${body}</svg>`;

/* Both surfaces fill the viewport, so the slice scale is the viewport's.
   The groups are drawn one at a time with a breath between each, so the
   first light's own fade (three seconds) covers their arrival and the page
   stays answerable while they land; the result is kept per size. Each
   picture is handed to `drawn(url, name)` as it is set, for a host to
   decode it ahead of showing it (the dawn's, #32). */
/**
 * @param {HTMLElement} world
 * @param {Record<string, Group | SunDisc[]>} groups the pictures to make, by name (`SUN` is painted, the rest drawn from their SVG)
 * @param {string} prefix
 * @param {{ until?: () => Promise<unknown> | null, drawn?: (url: string, name: string) => void }} [options]
 * @returns {{ start: () => void, stop: () => void }}
 */
export function mountRasters(world, groups, prefix, { until = () => null, drawn = () => {} } = {}) {
  let /** @type {ReturnType<typeof setTimeout> | undefined} */ timer, run = 0, /** @type {Set<string>} */ current = new Set();
  /* the picture each layer shows now (its cache key), so nothing on screen is let go */
  /** @type {Map<string, string>} */
  const shown = new Map();
  /* where the sunrise point (800, 920 in the slice) falls on screen, for the
     layers that turn about it */
  const origin = () => {
    const W = world.clientWidth || innerWidth, H = world.clientHeight || innerHeight, s = Math.max(W / 1600, H / 1000);
    world.style.setProperty("--ox", `${((W - 1600 * s) / 2 + 800 * s).toFixed(1)}px`);
    world.style.setProperty("--oy", `${(H - 1000 * s + 920 * s).toFixed(1)}px`);
  };
  async function build() {
    const id = ++run;
    endSun();
    origin();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const base = Math.max(innerWidth / 1600, innerHeight / 1000);
    world.dataset.rasterised = "pending";
    /* this build's pictures: name -> [key, w, h] (the key says the size), the newest build's being the current sizes */
    const sizes = Object.fromEntries(Object.keys(groups).map((name) => {
      const scale = base * (SOFTEST.has(name) ? 0.5 : SOFT.has(name) ? 1 : dpr);
      const w = Math.max(1, Math.round(1600 * scale)), h = Math.max(1, Math.round(1000 * scale));
      return [name, /** @type {[string, number, number]} */ ([`${prefix}-${name}|${w}|${h}`, w, h])];
    }));
    current = new Set(Object.values(sizes).map(([key]) => key));
    for (const [name, group] of Object.entries(groups)) {
      const [key, w, h] = sizes[name];
      /* the sun is painted (paintSun); the rest are drawn from their SVG */
      const url = /** @type {string} */ (await (group === SUN ? paintSun(key, w, h, () => id === run, sunEnds) : rasterise(key, frame(/** @type {Group} */ (group).defs, /** @type {Group} */ (group).body, w, h), w, h)));
      /* superseded: what it made for a size that is no longer current is let go (the newer build's own sizes are kept),
         unless it is a picture still on screen (a cached one it was handed): the newest build lets that go as it ends */
      if (id !== run) { if (url && !current.has(key) && ![...shown.values()].includes(key)) forget(key); return; }
      world.querySelector(`image[data-raster="${name}"]`)?.setAttribute("href", url);
      shown.set(name, key);
      drawn(url, name);
      await new Promise((r) => setTimeout(r, 0));
      if (id !== run) return;
    }
    /* "ready" is "drawn": the host may hold it for more (`until()`: a promise it never rejects; the dawn's Earth) */
    /* the newer build has ended: the pictures of sizes no longer current are let go (their blob: URLs revoked) */
    for (const k of [...cache.keys()]) if (k.startsWith(`${prefix}-`) && !current.has(k)) forget(k);
    await until();
    if (id !== run) return;
    world.dataset.rasterised = "ready";
  }
  /* the sun workers in flight, ended with the build that asked for them (a newer build, or stop) */
  /** @type {Set<() => void>} */
  const sunEnds = new Set();
  const endSun = () => { for (const f of [...sunEnds]) f(); };
  const rebuild = () => { clearTimeout(timer); timer = setTimeout(build, 120); };
  const start = () => { build(); addEventListener("resize", rebuild); };
  origin(); addEventListener("resize", origin);
  /* taken down: a build under way stops at its next step, and nothing listens */
  const stop = () => { run++; endSun(); clearTimeout(timer); removeEventListener("resize", rebuild); removeEventListener("resize", origin); };
  return { start, stop };
}
