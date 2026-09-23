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
 * check can be pointed at the product.
 */
import { createClock } from "./clock.js";
import { CHAPTERS } from "./chapters/index.js";
import { createFilmPlayer } from "./player.js";
import { mountTransport } from "./transport.js";
import { createFilmContext } from "./vocabulary.js";

/**
 * @param {object} [options]
 * @param {Document} [options.doc]
 * @param {import("./chapters/index.js").Chapter[]} [options.chapters]
 * @param {() => string} [options.routeOf]
 * @param {(route: string) => Promise<unknown>} [options.navigate]
 * @param {(route: string) => Promise<unknown>} [options.settle]
 * @param {boolean} [options.transport] mount the pill (off for a headless run)
 * @param {(error: unknown) => void} [options.onError]
 */
export function createFilm({
  doc = document,
  chapters = CHAPTERS,
  routeOf,
  navigate,
  settle,
  transport = true,
  onError = (error) => console.error("Tour film stopped:", error),
} = {}) {
  const clock = createClock();
  const ctx = createFilmContext({ clock, doc, routeOf, navigate, settle });

  /** @type {ReturnType<typeof mountTransport> | null} */
  let face = null;

  const player = createFilmPlayer({
    clock,
    ctx,
    chapters,
    onChapter: (index) => face?.markChapter(index),
    onEnd: () => face?.setRecede(),
    onError,
  });

  const hooks = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window));

  /**
   * Measures the film, puts the transport up, and plays from the top — or
   * from the chapter asked for, which is how a review jumps straight to the
   * one it is looking at.
   *
   * @param {{ from?: number }} [options]
   */
  async function start({ from = 0 } = {}) {
    const { offsets, total } = await player.measure();
    if (transport) face = mountTransport({ player, clock, doc });
    hooks.__total = total;
    hooks.__offsets = offsets.slice();
    hooks.__chapters = chapters.map((one, k) => ({ id: one.id, name: one.name, at: offsets[k] }));
    hooks.__jump = player.jump;
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

  return {
    start,
    player,
    clock,
    ctx,
    destroy() {
      face?.destroy();
      face = null;
      player.destroy();
    },
  };
}
