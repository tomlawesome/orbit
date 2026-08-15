import { readInbox, readRelay } from "$lib/data/workspace.js";
import { receiptFailuresOf } from "$lib/data/inbox.js";

/** Your relay reads through the seam (#446); the address/status values await
 *  the #432 endpoint, but what ARRIVED is already knowable — including mail
 *  that could not become a suggestion, which must be visible (#434): a
 *  suggestion that never appears is indistinguishable from mail that never
 *  arrived, and only one of those is the user's problem to fix. */
export const ssr = false;

export async function load() {
  const [relay, inbox] = await Promise.all([
    readRelay(),
    readInbox().catch(() => ({ receipts: [] })),
  ]);
  return { relay, failures: receiptFailuresOf(inbox.receipts) };
}
