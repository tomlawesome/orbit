// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import sky, { SELECTORS } from "../../web/src/lib/tour/chapters/11-your-sky.js";
import { createClock } from "../../web/src/lib/tour/clock.js";
import { createFilmContext } from "../../web/src/lib/tour/vocabulary.js";

/*
 * #866: chapter 11 ("Your sky") is cut from chapter 1's worked example
 * (01-arrive.js), so the same rules and the same pinning shape apply here —
 * see v19-tour-chapter-arrive.test.mjs for the fuller commentary. Nothing
 * here touches chapters/index.js: the registry is the orchestrator's, not
 * any one chapter's, so this file imports 11-your-sky.js directly.
 *
 * THE POINT OF THIS FILE is the first block: every selector the chapter
 * names must EXIST in home's own markup. Two of chapter 11's selectors
 * (`settingsLink`, `dawn`, `afterDark`) are attribute selectors rather than
 * a bare class or id, because home's markup has no class or id to tell the
 * five swatches or the settings link apart from their siblings — they are
 * told apart the same way the product's own click handler tells them apart
 * (`packOf`, web/src/routes/home/swatches.js, reads a swatch's `title`).
 * The shared `tokensOf` helper only extracts `.class`/`#id` tokens, so those
 * three get their own literal-string checks below instead.
 */

const web = (path) => resolve(import.meta.dirname, "../../web", path);

const HOME_SOURCE = [
  "src/routes/home/+page.svelte",
  "src/routes/home/home.behaviour.js",
  "src/routes/home/swatches.js",
].map((file) => readFileSync(web(file), "utf8")).join("\n");

/** Every name home's source assigns to a class or an id. Lifted from
 *  v19-tour-chapter-arrive.test.mjs, which lifted it from
 *  v19-tour-stops.test.mjs. */
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

/** The class and id names one CSS selector depends on. Attribute selectors
 *  (`[title="dawn"]`, `[href$="/settings"]`) yield no tokens here — those
 *  are checked by literal string instead, below. */
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

/* The v1.3.0 roster, verbatim from theme.js — the order home's own swatches
   render in, and the order the chapter's "star chart · after dark · clouds
   · dawn · retrograde" line reads them out. */
const PACKS = [
  ["star-chart", "starchart"],
  ["after dark", "afterdark"],
  ["clouds", "clouds"],
  ["dawn", "dawn"],
  ["retrograde", "retrograde"],
];

/** Home, near enough for the film: the account orb and its menu — the nav
 *  (Inbox, Settings, Administration) and the five theme swatches, in the
 *  same order and with the same `title`s home's own markup uses. */
