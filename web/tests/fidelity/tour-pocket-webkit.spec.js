import { expect, test } from "@playwright/test";

const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * THE POCKET FILM IN WEBKIT (#1174).
 *
 * The first-run film's pocket cut (#1083) shipped with every check green and
 * broke on the owner's iPhone. Every check ran in Chromium, and none played
 * the film through: the fidelity frames hold at three marks, pocket-measure
 * at three states, the e2e spec jumps to one chapter. What was wrong was
 * mostly in the playing — rings left where a control WAS before the page
 * scrolled, the film stopping itself at chapter 8, a lane named against a
 * page not yet drawn — and one part was Safari's alone (an unprefixed
 * `backdrop-filter`, so the pill and every callout were see-through).
 *
 * So this spec plays the whole film, in WebKit, at two phone widths, and
 * looks at every held mark. It runs as the `pocket-webkit` project
 * (web/playwright.config.js): `pnpm --filter orbit-web fidelity:webkit`,
 * which CI's `fidelity` job runs after the Chromium projects, in Playwright's
 * own image, where WebKit is installed. On a host without WebKit's system
 * libraries run it inside that image:
 *
 *   docker run --rm --network=host -v "$PWD:$PWD:ro" -w "$PWD/web" \
 *     -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright -e FIDELITY_APP=http://127.0.0.1:4173 \
 *     mcr.microsoft.com/playwright:v1.63.0-noble \
 *     node node_modules/@playwright/test/cli.js test --project=pocket-webkit
 *
 * against an app already serving the fixture build (`reuseExistingServer`).
 * Read-only mount, deliberately: a package manager run inside the image
 * rewrites the host's node_modules (environment skill, 2026-08-24).
 *
 * Two passes, both under reduced motion so the whole thing fits a CI job
 * (the phone's film is 1:42 reduced against 2:55; the timings only normal
 * motion can catch are the clash sampler's, tour-pocket-clash.spec.js). Each
 * pass measured ~2.7 minutes on a quiet host and ~4 under load, so the
 * budget is 7: a stalled film here should fail on what it did, not on the
 * clock.
 *
 *  1. 390x844, played end to end from the film's own start with nothing
 *     jumped, sampled every 250ms: the pill never sits on a sheet, the save
 *     bar, a callout or the top chrome's controls (the chrome under a raised
 *     sheet's scrim is inert and the pill docks over it by the owner's 1a,
 *     so that one is not counted while a sheet is up); no callout leaves the
 *     screen; every callout points at something — its anchor (the box the
 *     film stamps on it) is a real, on-screen element and its stem lands on
 *     that box, the design's own `dy` allowed — and covers no bright text
 *     but its anchor's (text under the veil is dimmed by design; text in a
 *     hole, or with the veil down, is being read); every ring on the screen
 *     is drawn round a real element's own box — a ring that matches nothing
 *     under it is a spotlight in the wrong place, which is what the owner
 *     saw; and the film reaches its own end
 *     with all twelve chapters seen in order and no error in the console — a
 *     film that stops itself (`Tour film stopped:`) is the failure chapter 8
 *     had.
 *
 *  2. 360x780, every mark held in turn (the review hooks the fidelity
 *     frames use): each is reached, and the same rules hold at each.
 */

/** Every mark the pocket cut fires, chapter by chapter (chapters/*.js;
 *  `add-yearly` is desk-only, #1083 §6). */
const MARKS = [
  ["arrive", ["arrive-chart", "arrive-gran"]],
  ["add", ["add-star", "add-drawer", "add-typing", "add-add"]],
  ["lands", ["lands-body"]],
  ["manifest", ["manifest-scrolled", "manifest-today"]],
  ["time", ["time-warmed", "time-toast"]],
  ["relay", ["relay-addr"]],
  ["inbox", ["inbox-orb", "inbox-lane-review", "inbox-lane-reading", "inbox-lane-filed", "inbox-lanes", "inbox-add", "inbox-sayso"]],
  /* #1319: "The item" replaced "The belt" (design/v19/tour-drawer/round-2).
     Keep this list to the marks the chapter sets: a mark it never sets
     costs a full 45s `never reached` wait. */
  ["item", ["item-row", "item-docs", "item-bring", "item-read", "item-acts", "item-editing", "item-edit", "item-calendar"]],
  ["done", ["done-complete", "done-swung", "done-round"]],
  ["others", ["others-gran", "others-ask"]],
  ["sky", ["sky-orb", "sky-settings", "sky-swatches", "sky-dawn", "sky-back"]],
  ["yours", ["yours-year", "yours-year-line", "yours-close"]],
];

/** What the pill, the callouts and the last ring are doing right now, read
 *  from inside the page. Null until the film has put its pill up. */
