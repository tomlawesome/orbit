/**
 * The sample workspace, in the exact shape `GET /api/workspace` answers
 * (src/lib/workspace.ts householdWorkspaceSchema) — plus the session and
 * per-item documents payloads their routes answer.
 *
 * This replaces the old per-screen view fixtures (#451): the fidelity gate's
 * fixture routes serve THESE as JSON and the very same transform code
 * (chart.js, the seam) renders them, so the gate proves the live path, not a
 * parallel one.
 *
 * Household ids are invented but not arbitrary: a household's sky bearing is
 * a pure function of its id (chart.js, CON-13), and these ids were chosen so
 * the sample sky matches the ratified design's scatter. Real households get
 * uniformly scattered bearings the same way — theirs simply aren't curated.
 *
 * Dates are relative to DESIGN_TODAY (2026-08-13), the date every mockup was
 * drawn against.
 */

export const SESSION_FIXTURE = {
  authenticated: true,
  csrfToken: "fixture-csrf-token",
  user: { id: "u-fixture", displayName: "Tom Lawson" },
};

const LAWSON_SECTIONS = [
  { id: "s-home", name: "Home" },
  { id: "s-vehicles", name: "Vehicles" },
  { id: "s-devices", name: "Devices" },
];

/** The primary household's items — the manifest and dial of the design. */
const LAWSON_ITEMS = [
  {
    id: "i-gutter", title: "Gutter clearing", sectionId: "s-home", status: "active",
    subtype: "service", scheduleKind: "service", provider: null, reference: null,
    costMinor: 15000, currency: "GBP", dueDate: "2026-07-28",
    recurrenceMonths: 12, reminderDays: [14, 3], notes: null,
    snoozedUntil: null, version: 3, updatedAt: "2026-07-01T09:00:00.000Z",
  },
  {
    id: "i-mot", title: "Car MOT — Volvo V60", sectionId: "s-vehicles", status: "active",
    subtype: "inspection", scheduleKind: "service", provider: null, reference: null,
    costMinor: 5485, currency: "GBP", dueDate: "2026-08-29", documentCount: 2,
    recurrenceMonths: 12, reminderDays: [21, 7], notes: null,
    snoozedUntil: null, version: 5, updatedAt: "2026-06-12T10:30:00.000Z",
  },
  {
    id: "i-boiler", title: "Boiler service", sectionId: "s-home", status: "active",
    subtype: "service", scheduleKind: "service", provider: "British Gas", reference: null,
    costMinor: 12000, currency: "GBP", dueDate: "2026-09-04",
    recurrenceMonths: 12, reminderDays: [14], notes: null,
    snoozedUntil: null, version: 2, updatedAt: "2026-05-20T16:00:00.000Z",
  },
  {
    id: "i-chimney", title: "Chimney sweep", sectionId: "s-home", status: "active",
    subtype: "service", scheduleKind: "service", provider: null, reference: null,
    costMinor: 9000, currency: "GBP", dueDate: "2026-10-13",
    recurrenceMonths: 12, reminderDays: [14], notes: null,
    snoozedUntil: null, version: 1, updatedAt: "2026-04-02T11:00:00.000Z",
  },
  {
    id: "i-smoke", title: "Smoke alarm batteries", sectionId: "s-devices", status: "active",
    subtype: "service", scheduleKind: "service", provider: null, reference: null,
    costMinor: 1200, currency: "GBP", dueDate: "2026-12-13",
    recurrenceMonths: 6, reminderDays: [7], notes: null,
    snoozedUntil: null, version: 4, updatedAt: "2026-06-13T08:00:00.000Z",
  },
  {
    id: "i-svc", title: "Car full service", sectionId: "s-vehicles", status: "active",
    subtype: "service", scheduleKind: "service", provider: null, reference: null,
    costMinor: 30000, currency: "GBP", dueDate: "2027-01-21", documentCount: 2,
    recurrenceMonths: 12, reminderDays: [21], notes: null,
    snoozedUntil: null, version: 2, updatedAt: "2026-06-12T10:35:00.000Z",
  },
];

/** Distant constellations, named: the id scheme and the due dates are
 * load-bearing (home's constellation dots hash the ids and band the dates),
 * so #461 gave these items their words without moving either. */
function distantItems(prefix, specs) {
  return specs.map(([title, sectionId, dueDate, costMinor, extra], index) => ({
    id: `${prefix}-${index}`, title, sectionId,
    status: "active", subtype: "service", scheduleKind: "service",
    provider: null, reference: null, costMinor, currency: "GBP",
    costIsEstimate: true,
    dueDate, recurrenceMonths: 12, reminderDays: [14], notes: null,
    snoozedUntil: null, version: 1, updatedAt: "2026-06-01T00:00:00.000Z",
    ...(extra ?? {}),
  }));
}

