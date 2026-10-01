// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import manifest, { SELECTORS } from "../../web/src/lib/tour/chapters/04-below-the-dial.js";
import { createClock } from "../../web/src/lib/tour/clock.js";
import { TOUR_STOPS } from "../../web/src/lib/tour/stops.js";
import { createFilmContext, T } from "../../web/src/lib/tour/vocabulary.js";

/*
 * #866: chapter 4 is one of the film's three measured, jumped-to ticks
 * (4, 8, 11 — the transport places a tick at every chapter's start and reads
 * it off a dry run before a frame plays), so what this file pins beyond the
 * selectors is that the chapter's own length never depends on how much is in
 * the manifest — the same rule chapter 1's own test pins for its suns.
 *
 * THE POINT OF THE FIRST BLOCK, same as chapter 1's and chapter 2's: every
 * selector the chapter names must EXIST in the real markup it names it
 * against, so a rename fails loudly here instead of silently lighting
 * nothing when the film plays.
 */

const web = (path) => resolve(import.meta.dirname, "../../web", path);

/* #manifest-top and its ".today" header live on home's own page; each row is
   CorridorRow.svelte, split out of +page.svelte (see that file's own
   comment). */
const HOME_SOURCE = [
  "src/routes/home/+page.svelte",
  "src/routes/home/CorridorRow.svelte",
].map((file) => readFileSync(web(file), "utf8")).join("\n");

/* #1083: the pocket's own manifest column and header live on pocket.svelte
   itself; each row is Row.svelte's own `.p-row`. */
const POCKET_SOURCE = [
  "src/routes/home/pocket.svelte",
  "src/lib/pocket/Row.svelte",
].map((file) => readFileSync(web(file), "utf8")).join("\n");

/** Every name the source assigns to a class or an id, however it writes it —
 *  literal, Svelte expression, or DOM assignment. Lifted from
 *  v19-tour-chapter-arrive.test.mjs, which lifted it from v19-tour-stops. */
function namesIn(source) {
  const names = new Set();
  const attributes = /(?:class(?:Name)?|id)\s*[=:]\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/gu;
  for (const match of source.matchAll(attributes)) {
    for (const word of (match[1] ?? match[2] ?? match[3] ?? "").matchAll(/[A-Za-z][\w-]*/gu)) {
      names.add(word[0]);
    }
  }
  for (const match of source.matchAll(/class:([\w-]+)/gu)) names.add(match[1]);
  return names;
}

/** The class and id names one CSS selector depends on. */
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

function box(el, { x, y, w, h }) {
  el.getBoundingClientRect = () => ({
    left: x, top: y, width: w, height: h,
    right: x + w, bottom: y + h, x, y, toJSON() {},
  });
}

/** Home's manifest, near enough for the film: the column, its "today"
 *  header and `rows` items under it — below the fold, as the real page has
 *  it. `rows = 0` is the household whose corridor holds nothing, which still
 *  renders the column and its header, just no items under it. */
function drawHome({ rows = 2 } = {}) {
  const items = Array.from(
    { length: rows },
    (_, k) => `<a class="item" id="row-${k}"><span class="planet"></span><div class="body"><b>Item ${k}</b></div></a>`,
  ).join("");
  document.body.innerHTML = `
    <div id="page">
      <div class="hero" id="hero">
        <svg class="dial"><g class="chrome"></g><a class="sun-link"></a></svg>
      </div>
      <div class="manifest" id="manifest-top">
        <div class="corridor">
          <div class="today"><span class="sunmark" aria-hidden="true"><i></i><b></b></span><span>TODAY</span><div class="rule"></div></div>
          ${items}
        </div>
        ${rows === 0 ? '<div class="horizon">— nothing scheduled: your sky is quiet —</div>' : ""}
      </div>
    </div>`;
  box(document.getElementById("manifest-top"), { x: 0, y: 900, w: 1280, h: 720 });
  box(document.querySelector("#manifest-top .today"), { x: 232, y: 920, w: 832, h: 28 });
  for (const row of document.querySelectorAll("#manifest-top .item")) {
    box(row, { x: 270, y: 960, w: 786, h: 84 });
  }
}

