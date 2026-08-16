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
