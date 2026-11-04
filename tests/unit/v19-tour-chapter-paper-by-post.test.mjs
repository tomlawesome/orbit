// @vitest-environment happy-dom
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it } from "vitest";

import relay, { SELECTORS } from "../../web/src/lib/tour/chapters/06-paper-by-post.js";
import { createClock } from "../../web/src/lib/tour/clock.js";
import { createFilmContext } from "../../web/src/lib/tour/vocabulary.js";
import { box, namesIn, playOut, setReducedMotion, settle, tokensOf, web } from "./v19-tour-test-kit.mjs";

/*
 * #866: chapter 6's copy is not new — it is the same "relay" stop
 * stops.js's own real (non-cinematic) walk already carries, pointed at the
 * same route and the same selector. This file pins that reuse, the same
 * markup-existence check chapter 1's test runs for its own selectors, and
 * the beat order, the same way as the other built chapters.
 */

const RELAY_SOURCE = readFileSync(web("src/routes/settings/mail/+page.svelte"), "utf8");
/* #1174: the pocket relay is its own dialect (pocket.svelte), and chapter 6's
   pocket selector is pinned against THAT file, not the desk's. */
const RELAY_POCKET_SOURCE = readFileSync(web("src/routes/settings/mail/pocket.svelte"), "utf8");

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

beforeEach(() => {
  document.body.innerHTML = "";
  setReducedMotion(false);
  window.innerWidth = 1280;
  window.innerHeight = 800;
});

describe("the selectors chapter 6 names", () => {
  it("every desk one of them exists in /settings/mail's own markup", () => {
    const rendered = namesIn(RELAY_SOURCE);
    for (const [beat, selector] of Object.entries(SELECTORS.DESK)) {
      for (const token of tokensOf(selector)) {
        expect(
          rendered.has(token),
          `chapter 6's desk "${beat}" names "${selector}", but /settings/mail renders no "${token}"`,
        ).toBe(true);
      }
    }
  });

  /* #1174: the pocket relay is pocket.svelte's, where the desk's
     `.relay-card` is a 0x0 box — the pocket set is pinned against the pocket
     file, and must not be the desk's selector. */
  it("every pocket one of them exists in the pocket relay's own markup (pocket.svelte)", () => {
    const rendered = namesIn(RELAY_POCKET_SOURCE);
    for (const [beat, selector] of Object.entries(SELECTORS.POCKET)) {
      for (const token of tokensOf(selector)) {
        expect(
          rendered.has(token),
          `chapter 6's pocket "${beat}" names "${selector}", but the pocket relay renders no "${token}"`,
        ).toBe(true);
      }
    }
    expect(RELAY_POCKET_SOURCE).toContain('aria-label="Your address"');
    expect(SELECTORS.POCKET.card).not.toBe(".relay-card");
  });

  it("names the same card the ratified walk already points at", () => {
    /* The walk ratified this stop (route and target held here as literals,
       #1403 D2); the film must not drift off onto its own idea of where the
       relay lives. */
    const stop = { route: "/settings/mail", target: ".relay-card" };
    expect(stop.route).toBe("/settings/mail");
    expect(stop.target).toContain(".relay-card");
    expect(SELECTORS.DESK.card).toBe(".relay-card");
    expect(SELECTORS.POCKET.card).toContain(".rl-pocket");
  });

  it("says the same line the ratified walk already says (its second cut, #1174)", () => {
    /* The ratified copy, held here as the reference (#1403 D2). */
    const ratifiedCopy = [
      "Forward a bill to your relay address and Orbit reads a copy to import it.",
    ];
    expect(ratifiedCopy).toEqual([
      "Forward a bill to your relay address and Orbit reads a copy to import it.",
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

  it("says its one ratified line, on the relay card", async () => {
    const { log, ctx } = recorder();
    await relay.play(ctx);
    const said = log.filter(([word]) => word === "callout").map(([, text, sel]) => [text, sel]);
    expect(said).toEqual([
      ["Forward a bill to your relay address and Orbit reads a copy to import it.", ".relay-card"],
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
  it("puts its one line on the screen", async () => {
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
      "Forward a bill to your relay address and Orbit reads a copy to import it.",
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
