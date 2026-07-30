import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GET as getReceipt } from "@/app/api/imap-inbox/[receiptId]/route";
import { GET as getInbox } from "@/app/api/imap-inbox/route";
import { getDb } from "@/db";
import { imapIngestionAttachments, imapIngestionMessages, items } from "@/db/schema";
import { eq } from "drizzle-orm";
import { discardImapReviewItem, getImapReview, listImapInbox } from "@/server/imap-inbox";
import { scanAndHoldImapAttachment, setImapHoldingPurgeImplementationForTests } from "@/server/imap-attachment-holding";
import { approveReviewedIntake } from "@/server/reviewed-intake";
import { requestHouseholdDeletion } from "@/server/household-lifecycle";
import { requestForSession, requestWithoutSession, createIntegrationFixture } from "./support/fixtures";

describe("authenticated mailbox review read boundary", () => {
  it("does not disclose a receipt to signed-out or cross-user callers", async () => {
    const fixture = await createIntegrationFixture("imap-review-route-auth");
    const member = await fixture.session("member");
    const outsider = await fixture.session("outsider");
    const [receipt] = await getDb().insert(imapIngestionMessages).values({
      mailbox: "private", mailboxUidValidity: "review", mailboxUid: 101,
      contentSha256: crypto.randomUUID().replaceAll("-", ""), recipientAliasSha256: "review-alias",
      userId: member.userId, status: "pending_review", householdId: fixture.household.id,
      proposal: { title: "Private proposal", provider: "Private provider" },
      expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending",
    }).returning({ id: imapIngestionMessages.id });
    await getDb().insert(imapIngestionAttachments).values({
      messageId: receipt.id, displayName: "private.pdf", mediaType: "application/pdf", sizeBytes: 12,
      contentSha256: crypto.randomUUID().replaceAll("-", ""), storageKey: `review/${crypto.randomUUID()}`,
      ciphertextSize: 20, envelopeVersion: 1, contentIv: "iv", contentAuthTag: "tag", wrappedDek: "dek",
      wrapIv: "wrap-iv", wrapAuthTag: "wrap-tag", keyId: "key", status: "stored",
    });
    const url = "http://127.0.0.1:3000/api/imap-inbox";
    expect((await getInbox(requestWithoutSession(url))).status).toBe(401);
    const memberInbox = await getInbox(requestForSession(member, url));
    expect((await memberInbox.json()).receipts).toHaveLength(1);
    const peerInbox = await getInbox(requestForSession(await fixture.session("owner"), url));
    expect((await peerInbox.json()).receipts).toHaveLength(0);
    const adminInbox = await getInbox(requestForSession(await fixture.session("admin"), url));
    expect((await adminInbox.json()).receipts).toHaveLength(0);
    const disabled = await fixture.session("disabled");
    await fixture.disableUser("disabled");
    expect((await getInbox(requestForSession(disabled, url))).status).toBe(401);
    const hidden = await getReceipt(
      requestForSession(outsider, `${url}/${receipt.id}?householdId=${fixture.household.id}`),
      { params: Promise.resolve({ receiptId: receipt.id }) },
    );
    expect(hidden.status).toBe(404);
    await fixture.cleanup();
  });

  it("requires a selected household and redacts mail and storage metadata", async () => {
    const fixture = await createIntegrationFixture("imap-review-route-safe");
    const member = await fixture.session("member");
    await getDb().update(items).set({ provider: "Shared provider" }).where(eq(items.id, fixture.secondItem.id));
    const [selectedCandidate] = await getDb().insert(items).values({
      householdId: fixture.household.id, sectionId: fixture.section.id, title: "Other household record", provider: "Shared provider", currency: "GBP",
    }).returning({ id: items.id });
    const [receipt] = await getDb().insert(imapIngestionMessages).values({
      mailbox: "private", mailboxUidValidity: "safe", mailboxUid: 102,
      contentSha256: crypto.randomUUID().replaceAll("-", ""), recipientAliasSha256: "safe-alias",
      userId: member.userId, status: "pending_review", householdId: fixture.household.id,
      proposal: { title: "Safe title", provider: "Shared provider", sender: "must-not-appear", filename: "must-not-appear.pdf" },
      fieldEvidence: { title: { source: "parser", confidence: "medium" } },
      expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending",
    }).returning({ id: imapIngestionMessages.id });
    const firstAttachmentId = randomUUID();
    const secondAttachmentId = randomUUID();
    await getDb().insert(imapIngestionAttachments).values([
      {
        id: firstAttachmentId, messageId: receipt.id, displayName: "first.pdf", mediaType: "application/pdf", sizeBytes: 12,
        contentSha256: randomUUID().replaceAll("-", ""), storageKey: `review/${randomUUID()}`, ciphertextSize: 20, envelopeVersion: 1,
        contentIv: "iv", contentAuthTag: "tag", wrappedDek: "dek", wrapIv: "wrap-iv", wrapAuthTag: "wrap-tag", keyId: "key", status: "stored",
        createdAt: new Date("2030-01-02T00:00:02.000Z"),
      },
      {
        id: secondAttachmentId, messageId: receipt.id, displayName: "second.pdf", mediaType: "application/pdf", sizeBytes: 13,
        contentSha256: randomUUID().replaceAll("-", ""), storageKey: `review/${randomUUID()}`, ciphertextSize: 21, envelopeVersion: 1,
        contentIv: "iv", contentAuthTag: "tag", wrappedDek: "dek", wrapIv: "wrap-iv", wrapAuthTag: "wrap-tag", keyId: "key", status: "stored",
        createdAt: new Date("2030-01-01T00:00:01.000Z"),
      },
    ]);
    const response = await getReceipt(
      requestForSession(member, `http://127.0.0.1:3000/api/imap-inbox/${receipt.id}?householdId=${fixture.household.id}`),
      { params: Promise.resolve({ receiptId: receipt.id }) },
    );
    expect(response.status).toBe(200);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload).toMatchObject({ receipt: { id: receipt.id }, sections: expect.any(Array), candidates: expect.any(Array) });
    expect(payload.candidates).toEqual([{ itemId: selectedCandidate.id, title: "Other household record", reason: "matching provider" }]);
    expect(payload.attachments).toEqual([
      { id: secondAttachmentId, ordinal: 1, mediaType: "application/pdf", sizeBytes: 13 },
      { id: firstAttachmentId, ordinal: 2, mediaType: "application/pdf", sizeBytes: 12 },
    ]);
    expect(JSON.stringify(payload)).not.toContain("must-not-appear");
    expect(JSON.stringify(payload)).not.toContain("storageKey");
    expect(JSON.stringify(payload)).not.toContain("contentSha256");
    await fixture.removeMember();
    expect((await listImapInbox(member.userId)).receipts).toHaveLength(0);
    await fixture.cleanup();
  });

  it("conceals assigned receipts and household choices scheduled for deletion", async () => {
    const fixture = await createIntegrationFixture("imap-review-deletion-boundary");
    try {
      const member = await fixture.session("member");
      await getDb().insert(imapIngestionMessages).values({
        mailbox: "private", mailboxUidValidity: "deletion", mailboxUid: 103,
        contentSha256: randomUUID().replaceAll("-", ""), recipientAliasSha256: "deletion-alias",
        userId: member.userId, status: "pending_review", householdId: fixture.household.id,
        proposal: { title: "Scheduled household receipt" }, expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending",
      });
      await requestHouseholdDeletion(fixture.users.owner.id, fixture.household.id, fixture.household.name);
      const inbox = await listImapInbox(member.userId);
      expect(inbox.households).toEqual([]);
      expect(inbox.receipts).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not present a failed discard cleanup as an approval retry", async () => {
    const fixture = await createIntegrationFixture("imap-review-discard-boundary");
    const receiptId = randomUUID();
    const held = await scanAndHoldImapAttachment({
      bytes: Buffer.from("%PDF-1.7\n1 0 obj\nendobj\ndiscard boundary\n%%EOF"),
      filename: "discard-boundary.pdf",
      declaredMediaType: "application/pdf",
      recipientUserId: fixture.users.member.id,
      receiptId,
    });
    try {
      await getDb().insert(imapIngestionMessages).values({
        id: receiptId, mailbox: "private", mailboxUidValidity: "discard-boundary", mailboxUid: 104,
        contentSha256: randomUUID().replaceAll("-", ""), recipientAliasSha256: "discard-boundary",
        userId: fixture.users.member.id, householdId: fixture.household.id, status: "pending_review",
        expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending",
      });
      await getDb().insert(imapIngestionAttachments).values({
        id: held.id, messageId: receiptId, displayName: held.displayName, mediaType: held.mediaType, sizeBytes: held.sizeBytes,
        contentSha256: held.contentSha256, storageKey: held.storageKey, ciphertextSize: held.ciphertextSize, ...held.envelope, status: "stored",
      });
      setImapHoldingPurgeImplementationForTests(async () => { throw new Error("synthetic discard purge failure"); });
      await expect(discardImapReviewItem(fixture.users.member.id, receiptId)).rejects.toMatchObject({ code: "staging_purge_failed" });
      expect((await getDb().select({
        status: imapIngestionMessages.status,
        failureCode: imapIngestionMessages.failureCode,
        approvalOperationId: imapIngestionMessages.approvalOperationId,
        approvedItemId: imapIngestionMessages.approvedItemId,
      }).from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId)))[0]).toMatchObject({
        status: "recoverable", failureCode: "discard_purge_failed", approvalOperationId: null, approvedItemId: null,
      });
      expect((await listImapInbox(fixture.users.member.id)).receipts[0]).toMatchObject({ classification: "retry", canApprove: false, canDiscard: true });
      await expect(getImapReview(fixture.users.member.id, receiptId, fixture.household.id)).resolves.toMatchObject({ receipt: { canApprove: false } });
      await expect(approveReviewedIntake(fixture.users.member.id, {
        operationId: randomUUID(),
        source: { kind: "mailbox_draft", receiptId, draftVersion: 1 },
        householdId: fixture.household.id,
        sectionId: fixture.section.id,
        action: "create_separate",
        item: { title: "Must remain private", currency: "GBP", status: "active" },
        attachmentIds: [],
      })).rejects.toMatchObject({ code: "reviewed_intake_not_approvable" });
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });
});
