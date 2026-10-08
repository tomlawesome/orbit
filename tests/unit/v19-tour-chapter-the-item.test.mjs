// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import item, { SELECTORS, rowOf } from "../../web/src/lib/tour/chapters/08-the-item.js";
import { createClock } from "../../web/src/lib/tour/clock.js";
import { createFilmPlayer } from "../../web/src/lib/tour/player.js";
import { createFilmContext } from "../../web/src/lib/tour/vocabulary.js";
import { box, drawHome } from "./v19-tour-home-drawer-lib.mjs";

/*
 * #1319: chapter 8 is "The item" (design/v19/tour-drawer/round-2), set in
 * home's item drawer now the belt is retired. It carries one of the film's
 * three ticks (4, 8, 11), so this file checks that every selector it names
 * exists in home's real markup, that it says round 2's lines in order on
 * either dialect, that what it opens for real (the row, the preview, the
 * editing, the calendar) is put back and nothing is ever saved, and that
 * its length is the same whatever the household holds.
 */

const web = (path) => resolve(import.meta.dirname, "../../web", path);
const read = (files) => files.map((file) => readFileSync(web(file), "utf8")).join("\n");

/* The drawer's own parts, shared by both dialects. */
const DRAWER_SOURCE = read([
  "src/routes/home/ItemView.svelte",
  "src/routes/home/FootRow.svelte",
  "src/routes/home/EditRows.svelte",
  "src/lib/reading/PreviewCard.svelte",
]);
const DESK_SOURCE = read(["src/routes/home/+page.svelte", "src/routes/home/CorridorRow.svelte"]) + "\n" + DRAWER_SOURCE;
const POCKET_SOURCE = read([
  "src/routes/home/pocket.svelte",
  "src/routes/home/ItemDrawer.svelte",
  "src/lib/pocket/Row.svelte",
]) + "\n" + DRAWER_SOURCE;

/** Every name a source gives a class or an id, however it writes it. */
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

