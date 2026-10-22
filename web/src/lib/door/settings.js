/*
 * The door's settings: what differs between the site and Orbit, given once by the host (index.js: createDoor) and
 * read here by every module in the folder. Nothing in the folder reads the address, the build or the file system
 * for itself: a host that wants a flag or a picture says so here.
 *
 *   image(path)    where a picture is: "dawn/dawn.webp" → a URL the page can load. The site passes a plain relative
 *                  base; a bundler's host builds its own map (never from the module's own address: that leaks into server-
 *                  rendered pages and is unresolvable in a bundle, tested on Orbit's Vite 8 / SvelteKit 2)
 *   flags          the debug switches, as the site reads them from its address: door3d, rich, lean, level (0-2),
 *                  holdreveal, mainthread, ring ("stop" | "rush"), open ("late"), gpu ("force": take the GPU
 *                  gate's context although the renderer is software; fitness.js), fit ("skip": the flight world's speed test is not run
 *                  and the world is taken as fit: for a tool that draws pictures on software GL; it grants no GPU, which
 *                  gpu: "force" does; voyage.js)
 *   storagePrefix  the first word of every localStorage key the folder writes ("orbit": "orbit-probe …")
 *   settle         timeline.js: ms after the landing at which the instrument arrives (the site's own amendment)
 *   typingWait     chores.js: an unhurried chore waits while someone is typing, this long after the last key (0: never)
 */
/**
 * @typedef {Record<string, string | boolean | null | undefined>} Flags the debug switches by name
 * @typedef {object} Settings
 * @property {(path: string) => string} image
 * @property {Flags} flags
 * @property {string} storagePrefix
 * @property {number} settle
 * @property {number} typingWait
 */

/** @type {Settings} */
export const settings = {
  image: (path) => path,
  flags: {},
  storagePrefix: "orbit",
  settle: 1100,
  typingWait: 600,
};

/**
 * the host's settings, given once before anything of the door is asked for
 * @param {Partial<Settings>} [given]
 * @returns {Settings}
 */
export function configure(given = {}) {
  for (const [k, v] of Object.entries(given)) if (v !== undefined) /** @type {Record<string, unknown>} */ (settings)[k] = v;
  return settings;
}

/**
 * a debug flag: false when the host set none
 * @param {string} name
 * @returns {string | boolean}
 */
export const flag = (name) => settings.flags?.[name] ?? false;

/**
 * a picture's URL, as the host resolves it
 * @param {string} path
 */
export const image = (path) => settings.image(path);
