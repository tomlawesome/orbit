/**
 * What the relay screen shows until the server can tell it.
 *
 * This is the same seam home has in galaxy.fixture.js, and it exists for a
 * blunt reason: no route serves this screen's data. The per-user address is
 * derived, never stored (`deriveImapRecipientAlias` in
 * src/server/mail-in/core/imap-recipient.ts), and nothing exposes the
 * listening state, the last receipt or the ingest flag to a signed-in user.
 * Adding that endpoint is server work, which this rebuild deliberately does
 * not do — so the screen is built, and the endpoint is asked for in #410.
 *
 * The values are the mockup's own, so the screen renders exactly as designed
 * and the fidelity gate measures the port rather than the placeholder. Until
 * they are real, this screen is not linked from anywhere in the product.
 */
export const relayFixture = {
  address: "tom-k7f2m@in.lawson-home.orbit",
  status: "connected · listening",
  lastReceived: "policy-schedule.pdf · 2d ago",
  ingest: "enabled",
};
