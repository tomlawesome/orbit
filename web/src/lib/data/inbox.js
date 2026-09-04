/**
 * Mail-in receipts, shaped for the screens (#434). Pure mappings only — the
 * fetch/approve protocol lives in the seam (workspace.js).
 *
 * A receipt the user can approve IS a suggestion: it joins the manifest's
 * "Suggested from your documents" group and the dial's un-accepted bodies.
 * A receipt that arrived but cannot be reviewed is a visible failure — a
 * suggestion that never appears is indistinguishable from mail that never
 * arrived, and only one of those is the user's problem to fix.
 */

/**
 * @param {import('./workspace.js').Receipt[]} [receipts]
 * @returns {import('./workspace.js').ReceiptSuggestion[]}
 */
export function receiptSuggestionsOf(receipts = []) {
  return receipts
    .filter((receipt) => receipt.canApprove)
    .map((receipt) => ({
      id: receipt.id,
      receiptId: receipt.id,
      draftVersion: receipt.draftVersion,
      householdId: receipt.householdId ?? null,
      title: receipt.proposal?.title ?? "Forwarded email",
      renewsOn: receipt.proposal?.dueDate ?? null,
      provider: receipt.proposal?.provider ?? null,
      expiresAt: receipt.expiresAt ?? null,
      receivedAt: receipt.receivedAt ?? null,
      costMinor: receipt.proposal?.costMinor ?? null,
      currency: receipt.proposal?.currency ?? "GBP",
      sourceDocument:
        (receipt.attachmentCount ?? 0) > 0
          ? `${receipt.attachmentCount} forwarded document${receipt.attachmentCount === 1 ? "" : "s"}`
          : "forwarded email",
      fieldEvidence: receipt.fieldEvidence ?? {},
      classification: receipt.classification,
      message: receipt.message,
    }));
}

/**
 * Arrived but unreviewable: bounded states with the server's own
 * plain-language message. "waiting" is neither a suggestion nor a failure —
 * it is simply not ready yet — so it appears in neither list.
 */
/**
 * @param {import('./workspace.js').Receipt[]} [receipts]
 * @returns {import('./workspace.js').MailFailure[]}
 */
export function receiptFailuresOf(receipts = []) {
  return receipts
    .filter((receipt) => !receipt.canApprove && receipt.classification !== "waiting")
    .map((receipt) => ({
      id: receipt.id,
      receivedAt: /** @type {string} */ (receipt.receivedAt),
      classification: receipt.classification,
      message: /** @type {string} */ (receipt.message),
      canDiscard: Boolean(receipt.canDiscard),
    }));
}

/**
 * Copies one field across if the source actually set it -- a small generic so
 * the field-by-field copy below type-checks per property instead of
 * collapsing every field in the list to one shared (and wrong) type.
 * @template {keyof import('./workspace.js').ItemProposal} K
 * @param {import('./workspace.js').ItemProposal} item
 * @param {import('./workspace.js').ItemProposal} proposal
 * @param {K} field
 */
function copyProposalField(item, proposal, field) {
  const value = proposal[field];
  if (value !== undefined && value !== null) item[field] = value;
}

/**
 * The final values an as-is approval sends: the sanitized proposal, with the
 * schema's own consistency rules honoured client-side too — a schedule needs
 * a date, recurrence needs a schedule.
 * @param {import('./workspace.js').ItemProposal} [proposal]
 * @param {string} [fallbackCurrency]
 * @returns {import('./workspace.js').ItemProposal}
 */
export function approvalItemOf(proposal = {}, fallbackCurrency = "GBP") {
  /** @type {import('./workspace.js').ItemProposal} */
  const item = { title: proposal.title ?? "Forwarded email", currency: proposal.currency ?? fallbackCurrency };
  /** @type {(keyof import('./workspace.js').ItemProposal)[]} */
  const passthroughFields = ["subtype", "provider", "reference", "costMinor", "notes"];
  for (const field of passthroughFields) {
    copyProposalField(item, proposal, field);
  }
  if (proposal.dueDate) {
    item.dueDate = proposal.dueDate;
    if (proposal.scheduleKind) {
      item.scheduleKind = proposal.scheduleKind;
      if (proposal.recurrenceMonths) item.recurrenceMonths = proposal.recurrenceMonths;
    }
  }
  return item;
}
