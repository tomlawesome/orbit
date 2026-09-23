// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
    expect(style).toContain(".pp,#orbit-tour-transport .stp{width:32px;height:32px");
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

  it("keeps the ghost when stopped, and CSS brings it back on hover", async () => {
    const parts = film();
    await parts.player.measure();
    const { player } = withTransport(parts);
    player.jump(0);
    await settle();

    player.stop();
    expect(bar().classList.contains("gone")).toBe(true);
    const style = document.getElementById("orbit-tour-transport-styles").textContent;
    expect(style).toContain("#orbit-tour-transport.gone{opacity:.16}");
    expect(style).toContain("#orbit-tour-transport.gone:focus-within{opacity:1}");
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
    expect(bar().classList.contains("gone")).toBe(true);
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
