/**
 * #1398: approving a mailbox draft is all or nothing (stage every attachment,
 * scan again, then create the item and bind the documents in one transaction).
 * A failure leaves no item and no bound document, keeps the mail and its held
 * files in the inbox, and tells the member once by mail (the card) and push.
 *
 * Failure is injected the way reviewed-intake.test.ts does it: a spy on
 * LocalDocumentStorage.sealQuarantine. The scanner is the same
 * `scanFileWithClamAv` mock as imap-attachment-processing.test.ts.
 */
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { documents, imapIngestionAttachments, imapIngestionMessages, items, pushSubscriptions, userPreferences } from "@/db/schema";
import { readDocumentDownload } from "@/server/document-repository";
import { getDocumentConfig } from "@/server/documents/config";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { scanAndHoldImapAttachment } from "@/server/mail-in/imap-attachment-holding";
import { listImapInbox } from "@/server/mail-in/imap-inbox";
import { openMetadataReader } from "@/server/metadata/fields";
import { getNotificationWorkerConfig, runNotificationCycle, type PushNotification, type SmtpNotification } from "@/server/notification-worker";
import { approveReviewedIntake, canonicalReviewedIntakeHash } from "@/server/reviewed-intake";
import { cleanupIntegrationEnvironment, createIntegrationFixture, withRequiredScanMode, type IntegrationFixture } from "./support/fixtures";
import { syntheticPdf } from "../support/synthetic-documents";
import { visibleText } from "../support/mail-card";

vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(async () => ({ status: "clean" as const })),
}));

const scan = vi.mocked(scanFileWithClamAv);
const TITLE = "Held attachment value";
const HEADLINE = `Orbit could not add ${TITLE} — your mail is kept, try again`;
const SCANNER_AWAY = "not added — the virus scanner is away; your mail is kept, try again later.";

beforeEach(() => { scan.mockReset(); scan.mockResolvedValue({ status: "clean" }); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await cleanupIntegrationEnvironment(); });

async function seedMail(fixture: IntegrationFixture, labels: string[]) {
  const receiptId = randomUUID();
  await getDb().insert(imapIngestionMessages).values({
    id: receiptId, mailbox: "private", mailboxUidValidity: `aon-${receiptId.slice(0, 8)}`, mailboxUid: 1,
    contentSha256: randomUUID().replaceAll("-", ""), recipientAliasSha256: `aon-${receiptId.slice(0, 8)}`,
    userId: fixture.users.member.id, householdId: fixture.household.id, draftVersion: 1, status: "pending_review",
    expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending",
  });
  const attachments: Array<{ id: string; storageKey: string }> = [];
  for (const label of labels) {
    const held = await scanAndHoldImapAttachment({
      bytes: syntheticPdf(label), filename: `${label}.pdf`, declaredMediaType: "application/pdf",
      recipientUserId: fixture.users.member.id, receiptId,
    });
    await getDb().insert(imapIngestionAttachments).values({
      id: held.id, messageId: receiptId, displayName: held.displayName, mediaType: held.mediaType, sizeBytes: held.sizeBytes,
      contentSha256: held.contentSha256, storageKey: held.storageKey, ciphertextSize: held.ciphertextSize, ...held.envelope, status: "stored",
    });
    attachments.push({ id: held.id, storageKey: held.storageKey });
  }
  return { receiptId, attachments };
}

const requestFor = (fixture: IntegrationFixture, receiptId: string, attachmentIds: string[], operationId = randomUUID()) => ({
  operationId,
  source: { kind: "mailbox_draft" as const, receiptId, draftVersion: 1 },
  householdId: fixture.household.id,
  sectionId: fixture.section.id,
  action: "create_separate" as const,
  item: { title: TITLE, currency: "GBP", status: "active" as const },
  attachmentIds,
});

/** Runs the approval and returns what it gave back or threw, never rejecting. */
const attempt = (userId: string, input: ReturnType<typeof requestFor>) =>
  approveReviewedIntake(userId, input).then((result) => ({ result, error: undefined as unknown }), (error: unknown) => ({ result: undefined, error }));

const itemIds = async (fixture: IntegrationFixture) =>
  (await getDb().select({ id: items.id }).from(items).where(eq(items.householdId, fixture.household.id))).map((row) => row.id).sort();

