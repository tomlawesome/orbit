import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { imapIngestionAttachments, imapIngestionMessages, items, sections } from "@/db/schema";
import { getDocumentHealth } from "@/server/document-health";
import { scanAndHoldImapAttachment, setImapHoldingPurgeImplementationForTests } from "@/server/mail-in/imap-attachment-holding";
import { discardImapReviewItem, purgeExpiredImapStaging } from "@/server/mail-in/imap-inbox";
import { openMetadataReader } from "@/server/metadata/fields";
import { canonicalReviewedIntakeHash } from "@/server/reviewed-intake";
import { applyWorkspaceCommand } from "@/server/workspace-repository";
import { cleanupIntegrationEnvironment, createIntegrationFixture, encryptedReceiptDraft, lockTheInstance } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";
import { syntheticPdf } from "../support/synthetic-documents";

/*
 * Approve retry (#1396, ADR-0005): approval is an idempotency-key operation
 * with a stored request fingerprint. The server also keeps the accepted request
 * and the review read hands the pending pair back to its owner
 * (`approval: { operationId, request }`), because the browser persists nothing
 * (ADR-0006). The selected-attachment check runs before the claim. The reclaim
 * of an abandoned `approving` receipt that already made its item moves it to
 * `recoverable` (`approval_interrupted`) keeping its key. In every case a
 * receipt has at most one item, and its id is the operation id.
 */

const { POST } = await loadRoute("reviewed-intake/approve");
const { GET: getReceipt, DELETE: discardReceipt } = await loadRoute("imap-inbox/[receiptId]");
const { GET: getInbox } = await loadRoute("imap-inbox");

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;
type Session = Awaited<ReturnType<Fixture["session"]>>;

/** The request the review read reports beside its key. */
type ReportedRequest = Record<string, unknown> & { item: { title?: unknown } };

const APPROVE_URL = "http://127.0.0.1:3000/api/reviewed-intake/approve";
const INBOX_URL = "http://127.0.0.1:3000/api/imap-inbox";
const reviewUrl = (fixture: Fixture, receiptId: string) => `http://127.0.0.1:3000/api/imap-inbox/${receiptId}?householdId=${fixture.household.id}`;
const db = () => getDb();

function approve(session: Session, payload: unknown): Promise<Response> {
  return callRouteForSession(POST, session, {
    url: APPROVE_URL, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
}

function readReview(session: Session, fixture: Fixture, receiptId: string): Promise<Response> {
  return callRouteForSession(getReceipt, session, { url: reviewUrl(fixture, receiptId), params: { receiptId } });
}

function payloadFor(fixture: Fixture, receiptId: string, operationId: string, overrides: { title?: string; attachmentIds?: string[]; draftVersion?: number } = {}) {
  return {
    operationId,
    source: { kind: "mailbox_draft", receiptId, draftVersion: overrides.draftVersion ?? 1 },
    householdId: fixture.household.id,
    sectionId: fixture.section.id,
    action: "create_separate",
    item: { title: overrides.title ?? "Retry value", currency: "GBP", status: "active" },
    attachmentIds: overrides.attachmentIds ?? [],
  };
}

async function seedReceipt(fixture: Fixture, over: Record<string, unknown> = {}): Promise<string> {
  const id = typeof over.id === "string" ? over.id : randomUUID();
  await db().insert(imapIngestionMessages).values({
    id, mailbox: "private", mailboxUidValidity: `retry-${id.slice(0, 8)}`, mailboxUid: Math.floor(Math.random() * 1_000_000),
    contentSha256: randomUUID().replaceAll("-", ""), recipientAliasSha256: "retry",
    userId: fixture.users.member.id, householdId: fixture.household.id, draftVersion: 1, status: "pending_review",
    expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending",
    ...over,
  });
  return id;
}

async function seedAttachment(receiptId: string, userId: string, label: string, status: "stored" | "rejected" = "stored"): Promise<string> {
  const held = await scanAndHoldImapAttachment({
    bytes: syntheticPdf(label), filename: `${label}.pdf`, declaredMediaType: "application/pdf",
    recipientUserId: userId, receiptId,
  });
  await db().insert(imapIngestionAttachments).values({
    id: held.id, messageId: receiptId, displayName: held.displayName, mediaType: held.mediaType, sizeBytes: held.sizeBytes,
    contentSha256: held.contentSha256, storageKey: held.storageKey, ciphertextSize: held.ciphertextSize, ...held.envelope, status,
  });
  return held.id;
}

async function receiptRow(receiptId: string) {
  const [row] = await db().select({
    status: imapIngestionMessages.status,
    failureCode: imapIngestionMessages.failureCode,
    approvalOperationId: imapIngestionMessages.approvalOperationId,
    approvalRequestSha256: imapIngestionMessages.approvalRequestSha256,
    approvedItemId: imapIngestionMessages.approvedItemId,
  }).from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId));
  return row;
}

/** Whether the receipt still holds its stored approval request (`approval_request_enc`). */
async function storedRequest(receiptId: string): Promise<string | null> {
  const [row] = await db().select({ enc: imapIngestionMessages.approvalRequestEnc }).from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId));
  return row.enc;
}

async function householdItemIds(fixture: Fixture): Promise<string[]> {
  return (await db().select({ id: items.id }).from(items).where(eq(items.householdId, fixture.household.id))).map((row) => row.id);
}

async function titleOf(fixture: Fixture, itemId: string): Promise<string | undefined> {
  const [row] = await db().select({ id: items.id, titleEnc: items.titleEnc }).from(items).where(eq(items.id, itemId));
  if (!row) return undefined;
  const metadata = await openMetadataReader(fixture.household.id);
  return metadata.text("items.title", row.id, { encrypted: row.titleEnc }).value ?? undefined;
}

/** The first approve fails in the attachment step and leaves the receipt `recoverable` (item recorded). */
async function approveToPartial(session: Session, payload: unknown): Promise<void> {
  setImapHoldingPurgeImplementationForTests(async () => {
    setImapHoldingPurgeImplementationForTests(undefined);
    throw new Error("synthetic purge failure");
  });
  const first = await approve(session, payload);
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ outcome: "partial_success" });
}

/** An approval started this long ago is past the 10-minute bound; "fresh" is inside it. */
const abandonedAt = () => new Date(Date.now() - 11 * 60_000);
const freshAt = () => new Date(Date.now() - 2 * 60_000);

/** The columns that hold ciphertext of a review, plus the ones the approval keeps beside them. */
async function reviewColumns(receiptId: string) {
  const [row] = await db().select({
    status: imapIngestionMessages.status,
    failureCode: imapIngestionMessages.failureCode,
    proposalEnc: imapIngestionMessages.proposalEnc,
    fieldEvidenceEnc: imapIngestionMessages.fieldEvidenceEnc,
    approvalRequestEnc: imapIngestionMessages.approvalRequestEnc,
    approvalOperationId: imapIngestionMessages.approvalOperationId,
    approvalRequestSha256: imapIngestionMessages.approvalRequestSha256,
    approvalStartedAt: imapIngestionMessages.approvalStartedAt,
    approvedItemId: imapIngestionMessages.approvedItemId,
  }).from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId));
  return row;
}

