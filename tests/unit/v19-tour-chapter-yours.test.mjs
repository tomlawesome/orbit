// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import yours, { SELECTORS } from "../../web/src/lib/tour/chapters/12-yours.js";
import { createClock } from "../../web/src/lib/tour/clock.js";
import { createFilmContext } from "../../web/src/lib/tour/vocabulary.js";

/*
 * #866: chapter 12 is the film's closing chapter, and one of the three (5,
 * 9, 12) whose lit ring and veil hole travel with a moving target instead of
 * sitting still -- pinned here the way v19-tour-chapter-time-runs.test.mjs
 * pins chapter 5's own travelling demo body. Only `.dial` and `.sun-link`
 * are real product markup; `.tourfilm-year-body` is drawn and removed by
 * this chapter alone, so it is pinned by running the chapter instead.
 *
 * Because this is the LAST chapter, this file also proves it leaves nothing
 * behind: no demo scenery still drawn on the real DOM, and no theme left
 * worn that the reader did not choose -- this chapter never calls `wear` at
 * all, trusting chapter 11's own closing `wear(null)` to have already put
 * the reader's own pack back.
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

/** happy-dom computes no real SVG layout, so the dial and this chapter's own
 *  travelling dot are given boxes by hand: the dial is fixed, and the dot's
 *  box is derived from the `cx`/`cy` this chapter writes onto it -- which is
 *  what lets a test see whether the box actually moves. Lifted from
 *  v19-tour-chapter-time-runs.test.mjs, which patches chapter 5's own demo
 *  dot the same way. */
function patchRects() {
  window.SVGElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains("dial")) return rect(390, 150, 500, 500);
    const dot = this.classList.contains("tourfilm-year-dot")
      ? this
      : this.querySelector(".tourfilm-year-dot");
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

/** Home, near enough for this chapter: the dial and this household's own
 *  sun, boxed the same way v19-tour-chapter-arrive.test.mjs boxes them. */
function drawHome() {
  document.body.innerHTML = `
    <div class="hero" id="hero">
      <svg class="dial"><g class="chrome"></g></svg>
      <a class="sun-link"></a>
    </div>`;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains("sun-link")) return rect(616, 376, 48, 48);
    return rect(0, 0, 0, 0);
  };
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

describe("the selectors chapter 12 names", () => {
  it("the real ones (.dial, .sun-link) exist in home's own markup", () => {
    const rendered = namesIn(HOME_SOURCE);
    for (const [beat, selector] of [["dial", SELECTORS.dial], ["sun", SELECTORS.sun]]) {
      for (const token of tokensOf(selector)) {
        expect(
          rendered.has(token),
          `chapter 12's "${beat}" names "${selector}", but /home renders no "${token}"`,
        ).toBe(true);
      }
    }
  });

  it("names the same sun the ratified walk and chapter 1 already point at", () => {
    expect(SELECTORS.sun).toBe(".sun-link");
  });

  it("the drawn one (.tourfilm-year-body) is never real markup", () => {
    const rendered = namesIn(HOME_SOURCE);
    for (const token of tokensOf(SELECTORS.body)) {
      expect(rendered.has(token)).toBe(false);
    }
  });
});