function sample() {
  const pill = document.getElementById("orbit-tour-transport");
  if (!pill) return null;
  const pillBox = pill.getBoundingClientRect();
  if (pillBox.width === 0 && pillBox.height === 0) return null;
  /** @param {DOMRect} a @param {DOMRect} b */
  const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  /** @type {string[]} */
  const faults = [];
  /* The chrome is not counted while a sheet is up (inert under the scrim)
     nor while the pill is still docked `.top` — it leaves the dock 350ms
     after the sheet's fold, the owner's own fix 1 on round 8. */
  const sheetUp = Boolean(document.querySelector(".p-sheet-layer.open")) || pill.classList.contains("top");
  const others = [
    { label: "a raised sheet's panel", els: [...document.querySelectorAll(".p-sheet-layer.open .p-sheet-panel")] },
    { label: "the save bar", els: [...document.querySelectorAll(".pk-bar")] },
    { label: "a callout", els: [...document.querySelectorAll(".tourfilm-callout")].filter((el) => /** @type {HTMLElement} */ (el).style.opacity !== "0") },
    { label: "the top chrome's own controls",
      els: sheetUp ? [] : [...document.querySelectorAll(".p-chrome:not(.hidden) a, .p-chrome:not(.hidden) button")] },
  ];
  for (const group of others) {
    for (const el of group.els) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (intersects(pillBox, box)) faults.push(`pill on ${group.label}`);
    }
  }
  const chrome = document.querySelector(".p-chrome:not(.hidden)");
  const chromeBox = chrome ? chrome.getBoundingClientRect() : null;

  /* The veil's holes, read from its own mask (veil.js, an inline SVG since
     #1174 round 3): text inside one is bright. A hole still closing is
     not counted; one opening is, as soon as it is half open. */
  const veil = document.getElementById("orbit-tour-veil");
  const veilUp = veil !== null && parseFloat(getComputedStyle(veil).opacity) > 0.05;
  /** @type {{ x: number, y: number, w: number, h: number }[]} */
  const holes = [];
  if (veilUp && veil) {
    for (const shape of veil.querySelectorAll("mask .hole:not(.leaving)")) {
      if (parseFloat(getComputedStyle(shape).fillOpacity) < 0.5) continue;
      const n = (/** @type {string} */ name) => Number(shape.getAttribute(name));
      if (shape.tagName.toLowerCase() === "circle") holes.push({ x: n("cx") - n("r"), y: n("cy") - n("r"), w: 2 * n("r"), h: 2 * n("r") });
      else holes.push({ x: n("x"), y: n("y"), w: n("width"), h: n("height") });
    }
  }
  /** @param {DOMRect} r */
  const bright = (r) => !veilUp || holes.some((h) => r.left < h.x + h.w && r.right > h.x && r.top < h.y + h.h && r.bottom > h.y);

  /** Every readable text box on the page that is not the film's own. */
  /** @type {{ rect: DOMRect, node: Text }[]} */
  const texts = [];
  /* Only worth reading while a callout is up — and reading it is the
     heaviest thing this sample does, which on a busy host starves the
     page's own frames (#1174 round 3). */
  const calloutUp = [.../** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(".tourfilm-callout"))].some((el) => el.style.opacity !== "0");
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = calloutUp ? walker.nextNode() : null; node; node = walker.nextNode()) {
    const text = /** @type {Text} */ (node);
    if (!text.data.trim()) continue;
    const parent = /** @type {HTMLElement | null} */ (text.parentElement);
    if (parent === null) continue;
    if (parent.closest("#orbit-tour-film, #orbit-tour-veil, #orbit-tour-transport, script, style")) continue;
    const cs = getComputedStyle(parent);
    if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) < 0.05) continue;
    /* visually-hidden text (the kit's sr-only, the count beads' words) is
       a 1px box whose text still measures at its laid-out width */
    const pb = parent.getBoundingClientRect();
    if (pb.width < 2 || pb.height < 2) continue;
    const range = document.createRange();
    range.selectNodeContents(text);
    for (const rect of range.getClientRects()) {
      if (rect.width < 2 || rect.height < 2) continue;
      texts.push({ rect, node: text });
    }
  }

  for (const el of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(".tourfilm-callout"))) {
    const box = el.getBoundingClientRect();
    if (el.style.opacity === "0") continue; /* leaving */
    const said = (el.textContent ?? "").slice(0, 28);
    if (box.left < -0.5 || box.top < -0.5 || box.right > window.innerWidth + 0.5 || box.bottom > window.innerHeight + 0.5) {
      faults.push(`callout past the screen (${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)})`);
    }
    if (chromeBox && chromeBox.height > 0 && intersects(box, chromeBox)) faults.push("callout under the top chrome");

    /* What it points at. */
    const anchor = el.dataset.tourfilmAnchor ?? "";
    const side = el.dataset.tourfilmSide ?? "";
    const dy = Math.abs(Number(el.dataset.tourfilmDy ?? 0));
    /** @type {DOMRect | null} */
    let target = null;
    if (anchor === "none") {
      faults.push(`callout pointing at nothing: "${said}"`);
    } else if (anchor !== "point" && anchor) {
      const [x, y, w, h] = anchor.split(",").map(Number);
      target = new DOMRect(x, y, w, h);
      if (w < 1 || h < 1) faults.push(`callout on a 0x0 anchor: "${said}"`);
      else if (target.right <= 0 || target.bottom <= 0 || target.left >= window.innerWidth || target.top >= window.innerHeight) {
        faults.push(`callout whose anchor is off the screen: "${said}" (anchor at ${Math.round(x)},${Math.round(y)}, page scrolled ${Math.round(window.scrollY)}px)`);
      } else {
        /* The stem's tip: the 14px square sits 8px past the box's edge,
           rotated, so its tip is ~7px beyond the box on the named side. */
        const stem = el.querySelector("i");
        const sb = stem ? stem.getBoundingClientRect() : box;
        const tip = side === "top" ? [(sb.left + sb.right) / 2, sb.bottom]
          : side === "bottom" ? [(sb.left + sb.right) / 2, sb.top]
            : side === "left" ? [sb.right, (sb.top + sb.bottom) / 2]
              : [sb.left, (sb.top + sb.bottom) / 2];
        const slackX = 10 + (side === "left" || side === "right" ? dy : 0);
        const slackY = 10 + (side === "top" || side === "bottom" ? dy : 0);
        const onTarget = tip[0] >= target.left - slackX && tip[0] <= target.right + slackX
          && tip[1] >= target.top - slackY && tip[1] <= target.bottom + slackY;
        if (!onTarget) faults.push(`callout's stem misses its anchor: "${said}"`);
      }
    }

    /* Bright text it covers, other than its anchor's own — and other than
       the lit surface its anchor stands in: a hole that contains the anchor
       (the item card round its complete button, the hatch's panel round
       its settings row) is the film's own picture of "this control, here",
       and a line inside it has nowhere else to sit. */
    /** @param {DOMRect} r @param {{ x: number, y: number, w: number, h: number }} h */
    const within = (r, h) => r.left >= h.x - 1 && r.right <= h.x + h.w + 1 && r.top >= h.y - 1 && r.bottom <= h.y + h.h + 1;
    const surface = target ? holes.filter((h) => within(target, h) && (h.w > target.width + 2 || h.h > target.height + 2)) : [];
    for (const { rect, node } of texts) {
      if (!intersects(box, rect) || !bright(rect)) continue;
      if (target && within(rect, { x: target.left, y: target.top, w: target.width, h: target.height })) continue;
      if (surface.some((h) => within(rect, h))) continue;
      faults.push(`callout "${said}" covers the text "${node.data.trim().slice(0, 24)}"`);
      break;
    }
  }
  /* Every ring must be the outline of something real: the film's own
     account (`__lit`, vocabulary.js's litBoxes) gives each ring beside the
     box of the element it was drawn round as it measures NOW — the two must
     agree to a pixel, the element must still be in the document and shown,
     and no ring may be up that the film does not account for (one left
     behind by a screen change). The rings' own frame after a scroll is
     allowed for by the caller (two samples running). */
  const rings = [.../** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("#orbit-tour-film .tourfilm-ring"))]
    .filter((r) => r.style.opacity !== "0");
  /** @type {{ ring: {x:number,y:number,w:number,h:number}, target: {x:number,y:number,w:number,h:number}, connected: boolean, shown: boolean, sel: string }[]} */
  const lit = /** @type {any} */ (window).__lit?.() ?? [];
  if (rings.length > lit.length) faults.push(`${rings.length - lit.length} ring(s) the film does not account for`);
  for (const one of lit) {
    const where = `${one.sel} at ${Math.round(one.ring.x)},${Math.round(one.ring.y)} ${Math.round(one.ring.w)}x${Math.round(one.ring.h)}`;
    if (!one.connected) { faults.push(`a ring round an element no longer in the document: ${where}`); continue; }
    if (one.ring.w < 1 || one.ring.h < 1 || one.target.w < 1 || one.target.h < 1) { faults.push(`a ring round nothing (0x0): ${where}`); continue; }
    const off = one.ring.x + one.ring.w <= 0 || one.ring.y + one.ring.h <= 0 || one.ring.x >= window.innerWidth || one.ring.y >= window.innerHeight;
    if (off) continue; /* a control the page has scrolled away is not on the screen to mislead */
    if (!one.shown) faults.push(`a ring round something a reader cannot see: ${where}`);
    const drift = Math.max(Math.abs(one.ring.x - one.target.x), Math.abs(one.ring.y - one.target.y),
      Math.abs(one.ring.w - one.target.w), Math.abs(one.ring.h - one.target.h));
    /* The ring growing out of the dot (vocabulary.js's growInto, 200ms) is
       the design's own motion, not a ring in the wrong place: a ring with
       that animation still running is in transit. */
    const el = rings.find((r) => { const b = r.getBoundingClientRect(); return Math.abs(b.left - one.ring.x) < 0.5 && Math.abs(b.top - one.ring.y) < 0.5; });
    if (el && el.getAnimations().some((a) => !(a instanceof CSSTransition) && a.playState === "running")) continue;
    /* Likewise the control pressing itself (vocabulary.js's press, 240ms):
       the ring follows it frame by frame, and a starved browser's frame
       can be a tenth of a second late. */
    if ([...document.querySelectorAll(one.sel)].some((t) => t.getAnimations().some((a) => !(a instanceof CSSTransition) && a.playState === "running"))) continue;
    /* 2px is the lift: the control rises 2px inside its ring (applyLift). */
    if (drift > 2.5) faults.push(`a ring ${Math.round(drift)}px off its element: ${where}`);
  }
  const reading = /** @type {any} */ (window).__reading?.();
  return {
    faults,
    chapter: reading?.chapter ?? -1,
    ended: Boolean(reading && reading.total > 0 && reading.cursor >= reading.total),
    pill: pill.className,
    url: location.pathname,
  };
}

/** The veil's open holes, wherever the veil keeps them — an inline mask's
 *  shapes (#1174 round 3) or a data-URI mask's (before it) — so the check
 *  below reads either. Inset from each hole's rounded edge, and on the
 *  screen. */
function openHoles() {
  const veil = document.getElementById("orbit-tour-veil");
  if (!veil || parseFloat(getComputedStyle(veil).opacity) < 0.3) return [];
  /** @type {{ x: number, y: number, w: number, h: number, inset: number }[]} */
  const out = [];
  const shapes = veil.querySelectorAll("mask .hole:not(.leaving)");
  for (const shape of shapes) {
    const n = (/** @type {string} */ name) => Number(shape.getAttribute(name));
    if (shape.tagName.toLowerCase() === "circle") out.push({ x: n("cx") - n("r"), y: n("cy") - n("r"), w: 2 * n("r"), h: 2 * n("r"), inset: n("r") * 0.3 });
    else out.push({ x: n("x"), y: n("y"), w: n("width"), h: n("height"), inset: Math.max(4, n("rx")) });
  }
  if (!shapes.length) {
    const m = /url\("data:image\/svg\+xml,(.*)"\)/u.exec(veil.style.webkitMaskImage || veil.style.maskImage || "");
    const svg = m ? decodeURIComponent(m[1]) : "";
    for (const r of svg.matchAll(/<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)" rx="([\d.]+)"/gu)) {
      out.push({ x: +r[1], y: +r[2], w: +r[3], h: +r[4], inset: Math.max(4, +r[5]) });
    }
    for (const c of svg.matchAll(/<circle cx="([\d.-]+)" cy="([\d.-]+)" r="([\d.]+)"/gu)) {
      out.push({ x: +c[1] - +c[3], y: +c[2] - +c[3], w: 2 * +c[3], h: 2 * +c[3], inset: +c[3] * 0.3 });
    }
  }
  return out.map((h) => {
    const x = Math.max(0, h.x + h.inset), y = Math.max(0, h.y + h.inset);
    const right = Math.min(window.innerWidth, h.x + h.w - h.inset), bottom = Math.min(window.innerHeight, h.y + h.h - h.inset);
    return { x, y, width: right - x, height: bottom - y };
  }).filter((c) => c.width >= 12 && c.height >= 12);
}

/**
 * What a hole shows, as really painted: the spread between the darkest and
 * brightest pixels of a screenshot of it (2nd to 98th percentile of grey).
 * The veil over anything squeezes that spread to about 38%, on a dark pack
 * or a light one; a hole leaves it as it is.
 * @param {import("@playwright/test").Page} page
 * @param {{ x: number, y: number, width: number, height: number }} clip
 */
async function spreadOf(page, clip) {
  const png = await page.screenshot({ clip, caret: "hide" });
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const cx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
    cx.drawImage(img, 0, 0);
    const { data: px } = cx.getImageData(0, 0, canvas.width, canvas.height);
    /** @type {number[]} */
    const greys = [];
    for (let i = 0; i < px.length; i += 4) greys.push(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]);
    greys.sort((a, b) => a - b);
    return greys[Math.floor(greys.length * 0.98)] - greys[Math.floor(greys.length * 0.02)];
  }, png.toString("base64"));
}