async function playOut(clock, promise, step = 100, cap = 400000) {
  let done = false;
  let failure = null;
  promise.then(() => { done = true; }, (error) => { done = true; failure = error; });
  let spent = 0;
  while (!done && spent < cap) {
    clock.advance(step);
    spent += step;
    await settle();
  }
  if (failure) throw failure;
}

beforeEach(() => {
  document.body.innerHTML = "";
  setReducedMotion(false);
  window.innerWidth = 1280;
  window.innerHeight = 800;
});

describe("the selectors chapter 4 names", () => {
  it("every desk one exists in home's own markup", () => {
    const rendered = namesIn(HOME_SOURCE);
    for (const [beat, selector] of Object.entries(SELECTORS.DESK)) {
      for (const token of tokensOf(selector)) {
        expect(
          rendered.has(token),
          `chapter 4's desk "${beat}" names "${selector}", but /home renders no "${token}"`,
        ).toBe(true);
      }
    }
  });

  it("every pocket one exists in pocket.svelte's own markup (#1083)", () => {
    const rendered = namesIn(POCKET_SOURCE);
    for (const [beat, selector] of Object.entries(SELECTORS.POCKET)) {
      for (const token of tokensOf(selector)) {
        expect(
          rendered.has(token),
          `chapter 4's pocket "${beat}" names "${selector}", but pocket.svelte renders no "${token}"`,
        ).toBe(true);
      }
    }
  });

  it("names the same manifest the ratified walk already points at, with the same copy (its second line cut, #1174)", () => {
    /* stops.js is where these were ratified; the film must not drift off
       onto its own idea of where the manifest is or what it says. */
    const stop = TOUR_STOPS.find((one) => one.id === "manifest");
    expect(stop.target).toContain("#manifest-top");
    expect(SELECTORS.DESK.manifest).toBe("#manifest-top");
    expect(stop.copy).toEqual([
      "The manifest lists what's ahead, nearest first.",
    ]);
  });
});

describe("the chapter's shape", () => {
  it("is { id, name, play }", () => {
    expect(manifest.id).toBe("manifest");
    expect(manifest.name).toBe("Below the dial");
    expect(typeof manifest.play).toBe("function");
  });
});

