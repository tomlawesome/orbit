import { describe, expect, it } from "vitest";
import {
  canonicalReviewedIntakeHash,
  clearedReviewDraftMetadata,
  reviewDraftMetadataFromProposal,
  reviewedIntakeApprovalSchema,
  sanitizeReviewDraftMetadata,
} from "./reviewed-intake";

describe("reviewed intake contract", () => {
  it("accepts only the two explicit approval actions and bounded final values", () => {
    const parsed = reviewedIntakeApprovalSchema.parse({
      operationId: "11111111-1111-4111-8111-111111111111",
      source: {
        kind: "mailbox_draft",
        receiptId: "22222222-2222-4222-8222-222222222222",
        draftVersion: 3,
      },
      householdId: "33333333-3333-4333-8333-333333333333",
      sectionId: "44444444-4444-4444-8444-444444444444",
      action: "create_separate",
      item: {
        title: "Reviewed title",
        provider: "Reviewed provider",
        reference: "REF-12345",
        currency: "GBP",
        status: "active",
      },
      attachmentIds: ["55555555-5555-4555-8555-555555555555"],
    });

    expect(parsed.source).toEqual({
      kind: "mailbox_draft",
      receiptId: "22222222-2222-4222-8222-222222222222",
      draftVersion: 3,
    });
    expect(() => reviewedIntakeApprovalSchema.parse({ ...parsed, action: "merge" })).toThrow();
    expect(() => reviewedIntakeApprovalSchema.parse({ ...parsed, action: "attach_existing", targetItemId: undefined })).toThrow();
  });

  it("redacts unsupported and content-bearing proposal/evidence values", () => {
    expect(sanitizeReviewDraftMetadata({
      proposal: {
        title: "  Suggested title  ",
        provider: "Provider",
        body: "raw message content must not survive",
        filename: "private.pdf",
        reference: "REF-1",
      },
      fieldEvidence: {
        title: { source: "parser", confidence: "high", excerpt: "private text" },
        provider: { source: "parser", confidence: "medium" },
        storageKey: { source: "parser", confidence: "high" },
      },
    })).toEqual({
      proposal: { title: "Suggested title", provider: "Provider", reference: "REF-1" },
      fieldEvidence: {
        title: { source: "parser", confidence: "high" },
        provider: { source: "parser", confidence: "medium" },
      },
    });
  });

  it("hashes canonical reviewed values instead of raw object key order", () => {
    const base = {
      operationId: "11111111-1111-4111-8111-111111111111",
      source: { kind: "direct_upload", expectedDocument: true },
      householdId: "33333333-3333-4333-8333-333333333333",
      sectionId: "44444444-4444-4444-8444-444444444444",
      action: "create_separate" as const,
      item: { title: "Reviewed", provider: "Provider", currency: "GBP", status: "active" },
      attachmentIds: [],
    };
    const reordered = { ...base, item: { status: "active", currency: "GBP", provider: "Provider", title: "Reviewed" } };
    expect(canonicalReviewedIntakeHash(reviewedIntakeApprovalSchema.parse(base))).toBe(
      canonicalReviewedIntakeHash(reviewedIntakeApprovalSchema.parse(reordered)),
    );
  });

  it("keeps a bounded rejected-reading alternative and drops an oversized or markup-bearing one (#959, ADR-0025 section 4)", () => {
    expect(sanitizeReviewDraftMetadata({
      proposal: { provider: "Larkfield Mutual" },
      fieldEvidence: {
        provider: { source: "document_text", confidence: "medium", alternative: "  Acme Cover  " },
        reference: { source: "document_text", confidence: "medium", alternative: "x".repeat(81) },
        title: { source: "filename", confidence: "high", alternative: "<script>alert(1)</script>" },
      },
    })).toEqual({
      proposal: { provider: "Larkfield Mutual" },
      fieldEvidence: {
        provider: { source: "document_text", confidence: "medium", alternative: "Acme Cover" },
        reference: { source: "document_text", confidence: "medium" },
        title: { source: "filename", confidence: "high" },
      },
    });
  });

  it("carries the rejected reading into a mail-in draft's field evidence only for the fields adjudication disputed", () => {
    const proposal = { title: "receipt", provider: "Larkfield Mutual", reference: "LKM-1", dates: ["2027-02-01"] };
    const { fieldEvidence } = reviewDraftMetadataFromProposal(proposal, { provider: "Acme Cover" });

    expect(fieldEvidence.provider).toEqual({ source: "document_text", confidence: "medium", alternative: "Acme Cover" });
    expect(fieldEvidence.reference).toEqual({ source: "document_text", confidence: "medium" });
    expect(fieldEvidence.title).toEqual({ source: "filename", confidence: "high" });
  });

  it("offers no alternative for a mail-in draft when adjudication is absent or agreed on everything", () => {
    const proposal = { title: "receipt", provider: "Larkfield Mutual", reference: "LKM-1", dates: ["2027-02-01"] };

    expect(reviewDraftMetadataFromProposal(proposal).fieldEvidence.provider).toEqual({ source: "document_text", confidence: "medium" });
  });

  it("clears every column a mail-in draft's rejected reading could ride in, and nothing else", () => {
    expect(clearedReviewDraftMetadata).toEqual({
      proposal: {},
      proposalEnc: null,
      fieldEvidence: {},
      fieldEvidenceEnc: null,
    });
  });

  it("requires an explicit, validated operation identity to complete a direct document upload", () => {
    expect(reviewedIntakeApprovalSchema.parse({
      operationId: "11111111-1111-4111-8111-111111111111",
      source: { kind: "direct_upload", expectedDocument: true },
      householdId: "33333333-3333-4333-8333-333333333333",
      sectionId: "44444444-4444-4444-8444-444444444444",
      action: "create_separate",
      item: { title: "Reviewed", currency: "GBP" },
      attachmentIds: [],
    }).source).toEqual({ kind: "direct_upload", expectedDocument: true });
  });
});