/** @param {import("@playwright/test").Page} page */
async function openFilm(page) {
  /** @type {string[]} */
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/settings/tour", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"tour":{"tourSeenAt":null}}' }));
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await page.waitForFunction(() => Array.isArray(/** @type {any} */ (window).__chapters), null, { timeout: 30_000 });
  return errors;
}

/* ---- round 3 (#1174, the owner's iPhone, 2026-10-01) -------------------
   The first round's passes were green and the owner's phone still showed
   the film stuck at 0:37 on /create, the screen flickering as the film
   selected things, and the pill too faint to see or lost under the veil —
   and the owner ruled the play bar is always in front (7a). The same play
   now answers three more questions, normal motion, as a phone plays it:

   - does the clock keep moving, even when the reader touches the page?
     (`sampleTransport`: the film's cursor every sample — one that stands
     still longer than the film's longest honest stall is a stuck film,
     whether or not it ever says so; and one tap on /create's "suggestion"
     chip while the film walks that form, which is what the owner's phone
     showed chosen);
   - is the pill in front, and can it be read? (a hit test at every
     control and edge — anything else answering is painted over it; its
     effective opacity — faint is dimmed; and `pillContrast`, the readout
     as really painted, decoded in the page, so its contrast against
     whatever is behind it is measured, not assumed);
   - does anything flash? (`installFrameWatch`: a veil hole or a ring
     that goes from nothing to full, or full to nothing, with no fade
     between is a bright patch snapping on or off over a dimmed screen —
     a flicker on a phone, whether or not anything else moved). */

/** m:ss, as the pill prints it (transport.js's mmss). @param {number} ms */
const mmssOf = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** The transport and the clock, read from inside the page. */
function sampleTransport() {
  const pill = document.getElementById("orbit-tour-transport");
  const reading = /** @type {any} */ (window).__reading?.();
  if (!pill || !reading) return null;
  const box = pill.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return null;
  /** @type {string[]} */
  const faults = [];
  /* Effective opacity: its own and every ancestor's. */
  let opacity = 1;
  for (let node = /** @type {Element | null} */ (pill); node; node = node.parentElement) {
    const cs = getComputedStyle(node);
    opacity *= parseFloat(cs.opacity);
    if (cs.visibility === "hidden" || cs.display === "none") faults.push("pill hidden");
  }
  const state = `${pill.className || "home"}`;
  /* A pill fading between its places (transport.js's moveDock: out at the
     old place, in at the new) is moving, not faint — unless it stays that
     way, which the caller times. */
  const moving = pill.style.opacity === "0"
    || pill.getAnimations().some((a) => a instanceof CSSTransition && a.transitionProperty === "opacity" && a.playState === "running");
  if (opacity < 0.95) faults.push(`pill ${moving ? "moving between places" : "faint"} (opacity ${opacity.toFixed(2)}, ${state})`);
  /* In front: whatever answers a hit test on the pill must be the pill. */
  /** @type {[number, number, string][]} */
  const points = [];
  for (const sel of [".pp", ".skp", ".track", ".now", ".clock"]) {
    const el = pill.querySelector(sel);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) points.push([r.left + r.width / 2, r.top + r.height / 2, sel]);
  }
  /* The midpoint of each edge, 4px in — never a corner, which is rounded
     18px and so outside the pill's own shape. */
  const cx = (box.left + box.right) / 2, cy = (box.top + box.bottom) / 2;
  points.push([cx, box.top + 4, "top edge"], [cx, box.bottom - 4, "bottom edge"],
    [box.left + 4, cy, "left edge"], [box.right - 4, cy, "right edge"]);
  for (const [x, y, where] of points) {
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
    const hit = document.elementFromPoint(x, y);
    if (hit && !pill.contains(hit)) {
      const tag = `${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ""}${hit.className && typeof hit.className === "string" ? `.${hit.className.split(" ")[0]}` : ""}`;
      faults.push(`${tag} painted over the pill at its ${where}`);
    }
  }
  const clock = pill.querySelector(".clock")?.getBoundingClientRect();
  return {
    faults,
    cursor: reading.cursor,
    total: reading.total,
    chapter: reading.chapter,
    ended: reading.total > 0 && reading.cursor >= reading.total,
    url: location.pathname,
    readout: clock ? { x: clock.left, y: clock.top, w: clock.width, h: clock.height } : null,
    flicker: /** @type {any} */ (window).__flicker?.splice(0) ?? [],
  };
}

/** Watches the veil's holes and the film's rings as the film changes them,
 *  from inside the page — on the DOM's own record of each change, never on
 *  sampled frames, so a busy browser painting one frame in five cannot hide
 *  a snap or invent one. A hole is a snap if it arrives already open or
 *  leaves while still open (veil.js marks a closing hole `.leaving` and
 *  fades it); a data-URI mask (the veil before round 3) has no fade at all,
 *  so any change in its hole count with the veil up is a snap. A ring is a
 *  snap if it leaves in the same breath it began to fade (under 50ms: the
 *  observer hears of a change only at the end of the task that made it, so
 *  a fade's start is heard late and a snap's removal arrives with it),
 *  unless the screen has just changed under it (a ring goes with its
 *  element, then). */
function installFrameWatch() {
  const w = /** @type {any} */ (window);
  if (w.__frameWatch) return;
  w.__frameWatch = true;
  w.__flicker = [];
  const veilUp = () => {
    const veil = document.getElementById("orbit-tour-veil");
    return Boolean(veil && parseFloat(getComputedStyle(veil).opacity) > 0.3);
  };
  /** @param {HTMLElement} veil */
  const uriHoles = (veil) => {
    const m = /url\("data:image\/svg\+xml,(.*)"\)/u.exec(veil.style.webkitMaskImage || veil.style.maskImage || "");
    return m ? (decodeURIComponent(m[1]).match(/fill="#000"/gu) ?? []).length : 0;
  };
  let lastUri = 0;
  let url = location.pathname;
  let urlChangedAt = -Infinity;
  /** @type {WeakMap<Element, number>} when each ring began to fade */
  const fadingSince = new WeakMap();
  new MutationObserver((records) => {
    const now = performance.now();
    if (location.pathname !== url) { url = location.pathname; urlChangedAt = now; }
    for (const record of records) {
      const t = /** @type {HTMLElement} */ (record.target);
      if (record.type === "attributes") {
        if (t.id === "orbit-tour-veil") {
          const n = uriHoles(t);
          if (n !== lastUri && veilUp()) w.__flicker.push(`a veil hole ${n > lastUri ? "cut" : "closed"} with no fade (${lastUri} → ${n} holes)`);
          lastUri = n;
        } else if (t.classList?.contains("tourfilm-ring") && t.style.opacity === "0" && !fadingSince.has(t)) {
          fadingSince.set(t, now);
        }
        continue;
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof Element) || !node.classList.contains("hole") || !veilUp()) continue;
        const open = parseFloat(getComputedStyle(node).fillOpacity);
        if (open >= 0.6) w.__flicker.push(`a veil hole cut already open (${open.toFixed(2)})`);
      }
      for (const node of record.removedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.classList.contains("hole") && !node.classList.contains("leaving") && veilUp()) {
          w.__flicker.push("a veil hole closed while still open");
        }
        if (node.classList.contains("tourfilm-ring") && now - urlChangedAt > 2000) {
          const since = fadingSince.get(node);
          if (since === undefined || now - since < 50) w.__flicker.push(`a ring put out ${since === undefined ? "while showing" : `${Math.round(now - since)}ms into its fade`}`);
        }
      }
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class"] });
}

/**
 * The pill's readout as it is really painted: a screenshot of its box,
 * decoded in the page through a canvas, and the contrast between its
 * brightest and darkest pixels (the 2nd and 98th percentile of relative
 * luminance, so a stray pixel decides nothing). Text and its ground are the
 * two populations in that box; a pill at 38% over a dark page has neither.
 * @param {import("@playwright/test").Page} page
 * @param {{ x: number, y: number, w: number, h: number }} box
 */
async function pillContrast(page, box) {
  const clip = { x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.max(1, box.w), height: Math.max(1, box.h) };
  const png = await page.screenshot({ clip, animations: "allow", caret: "hide" });
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const cx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
    cx.drawImage(img, 0, 0);
    const { data: px } = cx.getImageData(0, 0, canvas.width, canvas.height);
    /** @type {number[]} */
    const lums = [];
    const lin = (/** @type {number} */ c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    for (let i = 0; i < px.length; i += 4) lums.push(0.2126 * lin(px[i]) + 0.7152 * lin(px[i + 1]) + 0.0722 * lin(px[i + 2]));
    lums.sort((a, b) => a - b);
    const lo = lums[Math.floor(lums.length * 0.02)];
    const hi = lums[Math.floor(lums.length * 0.98)];
    return (hi + 0.05) / (lo + 0.05);
  }, png.toString("base64"));
}

/** The film's own record of each wait for the page that ran out (#1174
 *  round 6, vocabulary.js `waitForReal`), as "selector on route". */
function waitsRunOut() {
  const list = /** @type {any} */ (window).__waitedOut?.() ?? [];
  return list.map((/** @type {{ selector: string, route: string, ms: number }} */ one) => `${one.selector} on ${one.route}, ${one.ms / 1000}s`);
}

