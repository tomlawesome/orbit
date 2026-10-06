import { json } from "@sveltejs/kit";

import { getAboutFacts } from "orbit/server/about";

import { ABOUT_FIXTURE } from "$lib/data/fixtures/about.js";
import { read } from "$lib/server/api.js";

/**
 * The About page's first card (#1256): Orbit's version, its image, Node and
 * each sidecar's own version. Any signed-in member, no admin gate -- the
 * credits must reach everyone who uses the shipped product, and this card is
 * what they are credits for. `getAboutFacts` carries the security split:
 * versions and the image reference, never a hostname, URL or error.
 */
export const GET = read(
  async () => json({ about: await getAboutFacts() }, { headers: { "cache-control": "no-store" } }),
  { fixture: () => json({ about: ABOUT_FIXTURE }, { headers: { "cache-control": "no-store" } }) },
);