describe("the beats, in the mockup's order", () => {
  /** Records what the chapter asks the vocabulary to do, without touching a
   *  real document — lifted from v19-tour-chapter-add.test.mjs's own. */
  function recorder() {
    const log = [];
    /* #1174 round 4: the room a chapter makes below the page, kept apart
       from the beats so their order reads as it always has. */
    const rooms = [];
    const control = (sel) => ({ sel, els: [], ringEls: [], round: false, pad: 0, radius: 14, rings: [], lifted: false, saved: [] });
    return {
      log,
      rooms,
      ctx: {
        room: (px) => rooms.push(px),
        setScreen: async (route) => log.push(["setScreen", route]),
        veil: (on) => log.push(["veil", on]),
        ctl: (spec) => {
          log.push(["ctl", spec.sel]);
          return control(spec.sel);
        },
        goto: async (c, o) => log.push(["goto", c.sel, o?.willPress ?? true]),
        unlight: (...cs) => log.push(["unlight", cs.map((c) => c.sel)]),
        callout: async (text, anchor, side, o) => log.push(["callout", text, anchor.sel, side, o?.mark]),
        dropCallout: () => log.push(["dropCallout"]),
        mark: async (name) => log.push(["mark", name]),
        w: async (ms) => log.push(["w", ms]),
        /* #1174: the two scrolls run on the film's clock as a tween over
           T.scroll — the same beat the mockup's own `w(T.scroll)` spent, so
           it is logged as that beat. The step is landed once, as the clock
           lands it under reduced motion and in the dry run. */
        tween: async (ms, fn) => { fn(1); log.push(["w", ms]); },
        T,
        dry: () => false,
        doc: { defaultView: null },
      },
    };
  }

  it("leaves no room of its own below the page once it ends (#1174 round 4)", async () => {
    const { rooms, ctx } = recorder();
    await manifest.play(ctx);
    expect(rooms.at(-1)).toBe(0);
  });

  it("arrives on /home with the veil down before scrolling", async () => {
    const { log, ctx } = recorder();
    await manifest.play(ctx);
    expect(log[0]).toEqual(["setScreen", "/home"]);
    expect(log[1]).toEqual(["veil", false]);
  });

  it("marks manifest-scrolled once the scroll down is spent, then veils before teaching", async () => {
    const { log, ctx } = recorder();
    await manifest.play(ctx);
    const scrolled = log.findIndex(([word, name]) => word === "mark" && name === "manifest-scrolled");
    const veilTrue = log.findIndex(([word, on]) => word === "veil" && on === true);
    const gotoToday = log.findIndex(([word, sel]) => word === "goto" && sel === SELECTORS.DESK.today);
    expect(scrolled).toBeGreaterThan(-1);
    expect(veilTrue).toBeGreaterThan(scrolled);
    expect(veilTrue).toBeLessThan(gotoToday);
  });

  it("says its one ratified line, pinned to today with its mark", async () => {
    const { log, ctx } = recorder();
    await manifest.play(ctx);
    const said = log.filter(([word]) => word === "callout").map(([, text, sel, side, mark]) => [text, sel, side, mark]);
    expect(said).toEqual([
      ["The manifest lists what's ahead, nearest first.", SELECTORS.DESK.today, "left", "manifest-today"],
    ]);
  });

  it("visits today alone, never pressing it, and no row since the row's line was cut (#1174)", async () => {
    const { log, ctx } = recorder();
    await manifest.play(ctx);
    const visited = log.filter(([word]) => word === "goto").map(([, sel, willPress]) => [sel, willPress]);
    expect(visited).toEqual([
      [SELECTORS.DESK.today, false],
    ]);
    expect(log.some(([word]) => word === "press")).toBe(false);
  });

  it("veils down again before scrolling back up, and ends veil-free", async () => {
    const { log, ctx } = recorder();
    await manifest.play(ctx);
    const todayUnlit = log.findIndex(([word, sels]) => word === "unlight" && sels?.includes?.(SELECTORS.DESK.today));
    expect(todayUnlit).toBeGreaterThan(-1);
    const lastVeil = log.filter(([word]) => word === "veil").at(-1);
    expect(lastVeil).toEqual(["veil", false]);
    const veilFalseAfterToday = log.findIndex(
      ([word, on], i) => word === "veil" && on === false && i > todayUnlit,
    );
    expect(veilFalseAfterToday).toBeGreaterThan(todayUnlit);
  });
});

describe("the chapter played for real", () => {
  it("puts its one line on the screen, against a manifest with items", async () => {
    drawHome({ rows: 2 });
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document });
    clock.setPlaying(true);

    const seen = new Set();
    const said = [];
    const sample = () => {
      for (const note of document.querySelectorAll(".tourfilm-callout")) {
        if (seen.has(note)) continue;
        seen.add(note);
        said.push(note.textContent);
      }
    };

    let done = false;
    const playing = manifest.play(ctx).then(() => { done = true; }, () => { done = true; });
    let spent = 0;
    while (!done && spent < 400000) {
      clock.advance(100);
      spent += 100;
      await settle();
      sample();
    }
    await playing;
    sample();

    expect(said).toEqual([
      "The manifest lists what's ahead, nearest first.",
    ]);
    ctx.destroy();
  });

  it("leaves home's own DOM exactly as it found it", async () => {
    drawHome({ rows: 2 });
    const before = document.getElementById("page").outerHTML;
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document });
    clock.setPlaying(true);
    await playOut(clock, manifest.play(ctx));
    ctx.destroy();
    expect(document.getElementById("page").outerHTML).toBe(before);
  });

  it("plays the same beats, for the same length, whether the manifest is full or empty", async () => {
    const lengthWith = async (rows) => {
      drawHome({ rows });
      const clock = createClock({ reducedMotion: () => false });
      const ctx = createFilmContext({ clock, doc: document });
      clock.setPlaying(true);
      await playOut(clock, manifest.play(ctx));
      const spent = clock.sched();
      ctx.destroy();
      return spent;
    };
    /* The transport measured this tick before the film played, so a chapter
       whose length depended on the manifest's contents would land every
       later jump in the wrong place. Empty corridor or five rows deep,
       chapter 4 runs the same. */
    expect(await lengthWith(0)).toBe(await lengthWith(5));
  });
});
