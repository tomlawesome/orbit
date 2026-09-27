import { expect, test } from "@playwright/test";
import { APP, DOOR_STATES, PHONES, SIGNED_IN, settle } from "./pocket-states.js";

/*
 * THE PHONE MEASUREMENT CHECK (#1120, proposal §1.6, §1.7, §3).
 *
 * Opens every state a phone reader can reach -- each route at rest, and
 * every sheet, menu, search, opened row, armed act, expanded section and
 * refusal the fixture data reaches (pocket-states.js lists them and how to
 * get there) -- with touch on, at the two widths the proposal draws for
 * (390x844 and 360x780) and at the height a phone browser leaves them
 * (390x664, 360x640), and fails if anything visible breaks the pocket's
 * three hard floors:
 *   · a tappable element smaller than 44x44px
 *   · text smaller than 12px
 *   · a tappable element outside the viewport's width (content in a strip
 *     that scrolls sideways is reachable by scrolling, so it is exempt)
 * or if a tappable element cannot be seen and tapped whole (review round,
 * owner on a real phone: "buttons half cut off or falling out of view in
 * several places", which the floors above passed):
 *   · cut: part of it, or of its label, is clipped by an ancestor that hides
 *     its overflow, or its label spills out of it
 *   · out of reach: no scroll brings it wholly into view -- it sits in a
 *     sheet, drawer or bar past the screen's bottom or right edge
 *   · below a callout's fold: a callout sheet is its content's height
 *     (§1.4), so everything in it must show whole as it rises; a callout
 *     whose act is half cut or needs a scroll to find has outgrown it
 *   · covered: a fixed or sticky bar (the top chrome, a save bar, the orb,
 *     the add button) or anything else lies over part of it, at every
 *     scroll position that could show it
 * or if the words break round 3's rules for prose on the pocket
 * (design/v19/phone-vision/round-3.md §1):
 *   · a visible ellipsis outside a title or a file name (R8): the guard on
 *     a line is CSS, but a line that needs it is a defect in its words
 *   · a sentence at rest (R1, R3, R5): at rest, a row's meta over its cap
 *     (20 characters beside a trailing value, 34 without; an email address
 *     alone is exempt) or a .p-sub, .p-hint or .p-foot over 40
 *
 * A known defect is an EXPECTED failure (test.fail), not a skip: it still
 * runs, and the day it passes Playwright says so, which is the cue to drop
 * the mark. Each is listed on its state in pocket-states.js as
 * `review round step c: <what>`, the step that fixes it.
 */

/*
 * The two design widths at full height, and the same two phones as a
 * browser actually leaves them: the visible area under iPhone Safari's
 * bottom toolbar (390x664) and under Android Chrome's address bar
 * (360x640). A callout sized to 45% of the screen, or a bar pinned to its
 * foot, meets its first real test at these heights. A state's `defect` is
 * keyed by these names ("390", "360", "390x664", "360x640") or "*" for all.
 */
const MEASURED = [
  ...PHONES,
  { name: "390x664", viewport: { width: 390, height: 664 } },
  { name: "360x640", viewport: { width: 360, height: 640 } },
];

/**
 * The selector the checks scope to: the sheet or dialog that is up, when
 * one is (the page behind it is inert under its scrim), else the page.
 * @param {import("@playwright/test").Page} page
 */
const scopeOf = (page) => page.evaluate(() =>
  [...document.querySelectorAll("[aria-modal=true]")].some((m) => m.checkVisibility({ visibilityProperty: true }))
    ? "[aria-modal=true]" : "");

/**
 * Runs in the page. Returns every violation under `scope` (a selector; the
 * whole document when empty), as short readable strings.
 * @param {string} scope
 */