export const WORKSPACE_FIXTURE = {
  /* Not an API field: pins chart arithmetic to the mockups' own date so the
     fidelity gate is deterministic. The seam ignores it on live data. */
  fixtureToday: "2026-08-13",
  /* Not an API field either: no route serves document suggestions yet (#454
     will) — the design's "Suggested from your documents" group renders from
     this until it exists, and renders empty on live data. */
  suggestions: [
    {
      id: "sug-insurance", title: "Home insurance renewal",
      sourceDocument: "policy-schedule.pdf", renewsOn: "2026-10-03",
      costMinor: 40000, currency: "GBP",
    },
  ],
  activeHouseholdId: "hh-lawson-1",
  householdLanding: "active",
  households: [
    {
      id: "hh-lawson-1", name: "Lawson Home", timezone: "Europe/London",
      currency: "GBP", memberCount: 2, canManage: true, onboardingComplete: true,
      sections: LAWSON_SECTIONS, items: LAWSON_ITEMS, activities: [],
    },
    {
      id: "hh-seaside-4551", name: "Seaside Cottage", timezone: "Europe/London",
      currency: "GBP", memberCount: 3, canManage: false, onboardingComplete: true,
      sections: [{ id: "s-home", name: "Home" }, { id: "s-outside", name: "Outside" }],
      items: distantItems("i-seaside", [
        ["Septic tank empty", "s-outside", "2026-08-20", 21000],
        ["Chimney sweep — Seaside", "s-home", "2027-03-01", 9000],
        ["Deck re-oiling", "s-outside", "2027-06-15", 13000],
      ]),
      activities: [],
    },
    {
      id: "hh-mumdad-2480", name: "Mum & Dad’s", timezone: "Europe/London",
      currency: "GBP", memberCount: 2, canManage: false, onboardingComplete: true,
      sections: [{ id: "s-home", name: "Home" }, { id: "s-devices", name: "Devices" }],
      items: distantItems("i-mumdad", [
        ["Stairlift service", "s-devices", "2027-01-10", 14000],
        ["Boiler service — Mum & Dad’s", "s-home", "2027-04-20", 11000],
      ]),
      activities: [],
    },
    {
      id: "hh-narrow-15033", name: "The Narrowboat", timezone: "Europe/London",
      currency: "GBP", memberCount: 1, canManage: false, onboardingComplete: true,
      sections: [{ id: "s-boat", name: "Boat" }, { id: "s-cert", name: "Certification" }],
      items: distantItems("i-narrow", [
        ["Hull blacking", "s-boat", "2026-12-11", 55000],
        ["Boat Safety Scheme examination", "s-cert", "2026-09-27", 18000,
          { subtype: "inspection", scheduleKind: "inspection", costIsEstimate: false }],
      ]),
      activities: [],
    },
    {
      id: "hh-grans-1307", name: "Gran’s Flat", timezone: "Europe/London",
      currency: "GBP", memberCount: 2, canManage: false, onboardingComplete: true,
      sections: [{ id: "s-home", name: "Home" }],
      items: distantItems("i-grans", [
        ["Boiler service — Gran’s", "s-home", "2026-08-23", 9500],
        ["Gas safety certificate", "s-home", "2027-05-30", 8500],
      ]),
      activities: [],
    },
  ],
};

/**
 * Per-item documents, in the DocumentSummary shape
 * `GET /api/households/{householdId}/items/{itemId}/documents` answers
 * (src/server/document-repository.ts). Sizes and dates are chosen so the
 * client-side meta formatting reproduces the design's strings exactly
 * ("added 12 Jun · 240 KB").
 */
export const DOCUMENTS_FIXTURE = {
  "i-mot": [
    {
      id: "d-mot-cert", itemId: "i-mot", displayName: "MOT certificate 2025",
      mediaType: "application/pdf", sizeBytes: 245760, lifecycle: "stored",
      scanStatus: "clean", availableAt: "2026-06-12T10:30:00.000Z",
      deleteAfter: null, ready: true, failureCode: null, recoverable: false,
      recoveryExpiresAt: null, recoveryStatus: null,
    },
    {
      id: "d-mot-history", itemId: "i-mot", displayName: "Service history",
      mediaType: "application/pdf", sizeBytes: 90112, lifecycle: "stored",
      scanStatus: "clean", availableAt: "2026-06-12T10:31:00.000Z",
      deleteAfter: null, ready: true, failureCode: null, recoverable: false,
      recoveryExpiresAt: null, recoveryStatus: null,
    },
  ],
  "i-svc": [
    {
      id: "d-svc-invoice", itemId: "i-svc", displayName: "service-invoice-2026.pdf",
      mediaType: "application/pdf", sizeBytes: 245760, lifecycle: "stored",
      scanStatus: "clean", availableAt: "2026-06-12T10:35:00.000Z",
      deleteAfter: null, ready: true, failureCode: null, recoverable: false,
      recoveryExpiresAt: null, recoveryStatus: null,
    },
    {
      id: "d-svc-checklist", itemId: "i-svc", displayName: "service-checklist.pdf",
      mediaType: "application/pdf", sizeBytes: 90112, lifecycle: "stored",
      scanStatus: "clean", availableAt: "2026-06-12T10:36:00.000Z",
      deleteAfter: null, ready: true, failureCode: null, recoverable: false,
      recoveryExpiresAt: null, recoveryStatus: null,
    },
  ],
};
