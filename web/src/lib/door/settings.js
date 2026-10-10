/*
 * The door's settings: what differs between the site and Orbit, given once by the host (index.js: createDoor) and
 * read here by every module in the folder. Nothing in the folder reads the address, the build or the file system
 * for itself: a host that wants a flag or a picture says so here.
 *
 *   image(path)    where a picture is: "dawn/dawn.webp" → a URL the page can load. The site passes a plain relative
 *                  base; a bundler's host builds its own map (never from the module's own address: that leaks into server-
 *                  rendered pages and is unresolvable in a bundle, tested on Orbit's Vite 8 / SvelteKit 2)
 *   flags          the debug switches, as the site reads them from its address: door3d, rich, lean, level (0-2),
 *                  holdreveal, mainthread, ring ("stop" | "rush"), open ("late")
 *   storagePrefix  the first word of every localStorage key the folder writes ("orbit": "orbit-probe …")
 *   settle         timeline.js: ms after the landing at which the instrument arrives (the site's own amendment)
 *   typingWait     chores.js: an unhurried chore waits while someone is typing, this long after the last key (0: never)
 */
export const settings = {
  image: (path) => path,
  flags: {},
  storagePrefix: "orbit",
  settle: 1100,
  typingWait: 600,
};

/** the host's settings, given once before anything of the door is asked for */
export function configure(given = {}) {
  for (const [k, v] of Object.entries(given)) if (v !== undefined) settings[k] = v;
  return settings;
}

/** a debug flag: false when the host set none */
export const flag = (name) => settings.flags?.[name] ?? false;

/** a picture's URL, as the host resolves it */
export const image = (path) => settings.image(path);
