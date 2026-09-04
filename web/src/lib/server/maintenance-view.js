/**
 * What the maintenance screen is allowed to know (#526, ADR-0013 decision 8).
 *
 * `MaintenanceState` is the administrator's view: version, current window id,
 * the scheduled windows, every window's system timestamps. The screen a
 * blocked reader sees gets the open window's public timeline and the expected
 * return, and nothing else — not because the rest is secret, but because the
 * boundary is easier to hold when the shape cannot carry it.
 *
 * Entries come out newest first, which is how the screen shows them; the
 * engine stores them oldest first. Dates become ISO strings here because this
 * crosses SvelteKit's data boundary as JSON, and the screen renders them in
 * the viewer's locale, not the server's.
 *
 * @param {import("orbit/server/maintenance").MaintenanceState} state
 * @returns {import("$lib/data/fixtures/maintenance.js").MaintenanceView}
 */
export function maintenanceView(state) {
  const window = state.openWindow;
  const expectedEndAt = window?.expectedEndAt ?? state.expectedEndAt;
  return {
    expectedEndAt: expectedEndAt ? expectedEndAt.toISOString() : null,
    entries: (window?.updates ?? [])
      .map(({ id, kind, body, publishedAt }) => ({ id, kind, body, publishedAt: publishedAt.toISOString() }))
      .reverse(),
  };
}
