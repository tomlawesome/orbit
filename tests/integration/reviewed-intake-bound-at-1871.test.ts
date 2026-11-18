import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { documents, imapIngestionAttachments, imapIngestionMessages } from "@/db/schema";
import { approveReviewedIntake } from "@/server/reviewed-intake";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { sealedHash } from "./support/imap-attachment-seed";
import { holdAttachmentBytes } from "../support/imap-holding";
import { syntheticPdf } from "../support/synthetic-documents";

/* #1871 review Lows: the reviewed-intake bind sets bound_at, and the staged
   discard never hard-deletes a document that an item once bound. */

vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(async () => ({ status: "clean" as const })),
}));

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;

async function receiptWithAttachment(fixture: Fixture, label: string, uid: number, attachToExisting = false) {
  const receiptId = randomUUID();
  const held = await holdAttachmentBytes({ bytes: syntheticPdf(label), displayName: `${label}.pdf`, mediaType: "application/pdf", recipientUserId: fixture.users.member.id, receiptId });
  await getDb().insert(imapIngestionMessages).values({
    id: receiptId, mailbox: "private", mailboxUidValidity: label, mailboxUid: uid,
    recipientAliasSha256: label, userId: fixture.users.member.id, householdId: fixture.household.id,
    status: "pending_review", expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending",
  });
  await getDb().insert(imapIngestionAttachments).values({
    id: held.id, messageId: receiptId, displayName: held.displayName, mediaType: held.mediaType, sizeBytes: held.sizeBytes,
    ...await sealedHash(receiptId, held.id, held.contentSha256), storageKey: held.storageKey, ciphertextSize: held.ciphertextSize, ...held.envelope, status: "stored",
  });
  return {
    attachmentId: held.id,
    input: {
      operationId: randomUUID(),
      source: { kind: "mailbox_draft" as const, receiptId, draftVersion: 1 },
      householdId: fixture.household.id,
      sectionId: fixture.section.id,
      ...(attachToExisting
        ? { action: "attach_existing" as const, targetItemId: fixture.item.id }
        : { action: "create_separate" as const }),
      item: { title: `${label} value`, currency: "GBP", status: "active" },
      attachmentIds: [held.id],
    },
  };
}

describe("reviewed intake and bound_at (#1871)", () => {
  it("an approval that attaches a mail attachment leaves its document bound: bound_at set, delete_after null", async () => {
    // Catches the reviewed-intake bind (bindStagedDocuments, reached by attaching to an existing item) clearing delete_after but not setting bound_at.
    const fixture = await createIntegrationFixture("b1871-reviewed-bind");
    try {
      const { attachmentId, input } = await receiptWithAttachment(fixture, "b1871 reviewed bind", 1871001, true);
      const outcome = await approveReviewedIntake(fixture.users.member.id, input);
      expect(outcome.attachedAttachmentIds).toContain(attachmentId);
      const [staged] = await getDb().select({ id: imapIngestionAttachments.assignedDocumentId }).from(imapIngestionAttachments).where(eq(imapIngestionAttachments.id, attachmentId));
      const [state] = await getDb().execute(sql`select bound_at, delete_after, item_id from documents where id = ${staged!.id}`) as Array<{ bound_at: string | null; delete_after: string | null; item_id: string | null }>;
      expect(state.item_id).not.toBeNull();
      expect(state.delete_after).toBeNull();
      expect(state.bound_at, "bound_at set by the bind").not.toBeNull();
      expect(Math.abs(new Date(state.bound_at!).getTime() - Date.now())).toBeLessThan(60_000);
    } finally {
      await fixture.cleanup();
    }
  });

  it("the staged discard keeps a document that was once bound, even with no item now", async () => {
    // Catches discardStagedDocuments hard-deleting on item_id null alone: a kept paper whose item was deleted has bound_at set.
    const fixture = await createIntegrationFixture("b1871-reviewed-discard");
    try {
      const { attachmentId, input } = await receiptWithAttachment(fixture, "b1871 reviewed discard", 1871002);
      const bound = new Date(Date.now() - 86_400_000);
      await getDb().insert(documents).values({
        id: attachmentId, householdId: fixture.household.id, itemId: null, sealedItemId: randomUUID(),
        uploadedByUserId: fixture.users.member.id, displayName: "kept.pdf", mediaType: "application/pdf", sizeBytes: 128,
        contentSha256: "0".repeat(64), lifecycle: "available", scanStatus: "skipped", availableAt: bound, boundAt: bound, deleteAfter: null,
      });
      // The kept paper holds the attachment's id, so the approval is refused cleanly
      // rather than replacing it.
      await expect(approveReviewedIntake(fixture.users.member.id, input)).rejects.toMatchObject({ code: "document_conflict", status: 409 });
      // The approval stages its own copy under the attachment's id, so a deleted
      // stray would come back as a different row: check it is still this one.
      const rows = await getDb().select({ name: documents.displayName, sealed: documents.sealedItemId, boundAt: documents.boundAt }).from(documents).where(eq(documents.id, attachmentId));
      expect(rows, "one row under that id").toHaveLength(1);
      expect(rows[0]!.name, "the once-bound document itself survives the staged discard").toBe("kept.pdf");
      expect(rows[0]!.boundAt).not.toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });
});