type ListedReceipt = { id: string; status: string; classification: string; canApprove: boolean; canDiscard: boolean; message: string };

async function listReceipts(session: Session): Promise<ListedReceipt[]> {
  const response = await callRouteForSession(getInbox, session, { url: INBOX_URL });
  expect(response.status).toBe(200);
  return (await response.json() as { receipts: ListedReceipt[] }).receipts;
}

function discard(session: Session, fixture: Fixture, receiptId: string): Promise<Response> {
  return callRouteForSession(discardReceipt, session, { url: reviewUrl(fixture, receiptId), method: "DELETE", params: { receiptId } });
}

/** The row goes back to an `approving` request that died, keeping whatever else it holds (key, hash, stored request). */
async function rewindToApproving(receiptId: string, over: Record<string, unknown> = {}): Promise<void> {
  await db().update(imapIngestionMessages).set({
    status: "approving", approvalResultId: null, failureCode: null, approvalStartedAt: abandonedAt(), updatedAt: abandonedAt(), ...over,
  }).where(eq(imapIngestionMessages.id, receiptId));
}

/**
 * A receipt that holds a real draft (proposal and field evidence ciphertext)
 * and one held attachment, approved to `partial_success`: `recoverable`, the
 * item made, key, hash and stored request set.
 */
async function seedPartialApproval(fixture: Fixture, session: Session, userId: string, label: string, over: Record<string, unknown> = {}) {
  const receiptId = randomUUID();
  await seedReceipt(fixture, {
    id: receiptId, userId, householdId: fixture.household.id,
    ...await encryptedReceiptDraft(fixture.household.id, receiptId, { proposal: { title: `Draft ${label}` }, fieldEvidence: { title: { source: "subject" } } }),
    ...over,
  });
  const attachmentId = await seedAttachment(receiptId, userId, label);
  const operationId = randomUUID();
  const sent = payloadFor(fixture, receiptId, operationId, { title: `Typed title ${label}`, attachmentIds: [attachmentId] });
  await approveToPartial(session, sent);
  return { receiptId, attachmentId, operationId, sent };
}

async function lockedReceiptCount(): Promise<number> {
  const unlock = lockTheInstance();
  try {
    const health = await getDocumentHealth();
    expect(health.metadata.locked).toBe(true);
    return health.metadata.lockedReceipts;
  } finally {
    unlock();
  }
}

