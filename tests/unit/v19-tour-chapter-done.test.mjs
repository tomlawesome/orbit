// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import done, { SELECTORS } from "../../web/src/lib/tour/chapters/09-done.js";
import item from "../../web/src/lib/tour/chapters/08-the-item.js";
import { createClock } from "../../web/src/lib/tour/clock.js";
import { createFilmContext } from "../../web/src/lib/tour/vocabulary.js";
import { drawHome } from "./v19-tour-home-drawer-lib.mjs";

/*
 * #866: chapter 9 is one of the three (5, 9, 12) whose lit ring travels with
 * a moving target rather than sitting still, the same device chapter 5 uses
 * — pinned here the same way v19-tour-chapter-time-runs.test.mjs pins it.
 * #1319: it opens on home's item drawer, as chapter 8 leaves it (the belt's
 * item screen is retired), and teaches the drawer's own complete pill by
 * its label. The drawer and the pill are pinned against home's own markup;
 * the drawn `.tourfilm-time-body` by running the chapter, never against a
 * source.
 */

const web = (path) => resolve(import.meta.dirname, "../../web", path);
const read = (files) => files.map((file) => readFileSync(web(file), "utf8")).join("\n");
const DRAWER_SOURCE = read(["src/routes/home/ItemView.svelte", "src/routes/home/FootRow.svelte"]);
const HOME_SOURCE = read(["src/routes/home/+page.svelte", "src/routes/home/CorridorRow.svelte"]) + "\n" + DRAWER_SOURCE;
/* #1083: the pocket dialect of home — the pocket's own dial, sun and the
   demo body's real append target (`.pocket .mdial`, `.pk-sun`), and its
   drawer (the kit Row's detail, ItemDrawer.svelte). */
const POCKET_SOURCE = read(["src/routes/home/pocket.svelte", "src/routes/home/ItemDrawer.svelte", "src/lib/pocket/Row.svelte"])
  + "\n" + DRAWER_SOURCE;

function namesIn(source) {
  const names = new Set();
  const attributes = /(?:class(?:Name)?|id)\s*[=:]\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/gu;
  for (const match of source.matchAll(attributes)) {
    for (const word of (match[1] ?? match[2] ?? match[3] ?? "").matchAll(/[A-Za-z][\w-]*/gu)) {
      names.add(word[0]);
    }
  }
  return names;
}

