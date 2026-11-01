import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @typedef {import("$lib/about/group.js").Library} Library
 */

/**
 * The finished library list scripts/about-sbom.mjs writes beside the SBOM at
 * image build time (#1575): the list, or null when there is no such file (a
 * development build carries none). Any other read or parse failure throws, so
 * the caller can tell "absent" from "broken".
 *
 * @param {string} path
 * @returns {Promise<Library[] | null>}
 */
export async function readLibrariesFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Where the built client's files are: the `client/` directory beside
 * adapter-node's handler.js, which is where the adapter's own static-file
 * handler serves them from. This module is bundled into a chunk at a depth
 * that depends on the chunking, so walk up from it to the directory that holds
 * both. Outside a build (dev, unit tests) there is none, and the list is
 * absent.
 *
 * @returns {string | null}
 */
function builtClientDirectory() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "handler.js")) && existsSync(join(dir, "client"))) return join(dir, "client");
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The list cannot change within a build, so it is read on the first visit and
 * held for the life of the process. The promise is what is held, so visits
 * that arrive together share the one read. "Absent" (null) and a good list are
 * held; a read that fails is not, so the next visit tries again.
 * @type {Promise<Library[] | null> | null}
 */
let held = null;

/**
 * The libraries the About page credits (#1256), read from the built client's
 * `about/libraries.json`. Resolves null when the build carries none and for a
 * visit whose read failed (nothing is held for it).
 *
 * @returns {Promise<Library[] | null>}
 */
export function prebuiltLibraries() {
  const reading = (held ??= (async () => {
    const client = builtClientDirectory();
    return client === null ? null : readLibrariesFile(join(client, "about", "libraries.json"));
  })());
  return reading.catch(() => {
    if (held === reading) held = null;
    return null;
  });
}
