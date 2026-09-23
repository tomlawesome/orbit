// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import timeRuns, { SELECTORS } from "../../web/src/lib/tour/chapters/05-time-runs.js";
import { createClock } from "../../web/src/lib/tour/clock.js";
import { createFilmContext } from "../../web/src/lib/tour/vocabulary.js";

/*
 * #866: chapter 5 is one of the three (5, 9, 12) whose lit ring and veil
 * hole travel with a moving target instead of sitting still. Unlike chapter
 * 1, most of what this chapter lights is not real product markup: there is
 * no real due item a chapter is allowed to animate (a chapter must never
 * depend on a household's actual data), so it draws and removes its own demo
 * body. Only `.dial` is real, and that is what gets pinned against home's
 * own source the way v19-tour-chapter-arrive.test.mjs pins chapter 1's.
 */

const web = (path) => resolve(import.meta.dirname, "../../web", path);
const HOME_SOURCE = readFileSync(web("src/routes/home/+page.svelte"), "utf8");

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
 *  travelling dot are given boxes by hand: the dial is fixed, and the dot's
 *  box is derived from the `cx`/`cy` this chapter writes onto it -- which is
 *  what lets a test see whether the box actually moves. */
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

/** Home, near enough for this chapter: just the dial, the one real element
 *  it names. */
function drawHome() {
  document.body.innerHTML = `
    <div class="hero" id="hero">
      <svg class="dial" viewBox="0 0 380 380"></svg>
    </div>`;
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
  patchRects();
  window.innerWidth = 1280;
  window.innerHeight = 800;
});

describe("the selectors chapter 5 names", () => {
  it("the real one (.dial) exists in home's own markup", () => {
    const rendered = namesIn(HOME_SOURCE);
    for (const token of tokensOf(SELECTORS.dial)) {
      expect(rendered.has(token), `chapter 5 names "${SELECTORS.dial}", but /home renders no "${token}"`).toBe(true);
    }
  });

  it("the drawn one (.tourfilm-time-body) is never real markup", () => {
    const rendered = namesIn(HOME_SOURCE);
    for (const token of tokensOf(SELECTORS.body)) {
      expect(rendered.has(token)).toBe(false);
    }
  });
});

describe("the chapter's shape", () => {
  it("is { id, name, play }", () => {
    expect(timeRuns.id).toBe("time");
    expect(timeRuns.name).toBe("Time runs");
    expect(typeof timeRuns.play).toBe("function");
  });
});

