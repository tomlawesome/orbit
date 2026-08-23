import { error, json } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import { INBOX_FIXTURE } from "$lib/data/fixtures/inbox.js";

/**
 * Fixture stand-in for `GET /api/imap-inbox` (#434/#463) — see api/workspace/
 * +server.js for the env-gating rationale. Carries the #452 mockups' own
 * mail: home's suggestion row, its dial ring and the whole inbox screen all
 * derive from these receipts, so the two screens share one truth (#454).
 */
export function GET() {
  if (env.ORBIT_FIXTURES !== "1") error(404, "Not found");
  return json(INBOX_FIXTURE, { headers: { "cache-control": "no-store" } });
}
