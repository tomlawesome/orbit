/**
 * The gate's body for `GET /api/system-status` (ORBIT_FIXTURES only, #863).
 *
 * Pinned to `WORKSPACE_FIXTURE.fixtureToday` noon (2026-08-13T12:00:00Z), the
 * same instant every other fixture's `ago()` line is read against, so the
 * drawer's relative timestamps hold still under the gate exactly as the
 * relay and inbox fixtures already do.
 *
 * The scenario: the application itself and the database are both fine, but a
 * maintenance-state read failed (one of the two real causes
 * `getPublicReadiness` degrades for -- readiness.ts's own second branch),
 * which is why `application` reads `degraded` while `orbit-postgres` still
 * reads `healthy`. Scanning is required and ClamAV is unreachable,
 * independently of that. Nothing here duplicates the design mockup's demo
 * values byte for byte -- the mockup's own toolbar cycles three states with
 * no engine behind them -- but this is the same shape a real instance in
 * that condition would answer with.
 */
export const SYSTEM_STATUS_FIXTURE = {
  handle: "degraded",
  services: [
    { service: "orbit-app", state: "healthy", observedAt: "2026-08-13T11:59:20.000Z" },
    { service: "orbit-postgres", state: "healthy", observedAt: "2026-08-13T11:59:20.000Z" },
    { service: "orbit-clamav", state: "unreachable", observedAt: "2026-08-13T11:58:00.000Z" },
    { service: "orbit-tika", state: "not_enabled" },
    { service: "scheduler", state: "healthy", observedAt: "2026-08-13T11:59:48.000Z" },
  ],
  lastCheck: { scan: "failed", application: "degraded" },
};
