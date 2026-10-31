/**
 * WHAT THE INBOX DOES WITH A RECEIPT, WRITTEN ONCE (#1352; #1328 WI-22,
 * web-13). The desk's two-tap `tap` (+page.svelte) and the phone's
 * `approve` and `dismiss` (pocket.svelte) each wrote this for themselves.
 *
 * Approve goes through approveWithOperation (workspace.js, #1343): one
 * operation id per receipt across retries, and an approval that filed the
 * item but not its documents answers `partial` with the words to show, the
 * receipt staying in review for the plain retry. Dismiss discards the
 * receipt. Either way the inbox is read again once it has landed.
 *
 * What differs is the screen's: how it arms (the desk's arm.js, the phone's
 * ArmButton), where it shows the busy receipt and the problem (`busy`,
 * `say`), and what it does as the receipt leaves (`landed`: the phone's
 * card sinks or burns and the wake says so).
 *
 * @typedef {Awaited<ReturnType<typeof import('$lib/data/workspace.js').readInboxScreen>>} InboxView
 * @typedef {"approve" | "dismiss"} ReceiptAct
 */
import { approveWithOperation, dismissReceipt, wordsOf } from "$lib/data/workspace.js";

/**
 * @param {{
 *   view: () => InboxView,
 *   operationIds: Map<string, string>,
 *   reload: () => Promise<unknown>,
 *   say: (id: string, words: string | null) => unknown,
 *   busy: (id: string | null, act: ReceiptAct | null) => unknown,
 *   landed?: (receipt: { id: string }, act: ReceiptAct, amended: import('$lib/data/workspace.js').ItemProposal | null) => unknown,
 * }} options
 */
export function createReceiptActs({ view, operationIds, reload, say, busy, landed = () => {} }) {
  /**
   * Approves (as the relay read it, or as amended into a section) or
   * dismisses a receipt in review.
   * @param {{ id: string }} receipt
   * @param {ReceiptAct} act
   * @param {{ amended?: import('$lib/data/workspace.js').ItemProposal | null, sectionId?: string | null }} [options]
   * @returns {Promise<boolean>} whether it left review
   */
  async function decide(receipt, act, { amended = null, sectionId = null } = {}) {
    say(receipt.id, null);
    busy(receipt.id, act);
    try {
      if (act === "approve") {
        /* The review lane's receipts are exactly receiptSuggestionsOf's
           input, so one armed to approve is always found. */
        const suggestion = /** @type {import('$lib/data/workspace.js').ReceiptSuggestion} */ (
          view().suggestions.find((one) => one.receiptId === receipt.id));
        const result = await approveWithOperation(suggestion, operationIds, view().primary, amended, sectionId);
        if ("partial" in result) {
          /* The item exists but its documents didn't make it: the SAME
             operation id retries the SAME body, never a second item. */
          say(receipt.id, result.message);
          return false;
        }
      } else {
        await dismissReceipt(receipt.id);
      }
      landed(receipt, act, amended);
      await reload();
      return true;
    } catch (error) {
      say(receipt.id, wordsOf(error));
      return false;
    } finally {
      busy(null, null);
    }
  }

  return { decide };
}
