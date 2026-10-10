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
export { chore, fetchOnce, linked, counted, note, noteChores, quiet, openChores, openCompiles, openSoft, softRan, hurryChores, programs, compilesAside, holdReveal } from "./chores.js";
export { uploadBanded } from "./upload.js";
/* what this machine can carry (capability.js), and the level the door ships at */
export { probe, level, liveDoor, lateDoor } from "./capability.js";
/* the seeded stream and the SVG helper the door's stars use, for a host's own sky */
export { seededRng, el, measureTile } from "./stars.js";
/* the flight's engine and its climb, for a host's own flights (the site: assets/js/journeys.js) */
export { createFlight, UP, PROPS_UP, UPDUR } from "./engine.js";
/* the glows' filter graphs, for the tool that draws them into pictures (tools/glows.cjs) */
export { DAWN, DUSK } from "./glows.js";
export { createJourney } from "./journey.js";
export { mountDawn, mountDusk } from "./dawn.js";
export { dawnMarkup, duskMarkup } from "./markup.js";
export { decodeAhead } from "./decode-ahead.js";

/**
 * The door, made once for the page with the host's settings (settings.js says what each is). Called before anything
 * else of the door is asked for. Returns the door: dawn(host) and dusk(host) mount the surfaces on their markup
 * (markup.js), journey(options) makes the flight between them (journey.js); README.md has the whole interface.
 */
export function createDoor(given = {}) {
  configure(given);
  if (settings.typingWait > 0) watchTyping();
  /* for the live door's test (?door3d): the chores as they are now */
  if (settings.flags?.door3d) { try { window.__chores = choresNow; } catch { /* not a page */ } }
  return { settings, dawn: mountDawn, dusk: mountDusk, journey: createJourney };
}
