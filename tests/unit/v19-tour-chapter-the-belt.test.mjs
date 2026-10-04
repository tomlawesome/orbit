// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import belt, { SELECTORS, householdCarriesPapers } from "../../web/src/lib/tour/chapters/08-the-belt.js";
import { POCKET_RIDE } from "../../web/src/routes/item/[[id]]/band.js";
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

/* #1083: the pocket's own body (pocket.svelte's `pk-body`) and its route to
   `/item` (`pk-below`'s opened row, Row.svelte's own acts, and the reading
   sheet a document's press raises, Sheet.svelte) — the pocket-only markup
   chapter 8's POCKET selectors are checked against, beside the belt's own
   (ITEM_SOURCE), which does not change shape for the pocket. */
const POCKET_SOURCE = [
  "src/routes/home/pocket.svelte",
  "src/lib/pocket/Row.svelte",
  "src/lib/pocket/Sheet.svelte",
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
       onKeydown), and neither touches localStorage or a server.
       `aria-hidden="false"` is paintMembers' own say for "this one is
       actually out" (#1174 round 9) — docBody's ring relies on it. */
    const hit = document.createElementNS(SVG_NS, "g");
    hit.setAttribute("class", "hit");
    hit.setAttribute("aria-label", `Document ${k}, a document attached to Volvo V60`);
    hit.setAttribute("aria-hidden", "false");
    hit.addEventListener("click", () => {
      if (document.getElementById("readcard")) return;
      const card = document.createElement("aside");
      card.id = "readcard";
      container.appendChild(card);
    });
    box(hit, { x: 600 + k * 20, y: 270, w: 40, h: 40 });
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
  it("every desk one exists in home's or the belt's own markup", () => {
    const rendered = namesIn(HOME_SOURCE + "\n" + ITEM_SOURCE);
    for (const [beat, selector] of Object.entries(SELECTORS.DESK)) {
      for (const token of tokensOf(selector)) {
        expect(
          rendered.has(token),
          `chapter 8's desk "${beat}" names "${selector}", but neither /home nor the belt renders "${token}"`,
        ).toBe(true);
      }
    }
  });

  it("every pocket one exists in the pocket dialect's or the belt's own markup", () => {
    const rendered = namesIn(ITEM_SOURCE + "\n" + POCKET_SOURCE);
    for (const [beat, selector] of Object.entries(SELECTORS.POCKET)) {
      for (const token of tokensOf(selector)) {
        expect(
          rendered.has(token),
          `chapter 8's pocket "${beat}" names "${selector}", but neither the pocket dialect nor the belt renders "${token}"`,
        ).toBe(true);
      }
    }
  });

  it("pins POCKET_RIDE (band.js) at at least one paper riding the belt", () => {
    /* #1083: the two-papers count this chapter's docBody/docHit beats rely
       on being "however many ride" (see point 3 of the chapter's own header
       comment) presumes the belt seats at least one. */
    expect(POCKET_RIDE).toBeGreaterThanOrEqual(1);
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
      ["Every body carries its documents in a belt around it.", SELECTORS.DESK.docBody],
      ["The belt is what you have attached to it.", SELECTORS.DESK.docBody],
      ["Click one to bring it in.", SELECTORS.DESK.docBody],
      ["Read the full document, right here.", SELECTORS.DESK.cardwrap],
    ]);
  });

  it("presses the body, then the papers — never lands a step on a document (#1094), and never touches an end-cap (#1174 round 10)", async () => {
    const { log, ctx } = recorder();
    await belt.play(ctx);
    const pressed = log.filter(([word]) => word === "press").map(([, sel]) => sel);
    expect(pressed).toEqual([SELECTORS.DESK.body, SELECTORS.DESK.docBody]);
  });

  it("presses a body that carries documents when the first body has none (#1191), as the pocket does", async () => {
    const { log, ctx } = recorder();
    /* Two bodies on the sky: the first bare, the second carrying papers. The
       recorder's ctl answers every other selector with nothing, so only the
       carrying lookup finds an element. */
    const carrying = document.createElement("a");
    const bare = ctx.ctl;
    ctx.ctl = (spec) => {
      const control = bare(spec);
      if (spec.sel === SELECTORS.DESK.bodyWithPapers) return { ...control, els: [carrying], ringEls: [carrying] };
      return control;
    };
    await belt.play(ctx);
    const pressed = log.filter(([word]) => word === "press").map(([, sel]) => sel);
    expect(pressed).toEqual([SELECTORS.DESK.bodyWithPapers, SELECTORS.DESK.docBody]);
    expect(log.filter(([word, sel]) => word === "goto" && sel === SELECTORS.DESK.body)).toEqual([]);
  });

  it("names the carrying body's own item on the desk (#1151 F10), not the bare apex route", async () => {
    const { log, ctx } = recorder();
    /* Same two-body sky as the #1191 test above, but the carrying body is a
       real element with the `data-body` id home's own markup gives it
       (+page.svelte's `data-body={b.id}`), so the route can be read back. */
    const carrying = document.createElement("a");
    carrying.setAttribute("data-body", "volvo-v60");
    const bare = ctx.ctl;
    ctx.ctl = (spec) => {
      const control = bare(spec);
      if (spec.sel === SELECTORS.DESK.bodyWithPapers) return { ...control, els: [carrying], ringEls: [carrying] };
      return control;
    };
    await belt.play(ctx);
    const setScreens = log.filter(([word]) => word === "setScreen").map(([, route]) => route);
    /* Bare "/item" redirects to whichever item is soonest due (+page.js's
       primaryArrival()), which is not necessarily the body this chapter
       just rang and pressed — it must name that body's own item instead. */
    expect(setScreens).toEqual(["/home", "/item/volvo-v60"]);
  });

  it("reads a paper for real right after pressing it, and unreads it right after the read callout", async () => {
    const { log, ctx } = recorder();
    await belt.play(ctx);
    const pressPapers = log.findIndex(([word, sel]) => word === "press" && sel === SELECTORS.DESK.docBody);
    const readAt = log.findIndex(([word]) => word === "read");
    const dropAt = log.findIndex(([word]) => word === "dropCallout");
    const unreadAt = log.findIndex(([word]) => word === "unread");
    /* one `ctl` call for the paper's real hit sits between the two */
    expect(readAt).toBe(pressPapers + 2);
    expect(log[readAt]).toEqual(["read", SELECTORS.DESK.docHit]);
    /* #1174 round 10: the belt's own step (round 6's beat 4) is gone from
       the film, so the card now closes right where the read beat leaves
       off, not on a step this chapter no longer takes. */
    expect(unreadAt).toBe(dropAt + 1);
    /* Only ever read once and unread once — one paper, whichever it is. */
    expect(log.filter(([word]) => word === "read")).toHaveLength(1);
    expect(log.filter(([word]) => word === "unread")).toHaveLength(1);
  });
});

