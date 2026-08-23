import { error, json } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";

import { DOCUMENTS_FIXTURE } from "$lib/data/fixtures/workspace.js";

/** Fixture stand-in for the per-item documents route — see api/workspace/+server.js. */
export function GET({ params }) {
  if (env.ORBIT_FIXTURES !== "1") error(404, "Not found");
  return json(
    { documents: DOCUMENTS_FIXTURE[params.itemId] ?? [] },
    { headers: { "cache-control": "no-store" } },
  );
}