function drawHome() {
  document.body.innerHTML = `
    <div class="hero" id="hero">
      <a class="orb inbox-orb" href="/inbox"></a>
      <button class="orb" aria-expanded="false" aria-controls="account" title="Menu"></button>
      <div class="account" id="account" role="region" aria-label="Account and menu">
        <nav>
          <a href="/inbox">Inbox</a>
          <a href="/settings">Settings</a>
          <a href="/administration">Administration</a>
        </nav>
        <div class="swatches" role="group" aria-label="Theme">
          <span>THEME</span>
          ${PACKS.map(([title, name]) =>
            `<button title="${title}" aria-pressed="${name === "afterdark"}"></button>`).join("")}
        </div>
      </div>
    </div>`;
  box(document.querySelector("button.orb"), { x: 1214, y: 22, w: 40, h: 40 });
  box(document.querySelector('#account nav a[href$="/settings"]'), { x: 1030, y: 200, w: 210, h: 28 });
  box(document.querySelector("#account .swatches"), { x: 1068, y: 284, w: 148, h: 34 });
  document.querySelectorAll("#account .swatches button").forEach((el, k) => {
    box(el, { x: 1068 + k * 25, y: 284, w: 18, h: 18 });
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

describe("the selectors chapter 11 names", () => {
  it("every class and id it names exists in home's own markup", () => {
    const rendered = namesIn(HOME_SOURCE);
    for (const [beat, selector] of Object.entries(SELECTORS)) {
      for (const token of tokensOf(selector)) {
        expect(
          rendered.has(token),
          `chapter 11's "${beat}" names "${selector}", but /home renders no "${token}"`,
        ).toBe(true);
      }
    }
  });

  it("the orb it names is the account orb, not the inbox orb beside it", () => {
    expect(SELECTORS.orb).toBe("button.orb");
    expect(HOME_SOURCE).toContain('class="orb"');
    expect(HOME_SOURCE).toContain('class="orb inbox-orb"');
  });

  it("the settings row it names is a real link to /settings", () => {
    expect(SELECTORS.settingsLink).toContain('[href$="/settings"]');
    expect(HOME_SOURCE).toContain('resolve("/settings")');
  });

  it("the dawn and after-dark swatches it names are told apart the way the product's own click handler tells them apart", () => {
    /* packOf (swatches.js) reads a swatch's title; so does this chapter. */
    expect(SELECTORS.dawn).toContain('[title="dawn"]');
    expect(SELECTORS.afterDark).toContain('[title="after dark"]');
    expect(HOME_SOURCE).toContain('title="dawn"');
    expect(HOME_SOURCE).toContain('title="after dark"');
    expect(HOME_SOURCE).toContain("button.title.replace");
  });
});

describe("the chapter's shape", () => {
  it("is { id, name, play }", () => {
    expect(sky.id).toBe("sky");
    expect(sky.name).toBe("Your sky");
    expect(typeof sky.play).toBe("function");
  });
});

describe("the beats, in the mockup's order", () => {
  function recorder() {
    const log = [];
    const control = (sel) => ({ sel, els: [], ringEls: [], round: false, pad: 0, radius: 14, rings: [], lifted: false, saved: [] });
    return {
      log,
      ctx: {
        T: { cross: 350 },
        setScreen: async (route) => log.push(["setScreen", route]),
        veil: (on) => log.push(["veil", on]),
        ctl: (spec) => {
          log.push(["ctl", spec.sel]);
          return control(spec.sel);
        },
        goto: async (c) => log.push(["goto", c.sel]),
        press: async (c) => log.push(["press", c.sel]),
        unlight: (c) => log.push(["unlight", c.sel]),
        callout: async (text, anchor, side, o = {}) => {
          log.push(["callout", text, anchor.sel]);
          if (o.mark) log.push(["mark", o.mark]);
        },
        dropCallout: () => log.push(["dropCallout"]),
        mark: async (name) => log.push(["mark", name]),
        hold: async (ms) => log.push(["hold", ms]),
        w: async (ms) => log.push(["w", ms]),
      },
    };
  }

  it("arrives on /home, veil down, as the mockup opens", async () => {
    const { log, ctx } = recorder();
    await sky.play(ctx);
    expect(log[0]).toEqual(["setScreen", "/home"]);
    expect(log[1]).toEqual(["veil", false]);
  });

  it("says the two ratified lines, in order, each pinned to its own control", async () => {
    const { log, ctx } = recorder();
    await sky.play(ctx);
    const said = log.filter(([word]) => word === "callout").map(([, text, sel]) => [text, sel]);
    expect(said).toEqual([
      ["Settings holds your sky, your relay and this walk — take it again anytime.", SELECTORS.settingsLink],
      ["star chart · after dark · clouds · dawn · retrograde", SELECTORS.swatches],
    ]);
  });

  it("presses the orb, then dawn, then after dark — and only those three", async () => {
    const { log, ctx } = recorder();
    await sky.play(ctx);
    const pressed = log.filter(([word]) => word === "press").map(([, sel]) => sel);
    expect(pressed).toEqual([SELECTORS.orb, SELECTORS.dawn, SELECTORS.afterDark]);
  });

  it("marks sky-orb, sky-settings, sky-swatches, sky-dawn and sky-back, in that order", async () => {
    const { log, ctx } = recorder();
    await sky.play(ctx);
    const marks = log.filter(([word]) => word === "mark").map(([, name]) => name);
    expect(marks).toEqual(["sky-orb", "sky-settings", "sky-swatches", "sky-dawn", "sky-back"]);
  });

  it("never touches document.documentElement or localStorage itself — the real click, if any, is the product's", async () => {
    const { ctx } = recorder();
    const before = document.documentElement.dataset.theme;
    await sky.play(ctx);
    expect(document.documentElement.dataset.theme).toBe(before);
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
    const playing = sky.play(ctx).then(() => { done = true; }, () => { done = true; });
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
      "Settings holds your sky, your relay and this walk — take it again anytime.",
      "star chart · after dark · clouds · dawn · retrograde",
    ]);
    ctx.destroy();
  });

  it("leaves home's own DOM exactly as it found it", async () => {
    drawHome();
    const before = document.getElementById("hero").outerHTML;
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document });
    clock.setPlaying(true);
    await playOut(clock, sky.play(ctx));
    ctx.destroy();
    expect(document.getElementById("hero").outerHTML).toBe(before);
  });
});