/** The three phones (#1174): the owner's (430x932), the common size, and
 *  the narrowest. The owner's plays the whole film; the other two play
 *  from the start through chapter 3's arrival home — the hatch, the veil,
 *  the walk to /create, the reader's tap, the form and the walk back,
 *  where the owner's film stuck — which is every place the pill docks and
 *  every kind of beat, at a third of the time. */
const PHONES = [
  { width: 430, height: 932, through: "yours" },
  { width: 390, height: 844, through: "lands" },
  { width: 360, height: 780, through: "lands" },
];

test.describe("the pocket film in WebKit (#1174)", () => {
  test.use({ reducedMotion: "reduce" });

  for (const phone of PHONES) {
    test(`plays ${phone.through === "yours" ? "end to end" : "through chapter 3"} at ${phone.width}x${phone.height} under normal motion: the clock keeps moving through a reader's tap, the pill stays in front and readable, nothing flashes, and every mark is where it belongs`, async ({ browser }) => {
      test.setTimeout(phone.through === "yours" ? 540_000 : 240_000);
      const size = { width: phone.width, height: phone.height };
      const context = await browser.newContext({
        viewport: size, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
        reducedMotion: "no-preference",
      });
      const page = await context.newPage();
      const errors = await openFilm(page);
      await page.evaluate(installFrameWatch);
      await page.evaluate(() => { const w = /** @type {any} */ (window); w.__frames = 0; const count = () => { w.__frames++; requestAnimationFrame(count); }; requestAnimationFrame(count); });
      const chapterIds = await page.evaluate(() => /** @type {any} */ (window).__chapters.map((/** @type {any} */ c) => c.id));
      const last = chapterIds.indexOf(phone.through);

      /** @type {Record<string, number>} */
      const faults = {};
      /** @type {string[]} */
      const flicker = [];
      /** @type {{ at: string, ratio: number, url: string }[]} */
      const contrast = [];
      /** @type {number[]} */
      const chapters = [];
      /** The film's longest honest stall: `waitForReal`'s own 12s bound
       *  (vocabulary.js), plus the sheet's close and a navigation. */
      const STALL_BUDGET_MS = 15_000;
      let lastCursor = -1;
      let lastMoved = Date.now();
      /** @type {string | null} */
      let stuck = null;
      /** A fault seen on two samples running is on the screen long enough
       *  to be read (the chrome re-measures a frame after the page moves, a
       *  callout fades over 180ms). The pill's own move between places is a
       *  fade through nothing over 350ms (owner's call, round 8), so a pill
       *  fault counts once it has lasted a second's worth of painted frames
       *  — a pill at 38% or 16% is faint for whole chapters. Counted in the
       *  page's own frames (`__frames`), not wall time (#1184): at 6 frames
       *  a second a 350ms fade outlasts a wall-clock second.
       *  @type {Map<string, { run: number, sinceFrame: number }>} */
      let streak = new Map();
      /* 1000ms and 3000ms at 60 frames a second; they do not stretch on a slow host. */
      const PILL_FAULT_FRAMES = 60;
      /** A move between places is 350ms; one still under way after three
       *  seconds' worth of frames is a pill that never arrived. */
      const PILL_MOVE_FRAMES = 180;
      let tapped = false;
      let tapTook = false;
      let done = false;
      let samples = 0;
      const started = Date.now();
      while (!done && Date.now() - started < (phone.through === "yours" ? 480_000 : 200_000)) {
        const [s, first, frame] = await Promise.all([page.evaluate(sampleTransport), page.evaluate(sample),
          page.evaluate(() => /** @type {number} */ (/** @type {any} */ (window).__frames))]);
        /* A ring off its element is looked at again two painted frames on:
           the chrome re-measures once a frame, and a busy host paints few
           of them — a ring that is back on its element by then was a frame
           in transit, one still off is in the wrong place. */
        let m = first;
        if (first?.faults.some((f) => f.startsWith("a ring ") && f.includes("px off its element"))) {
          await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(undefined)))));
          const again = await page.evaluate(sample);
          if (again) m = { ...first, faults: [...first.faults.filter((f) => !f.includes("px off its element")), ...again.faults.filter((f) => f.includes("px off its element"))] };
        }
        if (s) {
          samples++;
          if (s.cursor !== lastCursor) { lastCursor = s.cursor; lastMoved = Date.now(); }
          else if (!s.ended && Date.now() - lastMoved > STALL_BUDGET_MS) {
            stuck = `the clock stood at ${mmssOf(s.cursor)} of ${mmssOf(s.total)} for ${Math.round((Date.now() - lastMoved) / 1000)}s on ${s.url}, chapter ${s.chapter + 1}`;
            break;
          }
          const now = new Map();
          /* #1190: once the film has ended, the pill holds then fades out
             and is gone — that is the ruling now, not a fault to sample. */
          const seen = [...(s.ended ? [] : s.faults.map((f) => ({ f, pill: true, need: 0 }))), ...(m?.faults ?? []).map((f) => ({ f, pill: false, need: f.startsWith("callout pointing at nothing") ? 1 : 2 }))];
          for (const { f, pill, need } of seen) {
            /* the pill's faults are keyed without their opacity figure, so
               a fade in progress is one fault lasting, not several */
            const key = `${pill ? f.replace(/\(opacity [\d.]+, /u, "(") : f} · ${s.url} · ch${s.chapter + 1}`;
            const was = streak.get(key);
            const run = { run: (was?.run ?? 0) + 1, sinceFrame: was?.sinceFrame ?? frame };
            now.set(key, run);
            const limit = f.startsWith("pill moving") ? PILL_MOVE_FRAMES : PILL_FAULT_FRAMES;
            if (pill ? frame - run.sinceFrame >= limit : run.run >= need) faults[key] = (faults[key] ?? 0) + 1;
          }
          streak = now;
          for (const one of s.flicker) flicker.push(`${one} · ${s.url} · ch${s.chapter + 1}`);
          if (chapters.at(-1) !== s.chapter) chapters.push(s.chapter);
          /* The readout's contrast every eighth sample: often enough to see
             the pill at every place it docks and on both packs (chapter 11
             wears Dawn). */
          if (s.readout && samples % 8 === 0) {
            /* Measured only on a pill at full strength (a faint or moving
               one is the fault above), and once more 400ms on if it reads
               low: a move between places can begin between the sample and
               the shot. */
            const weak = (/** @type {{ faults: string[] }} */ t) => t.faults.some((f) => f.startsWith("pill faint") || f.startsWith("pill moving"));
            let ratio = weak(s) ? null : await pillContrast(page, s.readout);
            if (ratio !== null && ratio < 4.5) {
              await page.waitForTimeout(400);
              const again = await page.evaluate(sampleTransport);
              ratio = again?.readout && !weak(again) ? await pillContrast(page, again.readout) : null;
            }
            if (ratio !== null) contrast.push({ at: mmssOf(s.cursor), ratio, url: s.url });
          }
          /* The reader's own touch: the owner's phone showed the suggestion
             chip chosen with the film stuck. A tap on the form while the
             film is walking it must land on the film, not the form. */
          if (!tapped && chapterIds[s.chapter] === "add" && s.url === "/create") {
            const chip = page.locator("#pocket-entry .pc-kinds .pc-chip", { hasText: "suggestion" });
            if (await chip.count()) {
              tapped = true;
              await chip.tap({ force: true });
              await page.waitForTimeout(100);
              tapTook = await chip.evaluate((el) => el.getAttribute("aria-pressed") === "true");
            }
          }
          done = s.ended || s.chapter > last;
        }
        await page.waitForTimeout(250);
      }
      const frames = await page.evaluate(() => /** @type {any} */ (window).__frames);
      console.log(`${phone.width}x${phone.height}: ${samples} samples, the page painted ${(frames / ((Date.now() - started) / 1000)).toFixed(1)} frames a second`);
      const waitedOut = await page.evaluate(waitsRunOut);
      await context.close();

      const unreadable = contrast.filter((one) => one.ratio < 4.5).map((one) => `${one.ratio.toFixed(1)}:1 at ${one.at} on ${one.url}`);
      const expected = chapterIds.map((/** @type {string} */ _, /** @type {number} */ k) => k).filter((/** @type {number} */ k) => k <= last + (phone.through === "yours" ? 0 : 1));
      expect.soft(errors, "no error in the console — a film that stopped itself says so there").toEqual([]);
      expect.soft(stuck, "the clock keeps moving — a film that stops advancing is stuck").toBeNull();
      expect.soft(waitedOut, "no wait for the page ran out — the clock stood still for something that never came").toEqual([]);
      expect.soft(done, "the film plays as far as this phone watches it").toBe(true);
      expect.soft(chapters, "every chapter, in order, none skipped").toEqual(expected);
      expect.soft(tapped, "the reader's tap on the form was made").toBe(true);
      expect.soft(tapTook, "the reader's tap on the form landed on the film, not the form").toBe(false);
      expect.soft(faults, "the pill in front and never faint; the callouts and rings where the design puts them").toEqual({});
      expect.soft(unreadable, "the pill's readout reads at 4.5:1 or better wherever it stands, on either pack").toEqual([]);
      expect.soft(flicker, "no hole or ring snaps on or off between one frame and the next").toEqual([]);
    });
  }

  test("reaches every mark at 360x780, each drawn on the screen and what it lights lit", async ({ page }) => {
    test.setTimeout(420_000);
    await page.setViewportSize({ width: 360, height: 780 });
    const errors = await openFilm(page);
    /** @type {string[]} */
    const wrong = [];

    for (const [chapter, marks] of MARKS) {
      const index = MARKS.findIndex(([id]) => id === chapter);
      for (const mark of marks) {
        await page.evaluate((m) => {
          const hooks = /** @type {any} */ (window);
          hooks.__held = null;
          hooks.__hold = m;
        }, mark);
        if (mark === marks[0]) await page.evaluate((k) => /** @type {any} */ (window).__jump(k), index);
        else await page.evaluate(() => /** @type {any} */ (window).__play());
        try {
          await page.waitForFunction((m) => /** @type {any} */ (window).__held === m, mark, { timeout: 45_000 });
        } catch {
          wrong.push(`${mark}: never reached`);
          continue;
        }
        /* the callout's own slide-in, and a frame for the sync loop */
        await page.waitForTimeout(350);
        const s = await page.evaluate(sample);
        if (!s) { wrong.push(`${mark}: no transport`); continue; }
        for (const fault of s.faults) wrong.push(`${mark}: ${fault}`);
        /* #1174 round 3: what the film lights is lit. The first open hole
           photographed with the veil up and with it hidden: a hole that
           really is one shows the same either way; the veil's data-URI
           mask cut nothing (an image mask works on alpha, and its black
           holes were opaque), so every lit control sat dimmed like the
           rest of the page. Holes with nothing in them prove nothing and
           are skipped. */
        const [hole] = await page.evaluate(openHoles);
        if (hole) {
          const lit = await spreadOf(page, hole);
          await page.evaluate(() => { /** @type {HTMLElement} */ (document.getElementById("orbit-tour-veil")).style.visibility = "hidden"; });
          const bare = await spreadOf(page, hole);
          await page.evaluate(() => { /** @type {HTMLElement} */ (document.getElementById("orbit-tour-veil")).style.visibility = ""; });
          if (bare >= 24 && lit < bare * 0.85) {
            wrong.push(`${mark}: a lit control dimmed under the veil (${Math.round(lit)} of its ${Math.round(bare)} grey levels showing, at ${Math.round(hole.x)},${Math.round(hole.y)})`);
          }
        }
      }
    }

    expect(errors, "no error in the console").toEqual([]);
    expect(wrong, "every mark reached and drawn on the screen").toEqual([]);
  });
});


