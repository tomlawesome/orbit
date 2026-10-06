/*
 * READYING THE FLIGHT BEFORE IT IS ASKED FOR (#1253).
 *
 * The flight's world (voyage.js) costs a shader compile and a few pictures
 * put on the GPU. That work is queued as chores (chores.js) and never begins
 * until the page says so:
 *
 *   · the door (SignIn.svelte) asks once its card is showing and its first
 *     light has finished drawing in, unhurried, so the work is done in idle
 *     moments and waits while someone types; and hurries it when the sign-in
 *     is submitted. The page then leaves for the landing, so what this buys
 *     is the browser's own caches -- the pictures in its HTTP cache, the
 *     compiled programs in its shader cache -- for the landing's flight. A
 *     browser that compiles on the page's own thread (no
 *     KHR_parallel_shader_compile: Firefox) would freeze the door for the
 *     length of the compile, so there the door fetches the pictures only;
 *   · home asks, hurried, when the sign-out is armed (its first tap), so the
 *     descent has its world by the time the second tap has revoked the
 *     session;
 *   · the flight itself asks, hurried, when a journey starts (Flight.svelte).
 *
 * Under reduced motion there is no flight, so nothing is readied.
 */
import { chore, fetchOnce, hurryChores, openChores } from "./chores.js";
import { compilesAside, fetchVoyage, voyageOnce } from "./voyage.js";

const EARTH = "/flight/door/dawn.webp";

const reduced = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** @type {Promise<void> | null} */
let asked = null;

/**
 * @param {{ hurry?: boolean, gentle?: boolean }} [how]
 *   hurry: the flight is wanted now. gentle: only where the compile cannot
 *   stop the page (the door).
 */
export function readyFlight({ hurry = false, gentle = false } = {}) {
  if (reduced() || typeof document === "undefined") return Promise.resolve();
  if (!asked) {
    fetchVoyage();
    fetchOnce(EARTH).catch(() => {});
    asked = gentle && !compilesAside()
      ? Promise.resolve()
      /* the world made (its shaders set compiling) as a chore of its own, so
         even that waits for the page's say-so */
      : chore(() => {
        /* wrapped, so this chore ends here: the warm-up queues chores of its
           own, and a chore that waited on them would never let them run */
        const world = voyageOnce();
        return { warming: world ? world.warm() : null };
      }, 60, "flight").then(({ warming }) => warming).then(() => {}, () => {});
  }
  if (hurry) hurryChores("flight"); else openChores();
  return asked;
}

/**
 * The sign-in was submitted: the flight is wanted on the next page, so
 * whatever is still queued for it goes first (and starts now, if the door had
 * not got to it yet). Still never a compile that would stop the page.
 */
export function hurryFlight() {
  return readyFlight({ hurry: true, gentle: true });
}
