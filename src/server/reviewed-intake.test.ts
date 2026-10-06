import { describe, expect, it } from "vitest";
import {
  canonicalReviewedIntakeHash,
  clearedReviewDraftMetadata,
  reviewDraftMetadataFromProposal,
  reviewedIntakeApprovalSchema,
  sanitizeReviewDraftMetadata,
} from "./reviewed-intake";

describe("reviewed intake contract", () => {
  // #1151 A3-Q8: this schema places no bound on `item` -- it is a plain
  // z.record(string, unknown) -- so the title no longer claims one. Any
  // bound on a final value is the service's job (canonicalItem and what it
  // feeds), not this schema's.
  it("accepts only the two explicit approval actions, and requires a target item for attach_existing", () => {
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

  it("keeps an expiry scheduleKind, not just renewal and service (#1151 A3-Q1)", () => {
    expect(sanitizeReviewDraftMetadata({
      proposal: { title: "Passport", scheduleKind: "expiry" },
    })).toEqual({
      proposal: { title: "Passport", scheduleKind: "expiry" },
      fieldEvidence: {},
    });
    expect(sanitizeReviewDraftMetadata({
      proposal: { title: "Passport", scheduleKind: "not_a_real_kind" },
    })).toEqual({
      proposal: { title: "Passport" },
      fieldEvidence: {},
    });
  });

  it("strips Unicode bidi and zero-width characters from a proposal field, like suggestions.ts's own sanitiser (#1151 A3-Q2)", () => {
    // U+2066 (left-to-right isolate) and U+200B (zero-width space): neither
    // is a `<` or `>`, so only a sanitiser that knows about bidi and
    // zero-width characters specifically catches them.
    expect(sanitizeReviewDraftMetadata({
      proposal: { title: `Acme⁦ Cover​` },
    })).toEqual({
      proposal: { title: "Acme Cover" },
      fieldEvidence: {},
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
    const base = {
      source: { kind: "direct_upload", expectedDocument: true },
      householdId: "33333333-3333-4333-8333-333333333333",
      sectionId: "44444444-4444-4444-8444-444444444444",
      action: "create_separate",
      item: { title: "Reviewed", currency: "GBP" },
      attachmentIds: [],
    };

    expect(reviewedIntakeApprovalSchema.parse({
      ...base,
      operationId: "11111111-1111-4111-8111-111111111111",
    }).source).toEqual({ kind: "direct_upload", expectedDocument: true });

    // #1151 A3-Q7: a missing or non-UUID operationId must be rejected, not
    // silently accepted -- this is the "validated operation identity" the
    // test's name promises.
    expect(() => reviewedIntakeApprovalSchema.parse({ ...base })).toThrow();
    expect(() => reviewedIntakeApprovalSchema.parse({ ...base, operationId: "not-a-uuid" })).toThrow();
  });
});
