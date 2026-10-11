/*
 * ORBIT'S HOST FOR THE SHARED DOOR (#1371, spec item 7).
 *
 * The door -- the Earth, the dawn, the flight and the dusk -- is orbit-site's
 * folder, copied here unchanged by the door import (web/src/lib/door/, its
 * record in door.upstream.json; never edited here). This is the one module
 * that makes it: every Orbit screen that shows a door asks this module for
 * it, so Orbit's settings are said once.
 *
 * THE PICTURES (decided on #1371, note 33890): Orbit ships every picture in
 * the folder except the live door's light strips, which only the door3d flag
 * draws and Orbit never passes. The bundler gives each picture its own
 * hashed address; a picture the map does not hold falls back to an address
 * nothing serves, which the folder never asks for with `flags: {}`.
 *
 * FLAGS: none. The folder's debug switches are read from the site's address;
 * Orbit's door has none.
 */
import { createDoor } from "$lib/door/index.js";

/** @type {Record<string, string>} */
const urls = import.meta.glob(["./door/img/**/*.webp", "!./door/img/dawn/lights-strip-*.webp"], {
  query: "?url", eager: true, import: "default",
});

/** each picture by the folder's own name for it ("dawn/dawn.webp") */
const byPath = Object.fromEntries(Object.entries(urls).map(([file, url]) => [file.slice("./door/img/".length), url]));

/**
 * Where one of the folder's pictures is served.
 * @param {string} path the folder's name for it, e.g. "dawn/dawn.webp"
 * @returns {string}
 */
export const image = (path) => byPath[path] ?? "/door/img/" + path;

/** The door, made once for the page with Orbit's settings (README.md in the folder: the interface). */
export const door = createDoor({ image, flags: {} });

/** The folder's own names for the flight maps, as its voyage asks for them (fetch-ahead.js fetches them ahead). */
export const flightPictures = () =>
  Object.keys(byPath).filter((path) => path.startsWith("flight/") || /^dawn\/[a-z]+-near\.webp$/.test(path)).map(image);

export {
  UP, PROPS_UP, chore, fetchOnce, hurryChores, openChores, compilesAside, dawnMarkup, duskMarkup,
} from "$lib/door/index.js";
