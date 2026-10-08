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
      /* #1005: which word that date takes on the screens -- a renewal comes
         round, a one-off ends. */
      scheduleKind: receipt.proposal?.scheduleKind ?? null,
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
      /* The papers by name where the list names them (fixtures today, #467
         for live data): the pocket prints the paper's name, not a count
         (review round §6.f, round 3 §2). */
      attachments: receipt.attachments ?? null,
      /* #941: a suggestion Orbit cannot read has to say so where it is
         reviewed, not arrive looking like one nobody filled in. */
      metadataStatus: receipt.metadataStatus ?? null,
      classification: receipt.classification,
      message: receipt.message,
      /* What the review sheet pre-fills, where home raises it in place
         (round 3 §4). */
      proposal: receipt.proposal ?? {},
      attachmentCount: receipt.attachmentCount ?? 0,
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
      metadataStatus: receipt.metadataStatus ?? null,
      reason: /** @type {string} */ (receipt.reason),
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
 * The final values an as-is approval sends: the sanitized proposal as the
 * relay read it, unjudged. Whether a schedule stands without a date, or a
 * repeat without a schedule, is the engine's to decide (ADR-0034, #1325):
 * it keeps the relay's reading only where it holds.
 * @param {import('./workspace.js').ItemProposal} [proposal]
 * @param {string} [fallbackCurrency]
 * @returns {import('./workspace.js').ItemProposal}
 */
export function approvalItemOf(proposal = {}, fallbackCurrency = "GBP") {
  /** @type {import('./workspace.js').ItemProposal} */
  const item = { title: proposal.title ?? "Forwarded email", currency: proposal.currency ?? fallbackCurrency };
  /** @type {(keyof import('./workspace.js').ItemProposal)[]} */
  const passthroughFields = [
    "subtype", "provider", "reference", "costMinor", "notes", "dueDate", "scheduleKind", "recurrenceMonths",
  ];
  for (const field of passthroughFields) {
    copyProposalField(item, proposal, field);
  }
  return item;
}
