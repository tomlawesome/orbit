/**
 * What the settings screen shows until the server can tell it (#464) — the
 * relay.js/#410 precedent. Reminder preferences have no route yet (#468
 * asks); the values are the mockup's own, so the screen renders as designed
 * and the gate measures the port rather than the placeholder.
 */
export const settingsFixture = {
  reminders: {
    emailEnabled: true,
    firstWarning: "14 days before closest approach",
    finalWarning: "3 days before",
    outboundMail: "configured",
  },
};
