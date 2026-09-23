// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import belt, { SELECTORS } from "../../web/src/lib/tour/chapters/08-the-belt.js";
import { createClock } from "../../web/src/lib/tour/clock.js";
import { createFilmPlayer } from "../../web/src/lib/tour/player.js";
import { createFilmContext } from "../../web/src/lib/tour/vocabulary.js";

/*
 * #866, round 6 (#1093): chapter 8 carries one of the film's three ticks
 * (4, 8, 11), so — same law 01-arrive.js's own test pins for the registry —
 * this file checks two things: every selector the chapter names exists in
 * the REAL markup it names it against (home's own `.body-link`, and the
 * belt's own `+page.svelte` / `belt.behaviour.js`), and the chapter's length
 * is the same whether the seated item carries no papers, one, or several —
 * because the transport measures this chapter's tick before a single frame
 * plays, and a length that depended on the data would land the jump in the
 * wrong sentence.
 */

const web = (path) => resolve(import.meta.dirname, "../../web", path);

const HOME_SOURCE = readFileSync(web("src/routes/home/+page.svelte"), "utf8");
const ITEM_SOURCE = [
  "src/routes/item/[[id]]/+page.svelte",
  "src/routes/item/[[id]]/belt.behaviour.js",
].map((file) => readFileSync(web(file), "utf8")).join("\n");

/** Lifted from v19-tour-chapter-arrive.test.mjs, which pins chapter 1's
 *  selectors the same way: every name a source assigns to a class or an id,
 *  however it writes it — JSX-style, a JS object literal's `class: "..."`
 *  (belt.behaviour.js builds its SVG with plain `el(name, attrs)` calls, not
 *  markup), or a Svelte `class:` directive. */
