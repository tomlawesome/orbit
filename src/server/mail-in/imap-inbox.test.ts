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

/** #467: the review inbox names the reader's own documents. The name is
 * sender-controlled text, so the read path re-sanitises the column rather
 * than trusting whatever intake wrote there. */
describe("review attachment display shaping", () => {
  it("keeps an ordinary name intact", () => {
    expect(reviewAttachmentDisplayName("policy-schedule.pdf", "application/pdf")).toBe("policy-schedule.pdf");
  });

  it("keeps only the leaf of a POSIX or Windows path", () => {
    expect(reviewAttachmentDisplayName("../../etc/passwd.pdf", "application/pdf")).toBe("passwd.pdf");
    expect(reviewAttachmentDisplayName("C:\\Users\\tom\\policy schedule.PDF", "application/pdf")).toBe("policy schedule.PDF");
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
