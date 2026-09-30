import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { documents, imapIngestionAttachments, imapIngestionMessages } from "@/db/schema";
import { getDocumentConfig } from "@/server/documents/config";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { holdImapAttachment } from "@/server/mail-in/imap-attachment-holding";
import { discardImapReviewItem, purgeExpiredImapStaging } from "@/server/imap-inbox";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";
import { callRoute, callRouteForSession, loadRoute } from "./support/request-event";
import { syntheticPdf } from "../support/synthetic-documents";

/**
 * The staged-attachment preview route's authorization boundary (#1155):
 * every case that is not the recipient's own live, stored attachment answers
 * the same 404 `inbox_receipt_not_found` a missing mail does -- never a 403,
 * which would tell another user the attachment exists. Mirrors the pattern
 * `imap-inbox-review.test.ts` uses for `getImapReview`'s own boundary.
 *
 * A real PDF is held through `holdImapAttachment` (not a stub), so decryption
 * and rendering are both exercised for real, the way
 * `document-lifecycle.test.ts`'s "document page-one preview over HTTP" block
 * proves the accepted-document route.
 */
const { GET: previewAttachment } = await loadRoute("imap-inbox/[receiptId]/attachments/[attachmentId]/preview");

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

/**
 * Seeds one staged receipt with one real, held PDF attachment -- the
 * recipient is the fixture's `member` unless overridden.
 */
async function seedStagedReceipt(fixture: IntegrationFixture, options: {
  recipientUserId?: string;
  householdId?: string | null;
  messageStatus?: "pending_review" | "approving";
  expiresAt?: Date;
  attachmentStatus?: "stored" | "assigned" | "rejected";
  purgePending?: boolean;
} = {}) {
  const receiptId = randomUUID();
  const recipientUserId = options.recipientUserId ?? fixture.users.member.id;
  const held = await holdImapAttachment({
    bytes: syntheticPdf("staged preview fixture"),
    displayName: "policy-schedule.pdf",
    mediaType: "application/pdf",
    recipientUserId,
    receiptId,
  });
  await getDb().insert(imapIngestionMessages).values({
    id: receiptId,
    mailbox: "private",
    mailboxUidValidity: `staged-preview-${receiptId.slice(0, 8)}`,
    mailboxUid: 900,
    contentSha256: randomUUID().replaceAll("-", ""),
    recipientAliasSha256: `staged-preview-alias-${receiptId.slice(0, 8)}`,
    userId: recipientUserId,
    householdId: options.householdId === undefined ? fixture.household.id : options.householdId,
    status: options.messageStatus ?? "pending_review",
    expiresAt: options.expiresAt ?? new Date(Date.now() + 86_400_000),
    receiptStatus: "pending",
  });
  await getDb().insert(imapIngestionAttachments).values({
    id: held.id,
    messageId: receiptId,
    displayName: held.displayName,
    mediaType: held.mediaType,
    sizeBytes: held.sizeBytes,
    contentSha256: held.contentSha256,
    storageKey: held.storageKey,
    ciphertextSize: held.ciphertextSize,
    ...held.envelope,
    status: options.attachmentStatus ?? "stored",
    purgePending: options.purgePending ?? false,
  });
  return { receiptId, attachmentId: held.id, storageKey: held.storageKey, recipientUserId };
}

/** @param {string} receiptId @param {string} attachmentId */
function previewUrl(receiptId: string, attachmentId: string): string {
  return `http://127.0.0.1:3000/api/imap-inbox/${receiptId}/attachments/${attachmentId}/preview`;
}