/** Documents of the household that belong to an item (staged, unbound ones have none). */
const boundDocuments = async (fixture: IntegrationFixture) =>
  (await getDb().select({ id: documents.id, itemId: documents.itemId, sealedItemId: documents.sealedItemId }).from(documents)
    .where(eq(documents.householdId, fixture.household.id))).filter((row) => row.itemId !== null || row.sealedItemId !== null);

const receiptOf = async (receiptId: string) => (await getDb().select({
  status: imapIngestionMessages.status, failureCode: imapIngestionMessages.failureCode,
  approvalOperationId: imapIngestionMessages.approvalOperationId, approvedItemId: imapIngestionMessages.approvedItemId,
}).from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId)))[0]!;

const heldRows = async (receiptId: string) => (await getDb().select({
  id: imapIngestionAttachments.id, status: imapIngestionAttachments.status, assignedDocumentId: imapIngestionAttachments.assignedDocumentId,
}).from(imapIngestionAttachments).where(eq(imapIngestionAttachments.messageId, receiptId))).sort((a, b) => a.id.localeCompare(b.id));

async function expectHeldFileKept(storageKey: string) {
  await expect(access(join(getDocumentConfig().storageRoot, "objects", storageKey.slice(0, 2), storageKey.slice(2, 4), `${storageKey}.bin`))).resolves.toBeUndefined();
}

/** The second upload's ciphertext write fails; the first goes through. */
function failSecondUpload() {
  const original = LocalDocumentStorage.prototype.sealQuarantine;
  let calls = 0;
  return vi.spyOn(LocalDocumentStorage.prototype, "sealQuarantine").mockImplementation(function (this: LocalDocumentStorage, ...args: Parameters<typeof original>) {
    calls += 1;
    if (calls === 2) return Promise.reject(new Error("synthetic document store outage"));
    return original.apply(this, args);
  });
}

async function expectNothingChanged(fixture: IntegrationFixture, receiptId: string, held: Array<{ id: string; storageKey: string }>, before: { items: string[]; bound: number }) {
  expect(await itemIds(fixture), "no item exists").toEqual(before.items);
  expect(await boundDocuments(fixture), "no document is bound").toHaveLength(before.bound);
  expect(await receiptOf(receiptId)).toMatchObject({ status: "pending_review", failureCode: null, approvalOperationId: null, approvedItemId: null });
  expect(await heldRows(receiptId)).toEqual(held.map(({ id }) => ({ id, status: "stored", assignedDocumentId: null })).sort((a, b) => a.id.localeCompare(b.id)));
  for (const { storageKey } of held) await expectHeldFileKept(storageKey);
  const listed = (await listImapInbox(fixture.users.member.id)).receipts.find((row) => row.id === receiptId);
  expect(listed, "the mail is still in the inbox").toBeDefined();
}

