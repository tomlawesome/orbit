// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import add, { SELECTORS } from "../../web/src/lib/tour/chapters/02-add.js";
import { createClock } from "../../web/src/lib/tour/clock.js";
import { TOUR_STOPS } from "../../web/src/lib/tour/stops.js";
import { createFilmContext, T } from "../../web/src/lib/tour/vocabulary.js";

/*
 * #866: chapter 2 opens home's own north star and lands on the considered
 * form at /create (web/src/routes/create/+page.svelte) — the mockup's
 * "create.png" screen, which in the product is what the drawer's own "open
 * the full form" link leads to (CON-12). See 02-add.js's own header for the
 * two places this chapter could not follow the mockup literally: there is no
 * typed-text mechanic in vocabulary.js, and no standalone "#c-year" chip —
 * the real recurrence control is a `<select>` already defaulted to yearly.
 *
 * THE POINT OF THIS FILE, same as chapter 1's: every selector the chapter
 * names must EXIST in the real markup it names it against, so a rename fails
 * loudly here instead of silently lighting nothing when the film plays.
 */

const web = (path) => resolve(import.meta.dirname, "../../web", path);

/* #nstar lives on home's own screen. */
const HOME_SOURCE = [
  "src/routes/home/+page.svelte",
  "src/routes/home/home.behaviour.js",
].map((file) => readFileSync(web(file), "utf8")).join("\n");

/* Every other control this chapter names lives on the considered form. */
const CREATE_SOURCE = readFileSync(web("src/routes/create/+page.svelte"), "utf8");

const ALL_SOURCE = `${HOME_SOURCE}\n${CREATE_SOURCE}`;

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

/** The class and id names one CSS selector depends on (ignores attribute
 *  selectors like `[data-type="inspection"]` — those are checked separately
 *  below, against the literal attribute text). */
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

function drawHome() {
  document.body.innerHTML = `
    <aside class="drawer-top" id="createdrawer" role="region" aria-label="Add to your orbit">
      <button class="nstar" id="nstar" aria-expanded="false" title="Add to your orbit"></button>
    </aside>`;
  box(document.getElementById("nstar"), { x: 618, y: 0, w: 44, h: 44 });
}

