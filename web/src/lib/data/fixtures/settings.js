/**
 * What the settings screen shows under the fidelity gate (#464) — the
 * relay.js/#410 precedent.
 *
 * This began as a seam with no server behind it. #468 built the endpoint —
 * `GET/PUT /api/settings/reminders` — and `readReminders` now fetches it, so
 * the helm's Reminders card is live. What survives here is the GATE's copy:
 * the mockup's own display values (settingsFixture, still rendered by the
 * ratified screenshots) and the fixture body the ORBIT_FIXTURES stand-in
 * route answers with (REMINDERS_FIXTURE). Neither value changed when the
 * endpoint landed, so the gate still measures the port rather than the data.
 */
export const settingsFixture = {
  reminders: {
    emailEnabled: true,
    firstWarning: "14 days before closest approach",
    finalWarning: "3 days before",
    outboundMail: "configured",
  },
};

/**
 * The gate's body for `GET /api/settings/reminders` (ORBIT_FIXTURES only), in
 * the shape the engine answers: the two rendered sentences AND the pair of
 * numbers behind them.
 *
 * The numbers are not decoration. `PUT` takes the whole preference —
 * `reminderPreferenceSchema` requires both offsets alongside the flag — so
 * the toggle can only write by handing back the pair it was given. 14/3 are
 * `DEFAULT_FIRST_WARNING_DAYS`/`DEFAULT_FINAL_WARNING_DAYS`, the same numbers
 * the server's own labels are built from, so the sentences and the pair here
 * cannot disagree.
 */
export const REMINDERS_FIXTURE = {
  reminders: {
    emailEnabled: settingsFixture.reminders.emailEnabled,
    firstWarningDays: 14,
    finalWarningDays: 3,
    firstWarning: settingsFixture.reminders.firstWarning,
    finalWarning: settingsFixture.reminders.finalWarning,
    outboundMail: settingsFixture.reminders.outboundMail,
  },
};

/**
 * "Sent to you lately" (#1003, owner-decisions §20) under the gate ONLY.
 *
 * There is no read of `notification_deliveries` for the signed-in user yet:
 * no route answers it and the seam has no reader, so the live screen says it
 * cannot show the list rather than showing an empty one. These rows are the
 * shape #1003's build names (newest first, at most five; the item, which
 * warning, which channel, when, and a failed or retrying send's plain reason)
 * so the phone layout can be drawn and photographed before the read exists.
 * The item ids are the workspace fixture's own, so each row leads somewhere.
 *
 * @typedef {{
 *   id: string, itemId: string, itemName: string,
 *   warning: "first" | "final", daysBefore: number,
 *   channel: "email" | "push", status: "sent" | "retry" | "failed",
 *   reason: ?string, at: string,
 * }} SentRow
 */
/** @type {SentRow[]} */
export const SENT_LATELY_FIXTURE = [
  { id: "nd-1", itemId: "i-smoke", itemName: "Smoke alarm batteries", warning: "final", daysBefore: 3,
    channel: "push", status: "retry", reason: "your phone was offline", at: "2026-08-12T08:00:00.000Z" },
  { id: "nd-2", itemId: "i-mot", itemName: "Car MOT — Volvo V60", warning: "first", daysBefore: 21,
    channel: "email", status: "sent", reason: null, at: "2026-08-08T09:00:00.000Z" },
  { id: "nd-3", itemId: "i-boiler", itemName: "Boiler service", warning: "first", daysBefore: 14,
    channel: "email", status: "failed", reason: "mail isn’t set up on this Orbit", at: "2026-08-05T09:00:00.000Z" },
  { id: "nd-4", itemId: "i-boiler", itemName: "Boiler service", warning: "first", daysBefore: 14,
    channel: "push", status: "sent", reason: null, at: "2026-08-05T09:00:00.000Z" },
  { id: "nd-5", itemId: "i-gutter", itemName: "Gutter clearing", warning: "final", daysBefore: 0,
    channel: "email", status: "sent", reason: null, at: "2026-07-30T07:30:00.000Z" },
];
