import { env } from "$env/dynamic/private";
import { readReleaseNotes } from "orbit/server/whats-new";

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
 *
 * The page's release notes (#1713) come with it: the { version, releases }
 * shape GET /api/whats-new answers, for the session's own user, filtered by
 * role the same way. Under fixtures, and for a visitor with no session, the
 * list is empty, as that route answers. Reading them records nothing. A read
 * that fails is logged and answers the empty list, so the page still loads.
 */
/** @type {import("./$types").PageServerLoad} */
export async function load({ locals }) {
  if (env.ORBIT_FIXTURES === "1") return { libraries: LIBRARIES_FIXTURE, releaseNotes: noReleaseNotes() };
  const [libraries, releaseNotes] = await Promise.all([prebuiltLibraries(), releaseNotesFor(locals.session)]);
  return { libraries, releaseNotes };
}

/** @returns {import("orbit/lib/whats-new").WhatsNewAnswer} */
function noReleaseNotes() {
  return { version: null, releases: [] };
}

/**
 * @param {App.Locals["session"]} session
 * @returns {Promise<import("orbit/lib/whats-new").WhatsNewAnswer>}
 */
async function releaseNotesFor(session) {
  if (!session) return noReleaseNotes();
  try {
    return await readReleaseNotes(session.user.id, { runningVersion: process.env.ORBIT_VERSION ?? null });
  } catch {
    /* By code only, as hooks.server logs a failed read: the error's own text can name the database host. */
    const { log } = await import("orbit/lib/logger");
    log.warn({
      event: "application.error",
      state: "degraded",
      reason: "unexpected_failure",
      action: "check_database",
      impact: "application_degraded",
    });
    return noReleaseNotes();
  }
}