describe("approve retry: the review read hands back the pending pair (#1396)", () => {
  it("lost answer, reload, tap: the read reports the accepted pair and replaying it finishes with one item", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-reload");
    const member = await fixture.session("member");
    const receiptId = await seedReceipt(fixture);
    const attachmentId = await seedAttachment(receiptId, fixture.users.member.id, "retry-reload");
    const operationId = randomUUID();
    const before = await householdItemIds(fixture);
    try {
      const sent = payloadFor(fixture, receiptId, operationId, { title: "Amended before the reload", attachmentIds: [attachmentId] });
      await approveToPartial(member, sent);
      const bound = await receiptRow(receiptId);
      expect(bound).toMatchObject({ status: "recoverable", approvalOperationId: operationId });

      const read = await readReview(member, fixture, receiptId);
      expect(read.status).toBe(200);
      const review = await read.json() as { approval?: { operationId: string; request: ReportedRequest } };
      expect(review.approval?.operationId).toBe(operationId);
      expect(review.approval?.request).toMatchObject({
        householdId: fixture.household.id,
        sectionId: fixture.section.id,
        action: "create_separate",
        source: { kind: "mailbox_draft", receiptId },
        item: { title: "Amended before the reload" },
        attachmentIds: [attachmentId],
      });
      // The reported request, sent back verbatim, hashes to the stored fingerprint.
      const replay = { ...review.approval!.request, operationId };
      expect(canonicalReviewedIntakeHash(sent as never)).toBe(bound.approvalRequestSha256);
      expect(canonicalReviewedIntakeHash(replay as never)).toBe(bound.approvalRequestSha256);

      // A second device: another session of the same user, no memory of the first attempt.
      const otherDevice = await fixture.session("member");
      const retry = await approve(otherDevice, replay);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ outcome: "approved", itemId: operationId, attachedAttachmentIds: [attachmentId], pendingAttachmentIds: [] });

      const after = await householdItemIds(fixture);
      expect(after.filter((id) => !before.includes(id))).toEqual([operationId]);
      expect(await titleOf(fixture, operationId)).toBe("Amended before the reload");
      expect(await receiptRow(receiptId)).toMatchObject({ status: "completed", approvedItemId: operationId });
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });

  it("with a pair pending, a changed body or a different key stays 409 and the stored pair still finishes with one item", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-stored-wins");
    const member = await fixture.session("member");
    const receiptId = await seedReceipt(fixture);
    const attachmentId = await seedAttachment(receiptId, fixture.users.member.id, "retry-stored");
    const operationId = randomUUID();
    const before = await householdItemIds(fixture);
    try {
      await approveToPartial(member, payloadFor(fixture, receiptId, operationId, { title: "First amendment", attachmentIds: [attachmentId] }));
      const changed = await approve(member, payloadFor(fixture, receiptId, operationId, { title: "Second amendment", attachmentIds: [attachmentId] }));
      expect(changed.status).toBe(409);
      expect((await changed.json()).error).toEqual({ code: "reviewed_intake_conflict", message: "That approval identity was already used" });
      const freshKey = await approve(member, payloadFor(fixture, receiptId, randomUUID(), { title: "First amendment", attachmentIds: [attachmentId] }));
      expect(freshKey.status).toBe(409);
      expect((await freshKey.json()).error).toEqual({ code: "reviewed_intake_conflict", message: "That approval identity was already used" });

      const review = await (await readReview(member, fixture, receiptId)).json() as { approval?: { operationId: string; request: ReportedRequest } };
      expect(review.approval?.operationId).toBe(operationId);
      expect(review.approval?.request.item.title).toBe("First amendment");
      const finished = await approve(member, { ...review.approval!.request, operationId: review.approval!.operationId });
      expect(finished.status).toBe(200);
      const created = (await householdItemIds(fixture)).filter((id) => !before.includes(id));
      expect(created).toEqual([operationId]);
      expect(await titleOf(fixture, operationId)).toBe("First amendment");
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });

  it("reports no approval for pending_review, approving, completed, or a recoverable receipt that is not an approval retry, and 404s another user", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-absent");
    const member = await fixture.session("member");
    const outsider = await fixture.session("outsider");
    try {
      const pending = await seedReceipt(fixture);
      const approving = await seedReceipt(fixture, {
        status: "approving", approvalOperationId: randomUUID(), approvalRequestSha256: "a".repeat(64), approvalStartedAt: new Date(),
      });
      const discardFailed = await seedReceipt(fixture, { status: "recoverable", failureCode: "discard_purge_failed" });
      const completed = await seedReceipt(fixture);
      expect((await approve(member, payloadFor(fixture, completed, randomUUID()))).status).toBe(200);
      expect((await receiptRow(completed)).status).toBe("completed");

      for (const id of [pending, approving, discardFailed, completed]) {
        const response = await readReview(member, fixture, id);
        const payload = await response.json() as Record<string, unknown>;
        expect(payload, `receipt ${id}`).not.toHaveProperty("approval");
      }

      // The positive control: the same read does report it for a retryable recoverable receipt.
      const retryable = await seedReceipt(fixture);
      const attachmentId = await seedAttachment(retryable, fixture.users.member.id, "retry-absent");
      const operationId = randomUUID();
      await approveToPartial(member, payloadFor(fixture, retryable, operationId, { attachmentIds: [attachmentId] }));
      expect(await (await readReview(member, fixture, retryable)).json()).toHaveProperty("approval.operationId", operationId);
      const hidden = await readReview(outsider, fixture, retryable);
      expect(hidden.status).toBe(404);
      expect(await hidden.json()).not.toHaveProperty("approval");
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });

  it("lost answer on a completed approval: the receipt leaves the lane after a reload and the item exists once", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-lost-answer");
    const member = await fixture.session("member");
    const receiptId = await seedReceipt(fixture);
    const operationId = randomUUID();
    const before = await householdItemIds(fixture);
    try {
      expect((await approve(member, payloadFor(fixture, receiptId, operationId))).status).toBe(200); // the answer is "lost"
      const lane = await callRouteForSession(getInbox, member, { url: "http://127.0.0.1:3000/api/imap-inbox" });
      expect((await lane.json() as { receipts: Array<{ id: string }> }).receipts.map((r) => r.id)).not.toContain(receiptId);
      expect((await householdItemIds(fixture)).filter((id) => !before.includes(id))).toEqual([operationId]);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("approve retry: validation runs before the claim (#1396)", () => {
  it("a stale attachment selection is refused 404 with nothing bound and no item; the next tap succeeds", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-stale-selection");
    const member = await fixture.session("member");
    const receiptId = await seedReceipt(fixture);
    const goodId = await seedAttachment(receiptId, fixture.users.member.id, "retry-good");
    const rejectedId = await seedAttachment(receiptId, fixture.users.member.id, "retry-rejected", "rejected");
    const operationId = randomUUID();
    const before = await householdItemIds(fixture);
    try {
      const refused = await approve(member, payloadFor(fixture, receiptId, operationId, { title: "Amended values", attachmentIds: [goodId, rejectedId] }));
      expect(refused.status).toBe(404);
      expect((await refused.json()).error.code).toBe("attachment_not_found");
      expect(await receiptRow(receiptId)).toMatchObject({
        status: "pending_review", approvalOperationId: null, approvalRequestSha256: null, approvedItemId: null,
      });
      expect(await householdItemIds(fixture)).toEqual(before);
      expect(await readReview(member, fixture, receiptId).then((r) => r.json())).not.toHaveProperty("approval");

      // The review now lists only the good attachment; the same key is still free.
      const retry = await approve(member, payloadFor(fixture, receiptId, operationId, { title: "Amended values", attachmentIds: [goodId] }));
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ outcome: "approved", itemId: operationId, attachedAttachmentIds: [goodId] });
      expect((await householdItemIds(fixture)).filter((id) => !before.includes(id))).toEqual([operationId]);
      expect(await titleOf(fixture, operationId)).toBe("Amended values");
    } finally {
      await fixture.cleanup();
    }
  });

  it("a selection naming an attachment the receipt does not have is refused before the claim too", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-unknown-selection");
    const member = await fixture.session("member");
    const receiptId = await seedReceipt(fixture);
    const before = await householdItemIds(fixture);
    try {
      const refused = await approve(member, payloadFor(fixture, receiptId, randomUUID(), { attachmentIds: [randomUUID()] }));
      expect(refused.status).toBe(404);
      expect((await refused.json()).error.code).toBe("attachment_not_found");
      expect(await receiptRow(receiptId)).toMatchObject({ status: "pending_review", approvalOperationId: null, approvalRequestSha256: null });
      expect(await householdItemIds(fixture)).toEqual(before);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("approve retry: the reclaim remembers the item (#1396)", () => {
  const abandoned = () => new Date(Date.now() - 11 * 60_000);

  it("an abandoned approving receipt that made its item becomes recoverable, keeps its key, reports the pair, and a tap finishes with one item", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-reclaim-item");
    const member = await fixture.session("member");
    const receiptId = await seedReceipt(fixture);
    const attachmentId = await seedAttachment(receiptId, fixture.users.member.id, "retry-reclaim-item");
    const operationId = randomUUID();
    const before = await householdItemIds(fixture);
    try {
      const sent = payloadFor(fixture, receiptId, operationId, { title: "Made before the crash", attachmentIds: [attachmentId] });
      // Completion clears the stored request, so take it while the approval is still open (partial).
      await approveToPartial(member, sent);
      const stored = await storedRequest(receiptId);
      expect(stored).not.toBeNull();
      // Rewind to a request that died after the item was created: it still holds its stored request.
      await db().update(imapIngestionMessages).set({
        status: "approving", approvalResultId: null, failureCode: null, approvalRequestEnc: stored, approvalStartedAt: abandoned(), updatedAt: abandoned(),
      }).where(eq(imapIngestionMessages.id, receiptId));
      const bound = await receiptRow(receiptId);
      expect(bound).toMatchObject({ status: "approving", approvalOperationId: operationId, approvedItemId: operationId });

      // Ten minutes on, the member reads the review.
      const read = await readReview(member, fixture, receiptId);
      expect(read.status).toBe(200);
      const review = await read.json() as { approval?: { operationId: string; request: ReportedRequest } };
      expect(await receiptRow(receiptId)).toMatchObject({
        status: "recoverable", failureCode: "approval_interrupted",
        approvalOperationId: operationId, approvalRequestSha256: bound.approvalRequestSha256, approvedItemId: operationId,
      });
      expect(review.approval?.operationId).toBe(operationId);
      expect(review.approval?.request).toMatchObject({ item: { title: "Made before the crash" } });

      const finished = await approve(member, { ...review.approval!.request, operationId });
      expect(finished.status).toBe(200);
      expect(await finished.json()).toMatchObject({ outcome: "approved", itemId: operationId });
      expect((await householdItemIds(fixture)).filter((id) => !before.includes(id))).toEqual([operationId]);
      expect(await receiptRow(receiptId)).toMatchObject({ status: "completed", approvedItemId: operationId });
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });

  it("a fresh key on an abandoned receipt that made its item never makes a second item", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-reclaim-fresh-key");
    const member = await fixture.session("member");
    const receiptId = await seedReceipt(fixture);
    const attachmentId = await seedAttachment(receiptId, fixture.users.member.id, "retry-reclaim-fresh");
    const operationId = randomUUID();
    const before = await householdItemIds(fixture);
    try {
      // Completion clears the stored request, so take it while the approval is still open (partial).
      await approveToPartial(member, payloadFor(fixture, receiptId, operationId, { title: "Made before the crash", attachmentIds: [attachmentId] }));
      const stored = await storedRequest(receiptId);
      expect(stored).not.toBeNull();
      await db().update(imapIngestionMessages).set({
        status: "approving", approvalResultId: null, failureCode: null, approvalRequestEnc: stored, approvalStartedAt: abandoned(), updatedAt: abandoned(),
      }).where(eq(imapIngestionMessages.id, receiptId));

      const fresh = await approve(member, payloadFor(fixture, receiptId, randomUUID(), { title: "Made before the crash", attachmentIds: [attachmentId] }));
      expect(fresh.status).toBe(409);
      expect((await fresh.json()).error).toEqual({ code: "reviewed_intake_conflict", message: "That approval identity was already used" });
      expect((await householdItemIds(fixture)).filter((id) => !before.includes(id))).toEqual([operationId]);
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });

  it("an abandoned approving receipt with no item created is reset as before: a fresh key makes the one item", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-reclaim-no-item");
    const member = await fixture.session("member");
    const staleKey = randomUUID();
    const receiptId = await seedReceipt(fixture, {
      status: "approving", approvalOperationId: staleKey, approvalRequestSha256: "b".repeat(64), approvalStartedAt: abandoned(), approvedItemId: null,
    });
    const freshKey = randomUUID();
    const before = await householdItemIds(fixture);
    try {
      const response = await approve(member, payloadFor(fixture, receiptId, freshKey, { title: "Only item" }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ outcome: "approved", itemId: freshKey });
      expect((await householdItemIds(fixture)).filter((id) => !before.includes(id))).toEqual([freshKey]);
      expect(await receiptRow(receiptId)).toMatchObject({ status: "completed", approvalOperationId: freshKey, approvedItemId: freshKey });
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("approve retry: completion clears the stored request (#1396)", () => {
  it("a completed approval has no stored request, and the same key and body still answers as completed", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-complete-clears");
    const member = await fixture.session("member");
    const receiptId = await seedReceipt(fixture);
    const operationId = randomUUID();
    const before = await householdItemIds(fixture);
    try {
      const sent = payloadFor(fixture, receiptId, operationId, { title: "Completed once" });
      expect((await approve(member, sent)).status).toBe(200);
      expect(await receiptRow(receiptId)).toMatchObject({ status: "completed", approvalOperationId: operationId, approvedItemId: operationId });
      // The request held the amended values for the life of the approval only.
      expect(await storedRequest(receiptId), "approval_request_enc after completion").toBeNull();

      const replay = await approve(member, sent);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ outcome: "approved", itemId: operationId });
      expect((await householdItemIds(fixture)).filter((id) => !before.includes(id))).toEqual([operationId]);
      expect(await receiptRow(receiptId)).toMatchObject({ status: "completed", approvalOperationId: operationId, approvalRequestSha256: expect.any(String) });
    } finally {
      await fixture.cleanup();
    }
  });

  it("a partial approval keeps its request until the retry completes it, then the request is gone", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-partial-then-clears");
    const member = await fixture.session("member");
    const receiptId = await seedReceipt(fixture);
    const attachmentId = await seedAttachment(receiptId, fixture.users.member.id, "retry-clears");
    const operationId = randomUUID();
    try {
      const sent = payloadFor(fixture, receiptId, operationId, { title: "Finished on retry", attachmentIds: [attachmentId] });
      await approveToPartial(member, sent);
      // The positive control: the column is set while the approval can still be retried.
      expect(await storedRequest(receiptId), "approval_request_enc while recoverable").not.toBeNull();

      const retry = await approve(member, sent);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ outcome: "approved", itemId: operationId, pendingAttachmentIds: [] });
      expect(await receiptRow(receiptId)).toMatchObject({ status: "completed" });
      expect(await storedRequest(receiptId), "approval_request_enc after the retry completes").toBeNull();

      const replay = await approve(member, sent);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ outcome: "approved", itemId: operationId });
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });
});

