// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CHAPTERS } from "../../web/src/lib/tour/chapters/index.js";
import { createClock } from "../../web/src/lib/tour/clock.js";
import { createFilmPlayer } from "../../web/src/lib/tour/player.js";
import { mountTransport } from "../../web/src/lib/tour/transport.js";
import { createFilmContext } from "../../web/src/lib/tour/vocabulary.js";

/*
 * Round 7 (#1097): a screen reader gets the film's script, not narration on
 * a clock. The script is never a second copy of a chapter's words -- it
 * comes straight out of player.js's own measuring pass, the same one that
 * places the transport's ticks -- so this test drives the REAL CHAPTERS
 * registry, exactly as v19-tour-transport.test.mjs's "reading budget" block
 * does for the offsets, rather than a stub film that could drift from what
 * the twelve chapters actually say.
 *
 * Dry mode touches no DOM at all (v19-tour-vocabulary.test.mjs's own "dry
 * mode" block), so `document` here never needs the real product's markup:
 * every `ctl()` inside a chapter short-circuits before it would ever query
 * for a selector.
 */

function setReducedMotion(matches) {
  window.matchMedia = () => ({
    matches,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
}

/** The label-only lines the current registry pins (round 7's README: the
 *  small uppercase tags on lanes and papers, not sentences) -- read from
 *  the chapters themselves so this test fails loudly if a callout's
 *  `label: true` is ever dropped without the transcript noticing. */
const LABEL_ONLY_LINES = [
  "Filed",
  "For your review",
  "Still reading",
  "Click one to bring it in.",
  "star chart · after dark · clouds · dawn · retrograde",
];

function stage() {
  setReducedMotion(false);
  const clock = createClock({ reducedMotion: () => false });
  const ctx = createFilmContext({ clock, doc: document });
  const player = createFilmPlayer({ clock, ctx, chapters: CHAPTERS });
  return { clock, ctx, player };
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

describe("the film's script (round 7, #1097)", () => {
  it("has a non-empty transcript for every one of the twelve chapters", async () => {
    const { player } = stage();
    const { script } = await player.measure();

    expect(CHAPTERS).toHaveLength(12);
    expect(script).toHaveLength(12);
    script.forEach((lines, k) => {
      expect(lines.length, `chapter ${k + 1} (${CHAPTERS[k].name})`).toBeGreaterThan(0);
      for (const line of lines) {
        expect(typeof line).toBe("string");
        expect(line.trim().length).toBeGreaterThan(0);
      }
    });
  });

  it("carries no label-only line -- a picture naming a part, not a sentence", async () => {
    const { player } = stage();
    const { script } = await player.measure();
    const allLines = script.flat();
    for (const label of LABEL_ONLY_LINES) {
      expect(allLines).not.toContain(label);
    }
  });

  it("agrees with player.script() after measure(), the same as offsets()/total()", async () => {
    const { player } = stage();
    const measured = await player.measure();
    expect(player.script()).toEqual(measured.script);
  });

  it("matches the transport's own tick headings, \"Chapter N: Name\"", async () => {
    const { player, clock } = stage();
    await player.measure();
    const face = mountTransport({ player, clock, doc: document, loop: false });
    face.refresh();

    const region = document.querySelector('[aria-label="Tour script"]');
    expect(region).not.toBeNull();
    const headings = [...region.querySelectorAll("h3")].map((h) => h.textContent);
    expect(headings).toHaveLength(12);

    const ticks = [...document.querySelectorAll(`#${face.bar.id} .tick`)];
    expect(ticks).toHaveLength(12);

    headings.forEach((heading, k) => {
      expect(heading).toBe(`Chapter ${k + 1}: ${CHAPTERS[k].name}`);
      expect(heading).toBe(ticks[k].getAttribute("aria-label"));
    });

    face.destroy();
  });
});
