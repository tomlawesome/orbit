/**
 * The review inbox's fixture receipts (#463, ORBIT_FIXTURES only) — the same
 * mail the #452 mockups drew, in the shape `GET /api/imap-inbox` answers.
 *
 * One truth, two screens (#454 closed by this): home's "Suggested from your
 * documents" group and its dial ring derive from the approvable receipt here,
 * not from a parallel synthetic suggestion — so the sky and the inbox can
 * never disagree about what the relay caught.
 *
 * `attachments` is NOT an API field yet: the real list names no files (only
 * the detail's ordinals/sizes), which #467 asks the server to change. Until
 * then the design renders as ratified from this, and live data degrades to
 * the count-based wording — the relay.js precedent (#410).
 *
 * Times are pinned against the fixture's noon (2026-08-13T12:00:00Z): caught
 * 11 Aug = 2d ago, burns up 25 Sep = in 43d, the waiting arrival = 4m ago.
 */
export const INBOX_FIXTURE = {
  receipts: [
    {
      id: "r-insurance",
      status: "pending_review",
      householdId: null,
      draftVersion: 1,
      receivedAt: "2026-08-11T09:24:00.000Z",
      expiresAt: "2026-09-25T12:00:00.000Z",
      attachmentCount: 1,
      classification: "ready",
      canApprove: true,
      canDiscard: true,
      cleanupOnly: false,
      message: "Ready for your review.",
      proposal: {
        title: "Home insurance renewal",
        provider: "Harbour Mutual",
        costMinor: 40000,
        currency: "GBP",
        dueDate: "2026-10-03",
        scheduleKind: "renewal",
        recurrenceMonths: 12,
      },
      fieldEvidence: {
        title: { source: "parser", confidence: "high" },
        provider: { source: "parser", confidence: "high" },
        dueDate: { source: "parser", confidence: "high" },
        costMinor: { source: "parser", confidence: "low" },
      },
      attachments: [{ displayName: "policy-schedule.pdf", sizeBytes: 831488, scannedClean: true }],
    },
    {
      id: "r-reading",
      status: "processing",
      householdId: null,
      draftVersion: 1,
      receivedAt: "2026-08-13T11:56:00.000Z",
      expiresAt: "2026-09-27T12:00:00.000Z",
      attachmentCount: 1,
      classification: "waiting",
      canApprove: false,
      canDiscard: false,
      cleanupOnly: false,
      message: "Orbit is reading its document — it will appear for review when it’s done",
      proposal: {},
      fieldEvidence: {},
    },
    {
      id: "r-scan-only",
      status: "failed",
      householdId: null,
      draftVersion: 1,
      receivedAt: "2026-08-09T16:02:00.000Z",
      expiresAt: "2026-09-23T12:00:00.000Z",
      attachmentCount: 1,
      classification: "cleanup",
      canApprove: false,
      canDiscard: true,
      cleanupOnly: true,
      message:
        "Its attachment is a picture-only scan, and Orbit couldn’t read any text from it. You can add the item yourself and attach the file from Documents.",
      proposal: {},
      fieldEvidence: {},
    },
    {
      id: "r-no-document",
      status: "failed",
      householdId: null,
      draftVersion: 1,
      receivedAt: "2026-08-06T08:41:00.000Z",
      expiresAt: "2026-09-20T12:00:00.000Z",
      attachmentCount: 0,
      classification: "cleanup",
      canApprove: false,
      canDiscard: true,
      cleanupOnly: true,
      message: "It carried no document Orbit can read (PDFs work best). Nothing was kept.",
      proposal: {},
      fieldEvidence: {},
    },
  ],
  households: [],
  /**
   * The Filed lane (§14, #472): every item the relay has ever fed into the
   * orbit. `filed` is NOT an API field yet — the server only lists receipts
   * still in flight and forgets the mail→item link once a receipt burns up,
   * which #467 asks it to change (provenance: source filename + filed date).
   * Until then the design renders from this record of the mail event; the
   * source document may since have been renamed or removed from the item —
   * the filed row remembers the mail, the item carries today's documents.
   * `itemId` points at real workspace-fixture items so a tap opens them.
   */
  filed: [
    { itemId: "i-mot", title: "Car MOT — Volvo V60", sourceDocument: "mot-reminder.pdf", filedAt: "2025-08-30" },
    { itemId: "i-svc", title: "Car full service", sourceDocument: "service-invoice-2026.pdf", filedAt: "2026-06-12" },
  ],
};