/* ---- round 4 (#1174, the owner's iPhone, 2026-10-01) -------------------
   Chapter 4 ("Below the dial") did not take the page down to the manifest
   on the owner's phone. Nothing above asked where the manifest ended up:
   the played film only looks at a callout's anchor, and the manifest's
   header was on the screen all along, just low on it. The pocket home is
   barely taller than a phone, so the scroll stopped at the page's own end
   (149px at 430x932) and the header stayed 37-47% of the way down. So at
   each phone, under normal motion, the film plays from its own start, as
   the owner's did, to chapter 4's line: the page has scrolled, the
   manifest's header and its first row are both on the screen and clear of
   the pill, and the header has been brought up into the top third of the
   screen. Chapter 5 then opens on the page at its top, with nothing of the
   film's left below it. (The chapter's second line, which pointed at the
   first row, was the owner's cut, 2026-10-01; the row is still checked, at
   the one line left.) */
test.describe("chapter 4 takes the page down to the manifest (#1174 round 4)", () => {
  for (const phone of PHONES) {
    test(`at ${phone.width}x${phone.height} the manifest is on the screen at chapter 4's line`, async ({ browser }) => {
      test.setTimeout(240_000);
      const context = await browser.newContext({
        viewport: { width: phone.width, height: phone.height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
        reducedMotion: "no-preference",
      });
      const page = await context.newPage();
      const errors = await openFilm(page);
      /** @type {string[]} */
      const wrong = [];
      const mark = "manifest-today";
      await page.evaluate((m) => { const hooks = /** @type {any} */ (window); hooks.__held = null; hooks.__hold = m; }, mark);
      let reached = true;
      try {
        await page.waitForFunction((m) => /** @type {any} */ (window).__held === m, mark, { timeout: 150_000 });
      } catch {
        wrong.push(`${mark}: never reached`);
        reached = false;
      }
      if (reached) await page.waitForTimeout(350);
      for (const [what, sel] of reached ? [["the header", ".pocket .pk-below h2.p-caps"], ["the first row", ".pocket .pk-below .p-row"]] : []) {
        const seen = await page.evaluate((s) => {
          const el = document.querySelector(s);
          const pill = document.getElementById("orbit-tour-transport")?.getBoundingClientRect();
          const box = el?.getBoundingClientRect();
          return {
            found: Boolean(el),
            top: box ? Math.round(box.top) : null,
            bottom: box ? Math.round(box.bottom) : null,
            pillTop: pill ? Math.round(pill.top) : null,
            scrollY: Math.round(window.scrollY),
            most: Math.round(document.documentElement.scrollHeight - window.innerHeight),
            vh: window.innerHeight,
          };
        }, sel);
        const where = `page at ${seen.scrollY}px of ${seen.most}, anchor ${seen.top}..${seen.bottom}, pill top ${seen.pillTop}, screen ${seen.vh}`;
        if (!seen.found) wrong.push(`${mark}: ${what}, ${sel}, is not on the page`);
        else if (seen.scrollY < 1) wrong.push(`${mark}: the page never left the top (${where})`);
        else if (seen.top === null || seen.top < 0 || seen.bottom === null || seen.bottom > (seen.pillTop ?? seen.vh)) wrong.push(`${mark}: ${what} is off the screen or under the pill (${where})`);
        else if (what === "the header" && seen.top > seen.vh / 3) wrong.push(`${mark}: the manifest's header is still low on the screen, not brought up to it (${where})`);
      }
      /* and chapter 5 opens on the page as the film found it: at its top,
         with nothing of the film's own left below it */
      await page.evaluate(() => { const hooks = /** @type {any} */ (window); hooks.__held = null; hooks.__hold = "time-warmed"; hooks.__play(); });
      try {
        await page.waitForFunction(() => /** @type {any} */ (window).__held === "time-warmed", null, { timeout: 60_000 });
        const after = await page.evaluate(() => ({ y: Math.round(window.scrollY), room: document.querySelectorAll(".tourfilm-room").length }));
        if (after.y !== 0) wrong.push(`time-warmed: the page left scrolled ${after.y}px after chapter 4`);
        if (after.room !== 0) wrong.push("time-warmed: chapter 4's room below the page left behind");
      } catch {
        wrong.push("time-warmed: never reached");
      }
      await context.close();
      expect(errors, "no error in the console").toEqual([]);
      expect(wrong, "the manifest on the screen at chapter 4's line").toEqual([]);
    });
  }
});

/**
 * How much of two same-sized screenshots differs: the share of pixels whose
 * channels move by more than 40 levels, decoded in the page.
 * @param {import("@playwright/test").Page} page
 * @param {Buffer} a @param {Buffer} b
 */
async function shareDiffering(page, a, b) {
  return page.evaluate(async ([one, two]) => {
    /** @param {string} data */
    const pixels = async (data) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const cx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
      cx.drawImage(img, 0, 0);
      return cx.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const [p, q] = [await pixels(one), await pixels(two)];
    if (p.length !== q.length) return 1;
    let differ = 0;
    for (let i = 0; i < p.length; i += 4) {
      if (Math.abs(p[i] - q[i]) > 40 || Math.abs(p[i + 1] - q[i + 1]) > 40 || Math.abs(p[i + 2] - q[i + 2]) > 40) differ++;
    }
    return differ / (p.length / 4);
  }, [a.toString("base64"), b.toString("base64")]);
}

/**
 * A box photographed once it has stopped changing (#1208): shot after shot,
 * about 100ms apart, until two in a row are the same picture -- the way
 * Playwright's own `toHaveScreenshot` waits for a settled page. A fixed
 * wait guessed how long WebKit takes to paint, and on a loaded CI runner,
 * late in the run, it sometimes had not finished. Bounded: after 20 shots
 * whatever is there is judged, so a page that never settles still fails
 * on what it shows rather than on the clock.
 * @param {import("@playwright/test").Page} page
 * @param {{ x: number, y: number, width: number, height: number }} box
 */
async function settledShot(page, box) {
  const shot = () => page.screenshot({ clip: box, animations: "disabled", caret: "hide" });
  let last = await shot();
  for (let k = 1; k < 20; k++) {
    await page.waitForTimeout(100);
    const next = await shot();
    if (next.equals(last)) return next;
    last = next;
  }
  return last;
}

/**
 * Whether a field's own placeholder can be seen in its box: the box
 * photographed as it is, and again with the placeholder taken off the
 * field. The same picture both times means nothing of it shows.
 * @param {import("@playwright/test").Page} page
 * @param {string} id the field's id
 */
async function placeholderShows(page, id) {
  const found = await page.evaluate((one) => {
    const el = /** @type {HTMLElement} */ (document.getElementById(one));
    const r = el.getBoundingClientRect();
    const x = Math.max(0, r.left + 2), y = Math.max(0, r.top + 2);
    const right = Math.min(window.innerWidth, r.right - 2), bottom = Math.min(window.innerHeight, r.bottom - 2);
    const at = { x: window.scrollX, y: window.scrollY };
    return { at, box: right - x < 8 || bottom - y < 8 ? null : { x, y, width: right - x, height: bottom - y } };
  }, id);
  const { at, box } = found;
  if (!box) return null;
  const twoFrames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(undefined)))));
  /* WebKit's scroll anchoring moves the page a frame after a half-visible
     field's placeholder goes or returns, so each picture is taken only
     after the page has been put back where it was -- at once, as the
     page's own smooth scrolling would take a while. */
  const atRest = async () => {
    await twoFrames();
    await page.evaluate((p) => window.scrollTo({ left: p.x, top: p.y, behavior: "instant" }), at);
    await twoFrames();
  };
  await atRest();
  const as = await settledShot(page, box);
  await page.evaluate((one) => {
    const el = /** @type {HTMLInputElement} */ (document.getElementById(one));
    el.dataset.heldPlaceholder = el.placeholder;
    el.placeholder = "";
  }, id);
  /* Both pictures are settled frames, the second only after the field has
     been repainted without its placeholder: an immediate shot could still
     be the old frame, equal to `as`, and prove nothing (#1208). */
  await atRest();
  const bare = await settledShot(page, box);
  await page.evaluate((one) => {
    const el = /** @type {HTMLInputElement} */ (document.getElementById(one));
    el.placeholder = el.dataset.heldPlaceholder ?? "";
    delete el.dataset.heldPlaceholder;
  }, id);
  await atRest();
  return (await shareDiffering(page, as, bare)) > 0.004;
}

