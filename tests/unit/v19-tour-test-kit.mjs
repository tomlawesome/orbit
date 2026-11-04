// The helpers the tour tests used to re-declare file by file (#1360).
// Each chapter keeps its own drawHome: what the film points at differs.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** A path under web/. */
export const web = (path) => resolve(import.meta.dirname, "../../web", path);

/** The named web/ files, read and joined. */
export const read = (files) => files.map((file) => readFileSync(web(file), "utf8")).join("\n");

/** Every name the source assigns to a class or an id, however it writes it:
 *  literal, Svelte expression, `class:` directive or DOM assignment. */
export function namesIn(source) {
  const names = new Set();
  const attributes = /(?:class(?:Name)?|id)\s*[=:]\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/gu;
  for (const match of source.matchAll(attributes)) {
    for (const word of (match[1] ?? match[2] ?? match[3] ?? "").matchAll(/[A-Za-z][\w-]*/gu)) {
      names.add(word[0]);
    }
  }
  for (const match of source.matchAll(/class:([\w-]+)/gu)) names.add(match[1]);
  return names;
}

/** The class and id names one CSS selector depends on. */
export function tokensOf(selector) {
  return [...selector.matchAll(/[.#]([\w-]+)/gu)].map((match) => match[1]);
}

export const settle = () => new Promise((resolve_) => setTimeout(resolve_, 0));

export function setReducedMotion(matches) {
  window.matchMedia = () => ({
    matches,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
}

export function box(el, { x, y, w, h }) {
  el.getBoundingClientRect = () => ({
    left: x, top: y, width: w, height: h,
    right: x + w, bottom: y + h, x, y, toJSON() {},
  });
}

/**
 * Advance the film clock until `promise` settles; return the simulated ms
 * spent. THROWS if the promise rejects, and throws if it has not settled
 * within `cap` ms of simulated time: a hung chapter must fail the test, not
 * fall out of the loop and return as if it had played (#1151, #1360).
 * `sample` runs after every step.
 */
export async function playOut(clock, promise, options = {}) {
  /* The old copies took `step` (or `sample`) third, positionally. */
  if (typeof options !== "object" || options === null) throw new TypeError("playOut: the third argument is { sample, step, cap }");
  const { sample = () => {}, step = 100, cap = 400000 } = options;
  let done = false;
  let failure = null;
  promise.then(() => { done = true; }, (error) => { done = true; failure = error; });
  let spent = 0;
  while (!done && spent < cap) {
    clock.advance(step);
    spent += step;
    await settle();
    sample();
  }
  if (failure) throw failure;
  if (!done) throw new Error(`playOut: chapter did not finish within ${cap}ms of simulated time`);
  return spent;
}
