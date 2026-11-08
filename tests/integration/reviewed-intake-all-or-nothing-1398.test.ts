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
import { auditLog, documents, imapIngestionAttachments, imapIngestionMessages, items, pushSubscriptions, userPreferences, users } from "@/db/schema";
import { queueApprovalNotice, APPROVAL_NOTICE_ENTITY } from "@/server/mail-in/approval-notice";
import { uploadItemDocument } from "@/server/document-repository";
import { setImapHoldingPurgeImplementationForTests } from "@/server/mail-in/imap-attachment-holding";
import { requireReceiptMetadataWriter } from "@/server/metadata/fields";
import { sql } from "drizzle-orm";
import { readDocumentDownload } from "@/server/document-repository";
import { getDocumentConfig } from "@/server/documents/config";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { scanAndHoldImapAttachment } from "@/server/mail-in/imap-attachment-holding";
import { listImapInbox, discardImapReviewItem, purgeExpiredImapStaging } from "@/server/mail-in/imap-inbox";
import { resetDocumentConfigForTests } from "@/server/documents/config";
import { getDocumentHealth } from "@/server/document-health";
import { openMetadataReader } from "@/server/metadata/fields";
import { getNotificationWorkerConfig, runNotificationCycle, type PushNotification, type SmtpNotification } from "@/server/notification-worker";
import { approveReviewedIntake, canonicalReviewedIntakeHash } from "@/server/reviewed-intake";
import { cleanupIntegrationEnvironment, createIntegrationFixture, withRequiredScanMode, type IntegrationFixture } from "./support/fixtures";
import { syntheticPdf } from "../support/synthetic-documents";
import { visibleText } from "../support/mail-card";

/** Faults the review-findings tests switch on; off unless a test sets them. */
const faults = vi.hoisted(() => ({ throwAfterBind: false, throwBeforeBind: false, readsBroken: false }));

vi.mock("@/server/workspace-repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/workspace-repository")>();
  return {
    ...actual,
    applyWorkspaceCommand: async (...args: Parameters<typeof actual.applyWorkspaceCommand>) => {
      if (faults.throwBeforeBind) {
        // The bind rolls back (nothing commits), and the check that would tell is broken too.
        faults.throwBeforeBind = false;
        faults.readsBroken = true;
        throw new Error("synthetic failure before the bind committed");
      }
      const result = await actual.applyWorkspaceCommand(...args);
      if (faults.throwAfterBind) {
        // The command committed; what the caller then sees is a failure, and so are its reads after it.
        faults.throwAfterBind = false;
        faults.readsBroken = true;
        throw new Error("synthetic failure after the bind committed");
      }
      return result;
    },
  };
});