/* ---- round 4: suggested values (#1174, the owner's iPhone) -------------
   The owner saw a field's suggested value left showing behind the text in
   it. The film never writes into a field: it paints its own line over the
   field's box on a cover the field's own colour (vocabulary.js
   `typeInto`). So at each phone, at both of chapter 2's typing marks,
   every field the film has typed over must show none of its own
   placeholder through the film's line. And the product's own form, with
   no film: a field holding real text shows no suggestion; emptied, the
   suggestion is back. */
test.describe("suggested values give way to real text (#1174 round 4)", () => {
  for (const phone of PHONES) {
    test(`at ${phone.width}x${phone.height} no field the film types over shows its suggestion through the film's text`, async ({ browser }) => {
      test.setTimeout(150_000);
      const context = await browser.newContext({
        viewport: { width: phone.width, height: phone.height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
        reducedMotion: "no-preference",
      });
      const page = await context.newPage();
      const errors = await openFilm(page);
      const index = await page.evaluate(() => /** @type {any} */ (window).__chapters.findIndex((/** @type {any} */ c) => c.id === "add"));
      /** @type {string[]} */
      const wrong = [];
      let typedOver = 0;
      for (const mark of ["add-typing", "add-add"]) {
        await page.evaluate((m) => { const hooks = /** @type {any} */ (window); hooks.__held = null; hooks.__hold = m; }, mark);
        if (mark === "add-typing") await page.evaluate((k) => /** @type {any} */ (window).__jump(k), index);
        else await page.evaluate(() => /** @type {any} */ (window).__play());
        try {
          await page.waitForFunction((m) => /** @type {any} */ (window).__held === m, mark, { timeout: 60_000 });
        } catch {
          wrong.push(`${mark}: never reached`);
          continue;
        }
        /* the fields with a film line over them, on the screen; each is
           judged from a settled frame (placeholderShows), not after a
           fixed wait (#1208) */
        const ids = await page.evaluate(() => {
          const ghosts = [...document.querySelectorAll(".tourfilm-typed")].map((g) => g.getBoundingClientRect());
          return [...document.querySelectorAll("#pocket-entry input[placeholder], #pocket-entry textarea[placeholder]")]
            .filter((el) => /** @type {HTMLInputElement} */ (el).placeholder && !(/** @type {HTMLInputElement} */ (el).value))
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return ghosts.some((g) => Math.abs(g.left - r.left) < 2 && Math.abs(g.top - r.top) < 2 && Math.abs(g.width - r.width) < 2);
            })
            .map((el) => el.id);
        });
        for (const id of ids) {
          const shows = await placeholderShows(page, id);
          if (shows === null) continue;
          typedOver++;
          if (shows) wrong.push(`${mark}: #${id}'s suggestion shows through the film's typed line`);
        }
      }
      await context.close();
      expect(errors, "no error in the console").toEqual([]);
      expect(typedOver, "the film's typed lines were found over their fields").toBeGreaterThan(0);
      expect(wrong, "no suggestion behind the film's typed text").toEqual([]);
    });

    test(`at ${phone.width}x${phone.height} the pocket form's suggestions go while a field holds real text and come back when it is emptied`, async ({ browser }) => {
      test.setTimeout(150_000);
      const context = await browser.newContext({
        viewport: { width: phone.width, height: phone.height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
      });
      const page = await context.newPage();
      await page.route("**/api/settings/tour", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: '{"tour":{"tourSeenAt":"2026-01-01T00:00:00.000Z"}}' }));
      await page.goto(`${APP}/create`, { waitUntil: "load" });
      await page.waitForSelector("#pocket-entry input[placeholder]", { timeout: 30_000 });
      const ids = await page.evaluate(() => [...document.querySelectorAll("#pocket-entry input[placeholder], #pocket-entry textarea[placeholder]")]
        .filter((el) => /** @type {HTMLInputElement} */ (el).placeholder && !(/** @type {HTMLInputElement} */ (el).disabled))
        .map((el) => el.id));
      /** @type {string[]} */
      const wrong = [];
      for (const id of ids) {
        const field = page.locator(`[id="${id}"]`);
        /* centred, clear of the save bar along the bottom */
        await field.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
        await page.waitForTimeout(150);
        if (!(await placeholderShows(page, id))) wrong.push(`#${id}: its suggestion is not drawn while it is empty`);
        await field.fill(id.endsWith("-cost") ? "54.85" : "Kwik Fit Bristol");
        await page.waitForTimeout(100);
        if (await placeholderShows(page, id)) wrong.push(`#${id}: its suggestion still shows with real text in it`);
        await field.fill("");
        await page.waitForTimeout(100);
        if (!(await placeholderShows(page, id))) wrong.push(`#${id}: its suggestion did not come back once emptied`);
      }
      await context.close();
      expect(ids.length, "the form's suggested fields were found").toBeGreaterThan(2);
      expect(wrong, "a suggestion only while the field is empty").toEqual([]);
    });
  }
});


/* ---- round 5 (#1174, the owner's iPhone, 2026-10-01) -------------------
   1. Chapter 4 brought the manifest up the screen, and the manifest was
      empty: a new household has nothing in it, so "The manifest lists
      what's ahead" and "Same law as the dial" pointed at blank sky. The
      fixture app's household is full, so nothing above could see it. Here
      the household is emptied as the browser reads it (home reads
      /api/workspace again on mount), and at chapter 4's line the manifest
      must hold at least one row on the screen, clear of the pill — the
      film's own example rows where the household has none, each saying it
      is an example — and the film's ring must be on the example's own
      header, the line's anchor. Once the chapter moves on, and when the
      film is stopped on its line, nothing the film staged is left. ("Same
      law as the dial", which pointed at the first row, was the owner's cut,
      2026-10-01; this used to hold at its mark, manifest-row.)

   2. Owner decision: when the film shows the danger-zone ring it pulses
      red, visibly. That is chapter 5 ("Time runs"), where a body walks in
      toward the sun. At its held mark the ring must be on the screen and
      red on every pack, at least 3:1 against the pack's ground; under
      normal motion it must move, and under reduced motion it must hold
      still; and it must be gone once chapter 6 begins. On the phone and on
      the desk. */

/** The household as the fixture serves it, with nothing in it: no items,
 *  no suggestions, no mail.
 *  @param {import("@playwright/test").Page} page */
async function emptyHousehold(page) {
  await page.route(/\/api\/workspace$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    for (const household of body.workspace?.households ?? []) household.items = [];
    if (body.workspace) body.workspace.suggestions = [];
    await route.fulfill({ response, json: body });
  });
  await page.route(/\/api\/imap-inbox$/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"receipts":[]}' }));
}

/** Everything the film stages on the product's own page. */
const STAGED = "[data-tourfilm-staged], .tourfilm-example-row, .tourfilm-danger";

