import { json } from "@sveltejs/kit";

import { getPublicReadiness } from "orbit/server/readiness";

/**
 * The unauthenticated liveness probe (#735 port).
 *
 * Read by the Dockerfile HEALTHCHECK, the installer, and every acceptance
 * script, none of which are `web/` code — which is why this route survived a
 * scan of what the front end calls, and why deleting it on that basis would
 * have broken every install.
 *
 * Signed out by design: it reaches no session and no household data, only the
 * readiness of the instance's own dependencies.
 */
export async function GET() {
  const readiness = await getPublicReadiness();
  return json(
    { status: readiness.status, service: "orbit", timestamp: new Date().toISOString() },
    /* 503 only for genuine dependency failure: a maintained instance is
       healthy, must not be restarted, and keeps receiving traffic
       (ADR-0013). */
    {
      status: readiness.status === "degraded" ? 503 : 200,
      headers: { "cache-control": "no-store" },
    },
  );
}
