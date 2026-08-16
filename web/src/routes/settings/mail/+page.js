import { readInbox, readRelay } from "$lib/data/workspace.js";
import { receiptFailuresOf } from "$lib/data/inbox.js";

/** Your relay reads through the seam (#446). The address, listening state,
 *  last arrival and ingest flag are live since #432
 *  (`GET /api/settings/mail-relay`); what ARRIVED comes from the inbox —
 *  including mail that could not become a suggestion, which must be visible
 *  (#434): a suggestion that never appears is indistinguishable from mail that
 *  never arrived, and only one of those is the user's problem to fix.
 *
 *  Unguarded on purpose: this screen's whole subject is the relay, so a relay
 *  that cannot be read is a failure to show, not one to paper over. The
 *  summaries elsewhere (inbox relaybar, helm card) degrade instead. */
export const ssr = false;

export async function load() {
  const [relay, inbox] = await Promise.all([
    readRelay(),
    readInbox().catch(() => ({ receipts: [] })),
  ]);
  return { relay, failures: receiptFailuresOf(inbox.receipts) };
}
