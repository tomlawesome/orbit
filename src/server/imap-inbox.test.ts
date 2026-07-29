import { describe, expect, it } from "vitest";
import { findReviewedIntakeCandidateReason, reviewInboxState } from "./imap-inbox";

describe("private mailbox review mapping", () => {
  const now = new Date("2030-01-02T00:00:00.000Z");
  const expiresAt = new Date("2030-01-03T00:00:00.000Z");

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
    expect(reviewInboxState("recoverable", "staging_purge_failed", {
      hasApprovalOperation: true,
      hasApprovedItem: true,
      expiresAt,
      now,
    })).toMatchObject({
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
