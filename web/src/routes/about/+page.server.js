import { env } from "$env/dynamic/private";

import { librariesOf } from "$lib/about/group.js";
import { LIBRARIES_FIXTURE } from "$lib/data/fixtures/about.js";

/**
 * The list cannot change within a build, so it is worked out on the first
 * visit and held for the life of the process (#1465). The promise is what is
 * held, so visits that arrive together share the one read. A read that fails
 * is not held (the next visit tries again); "absent" and a good list are.
 * @type {Promise<import("$lib/about/group.js").Library[] | null> | null}
 */
let held = null;

/**
 * @param {typeof fetch} fetch
 * @returns {Promise<import("$lib/about/group.js").Library[] | null>}
 */
async function readLibraries(fetch) {
  const response = await fetch("/about/sbom.spdx.json");
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`bill of materials answered ${response.status}`);
  return librariesOf(await response.json());
}

/**
 * The libraries the About page credits (#1256): the bill of materials
 * scripts/about-sbom.mjs writes into a release image's static files, read
 * here on the server so the page arrives with every row already in it.
 *
 * A build without one -- a development build -- answers 404 for the file,
 * which is "absent", not a failure: the page says this build carries none.
 * Under fixtures the gate's own list stands in, so the photograph has rows.
 *
 * The list itself is read once per build (see `held`).
 */
/** @type {import("./$types").PageServerLoad} */
export async function load({ fetch }) {
  if (env.ORBIT_FIXTURES === "1") return { libraries: LIBRARIES_FIXTURE };
  const reading = (held ??= readLibraries(fetch));
  try {
    return { libraries: await reading };
  } catch {
    if (held === reading) held = null;
    return { libraries: null };
  }
}
