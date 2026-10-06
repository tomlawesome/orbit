// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createClock } from "../../web/src/lib/tour/clock.js";
import { createFilmPlayer } from "../../web/src/lib/tour/player.js";
import { mmss, mountTransport } from "../../web/src/lib/tour/transport.js";
import { createFilmContext } from "../../web/src/lib/tour/vocabulary.js";

/*
 * #866: the transport is round 5's second ratified fix, and what it promises
 * is what round 4 proved and round 5 kept. Pinned here:
 *
 *  1. the playhead reads the FILM's budget, not the wall clock — so a jump
 *     to a chapter tick lands on exactly the reading that chapter starts at.
 *     Round 5's own headless check drives ticks 4, 8 and 11, so those three
 *     are named below;
 *  2. space toggles, Esc stops and fades the pill, and hover brings it back;
 *  3. the pill recedes to 38% while the film plays and keeps the 16% ghost
 *     when it has stopped or ended;
 *  4. a tick is a real button with a real name, and hovering one names its
 *     chapter while the chapter label yields;
 *  5. painted marks are small but hit targets are not (the ratified 32px
 *     circles and 18x38 tick hits).
 *
 * A stub twelve-chapter film stands in for the real one: the transport must
 * be right about twelve chapters before eleven of them exist, and a stub
 * with known lengths is the only way to say where a tick SHOULD be.
 */

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const BAR_ID = "orbit-tour-transport";
const bar = () => document.getElementById(BAR_ID);

