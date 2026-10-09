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
 * Inbox, The item (#1319: it replaced The belt), Done, Other households,
 * Your sky, Yours.
 */
import arrive from "./01-arrive.js";
import add from "./02-add.js";
import lands from "./03-lands.js";
import belowTheDial from "./04-below-the-dial.js";
import timeRuns from "./05-time-runs.js";
import paperByPost from "./06-paper-by-post.js";
import inbox from "./07-inbox.js";
import theItem from "./08-the-item.js";
import done from "./09-done.js";
import otherHouseholds from "./10-other-households.js";
import yourSky from "./11-your-sky.js";
import yours from "./12-yours.js";

/**
 * @typedef {object} Chapter
 * @property {string} id    stable name; the transport's tick and the review hooks use it
 * @property {string} name  what the transport prints above the playhead
 * @property {string} [enter] where the dot rests as the chapter opens, as a selector
 * @property {(ctx: import("../vocabulary.js").FilmContext) => Promise<void>} play
 */

/**
 * The film, in order (#1151 W3-Q3: all twelve are cut; this list used to
 * say only four were, a stale work-in-progress note the imports above had
 * already outgrown). A thirteenth chapter arrives the same way, as its own
 * file beside 01-arrive.js and one import line here.
 *
 * The list is DELIBERATELY not padded with placeholders for a chapter not
 * yet cut: the transport measures what is here and puts its ticks at the
 * starts it can see, so an empty chapter would take a tick and a name and
 * teach nothing.
 *
 * @type {Chapter[]}
 */
export const CHAPTERS = [
  arrive,
  add,
  lands,
  belowTheDial,
  timeRuns,
  paperByPost,
  inbox,
  theItem,
  done,
  otherHouseholds,
  yourSky,
  yours,
];

/** @param {string} id */
export function chapterIndex(id) {
  return CHAPTERS.findIndex((chapter) => chapter.id === id);
}
