import { json } from "@sveltejs/kit";

import { describeDevice } from "orbit/lib/auth/device";
import { authErrorResponse } from "orbit/lib/auth/http";
import { listSessions } from "orbit/lib/auth/session";

import { read } from "$lib/server/api.js";

/**
 * "Where you're signed in" (#482): every session the caller holds, reduced
 * to what a reader is allowed to see.
 *
 * Bounded per-session facts only — never the token hash, and never the raw
 * user agent, which `describeDevice` (lib/auth/device.ts) turns into a
 * coarse two-word description before it leaves the server. No IPs either:
 * the sessions table does not record one, and this is not the place to
 * start.
 *
 * Sorted current session first, then by most recently seen: the device the
 * reader is looking at right now is the one they least need to hunt for, and
 * after that the list reads as "most active first".
 */
export const GET = read(async (_event, session) => {
  const rows = await listSessions(session.user.id);
  const list = rows
    .map((row) => ({
      id: row.id,
      current: row.id === session.id,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
      device: describeDevice(row.userAgent),
    }))
    .sort((left, right) => {
      if (left.current !== right.current) return left.current ? -1 : 1;
      const leftSeen = left.lastSeenAt ? Date.parse(left.lastSeenAt) : -Infinity;
      const rightSeen = right.lastSeenAt ? Date.parse(right.lastSeenAt) : -Infinity;
      return rightSeen - leftSeen;
    });
  return json({ sessions: list }, { headers: { "cache-control": "no-store" } });
}, {
  /* Two rows, one of them current: enough for the fidelity gate and a
     fixture-mode dev server to render a real list rather than an empty one. */
  fixture: () => json({
    sessions: [
      { id: "s-fixture-current", current: true, createdAt: "2026-08-01T09:00:00.000Z", lastSeenAt: "2026-08-13T08:45:00.000Z", device: "Chrome · Linux" },
      { id: "s-fixture-phone", current: false, createdAt: "2026-07-20T18:00:00.000Z", lastSeenAt: "2026-08-10T21:12:00.000Z", device: "Safari · iPhone" },
    ],
  }, { headers: { "cache-control": "no-store" } }),
  errorResponse: authErrorResponse,
});