function namesIn(source) {
  const names = new Set();
  const attributes = /(?:class(?:Name)?|id)\s*[=:]\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/gu;
  for (const match of source.matchAll(attributes)) {
    for (const word of (match[1] ?? match[2] ?? match[3] ?? "").matchAll(/[A-Za-z][\w-]*/gu)) {
      names.add(word[0]);
    }
  }
  for (const match of source.matchAll(/class:([\w-]+)/gu)) names.add(match[1]);
  /* belt.behaviour.js draws its SVG with `el(name, attrs)` and, for a few
     conditional classes (the document's own `.doclabel`), a follow-up
     `el.setAttribute("class", "...")` rather than the object literal above. */
  const setAttr = /\.setAttribute\(\s*["']class["']\s*,\s*["']([^"']*)["']\s*\)/gu;
  for (const match of source.matchAll(setAttr)) {
    for (const word of match[1].matchAll(/[A-Za-z][\w-]*/gu)) names.add(word[0]);
  }
  return names;
}

/** The class and id names one CSS selector depends on (attribute selectors
 *  like `[data-step="1"]` and tag names are not pinned here, same limit
 *  chapter 1's own test carries). */
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

const SVG_NS = "http://www.w3.org/2000/svg";

/** One end-cap, near enough for the film: the ink and its real hit box,
 *  exactly as belt.behaviour.js's `buildEnds` shapes them. */
function drawEndcap(endsG, step, x) {
  const cap = document.createElementNS(SVG_NS, "g");
  cap.setAttribute("class", "endcap-hit");
  cap.setAttribute("data-step", String(step));
  const target = document.createElementNS(SVG_NS, "rect");
  target.setAttribute("class", "endtarget");
  const text = document.createElementNS(SVG_NS, "text");
  text.setAttribute("class", "endcap");
  text.textContent = step > 0 ? "later →" : "← sooner";
  cap.append(target, text);
  endsG.appendChild(cap);
  box(cap, { x, y: 20, w: 44, h: 44 });
  box(target, { x, y: 20, w: 44, h: 44 });
  box(text, { x: x + 4, y: 30, w: 36, h: 12 });
  return cap;
}

/** The belt: `#members` with its two end-caps, `docs` documents riding
 *  beside the apex item, and the card at the apex. Near enough for the film,
 *  the same spirit as chapter 1's own `drawHome`.
 *  @param {HTMLElement} container */
function drawBelt(container, { docs = 2 } = {}) {
  const members = document.createElementNS(SVG_NS, "svg");
  members.id = "members";
  const ends = document.createElementNS(SVG_NS, "g");
  ends.id = "ends";
  drawEndcap(ends, -1, 40);
  drawEndcap(ends, 1, 1200);
  const seats = document.createElementNS(SVG_NS, "g");
  seats.id = "seats";
  const caps = document.createElementNS(SVG_NS, "g");
  caps.id = "caps";
  for (let k = 0; k < docs; k++) {
    const capseat = document.createElementNS(SVG_NS, "g");
    capseat.setAttribute("class", "capseat");
    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("class", "cap-name doclabel");
    label.textContent = `Document ${k}`;
    capseat.appendChild(label);
    caps.appendChild(capseat);
    box(label, { x: 600 + k * 20, y: 300, w: 60, h: 12 });

    /* #866: a paper's own real hit, near enough belt.behaviour.js's own
       buildSeats to prove read()/unread() against something that behaves
       like the shipped screen — a real click really mounts a card (openDoc's
       own effect), a real Escape really closes it (+page.svelte's own
       onKeydown), and neither touches localStorage or a server. */
    const hit = document.createElementNS(SVG_NS, "g");
    hit.setAttribute("class", "hit");
    hit.setAttribute("aria-label", `Document ${k}, a document attached to Volvo V60`);
    hit.addEventListener("click", () => {
      if (document.getElementById("readcard")) return;
      const card = document.createElement("aside");
      card.id = "readcard";
      container.appendChild(card);
    });
    seats.appendChild(hit);
  }
  members.append(ends, seats, caps);
  if (docs > 0) {
    const onEscape = (event) => {
      if (event.key !== "Escape") return;
      window.removeEventListener("keydown", onEscape);
      document.getElementById("readcard")?.remove();
    };
    window.addEventListener("keydown", onEscape);
  }

  const cardwrap = document.createElement("div");
  cardwrap.id = "cardwrap";
  box(cardwrap, { x: 500, y: 150, w: 390, h: 372 });

  container.append(members, cardwrap);
}

/** Home, near enough for the film: one body on the dial.
 *  @param {HTMLElement} container */
function drawHome(container) {
  container.insertAdjacentHTML("beforeend", `
    <div class="hero" id="hero">
      <svg class="dial"><a class="body-link" data-body="volvo"></a></svg>
    </div>`);
  box(container.querySelector(".body-link"), { x: 646, y: 268, w: 50, h: 50 });
}

/** Everything real lives inside one stable container, so a comparison of
 *  ITS outerHTML (chapter 11's own pattern for this exact test) is
 *  unaffected by the film's own chrome and veil, which mount as siblings on
 *  `document.body` and fade out asynchronously rather than vanishing the
 *  instant `destroy()` returns. */
function drawScene({ docs = 2 } = {}) {
  document.body.innerHTML = '<div id="scene"></div>';
  const scene = document.getElementById("scene");
  drawHome(scene);
  drawBelt(scene, { docs });
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

describe("the selectors chapter 8 names", () => {
  it("every one of them exists in home's or the belt's own markup", () => {
    const rendered = namesIn(HOME_SOURCE + "\n" + ITEM_SOURCE);
    for (const [beat, selector] of Object.entries(SELECTORS)) {
      for (const token of tokensOf(selector)) {
        expect(
          rendered.has(token),
          `chapter 8's "${beat}" names "${selector}", but neither /home nor the belt renders "${token}"`,
        ).toBe(true);
      }
    }
  });
});

describe("the chapter's shape", () => {
  it("is { id, name, play }", () => {
    expect(belt.id).toBe("belt");
    expect(belt.name).toBe("The belt");
    expect(typeof belt.play).toBe("function");
  });
});

describe("the beats, in round 6's order", () => {
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
        press: async (c) => log.push(["press", c.sel]),
        light: (c) => log.push(["light", c.sel]),
        unlight: (c) => log.push(["unlight", c.sel]),
        callout: async (text, anchor) => log.push(["callout", text, anchor.sel]),
        dropCallout: () => log.push(["dropCallout"]),
        mark: async (name) => log.push(["mark", name]),
        read: (c) => log.push(["read", c.sel]),
        unread: () => log.push(["unread"]),
        w: async () => {},
        T: { cross: 350 },
      },
    };
  }

  it("arrives on /home with the veil down, before pressing the body and naming /item", async () => {
    const { log, ctx } = recorder();
    await belt.play(ctx);
    expect(log[0]).toEqual(["setScreen", "/home"]);
    expect(log[1]).toEqual(["veil", false]);
    const setScreens = log.filter(([word]) => word === "setScreen").map(([, route]) => route);
    expect(setScreens).toEqual(["/home", "/item"]);
  });

  it("says round 6's lines, in order, each pinned to its own control", async () => {
    const { log, ctx } = recorder();
    await belt.play(ctx);
    const said = log.filter(([word]) => word === "callout").map(([, text, sel]) => [text, sel]);
    expect(said).toEqual([
      ["Every body carries its documents in a belt around it.", SELECTORS.docLabel],
      ["The belt is what you have attached to it.", SELECTORS.docLabel],
      ["Click one to bring it in.", SELECTORS.docLabel],
      ["The page itself, read without leaving the sky.", SELECTORS.cardwrap],
      ["later → steps the belt — so do the arrow keys.", SELECTORS.laterInk],
    ]);
  });

  it("presses the body, the papers, and both end-caps — never lands a step on a document (#1094)", async () => {
    const { log, ctx } = recorder();
    await belt.play(ctx);
    const pressed = log.filter(([word]) => word === "press").map(([, sel]) => sel);
    expect(pressed).toEqual([SELECTORS.body, SELECTORS.docLabel, SELECTORS.laterInk, SELECTORS.soonerInk]);
  });

  it("reads a paper for real right after pressing it, and unreads it on the later step", async () => {
    const { log, ctx } = recorder();
    await belt.play(ctx);
    const pressPapers = log.findIndex(([word, sel]) => word === "press" && sel === SELECTORS.docLabel);
    const readAt = log.findIndex(([word]) => word === "read");
    const pressLater = log.findIndex(([word, sel]) => word === "press" && sel === SELECTORS.laterInk);
    const unreadAt = log.findIndex(([word]) => word === "unread");
    /* one `ctl` call for the paper's real hit sits between the two */
    expect(readAt).toBe(pressPapers + 2);
    expect(log[readAt]).toEqual(["read", SELECTORS.docHit]);
    expect(unreadAt).toBe(pressLater + 1);
    /* Only ever read once and unread once — one paper, whichever it is. */
    expect(log.filter(([word]) => word === "read")).toHaveLength(1);
    expect(log.filter(([word]) => word === "unread")).toHaveLength(1);
  });

  it("says no copy for ← sooner — one press each way is enough (round 6)", async () => {
    const { log, ctx } = recorder();
    await belt.play(ctx);
    const afterLater = log.findIndex(([word, sel]) => word === "press" && sel === SELECTORS.laterInk);
    const soonerPress = log.findIndex(([word, sel]) => word === "press" && sel === SELECTORS.soonerInk);
    const calloutsBetween = log
      .slice(afterLater + 1, soonerPress)
      .filter(([word]) => word === "callout");
    expect(calloutsBetween).toEqual([]);
  });
});

describe("the chapter played for real", () => {
  it("puts its five lines on the screen in order", async () => {
    drawScene({ docs: 2 });
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
    const playing = belt.play(ctx).then(() => { done = true; }, () => { done = true; });
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
      "Every body carries its documents in a belt around it.",
      "The belt is what you have attached to it.",
      "Click one to bring it in.",
      "The page itself, read without leaving the sky.",
      "later → steps the belt — so do the arrow keys.",
    ]);
    ctx.destroy();
  });

  it("opens the real reading card during beat 3, and it is gone again by the end of the chapter", async () => {
    drawScene({ docs: 2 });
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document });
    clock.setPlaying(true);

    let sawOpen = false;
    let done = false;
    const playing = belt.play(ctx).then(() => { done = true; }, () => { done = true; });
    let spent = 0;
    while (!done && spent < 400000) {
      clock.advance(100);
      spent += 100;
      await settle();
      if (document.getElementById("readcard")) sawOpen = true;
    }
    await playing;

    expect(sawOpen).toBe(true);
    /* Closed by beat 4's own unread() (the belt's step), not just by the
       teardown below — round 6's "two things happen together". */
    expect(document.getElementById("readcard")).toBeNull();
    ctx.destroy();
    expect(document.getElementById("readcard")).toBeNull();
  });

  it("a jump mid-chapter still closes whatever card the belt opened — clear(), the same law unread() gives unwear()", async () => {
    drawScene({ docs: 1 });
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document });
    const chapters = [belt, { id: "after", name: "After", async play(c) { await c.hold(60000); } }];
    const player = createFilmPlayer({ clock, ctx, chapters });
    await player.measure();
    player.jump(0);
    await settle();

    let spent = 0;
    while (!document.getElementById("readcard") && spent < 400000) {
      clock.advance(100);
      spent += 100;
      await settle();
    }
    expect(document.getElementById("readcard")).not.toBeNull();

    player.jump(1); /* the reader jumps away mid-chapter, card still open */
    await settle();
    expect(document.getElementById("readcard")).toBeNull();

    player.destroy();
  });

  it("no reading card, no chapter carrying no papers — read() is a no-op with nothing to click", async () => {
    drawScene({ docs: 0 });
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document });
    clock.setPlaying(true);
    await playOut(clock, belt.play(ctx));
    expect(document.getElementById("readcard")).toBeNull();
    ctx.destroy();
  });

  it("leaves the real DOM exactly as it found it", async () => {
    drawScene({ docs: 1 });
    const before = document.getElementById("scene").outerHTML;
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document });
    clock.setPlaying(true);
    await playOut(clock, belt.play(ctx));
    ctx.destroy();
    expect(document.getElementById("scene").outerHTML).toBe(before);
  });

  it("plays the same beats, for the same length, whatever the apex item carries (the tick)", async () => {
    const lengthWith = async (docs) => {
      drawScene({ docs });
      const clock = createClock({ reducedMotion: () => false });
      const ctx = createFilmContext({ clock, doc: document });
      clock.setPlaying(true);
      await playOut(clock, belt.play(ctx));
      const spent = clock.sched();
      ctx.destroy();
      return spent;
    };
    /* No papers, one, or several: the transport measured this chapter's tick
       before a frame played, so the length must not move. */
    const none = await lengthWith(0);
    const one = await lengthWith(1);
    const several = await lengthWith(4);
    expect(one).toBe(none);
    expect(several).toBe(none);
  });

  it("plays the same length even with no body on the dial and both end-caps spent", async () => {
    const lengthWith = async (withControls) => {
      drawScene({ docs: 2 });
      if (!withControls) {
        document.querySelector(".body-link")?.remove();
        for (const cap of document.querySelectorAll(".endcap-hit")) cap.remove();
      }
      const clock = createClock({ reducedMotion: () => false });
      const ctx = createFilmContext({ clock, doc: document });
      clock.setPlaying(true);
      await playOut(clock, belt.play(ctx));
      const spent = clock.sched();
      ctx.destroy();
      return spent;
    };
    expect(await lengthWith(false)).toBe(await lengthWith(true));
  });
});
