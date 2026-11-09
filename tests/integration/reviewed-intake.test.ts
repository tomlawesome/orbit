import { randomUUID } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { documents, imapIngestionAttachments, imapIngestionMessages, items } from "@/db/schema";
import { readDocumentDownload, uploadItemDocument } from "@/server/document-repository";
import { getDocumentConfig } from "@/server/documents/config";
import { DocumentIntegrityError } from "@/server/documents/crypto";
import { LocalDocumentStorage, openDocumentStorage } from "@/server/documents/storage";
import { scanAndHoldImapAttachment } from "@/server/mail-in/imap-attachment-holding";
import { approveReviewedIntake } from "@/server/reviewed-intake";
import { openMetadataReader } from "@/server/metadata/fields";
import { readUploadLimitSettings, setUploadLimit } from "@/server/upload-limit";
import { assignImapReceiptHousehold, listImapInbox } from "@/server/mail-in/imap-inbox";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";
import { paddedPdfOfSize } from "../support/large-pdf";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

const operation = (seed: string) => `${seed.slice(0, 8)}-1111-4111-8111-111111111111`;

describe("private reviewed intake approval boundary", () => {
  it("assigns a mailbox receipt without materializing any household item", async () => {
    const fixture = await createIntegrationFixture("reviewed-private-assignment");
    const member = await fixture.session("member");
    const [receipt] = await getDb().insert(imapIngestionMessages).values({
      mailbox: "private-test-mailbox",
      mailboxUidValidity: "private-test-validity",
      mailboxUid: 99,
      contentSha256: operation("aaaaaaaa"),
      recipientAliasSha256: operation("bbbbbbbb"),
      userId: member.userId,
      status: "pending_review",
      householdId: null,
      receiptStatus: "cancelled",
      expiresAt: new Date(Date.now() + 86_400_000),
    }).returning({ id: imapIngestionMessages.id });
    const before = await getDb().select({ id: items.id }).from(items).where(eq(items.householdId, fixture.household.id));

    await assignImapReceiptHousehold(member.userId, receipt.id, fixture.household.id);

    expect(await getDb().select({ id: items.id }).from(items).where(eq(items.householdId, fixture.household.id))).toEqual(before);
    const [stored] = await getDb().select({ householdId: imapIngestionMessages.householdId, reviewItemId: imapIngestionMessages.reviewItemId })
      .from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receipt.id));
    expect(stored).toEqual({ householdId: fixture.household.id, reviewItemId: null });
  });

  it("keeps drafts private and makes direct approval idempotent", async () => {
    const fixture = await createIntegrationFixture("reviewed-direct-approval");
    const member = await fixture.session("member");
    const outsider = await fixture.session("outsider");
    const before = await getDb().select({ id: items.id }).from(items).where(eq(items.householdId, fixture.household.id));
    const input = {
      operationId: operation("cccccccc"),
      source: { kind: "direct_upload" as const },
      householdId: fixture.household.id,
      sectionId: fixture.section.id,
      action: "create_separate" as const,
      item: { title: "Exact reviewed value", provider: "Reviewed provider", currency: "GBP", status: "active" as const },
      attachmentIds: [],
    };

    // T-Q6 (#1151): this used to check outsider's inbox before anything had
    // ever been written for anyone, so it was empty regardless of whether
    // listImapInbox actually scopes by user -- it could never have caught a
    // leak. Give member a real receipt first, so an outsider seeing it would
    // be a genuine privacy failure, not a trivial pass.
    const [memberReceipt] = await getDb().insert(imapIngestionMessages).values({
      mailbox: "reviewed-intake-privacy-check",
      mailboxUidValidity: "reviewed-intake-privacy-check",
      mailboxUid: 1,
      contentSha256: operation("eeeeeeee"),
      recipientAliasSha256: operation("ffffffff"),
      userId: member.userId,
      status: "pending_review",
      householdId: null,
      receiptStatus: "cancelled",
      expiresAt: new Date(Date.now() + 86_400_000),
    }).returning({ id: imapIngestionMessages.id });
    expect((await listImapInbox(member.userId)).receipts.map((r) => r.id)).toContain(memberReceipt.id);
    expect((await listImapInbox(outsider.userId)).receipts).toHaveLength(0);
    const first = await approveReviewedIntake(member.userId, input);
    const second = await approveReviewedIntake(member.userId, input);
    expect(second.itemId).toBe(first.itemId);
    expect(await getDb().select({ id: items.id }).from(items).where(eq(items.householdId, fixture.household.id))).toHaveLength(before.length + 1);
    // Title and provider are Tier 2 ciphertext since #963, so the row holds
    // envelopes; the assertion is the same one, made on the decrypted values.
    const [created] = await getDb().select({ id: items.id, titleEnc: items.titleEnc, providerEnc: items.providerEnc })
      .from(items).where(eq(items.id, first.itemId));
    const metadata = await openMetadataReader(fixture.household.id);
    expect({
      title: metadata.text("items.title", created.id, { encrypted: created.titleEnc }).value,
      provider: metadata.text("items.provider", created.id, { encrypted: created.providerEnc }).value,
    }).toEqual({ title: "Exact reviewed value", provider: "Reviewed provider" });
  });

  it("does not apply submitted fields when attaching to an existing item", async () => {
    const fixture = await createIntegrationFixture("reviewed-attach-existing");
    const member = await fixture.session("member");
    const before = await getDb().select({ titleEnc: items.titleEnc, providerEnc: items.providerEnc, referenceEnc: items.referenceEnc, sectionId: items.sectionId })
      .from(items).where(and(eq(items.id, fixture.item.id), eq(items.householdId, fixture.household.id)));

    await approveReviewedIntake(member.userId, {
      operationId: operation("dddddddd"),
      source: { kind: "direct_upload" },
      householdId: fixture.household.id,
      sectionId: fixture.section.id,
      action: "attach_existing",
      targetItemId: fixture.item.id,
      item: { title: "Must not overwrite", provider: "Must not overwrite", currency: "GBP", status: "active" },
      attachmentIds: [],
    });

    expect(await getDb().select({ titleEnc: items.titleEnc, providerEnc: items.providerEnc, referenceEnc: items.referenceEnc, sectionId: items.sectionId })
      .from(items).where(eq(items.id, fixture.item.id))).toEqual(before);
  });
});

