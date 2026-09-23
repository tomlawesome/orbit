// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import inbox, { SELECTORS } from "../../web/src/lib/tour/chapters/07-inbox.js";
import { createClock } from "../../web/src/lib/tour/clock.js";
import { createFilmContext, T } from "../../web/src/lib/tour/vocabulary.js";

/*
 * #866: chapter 7 is the door from home into the relay queue. Its selectors
 * span two real screens (home's own inbox orb, and the inbox route's three
 * lanes), so both are pinned here — the same check
 * v19-tour-chapter-arrive.test.mjs runs for chapter 1, extended the way
 * v19-tour-chapter-add.test.mjs extends it across `/home` and `/create`.
 *
 * The review and reading lanes share a plain `.lane` class with nothing else
 * to tell them apart (inbox/+page.svelte), so `SELECTORS.review` and
 * `SELECTORS.reading` reach for `:nth-of-type` — a real DOM position, not a
 * class the product has any other use for. `tokensOf` below only pins the
 * class tokens those selectors also depend on (`lanes`, `lane`); the
 * "played for real" section pins the position itself, against a fixture
 * shaped like the route's actual three-lane markup.
 */

const web = (path) => resolve(import.meta.dirname, "../../web", path);

/* The inbox orb lives on home's own screen. */
const HOME_SOURCE = readFileSync(web("src/routes/home/+page.svelte"), "utf8");

/* Everything else this chapter names lives on the inbox route. */
const INBOX_SOURCE = readFileSync(web("src/routes/inbox/+page.svelte"), "utf8");

const ALL_SOURCE = `${HOME_SOURCE}\n${INBOX_SOURCE}`;

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

/** The class and id names one CSS selector depends on (ignores pseudo
 *  selectors like `:nth-of-type(2)`, which name a DOM position, not a
 *  class or id the source assigns). */
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
    <a class="orb inbox-orb" href="/inbox"></a>
    <button class="orb" aria-expanded="false" title="Menu"></button>`;
  box(document.querySelector(".inbox-orb"), { x: 1160, y: 18, w: 48, h: 48 });
}

/** Shaped exactly like inbox/+page.svelte's real markup: `.lanes` holding
 *  three sibling `.lane` divs (filed, review, reading/failed), a real
 *  `.receipt .actions button.yes` inside the review lane. `full` draws the
 *  waiting receipt; without it the lanes exist but hold nothing, same as a
 *  household with an empty queue but something already filed. */
function drawInbox({ full = true } = {}) {
  document.body.innerHTML = `
    <div class="lanes">
      <div class="lane filed"></div>
      <div class="lane">
        ${full ? '<div class="receipt"><div class="actions"><button class="yes">Add to orbit</button></div></div>' : ""}
      </div>
      <div class="lane"></div>
    </div>`;
  box(document.querySelector(".lane.filed"), { x: 18, y: 166, w: 378, h: 194 });
  box(document.querySelectorAll(".lane")[1], { x: 408, y: 164, w: 466, h: 292 });
  box(document.querySelectorAll(".lane")[2], { x: 886, y: 164, w: 378, h: 152 });
  if (full) box(document.querySelector(".receipt .actions button.yes"), { x: 430, y: 381, w: 108, h: 48 });
}

/** A genuinely empty inbox: no `.lanes` at all (the route's own empty
 *  state, `.quietnote`) — checked directly against
 *  web/src/routes/inbox/+page.svelte, which renders no #1046-style tour
 *  hook on this branch. */
function drawEmptyInbox() {
  document.body.innerHTML = `<div class="quietnote"></div>`;
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

describe("the selectors chapter 7 names", () => {
  it("every plain class one of them depends on exists in the real markup", () => {
    const rendered = namesIn(ALL_SOURCE);
    for (const [beat, selector] of Object.entries(SELECTORS)) {
      for (const token of tokensOf(selector)) {
        expect(
          rendered.has(token),
          `chapter 7's "${beat}" names "${selector}", but no real screen renders a "${token}"`,
        ).toBe(true);
      }
    }
  });

  it("names the inbox orb the way home's own markup renders it, distinct from the account orb", () => {
    expect(SELECTORS.orb).toBe(".inbox-orb");
    expect(HOME_SOURCE).toContain("inbox-orb");
    /* the account orb chapter 11 opens has no inbox-orb class */
    expect(HOME_SOURCE).toMatch(/<button class="orb"/u);
  });

  it("names the real \"add to orbit\" control by its actual class", () => {
    expect(SELECTORS.add).toBe(".receipt .actions button.yes");
    expect(INBOX_SOURCE).toContain('class="yes"');
  });

  it("has no #1046 tour hook to reach for: this branch's inbox renders no .lanes at all when the queue is empty", () => {
    expect(INBOX_SOURCE).not.toContain("lanes-tourhook");
  });

  it("keeps the three .lane divs in the mockup's own order: filed, then review, then reading/failed", () => {
    const filed = INBOX_SOURCE.indexOf('class="lane filed"');
    const review = INBOX_SOURCE.indexOf("<h2>For your review");
    const reading = INBOX_SOURCE.indexOf("<h2>Still reading");
    expect(filed).toBeGreaterThan(-1);
    expect(review).toBeGreaterThan(filed);
    expect(reading).toBeGreaterThan(review);
  });
});

