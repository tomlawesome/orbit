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

export type ReviewInboxClassification = "ready" | "waiting" | "retry" | "unavailable";

export type ReviewInboxStateContext = {
  hasApprovalOperation?: boolean;
  hasApprovedItem?: boolean;
  /**
   * Whether the stored request the review read would hand back exists;
   * without it a retry has no body to send and is not offered.
   */
  hasApprovalRequest?: boolean;
  expiresAt?: Date;
  now?: Date;
};

const attachmentTransferFailureCodes = new Set([
  // An abandoned approval reclaimed after its item was made (#1396): the same
  // pair, reported by the review read, finishes it.
  "approval_interrupted",
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
  | "interrupted"
  | "wrong_recipient"
  | "account_disabled"
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
  // #1681 (87d): the sender's signature could not be checked, so nothing was kept.
  sender_dkim_unavailable: "not_kept",
  // #1681 (note 52496): a verified member's forward carried no signature Orbit could verify, so nothing was kept.
  sender_unsigned: "not_kept",
  // A verified member's forward over the raw size limit: never read, so never checked.
  sender_too_large: "too_large",
  // The item exists; only finishing it was cut short (#1568).
  approval_interrupted: "interrupted",
  // The scanner answered clean; the step that did not finish is the open check.
  structure_check_unavailable: "interrupted",
  recipient_mismatch: "wrong_recipient",
  account_disabled: "account_disabled",
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

/** Words for the terminal outcomes of attributed mail (#1652), keyed by stored `failure_code`. */
const terminalOutcomeMessages: Record<string, string> = {
  no_supported_pdf: "no PDF attached",
  message_too_large: "message over the size limit",
  attachment_processing_exhausted: "attachment could not be processed",
  // #1681, owner decision 87d.
  sender_dkim_unavailable: "Orbit could not check that this came from you, so it was not kept. Please send it again.",
  // #1681, design note 52496.
  sender_unsigned: "Orbit could not confirm this came from you, so it was not kept. Your mail service did not sign it (DKIM). Send it again from a service that signs, or ask whoever runs your mail domain to turn signing on.",
  sender_too_large: "This message was over the 25 MiB size limit, so Orbit could not check that it came from you and did not keep it. Send it again with fewer or smaller attachments.",
};

/** Failed receipts a member may remove: they hold no staged bytes, only the row (#1652). */
export function isRemovableTerminalFailure(status: string, failureCode: string | null | undefined): boolean {
  return status === "failed"
    && (failureCode === "no_supported_pdf" || failureCode === "message_too_large" || failureCode === "sender_dkim_unavailable"
      || failureCode === "sender_unsigned" || failureCode === "sender_too_large");
}

export function reviewInboxState(status: string, failureCode: string | null | undefined, context: ReviewInboxStateContext = {}): {
  classification: ReviewInboxClassification;
  canApprove: boolean;
  canDiscard: boolean;
  message: string;
  reason: FailureReason;
  /** The stored code of a terminal failure (#1670 G-W3), so a label need not read `message`. */
  failureCode?: string;
} {
  const now = context.now ?? new Date();
  const hasUnexpiredReceipt = Boolean(context.expiresAt && context.expiresAt > now);
  const canRetryAttachmentTransfer = status === "recoverable"
    && Boolean(context.hasApprovalOperation)
    && Boolean(context.hasApprovedItem)
    && Boolean(context.hasApprovalRequest)
    && hasUnexpiredReceipt
    && attachmentTransferFailureCodes.has(failureCode ?? "");
  // Made its item but holds no stored request (claimed before the request
  // was kept, #1396): nothing can finish it, so it is not offered. The item
  // is in the filed lane; discarding clears the receipt.
  const madeItemWithoutRequest = status === "recoverable"
    && Boolean(context.hasApprovalOperation)
    && Boolean(context.hasApprovedItem)
    && !context.hasApprovalRequest
    && attachmentTransferFailureCodes.has(failureCode ?? "");
  const reason = failureReasonOf(failureCode);
  /* #1652: an attributed forward with nothing to collect, or too big, or whose
     attachment could not be processed, is told to its member in its own words
     and can be removed. Unattributed mail never reaches this list (ADR-0017). */
  const terminal = status === "failed" || status === "recoverable" ? terminalOutcomeMessages[failureCode ?? ""] : undefined;
  /* Removable only where that is already safe: a failed row holding no staged
     bytes, or a recoverable row on the ordinary discard path. A failed row whose
     attachment processing was exhausted stays cleanup-only (#1403 D4). */
  if (terminal) return { classification: "unavailable", canApprove: false, canDiscard: status === "recoverable" || isRemovableTerminalFailure(status, failureCode), message: terminal, reason, failureCode: failureCode ?? undefined };
  if (status === "pending_review") return { classification: "ready", canApprove: true, canDiscard: true, message: "Ready for your review.", reason };
  if (status === "processing" || status === "approving") return { classification: "waiting", canApprove: false, canDiscard: false, message: "Orbit is still preparing this private review.", reason };
  /* ADR-0017 slice 5 (#746): the reader paused their own collection, so this
     arrived and was deliberately left alone. Saying so is the point — a held
     message that looked "unavailable" would read as something going wrong. */
  if (status === "held") return { classification: "waiting", canApprove: false, canDiscard: false, message: "Collection is paused. This will be prepared when you turn it back on.", reason };
  /* #1568: an interrupted approval says so in its own words, whether or not
     documents remain to attach (the worker's step is not the member's business). */
  if (canRetryAttachmentTransfer && failureCode === "approval_interrupted") return { classification: "retry", canApprove: true, canDiscard: true, message: "Your earlier approval was cut short after the item was recorded. Try once more to finish it.", reason };
  if (canRetryAttachmentTransfer) return { classification: "retry", canApprove: true, canDiscard: true, message: "The item was created; retry to finish attaching the selected documents.", reason };
  if (madeItemWithoutRequest) return { classification: "unavailable", canApprove: false, canDiscard: true, message: "The item was added, but Orbit could not finish attaching its documents, and this one cannot be retried. Remove the message to clear it.", reason };
  if (status === "recoverable") return { classification: "retry", canApprove: false, canDiscard: true, message: "Private cleanup is waiting to finish. You can retry discard.", reason };
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