describe("approve retry: the stored request ends with the review (L-F2, D-F4, D-F5)", () => {
  it("discard clears the stored request with the rest of the draft, and keeps the key and hash", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-discard-clears");
    const member = await fixture.session("member");
    try {
      const { receiptId, operationId } = await seedPartialApproval(fixture, member, fixture.users.member.id, "discard-clears");
      const before = await reviewColumns(receiptId);
      // Positive control: the review holds all three ciphertexts while it is open.
      expect(before).toMatchObject({ status: "recoverable", approvalOperationId: operationId });
      expect(before.approvalRequestEnc, "approval_request_enc while open").not.toBeNull();
      expect(before.proposalEnc, "proposal_enc while open").not.toBeNull();
      expect(before.fieldEvidenceEnc, "field_evidence_enc while open").not.toBeNull();

      expect((await discard(member, fixture, receiptId)).status).toBe(200);
      const after = await reviewColumns(receiptId);
      expect(after.status).toBe("discarded");
      expect(after.approvalRequestEnc, "approval_request_enc after discard").toBeNull();
      expect(after.proposalEnc, "proposal_enc after discard").toBeNull();
      expect(after.fieldEvidenceEnc, "field_evidence_enc after discard").toBeNull();
      expect(after.approvalOperationId).toBe(before.approvalOperationId);
      expect(after.approvalRequestSha256).toBe(before.approvalRequestSha256);
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });

  it("expiry clears the stored request with the rest of the draft", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-expiry-clears");
    const member = await fixture.session("member");
    try {
      const { receiptId } = await seedPartialApproval(fixture, member, fixture.users.member.id, "expiry-clears");
      expect((await reviewColumns(receiptId)).approvalRequestEnc, "approval_request_enc while open").not.toBeNull();
      await db().update(imapIngestionMessages).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(imapIngestionMessages.id, receiptId));

      await purgeExpiredImapStaging(new Date(), 100);
      const after = await reviewColumns(receiptId);
      expect(after.status).toBe("expired");
      expect(after.approvalRequestEnc, "approval_request_enc after expiry").toBeNull();
      expect(after.proposalEnc, "proposal_enc after expiry").toBeNull();
      expect(after.fieldEvidenceEnc, "field_evidence_enc after expiry").toBeNull();
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });

  it("a terminal attachment failure clears the stored request with the rest of the draft", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-terminal-clears");
    const member = await fixture.session("member");
    try {
      const { receiptId } = await seedPartialApproval(fixture, member, fixture.users.member.id, "terminal-clears");
      expect((await reviewColumns(receiptId)).approvalRequestEnc, "approval_request_enc while open").not.toBeNull();
      await db().update(imapIngestionMessages).set({ failureCode: "attachment_processing_exhausted" }).where(eq(imapIngestionMessages.id, receiptId));

      await purgeExpiredImapStaging(new Date(), 100);
      const after = await reviewColumns(receiptId);
      expect(after.status).toBe("failed");
      expect(after.approvalRequestEnc, "approval_request_enc after the terminal failure").toBeNull();
      expect(after.proposalEnc, "proposal_enc after the terminal failure").toBeNull();
      expect(after.fieldEvidenceEnc, "field_evidence_enc after the terminal failure").toBeNull();
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });

  it("a retryable purge failure at expiry keeps the stored request: the review has not ended (guard)", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-purge-failure-keeps");
    const member = await fixture.session("member");
    try {
      const { receiptId } = await seedPartialApproval(fixture, member, fixture.users.member.id, "purge-failure-keeps");
      await db().update(imapIngestionMessages).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(imapIngestionMessages.id, receiptId));

      setImapHoldingPurgeImplementationForTests(async () => { throw new Error("synthetic purge failure"); });
      await purgeExpiredImapStaging(new Date(), 100);
      const after = await reviewColumns(receiptId);
      expect(after).toMatchObject({ status: "recoverable", failureCode: "staging_purge_failed" });
      expect(after.approvalRequestEnc, "approval_request_enc while the purge is still to be retried").not.toBeNull();
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });

  it("document health stops counting a discarded receipt as holding locked ciphertext", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-health-count");
    const member = await fixture.session("member");
    try {
      const { receiptId } = await seedPartialApproval(fixture, member, fixture.users.member.id, "health-count");
      const lockedBefore = await lockedReceiptCount();
      expect(lockedBefore).toBeGreaterThanOrEqual(1);

      expect((await discard(member, fixture, receiptId)).status).toBe(200);
      expect((await reviewColumns(receiptId)).status).toBe("discarded");
      expect(await lockedReceiptCount()).toBe(lockedBefore - 1);
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });
});