function measure(scope) {
  const MIN_HIT = 44;
  const MIN_TEXT = 12;
  const TAPPABLE = "a[href],button,input:not([type=hidden]),select,textarea,summary,"
    + "[role=button],[role=link],[role=tab],[role=switch],[tabindex]:not([tabindex='-1'])";
  const roots = scope ? [...document.querySelectorAll(scope)] : [document.body];
  const vw = document.documentElement.clientWidth;
  const out = new Set();

  /** @param {Element} el */
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    /* A 1px box is the visually-hidden pattern (.sr-only): read by a screen
       reader, never seen or tapped. */
    if (r.width <= 1 || r.height <= 1) return false;
    return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  };
  /** @param {Element} el */
  const inSideScroller = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if ((o === "auto" || o === "scroll") && p.scrollWidth > p.clientWidth) return true;
    }
    return false;
  };
  /** @param {Element} el */
  const label = (el) => {
    const text = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.classList[0] ? `.${el.classList[0]}` : ""} "${text}"`;
  };

  for (const root of roots) {
    const candidates = [root, ...root.querySelectorAll(TAPPABLE)].filter((el) => el.matches(TAPPABLE));
    for (const el of candidates) {
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < MIN_HIT - 0.5 || r.height < MIN_HIT - 0.5)
        out.add(`tap target ${Math.round(r.width)}x${Math.round(r.height)}: ${label(el)}`);
      if ((r.left < -0.5 || r.right > vw + 0.5) && !inSideScroller(el))
        out.add(`outside the viewport (${Math.round(r.left)}..${Math.round(r.right)} of ${vw}): ${label(el)}`);
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.nodeValue?.trim()) continue;
      const el = node.parentElement;
      if (!el || !shown(el)) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < MIN_TEXT - 0.01) out.add(`text ${size}px: ${label(el)}`);
    }
  }
  return [...out];
}

/**
 * Runs in the page. The whole-and-reachable half of the check: every shown
 * tappable element under `scope`, and its label, must be visible whole --
 * not cut by an ancestor that hides its overflow, not spilling out of its
 * own box -- and where it is not wholly on screen now, scrolling it into
 * view must bring it wholly on screen. Returns each failure as a string.
 * Scrolls to find out, and puts every scroll back where it was.
 * @param {string} scope
 */
function reach(scope) {
  const TAPPABLE = "a[href],button,input:not([type=hidden]),select,textarea,summary,"
    + "[role=button],[role=link],[role=tab],[role=switch],[tabindex]:not([tabindex='-1'])";
  const SLACK = 1;
  const roots = scope ? [...document.querySelectorAll(scope)] : [document.body];
  const out = new Set();

  /** @param {Element} el */
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    return el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && !el.closest("[inert]");
  };
  /** @param {Element} el */
  const label = (el) => {
    const text = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.classList[0] ? `.${el.classList[0]}` : ""} "${text}"`;
  };
  /** @param {Element} el */
  const place = (el) => {
    const r = el.getBoundingClientRect();
    return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
  };
  /** @typedef {{ left: number, top: number, right: number, bottom: number }} Box */
  /** @param {Box} a @param {Box} b @returns {Box} */
  const meet = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
  /** @param {Box} inner @param {Box} outer */
  const within = (inner, outer) => inner.left >= outer.left - SLACK && inner.top >= outer.top - SLACK
    && inner.right <= outer.right + SLACK && inner.bottom <= outer.bottom + SLACK;
  /** The box an element clips its content to: its padding box. @param {Element} p @returns {Box} */
  const clipBox = (p) => {
    const r = p.getBoundingClientRect();
    const left = r.left + p.clientLeft;
    const top = r.top + p.clientTop;
    return { left, top, right: left + p.clientWidth, bottom: top + p.clientHeight };
  };
  /** A strip that scrolls sideways: what it hides is a swipe away. @param {Element} p */
  const sideScroller = (p) => {
    const o = getComputedStyle(p).overflowX;
    return (o === "auto" || o === "scroll") && p.scrollWidth > p.clientWidth;
  };
  /**
   * The ancestors that clip `el`, walking the containing blocks: an
   * absolutely positioned box escapes the overflow of everything below its
   * offset parent, a fixed one escapes all of it.
   * @param {Element} el
   * @returns {{ el: Element, x: string, y: string, box: Box }[]}
   */
  const clippers = (el) => {
    const found = [];
    let node = el;
    while (node && node !== document.body && node !== document.documentElement) {
      const position = node instanceof HTMLElement ? getComputedStyle(node).position : "static";
      /** @type {Element | null} */
      let next;
      if (position === "fixed") next = null;
      else if (position === "absolute" && node instanceof HTMLElement) next = node.offsetParent;
      else next = node.parentElement;
      if (!next || next === document.body || next === document.documentElement) break;
      const svgInner = next instanceof SVGElement && !(next instanceof SVGSVGElement && !(next.parentElement instanceof SVGElement));
      if (!svgInner) {
        const cs = getComputedStyle(next);
        if (cs.overflowX !== "visible" || cs.overflowY !== "visible")
          found.push({ el: next, x: cs.overflowX, y: cs.overflowY, box: clipBox(next) });
      }
      node = next;
    }
    return found;
  };
  const hides = (/** @type {string} */ o) => o === "hidden" || o === "clip";
  const scrolls = (/** @type {string} */ o) => o === "auto" || o === "scroll";

  /** Cut by an ancestor that hides overflow: never shown whole, whatever the scroll. @param {Element} el */
  const cut = (el) => {
    const r = el.getBoundingClientRect();
    for (const c of clippers(el)) {
      const box = { left: hides(c.x) ? c.box.left : -Infinity, right: hides(c.x) ? c.box.right : Infinity,
        top: hides(c.y) ? c.box.top : -Infinity, bottom: hides(c.y) ? c.box.bottom : Infinity };
      if (!within(r, box)) return c.el;
    }
    return null;
  };
  /** Where el can be seen right now: the viewport, less every scroller's and hider's box. @param {Element} el */
  const windowOf = (el) => {
    const found = clippers(el);
    /* In a strip that scrolls sideways, across is a swipe away (and scroll
       snapping decides where a scroll lands): only up and down count. */
    const strip = found.some((c) => sideScroller(c.el));
    let box = { left: strip ? -Infinity : 0, top: 0,
      right: strip ? Infinity : document.documentElement.clientWidth, bottom: document.documentElement.clientHeight };
    for (const c of found) {
      const xAxis = !strip && (hides(c.x) || scrolls(c.x));
      const yAxis = hides(c.y) || scrolls(c.y);
      box = meet(box, { left: xAxis ? c.box.left : -Infinity, right: xAxis ? c.box.right : Infinity,
        top: yAxis ? c.box.top : -Infinity, bottom: yAxis ? c.box.bottom : Infinity });
    }
    return box;
  };
  /** Every scroll position that scrollIntoView might move. */
  const scrolled = () => {
    /** @type {[Element, number, number][]} */
    const saved = [[document.scrollingElement ?? document.documentElement, scrollX, scrollY]];
    for (const p of document.querySelectorAll("*")) if (p.scrollTop || p.scrollLeft) saved.push([p, p.scrollLeft, p.scrollTop]);
    return () => {
      for (const p of document.querySelectorAll("*")) if (p.scrollTop || p.scrollLeft) p.scrollTo({ left: 0, top: 0, behavior: "instant" });
      for (const [p, left, top] of saved) p.scrollTo({ left, top, behavior: "instant" });
    };
  };

  const candidates = roots.flatMap((root) => [root, ...root.querySelectorAll(TAPPABLE)].filter((el) => el.matches(TAPPABLE)));
  for (const el of candidates) {
    if (!shown(el)) continue;
    /* The top chrome retracts on a scroll down by design and is back on
       any scroll up (§1.3, TopChrome.svelte): out of view, not out of reach. */
    if (el.closest(".p-chrome.hidden")) continue;
    /* A callout sheet is its content's height (Sheet.svelte, §1.4): what
       it holds must show whole as it rises, not wait below its fold. */
    const callout = el.closest(".p-sheet-layer.open[data-size=callout] .p-sheet-panel .body");
    if (callout) {
      const fold = meet(clipBox(callout), { left: 0, top: 0, right: document.documentElement.clientWidth, bottom: document.documentElement.clientHeight });
      const r = el.getBoundingClientRect();
      if (!within(r, fold)) {
        const shownPx = Math.max(0, Math.min(r.bottom, fold.bottom) - Math.max(r.top, fold.top));
        out.add(`below the fold of its callout sheet (${Math.round(shownPx)} of ${Math.round(r.height)}px showing): ${label(el)} at ${place(el)}`);
        continue;
      }
    }
    const hider = cut(el);
    if (hider) {
      out.add(`cut by ${label(hider)} at ${place(hider)}: ${label(el)} at ${place(el)}`);
      continue;
    }

    /* Its label: clipped inside it (an ellipsis is a deliberate cut and
       passes), or spilling out of it. */
    const own = el.getBoundingClientRect();
    /* A strip's own text scrolls inside it; a control inside another is
       measured as itself. */
    const ownScroll = getComputedStyle(el);
    const strip = scrolls(ownScroll.overflowX) || scrolls(ownScroll.overflowY);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!node.nodeValue?.trim() || !parent || !shown(parent) || strip) continue;
      if (parent.closest(TAPPABLE) !== el) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width < 1 || rect.height < 1) continue;
        /** @type {Box} */
        let seen = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        let problem = "";
        for (let p = /** @type {Element | null} */ (parent); p; p = p.parentElement) {
          const cs = getComputedStyle(p);
          if (hides(cs.overflowX) || hides(cs.overflowY)) {
            const edge = clipBox(p);
            const box = { left: hides(cs.overflowX) ? edge.left : -Infinity, right: hides(cs.overflowX) ? edge.right : Infinity,
              top: hides(cs.overflowY) ? edge.top : -Infinity, bottom: hides(cs.overflowY) ? edge.bottom : Infinity };
            const ellipsis = cs.textOverflow === "ellipsis" && seen.top >= box.top - SLACK && seen.bottom <= box.bottom + SLACK;
            if (!within(seen, box) && !ellipsis) problem ||= `label cut by ${label(p)}`;
            seen = meet(seen, box);
          }
          if (p === el) break;
        }
        if (!(el instanceof SVGElement) && !problem && !within(seen, own)) problem = "label spills out of its box";
        if (problem) out.add(`${problem}: "${node.nodeValue.trim().slice(0, 30)}" in ${label(el)} at ${place(el)}`);
      }
    }

    /* Out of reach: not wholly in view now, and scrolling it into view does
       not make it so. Bigger than its window can never fit and is left to
       the width floor. */
    const now = el.getBoundingClientRect();
    if (within(now, windowOf(el))) continue;
    const restore = scrolled();
    el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    const after = el.getBoundingClientRect();
    const view = windowOf(el);
    if (!within(after, view) && after.width <= view.right - view.left + SLACK && after.height <= view.bottom - view.top + SLACK) {
      const edges = [after.bottom > view.bottom + SLACK ? `bottom by ${Math.round(after.bottom - view.bottom)}px` : "",
        after.right > view.right + SLACK ? `right by ${Math.round(after.right - view.right)}px` : "",
        after.top < view.top - SLACK ? `top by ${Math.round(view.top - after.top)}px` : "",
        after.left < view.left - SLACK ? `left by ${Math.round(view.left - after.left)}px` : ""].filter(Boolean).join(", ");
      out.add(`out of reach, past the ${edges} at the furthest scroll: ${label(el)}`);
    }
    restore();
  }
  return [...out];
}

