import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { auditLog, documents, imapIngestionAttachments, imapIngestionMessages, items, reviewedIntakeOperations, sections } from "@/db/schema";
import { approveReviewedIntake } from "@/server/reviewed-intake";
import { purgeHeldImapAttachment, scanAndHoldImapAttachment, setImapHoldingPurgeImplementationForTests } from "@/server/imap-attachment-holding";
import { uploadItemDocument } from "@/server/document-repository";
import { createIntegrationFixture } from "./support/fixtures";
import { syntheticPdf } from "../support/synthetic-documents";

function directInput(fixture: Awaited<ReturnType<typeof createIntegrationFixture>>, operationId: string) {
  return {
    operationId,
    source: { kind: "direct_upload" as const, expectedDocument: false },
    householdId: fixture.household.id,
    sectionId: fixture.section.id,
    action: "create_separate" as const,
    item: { title: "Concurrent reviewed value", currency: "GBP", status: "active" },
    attachmentIds: [],
  };
}

describe("reviewed intake PostgreSQL idempotency boundaries", () => {
  it("returns one durable direct result for concurrent identical submissions", async () => {
    const fixture = await createIntegrationFixture("reviewed-concurrent-direct");
    const input = directInput(fixture, randomUUID());
    const [first, second] = await Promise.all([
      approveReviewedIntake(fixture.users.member.id, input),
      approveReviewedIntake(fixture.users.member.id, input),
    ]);
    expect(first.itemId).toBe(second.itemId);
    expect(first.approvalResultId).toBe(second.approvalResultId);
    expect(await getDb().select({ id: reviewedIntakeOperations.id }).from(reviewedIntakeOperations).where(eq(reviewedIntakeOperations.id, input.operationId))).toHaveLength(1);
    expect(await getDb().select({ id: items.id }).from(items).where(eq(items.id, first.itemId))).toHaveLength(1);
    expect(await getDb().select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.entityType, "item"), eq(auditLog.entityId, first.itemId)))).toHaveLength(1);
    const [replacement] = await getDb().insert(sections).values({ householdId: fixture.household.id, slug: `replacement-${randomUUID()}`, name: "Replacement", position: 1 }).returning({ id: sections.id });
    await getDb().update(items).set({ sectionId: replacement.id }).where(eq(items.householdId, fixture.household.id));
    await getDb().delete(sections).where(eq(sections.id, fixture.section.id));
    await fixture.cleanup();
  });

  it("serializes two attachment claimers so only one worker owns the staged row", async () => {
    const fixture = await createIntegrationFixture("reviewed-concurrent-attachment");
    const [receipt] = await getDb().insert(imapIngestionMessages).values({
      mailbox: "private", mailboxUidValidity: "claim", mailboxUid: 1, contentSha256: randomUUID().replaceAll("-", ""),
      recipientAliasSha256: "claim", userId: fixture.users.member.id, householdId: fixture.household.id,
      status: "recoverable", expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending",
    }).returning({ id: imapIngestionMessages.id });
    const [attachment] = await getDb().insert(imapIngestionAttachments).values({
      messageId: receipt.id, displayName: "claim.pdf", mediaType: "application/pdf", sizeBytes: 8,
      contentSha256: randomUUID().replaceAll("-", ""), storageKey: `claim/${randomUUID()}`, ciphertextSize: 16,
      envelopeVersion: 1, contentIv: "iv", contentAuthTag: "tag", wrappedDek: "dek", wrapIv: "wrap-iv",
      wrapAuthTag: "wrap-tag", keyId: "key", status: "stored",
    }).returning({ id: imapIngestionAttachments.id });
    const claim = async () => getDb().update(imapIngestionAttachments).set({ transferClaimToken: randomUUID(), transferLeaseExpiresAt: new Date(Date.now() + 300_000) })
      .where(and(eq(imapIngestionAttachments.id, attachment.id), eq(imapIngestionAttachments.status, "stored"), or(isNull(imapIngestionAttachments.transferClaimToken), lt(imapIngestionAttachments.transferLeaseExpiresAt, new Date())))).returning({ id: imapIngestionAttachments.id });
    const [first, second] = await Promise.all([claim(), claim()]);
    expect(first.length + second.length).toBe(1);
    await fixture.cleanup();
  });

  it("does not newly approve a cleanup-recoverable mailbox receipt", async () => {
    const fixture = await createIntegrationFixture("reviewed-cleanup-recoverable");
    const receiptId = randomUUID();
    await getDb().insert(imapIngestionMessages).values({
      id: receiptId, mailbox: "private", mailboxUidValidity: "cleanup", mailboxUid: 5, contentSha256: randomUUID().replaceAll("-", ""),
      recipientAliasSha256: "cleanup", userId: fixture.users.member.id, householdId: fixture.household.id,
      status: "recoverable", failureCode: "staging_purge_pending", expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending",
    });
    const beforeItems = await getDb().select({ id: items.id }).from(items).where(eq(items.householdId, fixture.household.id));
    const input = {
      operationId: randomUUID(),
      source: { kind: "mailbox_draft" as const, receiptId, draftVersion: 1 },
      householdId: fixture.household.id,
      sectionId: fixture.section.id,
      action: "create_separate" as const,
      item: { title: "Must not publish", currency: "GBP", status: "active" },
      attachmentIds: [],
    };
    await expect(approveReviewedIntake(fixture.users.member.id, input)).rejects.toMatchObject({ code: "reviewed_intake_not_approvable" });
    expect(await getDb().select({ id: items.id }).from(items).where(eq(items.householdId, fixture.household.id))).toEqual(beforeItems);
    expect(await getDb().select({ id: reviewedIntakeOperations.id }).from(reviewedIntakeOperations).where(eq(reviewedIntakeOperations.id, input.operationId))).toHaveLength(0);
    expect((await getDb().select({ status: imapIngestionMessages.status, approvalOperationId: imapIngestionMessages.approvalOperationId }).from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId)))[0]).toMatchObject({ status: "recoverable", approvalOperationId: null });
    await fixture.cleanup();
  });

  it("runs concurrent mailbox approvals through transfer and leaves one document and one result audit", async () => {
    const fixture = await createIntegrationFixture("reviewed-concurrent-mailbox");
    const receiptId = randomUUID();
    const held = await scanAndHoldImapAttachment({
      bytes: syntheticPdf("concurrent mailbox attachment"),
      filename: "concurrent-mailbox.pdf",
      declaredMediaType: "application/pdf",
      recipientUserId: fixture.users.member.id,
      receiptId,
    });
    const [receipt] = await getDb().insert(imapIngestionMessages).values({
      id: receiptId,
      mailbox: "private", mailboxUidValidity: "mailbox", mailboxUid: 2, contentSha256: randomUUID().replaceAll("-", ""),
      recipientAliasSha256: "mailbox", userId: fixture.users.member.id, householdId: fixture.household.id,
      status: "pending_review", expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending",
    }).returning({ id: imapIngestionMessages.id });
    await getDb().insert(imapIngestionAttachments).values({
      id: held.id, messageId: receipt.id, displayName: held.displayName, mediaType: held.mediaType,
      sizeBytes: held.sizeBytes, contentSha256: held.contentSha256, storageKey: held.storageKey,
      ciphertextSize: held.ciphertextSize, ...held.envelope, status: "stored",
    });
    const input = {
      operationId: randomUUID(),
      source: { kind: "mailbox_draft" as const, receiptId: receipt.id, draftVersion: 1 },
      householdId: fixture.household.id,
      sectionId: fixture.section.id,
      action: "create_separate" as const,
      item: { title: "Concurrent mailbox value", currency: "GBP", status: "active" },
      attachmentIds: [held.id],
    };
    const [first, second] = await Promise.all([
      approveReviewedIntake(fixture.users.member.id, input),
      approveReviewedIntake(fixture.users.member.id, input),
    ]);
    // Both calls must identify the same item and approval result.
    expect(first.itemId).toBe(second.itemId);
    expect(first.approvalResultId).toBe(second.approvalResultId);
    // At least one call is approved and no outcome is outside approved | partial_success.
    expect([first.outcome, second.outcome] as string[]).toEqual(expect.arrayContaining(["approved"]));
    expect(first.outcome).toMatch(/^(approved|partial_success)$/);
    expect(second.outcome).toMatch(/^(approved|partial_success)$/);
    // Every approved result reports the attachment as attached; partial_success reports it pending.
    if (first.outcome === "approved") {
      expect(first.attachmentState).toBe("attached");
      expect(first.attachedAttachmentIds).toContain(held.id);
    } else {
      expect(first.attachmentState).toBe("pending");
      expect(first.pendingAttachmentIds).toContain(held.id);
    }
    if (second.outcome === "approved") {
      expect(second.attachmentState).toBe("attached");
      expect(second.attachedAttachmentIds).toContain(held.id);
    } else {
      expect(second.attachmentState).toBe("pending");
      expect(second.pendingAttachmentIds).toContain(held.id);
    }
    // Final durable state: exactly one document for the item.
    const itemDocuments = await getDb().select({ id: documents.id }).from(documents).where(eq(documents.itemId, first.itemId));
    expect(itemDocuments).toHaveLength(1);
    // The staged attachment is assigned to that document and is no longer transfer-claimed or purge-pending.
    const [attachment] = await getDb().select({ id: imapIngestionAttachments.id, assignedDocumentId: imapIngestionAttachments.assignedDocumentId, transferClaimToken: imapIngestionAttachments.transferClaimToken, purgePending: imapIngestionAttachments.purgePending }).from(imapIngestionAttachments).where(eq(imapIngestionAttachments.id, held.id));
    expect(attachment.assignedDocumentId).toBe(itemDocuments[0].id);
    expect(attachment.transferClaimToken).toBeNull();
    expect(attachment.purgePending).toBe(false);
    // The mailbox receipt records the same completed operation, result, and item without a failure.
    const [completedReceipt] = await getDb().select({ status: imapIngestionMessages.status, approvalOperationId: imapIngestionMessages.approvalOperationId, approvalResultId: imapIngestionMessages.approvalResultId, approvedItemId: imapIngestionMessages.approvedItemId, failureCode: imapIngestionMessages.failureCode }).from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receipt.id));
    expect(completedReceipt).toMatchObject({
      status: "completed",
      approvalOperationId: input.operationId,
      approvalResultId: first.approvalResultId,
      approvedItemId: first.itemId,
      failureCode: null,
    });
    // Exactly one reviewed-intake result audit exists and records the final approved outcome.
    const audits = await getDb().select({ id: auditLog.id, entityType: auditLog.entityType, entityId: auditLog.entityId, action: auditLog.action }).from(auditLog).where(and(eq(auditLog.entityType, "reviewed_intake"), eq(auditLog.entityId, first.approvalResultId)));
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("reviewed_intake_approved");
    // Note: caller-local partial_success is legitimate when the non-owning concurrent caller's
    // bounded wait (40 x 50 ms) for the attachment claimer expires before the owner completes,
    // but final durable partial state is not: once both calls settle, the attachment must be
    // assigned and no longer transfer-claimed or purge-pending, with exactly one audit recording approved.
    await fixture.cleanup();
  });

  it("replays a stored attachment against an already available stable document without duplicating it", async () => {
    const fixture = await createIntegrationFixture("reviewed-crash-replay");
    const targetItemId = randomUUID();
    await getDb().insert(items).values({ id: targetItemId, householdId: fixture.household.id, sectionId: fixture.section.id, title: "Crash replay target", currency: "GBP" });
    const bytes = syntheticPdf("stable crash replay");
    const receiptId = randomUUID();
    const held = await scanAndHoldImapAttachment({ bytes, filename: "crash-replay.pdf", declaredMediaType: "application/pdf", recipientUserId: fixture.users.member.id, receiptId });
    const available = await uploadItemDocument({
      userId: fixture.users.member.id, householdId: fixture.household.id, itemId: targetItemId,
      filename: "crash-replay.pdf", body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
      declaredBytes: bytes.length, documentId: held.id,
    });
    const [receipt] = await getDb().insert(imapIngestionMessages).values({
      id: receiptId,
      mailbox: "private", mailboxUidValidity: "crash", mailboxUid: 3, contentSha256: randomUUID().replaceAll("-", ""),
      recipientAliasSha256: "crash", userId: fixture.users.member.id, householdId: fixture.household.id,
      status: "pending_review", expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending",
    }).returning({ id: imapIngestionMessages.id });
    await getDb().insert(imapIngestionAttachments).values({ id: held.id, messageId: receipt.id, displayName: held.displayName, mediaType: held.mediaType, sizeBytes: held.sizeBytes, contentSha256: held.contentSha256, storageKey: held.storageKey, ciphertextSize: held.ciphertextSize, ...held.envelope, status: "stored" });
    const input = { operationId: randomUUID(), source: { kind: "mailbox_draft" as const, receiptId: receipt.id, draftVersion: 1 }, householdId: fixture.household.id, sectionId: fixture.section.id, action: "attach_existing" as const, targetItemId, item: { title: "Crash replay target", currency: "GBP", status: "active" }, attachmentIds: [held.id] };
    const result = await approveReviewedIntake(fixture.users.member.id, input);
    expect(result).toMatchObject({ outcome: "approved", itemId: targetItemId, attachedAttachmentIds: [held.id] });
    expect(available.id).toBe(held.id);
    expect(await getDb().select({ id: documents.id }).from(documents).where(eq(documents.id, held.id))).toHaveLength(1);
    await fixture.cleanup();
  });

  it("retries a purge failure after assignment without re-uploading the document", async () => {
    const fixture = await createIntegrationFixture("reviewed-purge-retry");
    const receiptId = randomUUID();
    const held = await scanAndHoldImapAttachment({ bytes: syntheticPdf("purge retry"), filename: "purge-retry.pdf", declaredMediaType: "application/pdf", recipientUserId: fixture.users.member.id, receiptId });
    const [receipt] = await getDb().insert(imapIngestionMessages).values({ id: receiptId, mailbox: "private", mailboxUidValidity: "purge", mailboxUid: 4, contentSha256: randomUUID().replaceAll("-", ""), recipientAliasSha256: "purge", userId: fixture.users.member.id, householdId: fixture.household.id, status: "pending_review", expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending" }).returning({ id: imapIngestionMessages.id });
    await getDb().insert(imapIngestionAttachments).values({ id: held.id, messageId: receipt.id, displayName: held.displayName, mediaType: held.mediaType, sizeBytes: held.sizeBytes, contentSha256: held.contentSha256, storageKey: held.storageKey, ciphertextSize: held.ciphertextSize, ...held.envelope, status: "stored" });
    const input = { operationId: randomUUID(), source: { kind: "mailbox_draft" as const, receiptId: receipt.id, draftVersion: 1 }, householdId: fixture.household.id, sectionId: fixture.section.id, action: "create_separate" as const, item: { title: "Purge retry value", currency: "GBP", status: "active" }, attachmentIds: [held.id] };
    let attempts = 0;
    setImapHoldingPurgeImplementationForTests(async (storageKey) => {
      attempts += 1;
      if (attempts === 1) {
        setImapHoldingPurgeImplementationForTests(undefined);
        throw new Error("synthetic purge failure");
      }
      await purgeHeldImapAttachment(storageKey);
    });
    try {
      const partial = await approveReviewedIntake(fixture.users.member.id, input);
      expect(partial).toMatchObject({ outcome: "partial_success", pendingAttachmentIds: [held.id] });
      const beforeRetry = await getDb().select({ id: documents.id }).from(documents).where(eq(documents.itemId, partial.itemId));
      const completed = await approveReviewedIntake(fixture.users.member.id, input);
      expect(completed).toMatchObject({ outcome: "approved", itemId: partial.itemId });
      expect(await getDb().select({ id: documents.id }).from(documents).where(eq(documents.itemId, partial.itemId))).toEqual(beforeRetry);
      expect((await getDb().select({ purgeAttempts: imapIngestionAttachments.purgeAttempts, purgePending: imapIngestionAttachments.purgePending }).from(imapIngestionAttachments).where(eq(imapIngestionAttachments.id, held.id)))[0]).toMatchObject({ purgeAttempts: 1, purgePending: false });
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });
});