describe("mail approval is all or nothing (#1398)", () => {
  it("a failing document store on the 2nd attachment leaves no item, the mail intact with its held files, still approvable", async () => {
    const fixture = await createIntegrationFixture("aon-store-failure");
    await withRequiredScanMode(async () => {
      const { receiptId, attachments } = await seedMail(fixture, ["aon-one", "aon-two"]);
      const before = { items: await itemIds(fixture), bound: (await boundDocuments(fixture)).length };
      failSecondUpload();

      const outcome = await attempt(fixture.users.member.id, requestFor(fixture, receiptId, attachments.map(({ id }) => id)));

      expect(outcome.error ?? outcome.result, "the approval did not report success").not.toMatchObject({ outcome: expect.stringMatching(/^(approved|partial_success)$/u) });
      await expectNothingChanged(fixture, receiptId, attachments, before);
    });
  }, 60_000);

  it("scanner unreachable at approval refuses up front with the member's wording and creates nothing", async () => {
    const fixture = await createIntegrationFixture("aon-scanner-away");
    await withRequiredScanMode(async () => {
      const { receiptId, attachments } = await seedMail(fixture, ["aon-away"]);
      const before = { items: await itemIds(fixture), bound: (await boundDocuments(fixture)).length };
      scan.mockClear();
      scan.mockResolvedValue({ status: "error", reason: "unavailable" });

      const outcome = await attempt(fixture.users.member.id, requestFor(fixture, receiptId, attachments.map(({ id }) => id)));

      expect(scan, "approval scanned the attachment again").toHaveBeenCalled();
      expect(outcome.error, "refused, not returned").toBeInstanceOf(Error);
      expect((outcome.error as Error).message).toBe(SCANNER_AWAY);
      await expectNothingChanged(fixture, receiptId, attachments, before);
    });
  }, 60_000);

  it("an attachment that now scans as infected refuses the approval and creates nothing", async () => {
    const fixture = await createIntegrationFixture("aon-infected");
    await withRequiredScanMode(async () => {
      const { receiptId, attachments } = await seedMail(fixture, ["aon-clean", "aon-now-infected"]);
      const before = { items: await itemIds(fixture), bound: (await boundDocuments(fixture)).length };
      scan.mockClear();
      scan.mockResolvedValue({ status: "infected", signature: "Synthetic.Test.Signature" });

      const outcome = await attempt(fixture.users.member.id, requestFor(fixture, receiptId, attachments.map(({ id }) => id)));

      expect(scan, "approval scanned the attachments again").toHaveBeenCalled();
      expect(outcome.error ?? outcome.result, "the approval did not report success").not.toMatchObject({ outcome: expect.stringMatching(/^(approved|partial_success)$/u) });
      expect(await itemIds(fixture), "no item exists").toEqual(before.items);
      expect(await boundDocuments(fixture), "no document is bound").toHaveLength(before.bound);
      expect(await receiptOf(receiptId)).toMatchObject({ approvedItemId: null });
      expect((await receiptOf(receiptId)).status).not.toMatch(/^(completed|recoverable)$/u);
    });
  }, 60_000);

  it("a second approval after a failure succeeds: exactly one item with every attachment bound", async () => {
    const fixture = await createIntegrationFixture("aon-second-approval");
    await withRequiredScanMode(async () => {
      const { receiptId, attachments } = await seedMail(fixture, ["aon-again-one", "aon-again-two"]);
      const ids = attachments.map(({ id }) => id);
      const before = await itemIds(fixture);
      const spy = failSecondUpload();
      expect((await attempt(fixture.users.member.id, requestFor(fixture, receiptId, ids))).result).toBeUndefined();
      spy.mockRestore();

      const second = await attempt(fixture.users.member.id, requestFor(fixture, receiptId, ids));

      expect(second.error).toBeUndefined();
      expect(second.result).toMatchObject({ outcome: "approved", attachmentState: "attached" });
      expect([...second.result!.attachedAttachmentIds].sort()).toEqual([...ids].sort());
      const after = await itemIds(fixture);
      expect(after).toHaveLength(before.length + 1);
      expect(after).toContain(second.result!.itemId);
      const rows = await heldRows(receiptId);
      expect(rows.every((row) => row.status === "assigned" && row.assignedDocumentId !== null)).toBe(true);
      for (const row of rows) {
        expect((await readDocumentDownload(fixture.users.member.id, row.assignedDocumentId!)).bytes.length).toBeGreaterThan(0);
      }
      expect(await receiptOf(receiptId)).toMatchObject({ status: "completed", approvedItemId: second.result!.itemId });
    });
  }, 60_000);

  describe("telling the member", () => {
    const cycleTime = new Date("2026-03-29T08:00:00.000Z");

    async function cycle(mail: SmtpNotification[], push: PushNotification[]) {
      await runNotificationCycle({
        ...getNotificationWorkerConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv),
        smtpUrl: "smtp://smtp.invalid.example:587", smtpSecurity: "starttls", smtpFrom: "Orbit <orbit@example.invalid>",
        vapidSubject: "mailto:orbit@example.invalid", vapidPublicKey: "test-vapid-public-key", vapidPrivateKey: "fake-vapid-key",
        pollMilliseconds: 60_000, maxAttempts: 3,
      }, {
        now: () => cycleTime,
        providers: { async sendEmail(n) { mail.push(n); }, async sendPush(n) { push.push(n); } },
      });
    }

    async function failedApproval(label: string, switches: { email: boolean; push: boolean }) {
      const fixture = await createIntegrationFixture(label);
      await getDb().update(userPreferences).set({ emailNotifications: switches.email, pushNotifications: switches.push })
        .where(eq(userPreferences.userId, fixture.users.member.id));
      await getDb().insert(pushSubscriptions).values({
        userId: fixture.users.member.id, endpoint: `https://push.invalid.example/${fixture.users.member.id}`, p256dh: "fixture-p256dh", auth: "fixture-auth",
      });
      const { receiptId, attachments } = await seedMail(fixture, ["aon-note-one", "aon-note-two"]);
      const input = requestFor(fixture, receiptId, attachments.map(({ id }) => id));
      const spy = failSecondUpload();
      await attempt(fixture.users.member.id, input);
      return { fixture, input, spy };
    }

    const told = (mail: SmtpNotification[], fixture: IntegrationFixture) =>
      mail.filter((m) => m.to === fixture.users.member.email && m.subject.startsWith("Orbit could not add"));
    const pushed = (push: PushNotification[]) =>
      push.filter((p) => `${p.payload.title} ${p.payload.body}`.includes(TITLE));

    it("sends one card mail and one web push, and no more on later cycles or on the sender's retry of the same request", async () => {
      await withRequiredScanMode(async () => {
        const { fixture, input } = await failedApproval("aon-notify-on", { email: true, push: true });
        const mail: SmtpNotification[] = [];
        const push: PushNotification[] = [];

        await cycle(mail, push);
        await cycle(mail, push);
        await attempt(fixture.users.member.id, input); // the sender retries the same request; the store still fails
        await cycle(mail, push);

        const sent = told(mail, fixture);
        expect(sent).toHaveLength(1);
        expect(sent[0]!.subject).toBe(HEADLINE);
        const html = sent[0]!.html ?? "";
        expect(visibleText(html)).toContain(HEADLINE);
        expect(html, "the ratified card, no images").not.toMatch(/<img|<svg|<link/iu);
        expect(pushed(push)).toHaveLength(1);
      });
    }, 60_000);

    it("sends neither when the member's switches are off", async () => {
      await withRequiredScanMode(async () => {
        const { fixture } = await failedApproval("aon-notify-off", { email: false, push: false });
        const mail: SmtpNotification[] = [];
        const push: PushNotification[] = [];

        await cycle(mail, push);

        expect(told(mail, fixture)).toHaveLength(0);
        expect(pushed(push)).toHaveLength(0);
      });
    }, 60_000);

    it("obeys each switch on its own: mail only when push is off", async () => {
      await withRequiredScanMode(async () => {
        const { fixture } = await failedApproval("aon-notify-mail-only", { email: true, push: false });
        const mail: SmtpNotification[] = [];
        const push: PushNotification[] = [];

        await cycle(mail, push);

        expect(told(mail, fixture)).toHaveLength(1);
        expect(pushed(push)).toHaveLength(0);
      });
    }, 60_000);
  });

  it("a receipt left recoverable before the upgrade still retries by today's path and finishes with one item", async () => {
    const fixture = await createIntegrationFixture("aon-legacy-recoverable");
    await withRequiredScanMode(async () => {
      const { receiptId, attachments } = await seedMail(fixture, ["aon-legacy"]);
      const input = requestFor(fixture, receiptId, attachments.map(({ id }) => id));
      // What the old code left behind: the item exists (its id is the operation id), the receipt is recoverable.
      await approveReviewedIntake(fixture.users.member.id, { ...input, source: { kind: "direct_upload" as const }, attachmentIds: [] });
      const [made] = await getDb().select({ id: items.id }).from(items).where(and(eq(items.householdId, fixture.household.id), eq(items.id, input.operationId)));
      expect(made, "the item the old code had already made").toBeDefined();
      const metadata = await openMetadataReader(fixture.household.id);
      expect(metadata).toBeDefined();
      await getDb().update(imapIngestionMessages).set({
        status: "recoverable", failureCode: "attachment_transfer_failed", approvalOperationId: input.operationId,
        approvalResultId: randomUUID(), approvalRequestSha256: canonicalReviewedIntakeHash(input), approvedItemId: input.operationId,
        approvalStartedAt: new Date(Date.now() - 60_000),
      }).where(eq(imapIngestionMessages.id, receiptId));
      const before = await itemIds(fixture);

      const retry = await attempt(fixture.users.member.id, input);

      expect(retry.error).toBeUndefined();
      expect(retry.result).toMatchObject({ outcome: "approved", itemId: input.operationId, attachmentState: "attached" });
      expect(await itemIds(fixture)).toEqual(before);
      expect(await receiptOf(receiptId)).toMatchObject({ status: "completed", approvedItemId: input.operationId });
      expect((await heldRows(receiptId))[0]).toMatchObject({ status: "assigned" });
    });
  }, 60_000);
});