/**
 * Runs in the page. The covered half: every shown tappable element under
 * `scope` that is wholly in view right now (or only the one at `only`), hit
 * at its centre and 4px inside the middle of each edge. A hit that lands on
 * something that is neither it, inside it, nor around it means something
 * lies over it. Returns [index, what] for each, index into the same walk.
 * @param {{ scope: string, only?: number }} options
 */
function covered({ scope, only = -1 }) {
  const TAPPABLE = "a[href],button,input:not([type=hidden]),select,textarea,summary,"
    + "[role=button],[role=link],[role=tab],[role=switch],[tabindex]:not([tabindex='-1'])";
  const roots = scope ? [...document.querySelectorAll(scope)] : [document.body];
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  /** @param {Element} el */
  const label = (el) => {
    const text = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.classList[0] ? `.${el.classList[0]}` : ""} "${text}"`;
  };
  /** What lies over: the fixed or sticky thing it belongs to, if any, else itself. @param {Element} hit */
  const coverOf = (hit) => {
    for (let p = /** @type {Element | null} */ (hit); p && p !== document.body; p = p.parentElement) {
      const position = getComputedStyle(p).position;
      if (position === "fixed" || position === "sticky") return `${position} ${label(p)}`;
    }
    return label(hit);
  };
  /** @type {[number, string][]} */
  const out = [];
  const all = roots.flatMap((root) => [root, ...root.querySelectorAll(TAPPABLE)].filter((el) => el.matches(TAPPABLE)));
  all.forEach((el, index) => {
    if (only >= 0 && index !== only) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return;
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || el.closest("[inert]")) return;
    if (getComputedStyle(el).pointerEvents === "none") return;
    if (r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1) return;
    const inset = (/** @type {number} */ size) => Math.min(4, size / 4);
    const points = el instanceof SVGElement
      ? [[r.left + r.width / 2, r.top + r.height / 2]]
      : [[r.left + r.width / 2, r.top + r.height / 2], [r.left + r.width / 2, r.top + inset(r.height)],
        [r.left + r.width / 2, r.bottom - inset(r.height)], [r.left + inset(r.width), r.top + r.height / 2],
        [r.right - inset(r.width), r.top + r.height / 2]];
    for (const [x, y] of points) {
      const hit = document.elementFromPoint(x, y);
      if (!hit || hit === el || el.contains(hit) || hit.contains(el)) continue;
      /* A control drawn inside a field (a password's `show`) is the
         field's own adornment, not something over it. */
      const control = hit.closest(TAPPABLE);
      if (control) {
        const c = control.getBoundingClientRect();
        if (c.left >= r.left - 1 && c.right <= r.right + 1 && c.top >= r.top - 1 && c.bottom <= r.bottom + 1) continue;
      }
      out.push([index, `covered by ${coverOf(hit)}: ${label(el)} at ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`]);
      return;
    }
  });
  return out;
}

/**
 * Covered at every scroll position that could show it: looked for at the
 * state as reached and at the end of every scroll, and anything found is
 * scrolled to the middle of its scroller and looked at again -- only what
 * is still covered there is reported. Scrolls, then goes back to the top.
 * @param {import("@playwright/test").Page} page
 * @param {string} scope
 */
async function coveredEverywhere(page, scope) {
  /** @type {Map<number, string>} */
  const found = new Map();
  for (const [index, what] of await page.evaluate(covered, { scope })) found.set(index, what);
  await page.evaluate(() => {
    for (const p of [document.scrollingElement, ...document.querySelectorAll("*")]) {
      if (!p || p.scrollHeight <= p.clientHeight) continue;
      const o = p === document.scrollingElement ? "auto" : getComputedStyle(p).overflowY;
      if (o === "auto" || o === "scroll") p.scrollTo({ top: p.scrollHeight, behavior: "instant" });
    }
  });
  await page.waitForTimeout(450);
  for (const [index, what] of await page.evaluate(covered, { scope })) if (!found.has(index)) found.set(index, what);
  const problems = [];
  for (const [index] of found) {
    await page.evaluate(({ scope, index }) => {
      const TAPPABLE = "a[href],button,input:not([type=hidden]),select,textarea,summary,"
        + "[role=button],[role=link],[role=tab],[role=switch],[tabindex]:not([tabindex='-1'])";
      const roots = scope ? [...document.querySelectorAll(scope)] : [document.body];
      const all = roots.flatMap((root) => [root, ...root.querySelectorAll(TAPPABLE)].filter((el) => el.matches(TAPPABLE)));
      all[index]?.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    }, { scope, index });
    await page.waitForTimeout(450);
    const still = await page.evaluate(covered, { scope, only: index });
    if (still.length) problems.push(still[0][1]);
  }
  await page.evaluate(() => {
    for (const p of [document.scrollingElement, ...document.querySelectorAll("*")]) if (p && p.scrollTop) p.scrollTo({ top: 0, behavior: "instant" });
  });
  return problems;
}

/**
 * Runs in the page. Every visible ellipsis under `scope` that is not a
 * title's or a file name's (round 3 §1, R8): an element that cuts its own
 * text with `text-overflow: ellipsis` and is cut now. A cut is a file
 * name's when everything it hides is the line's trailing file name (and
 * the `·` before it), as a row's meta puts the elastic part last (R5).
 * @param {string} scope
 */
function ellipses(scope) {
  const roots = scope ? [...document.querySelectorAll(scope)] : [document.body];
  const FILE = /[^\s·]+\.[a-z0-9]{2,5}$/i;
  /** @param {Element} el */
  const label = (el) => {
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `${el.tagName.toLowerCase()}${el.classList[0] ? `.${el.classList[0]}` : ""} "${text}"`;
  };
  const out = new Set();
  for (const root of roots) {
    for (const el of [root, ...root.querySelectorAll("*")]) {
      const cs = getComputedStyle(el);
      if (cs.textOverflow !== "ellipsis" || !/hidden|clip/.test(cs.overflowX) || cs.whiteSpace !== "nowrap") continue;
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1 || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      if (el.closest("[class*=title]")) continue;
      /* Where the cut falls: the first character past the content edge. */
      const edge = r.left + el.clientLeft + el.clientWidth - parseFloat(cs.paddingRight);
      const text = el.textContent ?? "";
      let at = -1;
      let offset = 0;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      seek: for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const length = node.nodeValue?.length ?? 0;
        for (let i = 0; i < length; i++) {
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const box = range.getBoundingClientRect();
          if (box.width && box.right > edge + 0.5) { at = offset + i; break seek; }
        }
        offset += length;
      }
      const file = FILE.exec(text.trimEnd());
      /* The ellipsis itself takes a character's room before the cut. */
      if (file && at >= 0 && at - 1 >= file.index - 3) continue;
      out.add(`ellipsis outside a title or file name: ${label(el)}`);
    }
  }
  return [...out];
}

/**
 * Runs in the page, on a state at rest. Every line under `scope` that is
 * a sentence where the pocket keeps data (round 3 §1, R3, R5): a row's
 * meta over 20 characters beside a trailing value or 34 without, or a
 * `.p-sub`, `.p-hint` or `.p-foot` over 40. Those caps are set in 13px
 * mono at 7.8px a character; a meta in the body face (`metaFace="ui"`,
 * about 6.3px a character at 13px, §1's own measurements) gets the same
 * width in its own characters. An email address alone is R5's exception,
 * and a meta's trailing file name is R5's elastic part: the guard trims it
 * (the ellipsis check above allows that cut), so only the fixed data before
 * it counts against the cap.
 * @param {string} scope
 */
function sentences(scope) {
  const roots = scope ? [...document.querySelectorAll(scope)] : [document.body];
  const UI = 7.8 / 6.3;
  const FILE_TAIL = /\s·\s[^\s·]+\.[a-z0-9]{2,5}$/i;
  const out = new Set();
  /** @param {Element} el */
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  };
  for (const root of roots) {
    for (const el of root.querySelectorAll("[data-row] .meta, .p-sub, .p-hint, .p-foot")) {
      if (!shown(el)) continue;
      let text = (el.textContent ?? "").trim().replace(/\s+/g, " ");
      let cap = 40;
      if (el.classList.contains("meta")) {
        if (el.classList.contains("email")) continue;
        text = text.replace(FILE_TAIL, "");
        const row = el.closest("[data-row]");
        cap = row?.querySelector(".trail") ? 20 : 34;
        if (el.classList.contains("ui")) cap = Math.floor(cap * UI);
      }
      if (text.length > cap)
        out.add(`sentence at rest (${text.length} > ${cap}): ${el.classList[0]} "${text.slice(0, 60)}"`);
    }
  }
  return [...out];
}

/**
 * Every check on the state the page is in now. `rest` adds the check for
 * sentences, which the pocket allows once something is opened (R2).
 * @param {import("@playwright/test").Page} page
 * @param {{ rest?: boolean }} [options]
 */
async function inspect(page, { rest = false } = {}) {
  await settle(page);
  const scope = await scopeOf(page);
  const floors = await page.evaluate(measure, scope);
  const reached = await page.evaluate(reach, scope);
  const cover = await coveredEverywhere(page, scope);
  const words = [...await page.evaluate(ellipses, scope), ...(rest ? await page.evaluate(sentences, scope) : [])];
  return [...floors, ...reached, ...cover, ...words];
}

for (const phone of MEASURED) {
  test.describe(`pocket measurement at ${phone.name}`, () => {
    test.use({ viewport: phone.viewport, hasTouch: true, isMobile: true });

    for (const state of SIGNED_IN) {
      test(`${state.route} · ${state.state} meets the pocket floors`, async ({ page }) => {
        const defect = state.defect?.[phone.name] ?? state.defect?.["*"];
        test.fail(Boolean(defect), defect);
        await state.reach(page);
        const problems = await inspect(page, { rest: state.state === "rest" });
        expect(problems, problems.join("\n")).toEqual([]);
      });
    }
  });
}

for (const phone of MEASURED) {
  test.describe(`pocket measurement at ${phone.name}: the door family`, () => {
    test.use({ viewport: phone.viewport, hasTouch: true, isMobile: true, reducedMotion: "reduce" });

    for (const state of DOOR_STATES) {
      test(`${state.name} meets the pocket floors`, async ({ page }) => {
        const defect = state.defect?.[phone.name] ?? state.defect?.["*"];
        test.fail(Boolean(defect), defect);
        await state.reach(page);
        await page.evaluate(() => document.fonts.ready);
        /* reduced motion still crossfades the card in over .7s (ringcard.css) */
        await page.waitForTimeout(900);
        const problems = await inspect(page, { rest: state.state === "rest" });
        expect(problems, problems.join("\n")).toEqual([]);
      });
    }
  });
}

/*
 * THE GRAPHIC CHECK (#1120). The floors above measure tappable elements and
 * text, so they passed a 404 whose black hole ran off both sides of the phone
 * (the owner, on a real phone: "the 404 graphic is too wide for mobile").
 * Fitting the whole 1600x1000 scene then left the hole 60px across, so the
 * review round (design/v19/phone-vision/review-round.md §2.8) fits the well's
 * own box instead: the two 4s span x 440-1160 and the glow y 130-770 in scene
 * units, and that box must sit inside the viewport. The glow's faint outer
 * reach, the disc's widest rings and the falling labels on the outer part of
 * their orbits bleed off the sides by that ruling, as the star fall behind it
 * (`.infall`) always has.
 *
 * Runs in the page. Returns the box if it is outside the viewport, as a string.
 */
function wellOverflow() {
  const svg = /** @type {SVGSVGElement} */ (document.querySelector(".world > svg"));
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const ctm = svg.getScreenCTM();
  if (!ctm) return ["the well has no screen transform"];
  const at = (/** @type {number} */ x, /** @type {number} */ y) => new DOMPoint(x, y).matrixTransform(ctm);
  const a = at(440, 130);
  const b = at(1160, 770);
  if (a.x < 0 || a.y < 0 || b.x > vw || b.y > vh)
    return [`the well's box at ${Math.round(a.x)},${Math.round(a.y)}..${Math.round(b.x)},${Math.round(b.y)} of ${vw}x${vh}`];
  return [];
}

for (const phone of MEASURED) {
  test.describe(`pocket measurement at ${phone.name}: the error page's graphic`, () => {
    test.use({ viewport: phone.viewport, hasTouch: true, isMobile: true });

    test(".world > svg (the gravity well): its own box fits inside the screen", async ({ page }) => {
      await page.goto(`${APP}/pocket-measure-no-such-page`, { waitUntil: "load" });
      await page.waitForSelector(".world[data-rasterised=ready]");
      const problems = await page.evaluate(wellOverflow);
      expect(problems, problems.join("\n")).toEqual([]);
    });
  });
}
