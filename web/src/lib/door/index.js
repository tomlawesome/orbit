/*
 * The shared door: the Earth door and the flight, their engine and timeline, and the imagery they draw. This folder
 * is the one copy, kept on the site and pulled into Orbit unchanged (ADR-0001). Nothing in it imports from outside
 * it, and this file is the only one a host imports: what the host and the door say to each other goes through here
 * (README.md in this folder: the interface).
 */
import { configure, settings } from "./settings.js";
import { choresNow, watchTyping } from "./chores.js";
import { mountDawn, mountDusk } from "./dawn.js";
import { createJourney } from "./journey.js";

export { settings };
/* the background work (chores.js): a host's own worlds queue their GPU work here too, so it takes its turn with the door's */
export { chore, fetchOnce, fetchBitmap, linked, counted, note, noteChores, quiet, openChores, openCompiles, openSoft, softRan, hurryChores, programs, compilesAside, holdReveal, moving } from "./chores.js";
/* and the one limit on a wait for a background compile, for a host's own shaders */
export { compiledWithin, COMPILE_WAIT } from "./chores.js";
export { uploadBanded } from "./upload.js";
/* what this machine can carry (capability.js), and the level the door ships at */
export { probe, level, liveDoor, lateDoor } from "./capability.js";
/* whether the page may use the GPU at all, decided once from one context (fitness.js), and the renderer names it refuses */
export { gpu, isSoftware, FIT_MS } from "./fitness.js";
/* and the verdict on the flight's world remembered on this device for a week (ADR-0002 6.4): a host decides by it
   whether the proof waits for leisure or is asked at once */
export { rememberedFit, WEEK } from "./fitness.js";
/* whether the flight is drawn in a worker (fitness.js), for a host that puts its own drawing beside it */
export { drawnAside } from "./fitness.js";
/* and whether the pictures are decoded by the image loader (fitness.js), which a host's worker is told, and answers a worker's ask for (chores.js) */
export { decodeAside } from "./fitness.js";
export { decodeBlob } from "./chores.js";
/* the host's word that its first work is done, after which the flight's worker asks for its shaders (status.js, #119) */
export { statusGo } from "./status.js";
/* for a host's own worker: the page answered for there (page.js), and its queue run unpaced (chores.js), as draw-worker.js does */
export { setPage, askedOnce, stoppedAt } from "./page.js";
/* what the GPU is busy with, for the flight world's verdict (busy.js, #104): a host's own contexts watched, a host's own
   worker's ledger heard (busyHeard, busyGone), or heard and told everyone else's (busyPeer) */
export { watch, busyHeard, busyGone, busyPeer } from "./busy.js";
export { pace, askPage } from "./chores.js";
/* the seeded stream and the SVG helper the door's stars use, for a host's own sky */
export { seededRng, el, measureTile } from "./stars.js";
/* the flight's engine and its climb, for a host's own flights (the site: assets/js/journeys.js) */
export { createFlight, UP, PROPS_UP, UPDUR, DOWN, DOWNDUR, homeProps, docsRest } from "./engine.js";
/* the glows' filter graphs, for the tool that draws them into pictures (tools/glows.cjs) */
export { DAWN, DUSK } from "./glows.js";
export { createJourney, descentProfile, DOWN_DAWN, mirrored } from "./journey.js";
export { mountDawn, mountDusk } from "./dawn.js";
export { dawnMarkup, duskMarkup } from "./markup.js";
export { decodeAhead } from "./decode-ahead.js";

/**
 * The door, made once for the page with the host's settings (settings.js says what each is). Called before anything
 * else of the door is asked for. Returns the door: dawn(host) and dusk(host) mount the surfaces on their markup
 * (markup.js), journey(options) makes the flight between them (journey.js); README.md has the whole interface.
 * @param {Partial<import("./settings.js").Settings>} [given]
 */
export function createDoor(given = {}) {
  configure(given);
  if (settings.typingWait > 0) watchTyping();
  /* for the live door's test (?door3d): the chores as they are now */
  if (settings.flags?.door3d) { try { /** @type {Window & { __chores?: typeof choresNow }} */ (window).__chores = choresNow; } catch { /* not a page */ } }
  return { settings, dawn: mountDawn, dusk: mountDusk, journey: createJourney };
}