describe("the chapter's shape", () => {
  it("is { id, name, play }", () => {
    expect(inbox.id).toBe("inbox");
    expect(inbox.name).toBe("Inbox");
    expect(typeof inbox.play).toBe("function");
  });
});

describe("the beats, in the mockup's order", () => {
  /** Records what the chapter asks the vocabulary to do, without touching a
   *  real document — lifted from v19-tour-chapter-add.test.mjs's own. */
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

  it("opens on /home, veiled only once the orb is approached", async () => {
    const { log, ctx } = recorder();
    await inbox.play(ctx);
    expect(log[0]).toEqual(["setScreen", "/home"]);
    expect(log[1]).toEqual(["veil", false]);
    const veilTrue = log.findIndex(([word, on]) => word === "veil" && on === true);
    const gotoOrb = log.findIndex(([word, sel]) => word === "goto" && sel === SELECTORS.orb);
    expect(veilTrue).toBeGreaterThan(-1);
    expect(veilTrue).toBeLessThan(gotoOrb);
  });

  it("says what the orb is for, presses it, and only then opens /inbox", async () => {
    const { log, ctx } = recorder();
    await inbox.play(ctx);
    const said = log.find(([word]) => word === "callout");
    expect(said).toEqual([
      "callout",
      "Mail lands here first — filed, waiting for review, or still being read.",
      SELECTORS.orb,
      "left",
      "inbox-orb",
    ]);
    const pressOrb = log.findIndex(([word, sel]) => word === "press" && sel === SELECTORS.orb);
    const setInbox = log.findIndex(([word, route]) => word === "setScreen" && route === "/inbox");
    expect(pressOrb).toBeGreaterThan(-1);
    expect(setInbox).toBeGreaterThan(pressOrb);
  });

  it("never lowers the veil again once it opens on the orb", async () => {
    const { log, ctx } = recorder();
    await inbox.play(ctx);
    const veilTrue = log.findIndex(([word, on]) => word === "veil" && on === true);
    const veilFalseAfter = log
      .slice(veilTrue + 1)
      .some(([word, on]) => word === "veil" && on === false);
    expect(veilFalseAfter).toBe(false);
  });

  it("reads out the three lanes, in the mockup's own order and sides, then marks inbox-lanes", async () => {
    const { log, ctx } = recorder();
    await inbox.play(ctx);
    const said = log.filter(([word]) => word === "callout").map(([, text, sel, side, mark]) => [text, sel, side, mark]);
    expect(said.slice(1, 4)).toEqual([
      ["Filed", SELECTORS.filed, "bottom", "inbox-lane-filed"],
      ["For your review", SELECTORS.review, "bottom", "inbox-lane-review"],
      ["Still reading", SELECTORS.reading, "top", "inbox-lane-reading"],
    ]);
    const lanesMark = log.findIndex(([word, name]) => word === "mark" && name === "inbox-lanes");
    const lastLaneCallout = log.findIndex(([word, text]) => word === "callout" && text === "Still reading");
    expect(lanesMark).toBeGreaterThan(lastLaneCallout);
  });

  it("visits nothing during the lane beats: only looks, never presses", async () => {
    const { log, ctx } = recorder();
    await inbox.play(ctx);
    const laneGotos = log.filter(([word, , willPress]) => word === "goto" && willPress === false);
    expect(laneGotos.map(([, sel]) => sel)).toEqual([SELECTORS.filed, SELECTORS.review, SELECTORS.reading]);
  });

  it("marks the whole three lanes as optional controls, so a household with nothing waiting still plays the beat", async () => {
    const { log, ctx } = recorder();
    await inbox.play(ctx);
    const ctlCalls = log.filter(([word]) => word === "ctl").map(([, sel]) => sel);
    expect(ctlCalls).toContain(SELECTORS.filed);
    expect(ctlCalls).toContain(SELECTORS.review);
    expect(ctlCalls).toContain(SELECTORS.reading);
    expect(ctlCalls).toContain(SELECTORS.add);
  });

  it("lights the review lane around the add button, then drops both together", async () => {
    const { log, ctx } = recorder();
    await inbox.play(ctx);
    const litReview = log.findIndex(([word, sels]) => word === "light" && sels?.includes?.(SELECTORS.review));
    const gotoAdd = log.findIndex(([word, sel]) => word === "goto" && sel === SELECTORS.add);
    const pressAdd = log.findIndex(([word, sel]) => word === "press" && sel === SELECTORS.add);
    const markAdd = log.findIndex(([word, name]) => word === "mark" && name === "inbox-add");
    const sayso = log.findIndex(([word, text]) => word === "callout" && text === "Nothing joins your orbit without your say-so.");
    expect(litReview).toBeGreaterThan(-1);
    expect(litReview).toBeLessThan(gotoAdd);
    expect(pressAdd).toBeGreaterThan(gotoAdd);
    expect(markAdd).toBeGreaterThan(pressAdd);
    expect(sayso).toBeGreaterThan(markAdd);
    /* Scoped to after the add button is lit: the lane loop itself also
       unlights the review lane by the same selector string earlier on. */
    const unlitTogether = log
      .slice(litReview + 1)
      .filter(([word, sels]) => word === "unlight" && (sels?.includes?.(SELECTORS.add) || sels?.includes?.(SELECTORS.review)));
    expect(unlitTogether.length).toBe(2);
  });
});