test.describe("chapter 4's manifest holds rows to point at on a new household (#1174 round 5)", () => {
  for (const phone of PHONES) {
    test(`at ${phone.width}x${phone.height} the empty household's manifest shows rows at chapter 4's line, and the film leaves none behind`, async ({ browser }) => {
      test.setTimeout(180_000);
      const context = await browser.newContext({
        viewport: { width: phone.width, height: phone.height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
        reducedMotion: "no-preference",
      });
      const page = await context.newPage();
      await emptyHousehold(page);
      const errors = await openFilm(page);
      /* the browser's own read has landed: the household is the empty one */
      await page.waitForFunction(() => document.querySelector(".pocket .mdial") && !document.querySelector(".pocket .pk-below .pk-list"),
        null, { timeout: 30_000 });
      const index = await page.evaluate(() => /** @type {any} */ (window).__chapters.findIndex((/** @type {any} */ c) => c.id === "manifest"));
      /** @type {string[]} */
      const wrong = [];
      for (const mark of ["manifest-today"]) {
        await page.evaluate((m) => { const hooks = /** @type {any} */ (window); hooks.__held = null; hooks.__hold = m; }, mark);
        await page.evaluate((k) => /** @type {any} */ (window).__jump(k), index);
        try {
          await page.waitForFunction((m) => /** @type {any} */ (window).__held === m, mark, { timeout: 60_000 });
        } catch {
          wrong.push(`${mark}: never reached`);
          continue;
        }
        await page.waitForTimeout(350);
        const seen = await page.evaluate(() => {
          const pill = document.getElementById("orbit-tour-transport")?.getBoundingClientRect();
          const floor = pill ? pill.top : window.innerHeight;
          const rows = [...document.querySelectorAll(".pocket .pk-below :is(.p-row, .tourfilm-example-row)")].map((el) => {
            const r = el.getBoundingClientRect();
            let faint = false;
            for (let node = /** @type {Element | null} */ (el); node; node = node.parentElement) {
              const cs = getComputedStyle(node);
              if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.5) faint = true;
            }
            return {
              staged: el.classList.contains("tourfilm-example-row"),
              says: /example/i.test(el.textContent ?? ""),
              onScreen: !faint && r.height >= 40 && r.top >= 0 && r.bottom <= floor,
              box: { x: r.left, y: r.top, w: r.width, h: r.height },
            };
          });
          const lit = /** @type {any} */ (window).__lit?.() ?? [];
          const head = document.querySelector(".pocket .pk-below .tourfilm-example h2")?.getBoundingClientRect();
          return { rows, lit, floor: Math.round(floor), head: head ? { x: head.left, y: head.top, w: head.width, h: head.height } : null };
        });
        const shown = seen.rows.filter((row) => row.onScreen);
        if (shown.length === 0) wrong.push(`${mark}: the manifest has no row on the screen (${seen.rows.length} in the page, the pill's top at ${seen.floor})`);
        for (const row of seen.rows.filter((one) => one.staged && !one.says)) wrong.push(`${mark}: a row the film staged does not say it is an example (${JSON.stringify(row.box)})`);
        /* the line's anchor is the example's own header, and that is what is lit */
        if (!seen.head) wrong.push(`${mark}: the staged manifest has no header to point at`);
        else {
          const head = seen.head;
          const ringed = seen.lit.some((/** @type {any} */ one) => Math.abs(one.target.y - head.y) < 20 && Math.abs(one.target.h - head.h) < 30);
          if (!ringed) wrong.push(`${mark}: the example's header is not the one lit (${JSON.stringify(head)})`);
        }
      }
      /* chapter 5: nothing the film staged in chapter 4 is left */
      await page.evaluate(() => { const hooks = /** @type {any} */ (window); hooks.__held = null; hooks.__hold = "time-warmed"; hooks.__play(); });
      try {
        await page.waitForFunction(() => /** @type {any} */ (window).__held === "time-warmed", null, { timeout: 60_000 });
        const left = await page.evaluate(() => document.querySelectorAll(".pocket .pk-below :is([data-tourfilm-staged], .tourfilm-example-row)").length);
        if (left) wrong.push(`time-warmed: ${left} of chapter 4's staged nodes left in the manifest`);
      } catch {
        wrong.push("time-warmed: never reached");
      }
      /* and a stop on chapter 4's line leaves nothing either */
      await page.evaluate((k) => { const hooks = /** @type {any} */ (window); hooks.__held = null; hooks.__hold = "manifest-today"; hooks.__jump(k); }, index);
      try {
        await page.waitForFunction(() => /** @type {any} */ (window).__held === "manifest-today", null, { timeout: 60_000 });
        await page.evaluate(() => /** @type {any} */ (window).__stop());
        await page.waitForTimeout(300);
        const left = await page.evaluate((s) => document.querySelectorAll(s).length, STAGED);
        if (left) wrong.push(`stopped at manifest-today: ${left} staged nodes left on the page`);
      } catch {
        wrong.push("manifest-today (second pass): never reached");
      }
      await context.close();
      expect(errors, "no error in the console").toEqual([]);
      expect(wrong, "the manifest has rows at chapter 4's line, and the film's own go with it").toEqual([]);
    });
  }
});

/** The danger ring as painted now: its stroke on every pack, with the
 *  contrast against that pack's ground, and what of it is moving. */
function dangerRing() {
  const ring = document.querySelector(".tourfilm-danger");
  if (!ring) return null;
  /** @param {string} c */
  const rgb = (c) => {
    const hex = c.trim().match(/^#([0-9a-f]{6})$/i);
    if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
    const m = c.match(/rgba?\(([^)]+)\)/);
    return m ? m[1].split(/[ ,/]+/).filter(Boolean).slice(0, 3).map(Number) : [0, 0, 0];
  };
  /** @param {number[]} c */
  const lum = (c) => {
    const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const stroked = /** @type {Element} */ (ring.querySelector("[data-danger-line]") ?? ring);
  const root = document.documentElement;
  const before = root.dataset.theme;
  const packs = [];
  for (const theme of ["starchart", "afterdark", "dawn", "clouds", "retrograde"]) {
    root.dataset.theme = theme;
    const stroke = rgb(getComputedStyle(stroked).stroke);
    const ground = rgb(getComputedStyle(root).getPropertyValue("--bg"));
    const [a, b] = [lum(stroke), lum(ground)].sort((x, y) => y - x);
    packs.push({ theme, stroke, contrast: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100 });
  }
  if (before === undefined) delete root.dataset.theme;
  else root.dataset.theme = before;
  const box = ring.getBoundingClientRect();
  const moving = document.getAnimations().filter((a) => {
    const target = /** @type {KeyframeEffect} */ (a.effect)?.target;
    return target instanceof Element && ring.contains(target) && a.playState !== "finished";
  });
  return {
    packs,
    onScreen: box.width > 20 && box.top >= 0 && box.bottom <= window.innerHeight,
    opacity: Number(getComputedStyle(stroked).strokeOpacity) * Number(getComputedStyle(stroked).opacity),
    animations: moving.length,
    /* what a frame shows: every part's opacity and transform */
    frame: [...ring.querySelectorAll("*")].map((el) => `${getComputedStyle(el).opacity}|${getComputedStyle(el).transform}|${getComputedStyle(el).strokeOpacity}`).join(";"),
  };
}

test.describe("the danger-zone ring pulses red while chapter 5 shows it (#1174 round 5)", () => {
  const CASES = [
    { name: "on the phone, normal motion", viewport: { width: 390, height: 844 }, phone: true, reduced: false },
    { name: "on the phone, reduced motion", viewport: { width: 390, height: 844 }, phone: true, reduced: true },
    { name: "on the desk, normal motion", viewport: { width: 1600, height: 1000 }, phone: false, reduced: false },
  ];
  for (const one of CASES) {
    test(`${one.name}: red on every pack at time-warmed, ${one.reduced ? "steady" : "moving"}, and gone in chapter 6`, async ({ browser }) => {
      test.setTimeout(150_000);
      const context = await browser.newContext({
        viewport: one.viewport, isMobile: one.phone, hasTouch: one.phone, deviceScaleFactor: one.phone ? 2 : 1,
        reducedMotion: one.reduced ? "reduce" : "no-preference",
      });
      const page = await context.newPage();
      const errors = await openFilm(page);
      const index = await page.evaluate(() => /** @type {any} */ (window).__chapters.findIndex((/** @type {any} */ c) => c.id === "time"));
      /** @type {string[]} */
      const wrong = [];
      await page.evaluate((k) => { const hooks = /** @type {any} */ (window); hooks.__held = null; hooks.__hold = "time-warmed"; hooks.__jump(k); }, index);
      try {
        await page.waitForFunction(() => /** @type {any} */ (window).__held === "time-warmed", null, { timeout: 60_000 });
        await page.waitForTimeout(300);
        const held = await page.evaluate(dangerRing);
        if (!held) wrong.push("time-warmed: no danger ring drawn");
        else {
          if (!held.onScreen) wrong.push("time-warmed: the danger ring is not on the screen");
          for (const pack of held.packs) {
            const [r, g, b] = pack.stroke;
            if (!(r >= 150 && r - g >= 60 && r - b >= 40)) wrong.push(`time-warmed, ${pack.theme}: the ring is not red (rgb ${pack.stroke.join(",")})`);
            if (pack.contrast < 3) wrong.push(`time-warmed, ${pack.theme}: the ring is ${pack.contrast}:1 against the ground, under 3:1`);
          }
          if (one.reduced) {
            if (held.animations) wrong.push(`time-warmed: ${held.animations} animations on the ring under reduced motion`);
            if (held.opacity < 0.9) wrong.push(`time-warmed: the still ring is faint (${held.opacity})`);
          } else if (!held.animations) wrong.push("time-warmed: the ring has no animation under normal motion");
          /* played on: under normal motion the frames differ, under reduced they do not */
          await page.evaluate(() => /** @type {any} */ (window).__play());
          const frames = [];
          for (let k = 0; k < 5; k++) {
            await page.waitForTimeout(140);
            frames.push(await page.evaluate(() => {
              const ring = document.querySelector(".tourfilm-danger");
              return ring ? [...ring.querySelectorAll("*")].map((el) => `${getComputedStyle(el).opacity}|${getComputedStyle(el).transform}|${getComputedStyle(el).strokeOpacity}`).join(";") : "gone";
            }));
          }
          const distinct = new Set(frames.filter((f) => f !== "gone")).size;
          if (!one.reduced && distinct < 2) wrong.push(`playing: the ring's frames never changed (${frames.length} samples)`);
          if (one.reduced && distinct > 1) wrong.push("playing: the ring moved under reduced motion");
        }
      } catch (error) {
        wrong.push(`time-warmed: never reached (${String(error).slice(0, 80)})`);
      }
      await page.evaluate(() => { const hooks = /** @type {any} */ (window); hooks.__held = null; hooks.__hold = "relay-addr"; hooks.__play(); });
      try {
        await page.waitForFunction(() => /** @type {any} */ (window).__held === "relay-addr", null, { timeout: 90_000 });
        if (await page.evaluate(() => document.querySelectorAll(".tourfilm-danger").length)) wrong.push("relay-addr: the danger ring outlived chapter 5");
      } catch {
        wrong.push("relay-addr: never reached");
      }
      await context.close();
      expect(errors, "no error in the console").toEqual([]);
      expect(wrong, "the danger ring red, pulsing (or still, reduced) and gone after").toEqual([]);
    });
  }
});

/* ---- round 6 (#1174, the owner's iPhone, 2026-10-01) -------------------
   (#1319: chapter 8 is now "The item", set in home's drawer; it no longer
   walks to /item, and opens nothing where no body has a row. The plays
   below still hold it to the same rules.)
   The film stood still at 1:56 of the owner's 3:22: chapter 8, "The belt",
   between its start and its first line, on the walk to /item. On a
   household with nothing in it the phone has no body to open, so the film
   walks to /item, which shows the empty household's card -- and then waited
   for a belt that a household with nothing in it never draws. The wait is
   bounded at 12 seconds, and the clock stands still across it; then the
   film played on and stopped itself at 2:09, at the reading card no paper
   could open. The round 3 play above missed it twice over: it plays the
   fixture's full household, never an empty one, past chapter 4, and its
   stall budget (15s) is longer than the wait's own bound, so a wait that ran
   out read as an honest one. So the film now records any wait that runs out,
   every play here fails on one, and this plays a new household through
   chapter 8 -- empty, and with items but no papers -- at all three phones,
   under normal motion, from chapter 7 (the walk in from /inbox) until
   chapter 10 begins. */

/** A household with items, none carrying a paper.
 *  @param {import("@playwright/test").Page} page */
async function paperlessHousehold(page) {
  await page.route(/\/api\/workspace$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    for (const household of body.workspace?.households ?? []) {
      for (const item of household.items ?? []) item.documentCount = 0;
    }
    await route.fulfill({ response, json: body });
  });
}

