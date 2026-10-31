import { env } from "$env/dynamic/private";

import { LIBRARIES_FIXTURE } from "$lib/data/fixtures/about.js";
import { prebuiltLibraries } from "$lib/server/about-libraries.js";

/**
 * The libraries the About page credits (#1256), as a ready list: the image
 * build writes `libraries.json` beside the bill of materials (#1575,
 * scripts/about-sbom.mjs) and it is read once per process, so a visit neither
 * fetches the SBOM nor groups it.
 *
 * A build without one -- a development build -- has no file, which is
 * "absent", not a failure: the page says this build carries none. A read that
 * fails answers the same for that visit and is tried again on the next. Under
 * fixtures the gate's own list stands in, so the photograph has rows.
 */
/** @type {import("./$types").PageServerLoad} */
export async function load() {
  if (env.ORBIT_FIXTURES === "1") return { libraries: LIBRARIES_FIXTURE };
  return { libraries: await prebuiltLibraries() };
}