describe("the chapter played for real", () => {
  it("runs to completion against real home and a full inbox without a missing control", async () => {
    let route = "/home";
    drawHome();
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({
      clock,
      doc: document,
      routeOf: () => route,
      navigate: async (to) => {
        route = to;
        if (to === "/inbox") drawInbox({ full: true });
        else drawHome();
      },
      settle: async () => {},
    });
    clock.setPlaying(true);
    await playOut(clock, inbox.play(ctx));
    ctx.destroy();
    expect(route).toBe("/inbox");
  });

  it("plays the same beats, for the same length, whether the inbox is full, merely has lanes, or is genuinely empty", async () => {
    const lengthWith = async (drawIt) => {
      let route = "/home";
      drawHome();
      const clock = createClock({ reducedMotion: () => false });
      const ctx = createFilmContext({
        clock,
        doc: document,
        routeOf: () => route,
        navigate: async (to) => {
          route = to;
          if (to === "/inbox") drawIt();
          else drawHome();
        },
        settle: async () => {},
      });
      clock.setPlaying(true);
      await playOut(clock, inbox.play(ctx));
      const spent = clock.sched();
      ctx.destroy();
      return spent;
    };
    const full = await lengthWith(() => drawInbox({ full: true }));
    const emptyLanes = await lengthWith(() => drawInbox({ full: false }));
    const noLanesAtAll = await lengthWith(drawEmptyInbox);
    expect(emptyLanes).toBe(full);
    expect(noLanesAtAll).toBe(full);
  });

  it("leaves the inbox's own DOM exactly as it found it", async () => {
    let route = "/home";
    drawHome();
    let lanesBefore = null;
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({
      clock,
      doc: document,
      routeOf: () => route,
      navigate: async (to) => {
        route = to;
        if (to === "/inbox") {
          drawInbox({ full: true });
          lanesBefore = document.querySelector(".lanes").outerHTML;
        } else {
          drawHome();
        }
      },
      settle: async () => {},
    });
    clock.setPlaying(true);
    await playOut(clock, inbox.play(ctx));
    ctx.destroy();
    expect(document.querySelector(".lanes").outerHTML).toBe(lanesBefore);
  });
});