describe("the chapter's shape", () => {
  /* Position in the registry (last of twelve) is the orchestrator's own
     wiring in chapters/index.js, not this chapter's file to touch or this
     test's to assert -- pinned here is only the { id, name, play } shape
     every chapter file must have, the way chapter 1's own test pins it. */
  it("is { id, name, play }", () => {
    expect(yours.id).toBe("yours");
    expect(yours.name).toBe("Yours");
    expect(typeof yours.play).toBe("function");
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
    await yours.play(ctx);
    expect(log[0]).toEqual(["setScreen", "/home"]);
    expect(log[1]).toEqual(["veil", false]);
  });

  it("says the film's corrected closing lines, in order, pinned on the sun", async () => {
    const { log, ctx } = recorder();
    await yours.play(ctx);
    const said = log.filter(([word]) => word === "callout").map(([, text, sel]) => [text, sel]);
    expect(said).toEqual([
      ["That was a year, in one turn of the ring.", ".sun-link"],
      ["Now it's yours.", ".sun-link"],
    ]);
  });

  it("never says round 1's stale line", async () => {
    const { log, ctx } = recorder();
    await yours.play(ctx);
    const said = log.filter(([word]) => word === "callout").map(([, text]) => text);
    expect(said.join(" ")).not.toContain("in a minute");
  });

  /* Chapter 12 NEVER raises the veil, and that is the closing chapter's whole
     point. It is one of only two chapters in the ratified film that does not
     (the other is 5): the mockup opens it `veil(false)` and never calls
     `veil(true)` again (design/v19/tour/round-5/f-one-take.html:1104).
     "Now it's yours." is said over the reader's whole sky, undimmed —
     dimming it to spotlight one control would be the opposite of handing it
     over.

     This test previously asserted the opposite, because the chapter was
     built raising the veil, because veil.js's comment named "chapters
     5/9/12's travelling hole" and that reads as an instruction. It is not:
     it describes the mask being able to follow a moving hole. What travels
     here is the RING, not a hole. Chapter 5 made the same mistake from the
     same line. */
  it("lights the demo body and drops it before the sun is visited, without ever veiling", async () => {
    const { log, ctx } = recorder();
    await yours.play(ctx);
    const lit = log.findIndex(([w, sel]) => w === "light" && sel === ".tourfilm-year-body");
    const unlit = log.findIndex(([w, sel]) => w === "unlight" && sel === ".tourfilm-year-body");
    const gotoSun = log.findIndex(([w, sel]) => w === "goto" && sel === ".sun-link");
    expect(lit).toBeGreaterThanOrEqual(0);
    expect(unlit).toBeGreaterThan(lit);
    expect(unlit).toBeLessThan(gotoSun);
    /* The sky the film hands back is never dimmed: the only veil call is the
       chapter's own opening `veil(false)`, clearing what chapter 11 left. */
    expect(log.filter(([w, on]) => w === "veil" && on === true)).toEqual([]);
    expect(log.filter(([w]) => w === "veil").map(([, on]) => on)).toEqual([false]);
  });

  it("marks yours-year after the walk", async () => {
    const { log, ctx } = recorder();
    await yours.play(ctx);
    const marks = log.filter(([word]) => word === "mark").map(([, name]) => name);
    expect(marks).toEqual(["yours-year"]);
    /* yours-year-line and yours-close ride inside the two callouts' own
       options, which the recorder's `callout` stub does not see -- pinned
       for real below. */
  });

  it("presses nothing: chapter 12 only looks", async () => {
    const { log, ctx } = recorder();
    await expect(yours.play(ctx)).resolves.toBeUndefined();
    expect(log.some(([word]) => word === "press" || word === "tap")).toBe(false);
  });
});

describe("the chapter played for real", () => {
  it("draws the demo body, runs it in and back out, and removes it again", async () => {
    drawHome();
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document });
    clock.setPlaying(true);

    const seenX = [];
    let done = false;
    const playing = yours.play(ctx).then(() => { done = true; }, () => { done = true; });
    let spent = 0;
    while (!done && spent < 400000) {
      clock.advance(100);
      spent += 100;
      await settle();
      const body = document.querySelector(".tourfilm-year-body");
      if (body) seenX.push(body.getBoundingClientRect().x);
    }
    await playing;

    /* it moved: more than one distinct box was sampled while it was on
       screen, both travelling in and travelling back out */
    expect(new Set(seenX).size).toBeGreaterThan(1);
    /* it is gone by the time the chapter ends */
    expect(document.querySelector(".tourfilm-year-body")).toBeNull();
    ctx.destroy();
  });

  it("puts its two closing lines on the screen in order", async () => {
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
    const playing = yours.play(ctx).then(() => { done = true; }, () => { done = true; });
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
      "That was a year, in one turn of the ring.",
      "Now it's yours.",
    ]);
    ctx.destroy();
  });

  it("leaves home's own DOM exactly as it found it", async () => {
    drawHome();
    const before = document.getElementById("hero").outerHTML;
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document });
    clock.setPlaying(true);
    await playOut(clock, yours.play(ctx));
    ctx.destroy();
    expect(document.getElementById("hero").outerHTML).toBe(before);
  });

  it("being the last chapter, leaves nothing behind: no demo scenery, and the reader's own theme untouched", async () => {
    drawHome();
    /* whatever pack the reader is actually wearing -- this chapter must
       never know or care, because it never calls `wear` itself */
    document.documentElement.dataset.theme = "clouds";
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document });
    clock.setPlaying(true);
    await playOut(clock, yours.play(ctx));
    ctx.destroy();

    expect(document.querySelector(".tourfilm-year-body")).toBeNull();
    expect(document.querySelectorAll(".tourfilm-ring, .tourfilm-callout, .tourfilm-typed").length).toBe(0);
    expect(document.documentElement.dataset.theme).toBe("clouds");
  });

  it("names the dial as core, not optional: a sky with no dial is not a sky this chapter can play", async () => {
    document.body.innerHTML = '<div class="hero" id="hero"><a class="sun-link"></a></div>';
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document });
    clock.setPlaying(true);
    await expect(playOut(clock, yours.play(ctx))).rejects.toThrow(/no element matches ".dial"/u);
    ctx.destroy();
  });

  it("names the sun as core, not optional: the closing lines need somewhere to land", async () => {
    document.body.innerHTML = '<div class="hero" id="hero"><svg class="dial"></svg></div>';
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document });
    clock.setPlaying(true);
    await expect(playOut(clock, yours.play(ctx))).rejects.toThrow(/no element matches ".sun-link"/u);
    ctx.destroy();
  });
});
