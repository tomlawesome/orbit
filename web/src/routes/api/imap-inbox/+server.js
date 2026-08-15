import { error, json } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";

/**
 * Fixture stand-in for `GET /api/imap-inbox` (#434) — see api/workspace/
 * +server.js for the env-gating rationale. Empty on purpose: the gate's
 * suggestion row comes from the workspace fixture's own suggestions, so the
 * mail path renders nothing extra and the pixels stay pinned.
 */
export function GET() {
  if (env.ORBIT_FIXTURES !== "1") error(404, "Not found");
  return json({ receipts: [], households: [] }, { headers: { "cache-control": "no-store" } });
}