vi.mock("@/server/metadata/fields", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/metadata/fields")>();
  return {
    ...actual,
    openMetadataReader: async (...args: Parameters<typeof actual.openMetadataReader>) => {
      if (faults.readsBroken) throw new Error("synthetic read failure");
      return actual.openMetadataReader(...args);
    },
  };
});

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
  const attachments: Array<{ id: string; storageKey: string; bytes: Uint8Array }> = [];
  for (const label of labels) {
    const bytes = syntheticPdf(label);
    const held = await scanAndHoldImapAttachment({
      bytes, filename: `${label}.pdf`, declaredMediaType: "application/pdf",
      recipientUserId: fixture.users.member.id, receiptId,
    });
    await getDb().insert(imapIngestionAttachments).values({
      id: held.id, messageId: receiptId, displayName: held.displayName, mediaType: held.mediaType, sizeBytes: held.sizeBytes,
      contentSha256: held.contentSha256, storageKey: held.storageKey, ciphertextSize: held.ciphertextSize, ...held.envelope, status: "stored",
    });
    attachments.push({ id: held.id, storageKey: held.storageKey, bytes });
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

/* ---- Review findings on #1398 ---- */

describe("review findings on mail approval (#1398)", () => {
  const cycleTime = new Date("2026-03-29T08:00:00.000Z");
  const workerConfig = () => ({
    ...getNotificationWorkerConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv),
    smtpUrl: "smtp://smtp.invalid.example:587", smtpSecurity: "starttls" as const, smtpFrom: "Orbit <orbit@example.invalid>",
    vapidSubject: "mailto:orbit@example.invalid", vapidPublicKey: "test-vapid-public-key", vapidPrivateKey: "fake-vapid-key",
    pollMilliseconds: 60_000, maxAttempts: 3,
  });
  const runCycle = (providers: { sendEmail(n: SmtpNotification): Promise<void>; sendPush(n: PushNotification): Promise<void> }) =>
    runNotificationCycle(workerConfig(), { now: () => cycleTime, providers });

  /** A pending_review receipt with a queued "could not add" notice, as a failed approval leaves it. */
  async function queuedNotice(fixture: IntegrationFixture, title: string) {
    const receiptId = randomUUID();
    await getDb().insert(imapIngestionMessages).values({
      id: receiptId, mailbox: "private", mailboxUidValidity: `nt-${receiptId.slice(0, 8)}`, mailboxUid: 1,
      contentSha256: randomUUID().replaceAll("-", ""), recipientAliasSha256: `nt-${receiptId.slice(0, 8)}`,
      userId: fixture.users.member.id, householdId: fixture.household.id, draftVersion: 1, status: "pending_review",
      expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending",
    });
    const operationId = randomUUID();
    const cipher = await requireReceiptMetadataWriter(fixture.household.id);
    await queueApprovalNotice(getDb(), cipher, {
      operationId, userId: fixture.users.member.id, householdId: fixture.household.id, receiptId, title, reason: "approval_failed",
    });
    return { receiptId, operationId };
  }
  const noticeRow = async (receiptId: string) => (await getDb().select({ id: auditLog.id, changes: auditLog.changes }).from(auditLog)
    .where(and(eq(auditLog.entityType, APPROVAL_NOTICE_ENTITY), eq(auditLog.entityId, receiptId))))[0]!;

  it("notice starvation: more than 25 notices that can never send do not block a newer deliverable one; they reach a final state", async () => {
    const stuck = await createIntegrationFixture("aon-starve-stuck");
    const good = await createIntegrationFixture("aon-starve-good");
    for (const fixture of [stuck, good]) {
      await getDb().update(userPreferences).set({ emailNotifications: true, pushNotifications: false }).where(eq(userPreferences.userId, fixture.users.member.id));
    }
    await getDb().update(users).set({ emailEnc: "unreadable-ciphertext" }).where(eq(users.id, stuck.users.member.id));
    const stuckReceipts: string[] = [];
    for (let index = 0; index < 26; index += 1) stuckReceipts.push((await queuedNotice(stuck, `Stuck ${index}`)).receiptId);
    const { receiptId: goodReceipt } = await queuedNotice(good, "Deliverable newer notice");
    const mail: SmtpNotification[] = [];
    const providers = { async sendEmail(n: SmtpNotification) { mail.push(n); }, async sendPush() {} };

    await runCycle(providers);
    await runCycle(providers);

    expect(mail.filter((m) => m.to === good.users.member.email), "the newer deliverable notice was sent").toHaveLength(1);
    expect(mail.filter((m) => m.to === stuck.users.member.email)).toHaveLength(0);
    // Undeliverable notices end rather than being picked first, forever.
    for (let index = 0; index < 4; index += 1) await runCycle(providers);
    for (const receiptId of stuckReceipts) {
      const changes = (await noticeRow(receiptId)).changes as { email: string };
      expect(changes.email, "an unsendable notice is finalised").not.toBe("pending");
    }
    expect(((await noticeRow(goodReceipt)).changes as { email: string }).email).toBe("sent");
  }, 120_000);

  // "completed" is covered by the real-path test below (a member's own successful retry).
  it.each(["discarded", "expired"] as const)("a notice whose receipt is %s through the real path sends nothing and is finalised with its title cleared", async (status) => {
    const fixture = await createIntegrationFixture(`aon-notice-gone-${status}`);
    await getDb().insert(pushSubscriptions).values({
      userId: fixture.users.member.id, endpoint: `https://push.invalid.example/${fixture.users.member.id}`, p256dh: "fixture-p256dh", auth: "fixture-auth",
    });
    const { receiptId } = await queuedNotice(fixture, "Title that must not be sent");
    if (status === "discarded") {
      await discardImapReviewItem(fixture.users.member.id, receiptId);
    } else {
      await getDb().update(imapIngestionMessages).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(imapIngestionMessages.id, receiptId));
      await attempt(fixture.users.member.id, requestFor(fixture, receiptId, []));
    }
    expect((await receiptOf(receiptId)).status).toBe(status);
    const mail: SmtpNotification[] = [];
    const push: PushNotification[] = [];

    await runCycle({ async sendEmail(n) { mail.push(n); }, async sendPush(n) { push.push(n); } });

    expect(mail.filter((m) => m.to === fixture.users.member.email)).toHaveLength(0);
    expect(push.filter((p) => `${p.payload.title} ${p.payload.body}`.includes("Title that must not be sent"))).toHaveLength(0);
    const changes = (await noticeRow(receiptId)).changes as { email: string; push: string; titleEnc: string | null };
    expect(changes.email).not.toMatch(/^(pending|sending)$/u);
    expect(changes.push).not.toMatch(/^(pending|sending)$/u);
    expect(changes.titleEnc, "the encrypted title is cleared").toBeNull();
  }, 60_000);

  it("a member's own successful retry after a failure sends no notice and finalises it", async () => {
    await withRequiredScanMode(async () => {
      const fixture = await createIntegrationFixture("aon-notice-retried");
      const { receiptId, attachments } = await seedMail(fixture, ["aon-r1", "aon-r2"]);
      const input = requestFor(fixture, receiptId, attachments.map(({ id }) => id));
      const spy = failSecondUpload();
      await attempt(fixture.users.member.id, input);
      spy.mockRestore();
      const retry = await attempt(fixture.users.member.id, requestFor(fixture, receiptId, attachments.map(({ id }) => id)));
      expect(retry.result).toMatchObject({ outcome: "approved" });
      const mail: SmtpNotification[] = [];

      await runCycle({ async sendEmail(n) { mail.push(n); }, async sendPush() {} });

      expect(mail.filter((m) => m.to === fixture.users.member.email && m.subject.startsWith("Orbit could not add"))).toHaveLength(0);
      const changes = (await noticeRow(receiptId)).changes as { email: string; titleEnc: string | null };
      expect(changes.email).not.toBe("pending");
      expect(changes.titleEnc).toBeNull();
    });
  }, 60_000);

  it("the scanner dropping between the rescan and the upload refuses with the scanner wording, creates nothing and keeps the mail", async () => {
    const fixture = await createIntegrationFixture("aon-scanner-drops-late");
    await withRequiredScanMode(async () => {
      const { receiptId, attachments } = await seedMail(fixture, ["aon-late"]);
      const before = { items: await itemIds(fixture), bound: (await boundDocuments(fixture)).length };
      const documentsBefore = (await getDb().select({ id: documents.id }).from(documents).where(eq(documents.householdId, fixture.household.id))).length;
      scan.mockReset();
      scan.mockResolvedValueOnce({ status: "clean" }); // the rescan
      scan.mockResolvedValue({ status: "error", reason: "unavailable" }); // the upload's own scan

      const outcome = await attempt(fixture.users.member.id, requestFor(fixture, receiptId, attachments.map(({ id }) => id)));

      expect(scan.mock.calls.length, "the upload scanned again after the rescan").toBeGreaterThanOrEqual(2);
      expect(outcome.error, "refused, not returned").toBeInstanceOf(Error);
      expect((outcome.error as Error).message).toBe(SCANNER_AWAY);
      await expectNothingChanged(fixture, receiptId, attachments, before);
      expect((await getDb().select({ id: documents.id }).from(documents).where(eq(documents.householdId, fixture.household.id))).length, "no staged copy is left").toBe(documentsBefore);
    });
  }, 60_000);

  it("a legacy recoverable receipt whose document is in scanner recovery never has its held copy purged (#383 finding 4)", async () => {
    const fixture = await createIntegrationFixture("aon-legacy-recovery");
    await withRequiredScanMode(async () => {
      const { receiptId, attachments } = await seedMail(fixture, ["aon-legacy-recovery"]);
      const held = attachments[0]!;
      const input = requestFor(fixture, receiptId, [held.id]);
      // What the old code left behind: the item exists, the document was uploaded
      // while the scanner was away (so it is in scanner recovery), the attachment
      // is assigned to it with its purge pending, and the receipt is recoverable.
      await approveReviewedIntake(fixture.users.member.id, { ...input, source: { kind: "direct_upload" as const }, attachmentIds: [] });
      scan.mockReset();
      scan.mockResolvedValue({ status: "error", reason: "unavailable" });
      const document = await uploadItemDocument({
        userId: fixture.users.member.id, householdId: fixture.household.id, itemId: input.operationId,
        filename: "aon-legacy-recovery.pdf", body: new Blob([held.bytes as BlobPart]).stream() as ReadableStream<Uint8Array>,
        declaredBytes: held.bytes.byteLength, documentId: held.id, detectDuplicates: false,
      });
      expect(document.recoverable, "the document is in scanner recovery").toBe(true);
      await getDb().update(imapIngestionAttachments).set({ status: "assigned", assignedDocumentId: document.id, purgePending: true })
        .where(eq(imapIngestionAttachments.id, held.id));
      await getDb().update(imapIngestionMessages).set({
        status: "recoverable", failureCode: "scanner_unavailable",
        approvalOperationId: input.operationId, approvalResultId: randomUUID(), approvalRequestSha256: canonicalReviewedIntakeHash(input),
        approvedItemId: input.operationId, approvalStartedAt: new Date(Date.now() - 60_000),
      }).where(eq(imapIngestionMessages.id, receiptId));
      let purgeCalls = 0;
      setImapHoldingPurgeImplementationForTests(async () => { purgeCalls += 1; });
      try {
        const retry = await attempt(fixture.users.member.id, input);

        expect(purgeCalls, "the held copy is never purged while the document is in recovery").toBe(0);
        expect(retry.result).toMatchObject({ outcome: "partial_success", attachmentState: "pending", pendingAttachmentIds: [held.id] });
        expect(await receiptOf(receiptId)).toMatchObject({ status: "recoverable", failureCode: "scanner_unavailable" });
        await expectHeldFileKept(held.storageKey);
      } finally {
        setImapHoldingPurgeImplementationForTests(undefined);
      }
    });
  }, 60_000);

  it("a second request for an operation still staging waits, then gets 409 reviewed_intake_in_progress", async () => {
    const fixture = await createIntegrationFixture("aon-in-progress");
    await withRequiredScanMode(async () => {
      const { receiptId, attachments } = await seedMail(fixture, ["aon-wait"]);
      const input = requestFor(fixture, receiptId, attachments.map(({ id }) => id));
      const itemsBefore = (await itemIds(fixture)).length;
      const original = LocalDocumentStorage.prototype.sealQuarantine;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let staging = false;
      vi.spyOn(LocalDocumentStorage.prototype, "sealQuarantine").mockImplementation(async function (this: LocalDocumentStorage, ...args: Parameters<typeof original>) {
        staging = true;
        await gate;
        return original.apply(this, args);
      });
      const first = attempt(fixture.users.member.id, input);
      for (let tries = 0; tries < 200 && !staging; tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(staging, "the first request is staging").toBe(true);

      // `inProgressWaitMs` is the option the builder adds to keep this wait short; until then the default wait applies.
      const second = await (approveReviewedIntake as unknown as (userId: string, input: unknown, options?: { inProgressWaitMs?: number }) => Promise<unknown>)(
        fixture.users.member.id, input, { inProgressWaitMs: 200 },
      ).then((result) => ({ result, error: undefined as unknown }), (error: unknown) => ({ result: undefined, error }));

      expect(second.error).toMatchObject({ code: "reviewed_intake_in_progress", status: 409 });
      release();
      expect((await first).result).toMatchObject({ outcome: "approved" });
      expect(await itemIds(fixture)).toHaveLength(itemsBefore + 1);
    });
  }, 90_000);

  it("when the bind committed but checking it throws, the receipt is not released, and a later approval with a fresh key makes no second item", async () => {
    const fixture = await createIntegrationFixture("aon-bind-committed");
    await withRequiredScanMode(async () => {
      const { receiptId, attachments } = await seedMail(fixture, ["aon-bound"]);
      const ids = attachments.map(({ id }) => id);
      const itemsBefore = (await itemIds(fixture)).length;
      faults.throwAfterBind = true;

      await attempt(fixture.users.member.id, requestFor(fixture, receiptId, ids));
      faults.throwAfterBind = false;
      faults.readsBroken = false;

      expect(await itemIds(fixture), "the bind did commit").toHaveLength(itemsBefore + 1);
      const receipt = await receiptOf(receiptId);
      expect(receipt.status === "pending_review" && receipt.approvedItemId === null, "released to review with no item recorded").toBe(false);

      await attempt(fixture.users.member.id, requestFor(fixture, receiptId, ids, randomUUID()));

      expect(await itemIds(fixture), "no second item").toHaveLength(itemsBefore + 1);
    });
  }, 60_000);

  it("a notice is claimed before it is sent: sending does not hold the row lock, and a failed send is not repeated in the same cycle", async () => {
    const fixture = await createIntegrationFixture("aon-notice-lock");
    await getDb().update(userPreferences).set({ emailNotifications: true, pushNotifications: false }).where(eq(userPreferences.userId, fixture.users.member.id));
    const { receiptId } = await queuedNotice(fixture, "Lock probe");
    const row = await noticeRow(receiptId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let sends = 0;
    let started!: () => void;
    const sending = new Promise<void>((resolve) => { started = resolve; });
    const slowFailing = { async sendEmail() { sends += 1; started(); await gate; throw new Error("synthetic send failure"); }, async sendPush() {} };
    const other = { async sendEmail() { sends += 1; }, async sendPush() {} };

    const first = runCycle(slowFailing);
    await sending;
    const probe = await getDb().transaction((transaction) => transaction.execute(sql`select id from audit_log where id = ${row.id} for update nowait`))
      .then(() => "free", () => "locked");
    // A concurrent cycle neither blocks on the row nor sends it a second time.
    await runCycle(other);
    release();
    await first;

    expect(probe, "no database row lock is held while the mail is sent").toBe("free");
    expect(sends, "one send in the cycle, failed or not").toBe(1);
  }, 60_000);

  /* ---- Second review findings ---- */

  function lockKey() {
    const original = process.env.DOCUMENT_KEK;
    delete process.env.DOCUMENT_KEK;
    resetDocumentConfigForTests();
    return () => {
      if (original !== undefined) process.env.DOCUMENT_KEK = original;
      resetDocumentConfigForTests();
    };
  }
  const mailOnly = (fixture: IntegrationFixture) =>
    getDb().update(userPreferences).set({ emailNotifications: true, pushNotifications: false }).where(eq(userPreferences.userId, fixture.users.member.id));
  const collecting = (mail: SmtpNotification[]) => ({ async sendEmail(n: SmtpNotification) { mail.push(n); }, async sendPush() {} });
  const toMember = (mail: SmtpNotification[], fixture: IntegrationFixture) => mail.filter((m) => m.to === fixture.users.member.email);

  it("key locked: a notice stays pending (not failed, title kept, still counted) and is sent once the key is back", async () => {
    const fixture = await createIntegrationFixture("aon-notice-key-locked");
    await mailOnly(fixture);
    const { receiptId } = await queuedNotice(fixture, "Locked key title");
    const mail: SmtpNotification[] = [];
    const restore = lockKey();
    try {
      await runCycle(collecting(mail));
      await runCycle(collecting(mail));
      const changes = (await noticeRow(receiptId)).changes as { email: string; push: string; titleEnc: string | null };
      expect(changes.email, "retried like any transient fault, not failed").toBe("pending");
      expect(changes.titleEnc, "the title is kept").not.toBeNull();
      expect(toMember(mail, fixture)).toHaveLength(0);
      expect((await getDocumentHealth()).metadata?.lockedReceipts, "still counted while locked").toBeGreaterThan(0);
    } finally {
      restore();
    }
    await runCycle(collecting(mail));
    expect(toMember(mail, fixture).filter((m) => m.subject.includes("Locked key title")), "sent once the key is back").toHaveLength(1);
    expect(((await noticeRow(receiptId)).changes as { email: string }).email).toBe("sent");
  }, 60_000);

  it("a receipt still approving (a same-key replay under way) does not end the notice; after the replay fails and releases the member is told once", async () => {
    const fixture = await createIntegrationFixture("aon-notice-replaying");
    await mailOnly(fixture);
    const { receiptId, operationId } = await queuedNotice(fixture, "Replay title");
    await getDb().update(imapIngestionMessages).set({ status: "approving", approvalOperationId: operationId, approvalStartedAt: new Date() })
      .where(eq(imapIngestionMessages.id, receiptId));
    const mail: SmtpNotification[] = [];

    await runCycle(collecting(mail));

    const during = (await noticeRow(receiptId)).changes as { email: string; push: string; titleEnc: string | null };
    expect(toMember(mail, fixture)).toHaveLength(0);
    expect(during.email, "not ended while the replay runs").toBe("pending");
    expect(during.titleEnc).not.toBeNull();
    // The replay fails and releases the claim.
    await getDb().update(imapIngestionMessages).set({ status: "pending_review", approvalOperationId: null, approvalStartedAt: null })
      .where(eq(imapIngestionMessages.id, receiptId));
    await runCycle(collecting(mail));
    await runCycle(collecting(mail));

    expect(toMember(mail, fixture).filter((m) => m.subject.startsWith("Orbit could not add")), "told exactly once in total").toHaveLength(1);
  }, 60_000);

  it("lease: a claim older than 10 minutes ends failed and is not resent", async () => {
    const fixture = await createIntegrationFixture("aon-notice-lease");
    await mailOnly(fixture);
    const { receiptId } = await queuedNotice(fixture, "Lease title");
    const row = await noticeRow(receiptId);
    const stale = new Date(cycleTime.getTime() - 11 * 60_000).toISOString();
    await getDb().update(auditLog).set({ changes: { ...(row.changes as object), email: "sending", emailClaimedAt: stale } }).where(eq(auditLog.id, row.id));
    const mail: SmtpNotification[] = [];

    await runCycle(collecting(mail));
    await runCycle(collecting(mail));

    expect(toMember(mail, fixture)).toHaveLength(0);
    expect(((await noticeRow(receiptId)).changes as { email: string }).email).toBe("failed");
  }, 60_000);

  it("lease: a late result after the claim was taken over is ignored", async () => {
    const fixture = await createIntegrationFixture("aon-notice-late-result");
    await mailOnly(fixture);
    const { receiptId } = await queuedNotice(fixture, "Late result title");
    const row = await noticeRow(receiptId);
    const takenOver = new Date(cycleTime.getTime() + 5 * 60_000).toISOString();
    const slow = {
      async sendEmail() {
        // While this send is on the wire, another worker takes the claim over.
        await getDb().update(auditLog).set({ changes: sql`jsonb_set(${auditLog.changes}, '{emailClaimedAt}', to_jsonb(${takenOver}::text))` }).where(eq(auditLog.id, row.id));
      },
      async sendPush() {},
    };

    await runCycle(slow);

    const changes = (await noticeRow(receiptId)).changes as { email: string; emailClaimedAt: string | null };
    expect(changes.email, "the late result did not overwrite the newer claim").toBe("sending");
    expect(changes.emailClaimedAt).toBe(takenOver);
  }, 60_000);

  it("a receipt removed by retention has its notice finalised by the purge itself", async () => {
    const fixture = await createIntegrationFixture("aon-notice-purged");
    const { receiptId } = await queuedNotice(fixture, "Purged title");
    await getDb().update(imapIngestionMessages).set({ expiresAt: new Date("2020-01-01T00:00:00.000Z") }).where(eq(imapIngestionMessages.id, receiptId));

    await purgeExpiredImapStaging(new Date(), 100);

    expect((await receiptOf(receiptId)).status).toBe("expired");
    const changes = (await noticeRow(receiptId)).changes as { email: string; push: string; titleEnc: string | null };
    expect(changes.email).not.toMatch(/^(pending|sending)$/u);
    expect(changes.push).not.toMatch(/^(pending|sending)$/u);
    expect(changes.titleEnc, "the encrypted title is cleared by the purge").toBeNull();
  }, 60_000);

  it("a discarded receipt has its notice finalised by the discard itself", async () => {
    const fixture = await createIntegrationFixture("aon-notice-discarded");
    const { receiptId } = await queuedNotice(fixture, "Discarded title");

    await discardImapReviewItem(fixture.users.member.id, receiptId);

    expect((await receiptOf(receiptId)).status).toBe("discarded");
    const changes = (await noticeRow(receiptId)).changes as { email: string; push: string; titleEnc: string | null };
    expect(changes.email).not.toMatch(/^(pending|sending)$/u);
    expect(changes.push).not.toMatch(/^(pending|sending)$/u);
    expect(changes.titleEnc, "the encrypted title is cleared by the discard").toBeNull();
  }, 60_000);

  it("bind rolled back but the commit check throws: a same-key replay leaves one item, each attachment once, and no orphan staged document", async () => {
    const fixture = await createIntegrationFixture("aon-bind-rolled-back");
    await withRequiredScanMode(async () => {
      const { receiptId, attachments } = await seedMail(fixture, ["aon-rb-one", "aon-rb-two"]);
      const ids = attachments.map(({ id }) => id);
      const input = requestFor(fixture, receiptId, ids);
      const itemsBefore = (await itemIds(fixture)).length;
      faults.throwBeforeBind = true;

      await attempt(fixture.users.member.id, input);
      faults.throwBeforeBind = false;
      faults.readsBroken = false;
      const replay = await attempt(fixture.users.member.id, input);

      expect(replay.error).toBeUndefined();
      expect(await itemIds(fixture), "exactly one item").toHaveLength(itemsBefore + 1);
      const all = await getDb().select({ id: documents.id, itemId: documents.itemId, sealedItemId: documents.sealedItemId }).from(documents)
        .where(eq(documents.householdId, fixture.household.id));
      const mine = all.filter((row) => row.itemId === input.operationId || row.sealedItemId === input.operationId);
      expect(mine, "each attachment once").toHaveLength(ids.length);
      expect(all.filter((row) => row.itemId === null && row.sealedItemId === null), "no staged document without an item").toHaveLength(0);
    });
  }, 60_000);
});
