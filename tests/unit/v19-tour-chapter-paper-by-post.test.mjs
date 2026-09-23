// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import relay, { SELECTORS } from "../../web/src/lib/tour/chapters/06-paper-by-post.js";
import { createClock } from "../../web/src/lib/tour/clock.js";
import { TOUR_STOPS } from "../../web/src/lib/tour/stops.js";
import { createFilmContext } from "../../web/src/lib/tour/vocabulary.js";

/*
 * #866: chapter 6's copy is not new — it is the same "relay" stop
 * stops.js's own real (non-cinematic) walk already carries, pointed at the
 * same route and the same selector. This file pins that reuse, the same
 * markup-existence check chapter 1's test runs for its own selectors, and
 * the beat order, the same way as the other built chapters.
 */

const web = (path) => resolve(import.meta.dirname, "../../web", path);
const RELAY_SOURCE = readFileSync(web("src/routes/settings/mail/+page.svelte"), "utf8");

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

function box(el, { x, y, w, h }) {
  el.getBoundingClientRect = () => ({
    left: x, top: y, width: w, height: h,
    right: x + w, bottom: y + h, x, y, toJSON() {},
  });
}

/** The relay screen, near enough for the film: just the card this chapter
 *  names. */
function drawRelay() {
  document.body.innerHTML = `
    <div class="stage" id="stage">
      <div class="glass relay-card">
        <div class="dish" id="relaydish"><span></span><span></span><span></span><i></i></div>
        <h1>Your relay</h1>
        <div class="alias">relay-household@post.orbit.test</div>
        <div class="btns"><button class="pri">rotate address</button><button>pause ingest</button></div>
      </div>
    </div>`;
  box(document.querySelector(".relay-card"), { x: 458, y: 264, w: 364, h: 260 });
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

describe("the selectors chapter 6 names", () => {
  it("every one of them exists in /settings/mail's own markup", () => {
    const rendered = namesIn(RELAY_SOURCE);
    for (const [beat, selector] of Object.entries(SELECTORS)) {
      for (const token of tokensOf(selector)) {
        expect(
          rendered.has(token),
          `chapter 6's "${beat}" names "${selector}", but /settings/mail renders no "${token}"`,
        ).toBe(true);
      }
    }
  });

  it("names the same card the ratified walk already points at", () => {
    /* stops.js is where this stop was ratified; the film must not drift off
       onto its own idea of where the relay lives. */
    const stop = TOUR_STOPS.find((one) => one.id === "relay");
    expect(stop.route).toBe("/settings/mail");
    expect(stop.target).toContain(".relay-card");
    expect(SELECTORS.card).toBe(".relay-card");
  });

  it("says the same two lines the ratified walk already says", () => {
    const stop = TOUR_STOPS.find((one) => one.id === "relay");
    expect(stop.copy).toEqual([
      "Forward a bill to your relay address and Orbit reads a copy.",
      "Your mail is never redirected — it keeps arriving exactly where it always has.",
    ]);
  });
});

describe("the chapter's shape", () => {
  it("is { id, name, play }", () => {
    expect(relay.id).toBe("relay");
    expect(relay.name).toBe("Paper by post");
    expect(typeof relay.play).toBe("function");
  });
});

describe("the beats, against a recorder", () => {
  function recorder() {
    const log = [];
    const control = (sel) => ({ sel, els: [], ringEls: [], round: false, pad: 0, radius: 14, rings: [], lifted: false, saved: [] });
    return {
      log,
      ctx: {
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

  it("arrives on /home with the veil down, as every chapter opens", async () => {
    const { log, ctx } = recorder();
    await relay.play(ctx);
    expect(log[0]).toEqual(["setScreen", "/home"]);
    expect(log[1]).toEqual(["veil", false]);
  });

  it("dims before the cut, then moves to the relay", async () => {
    const { log, ctx } = recorder();
    await relay.play(ctx);
    const veilOn = log.findIndex(([w, on]) => w === "veil" && on === true);
    const moved = log.findIndex(([w, route]) => w === "setScreen" && route === "/settings/mail");
    expect(veilOn).toBeGreaterThan(-1);
    expect(moved).toBeGreaterThan(veilOn);
  });

  it("says the two ratified lines, in order, both on the relay card", async () => {
    const { log, ctx } = recorder();
    await relay.play(ctx);
    const said = log.filter(([word]) => word === "callout").map(([, text, sel]) => [text, sel]);
    expect(said).toEqual([
      ["Forward a bill to your relay address and Orbit reads a copy.", ".relay-card"],
      ["Your mail is never redirected — it keeps arriving exactly where it always has.", ".relay-card"],
    ]);
  });

  it("presses nothing: chapter 6 only looks, same as the mockup's own cut", async () => {
    const { log, ctx } = recorder();
    /* `press` and `tap` are absent from the recorder, so a chapter reaching
       for either would throw rather than pass quietly. */
    await expect(relay.play(ctx)).resolves.toBeUndefined();
    expect(log.some(([word]) => word === "press" || word === "tap")).toBe(false);
  });
});

describe("the chapter played for real", () => {
  it("puts its two lines on the screen in order", async () => {
    drawRelay();
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({
      clock,
      doc: document,
      routeOf: () => "/settings/mail",
      navigate: async () => {},
      settle: async () => {},
    });
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
    const playing = relay.play(ctx).then(() => { done = true; }, () => { done = true; });
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
      "Forward a bill to your relay address and Orbit reads a copy.",
      "Your mail is never redirected — it keeps arriving exactly where it always has.",
    ]);
    ctx.destroy();
  });

  it("leaves the relay screen's own DOM exactly as it found it", async () => {
    drawRelay();
    const before = document.getElementById("stage").outerHTML;
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({
      clock,
      doc: document,
      routeOf: () => "/settings/mail",
      navigate: async () => {},
      settle: async () => {},
    });
    clock.setPlaying(true);
    await playOut(clock, relay.play(ctx));
    ctx.destroy();
    expect(document.getElementById("stage").outerHTML).toBe(before);
  });
});
