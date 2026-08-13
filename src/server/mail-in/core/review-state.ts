/**
 * mail-in/core boundary: pure parsing/classification logic only. No
 * `getDb`/`db`/schema imports and no `imapflow` import — see
 * src/server/mail-in/README.md.
 * Extracted from imap-inbox.ts as part of the #298 module split; the
 * original module re-exports these so every existing import path keeps
 * working unchanged.
 */

export type ReviewInboxClassification = "ready" | "waiting" | "retry" | "cleanup" | "unavailable";

export type ReviewInboxStateContext = {
  hasApprovalOperation?: boolean;
  hasApprovedItem?: boolean;
  expiresAt?: Date;
  now?: Date;
};

const attachmentTransferFailureCodes = new Set([
  "attachment_state_changed",
  "attachment_state_invalid",
  "attachment_transfer_failed",
  "attachment_transfer_in_progress",
  "staging_purge_failed",
]);

export function reviewInboxState(status: string, failureCode: string | null | undefined, context: ReviewInboxStateContext = {}): {
  classification: ReviewInboxClassification;
  canApprove: boolean;
  canDiscard: boolean;
  message: string;
} {
  const now = context.now ?? new Date();
  const hasUnexpiredReceipt = Boolean(context.expiresAt && context.expiresAt > now);
  const canRetryAttachmentTransfer = status === "recoverable"
    && Boolean(context.hasApprovalOperation)
    && Boolean(context.hasApprovedItem)
    && hasUnexpiredReceipt
    && attachmentTransferFailureCodes.has(failureCode ?? "");
  if (status === "pending_review") return { classification: "ready", canApprove: true, canDiscard: true, message: "Ready for your review." };
  if (status === "processing" || status === "approving") return { classification: "waiting", canApprove: false, canDiscard: false, message: "Orbit is still preparing this private review." };
  if (canRetryAttachmentTransfer) return { classification: "retry", canApprove: true, canDiscard: true, message: "The item was created; retry to finish attaching the selected documents." };
  if (status === "recoverable") return { classification: "retry", canApprove: false, canDiscard: true, message: "Private cleanup is waiting to finish. You can retry discard." };
  if (status === "failed" && failureCode === "legacy_review_item") return { classification: "cleanup", canApprove: false, canDiscard: true, message: "This older review can only finish private cleanup." };
  return { classification: "unavailable", canApprove: false, canDiscard: false, message: "This incoming document is no longer available for review." };
}

function comparableText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-GB");
  return normalized || undefined;
}

export function findReviewedIntakeCandidateReason(
  proposal: Record<string, unknown>,
  item: { title: string; provider: string | null; reference: string | null; subtype: string | null },
): "matching title" | "matching provider" | "matching reference" | "matching type" | undefined {
  const pairs = [
    ["title", proposal.title, item.title, "matching title"],
    ["provider", proposal.provider, item.provider, "matching provider"],
    ["reference", proposal.reference, item.reference, "matching reference"],
    ["subtype", proposal.subtype, item.subtype, "matching type"],
  ] as const;
  for (const [, left, right, reason] of pairs) {
    const comparableLeft = comparableText(left);
    const comparableRight = comparableText(right);
    if (comparableLeft && comparableRight && comparableLeft === comparableRight) return reason;
  }
  return undefined;
}
