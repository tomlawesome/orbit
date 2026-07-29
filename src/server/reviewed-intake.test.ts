import { describe, expect, it } from "vitest";
import {
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
});
