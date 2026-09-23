// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import arrive, { SELECTORS } from "../../web/src/lib/tour/chapters/01-arrive.js";
import { CHAPTERS } from "../../web/src/lib/tour/chapters/index.js";
import { createClock } from "../../web/src/lib/tour/clock.js";
import { TOUR_STOPS } from "../../web/src/lib/tour/stops.js";
import { createFilmContext } from "../../web/src/lib/tour/vocabulary.js";

/*
 * #866: chapter 1 is the worked example the other eleven are cut from, so
 * what is pinned here is pinned for all twelve.
 *
 * THE POINT OF THIS FILE is the first block: every selector the chapter
 * names must EXIST in the markup it names it against. A film that points at
 * a class nobody renders explains nothing, and does it silently — the whole
 * risk of trading the mockup's hard-coded coordinates for selectors. The
 * screens move; the film does not notice. This is what makes it notice, and
 * it is the same check tests/unit/v19-tour-stops.test.mjs already runs for
 * the eight-stop walk.
 *
 * Also pinned: the ratified copy character for character (it is the same
 * copy stops.js carries, which is where it was ratified), the beat order
 * from the mockup's first CH entry, and the rule every chapter must keep —
 * the same beats, of the same length, whatever is on the screen, because
 * the transport measured the ticks before the film played.
 */

const web = (path) => resolve(import.meta.dirname, "../../web", path);

/* Where home's markup actually lives: the desk page and the behaviour module
   that writes the other households' suns into it. */
const HOME_SOURCE = [
  "src/routes/home/+page.svelte",
  "src/routes/home/home.behaviour.js",
].map((file) => readFileSync(web(file), "utf8")).join("\n");

/** Every name home's source assigns to a class or an id, however it writes
 *  it — literal, Svelte expression, or DOM assignment. Lifted from
 *  v19-tour-stops.test.mjs, which pins the eight-stop walk the same way. */
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

/** Home, near enough for the film: the dial, this household's sun, and two
 *  other households out in the sky. */