function setReducedMotion(matches) {
  window.matchMedia = () => ({
    matches,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
}

/** #1083: a `matchMedia` that answers both the reduced-motion query and
 *  media.js's own `POCKET_QUERY` (`isPocket()`), so a test can mount the
 *  transport in whichever dialect it needs. */
function setMedia({ reduced = false, pocket = false } = {}) {
  window.matchMedia = (query) => ({
    matches: /prefers-reduced-motion/u.test(query) ? reduced : pocket,
    media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
}

/** Twelve chapters of known, different lengths, all of it reading time so
 *  the arithmetic is the same in either motion mode. */
const CHAPTERS = Array.from({ length: 12 }, (_, k) => ({
  id: `ch${k + 1}`,
  name: `Chapter ${k + 1}`,
  async play(ctx) {
    await ctx.hold(1000 * (k + 1));
  },
}));

/** Cumulative starts: 0, 1000, 3000, 6000, ... */
const EXPECTED_OFFSETS = CHAPTERS.reduce(
  (acc, _, k) => [...acc, k === 0 ? 0 : acc[k - 1] + 1000 * k],
  [],
);
const EXPECTED_TOTAL = 1000 * ((12 * 13) / 2);

function film({ reduced = false } = {}) {
  setReducedMotion(reduced);
  const clock = createClock({ reducedMotion: () => reduced });
  const ctx = createFilmContext({ clock, doc: document });
  const seen = { chapters: [], errors: [] };
  const player = createFilmPlayer({
    clock,
    ctx,
    chapters: CHAPTERS,
    onChapter: (index) => seen.chapters.push(index),
    onError: (error) => seen.errors.push(error),
  });
  return { clock, ctx, player, seen };
}

/** Puts the pill up without letting it drive itself from real frames. */
function withTransport(parts) {
  const face = mountTransport({ player: parts.player, clock: parts.clock, doc: document, loop: false });
  return { ...parts, face };
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  setReducedMotion(false);
  window.innerWidth = 1280;
  window.innerHeight = 800;
});

afterEach(() => {
  setReducedMotion(false);
});

describe("the reading budget", () => {
  it("measures every chapter's start before a frame is played", async () => {
    const { player } = film();
    const { offsets, total } = await player.measure();
    expect(offsets).toEqual(EXPECTED_OFFSETS);
    expect(total).toBe(EXPECTED_TOTAL);
  });

  it("lands a jump on the reading its chapter starts at, not on wall time", async () => {
    const { clock, player } = film();
    await player.measure();

    /* round 5's headless check drives exactly these three */
    for (const tick of [4, 8, 11]) {
      const index = tick - 1;
      player.jump(index);
      await settle();
      expect(player.chapter()).toBe(index);
      expect(clock.cursor()).toBe(EXPECTED_OFFSETS[index]);
    }
    player.destroy();
  });

  it("plays chapters back to back with nothing between them", async () => {
    const { clock, player, seen } = film();
    await player.measure();
    player.jump(0);
    await settle();

    /* run the first three chapters out: 1000 + 2000 + 3000 */
    for (let k = 0; k < 80; k++) {
      clock.advance(100);
      await settle();
      if (player.chapter() >= 3) break;
    }
    expect(seen.chapters.slice(0, 4)).toEqual([0, 1, 2, 3]);
    player.destroy();
  });

  it("measures shorter under reduced motion only where there is motion", async () => {
    /* these stub chapters are all reading, so both modes agree — which is
       round 5's rule stated as an equality rather than an inequality */
    const full = await film({ reduced: false }).player.measure();
    const still = await film({ reduced: true }).player.measure();
    expect(still.total).toBe(full.total);
  });
});

describe("the pill", () => {
  it("is a 470x44 pill centred at the bottom, with a named group role", async () => {
    const parts = film();
    await parts.player.measure();
    withTransport(parts);
    expect(bar().getAttribute("role")).toBe("group");
    expect(bar().getAttribute("aria-label")).toBe("Tour transport");
    const style = document.getElementById("orbit-tour-transport-styles").textContent;
    expect(style).toContain("width:470px;height:44px");
    expect(style).toContain("left:50%");
  });

  it("keeps hit targets big while the painted marks stay small", async () => {
    const parts = film();
    await parts.player.measure();
    withTransport(parts);
    const style = document.getElementById("orbit-tour-transport-styles").textContent;
    /* the ratified 32px buttons and the 18x38 hit around a 1x8 tick mark */
    expect(style).toContain(".pp,#orbit-tour-transport .skp{width:32px;height:32px");
    expect(style).toContain(".tick{position:absolute;top:6px;width:18px;height:38px");
    expect(style).toContain("width:1px;height:8px");
  });

  it("recedes while the film plays and returns whenever it is not", async () => {
    const parts = film();
    await parts.player.measure();
    const { clock, player } = withTransport(parts);

    player.jump(0);
    await settle();
    expect(bar().classList.contains("dim")).toBe(true);

    clock.setPlaying(false);
    expect(bar().classList.contains("dim")).toBe(false);
    player.destroy();
  });

  it("#1190: skip adds `leaving`, and the bar is gone once it fires onLeave", async () => {
    vi.useFakeTimers();
    try {
      const parts = film();
      await parts.player.measure();
      const { face, player } = withTransport(parts);
      face.onLeave(() => face.destroy()); /* film.js's own wiring */
      player.jump(0);
      await vi.advanceTimersByTimeAsync(0);

      bar().querySelector(".skp").click();
      expect(bar().classList.contains("leaving")).toBe(true);
      expect(document.getElementById(BAR_ID)).not.toBeNull();

      await vi.advanceTimersByTimeAsync(999);
      expect(document.getElementById(BAR_ID)).not.toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(document.getElementById(BAR_ID)).toBeNull();
      player.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("#1190: a natural finish holds at full strength for 3s, then leaves", async () => {
    vi.useFakeTimers();
    try {
      const parts = film();
      await parts.player.measure();
      const { face, player } = withTransport(parts);
      player.jump(0);
      await vi.advanceTimersByTimeAsync(0);

      /* a finish, not a skip: ended with nobody having pressed anything */
      player.stop();
      expect(bar().classList.contains("dim")).toBe(false);
      expect(bar().classList.contains("leaving")).toBe(false);

      await vi.advanceTimersByTimeAsync(2999);
      expect(bar().classList.contains("leaving")).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(bar().classList.contains("leaving")).toBe(true);
      face.destroy();
      player.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("#1190: play during the hold restarts the film and cancels the leave", async () => {
    vi.useFakeTimers();
    try {
      const parts = film();
      await parts.player.measure();
      const { face, player } = withTransport(parts);
      player.jump(0);
      await vi.advanceTimersByTimeAsync(0);

      player.stop();
      await vi.advanceTimersByTimeAsync(1500); /* partway through the 3s hold */
      player.toggle(); /* today's toggle(): past the end, start again */
      await vi.advanceTimersByTimeAsync(0);
      expect(player.ended()).toBe(false);
      expect(bar().classList.contains("leaving")).toBe(false);

      /* waiting out what would have been the hold and the leave: neither fires */
      await vi.advanceTimersByTimeAsync(3000 + 1000);
      expect(bar().classList.contains("leaving")).toBe(false);
      expect(document.getElementById(BAR_ID)).not.toBeNull();
      face.destroy();
      player.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("#1190: focus inside the bar moves to main when it leaves", async () => {
    vi.useFakeTimers();
    try {
      const main = document.createElement("main");
      document.body.appendChild(main);
      const parts = film();
      await parts.player.measure();
      const { face, player } = withTransport(parts);
      player.jump(0);
      await vi.advanceTimersByTimeAsync(0);

      const skip = bar().querySelector(".skp");
      skip.focus();
      skip.click();
      expect(document.activeElement).toBe(main);
      face.destroy();
      player.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("#1190: focus inside the bar moves to body when there is no main", async () => {
    vi.useFakeTimers();
    try {
      const parts = film();
      await parts.player.measure();
      const { face, player } = withTransport(parts);
      player.jump(0);
      await vi.advanceTimersByTimeAsync(0);

      const skip = bar().querySelector(".skp");
      skip.focus();
      skip.click();
      expect(document.activeElement).toBe(document.body);
      face.destroy();
      player.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("#1190: the skip control is labelled, same slot as the old Stop", async () => {
    const parts = film();
    await parts.player.measure();
    withTransport(parts);
    const skip = bar().querySelector(".skp");
    expect(skip.getAttribute("aria-label")).toBe("Skip the tour");
    expect(skip.getAttribute("title")).toBe("Skip the tour · esc");
  });

  it("#1190: announces a skip, not a stop", async () => {
    const parts = film();
    await parts.player.measure();
    const { player } = withTransport(parts);
    player.jump(0);
    await settle();
    const status = bar().querySelector('[role="status"]');
    expect(status.textContent).toContain("Press Escape to skip it.");

    bar().querySelector(".skp").click();
    expect(status.textContent).toBe("Tour skipped. Your sky is back.");
    player.destroy();
  });

  it("prints m:ss / m:ss", () => {
    expect(mmss(0)).toBe("0:00");
    expect(mmss(221000)).toBe("3:41"); /* the ratified length */
    expect(mmss(127000)).toBe("2:07"); /* and its reduced-motion length */
  });
});

describe("the ticks", () => {
  it("puts one named button per chapter, at its chapter's start", async () => {
    const parts = film();
    await parts.player.measure();
    const { face } = withTransport(parts);
    face.refresh();

    const ticks = [...bar().querySelectorAll(".tick")];
    expect(ticks).toHaveLength(12);
    expect(ticks[3].getAttribute("aria-label")).toBe("Chapter 4: Chapter 4");
    const expected = (EXPECTED_OFFSETS[3] / EXPECTED_TOTAL) * 100;
    expect(parseFloat(ticks[3].style.left)).toBeCloseTo(expected, 5);
  });

  it("jumps to its chapter when pressed", async () => {
    const parts = film();
    await parts.player.measure();
    const { clock, player } = withTransport(parts);

    [...bar().querySelectorAll(".tick")][7].click();
    await settle();
    expect(player.chapter()).toBe(7);
    expect(clock.cursor()).toBe(EXPECTED_OFFSETS[7]);
    player.destroy();
  });

  it("names its chapter on hover, and the chapter label yields while it does", async () => {
    const parts = film();
    await parts.player.measure();
    const { face, player } = withTransport(parts);
    face.refresh();

    const tick = [...bar().querySelectorAll(".tick")][10];
    tick.dispatchEvent(new window.MouseEvent("mouseenter"));
    const tip = bar().querySelector(".tip");
    expect(tip.textContent).toBe("Chapter 11");
    expect(tip.classList.contains("on")).toBe(true);
    expect(bar().querySelector(".track").classList.contains("tipping")).toBe(true);

    tick.dispatchEvent(new window.MouseEvent("mouseleave"));
    expect(bar().querySelector(".track").classList.contains("tipping")).toBe(false);
    player.destroy();
  });

  it("marks the chapter now playing", async () => {
    const parts = film();
    await parts.player.measure();
    const { player } = withTransport(parts);
    player.jump(5);
    await settle();
    const ticks = [...bar().querySelectorAll(".tick")];
    expect(ticks[5].classList.contains("here")).toBe(true);
    expect(ticks.filter((t) => t.classList.contains("here"))).toHaveLength(1);
    expect(bar().querySelector(".now").textContent).toBe("CHAPTER 6");
    player.destroy();
  });
});

describe("the keys", () => {
  it("toggles on space", async () => {
    const parts = film();
    await parts.player.measure();
    const { player } = withTransport(parts);
    player.jump(0);
    await settle();
    expect(player.playing()).toBe(true);

    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    expect(player.playing()).toBe(false);

    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    expect(player.playing()).toBe(true);
    player.destroy();
  });

  it("stops on Escape", async () => {
    const parts = film();
    await parts.player.measure();
    const { player } = withTransport(parts);
    player.jump(0);
    await settle();

    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(player.ended()).toBe(true);
    expect(player.playing()).toBe(false);
    expect(bar().classList.contains("leaving")).toBe(true);
    player.destroy();
  });

  it("starts again from the top once it has ended", async () => {
    const parts = film();
    await parts.player.measure();
    const { clock, player } = withTransport(parts);
    player.jump(4);
    await settle();
    player.stop();
    expect(player.ended()).toBe(true);

    player.toggle();
    await settle();
    expect(player.ended()).toBe(false);
    expect(player.chapter()).toBe(0);
    expect(clock.cursor()).toBe(0);
    player.destroy();
  });
});

describe("a chapter that throws", () => {
  it("stops the film rather than playing on over a screen that is not there", async () => {
    setReducedMotion(false);
    const clock = createClock({ reducedMotion: () => false });
    const ctx = createFilmContext({ clock, doc: document });
    const errors = [];
    const player = createFilmPlayer({
      clock,
      ctx,
      chapters: [{
        id: "broken",
        name: "Broken",
        async play(context) {
          context.ctl({ sel: ".nothing-the-product-renders" });
        },
      }],
      onError: (error) => errors.push(error),
    });
    await player.measure();
    player.jump(0);
    await settle();

    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("nothing-the-product-renders");
    expect(player.playing()).toBe(false);
    expect(player.ended()).toBe(true);
  });
});

describe("#1083: the pocket transport", () => {
  /** Puts the pill up in the pocket dialect. */
  function withPocketTransport(parts) {
    setMedia({ pocket: true });
    const face = mountTransport({ player: parts.player, clock: parts.clock, doc: document, loop: false });
    return { ...parts, face };
  }

  afterEach(() => {
    setMedia({ pocket: false });
    document.documentElement.removeAttribute("data-tour-pocket");
  });

  it("paints twelve <i> ticks, not buttons, and carries data-pocket-above", async () => {
    const parts = film();
    await parts.player.measure();
    withPocketTransport(parts);

    const ticks = [...bar().querySelectorAll(".tick")];
    expect(ticks).toHaveLength(12);
    for (const tick of ticks) expect(tick.tagName).toBe("I");
    expect(bar().getAttribute("data-pocket-above")).toBe("");
    expect(document.documentElement.hasAttribute("data-tour-pocket")).toBe(true);
  });

  it("keeps ticks as real buttons on desk, and adds no pocket-only attribute", async () => {
    const parts = film();
    await parts.player.measure();
    withTransport(parts); /* desk mount, default matchMedia (pocket false) */

    const ticks = [...bar().querySelectorAll(".tick")];
    for (const tick of ticks) expect(tick.tagName).toBe("BUTTON");
    expect(bar().hasAttribute("data-pocket-above")).toBe(false);
    expect(document.documentElement.hasAttribute("data-tour-pocket")).toBe(false);
  });

  it("the rail is one role=slider target with the chapter's own aria-valuenow", async () => {
    const parts = film();
    await parts.player.measure();
    const { player } = withPocketTransport(parts);
    player.jump(3);
    await settle();

    const track = bar().querySelector(".track");
    expect(track.getAttribute("role")).toBe("slider");
    expect(track.getAttribute("aria-valuemin")).toBe("0");
    expect(track.getAttribute("aria-valuemax")).toBe("11");
    expect(track.getAttribute("aria-valuenow")).toBe("3");
    expect(track.getAttribute("aria-valuetext")).toContain("Chapter 4");
    player.destroy();
  });

  it("a pointer drag aims a tick and jumps to it on release", async () => {
    const parts = film();
    await parts.player.measure();
    const { player } = withPocketTransport(parts);
    const track = bar().querySelector(".track");
    track.getBoundingClientRect = () => ({ left: 0, right: 250, width: 250, top: 0, bottom: 44, height: 44, x: 0, y: 0, toJSON() {} });
    track.setPointerCapture = () => {};

    /* aimed near the very end of the rail */
    track.dispatchEvent(new window.PointerEvent("pointerdown", { pointerId: 1, clientX: 240, bubbles: true }));
    expect(bar().querySelector(".now").classList.contains("aim")).toBe(true);
    expect(bar().classList.contains("touched")).toBe(true);

    track.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 1, clientX: 240, bubbles: true }));
    await settle();
    expect(bar().querySelector(".now").classList.contains("aim")).toBe(false);
    expect(player.chapter()).toBe(11); /* the last chapter, nearest the far end */
    player.destroy();
  });

  it("ArrowRight/ArrowLeft/Home/End jump the rail", async () => {
    const parts = film();
    await parts.player.measure();
    const { player } = withPocketTransport(parts);
    player.jump(5);
    await settle();
    const track = bar().querySelector(".track");

    track.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    expect(player.chapter()).toBe(6);
    track.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    expect(player.chapter()).toBe(5);
    track.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
    expect(player.chapter()).toBe(0);
    track.dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
    expect(player.chapter()).toBe(11);
    player.destroy();
  });

  it("docks to .top the instant a kit sheet opens, and comes home 350ms after it closes", async () => {
    vi.useFakeTimers();
    try {
      const parts = film();
      await parts.player.measure();
      const { player } = withPocketTransport(parts);
      player.jump(0);
      await vi.advanceTimersByTimeAsync(0);

      /* Real Sheet.svelte components mount their own `.p-sheet-layer` once
         and toggle `open` on it after — an attribute change, not a new
         node — which is exactly what the dock's own MutationObserver
         watches for (§4.4: "attributes, class"). */
      const layer = document.createElement("div");
      layer.className = "p-sheet-layer";
      document.body.appendChild(layer);
      await vi.advanceTimersByTimeAsync(0);

      layer.classList.add("open");
      /* immediate on .open appearing (owner's fix 1) — no 150ms fade owed */
      await vi.advanceTimersByTimeAsync(0);
      expect(bar().classList.contains("top")).toBe(true);

      layer.classList.remove("open");
      await vi.advanceTimersByTimeAsync(0);
      expect(bar().classList.contains("top")).toBe(true); /* not yet — 350ms owed */
      await vi.advanceTimersByTimeAsync(349);
      expect(bar().classList.contains("top")).toBe(true);
      /* the 350ms mark fires the move; the move's own 150ms fade-out then
         applies the class */
      await vi.advanceTimersByTimeAsync(1 + 150);
      expect(bar().classList.contains("top")).toBe(false);
      player.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stands .raised when a .pk-bar owns the foot", async () => {
    vi.useFakeTimers();
    try {
      const parts = film();
      await parts.player.measure();
      const { player } = withPocketTransport(parts);
      /* Mounted closed first, then given its class, the same way the dock's
         attribute-only observer expects (see the .top test's own note). */
      const pkBar = document.createElement("div");
      pkBar.getBoundingClientRect = () => ({ height: 64, top: 0, bottom: 64, left: 0, right: 390, width: 390, x: 0, y: 0, toJSON() {} });
      document.body.appendChild(pkBar);
      await vi.advanceTimersByTimeAsync(0);
      pkBar.className = "pk-bar";
      await vi.advanceTimersByTimeAsync(0);
      /* home -> raised is an ordinary move: the 150ms fade applies first */
      await vi.advanceTimersByTimeAsync(151);
      expect(bar().classList.contains("raised")).toBe(true);
      player.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores its own tourfilm-marked Escape, and lets a reader's own sheet close without stopping the film", async () => {
    const parts = film();
    await parts.player.measure();
    const { player } = withPocketTransport(parts);
    player.jump(0);
    await settle();

    const tourfilmEscape = new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    Object.defineProperty(tourfilmEscape, "tourfilm", { value: true });
    document.dispatchEvent(tourfilmEscape);
    expect(player.ended()).toBe(false);

    const layer = document.createElement("div");
    layer.className = "p-sheet-layer open";
    document.body.appendChild(layer);
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    /* the film did not open this sheet (hasFilmOpenedSheet defaults false),
       so the film must not stop for it */
    expect(player.ended()).toBe(false);
    player.destroy();
  });

  it("still stops on a real Escape with no sheet up", async () => {
    const parts = film();
    await parts.player.measure();
    const { player } = withPocketTransport(parts);
    player.jump(0);
    await settle();
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(player.ended()).toBe(true);
    player.destroy();
  });
});
