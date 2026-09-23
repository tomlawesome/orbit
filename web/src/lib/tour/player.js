/**
 * THE PLAYER (#866): the film's runner, and the budget the transport paints.
 *
 * The mockup keeps this and its transport in one lump
 * (design/v19/tour/round-5/f-one-take.html, "THE TRANSPORT"). They are
 * separated here because only half of it is about a pill at the bottom of
 * the screen: measuring the film, sequencing twelve chapters, and
 * abandoning one mid-sentence when the reader jumps are the FILM's business
 * and are worth testing without any chrome in the document at all.
 * transport.js is this object's face; nothing below knows it exists.
 *
 * THE READING BUDGET, not the wall clock. The mockup's own comment: the time
 * bar "reads the film's own budget rather than the wall clock — so a jump to
 * a chapter tick lands the bar on exactly the reading that chapter starts
 * at." Before a frame is played, `measure()` runs all twelve chapters
 * against a stopped clock (clock.js's dry mode, vocabulary.js's stubs) and
 * adds up what each one asks for. That gives the total and every chapter's
 * offset; a jump then seeks the clock to the offset and starts the chapter
 * there, so the playhead and the words are never telling different stories.
 *
 * Because reading time survives reduced motion and motion time does not, the
 * measurement is taken in whichever mode the reader is actually in: 3:41 of
 * budget normally, 2:07 reduced, both measured the same way.
 *
 * CANCELLING A CHAPTER. A chapter suspended deep inside its own awaits
 * cannot be resumed somewhere else, so a jump bumps a generation, cancels
 * the clock, and lets the CANCEL rejection unwind the old coroutine through
 * its own awaits while the new one starts. Both guards are needed: the
 * generation catches a chapter that finished cleanly just as the reader
 * jumped, the rejection catches one still waiting.
 */
import { CANCEL } from "./clock.js";

/**
 * @typedef {object} FilmPlayer
 * @property {() => Promise<{ offsets: number[], total: number }>} measure
 * @property {(index?: number) => void} jump
 * @property {() => void} stop
 * @property {() => void} toggle
 * @property {(on: boolean) => void} setPlaying
 * @property {() => number} total
 * @property {() => number[]} offsets
 * @property {() => number} chapter
 * @property {() => boolean} ended
 * @property {() => boolean} playing
 * @property {() => number} cursor
 * @property {() => import("./chapters/index.js").Chapter[]} chapters
 * @property {() => void} destroy
 */

/**
 * @param {object} options
 * @param {import("./clock.js").FilmClock} options.clock
 * @param {import("./vocabulary.js").FilmContext} options.ctx
 * @param {import("./chapters/index.js").Chapter[]} options.chapters
 * @param {(index: number) => void} [options.onChapter]
 * @param {(ended: boolean) => void} [options.onEnd]
 * @param {(error: unknown) => void} [options.onError]
 * @returns {FilmPlayer}
 */
export function createFilmPlayer({
  clock,
  ctx,
  chapters,
  onChapter = () => {},
  onEnd = () => {},
  onError = () => {},
}) {
  /** @type {number[]} */
  let offsets = chapters.map(() => 0);
  let total = 0;
  let chapter = 0;
  let ended = false;
  let generation = 0;

  /**
   * Every chapter's start offset and the film's whole length, measured by
   * playing it with the clock stopped. Nothing is drawn and nothing is
   * navigated to: the vocabulary stubs itself out in dry mode, so this costs
   * a few microtasks rather than 3:41.
   */
  async function measure() {
    /** @type {number[]} */
    const measured = [];
    let running = 0;
    for (const one of chapters) {
      measured.push(running);
      clock.dryStart();
      try {
        await one.play(ctx);
      } catch (error) {
        if (error !== CANCEL) {
          clock.dryEnd();
          throw error;
        }
      }
      running += clock.dryEnd();
    }
    offsets = measured;
    total = running;
    return { offsets: offsets.slice(), total };
  }

  /** @param {number} index */
  function setChapter(index) {
    chapter = index;
    onChapter(index);
  }

  /**
   * The film itself: chapters awaited back to back, with nothing between
   * them. That is the whole of "one take".
   *
   * @param {number} from
   */
  async function run(from) {
    const mine = ++generation;
    try {
      for (let k = from; k < chapters.length; k++) {
        if (mine !== generation) return;
        setChapter(k);
        ctx.enter(chapters[k].enter);
        await chapters[k].play(ctx);
      }
    } catch (error) {
      if (error === CANCEL) return;
      /* A selector the product no longer renders, or anything else the film
         did not expect. Stopping is the honest response — a film carrying on
         over a chapter that threw is teaching a screen that is not there. */
      stop();
      onError(error);
      return;
    }
    if (mine === generation) finish();
  }

  /** The end of the film: the stage cleared, the clock parked on the total. */
  function finish() {
    ended = true;
    generation++;
    clock.cancel();
    clock.seek(total);
    ctx.clear();
    ctx.veil(false);
    clock.setPlaying(false);
    onEnd(true);
  }

  /** Esc, and the stop button. Same as finishing, but from wherever it is. */
  function stop() {
    generation++;
    clock.cancel();
    ctx.clear();
    ctx.veil(false);
    clock.setPlaying(false);
    ended = true;
    onEnd(true);
  }

  /**
   * Starts chapter `index` at the reading its tick stands on. The cursor is
   * seeked to the measured offset, not to wherever the wall clock had got
   * to, which is what makes a tick land on its chapter's first line.
   *
   * @param {number} [index]
   */
  function jump(index = 0) {
    const k = Math.max(0, Math.min(index, chapters.length - 1));
    generation++;
    clock.cancel();
    ctx.clear();
    ended = false;
    onEnd(false);
    clock.seek(offsets[k] ?? 0);
    clock.setPlaying(true);
    setChapter(k);
    void run(k);
  }

  /** Space, and the play/pause button. Past the end, it starts again. */
  function toggle() {
    if (ended) {
      jump(0);
      return;
    }
    clock.setPlaying(!clock.playing());
  }

  return {
    measure,
    jump,
    stop,
    toggle,
    setPlaying: (on) => clock.setPlaying(on),
    total: () => total,
    offsets: () => offsets.slice(),
    chapter: () => chapter,
    ended: () => ended,
    playing: () => clock.playing(),
    cursor: () => clock.cursor(),
    chapters: () => chapters.slice(),
    destroy() {
      generation++;
      clock.cancel();
      ctx.destroy();
    },
  };
}
