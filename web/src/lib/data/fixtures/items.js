/**
 * The items the manifest draws, keyed by the id its rows already carry.
 *
 * The same seam home has in galaxy.fixture.js and the relay has in
 * relay.fixture.js, and it exists for the same reason: no route serves this
 * screen's data yet. `GET /api/workspace` returns the signed-in user's whole
 * workspace and web/src/lib/data/workspace.js is the seam to it, but this
 * front end is not wired to the API, so the screen renders the mockup's own
 * values and is honest about it.
 *
 * Shaped to workspaceItemSchema (src/lib/workspace.ts) rather than to whatever
 * this screen happens to display, so wiring it later swaps the source instead
 * of rewriting the view.
 *
 * Values are read off design/v19/home.html's manifest rows and callouts, so
 * the view shows what the design shows.
 */
export const ITEMS_FIXTURE = {
  "i-gutter": {
    id: "i-gutter", title: "Gutter clearing", section: "Home", status: "active",
    subtype: "service", scheduleKind: "service", provider: null, reference: null,
    costMinor: 15000, costIsEstimate: true, currency: "GBP",
    dueDate: "2026-07-28", recurrenceMonths: 12, reminderDays: [14, 3],
    notes: null, documents: [],
  },
  "i-mot": {
    id: "i-mot", title: "Car MOT — Volvo V60", section: "Vehicles", status: "active",
    subtype: "inspection", scheduleKind: "service", provider: null, reference: null,
    costMinor: 5485, costIsEstimate: false, currency: "GBP",
    dueDate: "2026-08-29", recurrenceMonths: 12, reminderDays: [21, 7],
    notes: null,
    documents: [
      { name: "MOT certificate 2025", meta: "added 12 Jun · 240 KB" },
      { name: "Service history", meta: "added 12 Jun · 88 KB" },
    ],
  },
  "i-boiler": {
    id: "i-boiler", title: "Boiler service", section: "Home", status: "active",
    subtype: "service", scheduleKind: "service", provider: "British Gas", reference: null,
    costMinor: 12000, costIsEstimate: true, currency: "GBP",
    dueDate: "2026-09-04", recurrenceMonths: 12, reminderDays: [14],
    notes: null, documents: [],
  },
  "i-chimney": {
    id: "i-chimney", title: "Chimney sweep", section: "Home", status: "active",
    subtype: "service", scheduleKind: "service", provider: null, reference: null,
    costMinor: 9000, costIsEstimate: true, currency: "GBP",
    dueDate: "2026-11-12", recurrenceMonths: 12, reminderDays: [14],
    notes: null, documents: [],
  },
  "i-smoke": {
    id: "i-smoke", title: "Smoke alarm batteries", section: "Devices", status: "active",
    subtype: "service", scheduleKind: "service", provider: null, reference: null,
    costMinor: 1200, costIsEstimate: true, currency: "GBP",
    dueDate: "2026-12-14", recurrenceMonths: 6, reminderDays: [7],
    notes: null, documents: [],
  },
};