describe("approve retry: the approval's own expiry writes end the review (mailin-1)", () => {
  const pastExpiry = () => new Date(Date.now() - 60_000);

  async function lapse(receiptId: string): Promise<void> {
    await db().update(imapIngestionMessages).set({ expiresAt: pastExpiry() }).where(eq(imapIngestionMessages.id, receiptId));
  }

  async function expiredAtOf(receiptId: string): Promise<Date | null> {
    const [row] = await db().select({ expiredAt: imapIngestionMessages.expiredAt }).from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId));
    return row.expiredAt;
  }

  async function expectExpiredAnswer(response: Response): Promise<void> {
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "reviewed_intake_expired" } });
  }

  it("replaying the pair past expiry answers expired and clears the draft and the stored request, keeping the key and hash", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-replay-expiry-clears");
    const member = await fixture.session("member");
    try {
      const { receiptId, sent } = await seedPartialApproval(fixture, member, fixture.users.member.id, "replay-expiry");
      const before = await reviewColumns(receiptId);
      // Positive control: the review holds all three ciphertexts while it is open.
      expect(before.status).toBe("recoverable");
      expect(before.approvalRequestEnc, "approval_request_enc while open").not.toBeNull();
      expect(before.proposalEnc, "proposal_enc while open").not.toBeNull();
      expect(before.fieldEvidenceEnc, "field_evidence_enc while open").not.toBeNull();
      expect(before.approvedItemId).not.toBeNull();
      await lapse(receiptId);

      await expectExpiredAnswer(await approve(member, sent));
      const after = await reviewColumns(receiptId);
      expect(after.status).toBe("expired");
      expect(await expiredAtOf(receiptId), "expired_at").not.toBeNull();
      expect(after.approvalRequestEnc, "approval_request_enc after the replay expires the review").toBeNull();
      expect(after.proposalEnc, "proposal_enc after the replay expires the review").toBeNull();
      expect(after.fieldEvidenceEnc, "field_evidence_enc after the replay expires the review").toBeNull();
      expect(after.approvalOperationId).toBe(before.approvalOperationId);
      expect(after.approvalRequestSha256).toBe(before.approvalRequestSha256);
      expect(after.approvedItemId).toBe(before.approvedItemId);
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });

  it("approving a lapsed unclaimed review answers expired and clears its draft, with no claim made", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-preclaim-expiry-clears");
    const member = await fixture.session("member");
    try {
      const receiptId = randomUUID();
      await seedReceipt(fixture, {
        id: receiptId, userId: fixture.users.member.id, householdId: fixture.household.id,
        ...await encryptedReceiptDraft(fixture.household.id, receiptId, { proposal: { title: "Draft preclaim" }, fieldEvidence: { title: { source: "subject" } } }),
      });
      const attachmentId = await seedAttachment(receiptId, fixture.users.member.id, "preclaim-expiry");
      const before = await reviewColumns(receiptId);
      // Positive control: the draft is held while the review is open.
      expect(before.status).toBe("pending_review");
      expect(before.proposalEnc, "proposal_enc while open").not.toBeNull();
      expect(before.fieldEvidenceEnc, "field_evidence_enc while open").not.toBeNull();
      await lapse(receiptId);

      await expectExpiredAnswer(await approve(member, payloadFor(fixture, receiptId, randomUUID(), { title: "Too late", attachmentIds: [attachmentId] })));
      const after = await reviewColumns(receiptId);
      expect(after.status).toBe("expired");
      expect(after.proposalEnc, "proposal_enc after the approve finds the review lapsed").toBeNull();
      expect(after.fieldEvidenceEnc, "field_evidence_enc after the approve finds the review lapsed").toBeNull();
      expect(after.approvalRequestEnc).toBeNull();
      expect(after.approvalOperationId).toBeNull();
      expect(after.approvalRequestSha256).toBeNull();
      expect(after.approvedItemId).toBeNull();
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });

  it("a purge failure after the expiry write does not bring the review back: the sweep finishes it and the pair still answers expired", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-expiry-purge-failure");
    const member = await fixture.session("member");
    try {
      const { receiptId, sent } = await seedPartialApproval(fixture, member, fixture.users.member.id, "expiry-purge-failure");
      const before = await reviewColumns(receiptId);
      expect(before.approvalRequestEnc, "approval_request_enc while open").not.toBeNull();
      expect(before.proposalEnc, "proposal_enc while open").not.toBeNull();
      expect(before.fieldEvidenceEnc, "field_evidence_enc while open").not.toBeNull();
      await lapse(receiptId);

      setImapHoldingPurgeImplementationForTests(async () => { throw new Error("synthetic purge failure"); });
      const failed = await approve(member, sent);
      expect(failed.status).toBe(503);
      expect(await failed.json()).toMatchObject({ error: { code: "staging_purge_failed" } });
      const reverted = await reviewColumns(receiptId);
      expect(reverted).toMatchObject({ status: "recoverable", failureCode: "staging_purge_failed" });
      // The review ended when expires_at passed: the purge is retried, the review is not reopened.
      expect(reverted.approvalRequestEnc, "approval_request_enc after the 503").toBeNull();
      expect(reverted.proposalEnc, "proposal_enc after the 503").toBeNull();
      expect(reverted.fieldEvidenceEnc, "field_evidence_enc after the 503").toBeNull();

      setImapHoldingPurgeImplementationForTests(undefined);
      await purgeExpiredImapStaging(new Date(), 100);
      const swept = await reviewColumns(receiptId);
      expect(swept.status).toBe("expired");
      expect(swept.approvalRequestEnc).toBeNull();
      expect(swept.proposalEnc).toBeNull();
      expect(swept.fieldEvidenceEnc).toBeNull();

      // The key and hash still answer without the stored request.
      await expectExpiredAnswer(await approve(member, sent));
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });

  it("document health stops counting a receipt whose approval replay found it lapsed", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-expiry-health-count");
    const member = await fixture.session("member");
    try {
      const { receiptId, sent } = await seedPartialApproval(fixture, member, fixture.users.member.id, "expiry-health");
      const lockedBefore = await lockedReceiptCount();
      expect(lockedBefore).toBeGreaterThanOrEqual(1);
      await lapse(receiptId);

      await expectExpiredAnswer(await approve(member, sent));
      expect((await reviewColumns(receiptId)).status).toBe("expired");
      expect(await lockedReceiptCount()).toBe(lockedBefore - 1);
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });
});

