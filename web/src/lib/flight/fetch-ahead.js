/*
 * THE FLIGHT'S PICTURES, FETCHED AHEAD OF A PAGE THAT HAS NO JOURNEY (#1371).
 *
 * The flight's world belongs to the page's journey (the shared door's
 * `door.journey()`, made by Flight.svelte): it makes and proves its own world,
 * and Flight.svelte decides when. The sign-in has no journey on it, and the
 * arrival has none until it knows the reader flies there, but the flight that
 * follows them is on the next page. All this does for those pages is ask the
 * browser for the pictures that flight will draw, so it finds them in its HTTP
 * cache, as the chores the folder queues for the page's own GPU work are
 * opened or hurried (README.md in the folder: chores).
 *
 * It asks the page's one GPU verdict (lib/gpu.js) first: refused the GPU,
 * the flight is drawn without its world and none of the world's pictures is
 * fetched. Never under reduced motion (there is no flight) or save-data (the
 * reader has asked for fewer bytes).
 */
import { chore, fetchOnce, hurryChores, openChores, image, flightPictures } from "$lib/door-host.js";
import { gpu } from "$lib/gpu.js";

/** the page's GPU verdict, asked for once (as the first call's chore)
 * @type {Promise<unknown> | null} */
let asked = null;

/**
 * @param {{ hurry?: boolean }} [how]  hurry: the flight is wanted now, so
 *   what is queued for it goes first (and starts now, if the door had not
 *   opened the chores yet)
 */
export function fetchFlightAhead({ hurry = false } = {}) {
  if (typeof document === "undefined") return;
  if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (/** @type {any} */ (navigator).connection?.saveData) return;
  if (!asked) {
    fetchOnce(image("dawn/dawn.webp")).catch(() => {});
    asked = chore(() => gpu(), 60, "flight").then((g) => {
      if (g) for (const url of flightPictures()) fetchOnce(url).catch(() => {});
    }).catch(() => {});
  }
  if (hurry) hurryChores("flight"); else openChores();
}
