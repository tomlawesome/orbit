import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { imapIngestionAttachments, imapIngestionMessages } from "@/db/schema";
import { scanAndHoldImapAttachment, setImapHoldingPurgeImplementationForTests } from "@/server/imap-attachment-holding";
import { createIntegrationFixture } from "./support/fixtures";
import { callRoute, callRouteForSession, loadRoute } from "./support/request-event";
import { syntheticPdf } from "../support/synthetic-documents";

const { POST } = await loadRoute("reviewed-intake/approve");
const { GET: getReceipt } = await loadRoute("imap-inbox/[receiptId]");

function body(fixture: Awaited<ReturnType<typeof createIntegrationFixture>>, overrides: Record<string, unknown> = {}) {
  return {
    operationId: "11111111-1111-4111-8111-111111111111",
    source: { kind: "direct_upload", expectedDocument: false },
    householdId: fixture.household.id,
    sectionId: fixture.section.id,
    action: "create_separate",
    item: { title: "Reviewed route item", currency: "GBP", status: "active" },
    attachmentIds: [],
    ...overrides,
  };
}

function approve(session: Awaited<ReturnType<Awaited<ReturnType<typeof createIntegrationFixture>>["session"]>>, url: string, payload: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return callRouteForSession(POST, session, {
    url,
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

describe("POST /api/reviewed-intake/approve security contract", () => {
  it("rejects signed-out and CSRF-failed requests with no-store sanitized errors", async () => {
    const fixture = await createIntegrationFixture("reviewed-route-auth");
    const url = `http://127.0.0.1:3000/api/reviewed-intake/approve`;
    const signedOut = await callRoute(POST, { url, method: "POST", body: "{}" });
    expect(signedOut.status).toBe(401);
    expect(signedOut.headers.get("cache-control")).toBe("no-store");
    const member = await fixture.session("member");
    const csrf = await approve(member, url, body(fixture), { "x-csrf-token": "wrong" });
    expect(csrf.status).toBe(403);
    expect(await csrf.json()).toEqual({ error: { code: "csrf_failed", message: "The CSRF token is missing or invalid" } });
    expect(csrf.headers.get("cache-control")).toBe("no-store");
    await fixture.cleanup();
  });

  it("does not disclose a mailbox receipt to another user and rejects altered replay", async () => {
    const fixture = await createIntegrationFixture("reviewed-route-replay");
    const member = await fixture.session("member");
    const outsider = await fixture.session("outsider");
    const [receipt] = await getDb().insert(imapIngestionMessages).values({
      mailbox: "private", mailboxUidValidity: "1", mailboxUid: Math.floor(Math.random() * 1000000),
      contentSha256: crypto.randomUUID().replaceAll("-", ""), recipientAliasSha256: "alias",
      userId: fixture.users.member.id, householdId: fixture.household.id, status: "pending_review",
      expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending",
    }).returning({ id: imapIngestionMessages.id });
    const url = "http://127.0.0.1:3000/api/reviewed-intake/approve";
    const mailbox = body(fixture, { source: { kind: "mailbox_draft", receiptId: receipt.id, draftVersion: 1 }, operationId: "33333333-3333-4333-8333-333333333333" });
    const hidden = await approve(outsider, url, mailbox);
    expect(hidden.status).toBe(404);
    const first = await approve(member, url, body(fixture));
    expect(first.status).toBe(200);
    const altered = await approve(member, url, body(fixture, { item: { title: "Altered", currency: "GBP", status: "active" } }));
    expect(altered.status).toBe(409);
    expect((await altered.json()).error).toEqual({ code: "reviewed_intake_conflict", message: "That approval identity was already used" });
    await fixture.cleanup();
  });

  it("covers disabled membership, destination, target, stale-version, and cache boundaries", async () => {
    const fixture = await createIntegrationFixture("reviewed-route-boundaries");
    const member = await fixture.session("member");
    const disabled = await fixture.session("disabled");
    const url = "http://127.0.0.1:3000/api/reviewed-intake/approve";
    await fixture.disableUser("disabled");
    const disabledResponse = await approve(disabled, url, body(fixture));
    expect(disabledResponse.status).toBe(401);
    expect(disabledResponse.headers.get("cache-control")).toBe("no-store");

    const removedFixture = await createIntegrationFixture("reviewed-route-removed");
    const removedMember = await removedFixture.session("member");
    await removedFixture.removeMember();
    const removed = await approve(removedMember, url, body(removedFixture));
    expect(removed.status).toBe(404);
    expect(await removed.json()).toEqual({ error: { code: "household_not_found", message: "That household is not available" } });

    const wrongTarget = await approve(member, url, body(fixture, { targetItemId: fixture.secondItem.id, action: "attach_existing" }));
    expect(wrongTarget.status).toBe(404);
    expect((await wrongTarget.json()).error.code).toBe("item_not_found");
    const wrongHousehold = await approve(member, url, body(fixture, { householdId: fixture.secondHousehold.id }));
    expect(wrongHousehold.status).toBe(404);
    expect((await wrongHousehold.json()).error.code).toBe("household_not_found");
    const wrongSection = await approve(member, url, body(fixture, { sectionId: "55555555-5555-4555-8555-555555555555" }));
    expect(wrongSection.status).toBe(404);
    expect((await wrongSection.json()).error.code).toBe("section_not_found");

    const [receipt] = await getDb().insert(imapIngestionMessages).values({
      mailbox: "private", mailboxUidValidity: "2", mailboxUid: 9001,
      contentSha256: crypto.randomUUID().replaceAll("-", ""), recipientAliasSha256: "stale-alias",
      userId: fixture.users.member.id, householdId: fixture.household.id, draftVersion: 2, status: "pending_review",
      expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending",
    }).returning({ id: imapIngestionMessages.id });
    const stale = await approve(member, url, body(fixture, { source: { kind: "mailbox_draft", receiptId: receipt.id, draftVersion: 1 }, operationId: "44444444-4444-4444-8444-444444444444" }));
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("reviewed_intake_stale");
    await fixture.cleanup();
    await removedFixture.cleanup();
  });

  it("accepts a retry with the same operation id and the draftVersion the GET reports after a partial_success", async () => {
    const fixture = await createIntegrationFixture("reviewed-route-partial-retry");
    const member = await fixture.session("member");
    const url = "http://127.0.0.1:3000/api/reviewed-intake/approve";
    const receiptId = randomUUID();
    const held = await scanAndHoldImapAttachment({
      bytes: syntheticPdf("partial retry"), filename: "partial-retry.pdf", declaredMediaType: "application/pdf",
      recipientUserId: fixture.users.member.id, receiptId,
    });
    await getDb().insert(imapIngestionMessages).values({
      id: receiptId, mailbox: "private", mailboxUidValidity: "partialretry", mailboxUid: 8101,
      contentSha256: randomUUID().replaceAll("-", ""), recipientAliasSha256: "partialretry",
      userId: fixture.users.member.id, householdId: fixture.household.id, draftVersion: 1, status: "pending_review",
      expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending",
    });
    await getDb().insert(imapIngestionAttachments).values({
      id: held.id, messageId: receiptId, displayName: held.displayName, mediaType: held.mediaType,
      sizeBytes: held.sizeBytes, contentSha256: held.contentSha256, storageKey: held.storageKey,
      ciphertextSize: held.ciphertextSize, ...held.envelope, status: "stored",
    });
    const operationId = randomUUID();
    const payload = (draftVersion: number) => body(fixture, {
      operationId,
      source: { kind: "mailbox_draft", receiptId, draftVersion },
      action: "create_separate",
      item: { title: "Partial retry value", currency: "GBP", status: "active" },
      attachmentIds: [held.id],
    });
    try {
      // The first approve fails in the attachment step (the failure seam the
      // concurrency suite uses for partial_success) and leaves the attachment pending.
      setImapHoldingPurgeImplementationForTests(async () => {
        setImapHoldingPurgeImplementationForTests(undefined);
        throw new Error("synthetic purge failure");
      });
      const first = await approve(member, url, payload(1));
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ outcome: "partial_success", pendingAttachmentIds: [held.id] });

      // The retry carries whatever draft version the review read reports.
      const read = await callRouteForSession(getReceipt, member, {
        url: `http://127.0.0.1:3000/api/imap-inbox/${receiptId}?householdId=${fixture.household.id}`,
        params: { receiptId },
      });
      expect(read.status).toBe(200);
      const reported = (await read.json() as { receipt: { draftVersion: number } }).receipt.draftVersion;

      const retry = await approve(member, url, payload(reported));
      // A bumped version here would not match the stored request hash and give 409 reviewed_intake_conflict.
      expect(await retry.clone().json()).not.toMatchObject({ error: { code: "reviewed_intake_conflict" } });
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ outcome: "approved", attachedAttachmentIds: [held.id], pendingAttachmentIds: [] });

      const [receipt] = await getDb().select({ status: imapIngestionMessages.status, approvalOperationId: imapIngestionMessages.approvalOperationId })
        .from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId));
      expect(receipt).toMatchObject({ status: "completed", approvalOperationId: operationId });
      const [attachment] = await getDb().select({ assignedDocumentId: imapIngestionAttachments.assignedDocumentId })
        .from(imapIngestionAttachments).where(eq(imapIngestionAttachments.id, held.id));
      expect(attachment.assignedDocumentId).not.toBeNull();
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });
});
