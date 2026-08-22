/**
 * What the relay screen shows under the fidelity gate.
 *
 * This began as a seam with no server behind it: the per-user address is
 * derived, never stored (`deriveImapRecipientAlias` in
 * src/server/mail-in/core/imap-recipient.ts), and nothing exposed the
 * listening state, the last receipt or the ingest flag to a signed-in user.
 * #432 built that endpoint — `GET /api/settings/mail-relay` — and `readRelay`
 * now fetches it, so the screen is live.
 *
 * What survives here is the GATE's copy: the mockup's own display values
 * (relayFixture, still rendered by the ratified screenshots) and the fixture
 * body the ORBIT_FIXTURES stand-in route answers with (RELAY_FIXTURE). Neither
 * value changed when the endpoint landed, so the gate still measures the port
 * rather than the data.
 */
export const relayFixture = {
  address: "tom-k7f2m@in.lawson-home.orbit",
  status: "connected · listening",
  lastReceived: "policy-schedule.pdf · 2d ago",
  ingest: "enabled",
};

/**
 * The gate's body for `GET /api/settings/mail-relay` (ORBIT_FIXTURES only), in
 * the shape the engine answers: a bounded `listening` word rather than a
 * rendered status, and a bare timestamp rather than a sentence.
 *
 * `lastReceivedLabel` is NOT an API field. The server carries no plain document
 * name on a receipt (#467 asks for one), so the mockup's "policy-schedule.pdf ·
 * 2d ago" can only come from the fixture; live data degrades to the elapsed
 * time alone. Same precedent as `attachments` in inbox.js (#410).
 */
export const RELAY_FIXTURE = {
  relay: {
    address: relayFixture.address,
    listening: relayFixture.status,
    /* 2d before the fixture's pinned noon, so the timestamp and the label agree. */
    lastReceived: "2026-08-11T12:00:00.000Z",
    lastReceivedLabel: relayFixture.lastReceived,
    ingest: relayFixture.ingest,
  },
};