describe("approve retry: the inbox list reclaims an abandoned approval (L-R1)", () => {
  it("an abandoned approving receipt that made its item comes back retryable", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-list-reclaims-item");
    const member = await fixture.session("member");
    try {
      const { receiptId, operationId } = await seedPartialApproval(fixture, member, fixture.users.member.id, "list-item");
      await rewindToApproving(receiptId);
      expect(await reviewColumns(receiptId)).toMatchObject({ status: "approving", approvalOperationId: operationId, approvedItemId: operationId });

      const listed = (await listReceipts(member)).find((receipt) => receipt.id === receiptId);
      expect(listed).toMatchObject({ status: "recoverable", classification: "retry", canApprove: true, canDiscard: true });
      expect(await reviewColumns(receiptId)).toMatchObject({ status: "recoverable", failureCode: "approval_interrupted", approvedItemId: operationId });
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });

  it("an abandoned approving receipt with no item is reset to pending review", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-list-reclaims-no-item");
    const member = await fixture.session("member");
    try {
      const { receiptId } = await seedPartialApproval(fixture, member, fixture.users.member.id, "list-no-item");
      // A key that made no item (the attach_existing shape): nothing exists under it.
      await rewindToApproving(receiptId, { approvalOperationId: randomUUID(), approvedItemId: null });
      expect(await reviewColumns(receiptId)).toMatchObject({ status: "approving", approvedItemId: null });
      expect((await reviewColumns(receiptId)).approvalRequestEnc).not.toBeNull();

      const listed = (await listReceipts(member)).find((receipt) => receipt.id === receiptId);
      expect(listed).toMatchObject({ status: "pending_review", canApprove: true });
      const row = await reviewColumns(receiptId);
      expect(row).toMatchObject({ status: "pending_review", approvalOperationId: null, approvalRequestSha256: null, approvalRequestEnc: null, approvalStartedAt: null });
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });

  it("a fresh approving receipt is left alone (bound guard)", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-list-fresh");
    const member = await fixture.session("member");
    try {
      const { receiptId, operationId } = await seedPartialApproval(fixture, member, fixture.users.member.id, "list-fresh");
      await rewindToApproving(receiptId, { approvalStartedAt: freshAt(), updatedAt: freshAt() });

      const listed = (await listReceipts(member)).find((receipt) => receipt.id === receiptId);
      expect(listed).toMatchObject({ status: "approving", classification: "waiting" });
      expect(await reviewColumns(receiptId)).toMatchObject({ status: "approving", approvalOperationId: operationId });
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });

  it("another member's abandoned approving receipt is not touched by this member's list (scope guard)", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-list-scope");
    const member = await fixture.session("member");
    const owner = await fixture.session("owner");
    try {
      const theirs = await seedPartialApproval(fixture, owner, fixture.users.owner.id, "list-scope");
      await rewindToApproving(theirs.receiptId);

      await listReceipts(member);
      expect(await reviewColumns(theirs.receiptId)).toMatchObject({ status: "approving", failureCode: null, approvalOperationId: theirs.operationId });
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });
});