describe("the staged attachment preview route", () => {
  it("answers nothing without a session", async () => {
    const fixture = await createIntegrationFixture("staged-preview-anonymous");
    const { receiptId, attachmentId } = await seedStagedReceipt(fixture);

    const response = await callRoute(previewAttachment, {
      url: previewUrl(receiptId, attachmentId),
      params: { receiptId, attachmentId },
    });

    expect(response.status).toBe(401);
    await fixture.cleanup();
  });

  it("answers a real rendered page under the documents preview route's own headers, and creates no documents row", async () => {
    const fixture = await createIntegrationFixture("staged-preview-recipient");
    const { receiptId, attachmentId, recipientUserId } = await seedStagedReceipt(fixture);
    const before = await getDb().select({ id: documents.id }).from(documents);
    const member = await fixture.session("member");
    expect(member.userId).toBe(recipientUserId);

    const response = await callRouteForSession(previewAttachment, member, {
      url: previewUrl(receiptId, attachmentId),
      params: { receiptId, attachmentId },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const body = Buffer.from(await response.arrayBuffer());
    expect(response.headers.get("content-length")).toBe(String(body.length));
    // PNG magic bytes: a real render, not a stub standing in for one.
    expect(body.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const after = await getDb().select({ id: documents.id }).from(documents);
    expect(after.length).toBe(before.length);
    await fixture.cleanup();
  });

  it("refuses another member of the same household, an outsider and an instance admin -- the same 404, and never names the file", async () => {
    const fixture = await createIntegrationFixture("staged-preview-others");
    const { receiptId, attachmentId } = await seedStagedReceipt(fixture);

    for (const role of ["owner", "outsider", "admin"] as const) {
      const session = await fixture.session(role);
      const response = await callRouteForSession(previewAttachment, session, {
        url: previewUrl(receiptId, attachmentId),
        params: { receiptId, attachmentId },
      });
      expect(response.status, `role=${role}`).toBe(404);
      const body = await response.text();
      expect(body).not.toContain("policy-schedule");
      expect(JSON.parse(body)).toEqual({
        error: { code: "inbox_receipt_not_found", message: "That incoming document is not available" },
      });
    }
    await fixture.cleanup();
  });

  it("refuses the right attachment id under a different receipt id, even one the recipient owns", async () => {
    const fixture = await createIntegrationFixture("staged-preview-wrong-receipt");
    const { attachmentId } = await seedStagedReceipt(fixture);
    const { receiptId: otherReceiptId } = await seedStagedReceipt(fixture);
    const member = await fixture.session("member");

    const response = await callRouteForSession(previewAttachment, member, {
      url: previewUrl(otherReceiptId, attachmentId),
      params: { receiptId: otherReceiptId, attachmentId },
    });

    expect(response.status).toBe(404);
    await fixture.cleanup();
  });

  it("bounds malformed ids to 404 instead of a driver-error 500 (#383's pattern)", async () => {
    const fixture = await createIntegrationFixture("staged-preview-malformed");
    const member = await fixture.session("member");

    const response = await callRouteForSession(previewAttachment, member, {
      url: previewUrl("not-a-uuid", "also-not-a-uuid"),
      params: { receiptId: "not-a-uuid", attachmentId: "also-not-a-uuid" },
    });

    expect(response.status).toBe(404);
    await fixture.cleanup();
  });

  it("refuses while the receipt is mid-approval, or the attachment has already transferred", async () => {
    const fixture = await createIntegrationFixture("staged-preview-in-flight");
    const approving = await seedStagedReceipt(fixture, { messageStatus: "approving" });
    const assigned = await seedStagedReceipt(fixture, { attachmentStatus: "assigned" });
    const member = await fixture.session("member");

    for (const { receiptId, attachmentId } of [approving, assigned]) {
      const response = await callRouteForSession(previewAttachment, member, {
        url: previewUrl(receiptId, attachmentId),
        params: { receiptId, attachmentId },
      });
      expect(response.status).toBe(404);
    }
    await fixture.cleanup();
  });

  it("refuses once expiresAt has passed, before any sweep runs", async () => {
    const fixture = await createIntegrationFixture("staged-preview-expired");
    const { receiptId, attachmentId } = await seedStagedReceipt(fixture, { expiresAt: new Date(Date.now() - 1000) });
    const member = await fixture.session("member");

    const response = await callRouteForSession(previewAttachment, member, {
      url: previewUrl(receiptId, attachmentId),
      params: { receiptId, attachmentId },
    });

    expect(response.status).toBe(404);
    await fixture.cleanup();
  });

  it("refuses after discardImapReviewItem, and the bytes are actually gone", async () => {
    const fixture = await createIntegrationFixture("staged-preview-discarded");
    const { receiptId, attachmentId, storageKey, recipientUserId } = await seedStagedReceipt(fixture);
    await discardImapReviewItem(recipientUserId, receiptId);
    const member = await fixture.session("member");

    const response = await callRouteForSession(previewAttachment, member, {
      url: previewUrl(receiptId, attachmentId),
      params: { receiptId, attachmentId },
    });

    expect(response.status).toBe(404);
    const config = getDocumentConfig();
    const storage = new LocalDocumentStorage(config.storageRoot, config.quarantineRoot);
    expect(await storage.ciphertextExists(storageKey)).toBe(false);
    await fixture.cleanup();
  });

  it("refuses after the 45-day sweep purges an expired receipt", async () => {
    const fixture = await createIntegrationFixture("staged-preview-swept");
    const { receiptId, attachmentId } = await seedStagedReceipt(fixture, { expiresAt: new Date(Date.now() - 1000) });
    await purgeExpiredImapStaging(new Date());
    const member = await fixture.session("member");

    const response = await callRouteForSession(previewAttachment, member, {
      url: previewUrl(receiptId, attachmentId),
      params: { receiptId, attachmentId },
    });

    expect(response.status).toBe(404);
    // The sweep's own contract: a live row past its date is a refusal on the
    // status columns alone, not just on the id no longer resolving.
    const [row] = await getDb().select({ status: imapIngestionMessages.status })
      .from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId));
    expect(row?.status).not.toBe("pending_review");
    await fixture.cleanup();
  });
});
