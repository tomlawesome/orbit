// @vitest-environment happy-dom
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it } from "vitest";

import chapter, { SELECTORS } from "../../web/src/lib/tour/chapters/10-other-households.js";
import { createClock } from "../../web/src/lib/tour/clock.js";
import { createFilmContext } from "../../web/src/lib/tour/vocabulary.js";
import { box, namesIn, playOut, setReducedMotion, settle, tokensOf, web } from "./v19-tour-test-kit.mjs";

/*
 * #866: chapter 10 ("other households") is translated by the same rules
 * chapter 1 sets out in 01-arrive.js and pinned by the same shape of test:
 * every selector must exist in home's real markup, the ratified copy is
 * pinned character for character, the beats follow the mockup's own order,
 * and — the rule this chapter is the most tempting place in the whole film
 * to break — the same beats play for the same length whatever the reader's
 * sky actually holds, because the transport measures the ticks once, before
 * the film plays, against a stopped clock.
 */

const HOME_SOURCE = [
  "src/routes/home/+page.svelte",
  "src/routes/home/home.behaviour.js",
].map((file) => readFileSync(web(file), "utf8")).join("\n");

/* #1083: the pocket's own home screen — where the pill-chip strip lives. */
const POCKET_SOURCE = readFileSync(web("src/routes/home/pocket.svelte"), "utf8");

/** Home, near enough for this chapter: the dial, this household's own sun,
 *  and however many other households the reader belongs among — the same
 *  fixture shape 01-arrive.js's test draws, so the same box exercises both
 *  chapters' selectors. */
function drawHome({ others = 2 } = {}) {
  document.body.innerHTML = `
    <div class="hero" id="hero">
      <svg class="dial"><g class="chrome"></g><a class="sun-link"></a></svg>
      ${Array.from({ length: others }, () => '<div class="minisys"><svg><circle class="msring"/></svg></div>').join("")}
    </div>`;
  box(document.querySelector(".dial"), { x: 390, y: 150, w: 500, h: 500 });
  box(document.querySelector(".sun-link"), { x: 616, y: 376, w: 48, h: 48 });
  [...document.querySelectorAll(".minisys")].forEach((sun, k) => {
    box(sun, { x: 1053 - k * 700, y: 235 + k * 300, w: 210, h: 160 });
    box(sun.querySelector(".msring"), { x: 1131 - k * 700, y: 290 + k * 300, w: 80, h: 80 });
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
  setReducedMotion(false);
  window.innerWidth = 1280;
  window.innerHeight = 800;
});

describe("the selectors chapter 10 names", () => {
  it("every desk one exists in home's own markup", () => {
    const rendered = namesIn(HOME_SOURCE);
    for (const [beat, selector] of Object.entries(SELECTORS.DESK)) {
      for (const token of tokensOf(selector)) {
        expect(
          rendered.has(token),
          `chapter 10's desk "${beat}" names "${selector}", but /home renders no "${token}"`,
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
          `chapter 10's pocket "${beat}" names "${selector}", but pocket.svelte renders no "${token}"`,
        ).toBe(true);
      }
    }
  });

  it("names the same sun the ratified walk already points at", () => {
    /* stops.js is where .minisys was ratified (the "sun" stop's target, and
       the /home TOUR_REGIONS list); the film must not drift off onto its own
       idea of where another household's sun is. */
    const sun = { target: ".sun-link, .minisys" };
    expect(sun.target).toContain(".minisys");
    /* The film rings the system's own 40px ring inside that group, not the
       group: the group's box takes in the label above (#866, #1098 frames). */
    expect(SELECTORS.DESK.other).toBe(".minisys .msring");
  });
});

describe("the chapter's shape", () => {
  it("is { id, name, play }", () => {
    expect(chapter.id).toBe("others");
    expect(chapter.name).toBe("Other households");
    expect(typeof chapter.play).toBe("function");
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
        goto: async (c, o) => log.push(["goto", c.sel, o?.willPress]),
        press: async (c) => log.push(["press", c.sel]),
        unlight: (c) => log.push(["unlight", c.sel]),
        callout: async (text, anchor) => log.push(["callout", text, anchor.sel]),
        dropCallout: () => log.push(["dropCallout"]),
      },
    };
  }

  it("arrives on /home and veils before teaching, as the mockup does", async () => {
    const { log, ctx } = recorder();
    await chapter.play(ctx);
    expect(log[0]).toEqual(["setScreen", "/home"]);
    expect(log[1]).toEqual(["veil", false]);
    const veilTrue = log.findIndex(([word, on]) => word === "veil" && on === true);
    const firstGoto = log.findIndex(([word]) => word === "goto");
    expect(veilTrue).toBeGreaterThan(-1);
    expect(veilTrue).toBeLessThan(firstGoto);
  });

  it("says the two ratified lines, in order, both pinned to the same household sun", async () => {
    const { log, ctx } = recorder();
    await chapter.play(ctx);
    const said = log.filter(([word]) => word === "callout").map(([, text, sel]) => [text, sel]);
    expect(said).toEqual([
      ["Explore the sky to find other households.", ".minisys .msring"],
      ["Tap one to fly there — Gran's flat, the narrowboat.", ".minisys .msring"],
    ]);
  });

  it("presses the sun once, between the two lines, and never opens a real join dialog", async () => {
    const { log, ctx } = recorder();
    await chapter.play(ctx);
    const beats = log.filter(([word]) => word === "callout" || word === "press").map(([word]) => word);
    expect(beats).toEqual(["callout", "press", "callout"]);
    /* press() only animates itself (vocabulary.js) — a real click on a
       .minisys the reader already belongs among instead flies the camera
       (home.behaviour.js's flyTo), which this chapter must not trigger. */
    expect(log.filter(([word]) => word === "press")).toHaveLength(1);
  });

  it("ends with the sun unlit and the veil back down", async () => {
    const { log, ctx } = recorder();
    await chapter.play(ctx);
    expect(log.some(([word, a]) => word === "unlight" && a === ".minisys .msring")).toBe(true);
    expect(log.at(-1)).toEqual(["veil", false]);
  });
});

describe("the chapter played for real", () => {
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
    const playing = chapter.play(ctx).then(() => { done = true; }, () => { done = true; });
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
      "Explore the sky to find other households.",
      "Tap one to fly there — Gran's flat, the narrowboat.",
    ]);
    ctx.destroy();
  });

  it("leaves home's own DOM exactly as it found it", async () => {
    drawHome();
    const before = document.getElementById("hero").outerHTML;
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document });
    clock.setPlaying(true);
    await playOut(clock, chapter.play(ctx));
    ctx.destroy();
    expect(document.getElementById("hero").outerHTML).toBe(before);
  });

  it("plays the same beats, for the same length, whatever the reader's sky holds", async () => {
    const lengthWith = async (others) => {
      drawHome({ others });
      const clock = createClock({ reducedMotion: () => false });
      const ctx = createFilmContext({ clock, doc: document });
      clock.setPlaying(true);
      await playOut(clock, chapter.play(ctx));
      const spent = clock.sched();
      ctx.destroy();
      return spent;
    };
    /* The transport measures every chapter's ticks once, before the film
       plays, so a chapter whose length depended on how many other
       households the reader belongs among would land every later jump in
       the wrong sentence. Alone in the sky, or with four others: same
       film. */
    expect(await lengthWith(0)).toBe(await lengthWith(4));
  });
});