describe("approve retry: the reclaim remembers an item it never recorded (W-R1)", () => {
  /** The approval's kill landed between making the item and recording it: `approved_item_id` is NULL, the item exists under the key. */
  async function seedKilledBeforeRecording(fixture: Fixture, session: Session, label: string) {
    const seeded = await seedPartialApproval(fixture, session, fixture.users.member.id, label);
    await rewindToApproving(seeded.receiptId, { approvedItemId: null });
    expect(await reviewColumns(seeded.receiptId)).toMatchObject({
      status: "approving", approvalOperationId: seeded.operationId, approvedItemId: null, failureCode: null,
    });
    expect((await householdItemIds(fixture))).toContain(seeded.operationId);
    return seeded;
  }

  it("the review read finds the item under the key: recoverable, same key, and the pair finishes with one item", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-unrecorded-read");
    const member = await fixture.session("member");
    const before = await householdItemIds(fixture);
    try {
      const { receiptId, operationId } = await seedKilledBeforeRecording(fixture, member, "unrecorded-read");

      const read = await readReview(member, fixture, receiptId);
      expect(read.status).toBe(200);
      const review = await read.json() as { approval?: { operationId: string; request: ReportedRequest } };
      expect(await reviewColumns(receiptId)).toMatchObject({ status: "recoverable", failureCode: "approval_interrupted", approvedItemId: operationId });
      expect(review.approval?.operationId).toBe(operationId);

      const finished = await approve(member, { ...review.approval!.request, operationId });
      expect(finished.status).toBe(200);
      expect(await finished.json()).toMatchObject({ outcome: "approved", itemId: operationId });
      expect((await householdItemIds(fixture)).filter((id) => !before.includes(id))).toEqual([operationId]);
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });

  it("a fresh key after that kill makes no second item", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-unrecorded-fresh-key");
    const member = await fixture.session("member");
    const before = await householdItemIds(fixture);
    try {
      const { receiptId, operationId, attachmentId } = await seedKilledBeforeRecording(fixture, member, "unrecorded-fresh");

      const fresh = await approve(member, payloadFor(fixture, receiptId, randomUUID(), { title: "Typed title unrecorded-fresh", attachmentIds: [attachmentId] }));
      expect(fresh.status).toBe(409);
      expect((await fresh.json()).error.code).toBe("reviewed_intake_conflict");
      expect((await householdItemIds(fixture)).filter((id) => !before.includes(id))).toEqual([operationId]);
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });

  it("the replayed pair, with no read first, finishes with one item (the approve path backfills too)", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-unrecorded-approve");
    const member = await fixture.session("member");
    const before = await householdItemIds(fixture);
    try {
      const { receiptId, operationId, sent } = await seedKilledBeforeRecording(fixture, member, "unrecorded-approve");

      const replay = await approve(member, sent);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ outcome: "approved", itemId: operationId });
      expect((await householdItemIds(fixture)).filter((id) => !before.includes(id))).toEqual([operationId]);
      expect(await reviewColumns(receiptId)).toMatchObject({ status: "completed", approvedItemId: operationId });
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });

  it("a key with no item under it still resets (guard)", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-unrecorded-no-item");
    const member = await fixture.session("member");
    try {
      const { receiptId } = await seedPartialApproval(fixture, member, fixture.users.member.id, "unrecorded-none");
      await rewindToApproving(receiptId, { approvalOperationId: randomUUID(), approvedItemId: null });

      expect((await readReview(member, fixture, receiptId)).status).toBe(200);
      expect(await reviewColumns(receiptId)).toMatchObject({ status: "pending_review", approvalOperationId: null, approvedItemId: null });
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });

  it("household boundary: an item with the key's id in another household is not this approval's item (guard)", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-unrecorded-boundary");
    const member = await fixture.session("member");
    try {
      const { receiptId } = await seedPartialApproval(fixture, member, fixture.users.member.id, "unrecorded-boundary");
      const foreignKey = randomUUID();
      const [foreignSection] = await db().select({ id: sections.id }).from(sections).where(eq(sections.householdId, fixture.secondHousehold.id));
      await applyWorkspaceCommand(fixture.users.secondOwner.id, "retry-boundary-test", {
        type: "item.upsert",
        householdId: fixture.secondHousehold.id,
        item: { id: foreignKey, sectionId: foreignSection.id, title: "Another household's item", currency: "GBP", importance: "normal" },
      });
      await rewindToApproving(receiptId, { approvalOperationId: foreignKey, approvedItemId: null });

      expect((await readReview(member, fixture, receiptId)).status).toBe(200);
      expect(await reviewColumns(receiptId)).toMatchObject({ status: "pending_review", approvalOperationId: null, approvedItemId: null });
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });
});

describe("approve retry: an item with no stored request is a terminal state, discard the way out (O-F8, D-F6)", () => {
  /**
   * An `approving` receipt past the bound that already made its item, as a
   * v0.3.2 row is after the upgrade: a key, a hash and an item, but no stored
   * request (`approval_request_enc` null).
   */
  async function seedPreUpgradeApproving(fixture: Fixture, session: Session, operationId: string): Promise<string> {
    const receiptId = await seedReceipt(fixture);
    expect((await approve(session, payloadFor(fixture, receiptId, operationId, { title: "Made before the crash" }))).status).toBe(200);
    await rewindToApproving(receiptId, { approvalRequestEnc: null });
    expect(await receiptRow(receiptId)).toMatchObject({ status: "approving", approvalOperationId: operationId, approvedItemId: operationId });
    expect(await storedRequest(receiptId)).toBeNull();
    return receiptId;
  }

  /** A `recoverable` row after a partial approval, as v0.3.2 left it: item and key set, no stored request, time left. */
  async function seedPreUpgradeRecoverable(fixture: Fixture, session: Session, operationId: string): Promise<string> {
    const receiptId = await seedReceipt(fixture);
    expect((await approve(session, payloadFor(fixture, receiptId, operationId, { title: "Made before the upgrade" }))).status).toBe(200);
    await db().update(imapIngestionMessages).set({
      status: "recoverable", failureCode: "attachment_transfer_failed", approvalResultId: null, approvedAt: null, approvalRequestEnc: null, updatedAt: new Date(),
    }).where(eq(imapIngestionMessages.id, receiptId));
    expect(await receiptRow(receiptId)).toMatchObject({ status: "recoverable", approvalOperationId: operationId, approvedItemId: operationId });
    expect(await storedRequest(receiptId)).toBeNull();
    return receiptId;
  }

  type ReadReview = { approval?: unknown; receipt: { canApprove: boolean; canDiscard: boolean } };

  it("an abandoned pre-upgrade approving row lands in the terminal state on the review read, not back in review", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-preupgrade-read");
    const member = await fixture.session("member");
    const operationId = randomUUID();
    try {
      const receiptId = await seedPreUpgradeApproving(fixture, member, operationId);
      const bound = await receiptRow(receiptId);
      const read = await readReview(member, fixture, receiptId);
      expect(read.status).toBe(200);
      const review = await read.json() as ReadReview;
      expect(await receiptRow(receiptId)).toMatchObject({
        status: "recoverable", failureCode: "approval_interrupted",
        approvedItemId: operationId, approvalOperationId: operationId, approvalRequestSha256: bound.approvalRequestSha256,
      });
      expect(review).not.toHaveProperty("approval");
      expect(review.receipt).toMatchObject({ canApprove: false, canDiscard: true });
    } finally {
      await fixture.cleanup();
    }
  });

  it("a fresh key on a pre-upgrade approving row is refused and makes no second item", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-preupgrade-approve");
    const member = await fixture.session("member");
    const operationId = randomUUID();
    const before = await householdItemIds(fixture);
    try {
      const receiptId = await seedPreUpgradeApproving(fixture, member, operationId);
      const refused = await approve(member, payloadFor(fixture, receiptId, randomUUID(), { title: "Made before the crash" }));
      expect(refused.status).toBe(409);
      expect((await refused.json()).error.code).toBe("reviewed_intake_conflict");
      expect((await householdItemIds(fixture)).filter((id) => !before.includes(id))).toEqual([operationId]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("the inbox list shows a pre-upgrade approving row as removable, and discard works", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-preupgrade-list");
    const member = await fixture.session("member");
    try {
      const receiptId = await seedPreUpgradeApproving(fixture, member, randomUUID());
      const listed = (await listReceipts(member)).find((receipt) => receipt.id === receiptId);
      expect(listed).toMatchObject({ canApprove: false, canDiscard: true });
      expect(listed?.classification).not.toBe("waiting");

      expect((await discard(member, fixture, receiptId)).status).toBe(200);
      expect((await receiptRow(receiptId)).status).toBe("discarded");
    } finally {
      await fixture.cleanup();
    }
  });

  it("a pre-upgrade recoverable row (item, key, no request) is the same terminal state", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-preupgrade-recoverable");
    const member = await fixture.session("member");
    const operationId = randomUUID();
    const before = await householdItemIds(fixture);
    try {
      const receiptId = await seedPreUpgradeRecoverable(fixture, member, operationId);

      const read = await readReview(member, fixture, receiptId);
      expect(read.status).toBe(200);
      const review = await read.json() as ReadReview;
      expect(review).not.toHaveProperty("approval");
      expect(review.receipt).toMatchObject({ canApprove: false, canDiscard: true });

      const refused = await approve(member, payloadFor(fixture, receiptId, randomUUID(), { title: "Made before the upgrade" }));
      expect(refused.status).toBe(409);
      expect((await householdItemIds(fixture)).filter((id) => !before.includes(id))).toEqual([operationId]);

      const listed = (await listReceipts(member)).find((receipt) => receipt.id === receiptId);
      expect(listed).toMatchObject({ canApprove: false, canDiscard: true });
    } finally {
      await fixture.cleanup();
    }
  });
});