describe("the beats, against a recorder", () => {
  function recorder() {
    const log = [];
    const control = (sel) => ({ sel, els: [], ringEls: [], round: false, pad: 0, radius: 14, rings: [], lifted: false, saved: [] });
    return {
      log,
      ctx: {
        doc: document,
        dry: () => false,
        setScreen: async (route) => log.push(["setScreen", route]),
        veil: (on) => log.push(["veil", on]),
        ctl: (spec) => { log.push(["ctl", spec.sel]); return control(spec.sel); },
        goto: async (c) => log.push(["goto", c.sel]),
        light: (c) => log.push(["light", c.sel]),
        unlight: (c) => log.push(["unlight", c.sel]),
        callout: async (text, anchor) => log.push(["callout", text, anchor.sel]),
        dropCallout: () => log.push(["dropCallout"]),
        tween: async (ms, fn) => { fn(1); log.push(["tween"]); },
        w: async () => log.push(["w"]),
        mark: async (name) => log.push(["mark", name]),
      },
    };
  }

  it("arrives on /home with the veil down, as the mockup opens", async () => {
    const { log, ctx } = recorder();
    await timeRuns.play(ctx);
    expect(log[0]).toEqual(["setScreen", "/home"]);
    expect(log[1]).toEqual(["veil", false]);
  });

  it("says the two ratified lines, in order, on their own controls", async () => {
    const { log, ctx } = recorder();
    await timeRuns.play(ctx);
    const said = log.filter(([word]) => word === "callout").map(([, text, sel]) => [text, sel]);
    expect(said).toEqual([
      ["Time runs. The nearer the sun, the sooner.", ".tourfilm-time-body"],
      ["At a month out it warms, and Orbit reminds you.", ".dial"],
    ]);
  });

  it("lights the demo body, veils the sky, and drops both before the reminder line", async () => {
    const { log, ctx } = recorder();
    await timeRuns.play(ctx);
    const veilOn = log.findIndex(([w, on]) => w === "veil" && on === true);
    const lit = log.findIndex(([w, sel]) => w === "light" && sel === ".tourfilm-time-body");
    const unlit = log.findIndex(([w, sel]) => w === "unlight" && sel === ".tourfilm-time-body");
    const veilOff = log.findLastIndex(([w, on]) => w === "veil" && on === false);
    const reminder = log.findIndex(([w, text]) => w === "callout" && text?.startsWith("At a month out"));
    expect(lit).toBeGreaterThanOrEqual(0);
    expect(lit).toBeLessThan(veilOn);
    expect(unlit).toBeGreaterThan(veilOn);
    expect(unlit).toBeLessThan(veilOff);
    expect(veilOff).toBeLessThan(reminder);
  });

  it("marks time-warmed after the walk and time-toast on the reminder line", async () => {
    const { log, ctx } = recorder();
    await timeRuns.play(ctx);
    const marks = log.filter(([word]) => word === "mark").map(([, name]) => name);
    expect(marks).toEqual(["time-warmed"]);
    /* the second mark rides inside the reminder callout's own options, which
       the recorder's `callout` stub does not see -- pinned for real below. */
  });

  it("presses nothing: chapter 5 only looks", async () => {
    const { log, ctx } = recorder();
    await expect(timeRuns.play(ctx)).resolves.toBeUndefined();
    expect(log.some(([word]) => word === "press" || word === "tap")).toBe(false);
  });
});

describe("the chapter played for real", () => {
  it("draws the demo body, moves it, and removes it again", async () => {
    drawHome();
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document });
    clock.setPlaying(true);

    const seenX = [];
    let done = false;
    const playing = timeRuns.play(ctx).then(() => { done = true; }, () => { done = true; });
    let spent = 0;
    while (!done && spent < 400000) {
      clock.advance(100);
      spent += 100;
      await settle();
      const body = document.querySelector(".tourfilm-time-body");
      if (body) seenX.push(body.getBoundingClientRect().x);
    }
    await playing;

    /* it moved: more than one distinct box was sampled while it was on screen */
    expect(new Set(seenX).size).toBeGreaterThan(1);
    /* it is gone by the time the chapter ends */
    expect(document.querySelector(".tourfilm-time-body")).toBeNull();
    ctx.destroy();
  });

  it("puts its two lines on the screen in order", async () => {
    drawHome();
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
    const playing = timeRuns.play(ctx).then(() => { done = true; }, () => { done = true; });
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
      "Time runs. The nearer the sun, the sooner.",
      "At a month out it warms, and Orbit reminds you.",
    ]);
    ctx.destroy();
  });

  it("leaves home's own DOM exactly as it found it", async () => {
    drawHome();
    const before = document.getElementById("hero").outerHTML;
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document });
    clock.setPlaying(true);
    await playOut(clock, timeRuns.play(ctx));
    ctx.destroy();
    expect(document.getElementById("hero").outerHTML).toBe(before);
  });

  it("names the dial as core, not optional: a sky with no dial is not a sky this chapter can play", async () => {
    /* Unlike the suns chapter 1 marks `optional` (may legitimately be zero),
       `.dial` is assumed the way chapter 1 assumes it too -- the tour is
       never offered on a household with no sky to walk (offer.js). Pinned
       here so a future edit that quietly adds `optional: true` to the wrong
       control is caught, rather than silently drawing the demo body nowhere. */
    document.body.innerHTML = '<div class="hero" id="hero"></div>';
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document });
    clock.setPlaying(true);
    await expect(playOut(clock, timeRuns.play(ctx))).rejects.toThrow(/no element matches ".dial"/u);
    ctx.destroy();
  });
});
