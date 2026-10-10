/*
 * THE OTHER HOUSEHOLDS IN THE FLIGHT (#1253 ruling 3; #1371 spec item 9).
 *
 * The reader's real other households pass on the climb, each with its items
 * as bodies where its dial has them, and are met again on the way down. A
 * reader with one household passes nothing. This is Orbit's layer on the
 * shared door's flight: which households, read from Orbit's own galaxy
 * (othersOf), and their tones read as colours when the flight starts
 * (paintedHomes). How they fly is the folder's (homeProps).
 */

/** @typedef {{ name: string, bodies: Array<[number, number, string, number]> }} PassingHome */

/**
 * The other households as the galaxy holds them (chart.js galaxyOf): each
 * planet at its own bearing, at the radius the dial would put it. Tones are
 * left as the galaxy names them; paintedHomes resolves them to colours.
 * @param {Record<string, { name: string, planets: Array<[number, number, number, string]> }> | null | undefined} galaxy
 * @param {string | null | undefined} primary
 * @returns {PassingHome[]}
 */
export function othersOf(galaxy, primary) {
  return Object.entries(galaxy ?? {}).filter(([id]) => id !== primary).map(([, h]) => ({
    name: h.name,
    bodies: (h.planets ?? []).map(([dx, dy, , tone]) => {
      const a = Math.atan2(dy, dx), r = 22 + ((Math.hypot(dx, dy) - 18) / 12) * 58;
      return /** @type {[number, number, string, number]} */ ([Math.cos(a) * r, Math.sin(a) * r, tone, 3.2]);
    }),
  }));
}

/**
 * The other households with their tones read as colours, now: a tone may be a
 * CSS custom property name, read off the body.
 * @param {PassingHome[]} homes
 * @returns {PassingHome[]}
 */
export function paintedHomes(homes) {
  const style = getComputedStyle(document.body);
  /** @param {string} tone */
  const colour = (tone) => (tone.startsWith("--") ? style.getPropertyValue(tone).trim() : tone) || "#8fb8ff";
  return homes.map((h) => ({ name: h.name, bodies: h.bodies.map((b) => /** @type {[number, number, string, number]} */ ([b[0], b[1], colour(b[2]), b[3]])) }));
}

/*
 * #1371: waits for ai/orbit-site#24 -- the folder exports homeProps (its
 * demoFlight's own), and this copy then goes: `import { homeProps } from
 * "$lib/door/index.js"`. Until then, Orbit's own, as it flew before the
 * import (the folder's engine draws a "home" prop as it always did).
 */
/**
 * @param {PassingHome[]} homes
 */
export function homeProps(homes) {
  const BEAR = [44, 136, 74, 106, 58, 122], ZED = [0.5, 0.42, 0.62, 0.46, 0.56, 0.4];
  return homes.map((h, i) => ({ kind: "home", name: h.name, bodies: h.bodies, t0: 760 + i * 380, dur: 2000 + (i % 3) * 350, ang: BEAR[i % BEAR.length], z: ZED[i % ZED.length], spin: 0 }));
}