function drawCreate() {
  document.body.innerHTML = `
    <form class="glass card" id="card">
      <input id="f-name" class="name-title" value="New Entry" aria-label="name">
      <div class="field">
        <div class="types" id="types">
          <button type="button" data-type="service" aria-pressed="false">service</button>
          <button type="button" data-type="renewal" aria-pressed="false">renewal</button>
          <button type="button" data-type="inspection" aria-pressed="false">inspection</button>
        </div>
      </div>
      <div class="daterow">
        <div class="field f-date" id="field-date">
          <input id="f-date" type="date">
        </div>
        <div class="field f-recur">
          <select id="f-recur">
            <option value="once">one-off</option>
            <option value="monthly">monthly</option>
            <option value="yearly" selected>yearly</option>
          </select>
        </div>
      </div>
      <div class="field" id="field-cost">
        <input id="f-cost" type="number">
      </div>
      <div class="save-row">
        <button type="submit" class="btn-primary">Add to orbit</button>
      </div>
    </form>`;
  box(document.getElementById("card"), { x: 340, y: 234, w: 600, h: 332 });
  box(document.getElementById("f-name"), { x: 373, y: 259, w: 218, h: 38 });
  box(document.querySelector('#types button[data-type="inspection"]'), { x: 583, y: 351, w: 126, h: 37 });
  box(document.getElementById("f-date"), { x: 373, y: 447, w: 268, h: 38 });
  box(document.getElementById("f-cost"), { x: 657, y: 447, w: 249, h: 38 });
  box(document.getElementById("f-recur"), { x: 457, y: 498, w: 120, h: 39 });
  box(document.querySelector("#card .btn-primary"), { x: 798, y: 498, w: 108, h: 39 });
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

describe("the selectors chapter 2 names", () => {
  it("every plain class/id one of them depends on exists in the real markup", () => {
    const rendered = namesIn(ALL_SOURCE);
    for (const [beat, selector] of Object.entries(SELECTORS)) {
      for (const token of tokensOf(selector)) {
        expect(
          rendered.has(token),
          `chapter 2's "${beat}" names "${selector}", but no real screen renders a "${token}"`,
        ).toBe(true);
      }
    }
  });

  it('names the real "inspection" type chip by its actual data-type attribute', () => {
    expect(SELECTORS.inspection).toBe('#types button[data-type="inspection"]');
    expect(CREATE_SOURCE).toContain('data-type="inspection"');
  });

  it("names the same north star the ratified walk's create stop already points at", () => {
    const create = TOUR_STOPS.find((stop) => stop.id === "create");
    expect(create.target).toContain("#nstar");
    expect(SELECTORS.star).toBe("#nstar");
    /* the ratified line this chapter's drawer callout says, verbatim */
    expect(create.copy[0]).toBe("Add anything here, by hand or by forwarding a document.");
  });
});

describe("the chapter's shape", () => {
  it("is { id, name, play }", () => {
    expect(add.id).toBe("add");
    expect(add.name).toBe("Add");
    expect(typeof add.play).toBe("function");
  });
});

describe("the beats, in the mockup's order", () => {
  /** Records what the chapter asks the vocabulary to do, without touching a
   *  real document — lifted from v19-tour-chapter-arrive.test.mjs's own. */
  function recorder() {
    const log = [];
    const control = (sel) => ({ sel, els: [], ringEls: [], round: false, pad: 0, radius: 14, rings: [], lifted: false, saved: [] });
    return {
      log,
      ctx: {
        setScreen: async (route) => log.push(["setScreen", route]),
        veil: (on) => log.push(["veil", on]),
        ctl: (spec) => {
          log.push(["ctl", spec.sel]);
          return control(spec.sel);
        },
        goto: async (c, o) => log.push(["goto", c.sel, o?.willPress ?? true]),
        press: async (c) => log.push(["press", c.sel]),
        quiet: (c) => log.push(["quiet", c.sel]),
        light: (...cs) => log.push(["light", cs.map((c) => c.sel)]),
        unlight: (...cs) => log.push(["unlight", cs.map((c) => c.sel)]),
        callout: async (text, anchor, side, o) => log.push(["callout", text, anchor.sel, side, o?.mark]),
        dropCallout: () => log.push(["dropCallout"]),
        mark: async (name) => log.push(["mark", name]),
        w: async (ms) => log.push(["w", ms]),
        T,
      },
    };
  }

  it("opens on /home, veiled only once the star is approached", async () => {
    const { log, ctx } = recorder();
    await add.play(ctx);
    expect(log[0]).toEqual(["setScreen", "/home"]);
    expect(log[1]).toEqual(["veil", false]);
    const veilTrue = log.findIndex(([word, on]) => word === "veil" && on === true);
    const gotoStar = log.findIndex(([word, sel]) => word === "goto" && sel === SELECTORS.star);
    expect(veilTrue).toBeGreaterThan(-1);
    expect(veilTrue).toBeLessThan(gotoStar);
  });

  it("presses the star, marks it, then opens the considered form at /create", async () => {
    const { log, ctx } = recorder();
    await add.play(ctx);
    const pressStar = log.findIndex(([word, sel]) => word === "press" && sel === SELECTORS.star);
    const markStar = log.findIndex(([word, name]) => word === "mark" && name === "add-star");
    const setCreate = log.findIndex(([word, route]) => word === "setScreen" && route === "/create");
    expect(pressStar).toBeGreaterThan(-1);
    expect(markStar).toBeGreaterThan(pressStar);
    expect(setCreate).toBeGreaterThan(markStar);
  });

  it("says the ratified drawer line once, pinned to the whole form", async () => {
    const { log, ctx } = recorder();
    await add.play(ctx);
    const said = log.filter(([word]) => word === "callout").map(([, text, sel, side, mark]) => [text, sel, side, mark]);
    expect(said).toEqual([
      ["Add anything here, by hand or by forwarding a document.", SELECTORS.card, "top", "add-drawer"],
    ]);
  });

  it("visits every field once, in the mockup's order, and marks add-typing, add-yearly, add-add", async () => {
    const { log, ctx } = recorder();
    await add.play(ctx);
    const visited = log.filter(([word]) => word === "goto").map(([, sel]) => sel);
    expect(visited).toEqual([
      SELECTORS.star,
      SELECTORS.card,
      SELECTORS.name,
      SELECTORS.inspection,
      SELECTORS.due,
      SELECTORS.cost,
      SELECTORS.recurrence,
      SELECTORS.add,
    ]);
    /* "add-drawer" is not here: it travels as the drawer callout's own
       `mark` option (checked above), which only the real film context
       turns into a `mark()` call -- this recorder logs `callout` itself,
       not what it triggers internally. */
    const marks = log.filter(([word]) => word === "mark").map(([, name]) => name);
    expect(marks).toEqual(["add-star", "add-typing", "add-yearly", "add-add"]);
  });

  it("leaves the add button lit at the end, for the next chapter to inherit", async () => {
    const { log, ctx } = recorder();
    await add.play(ctx);
    const lastGoto = log.filter(([word]) => word === "goto").at(-1);
    expect(lastGoto).toEqual(["goto", SELECTORS.add, true]);
    const unlitAdd = log.some(([word, sels]) => word === "unlight" && sels?.includes?.(SELECTORS.add));
    expect(unlitAdd).toBe(false);
  });
});

describe("the chapter played for real", () => {
  it("runs to completion against real home and create markup without a missing control", async () => {
    let route = "/home";
    drawHome();
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({
      clock,
      doc: document,
      routeOf: () => route,
      navigate: async (to) => {
        route = to;
        if (to === "/create") drawCreate();
        else drawHome();
      },
      settle: async () => {},
    });
    clock.setPlaying(true);
    await playOut(clock, add.play(ctx));
    ctx.destroy();
    expect(route).toBe("/create");
  });
});