test.describe("chapter 8 plays through on a new household (#1174 round 6)", () => {
  const CASES = [
    ...PHONES.map((phone) => ({ phone, household: "empty" })),
    { phone: PHONES[1], household: "paperless" },
  ];
  for (const { phone, household } of CASES) {
    test(`at ${phone.width}x${phone.height} on ${household === "empty" ? "a household with nothing in it" : "a household whose items carry no papers"}, chapters 7 to 9 play on without the clock standing still and without the film stopping itself`, async ({ browser }) => {
      test.setTimeout(180_000);
      const context = await browser.newContext({
        viewport: { width: phone.width, height: phone.height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
        reducedMotion: "no-preference",
      });
      const page = await context.newPage();
      if (household === "empty") await emptyHousehold(page);
      else await paperlessHousehold(page);
      const errors = await openFilm(page);
      /* the browser's own read has landed */
      if (household === "empty") {
        await page.waitForFunction(() => document.querySelector(".pocket .mdial") && !document.querySelector(".pocket .pk-below .pk-list"),
          null, { timeout: 30_000 });
      } else {
        await page.waitForFunction(() => document.querySelector(".pocket .mdial .pk-body:not([data-body-sugg])")
          && !document.querySelector('.pocket .mdial .pk-body[data-papers]:not([data-papers="0"])'), null, { timeout: 30_000 });
      }
      const ids = await page.evaluate(() => /** @type {any} */ (window).__chapters.map((/** @type {any} */ c) => c.id));
      const from = ids.indexOf("inbox");
      const until = ids.indexOf("others");
      await page.evaluate((k) => /** @type {any} */ (window).__jump(k), from);
      /** The film's longest honest stall, as above. */
      const STALL_BUDGET_MS = 15_000;
      /** @type {string | null} */
      let stuck = null;
      /** @type {number[]} */
      const chapters = [];
      let lastCursor = -1;
      let lastMoved = Date.now();
      let reached = false;
      let gone = false;
      const started = Date.now();
      while (Date.now() - started < 150_000) {
        const s = await page.evaluate(sampleTransport);
        if (!s) { gone = true; break; }
        if (chapters.at(-1) !== s.chapter) chapters.push(s.chapter);
        if (s.chapter >= until) { reached = true; break; }
        if (s.cursor !== lastCursor) { lastCursor = s.cursor; lastMoved = Date.now(); }
        else if (Date.now() - lastMoved > STALL_BUDGET_MS) {
          stuck = `the clock stood at ${mmssOf(s.cursor)} for ${Math.round((Date.now() - lastMoved) / 1000)}s on ${s.url}, chapter ${s.chapter + 1}`;
          break;
        }
        await page.waitForTimeout(250);
      }
      const waitedOut = await page.evaluate(waitsRunOut);
      await context.close();
      expect.soft(errors, "no error in the console — a film that stopped itself says so there").toEqual([]);
      expect.soft(waitedOut, "no wait for the page ran out — the clock stood still for something that never came").toEqual([]);
      expect.soft(stuck, "the clock keeps moving").toBeNull();
      expect.soft(gone, "the play bar stays up — it goes when the film stops itself").toBe(false);
      expect.soft(reached, "the film plays on into chapter 10").toBe(true);
      expect.soft(chapters, "chapters 7, 8 and 9 in order, none skipped").toEqual([from, from + 1, from + 2, until]);
    });
  }
});

/* ---- round 6, Fable's call (#1174, 2026-10-01; #1319) -----------------
   On a household with nothing in it there is no drawer to open: chapter 8
   says every line at the sun, and chapter 9 says "MOT passed" there too,
   then plays its second line as before. So, on an empty household at
   390x844: every line either chapter shows is anchored to an element on
   the screen, with its stem on it, and the film never walks to /item. */
test.describe("chapters 8 and 9 stay on the sky when the household has nothing in it (#1174 round 6, #1319)", () => {
  test("at 390x844 on a household with nothing in it, every line of chapters 8 and 9 points at something on the screen, and no item is opened", async ({ browser }) => {
    test.setTimeout(150_000);
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
      reducedMotion: "no-preference",
    });
    const page = await context.newPage();
    await emptyHousehold(page);
    const errors = await openFilm(page);
    await page.waitForFunction(() => document.querySelector(".pocket .mdial") && !document.querySelector(".pocket .pk-below .pk-list"),
      null, { timeout: 30_000 });
    const ids = await page.evaluate(() => /** @type {any} */ (window).__chapters.map((/** @type {any} */ c) => c.id));
    const from = ids.indexOf("item");
    const until = ids.indexOf("others");
    await page.evaluate((k) => /** @type {any} */ (window).__jump(k), from);
    /** @type {Record<string, number>} */
    const faults = {};
    /** @type {Set<string>} */
    const lines = new Set();
    /** @type {Set<string>} */
    const urls = new Set();
    /** @type {Map<string, number>} */
    let streak = new Map();
    let reached = false;
    const started = Date.now();
    while (Date.now() - started < 120_000) {
      const m = await page.evaluate(sample);
      const s = await page.evaluate(sampleTransport);
      if (!s || !m) break;
      if (s.chapter >= until) { reached = true; break; }
      if (s.chapter < from) { await page.waitForTimeout(250); continue; }
      urls.add(s.url);
      for (const text of await page.evaluate(() => [.../** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(".tourfilm-callout"))]
        .filter((el) => el.style.opacity !== "0").map((el) => (el.textContent ?? "").slice(0, 28)))) lines.add(text);
      const now = new Map();
      for (const f of m.faults.filter((one) => one.startsWith("callout"))) {
        const key = `${f} · ${s.url} · ch${s.chapter + 1}`;
        const run = (streak.get(key) ?? 0) + 1;
        now.set(key, run);
        if (run >= (f.startsWith("callout pointing at nothing") ? 1 : 2)) faults[key] = (faults[key] ?? 0) + 1;
      }
      streak = now;
      await page.waitForTimeout(250);
    }
    const waitedOut = await page.evaluate(waitsRunOut);
    await context.close();
    expect.soft(errors, "no error in the console").toEqual([]);
    expect.soft(waitedOut, "no wait for the page ran out").toEqual([]);
    expect.soft(reached, "the film plays on into chapter 10").toBe(true);
    expect.soft([...urls].filter((u) => u.startsWith("/item")), "no item is opened in chapters 8 and 9").toEqual([]);
    expect.soft(lines.size, "the lines of chapters 8 and 9 were seen").toBeGreaterThanOrEqual(4);
    expect.soft(faults, "every line points at something on the screen").toEqual({});
  });
});
