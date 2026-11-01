import { describe, expect, it } from "vitest";
import {
  findReviewedIntakeCandidateReason,
  reviewAttachmentDisplayName,
  reviewAttachmentMediaType,
  reviewAttachmentScanState,
  reviewInboxState,
} from "./imap-inbox";

describe("private mailbox review mapping", () => {
  const now = new Date("2030-01-02T00:00:00.000Z");
  const expiresAt = new Date("2030-01-03T00:00:00.000Z");
  // A retry is offered only when the stored request exists to be reported (L-F2 / O-F8).
  const retryable = { hasApprovalOperation: true, hasApprovedItem: true, hasApprovalRequest: true, expiresAt, now };
  const noStoredRequest = { ...retryable, hasApprovalRequest: false };

  it("exposes only safe actions for processing, review, retry, and terminal states", () => {
    expect(reviewInboxState("processing", "scanner_disabled")).toMatchObject({
      classification: "waiting",
      canApprove: false,
      canDiscard: false,
    });
    expect(reviewInboxState("pending_review", null)).toMatchObject({
      classification: "ready",
      canApprove: true,
      canDiscard: true,
    });
    expect(reviewInboxState("recoverable", "staging_purge_failed")).toMatchObject({
      classification: "retry",
      canApprove: false,
      canDiscard: true,
    });
    expect(reviewInboxState("recoverable", "staging_purge_failed", retryable)).toMatchObject({
      classification: "retry",
      canApprove: true,
      canDiscard: true,
    });
    expect(reviewInboxState("recoverable", "discard_purge_failed", {
      hasApprovalOperation: true,
      hasApprovedItem: true,
      expiresAt,
      now,
    })).toMatchObject({ canApprove: false, canDiscard: true });
    expect(reviewInboxState("recoverable", "attachment_transfer_failed", {
      hasApprovalOperation: true,
      hasApprovedItem: false,
      expiresAt,
      now,
    })).toMatchObject({ canApprove: false, canDiscard: true });
    expect(reviewInboxState("recoverable", "attachment_transfer_failed", {
      hasApprovalOperation: true,
      hasApprovedItem: true,
      expiresAt: now,
      now,
    })).toMatchObject({ canApprove: false, canDiscard: true });
    expect(reviewInboxState("quarantined", "provider_identity_ambiguous")).toMatchObject({
      classification: "unavailable",
      canApprove: false,
      canDiscard: false,
      reason: "unknown",
    });
  });

  // #1568: an interrupted approval has its own line, keyed on the code (not on
  // a document count): the item is recorded and one more try finishes it.
  const INTERRUPTED_MESSAGE = "Your earlier approval was cut short after the item was recorded. Try once more to finish it.";

  it("gives an interrupted approval its own retry line and reason (#1568)", () => {
    expect(reviewInboxState("recoverable", "approval_interrupted", retryable)).toMatchObject({
      classification: "retry",
      canApprove: true,
      canDiscard: true,
      message: INTERRUPTED_MESSAGE,
      reason: "interrupted",
    });
  });

  it("keeps the cleanup line for an interrupted approval whose receipt has expired (#1568)", () => {
    const expired = reviewInboxState("recoverable", "approval_interrupted", { ...retryable, expiresAt: now });
    expect(expired).toMatchObject({ canApprove: false, canDiscard: true });
    expect(expired.message).toContain("Private cleanup is waiting to finish");
  });

  it("keeps the attaching-documents line for attachment_transfer_failed (#1568)", () => {
    const state = reviewInboxState("recoverable", "attachment_transfer_failed", retryable);
    expect(state).toMatchObject({ classification: "retry", canApprove: true });
    expect(state.message).toContain("attaching the selected documents");
    expect(state.message).not.toBe(INTERRUPTED_MESSAGE);
  });

  it("an item with no stored request cannot be retried: terminal, discard the way out (O-F8)", () => {
    for (const code of ["approval_interrupted", "attachment_transfer_failed", "staging_purge_failed", "attachment_state_changed"]) {
      const state = reviewInboxState("recoverable", code, noStoredRequest);
      expect(state, code).toMatchObject({ classification: "unavailable", canApprove: false, canDiscard: true });
      // The words say the item was added, and that this one cannot be retried.
      expect(state.message, code).toMatch(/added/i);
      expect(state.message, code).toMatch(/cannot be retried|can't be retried|not be retried/i);
    }
  });

  it("the same receipt with its stored request keeps the retry contract (O-F8)", () => {
    for (const code of ["approval_interrupted", "attachment_transfer_failed", "staging_purge_failed", "attachment_state_changed"]) {
      expect(reviewInboxState("recoverable", code, retryable), code).toMatchObject({ classification: "retry", canApprove: true, canDiscard: true });
    }
  });

  it("the stored-request flag defaults closed: a retryable context without it cannot approve (O-F8)", () => {
    const withoutFlag = { hasApprovalOperation: true, hasApprovedItem: true, expiresAt, now };
    expect(reviewInboxState("recoverable", "attachment_transfer_failed", withoutFlag).canApprove).toBe(false);
  });

  it("a recoverable receipt with no item and no stored request keeps the private-cleanup answer (O-F8 guard)", () => {
    expect(reviewInboxState("recoverable", "attachment_transfer_failed", { ...noStoredRequest, hasApprovedItem: false })).toMatchObject({
      classification: "retry",
      canApprove: false,
      canDiscard: true,
      message: "Private cleanup is waiting to finish. You can retry discard.",
    });
  });

  it("derives bounded coarse duplicate reasons from server-owned proposal values", () => {
    expect(findReviewedIntakeCandidateReason(
      { title: "Annual cover", provider: "Orbit Cover", reference: "POL-123" },
      { title: "Annual cover", provider: "Different", reference: "Other", subtype: null },
    )).toBe("matching title");
    expect(findReviewedIntakeCandidateReason(
      { title: "Annual cover", provider: "Orbit Cover", reference: "POL-123" },
      { title: "Another item", provider: "Orbit Cover", reference: "Other", subtype: null },
    )).toBe("matching provider");
    expect(findReviewedIntakeCandidateReason(
      { title: "Annual cover", provider: "Orbit Cover", reference: "POL-123" },
      { title: "Another item", provider: "Different", reference: "Other", subtype: null },
    )).toBeUndefined();
  });
});

/** #467: the review inbox names the reader's own documents. The name is
 * sender-controlled text, so the read path re-sanitises the column rather
 * than trusting whatever intake wrote there. */
describe("review attachment display shaping", () => {
  it("keeps an ordinary name intact", () => {
    expect(reviewAttachmentDisplayName("policy-schedule.pdf", "application/pdf")).toBe("policy-schedule.pdf");
  });

  it("keeps only the leaf of a POSIX or Windows path", () => {
    expect(reviewAttachmentDisplayName("../../etc/passwd.pdf", "application/pdf")).toBe("passwd.pdf");
    expect(reviewAttachmentDisplayName("C:\\Users\\alex\\policy schedule.PDF", "application/pdf")).toBe("policy schedule.PDF");
  });

  it("strips control, NUL and bidi characters that could disguise the name", () => {
    expect(reviewAttachmentDisplayName("in\u0000voi\u202Efdp.exe", "application/pdf")).toBe("invoifdp.exe");
    expect(reviewAttachmentDisplayName("line\nbreak.pdf", "application/pdf")).toBe("linebreak.pdf");
  });

  it("bounds the length and never returns an empty chip", () => {
    const long = reviewAttachmentDisplayName(`${"z".repeat(400)}.pdf`, "application/pdf");
    expect(Buffer.byteLength(long, "utf8")).toBeLessThanOrEqual(180);
    expect(reviewAttachmentDisplayName("   ", "application/pdf")).toBe("document.pdf");
    expect(reviewAttachmentDisplayName(null, "image/png")).toBe("document.png");
    expect(reviewAttachmentDisplayName(undefined, "image/jpeg")).toBe("document.jpg");
  });

  it("names only the one media type the review inbox understands", () => {
    expect(reviewAttachmentMediaType("application/pdf")).toBe("application/pdf");
    for (const hostile of ["application/x-msdownload", "text/html", "", null, undefined]) {
      expect(reviewAttachmentMediaType(hostile)).toBe("application/octet-stream");
    }
  });

  it("reads the clean verdict off the holding state instead of inventing it", () => {
    expect(reviewAttachmentScanState("stored")).toBe("clean");
    expect(reviewAttachmentScanState("assigned")).toBe("clean");
    expect(reviewAttachmentScanState("rejected")).toBe("unknown");
  });
});
