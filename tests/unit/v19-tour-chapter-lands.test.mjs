// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import lands, { SELECTORS } from "../../web/src/lib/tour/chapters/03-lands.js";
import { createClock } from "../../web/src/lib/tour/clock.js";
import { createFilmContext } from "../../web/src/lib/tour/vocabulary.js";

/*
 * #866: chapter 3 returns to home after chapter 2's create drawer. Nothing
 * chapter 2 did was ever really saved (`press()` never dispatches a click),
 * so there is no real due item this chapter is allowed to point at — a
 * chapter must never depend on a household's actual data. It draws and
 * removes its own demo body instead, the way chapter 5 ("Time runs") draws
 * its own. Only `.dial` is real, and that is what gets pinned against
 * home's own source the way v19-tour-chapter-arrive.test.mjs pins
 * chapter 1's.
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
 *  demo body are given boxes by hand, the dot's derived from the `cx`/`cy`
 *  this chapter writes onto it — lifted from
 *  v19-tour-chapter-time-runs.test.mjs, which patches the same way for its
 *  own demo body. */
function patchRects() {
  window.SVGElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains("dial")) return rect(390, 150, 500, 500);
    if (this.classList.contains("tourfilm-lands-body")) {
      const dot = this.querySelector("circle");
      const cx = Number(dot?.getAttribute("cx") ?? 190);
      const cy = Number(dot?.getAttribute("cy") ?? 190);
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

describe("the selectors chapter 3 names", () => {
  it("the real one (.dial) exists in home's own markup", () => {
    const rendered = namesIn(HOME_SOURCE);
    for (const token of tokensOf(SELECTORS.dial)) {
      expect(rendered.has(token), `chapter 3 names "${SELECTORS.dial}", but /home renders no "${token}"`).toBe(true);
    }
  });

  it("the drawn one (.tourfilm-lands-body) is never real markup", () => {
    const rendered = namesIn(HOME_SOURCE);
    for (const token of tokensOf(SELECTORS.body)) {
      expect(rendered.has(token)).toBe(false);
    }
  });
});

describe("the chapter's shape", () => {
  it("is { id, name, play }", () => {
    expect(lands.id).toBe("lands");
    expect(lands.name).toBe("Lands");
    expect(typeof lands.play).toBe("function");
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
        unlight: (c) => log.push(["unlight", c.sel]),
        callout: async (text, anchor) => log.push(["callout", text, anchor.sel]),
        dropCallout: () => log.push(["dropCallout"]),
      },
    };
  }

  it("returns to /home with the veil lifted, as the mockup does", async () => {
    const { log, ctx } = recorder();
    await lands.play(ctx);
    expect(log[0]).toEqual(["setScreen", "/home"]);
    expect(log[1]).toEqual(["veil", false]);
  });

  it("says the two ratified lines, in order, each pinned to its own control", async () => {
    const { log, ctx } = recorder();
    await lands.play(ctx);
    const said = log.filter(([word]) => word === "callout").map(([, text, sel]) => [text, sel]);
    expect(said).toEqual([
      ["Bodies orbit by when they're due.", ".tourfilm-lands-body"],
      ["The nearer the ring, the sooner.", ".dial"],
    ]);
  });

  it("presses nothing: chapter 3 only looks", async () => {
    const { log, ctx } = recorder();
    await expect(lands.play(ctx)).resolves.toBeUndefined();
    expect(log.some(([word]) => word === "press" || word === "tap")).toBe(false);
  });
});

describe("the chapter played for real", () => {
  it("draws the demo body and removes it again", async () => {
    drawHome();
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document });
    clock.setPlaying(true);

    let seenOnce = false;
    let done = false;
    const playing = lands.play(ctx).then(() => { done = true; }, () => { done = true; });
    let spent = 0;
    while (!done && spent < 400000) {
      clock.advance(100);
      spent += 100;
      await settle();
      if (document.querySelector(".tourfilm-lands-body")) seenOnce = true;
    }
    await playing;

    expect(seenOnce).toBe(true);
    /* it is gone by the time the chapter ends */
    expect(document.querySelector(".tourfilm-lands-body")).toBeNull();
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
    const playing = lands.play(ctx).then(() => { done = true; }, () => { done = true; });
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
      "Bodies orbit by when they're due.",
      "The nearer the ring, the sooner.",
    ]);
    ctx.destroy();
  });

  it("leaves home's own DOM exactly as it found it", async () => {
    drawHome();
    const before = document.getElementById("hero").outerHTML;
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document });
    clock.setPlaying(true);
    await playOut(clock, lands.play(ctx));
    ctx.destroy();
    expect(document.getElementById("hero").outerHTML).toBe(before);
  });

  it("names the dial as core, not optional: a sky with no dial is not a sky this chapter can play", async () => {
    document.body.innerHTML = '<div class="hero" id="hero"></div>';
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document });
    clock.setPlaying(true);
    await expect(playOut(clock, lands.play(ctx))).rejects.toThrow(/no element matches ".dial"/u);
    ctx.destroy();
  });
});
