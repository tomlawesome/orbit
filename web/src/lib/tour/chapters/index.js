/**
 * THE CHAPTER REGISTRY (#866).
 *
 * The film is twelve chapters played back to back with nothing between them.
 * They are declared one per file — a hard rule, so the eleven still to be
 * cut can be added in parallel without two of them meeting in the same file
 * — and ordered here, which is the only place the order is written down.
 *
 * The transport reads this list and nothing else: it measures each entry's
 * length, puts a tick where each one starts, and names the one playing. So
 * adding a chapter is adding a file and a line below.
 *
 * ORDER IS THE RATIFIED ORDER (design/v19/tour/round-5/README.md, "The
 * film"): Arrive, Add, Lands, Below the dial, Time runs, Paper by post,
 * Inbox, The belt, Done, Other households, Your sky, Yours.
 */
import arrive from "./01-arrive.js";
import add from "./02-add.js";
import timeRuns from "./05-time-runs.js";
import yourSky from "./11-your-sky.js";

/**
 * @typedef {object} Chapter
 * @property {string} id    stable name; the transport's tick and the review hooks use it
 * @property {string} name  what the transport prints above the playhead
 * @property {string} [enter] where the dot rests as the chapter opens, as a selector
 * @property {(ctx: import("../vocabulary.js").FilmContext) => Promise<void>} play
 */

/**
 * The film, in order. Four of the twelve are cut; the rest arrive the same
 * way, each as its own file beside 01-arrive.js and one import line here.
 *
 * The list is DELIBERATELY not padded with placeholders for the eight still
 * to come: the transport measures what is here and puts its ticks at the
 * starts it can see, so an empty chapter would take a tick and a name and
 * teach nothing. The gaps close as the files land.
 *
 * @type {Chapter[]}
 */
export const CHAPTERS = [
  arrive,
  add,
  timeRuns,
  yourSky,
];

/** @param {string} id */
export function chapterIndex(id) {
  return CHAPTERS.findIndex((chapter) => chapter.id === id);
}