function tokensOf(selector) {
  return [...selector.matchAll(/[.#]([\w-]+)/gu)].map((match) => match[1]);
}

const settle = () => new Promise((resolve_) => setTimeout(resolve_, 0));

function setReducedMotion(matches) {
  window.matchMedia = () => ({
    matches,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
}

function rect(x, y, w, h) {
  return { left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y, toJSON() {} };
}

/** happy-dom computes no real SVG layout, so the dial and the chapter's own
 *  travelling dot are given boxes by hand, the same trick
 *  v19-tour-chapter-time-runs.test.mjs uses: the dial is fixed, and the
 *  dot's box is derived from the `cx`/`cy` this chapter writes onto it. */
function patchRects() {
  window.SVGElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains("dial")) return rect(390, 150, 500, 500);
    const dot = this.classList.contains("tourfilm-time-dot")
      ? this
      : this.querySelector(".tourfilm-time-dot");
    if (dot) {
      const cx = Number(dot.getAttribute("cx") ?? 190);
      const cy = Number(dot.getAttribute("cy") ?? 190);
      const x = 390 + (cx / 380) * 500;
      const y = 150 + (cy / 380) * 500;
      return rect(x - 6, y - 6, 12, 12);
    }
    return rect(0, 0, 0, 0);
  };
}

async function playOut(clock, promise, step = 100, cap = 400000) {
  let doneRunning = false;
  let failure = null;
  promise.then(() => { doneRunning = true; }, (error) => { doneRunning = true; failure = error; });
  let spent = 0;
  while (!doneRunning && spent < cap) {
    clock.advance(step);
    spent += step;
    await settle();
  }
  if (failure) throw failure;
  if (!doneRunning) throw new Error("the chapter never finished");
}

beforeEach(() => {
  document.body.innerHTML = "";
  /* home's own read has landed, as +page.svelte's sync() says it */
  document.body.dataset.homeReady = "true";
  setReducedMotion(false);
  patchRects();
  window.innerWidth = 1280;
  window.innerHeight = 800;
});

describe("the selectors chapter 9 names", () => {
  for (const [dialect, table, source] of [["desk", SELECTORS.DESK, HOME_SOURCE], ["pocket", SELECTORS.POCKET, POCKET_SOURCE]]) {
    it(`the ${dialect} drawer, its complete pill, the dial and the sun exist in home's own markup`, () => {
      const rendered = namesIn(source);
      for (const key of ["drawer", "done", "dial", "dialSvg", "sun"]) {
        for (const token of tokensOf(table[key])) {
          expect(rendered.has(token), `chapter 9's ${dialect} "${key}" names "${table[key]}", but home renders no "${token}"`).toBe(true);
        }
      }
    });
  }

  it("finds the complete pill by its own label, never by its place among the pills", () => {
    for (const table of [SELECTORS.DESK, SELECTORS.POCKET]) {
      expect(table.done).toContain('button[aria-label^="Complete "]');
      expect(table.done).not.toMatch(/child|of-type/u);
    }
    expect(DRAWER_SOURCE).toContain('aria-label="Complete {title}"');
  });

  it("names nothing on the retired item screen", () => {
    for (const table of [SELECTORS.DESK, SELECTORS.POCKET]) {
      for (const selector of Object.values(table)) expect(selector).not.toMatch(/item-card|ip-acts|ip-complete/u);
    }
  });

  it("the drawn one (.tourfilm-time-body) is never real markup, on either dialect", () => {
    expect(SELECTORS.POCKET.body).toBe(SELECTORS.DESK.body);
    for (const source of [HOME_SOURCE, POCKET_SOURCE]) {
      const names = namesIn(source);
      for (const token of tokensOf(SELECTORS.DESK.body)) expect(names.has(token)).toBe(false);
    }
  });
});

describe("the chapter's shape", () => {
  it("is { id, name, play }", () => {
    expect(done.id).toBe("done");
    expect(done.name).toBe("Done");
    expect(typeof done.play).toBe("function");
  });
});

describe("the beats, against a recorder", () => {
  /** @param {{ open?: boolean, pocket?: boolean }} [options] the drawer
   *  already open (played on from chapter 8), or not (a cold jump) */
  function recorder({ open = true, pocket = false } = {}) {
    const S = pocket ? SELECTORS.POCKET : SELECTORS.DESK;
    const log = [];
    const control = (sel, els = []) => ({ sel, els, ringEls: els, round: false, pad: 0, radius: 14, rings: [], lifted: false, saved: [] });
    const pill = document.createElement("button");
    return {
      log,
      ctx: {
        pocket,
        doc: { querySelector: (sel) => (open && (sel === S.done || sel.endsWith(".ivfootrow")) ? pill : null), defaultView: null },
        dry: () => false,
        T: { cross: 350, scroll: 600 },
        setScreen: async (route) => log.push(["setScreen", route]),
        veil: (on) => log.push(["veil", on]),
        ctl: (spec) => { log.push(["ctl", spec.sel]); return control(spec.sel, spec.sel === S.done && open ? [pill] : []); },
        goto: async (c) => log.push(["goto", c.sel]),
        press: async (c) => log.push(["press", c.sel]),
        light: (c) => log.push(["light", c.sel]),
        unlight: (c) => log.push(["unlight", c.sel]),
        callout: async (text, anchor, side, o) => { log.push(["callout", text, anchor.sel]); if (o?.mark) log.push(["mark", o.mark]); },
        dropCallout: () => log.push(["dropCallout"]),
        tween: async (ms, fn) => { fn(1); log.push(["tween", ms]); },
        w: async (ms) => log.push(["w", ms]),
        mark: async (name) => log.push(["mark", name]),
        open: (c) => { log.push(["open", c.sel]); return async () => {}; },
        shut: async () => log.push(["shut"]),
        waitForReal: async () => {},
        room: () => {},
        lit: () => [],
      },
    };
  }

  it("stays on /home, veiled for the pill, and hands the sky back undimmed once the drawer is put away", async () => {
    const { log, ctx } = recorder();
    await done.play(ctx);
    expect(log[0]).toEqual(["setScreen", "/home"]);
    expect(log.filter(([word]) => word === "setScreen").map(([, route]) => route)).toEqual(["/home"]);
    const shutAt = log.findIndex(([word]) => word === "shut");
    const pressAt = log.findIndex(([word]) => word === "press");
    expect(pressAt).toBeGreaterThan(0);
    expect(shutAt).toBeGreaterThan(pressAt);
    expect(log[shutAt + 1]).toEqual(["veil", false]);
    expect(log.slice(0, pressAt).some(([word, on]) => word === "veil" && on === true)).toBe(true);
    /* never raised again after that -- the swing back out plays undimmed */
    expect(log.slice(shutAt).some(([word, on]) => word === "veil" && on === true)).toBe(false);
  });

  it("says the two lines, in order, the first at the drawer's complete pill, the closing line verbatim", async () => {
    const { log, ctx } = recorder();
    await done.play(ctx);
    const said = log.filter(([word]) => word === "callout").map(([, text, sel]) => [text, sel]);
    expect(said).toEqual([
      ["MOT passed — mark it done and it swings back out to next year.", SELECTORS.DESK.done],
      ["Renewals start their orbit again, fixed length items disappear.", ".tourfilm-time-body"],
    ]);
  });

  it("says the first line at the sun when there is no drawer to open", async () => {
    for (const pocket of [false, true]) {
      const { log, ctx } = recorder({ open: false, pocket });
      await done.play(ctx);
      const S = pocket ? SELECTORS.POCKET : SELECTORS.DESK;
      expect(log.find(([word]) => word === "callout")).toEqual(["callout", "MOT passed — mark it done and it swings back out to next year.", S.sun]);
    }
  });

  it("presses only the complete pill, and only animates it", async () => {
    const { log, ctx } = recorder();
    await done.play(ctx);
    expect(log.filter(([word]) => word === "press").map(([, sel]) => sel)).toEqual([SELECTORS.DESK.done]);
  });

  it("opens no drawer of its own when chapter 8 left one open", async () => {
    const { log, ctx } = recorder();
    await done.play(ctx);
    expect(log.filter(([word]) => word === "open")).toEqual([]);
  });

  it("takes the same time whether the drawer was open or not (the tick)", async () => {
    const spent = async (open) => {
      const { log, ctx } = recorder({ open });
      await done.play(ctx);
      return log.filter(([word]) => word === "w" || word === "tween").map(([, ms]) => ms);
    };
    expect(await spent(false)).toEqual(await spent(true));
  });

  it("marks done-complete, done-swung and done-round", async () => {
    const { log, ctx } = recorder();
    await done.play(ctx);
    expect(log.filter(([word]) => word === "mark").map(([, name]) => name)).toEqual(["done-complete", "done-swung", "done-round"]);
  });
});

describe("the chapter played for real", () => {
  function liveFilm() {
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document });
    clock.setPlaying(true);
    return { clock, ctx };
  }

  it("on a cold jump opens the drawer itself and puts it away; the demo body swings outward and goes", async () => {
    const home = drawHome();
    const { clock, ctx } = liveFilm();
    /** @type {number[]} */
    const seenX = [];
    let sawDrawer = false;
    let finished = false;
    const playing = done.play(ctx).then(() => { finished = true; }, () => { finished = true; });
    let spent = 0;
    while (!finished && spent < 400000) {
      clock.advance(100);
      spent += 100;
      await settle();
      if (document.querySelector(".itemview")) sawDrawer = true;
      const bodyEl = document.querySelector(".tourfilm-time-body");
      if (bodyEl) seenX.push(bodyEl.getBoundingClientRect().x);
    }
    await playing;
    expect(sawDrawer).toBe(true);
    expect(document.querySelector(".itemview")).toBeNull();
    expect(new Set(seenX).size).toBeGreaterThan(1);
    expect(document.querySelector(".tourfilm-time-body")).toBeNull();
    expect(home.writes.count).toBe(0);
    ctx.destroy();
    home.done();
  });

  it("puts its two lines on the screen in order", async () => {
    const home = drawHome();
    const { clock, ctx } = liveFilm();
    const seen = new Set();
    const said = [];
    let finished = false;
    const playing = done.play(ctx).then(() => { finished = true; }, () => { finished = true; });
    let spent = 0;
    while (!finished && spent < 400000) {
      clock.advance(100);
      spent += 100;
      await settle();
      for (const note of document.querySelectorAll(".tourfilm-callout")) {
        if (seen.has(note)) continue;
        seen.add(note);
        said.push(note.textContent);
      }
    }
    await playing;
    expect(said).toEqual([
      "MOT passed — mark it done and it swings back out to next year.",
      "Renewals start their orbit again, fixed length items disappear.",
    ]);
    ctx.destroy();
    home.done();
  });

  it("played on from chapter 8, closes the drawer chapter 8 opened and leaves home exactly as it found it", async () => {
    const home = drawHome({ docs: 1 });
    const before = home.scene.outerHTML;
    const { clock, ctx } = liveFilm();
    await playOut(clock, item.play(ctx));
    expect(document.querySelector(".itemview")).not.toBeNull();
    await playOut(clock, done.play(ctx));
    expect(document.querySelector(".itemview")).toBeNull();
    expect(ctx.hasOpenUndo()).toBe(false);
    expect(home.writes.count).toBe(0);
    ctx.destroy();
    expect(home.scene.outerHTML).toBe(before);
    home.done();
  });
});