/** The class and id names one selector depends on. */
const tokensOf = (selector) => [...selector.matchAll(/[.#]([\w-]+)/gu)].map((match) => match[1]);
/** The attribute names one selector depends on (`[data-doc-row]`). */
const attributesOf = (selector) => [...selector.matchAll(/\[([\w-]+)/gu)].map((match) => match[1])
  .filter((name) => !["id", "aria-label", "aria-expanded"].includes(name));
/** The aria-label prefixes one selector depends on (`[aria-label^="Complete "]`). */
const labelsOf = (selector) => [...selector.matchAll(/\[aria-label\^="([^"]+)"\]/gu)].map((match) => match[1]);
/** Whether a source writes an aria-label starting with `prefix`, literally
 *  or as a template. */
const writesLabel = (source, prefix) => source.includes(`aria-label="${prefix}`)
  || source.includes(`aria-label={\`${prefix}`);

const settle = () => new Promise((resolve_) => setTimeout(resolve_, 0));

function setReducedMotion(matches) {
  window.matchMedia = () => ({
    matches,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
}

describe("the selectors chapter 8 names", () => {
  for (const [dialect, table, source] of [["desk", SELECTORS.DESK, DESK_SOURCE], ["pocket", SELECTORS.POCKET, POCKET_SOURCE]]) {
    it(`every ${dialect} one exists in home's own markup`, () => {
      const rendered = namesIn(source);
      for (const [beat, selector] of Object.entries(table)) {
        for (const token of tokensOf(selector)) {
          expect(rendered.has(token), `chapter 8's ${dialect} "${beat}" names "${selector}", but home renders no "${token}"`).toBe(true);
        }
        for (const name of attributesOf(selector)) {
          expect(source.includes(name), `chapter 8's ${dialect} "${beat}" names "${selector}", but home writes no "${name}"`).toBe(true);
        }
        for (const prefix of labelsOf(selector)) {
          expect(writesLabel(source, prefix), `chapter 8's ${dialect} "${beat}" names "${selector}", but no label starts "${prefix}"`).toBe(true);
        }
      }
    });
  }

  it("names a row by its item's own id, on either dialect", () => {
    expect(rowOf(false, "volvo")).toBe('.desk a.item[id="volvo"]');
    expect(rowOf(true, "volvo")).toBe('.pocket .pk-below .p-row[data-row-key="volvo"]');
    expect(rowOf(false, 'a"b')).toBe('.desk a.item[id="a\\"b"]');
  });

  it("names nothing on the retired belt or item screen", () => {
    for (const table of [SELECTORS.DESK, SELECTORS.POCKET]) {
      for (const selector of Object.values(table)) {
        expect(selector).not.toMatch(/item-card|cardwrap|capseat|g\.hit|ip-/u);
      }
    }
  });
});

describe("the chapter's shape", () => {
  it("is { id, name, play }, named as round 2 names it", () => {
    expect(item.id).toBe("item");
    expect(item.name).toBe("The item");
    expect(typeof item.play).toBe("function");
  });
});

/* ---- against a recorder ------------------------------------------------ */

/** Home, near enough for the recorder: one body with its row, the sun. */
function drawSky(pocket) {
  document.body.innerHTML = pocket
    ? `<div class="pocket"><svg class="mdial"><g class="pk-sun"></g><g class="pk-body" data-body="volvo" data-papers="2"></g></svg>
       <div class="pk-below"><div class="p-row" data-row-key="volvo"></div></div></div>`
    : `<div class="desk"><svg class="dial"><a class="sun-link"></a><a class="body-link" data-body="volvo" data-docs="2"></a></svg>
       <div class="manifest"><a class="item" id="volvo"></a></div></div>`;
}

function recorder(pocket = false) {
  drawSky(pocket);
  const log = [];
  const control = (sel, els = []) => ({ sel, els, ringEls: els, round: false, pad: 0, radius: 14, rings: [], lifted: false, saved: [] });
  return {
    log,
    ctx: {
      pocket,
      doc: document,
      dry: () => false,
      T: { cross: 350, scroll: 600, sheet: 300 },
      setScreen: async (route) => log.push(["setScreen", route]),
      veil: (on) => log.push(["veil", on]),
      ctl: (spec) => {
        log.push(["ctl", spec.sel]);
        const els = spec.all ? [...document.querySelectorAll(spec.sel)] : [document.querySelector(spec.sel)].filter(Boolean);
        return control(spec.sel, els);
      },
      goto: async (c) => log.push(["goto", c.sel]),
      press: async (c) => log.push(["press", c.sel]),
      light: (c) => log.push(["light", c.sel]),
      unlight: (c) => log.push(["unlight", c.sel]),
      callout: async (text, anchor, side, o) => log.push(["callout", text, o?.label === true]),
      dropCallout: () => log.push(["dropCallout"]),
      mark: async (name) => log.push(["mark", name]),
      read: (c) => log.push(["read", c.sel]),
      unread: () => log.push(["unread"]),
      open: (c) => { log.push(["open", c.sel]); return async () => log.push(["shut", c.sel]); },
      waitForReal: async (sel) => log.push(["waitForReal", sel]),
      tween: async (ms, fn) => { fn(1); log.push(["tween", ms]); },
      room: () => {},
      w: async () => {},
    },
  };
}

const DESK_LINES = [
  "Open an item and everything about it is right here.",
  "Your notes, then any paperwork you’ve added.",
  "Click one to bring it in.",
  "That’s a preview. Click it to read the whole thing.",
  "Snooze it, mark it done, add a document or retire it — all from here.",
  "Need to change something? Edit it right here.",
  "Click the date and pick a new one from the calendar.",
];
const POCKET_LINES = [
  "Open an item and everything about it is right here.",
  "Your notes, then any paperwork you’ve added.",
  "Tap one to bring it in.",
  "That’s a preview. Tap it to read the whole thing.",
  "Snooze it, mark it done, add a document or retire it — all from here.",
  "Need to change something? Edit it right here.",
  "Tap the date and pick a new one from the calendar.",
];

describe("the beats, against a recorder", () => {
  it("arrives on /home with the veil down, and never leaves it", async () => {
    const { log, ctx } = recorder();
    await item.play(ctx);
    expect(log[0]).toEqual(["setScreen", "/home"]);
    expect(log[1]).toEqual(["veil", false]);
    expect(log.filter(([word]) => word === "setScreen").map(([, route]) => route)).toEqual(["/home"]);
  });

  for (const [pocket, lines] of [[false, DESK_LINES], [true, POCKET_LINES]]) {
    it(`says round 2's lines, in order, word for word (${pocket ? "pocket" : "desk"})`, async () => {
      const { log, ctx } = recorder(pocket);
      await item.play(ctx);
      const said = log.filter(([word]) => word === "callout");
      expect(said.map(([, text]) => text)).toEqual(lines);
      /* "Click/Tap one to bring it in." is a label, as it always was */
      expect(said.filter(([, , label]) => label).map(([, text]) => text)).toEqual([lines[2]]);
    });
  }

  it("marks round 2's scenes, in order", async () => {
    const { log, ctx } = recorder();
    /* the callout's own mark option, and mark() itself */
    ctx.callout = async (text, anchor, side, o) => log.push(["mark", o.mark]);
    await item.play(ctx);
    expect(log.filter(([word]) => word === "mark").map(([, name]) => name)).toEqual([
      "item-row", "item-docs", "item-bring", "item-read", "item-acts", "item-editing", "item-edit", "item-calendar",
    ]);
  });

  it("presses the body, a paper, the pencil, the due value and cancel — never save, never complete", async () => {
    const { log, ctx } = recorder();
    await item.play(ctx);
    const S = SELECTORS.DESK;
    expect(log.filter(([word]) => word === "press").map(([, sel]) => sel)).toEqual([S.body, S.docs, S.pencil, S.due, S.cancel]);
  });

  it("opens the body's own row on the desk, then the paper, the editing and the calendar, and puts back all but the row", async () => {
    const { log, ctx } = recorder();
    await item.play(ctx);
    const S = SELECTORS.DESK;
    const real = log.filter(([word]) => ["open", "shut", "read", "unread"].includes(word));
    expect(real).toEqual([
      ["open", '.desk a.item[id="volvo"]'],
      ["read", S.docs],
      ["unread"],
      ["open", S.pencil],
      ["open", S.due],
      ["shut", S.due],
      ["shut", S.pencil],
    ]);
  });

  it("opens the row with the body's own tap on the pocket", async () => {
    const { log, ctx } = recorder(true);
    await item.play(ctx);
    expect(log.find(([word]) => word === "open")).toEqual(["open", SELECTORS.POCKET.body]);
  });

  it("waits for the drawer's record, and for the papers the body says it carries", async () => {
    const { log, ctx } = recorder();
    await item.play(ctx);
    const waits = log.filter(([word]) => word === "waitForReal").map(([, sel]) => sel);
    expect(waits.slice(0, 2)).toEqual([SELECTORS.DESK.foot, SELECTORS.DESK.docs]);
  });

  it("opens nothing, and waits for nothing, when the body has no row to open", async () => {
    const { log, ctx } = recorder(true);
    document.querySelector(".p-row")?.remove();
    await item.play(ctx);
    expect(log.filter(([word]) => word === "open").map(([, sel]) => sel)).toEqual([SELECTORS.POCKET.pencil, SELECTORS.POCKET.due]);
    expect(log.filter(([word]) => word === "waitForReal")).toEqual([]);
  });
});

/* ---- played for real, on a home near enough ----------------------------- */

async function playOut(clock, promise, sample = () => {}, step = 100, cap = 400000) {
  let finished = false;
  let failure = null;
  promise.then(() => { finished = true; }, (error) => { finished = true; failure = error; });
  let spent = 0;
  while (!finished && spent < cap) {
    clock.advance(step);
    spent += step;
    await settle();
    sample();
  }
  if (failure) throw failure;
  /* a wait for the page that never came stands the clock still: the loop
     runs out rather than the chapter finishing */
  if (!finished) throw new Error("the chapter never finished");
}

function liveFilm() {
  const clock = createClock({ reducedMotion: () => false });
  const ctx = createFilmContext({ clock, doc: document });
  clock.setPlaying(true);
  return { clock, ctx };
}

beforeEach(() => {
  document.body.innerHTML = "";
  setReducedMotion(false);
  window.innerWidth = 1440;
  window.innerHeight = 900;
});

describe("the chapter played for real", () => {
  it("puts round 2's desk lines on the screen in order", async () => {
    const home = drawHome();
    const { clock, ctx } = liveFilm();
    const seen = new Set();
    const said = [];
    await playOut(clock, item.play(ctx), () => {
      for (const note of document.querySelectorAll(".tourfilm-callout")) {
        if (seen.has(note)) continue;
        seen.add(note);
        said.push(note.textContent);
      }
    });
    expect(said).toEqual(DESK_LINES);
    ctx.destroy();
    home.done();
  });

  it("opens the row, the preview, the editing and the calendar for real, puts back all but the row, and writes nothing", async () => {
    const home = drawHome();
    const { clock, ctx } = liveFilm();
    const saw = { preview: false, editing: false, chooser: false };
    await playOut(clock, item.play(ctx), () => {
      if (document.querySelector("[data-preview-card]")) saw.preview = true;
      if (document.querySelector("[data-edit-rows]")) saw.editing = true;
      if (document.querySelector("[data-chooser-card]")) saw.chooser = true;
    });
    expect(saw).toEqual({ preview: true, editing: true, chooser: true });
    expect(document.querySelector("[data-preview-card]")).toBeNull();
    expect(document.querySelector("[data-chooser-card]")).toBeNull();
    expect(home.state.editing).toBe(false);
    /* the drawer stays open for chapter 9, lit */
    expect(document.querySelector("a.item.open + .itemview")).not.toBeNull();
    expect(ctx.lit().some((c) => c.sel === SELECTORS.DESK.drawer)).toBe(true);
    expect(home.writes.count).toBe(0);
    ctx.destroy();
    home.done();
  });

  it("a jump mid-chapter puts everything back, the row too — clear(), the same law unread() gives unwear()", async () => {
    const home = drawHome({ docs: 1 });
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document });
    const chapters = [item, { id: "after", name: "After", async play(c) { await c.hold(60000); } }];
    const player = createFilmPlayer({ clock, ctx, chapters });
    await player.measure();
    player.jump(0);
    await settle();

    let spent = 0;
    while (!document.querySelector("[data-chooser-card]") && spent < 400000) {
      clock.advance(100);
      spent += 100;
      await settle();
    }
    expect(document.querySelector("[data-chooser-card]")).not.toBeNull();
    expect(home.state.editing).toBe(true);

    player.jump(1); /* the reader jumps away, the calendar still up */
    await settle();
    expect(document.querySelector("[data-chooser-card]")).toBeNull();
    expect(home.state.editing).toBe(false);
    expect(document.querySelector(".itemview")).toBeNull();
    expect(home.writes.count).toBe(0);
    player.destroy();
    home.done();
  });

  it("leaves the real DOM exactly as it found it once the film is cleared", async () => {
    const home = drawHome({ docs: 1 });
    const before = home.scene.outerHTML;
    const { clock, ctx } = liveFilm();
    await playOut(clock, item.play(ctx));
    ctx.destroy();
    expect(home.scene.outerHTML).toBe(before);
    home.done();
  });

  it("plays the same beats, for the same length, whatever the household holds (the tick)", async () => {
    const lengthWith = async (options) => {
      const home = drawHome(options);
      const { clock, ctx } = liveFilm();
      await playOut(clock, item.play(ctx));
      const spent = clock.sched();
      ctx.destroy();
      home.done();
      return spent;
    };
    const several = await lengthWith({ docs: 4 });
    expect(await lengthWith({ docs: 1 })).toBe(several);
    expect(await lengthWith({ docs: 0 })).toBe(several);
    expect(await lengthWith({ body: false })).toBe(several);
    expect(await lengthWith({ row: false })).toBe(several);
  }, 30_000);

  it("and the same length as its own dry run, which is what the transport measured", async () => {
    const home = drawHome();
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document });
    clock.dryStart();
    await item.play(ctx);
    const measured = clock.dryEnd();
    clock.setPlaying(true);
    await playOut(clock, item.play(ctx));
    expect(clock.sched()).toBe(measured);
    ctx.destroy();
    home.done();
  });

  it("says every line at the sun, opening nothing, on a household with nothing in it", async () => {
    const home = drawHome({ body: false, row: false });
    box(/** @type {Element} */ (document.querySelector(".sun-link")), { x: 690, y: 330, w: 60, h: 60 });
    const { clock, ctx } = liveFilm();
    let opened = false;
    await playOut(clock, item.play(ctx), () => {
      if (document.querySelector(".itemview, [data-preview-card], [data-chooser-card]")) opened = true;
    });
    expect(opened).toBe(false);
    ctx.destroy();
    home.done();
  });
});