describe("the chapter played for real", () => {
  it("puts its four lines on the screen in order", async () => {
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
      "Read the full document, right here.",
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
    /* Closed by the read beat's own unread(), right after its callout, not
       just by the teardown below (#1174 round 10: round 6's own beat 4,
       which used to close it, is gone from the film). */
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

  it("plays the same length with no body on the dial", async () => {
    const lengthWith = async (withBody) => {
      drawScene({ docs: 2 });
      if (!withBody) document.querySelector(".body-link")?.remove();
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

/* #1174 round 6 (Fable's call): with no body carrying a paper the chapter
   stays on the sky and reads its first two lines over the sun. */
describe("when no body carries a paper", () => {
  function recorder(pocket) {
    const log = [];
    const control = (sel) => ({ sel, els: [], ringEls: [], round: false, pad: 0, radius: 14, rings: [], lifted: false, saved: [] });
    return {
      log,
      ctx: {
        pocket,
        carriesPapers: () => false,
        setScreen: async (route) => log.push(["setScreen", route]),
        veil: (on) => log.push(["veil", on]),
        ctl: (spec) => { log.push(["ctl", spec.sel]); return control(spec.sel); },
        goto: async (c) => log.push(["goto", c.sel]),
        press: async (c) => log.push(["press", c.sel]),
        light: (c) => log.push(["light", c.sel]),
        unlight: (c) => log.push(["unlight", c.sel]),
        callout: async (text, anchor, side, o) => { log.push(["callout", text, anchor.sel]); if (o?.mark) log.push(["mark", o.mark]); },
        dropCallout: () => log.push(["dropCallout"]),
        mark: async (name) => log.push(["mark", name]),
        read: (c) => log.push(["read", c.sel]),
        unread: () => log.push(["unread"]),
        open: (c) => log.push(["open", c.sel]),
        waitForReal: async () => log.push(["waitForReal"]),
        w: async () => {},
        T: { cross: 350, scroll: 600, sheet: 300 },
      },
    };
  }

  for (const pocket of [false, true]) {
    it(`stays on the sky and reads two lines over the sun, opening nothing (${pocket ? "pocket" : "desk"})`, async () => {
      const { log, ctx } = recorder(pocket);
      await belt.play(ctx);
      const S = pocket ? SELECTORS.POCKET : SELECTORS.DESK;
      expect(log.filter(([word]) => word === "setScreen").map(([, route]) => route)).toEqual(["/home"]);
      expect(log.filter(([word]) => ["press", "read", "open", "unread"].includes(word))).toEqual([]);
      expect(log.filter(([word]) => word === "callout").map(([, text, sel]) => [text, sel])).toEqual([
        ["Every body carries its documents in a belt around it.", S.sun],
        ["The belt is what you have attached to it.", S.sun],
      ]);
      expect(log.filter(([word]) => word === "mark").map(([, name]) => name)).toEqual(["belt-cert", "belt-svc"]);
      expect(log.at(-1)).toEqual(["unlight", S.sun]);
    });
  }

  it("householdCarriesPapers reads the sky's own counts, per dialect", () => {
    document.body.innerHTML = '<a class="body-link" data-docs="2"></a><div class="pocket"><svg class="mdial"><g class="pk-body" data-papers="0"></g></svg></div>';
    expect(householdCarriesPapers(document, false)).toBe(true);
    expect(householdCarriesPapers(document, true)).toBe(false);
    document.body.innerHTML = '<a class="body-link"></a><div class="pocket"><svg class="mdial"><g class="pk-body" data-papers="1"></g><g class="pk-body" data-body-sugg data-papers="3"></g></svg></div>';
    expect(householdCarriesPapers(document, false)).toBe(false);
    expect(householdCarriesPapers(document, true)).toBe(true);
    document.body.innerHTML = "";
  });
});
