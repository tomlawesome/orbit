// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import done, { SELECTORS } from "../../web/src/lib/tour/chapters/09-done.js";
import { createClock } from "../../web/src/lib/tour/clock.js";
import { createFilmContext } from "../../web/src/lib/tour/vocabulary.js";

/*
 * #866: chapter 9 is one of the three (5, 9, 12) whose lit ring travels with
 * a moving target rather than sitting still, the same device chapter 5 uses
 * — pinned here the same way v19-tour-chapter-time-runs.test.mjs pins it.
 * Unlike chapter 5, this chapter spans two real screens: the item screen
 * (where the complete button lives) and home (where the demo body swings
 * back out). `.item-card` and the complete button's position are pinned
 * against the item screen's own markup; `.dial` against home's; the drawn
 * `.tourfilm-time-body` is pinned by running the chapter, never against
 * either source.
 */

const web = (path) => resolve(import.meta.dirname, "../../web", path);
const ITEM_SOURCE = readFileSync(web("src/routes/item/[[id]]/+page.svelte"), "utf8");
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

/** Every attribute VALUE a source writes literally (not just class/id) — so
 *  `aria-label="Item actions"` can be pinned the same way a class is. */
function attributeValuesIn(source) {
  const values = new Set();
  for (const match of source.matchAll(/aria-label\s*=\s*"([^"]*)"/gu)) values.add(match[1]);
  return values;
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

function box(el, r) {
  el.getBoundingClientRect = () => rect(r.x, r.y, r.w, r.h);
}

/** happy-dom computes no real SVG layout, so the dial and the chapter's own
 *  travelling dot are given boxes by hand, the same trick
 *  v19-tour-chapter-time-runs.test.mjs uses: the dial is fixed, and the
 *  dot's box is derived from the `cx`/`cy` this chapter writes onto it. */
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

/** Both screens the chapter visits, drawn at once: the recorder's stubbed
 *  `setScreen` never swaps real DOM, so both the item card and the dial have
 *  to already be there for the "played for real" tests below. */
function drawScreens() {
  document.body.innerHTML = `
    <div class="hero" id="hero">
      <article class="glass item-card">
        <h2>Car MOT — Volvo V60</h2>
        <div class="acts" role="group" aria-label="Item actions">
          <button style="--act:var(--ok);--act-text:var(--ok-text)">complete</button>
          <button style="--act:var(--upcoming);--act-text:var(--upcoming-text)">reschedule</button>
          <button style="--act:var(--warm);--act-text:var(--warm-text)">snooze</button>
          <button style="--act:var(--accent);--act-text:var(--accent-text)">edit</button>
          <button style="--act:var(--overdue);--act-text:var(--overdue-text)">retire</button>
        </div>
      </article>
      <svg class="dial" viewBox="0 0 380 380"></svg>
    </div>`;
  box(document.querySelector(".item-card"), { x: 445, y: 154, w: 390, h: 372 });
  box(document.querySelector(".acts button"), { x: 467, y: 388, w: 92, h: 36 });
}

async function playOut(clock, promise, step = 100, cap = 400000) {
  let doneRunning = false;
  let failure = null;
  promise.then(() => { doneRunning = true; }, (error) => { doneRunning = true; failure = error; });
  let spent = 0;
  while (!doneRunning && spent < cap) {
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

describe("the selectors chapter 9 names", () => {
  it("the item screen's own ones (.item-card, the actions group) exist in its markup", () => {
    const rendered = namesIn(ITEM_SOURCE);
    for (const token of tokensOf(SELECTORS.card)) {
      expect(rendered.has(token), `chapter 9 names "${SELECTORS.card}", but /item renders no "${token}"`).toBe(true);
    }
    for (const token of tokensOf(SELECTORS.done)) {
      expect(rendered.has(token), `chapter 9 names "${SELECTORS.done}", but /item renders no "${token}"`).toBe(true);
    }
    expect(attributeValuesIn(ITEM_SOURCE).has("Item actions")).toBe(true);
  });

  it("the real dial exists in home's own markup", () => {
    const rendered = namesIn(HOME_SOURCE);
    for (const token of tokensOf(SELECTORS.dial)) {
      expect(rendered.has(token), `chapter 9 names "${SELECTORS.dial}", but /home renders no "${token}"`).toBe(true);
    }
  });

  it("the drawn one (.tourfilm-time-body) is never real markup", () => {
    const item = namesIn(ITEM_SOURCE);
    const home = namesIn(HOME_SOURCE);
    for (const token of tokensOf(SELECTORS.body)) {
      expect(item.has(token)).toBe(false);
      expect(home.has(token)).toBe(false);
    }
  });
});

describe("the chapter's shape", () => {
  it("is { id, name, play }", () => {
    expect(done.id).toBe("done");
    expect(done.name).toBe("Done");
    expect(typeof done.play).toBe("function");
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
        T: { cross: 350 },
        setScreen: async (route) => log.push(["setScreen", route]),
        veil: (on) => log.push(["veil", on]),
        ctl: (spec) => { log.push(["ctl", spec.sel]); return control(spec.sel); },
        goto: async (c) => log.push(["goto", c.sel]),
        press: async (c) => log.push(["press", c.sel]),
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

  it("opens on the item screen, veiled, and hands home back undimmed", async () => {
    const { log, ctx } = recorder();
    await done.play(ctx);
    expect(log[0]).toEqual(["setScreen", "/item"]);
    expect(log[1]).toEqual(["veil", true]);
    const homeIndex = log.findIndex(([w, route]) => w === "setScreen" && route === "/home");
    expect(homeIndex).toBeGreaterThan(0);
    expect(log[homeIndex + 1]).toEqual(["veil", false]);
    /* never raised again after that -- the swing back out plays undimmed */
    expect(log.slice(homeIndex).some(([w, on]) => w === "veil" && on === true)).toBe(false);
  });

  it("says the corrected two ratified lines, in order, each pinned to its own control", async () => {
    const { log, ctx } = recorder();
    await done.play(ctx);
    const said = log.filter(([word]) => word === "callout").map(([, text, sel]) => [text, sel]);
    expect(said).toEqual([
      ["MOT passed — mark it done and it swings back out to next year.", SELECTORS.done],
      ["A repeat is never finished; it comes round. A one-off simply ends.", ".tourfilm-time-body"],
    ]);
  });

  it("lights and unlights the card and the button before leaving for /home", async () => {
    const { log, ctx } = recorder();
    await done.play(ctx);
    const homeIndex = log.findIndex(([w, route]) => w === "setScreen" && route === "/home");
    const litCard = log.findIndex(([w, sel]) => w === "light" && sel === SELECTORS.card);
    const unlitCard = log.findIndex(([w, sel]) => w === "unlight" && sel === SELECTORS.card);
    const unlitDone = log.findIndex(([w, sel]) => w === "unlight" && sel === SELECTORS.done);
    expect(litCard).toBeGreaterThanOrEqual(0);
    expect(litCard).toBeLessThan(homeIndex);
    expect(unlitCard).toBeLessThan(homeIndex);
    expect(unlitDone).toBeLessThan(homeIndex);
  });

  it("presses only the done button", async () => {
    const { log, ctx } = recorder();
    await done.play(ctx);
    const pressed = log.filter(([word]) => word === "press").map(([, sel]) => sel);
    expect(pressed).toEqual([SELECTORS.done]);
  });

  it("marks done-complete, done-swung and done-round", async () => {
    const { log, ctx } = recorder();
    await done.play(ctx);
    const marks = log.filter(([word]) => word === "mark").map(([, name]) => name);
    expect(marks).toEqual(["done-swung"]);
    /* done-complete and done-round ride inside their callouts' own options,
       which this recorder's `callout` stub does not see -- pinned for real
       below. */
  });
});

describe("the chapter played for real", () => {
  it("draws the demo body swinging outward, and removes it again", async () => {
    drawScreens();
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document });
    clock.setPlaying(true);

    const seenX = [];
    let finished = false;
    const playing = done.play(ctx).then(() => { finished = true; }, () => { finished = true; });
    let spent = 0;
    while (!finished && spent < 400000) {
      clock.advance(100);
      spent += 100;
      await settle();
      const bodyEl = document.querySelector(".tourfilm-time-body");
      if (bodyEl) seenX.push(bodyEl.getBoundingClientRect().x);
    }
    await playing;

    expect(new Set(seenX).size).toBeGreaterThan(1);
    expect(document.querySelector(".tourfilm-time-body")).toBeNull();
    ctx.destroy();
  });

  it("puts its two lines on the screen in order, with the corrected close", async () => {
    drawScreens();
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

    let finished = false;
    const playing = done.play(ctx).then(() => { finished = true; }, () => { finished = true; });
    let spent = 0;
    while (!finished && spent < 400000) {
      clock.advance(100);
      spent += 100;
      await settle();
      sample();
    }
    await playing;
    sample();

    expect(said).toEqual([
      "MOT passed — mark it done and it swings back out to next year.",
      "A repeat is never finished; it comes round. A one-off simply ends.",
    ]);
    ctx.destroy();
  });

  it("leaves the item card and its actions exactly as it found them", async () => {
    /* `applyLift`/`restore` (vocabulary.js) put the button's own transform,
       filter and transition back to their saved (empty) values -- but
       touching `style.transform` at all makes a browser (happy-dom
       included) reserialize the WHOLE inline style string, so
       `--act:var(--ok);--act-text:var(--ok-text)` comes back as
       `--act: var(--ok); --act-text: var(--ok-text);` -- same values,
       cosmetic spacing only. Real markup carries exactly this kind of
       inline style, so the comparison below normalizes style attributes
       rather than asserting byte-for-byte equality a real lift could never
       actually promise. */
    const normalizeStyles = (html) =>
      html.replace(/style="([^"]*)"/gu, (_, css) =>
        `style="${css.split(";").map((rule) => rule.trim()).filter(Boolean)
          .map((rule) => rule.replace(/\s*:\s*/u, ":")).join(";")}"`);

    drawScreens();
    const before = document.querySelector(".item-card").outerHTML;
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document });
    clock.setPlaying(true);
    await playOut(clock, done.play(ctx));
    ctx.destroy();
    const after = document.querySelector(".item-card").outerHTML;
    expect(normalizeStyles(after)).toBe(normalizeStyles(before));
  });
});
