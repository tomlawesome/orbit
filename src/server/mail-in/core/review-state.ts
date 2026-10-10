/**
 * mail-in/core boundary: pure parsing/classification logic only. No
 * `getDb`/`db`/schema imports and no `imapflow` import — see
 * src/server/mail-in/README.md.
 * Extracted from imap-inbox.ts as part of the #298 module split; the
 * original module re-exports these so every existing import path keeps
 * working unchanged.
 */
import { normalizeImapAttachmentName } from "./imap-attachment-validation";
import { normalizeComparableMetadata } from "@/server/metadata/crypto";
import type { SupportedDocumentMediaType } from "@/server/documents/validation";

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

/**
 * The nine reasons a member can be given for a failed mail-in receipt,
 * folded from the ~25 stored `failure_code` values (#1143). The member
 * needs "what kind of thing went wrong", not the worker's step; the raw
 * `failure_code` stays on the row for support.
 */
export type FailureReason =
  | "no_document"
  | "too_large"
  | "malware"
  | "scanner_off"
  | "not_kept"
  | "wrong_recipient"
  | "account_disabled"
  | "older_review"
  | "unknown";

const failureReasonByCode: Record<string, FailureReason> = {
  no_supported_pdf: "no_document",
  document_type_unsupported: "no_document",
  mime_type_mismatch: "no_document",
  mime_structure_invalid: "no_document",
  mime_part_count_exceeded: "no_document",
  mime_nesting_too_deep: "no_document",
  message_too_large: "too_large",
  document_too_large: "too_large",
  attachment_total_too_large: "too_large",
  attachment_count_exceeded: "too_large",
  malware_detected: "malware",
  scanner_disabled: "scanner_off",
  scanner_unavailable: "scanner_off",
  // The other outcomes of a scan that did not pass (documents/scan-outcome.ts)
  // read to a member the same way: the scanner is not working, try later.
  scanner_timeout: "scanner_off",
  scanner_protocol: "scanner_off",
  scanner_failed: "scanner_off",
  attachment_download_failed: "not_kept",
  staging_lease_lost: "not_kept",
  attachment_processing_failed: "not_kept",
  attachment_processing_exhausted: "not_kept",
  staging_purge_failed: "not_kept",
  discard_purge_failed: "not_kept",
  staging_purge_pending: "not_kept",
  staging_expiry_pending: "not_kept",
  recipient_mismatch: "wrong_recipient",
  account_disabled: "account_disabled",
  legacy_review_item: "older_review",
};

/**
 * Derives the short, fixed reason a member sees for a failed mail-in
 * receipt from the stored `failure_code`. Pure and derived on read: a
 * second stored column would drift from the first, and old rows with no
 * code (or a code not in the table) read as `unknown` for free (#1143).
 */
export function failureReasonOf(failureCode: string | null | undefined): FailureReason {
  if (!failureCode) return "unknown";
  return failureReasonByCode[failureCode] ?? "unknown";
}

export function reviewInboxState(status: string, failureCode: string | null | undefined, context: ReviewInboxStateContext = {}): {
  classification: ReviewInboxClassification;
  canApprove: boolean;
  canDiscard: boolean;
  message: string;
  reason: FailureReason;
} {
  const now = context.now ?? new Date();
  const hasUnexpiredReceipt = Boolean(context.expiresAt && context.expiresAt > now);
  const canRetryAttachmentTransfer = status === "recoverable"
    && Boolean(context.hasApprovalOperation)
    && Boolean(context.hasApprovedItem)
    && hasUnexpiredReceipt
    && attachmentTransferFailureCodes.has(failureCode ?? "");
  const reason = failureReasonOf(failureCode);
  if (status === "pending_review") return { classification: "ready", canApprove: true, canDiscard: true, message: "Ready for your review.", reason };
  if (status === "processing" || status === "approving") return { classification: "waiting", canApprove: false, canDiscard: false, message: "Orbit is still preparing this private review.", reason };
  /* ADR-0017 slice 5 (#746): the reader paused their own collection, so this
     arrived and was deliberately left alone. Saying so is the point — a held
     message that looked "unavailable" would read as something going wrong. */
  if (status === "held") return { classification: "waiting", canApprove: false, canDiscard: false, message: "Collection is paused. This will be prepared when you turn it back on.", reason };
  if (canRetryAttachmentTransfer) return { classification: "retry", canApprove: true, canDiscard: true, message: "The item was created; retry to finish attaching the selected documents.", reason };
  if (status === "recoverable") return { classification: "retry", canApprove: false, canDiscard: true, message: "Private cleanup is waiting to finish. You can retry discard.", reason };
  if (status === "failed" && failureCode === "legacy_review_item") return { classification: "cleanup", canApprove: false, canDiscard: true, message: "This older review can only finish private cleanup.", reason };
  return { classification: "unavailable", canApprove: false, canDiscard: false, message: "This incoming document is no longer available for review.", reason };
}

/**
 * The only media types the review inbox will name. Everything else stays
 * opaque rather than becoming a hint about what the holding area contains.
 */
export type ReviewAttachmentMediaType = "application/pdf" | "application/octet-stream";

export function reviewAttachmentMediaType(stored: string | null | undefined): ReviewAttachmentMediaType {
  return stored === "application/pdf" ? "application/pdf" : "application/octet-stream";
}

/**
 * Mailbox intake refuses to hold bytes unless scanning is *required* and the
 * verdict came back clean (`scanAndHoldImapAttachment`), and it refuses to
 * hold anything at all when the scanner is switched off. So a row still in a
 * holding state IS that clean verdict: the word is read off the state
 * machine, never invented for the screen (#467).
 */
export function reviewAttachmentScanState(status: string): "clean" | "unknown" {
  return status === "stored" || status === "assigned" ? "clean" : "unknown";
}

const displayFallbackMediaTypes = new Map<string, SupportedDocumentMediaType>([
  ["application/pdf", "application/pdf"],
  ["image/jpeg", "image/jpeg"],
  ["image/png", "image/png"],
]);

/**
 * Re-normalizes a stored attachment name on the way out (#467). Intake
 * already ran `normalizeImapAttachmentName` over the provider's value, but
 * the column holds durable, sender-controlled text — so the read path strips
 * control and bidi characters, collapses whitespace, keeps only the leaf of
 * any path, and re-bounds the length rather than trusting the row. It is
 * display text, never a key and never a filename to write.
 */
export function reviewAttachmentDisplayName(
  stored: string | null | undefined,
  mediaType: string | null | undefined,
): string {
  return normalizeImapAttachmentName(stored ?? undefined, displayFallbackMediaTypes.get(mediaType ?? "") ?? "application/pdf");
}

/**
 * Promoted to `normalizeComparableMetadata` (ADR-0024 decision 2), so the
 * blind index and every in-application comparison agree on one canonical form.
 * The implementation moved for a second reason: the range it used to spell out
 * by hand is exactly the regular-expression trap docs/testing.md ("Local traps") warns about, and
 * the shared version scans for control characters explicitly instead.
 */
const comparableText = normalizeComparableMetadata;

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
