/**
 * The open maintenance window `/maintenance` renders under the fixture
 * harness (#526), in the shape `+page.server.js` hands the screen: the
 * window's public timeline and its expected return, nothing else.
 *
 * Three entries, so the default render shows the arrow and the drawer that
 * the one-entry case — the overwhelmingly common one — never shows. The
 * one-entry state is the same window cut to its newest entry, reached with
 * `?entries=one`. The values are design/family/maintenance.html's own, so
 * the fidelity gate measures the port rather than a difference of data.
 *
 * Timestamps are ISO strings, not Dates: this crosses the SvelteKit data
 * boundary as JSON, and the screen formats them in the viewer's own locale.
 */

/**
 * `kind` (#1405): `"window"` is an operator's open window; `"key"` is Orbit
 * holding no usable encryption key, which has no entries, no expected return,
 * and may carry the instance's public contact address.
 *
 * @typedef {{ id: string, kind: "scheduled" | "started" | "update" | "resolved", body: string, publishedAt: string }} MaintenanceEntry
 * @typedef {{ entries: MaintenanceEntry[], expectedEndAt: string | null }} MaintenanceView
 * @typedef {MaintenanceView & { kind: "window" | "key", contactAddress: string | null }} MaintenanceScreen
 */

/** @type {MaintenanceScreen} */
export const MAINTENANCE_FIXTURE = {
  kind: "window",
  contactAddress: null,
  expectedEndAt: "2026-09-04T22:30:00.000Z",
  /* Newest first, as the screen shows them. */
  entries: [
    {
      id: "0d2a2d4e-6c3e-4b3a-9c47-3c2a7f5e1a03",
      kind: "update",
      body: "Verifying the copied documents before we reopen.",
      publishedAt: "2026-09-04T21:48:00.000Z",
    },
    {
      id: "0d2a2d4e-6c3e-4b3a-9c47-3c2a7f5e1a02",
      kind: "update",
      body: "The copy is about halfway. Still on track for the time below.",
      publishedAt: "2026-09-04T21:25:00.000Z",
    },
    {
      id: "0d2a2d4e-6c3e-4b3a-9c47-3c2a7f5e1a01",
      kind: "started",
      body: "We are moving Orbit to new storage. Documents and mail are paused while everything copies across.",
      publishedAt: "2026-09-04T21:00:00.000Z",
    },
  ],
};

/** @type {MaintenanceScreen} */
export const MAINTENANCE_FIXTURE_ONE = {
  kind: "window",
  contactAddress: null,
  expectedEndAt: MAINTENANCE_FIXTURE.expectedEndAt,
  entries: MAINTENANCE_FIXTURE.entries.slice(0, 1),
};

/** The locked screen (#1405, `?kind=key`): nothing to show but the fact. */
/** @type {MaintenanceScreen} */
export const MAINTENANCE_KEY_FIXTURE = {
  kind: "key",
  entries: [],
  expectedEndAt: null,
  contactAddress: null,
};

/** The same with the instance's public contact address (`?kind=key&contact=1`). */
/** @type {MaintenanceScreen} */
export const MAINTENANCE_KEY_FIXTURE_CONTACT = {
  ...MAINTENANCE_KEY_FIXTURE,
  contactAddress: "household-help@example.com",
};
