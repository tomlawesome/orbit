/**
 * The server environment variables this front end reads.
 *
 * SvelteKit 3 no longer hands a route every process variable through
 * `$env/dynamic/private`: only the ones declared here exist, and anything
 * else reads as undefined. Each is optional (the schema accepts "unset") and
 * read when the server starts, not baked in at build time. The engine reads
 * its own settings straight from `process.env`; these are only the ones the
 * web routes ask SvelteKit for.
 */
import { defineEnvVars } from "@sveltejs/kit/env";

/** @param {string | undefined} value */
const optional = (value) => value;

export const variables = defineEnvVars({
  /** "1" turns on the fixture harness (no database, no session cookie). */
  ORBIT_FIXTURES: { schema: optional },
  /** Per-read stall limit for an archive upload body, in milliseconds. */
  ORBIT_ARCHIVE_BODY_STALL_MS: { schema: optional },
  /** Whole-body deadline for an archive upload, in milliseconds. */
  ORBIT_ARCHIVE_BODY_DEADLINE_MS: { schema: optional },
  /** The VAPID public key a browser needs before it can subscribe. */
  VAPID_PUBLIC_KEY: { schema: optional },
});