/**
 * #1571 lane 3: approving a mailbox draft decrypts the held attachment into a
 * `.recovery` quarantine file, verifies its tag, streams the file into the
 * upload and discards it, whatever the outcome.
 */
describe("approving a mailbox draft with a held attachment reads it through a verified quarantine file (#1571)", () => {
  const MIB = 1_048_576;

  async function seedHeldDraft(fixture: IntegrationFixture, bytes: Buffer, maxBytes?: number) {
    const receiptId = randomUUID();
    const held = await scanAndHoldImapAttachment({
      bytes,
      filename: "held-policy.pdf",
      declaredMediaType: "application/pdf",
      recipientUserId: fixture.users.member.id,
      receiptId,
      ...(maxBytes === undefined ? {} : { maxBytes }),
    });
    await getDb().insert(imapIngestionMessages).values({
      id: receiptId, mailbox: "private", mailboxUidValidity: `held-${receiptId.slice(0, 8)}`, mailboxUid: 1, contentSha256: randomUUID().replaceAll("-", ""),
      recipientAliasSha256: `held-${receiptId.slice(0, 8)}`, userId: fixture.users.member.id, householdId: fixture.household.id,
      status: "pending_review", expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending",
    });
    await getDb().insert(imapIngestionAttachments).values({
      id: held.id, messageId: receiptId, displayName: held.displayName, mediaType: held.mediaType, sizeBytes: held.sizeBytes,
      contentSha256: held.contentSha256, storageKey: held.storageKey, ciphertextSize: held.ciphertextSize, ...held.envelope, status: "stored",
    });
    const input = {
      operationId: randomUUID(),
      source: { kind: "mailbox_draft" as const, receiptId, draftVersion: 1 },
      householdId: fixture.household.id,
      sectionId: fixture.section.id,
      action: "create_separate" as const,
      item: { title: "Held attachment value", currency: "GBP", status: "active" },
      attachmentIds: [held.id],
    };
    return { held, input };
  }

  function bodyOf(bytes: Buffer): ReadableStream<Uint8Array> {
    let at = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= bytes.length) return controller.close();
        controller.enqueue(new Uint8Array(bytes.subarray(at, Math.min(at + MIB, bytes.length))));
        at += MIB;
      },
    });
  }

  async function recoveryFilesOf(attachmentId: string): Promise<string[]> {
    return (await openDocumentStorage().listQuarantineFiles()).map((file) => basename(file.path))
      .filter((name) => name.startsWith(`${attachmentId}.`) && name.endsWith(".recovery"));
  }

  async function expectGone(path: string): Promise<void> {
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  }

  const stagedRow = async (attachmentId: string) => (await getDb().select({ status: imapIngestionAttachments.status, assignedDocumentId: imapIngestionAttachments.assignedDocumentId })
    .from(imapIngestionAttachments).where(eq(imapIngestionAttachments.id, attachmentId)))[0]!;

  it("attaches a multi-piece PDF byte for byte, and the .recovery file is gone afterwards", async () => {
    const fixture = await createIntegrationFixture("reviewed-held-attach");
    const bytes = paddedPdfOfSize(2 * MIB + 5);
    const { held, input } = await seedHeldDraft(fixture, bytes);
    const unseal = vi.spyOn(LocalDocumentStorage.prototype, "unsealToQuarantine");
    try {
      const result = await approveReviewedIntake(fixture.users.member.id, input);

      expect(result.outcome).toBe("approved");
      expect(result.attachedAttachmentIds).toContain(held.id);
      const documentId = (await stagedRow(held.id)).assignedDocumentId!;
      expect((await readDocumentDownload(fixture.users.member.id, documentId)).bytes.equals(bytes)).toBe(true);
      expect(unseal).toHaveBeenCalledTimes(1);
      expect(unseal.mock.calls[0]![0]).toEqual({ kind: "object", storageKey: held.storageKey });
      const { quarantinePath } = await unseal.mock.results[0]!.value as { quarantinePath: string };
      expect(quarantinePath).toMatch(/\.recovery$/u);
      await expectGone(quarantinePath);
      expect(await recoveryFilesOf(held.id)).toEqual([]);
    } finally {
      unseal.mockRestore();
    }
  }, 60_000);

  /** Sets the administrator's upload limit, returning a restore for `finally`. */
  async function withUploadLimit(fixture: IntegrationFixture, bytes: number): Promise<() => Promise<void>> {
    const admin = fixture.users.admin.id;
    const before = await readUploadLimitSettings(admin);
    const lowered = await setUploadLimit(admin, before.version, bytes);
    return async () => { await setUploadLimit(admin, lowered.version, before.overrideBytes); };
  }

  it("#1784 A-F6/A-F8: files a held attachment the mail limit accepted, though it is larger than the upload limit", async () => {
    const fixture = await createIntegrationFixture("reviewed-held-over-upload-limit");
    const { held, input } = await seedHeldDraft(fixture, paddedPdfOfSize(2 * MIB + 5), 25 * MIB);
    const restore = await withUploadLimit(fixture, MIB);
    try {
      const result = await approveReviewedIntake(fixture.users.member.id, input);

      expect(result).toMatchObject({ outcome: "approved", attachmentState: "attached" });
      const row = await stagedRow(held.id);
      expect(row.status).toBe("assigned");
      expect(row.assignedDocumentId).toBeTruthy();
      const [document] = await getDb().select({ sizeBytes: documents.sizeBytes }).from(documents).where(eq(documents.id, row.assignedDocumentId!));
      expect(document!.sizeBytes).toBe(held.sizeBytes);
    } finally {
      await restore();
    }
  }, 60_000);

  it("#1784: a browser upload without maxBytes still obeys the administrator's upload limit", async () => {
    const fixture = await createIntegrationFixture("reviewed-upload-limit-kept");
    const bytes = paddedPdfOfSize(2 * MIB);
    const restore = await withUploadLimit(fixture, MIB);
    try {
      await expect(uploadItemDocument({
        userId: fixture.users.member.id,
        householdId: fixture.household.id,
        itemId: fixture.item.id,
        filename: "policy.pdf",
        body: bodyOf(bytes),
        declaredBytes: bytes.length,
      })).rejects.toMatchObject({ code: "document_too_large", status: 413 });
    } finally {
      await restore();
    }
  }, 60_000);

  it("#1784: maxBytes replaces the upload limit, not the size guard: a body longer than it is refused", async () => {
    const fixture = await createIntegrationFixture("reviewed-max-bytes-guard");
    const bound = MIB + 5;
    const bytes = paddedPdfOfSize(bound + 1);
    await expect(uploadItemDocument({
      userId: fixture.users.member.id,
      householdId: fixture.household.id,
      itemId: fixture.item.id,
      filename: "policy.pdf",
      body: bodyOf(bytes),
      declaredBytes: bound,
      maxBytes: bound,
    })).rejects.toMatchObject({ code: "document_too_large", status: 413 });
  }, 60_000);

  it("removes the .recovery file when the upload fails after it was written", async () => {
    const fixture = await createIntegrationFixture("reviewed-held-forced-failure");
    const { held, input } = await seedHeldDraft(fixture, paddedPdfOfSize(MIB + 5));
    const unseal = vi.spyOn(LocalDocumentStorage.prototype, "unsealToQuarantine");
    const seal = vi.spyOn(LocalDocumentStorage.prototype, "sealQuarantine").mockRejectedValueOnce(new Error("synthetic ciphertext write outage"));
    try {
      await approveReviewedIntake(fixture.users.member.id, input).then(() => undefined, () => undefined);

      expect(seal).toHaveBeenCalledTimes(1);
      expect(unseal).toHaveBeenCalledTimes(1);
      const { quarantinePath } = await unseal.mock.results[0]!.value as { quarantinePath: string };
      await expectGone(quarantinePath);
      expect(await recoveryFilesOf(held.id)).toEqual([]);
      expect((await stagedRow(held.id)).status).toBe("stored");
    } finally {
      seal.mockRestore();
      unseal.mockRestore();
    }
  }, 60_000);

  it.each([["first byte", 3], ["last byte", "last"]] as const)("fails the approval of a tampered held object (%s), leaves the attachment stored, uploads nothing and leaves no .recovery file", async (_label, position) => {
    const fixture = await createIntegrationFixture("reviewed-held-tampered");
    const { held, input } = await seedHeldDraft(fixture, paddedPdfOfSize(MIB + 5));
    const key = held.storageKey;
    const path = join(getDocumentConfig().storageRoot, "objects", key.slice(0, 2), key.slice(2, 4), `${key}.bin`);
    const object = await readFile(path);
    object[position === "last" ? object.length - 1 : position] ^= 0xff;
    await writeFile(path, object);
    const before = await getDb().select({ id: documents.id }).from(documents).where(eq(documents.householdId, fixture.household.id));
    const unseal = vi.spyOn(LocalDocumentStorage.prototype, "unsealToQuarantine");
    const seal = vi.spyOn(LocalDocumentStorage.prototype, "sealQuarantine");
    try {
      const outcome = await approveReviewedIntake(fixture.users.member.id, input).then((result) => result, (error: unknown) => error);

      if (!(outcome instanceof Error)) expect((outcome as { outcome: string }).outcome).not.toBe("approved");
      expect(unseal).toHaveBeenCalledTimes(1);
      await expect(unseal.mock.results[0]!.value).rejects.toBeInstanceOf(DocumentIntegrityError);
      expect(seal, "nothing was uploaded").not.toHaveBeenCalled();
      expect(await getDb().select({ id: documents.id }).from(documents).where(eq(documents.householdId, fixture.household.id))).toEqual(before);
      expect(await stagedRow(held.id)).toEqual({ status: "stored", assignedDocumentId: null });
      expect(await recoveryFilesOf(held.id)).toEqual([]);
    } finally {
      seal.mockRestore();
      unseal.mockRestore();
    }
  }, 60_000);
});
