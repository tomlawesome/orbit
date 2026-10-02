/**
 * THE FILM (#866): the spine, assembled.
 *
 * One continuous take of twelve chapters over Orbit's own screens, with a
 * transport under it. This module is where the four parts meet and nothing
 * else: the clock everything hangs off (clock.js), the vocabulary the
 * chapters are written in (vocabulary.js), the runner and its reading budget
 * (player.js), and the pill (transport.js). The chapters themselves are a
 * registry of files (chapters/).
 *
 * WHAT IS DELIBERATELY NOT HERE. The first-login trigger, skip and take-
 * again: whoever puts the film in front of a reader decides when it plays.
 * This hands back `start` and `destroy` and holds no opinion about either.
 *
 * THE REVIEW HOOKS are the mockup's, kept because the design's own headless
 * check drives the film through them — `window.__chapters` for where each
 * chapter starts, `window.__reading` for what the clock and the label say,
 * and `__jump` / `__stop` / `__pause` / `__play` to work the transport
 * without a mouse. They are the same names the mockup exposes, so the same
 * check can be pointed at the product. `window.__script` is round 7's own
 * addition, the mockup having no script to expose: every chapter's
 * transcript, so the same check can read what a screen reader gets.
 */
import { createClock } from "./clock.js";
import { CHAPTERS } from "./chapters/index.js";
import { householdCarriesPapers } from "./chapters/08-the-belt.js";
import { createFilmPlayer } from "./player.js";
import { mountTransport } from "./transport.js";
import { createFilmContext } from "./vocabulary.js";

/**
 * @param {object} [options]
 * @param {Document} [options.doc]
 * @param {boolean} [options.pocket] the pocket dialect (`isPocket()`, decided by the caller)
 * @param {import("./chapters/index.js").Chapter[]} [options.chapters]
 * @param {() => string} [options.routeOf]
 * @param {(route: string) => Promise<unknown>} [options.navigate]
 * @param {(route: string) => Promise<unknown>} [options.settle]
 * @param {boolean} [options.transport] mount the pill (off for a headless run)
 * @param {(error: unknown) => void} [options.onError]
 */
export function createFilm({
  doc = document,
  pocket = false,
  chapters = CHAPTERS,
  routeOf,
  navigate,
  settle,
  transport = true,
  onError = (error) => console.error("Tour film stopped:", error),
} = {}) {
  const clock = createClock();
  const ctx = createFilmContext({ clock, doc, pocket, routeOf, navigate, settle });

  /** @type {ReturnType<typeof mountTransport> | null} */
  let face = null;
  /** #1190: destroy() is called from more than one place now — the bar's
   *  own leave, and whoever assembles the film unmounting — so it must be
   *  safe to call twice. */
  let destroyed = false;

  /* No onChapter/onEnd here: the transport subscribes to the player itself
     (player.js's follower lists), so the two stay wired however this is
     assembled. */
  const player = createFilmPlayer({ clock, ctx, chapters, onError });

  const hooks = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window));

  /**
   * Measures the film, puts the transport up, and plays from the top — or
   * from the chapter asked for, which is how a review jumps straight to the
   * one it is looking at.
   *
   * @param {{ from?: number }} [options]
   */
  async function start({ from = 0 } = {}) {
    /* #1174 round 6: chapters 8 and 9 take another path when no body
       carries a paper, and the measure has to know which before a frame
       plays. Home's sky is server-drawn and then read again in the
       browser; `body[data-home-ready]` is that read having landed, so the
       sky is asked once it has (bounded: a home that never says so is
       read as it stands). */
    await homeSettled();
    ctx.setCarriesPapers(householdCarriesPapers(doc, pocket));
    const { offsets, total } = await player.measure();
    /* transport.js decides its own dialect (isPocket(), at mount inside
       buildTicks) rather than being told: the pill's shape is CSS-driven
       exactly as the product's own screens are, and only the tick's element
       type needs a JS branch at all (#1083 §4.2). */
    if (transport) {
      face = mountTransport({ player, clock, doc, hasFilmOpenedSheet: ctx.hasOpenUndo });
      /* #1190: the bar's own leave (skip, or a natural finish's hold) is
         what ends the film now — not just the next take or an unmount. */
      face.onLeave(() => destroy());
    }
    hooks.__total = total;
    hooks.__offsets = offsets.slice();
    hooks.__chapters = chapters.map((one, k) => ({ id: one.id, name: one.name, at: offsets[k] }));
    /* Round 7 (#1097): the script every chapter plays, so the design host's
       own headless check can read it the same way it reads __chapters. */
    hooks.__script = player.script();
    hooks.__jump = player.jump;
    /* #1174: the film's own account of its rings, for the phone check. */
    hooks.__lit = ctx.litBoxes;
    /* #1174 round 6: every wait for the page that ran out. */
    hooks.__waitedOut = ctx.waitedOut;
    hooks.__stop = player.stop;
    hooks.__pause = () => player.setPlaying(false);
    hooks.__play = () => player.setPlaying(true);
    hooks.__reading = () => ({
      cursor: player.cursor(),
      total: player.total(),
      chapter: player.chapter(),
      name: chapters[player.chapter()]?.name ?? "",
    });
    face?.refresh();
    player.jump(from);
    return { offsets, total };
  }

  /** Waits, up to 6s, for home's own read to land (#1174 round 6). */
  async function homeSettled() {
    const body = doc.body;
    if (!body || body.dataset.homeReady === "true") return;
    const until = Date.now() + 6_000;
    while (body.dataset.homeReady !== "true" && Date.now() < until) {
      await new Promise((res) => setTimeout(res, 50));
    }
  }

  return {
    start,
    player,
    clock,
    ctx,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      face?.destroy();
      face = null;
      player.destroy();
    },
  };
}
