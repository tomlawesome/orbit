import { env } from "$env/dynamic/private";

import { librariesOf } from "$lib/about/group.js";
import { LIBRARIES_FIXTURE } from "$lib/data/fixtures/about.js";

/**
 * The libraries the About page credits (#1256): the bill of materials
 * scripts/about-sbom.mjs writes into a release image's static files, read
 * here on the server so the page arrives with every row already in it.
 *
 * A build without one -- a development build -- answers 404 for the file,
 * which is "absent", not a failure: the page says this build carries none.
 * Under fixtures the gate's own list stands in, so the photograph has rows.
 */
/** @type {import("./$types").PageServerLoad} */
export async function load({ fetch }) {
  if (env.ORBIT_FIXTURES === "1") return { libraries: LIBRARIES_FIXTURE };
  try {
    const response = await fetch("/about/sbom.spdx.json");
    if (!response.ok) return { libraries: null };
    return { libraries: librariesOf(await response.json()) };
  } catch {
    return { libraries: null };
  }
}