/*
 * #1568 part 2: a replay of a stored approval request must not outlive the
 * receipt. Once the receipt is discarded (or a discard is under way) the
 * matching-identity branch refuses, as the fresh-claim path already does:
 * 409 `reviewed_intake_not_approvable`, before any item is made or any
 * attachment transferred.
 */
describe("approve retry: a replay after discard is refused (#1568)", () => {
  const abandoned = () => new Date(Date.now() - 11 * 60_000);

  async function attachmentStatuses(receiptId: string): Promise<string[]> {
    return (await db().select({ status: imapIngestionAttachments.status }).from(imapIngestionAttachments)
      .where(eq(imapIngestionAttachments.messageId, receiptId))).map((row) => row.status);
  }

  /** An approval that made its item, then sat in `approving` past the reclaim timeout and was reclaimed by a read. */
  async function interrupted(fixture: Fixture, member: Session, label: string) {
    const receiptId = await seedReceipt(fixture);
    const attachmentId = await seedAttachment(receiptId, fixture.users.member.id, label);
    const operationId = randomUUID();
    const sent = payloadFor(fixture, receiptId, operationId, { title: `Made before the crash ${label}`, attachmentIds: [attachmentId] });
    await approveToPartial(member, sent);
    const stored = await storedRequest(receiptId);
    expect(stored).not.toBeNull();
    await db().update(imapIngestionMessages).set({
      status: "approving", approvalResultId: null, failureCode: null, approvalRequestEnc: stored, approvalStartedAt: abandoned(), updatedAt: abandoned(),
    }).where(eq(imapIngestionMessages.id, receiptId));
    expect((await readReview(member, fixture, receiptId)).status).toBe(200);
    expect(await receiptRow(receiptId)).toMatchObject({ status: "recoverable", failureCode: "approval_interrupted", approvedItemId: operationId });
    return { receiptId, attachmentId, operationId, sent };
  }

  async function expectRefused(response: Response) {
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatchObject({ code: "reviewed_intake_not_approvable" });
  }

  it("interrupted, discarded, then replayed: 409, no second item, the attachments stay rejected", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-discard-replay");
    const member = await fixture.session("member");
    const before = await householdItemIds(fixture);
    try {
      const { receiptId, operationId, sent } = await interrupted(fixture, member, "discard-replay");
      await discardImapReviewItem(fixture.users.member.id, receiptId);
      expect(await receiptRow(receiptId)).toMatchObject({ status: "discarded" });
      expect(await attachmentStatuses(receiptId)).toEqual(["rejected"]);

      await expectRefused(await approve(member, sent));
      expect(await receiptRow(receiptId)).toMatchObject({ status: "discarded" });
      expect(await attachmentStatuses(receiptId)).toEqual(["rejected"]);
      expect((await householdItemIds(fixture)).filter((id) => !before.includes(id))).toEqual([operationId]);
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });

  it.each(["staging_purge_pending", "discard_purge_failed"])("a replay while a discard is under way (%s) is refused the same way", async (failureCode) => {
    const fixture = await createIntegrationFixture(`reviewed-retry-discarding-${failureCode.replaceAll("_", "-")}`);
    const member = await fixture.session("member");
    const before = await householdItemIds(fixture);
    try {
      const { receiptId, operationId, sent } = await interrupted(fixture, member, `discarding-${failureCode}`);
      await db().update(imapIngestionMessages).set({ status: "recoverable", failureCode }).where(eq(imapIngestionMessages.id, receiptId));

      await expectRefused(await approve(member, sent));
      expect(await receiptRow(receiptId)).toMatchObject({ status: "recoverable", failureCode });
      expect(await attachmentStatuses(receiptId)).toEqual(["assigned"]);
      expect((await householdItemIds(fixture)).filter((id) => !before.includes(id))).toEqual([operationId]);
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });

  it("a replay of an interrupted approval that was not discarded still finishes it", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-interrupted-replay");
    const member = await fixture.session("member");
    const before = await householdItemIds(fixture);
    try {
      const { receiptId, operationId, sent } = await interrupted(fixture, member, "interrupted-replay");
      const finished = await approve(member, sent);
      expect(finished.status).toBe(200);
      expect(await finished.json()).toMatchObject({ outcome: "approved", itemId: operationId, pendingAttachmentIds: [] });
      expect(await receiptRow(receiptId)).toMatchObject({ status: "completed" });
      expect((await householdItemIds(fixture)).filter((id) => !before.includes(id))).toEqual([operationId]);
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });

  it("a replay of a partial transfer still retries and finishes it", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-partial-replay");
    const member = await fixture.session("member");
    const receiptId = await seedReceipt(fixture);
    const attachmentId = await seedAttachment(receiptId, fixture.users.member.id, "partial-replay");
    const operationId = randomUUID();
    const before = await householdItemIds(fixture);
    try {
      const sent = payloadFor(fixture, receiptId, operationId, { title: "Partial then retried", attachmentIds: [attachmentId] });
      await approveToPartial(member, sent);
      expect(await receiptRow(receiptId)).toMatchObject({ status: "recoverable" });
      const retry = await approve(member, sent);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ outcome: "approved", itemId: operationId, pendingAttachmentIds: [] });
      expect(await receiptRow(receiptId)).toMatchObject({ status: "completed" });
      expect((await householdItemIds(fixture)).filter((id) => !before.includes(id))).toEqual([operationId]);
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });
});
