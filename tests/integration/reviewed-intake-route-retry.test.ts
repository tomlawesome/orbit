import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { imapIngestionAttachments, imapIngestionMessages, items } from "@/db/schema";
import { scanAndHoldImapAttachment, setImapHoldingPurgeImplementationForTests } from "@/server/mail-in/imap-attachment-holding";
import { openMetadataReader } from "@/server/metadata/fields";
import { canonicalReviewedIntakeHash } from "@/server/reviewed-intake";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
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
const { GET: getReceipt } = await loadRoute("imap-inbox/[receiptId]");
const { GET: getInbox } = await loadRoute("imap-inbox");

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;
type Session = Awaited<ReturnType<Fixture["session"]>>;

/** The request the review read reports beside its key. */
type ReportedRequest = Record<string, unknown> & { item: { title?: unknown } };

const APPROVE_URL = "http://127.0.0.1:3000/api/reviewed-intake/approve";
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
    item: { kind: "service", title: overrides.title ?? "Retry value", currency: "GBP", status: "active" },
    attachmentIds: overrides.attachmentIds ?? [],
  };
}

async function seedReceipt(fixture: Fixture, over: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
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

describe("approve retry: receipts stored before this change keep the old reclaim (#1396)", () => {
  const abandoned = () => new Date(Date.now() - 11 * 60_000);

  /**
   * An `approving` receipt past the bound that already made its item, as one
   * written before #1396 was: it has a key, a hash and an item, but no stored
   * request (`approval_request_enc` null).
   */
  async function seedPreChangeReceipt(fixture: Fixture, session: Session, operationId: string): Promise<string> {
    const receiptId = await seedReceipt(fixture);
    expect((await approve(session, payloadFor(fixture, receiptId, operationId, { title: "Made before the crash" }))).status).toBe(200);
    await db().update(imapIngestionMessages).set({
      status: "approving", approvalResultId: null, failureCode: null, approvalRequestEnc: null, approvalStartedAt: abandoned(), updatedAt: abandoned(),
    }).where(eq(imapIngestionMessages.id, receiptId));
    expect(await receiptRow(receiptId)).toMatchObject({ status: "approving", approvalOperationId: operationId, approvedItemId: operationId });
    expect(await storedRequest(receiptId)).toBeNull();
    return receiptId;
  }

  it("the review read does not move it to recoverable/approval_interrupted: it stays approving, as before, with no pair to report", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-prechange-read");
    const member = await fixture.session("member");
    const operationId = randomUUID();
    try {
      const receiptId = await seedPreChangeReceipt(fixture, member, operationId);
      const read = await readReview(member, fixture, receiptId);
      expect(read.status).toBe(200);
      expect(await read.json()).not.toHaveProperty("approval");
      const row = await receiptRow(receiptId);
      expect(row.failureCode).not.toBe("approval_interrupted");
      expect(row).toMatchObject({ status: "approving", failureCode: null, approvalOperationId: operationId });
    } finally {
      await fixture.cleanup();
    }
  });

  it("an approve with a fresh key takes the old path (reset to pending review, then claimed afresh), not a 409 over a pair that cannot be reported", async () => {
    const fixture = await createIntegrationFixture("reviewed-retry-prechange-approve");
    const member = await fixture.session("member");
    const operationId = randomUUID();
    const freshKey = randomUUID();
    try {
      const receiptId = await seedPreChangeReceipt(fixture, member, operationId);
      const response = await approve(member, payloadFor(fixture, receiptId, freshKey, { title: "Made before the crash" }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ outcome: "approved", itemId: freshKey });
      expect(await receiptRow(receiptId)).toMatchObject({ status: "completed", failureCode: null, approvalOperationId: freshKey, approvedItemId: freshKey });
    } finally {
      await fixture.cleanup();
    }
  });
});