function drawHome({ others = 2 } = {}) {
  document.body.innerHTML = `
    <div class="hero" id="hero">
      <svg class="dial"><g class="chrome"></g><a class="sun-link"></a></svg>
      ${Array.from({ length: others }, () => '<div class="minisys"></div>').join("")}
    </div>`;
  box(document.querySelector(".dial"), { x: 390, y: 150, w: 500, h: 500 });
  box(document.querySelector(".sun-link"), { x: 616, y: 376, w: 48, h: 48 });
  [...document.querySelectorAll(".minisys")].forEach((sun, k) => {
    box(sun, { x: 1053 - k * 700, y: 235 + k * 300, w: 96, h: 96 });
  });
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

describe("the selectors chapter 1 names", () => {
  it("every one of them exists in home's own markup", () => {
    const rendered = namesIn(HOME_SOURCE);
    for (const [beat, selector] of Object.entries(SELECTORS)) {
      for (const token of tokensOf(selector)) {
        expect(
          rendered.has(token),
          `chapter 1's "${beat}" names "${selector}", but /home renders no "${token}"`,
        ).toBe(true);
      }
    }
  });

  it("names the same chart and sun the ratified walk already points at", () => {
    /* stops.js is where these were ratified; the film must not drift off
       onto its own idea of where the star chart is. */
    const chart = TOUR_STOPS.find((stop) => stop.id === "chart");
    const sun = TOUR_STOPS.find((stop) => stop.id === "sun");
    expect(chart.target).toContain(".dial");
    expect(SELECTORS.dial).toBe(".dial");
    expect(sun.target).toContain(".sun-link");
    expect(SELECTORS.sun).toBe(".sun-link");
  });
});

describe("the chapter's shape", () => {
  it("is { id, name, play } and is first in the registry", () => {
    expect(arrive.id).toBe("arrive");
    expect(arrive.name).toBe("Arrive");
    expect(typeof arrive.play).toBe("function");
    expect(CHAPTERS[0]).toBe(arrive);
  });
});

describe("the beats, in the mockup's order", () => {
  /** Records what the chapter asks the vocabulary to do. */
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
        goto: async (c) => log.push(["goto", c.sel]),
        light: (c) => log.push(["light", c.sel]),
        unlight: (c) => log.push(["unlight", c.sel]),
        callout: async (text, anchor) => log.push(["callout", text, anchor.sel]),
        dropCallout: () => log.push(["dropCallout"]),
      },
    };
  }

  it("arrives on /home with the veil down, as the mockup opens", async () => {
    const { log, ctx } = recorder();
    await arrive.play(ctx);
    expect(log[0]).toEqual(["setScreen", "/home"]);
    expect(log[1]).toEqual(["veil", false]);
  });

  it("says the four ratified lines, in order, each pinned to its own control", async () => {
    const { log, ctx } = recorder();
    await arrive.play(ctx);
    const said = log.filter(([word]) => word === "callout").map(([, text, sel]) => [text, sel]);
    expect(said).toEqual([
      ["This is your star chart.", ".dial"],
      ["Every sun is a household you belong to.", ".sun-link"],
      ["That's your sun, at centre — your household, always here.", ".sun-link"],
      ["The rest of the sky holds systems you don't belong to — tap one to ask to join.", ".minisys"],
    ]);
  });

  it("lights the other suns for the first line and drops them for the second", async () => {
    const { log, ctx } = recorder();
    await arrive.play(ctx);
    const order = log
      .filter(([word, a]) => (word === "light" || word === "unlight" || word === "callout") && (a === ".minisys" || word === "callout"))
      .map(([word, a, sel]) => (word === "callout" ? `say:${sel}` : `${word}:${a}`));
    /* the outer suns come up for "every sun", and are gone before the line
       about the centre one is read */
    expect(order).toContain("light:.minisys");
    const lit = order.indexOf("light:.minisys");
    const unlit = order.indexOf("unlight:.minisys");
    const centreLine = order.lastIndexOf("say:.sun-link");
    expect(lit).toBeLessThan(unlit);
    expect(unlit).toBeLessThan(centreLine);
  });

  it("presses nothing: chapter 1 only looks", async () => {
    const { log, ctx } = recorder();
    /* `press` and `tap` are absent from the recorder, so a chapter reaching
       for either would throw rather than pass quietly. */
    await expect(arrive.play(ctx)).resolves.toBeUndefined();
    expect(log.some(([word]) => word === "press" || word === "tap")).toBe(false);
  });
});

describe("the chapter played for real", () => {
  it("puts its four lines on the screen in order", async () => {
    drawHome();
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document });
    clock.setPlaying(true);

    /* Each callout node is recorded once, the first frame it exists: a
       departing one lingers for its fade beside its successor, so sampling
       by identity is what gives the order the reader actually sees. */
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
    const playing = arrive.play(ctx).then(() => { done = true; }, () => { done = true; });
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
      "This is your star chart.",
      "Every sun is a household you belong to.",
      "That's your sun, at centre — your household, always here.",
      "The rest of the sky holds systems you don't belong to — tap one to ask to join.",
    ]);
    ctx.destroy();
  });

  it("leaves home's own DOM exactly as it found it", async () => {
    drawHome();
    const before = document.getElementById("hero").outerHTML;
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document });
    clock.setPlaying(true);
    await playOut(clock, arrive.play(ctx));
    ctx.destroy();
    expect(document.getElementById("hero").outerHTML).toBe(before);
  });

  it("plays the same beats, for the same length, on a household alone in its sky", async () => {
    const lengthWith = async (others) => {
      drawHome({ others });
      const clock = createClock({ reducedMotion: () => false });
      const ctx = createFilmContext({ clock, doc: document });
      clock.setPlaying(true);
      await playOut(clock, arrive.play(ctx));
      const spent = clock.sched();
      ctx.destroy();
      return spent;
    };
    /* The transport measured the ticks before the film played, so a chapter
       whose length depended on the data would land every later jump in the
       wrong sentence. Four suns or none, chapter 1 runs the same. */
    expect(await lengthWith(0)).toBe(await lengthWith(4));
  });
});
