import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { GET as getOperations } from "@/app/api/admin/operations/route";
import { POST as verifyImap } from "@/app/api/admin/operations/imap-test/route";
import { POST as retryMailboxNotifications } from "@/app/api/admin/operations/mailbox-notifications/route";
import { getDb } from "@/db";
import { imapIngestionMessages, imapNotificationDeliveries } from "@/db/schema";
import { requestForSession, requestWithoutSession, createIntegrationFixture } from "./support/fixtures";
import {
  claimImapNotificationsForTests,
  cancelDisabledImapNotificationForTests,
  markImapNotificationFailureForTests,
  materializeImapNotificationsForTests,
} from "@/server/imap-receipt-worker";

const adminVerifyUrl = "http://127.0.0.1:3000/api/admin/operations/imap-test";
const adminRetryUrl = "http://127.0.0.1:3000/api/admin/operations/mailbox-notifications";

function expectNoStore(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("no-store");
}

describe("PostgreSQL mailbox notification lifecycle", () => {
  it("materializes only bounded eligible batches, stays idempotent, and excludes disabled users", async () => {
    const fixture = await createIntegrationFixture("imap-notification-materialize");
    try {
      await fixture.disableUser("disabled");
      const activeMessages = await getDb().insert(imapIngestionMessages).values(Array.from({ length: 5 }, (_, index) => ({
        mailbox: "private", mailboxUidValidity: "bounded", mailboxUid: 200 + index,
        contentSha256: randomUUID().replaceAll("-", ""), recipientAliasSha256: `bounded-${index}`,
        userId: fixture.users.member.id, householdId: fixture.household.id, status: "pending_review" as const,
        proposal: { privateMarker: `private-${index}` }, expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending" as const,
      }))).returning({ id: imapIngestionMessages.id });
      const [disabledMessage] = await getDb().insert(imapIngestionMessages).values({
        mailbox: "private", mailboxUidValidity: "bounded-disabled", mailboxUid: 300,
        contentSha256: randomUUID().replaceAll("-", ""), recipientAliasSha256: "bounded-disabled",
        userId: fixture.users.disabled.id, householdId: fixture.household.id, status: "pending_review",
        proposal: { privateMarker: "disabled-private" }, expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending",
      }).returning({ id: imapIngestionMessages.id });

      expect(await materializeImapNotificationsForTests(new Date(), 2, fixture.users.member.id)).toBe(4);
      expect(await materializeImapNotificationsForTests(new Date(), 10, fixture.users.member.id)).toBe(6);
      expect(await materializeImapNotificationsForTests(new Date(), 10, fixture.users.member.id)).toBe(0);

      const rows = await getDb().select({ messageId: imapNotificationDeliveries.messageId, kind: imapNotificationDeliveries.kind })
        .from(imapNotificationDeliveries)
        .where(inArray(imapNotificationDeliveries.messageId, activeMessages.map(({ id }) => id)));
      expect(rows).toHaveLength(10);
      expect(new Set(rows.map((row) => `${row.messageId}:${row.kind}`)).size).toBe(10);
      expect(rows.some((row) => row.messageId === disabledMessage.id)).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("claims concurrently, fences stale leases, and records bounded retry then exhaustion", async () => {
    const fixture = await createIntegrationFixture("imap-notification-claims");
    try {
      const messages = await getDb().insert(imapIngestionMessages).values(Array.from({ length: 4 }, (_, index) => ({
        mailbox: "private", mailboxUidValidity: "claims", mailboxUid: 400 + index,
        contentSha256: randomUUID().replaceAll("-", ""), recipientAliasSha256: `claims-${index}`,
        userId: fixture.users.member.id, householdId: fixture.household.id, status: "pending_review" as const,
        expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "sent" as const,
      }))).returning({ id: imapIngestionMessages.id });
      await getDb().insert(imapNotificationDeliveries).values(messages.map(({ id }) => ({
        messageId: id, userId: fixture.users.member.id, kind: "review_ready" as const,
      })));

      const now = new Date();
      const [first, second] = await Promise.all([
        claimImapNotificationsForTests(now, 2, messages.map(({ id }) => id)),
        claimImapNotificationsForTests(now, 2, messages.map(({ id }) => id)),
      ]);
      const claimed = [...first, ...second];
      expect(claimed).toHaveLength(4);
      expect(new Set(claimed.map(({ id }) => id)).size).toBe(4);

      const stale = claimed[0];
      await getDb().update(imapNotificationDeliveries).set({ lockedAt: new Date(now.getTime() - 11 * 60_000) })
        .where(eq(imapNotificationDeliveries.id, stale.id));
      const replacement = (await claimImapNotificationsForTests(now, 1, messages.map(({ id }) => id)))[0];
      expect(replacement.id).toBe(stale.id);
      expect(replacement.leaseToken).not.toBe(stale.leaseToken);
      const fenced = await getDb().update(imapNotificationDeliveries).set({ status: "sent" })
        .where(and(eq(imapNotificationDeliveries.id, stale.id), eq(imapNotificationDeliveries.leaseToken, stale.leaseToken)))
        .returning({ id: imapNotificationDeliveries.id });
      expect(fenced).toHaveLength(0);

      await markImapNotificationFailureForTests({
        id: replacement.id, leaseToken: replacement.leaseToken, attempts: 1, maxAttempts: 2,
        category: "smtp_unavailable", now,
      });
      expect((await getDb().select({ status: imapNotificationDeliveries.status }).from(imapNotificationDeliveries).where(eq(imapNotificationDeliveries.id, replacement.id)))[0]?.status).toBe("retry");
      await getDb().update(imapNotificationDeliveries).set({ nextAttemptAt: now }).where(eq(imapNotificationDeliveries.id, replacement.id));
      const retryClaim = (await claimImapNotificationsForTests(now, 1, messages.map(({ id }) => id)))[0];
      await markImapNotificationFailureForTests({
        id: retryClaim.id, leaseToken: retryClaim.leaseToken, attempts: 2, maxAttempts: 2,
        category: "smtp_unavailable", now,
      });
      expect((await getDb().select({ status: imapNotificationDeliveries.status }).from(imapNotificationDeliveries).where(eq(imapNotificationDeliveries.id, replacement.id)))[0]?.status).toBe("failed");
    } finally {
      await fixture.cleanup();
    }
  });

  it("cancels a claimed delivery when the recipient is disabled before dispatch", async () => {
    const fixture = await createIntegrationFixture("imap-notification-disabled");
    try {
      await fixture.disableUser("disabled");
      const [message] = await getDb().insert(imapIngestionMessages).values({
        mailbox: "private", mailboxUidValidity: "disabled", mailboxUid: 500,
        contentSha256: randomUUID().replaceAll("-", ""), recipientAliasSha256: "disabled",
        userId: fixture.users.disabled.id, householdId: fixture.household.id, status: "pending_review",
        expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "sent",
      }).returning({ id: imapIngestionMessages.id });
      await getDb().insert(imapNotificationDeliveries).values({
        messageId: message.id, userId: fixture.users.disabled.id, kind: "review_ready",
      });
      const [delivery] = await getDb().select({ id: imapNotificationDeliveries.id }).from(imapNotificationDeliveries)
        .where(eq(imapNotificationDeliveries.messageId, message.id));
      if (!delivery) throw new Error("Synthetic disabled delivery was not persisted");
      const claimed = (await claimImapNotificationsForTests(new Date(), 1, [delivery.id]))[0];
      if (!claimed) throw new Error("Synthetic disabled delivery was not claimable");
      expect(await cancelDisabledImapNotificationForTests(claimed.id, claimed.leaseToken)).toBe(true);
      expect((await getDb().select({ status: imapNotificationDeliveries.status }).from(imapNotificationDeliveries).where(eq(imapNotificationDeliveries.messageId, message.id)))[0]?.status).toBe("cancelled");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("administrator mailbox operation boundaries", () => {
  it("denies signed-out, non-admin, missing-CSRF, and wrong-CSRF requests with no-store responses", async () => {
    const fixture = await createIntegrationFixture("imap-admin-auth");
    try {
      const member = await fixture.session("member");
      const admin = await fixture.session("admin");
      for (const [url, body] of [[adminVerifyUrl, undefined], [adminRetryUrl, JSON.stringify({ action: "retry_exhausted" })]] as const) {
        const signedOut = await (url === adminVerifyUrl ? verifyImap : retryMailboxNotifications)(requestWithoutSession(url, { method: "POST", body, headers: { "content-type": "application/json" } }));
        expect(signedOut.status).toBe(401);
        expectNoStore(signedOut);
        const nonAdmin = await (url === adminVerifyUrl ? verifyImap : retryMailboxNotifications)(requestForSession(member, url, { method: "POST", body, headers: { "content-type": "application/json" } }));
        expect(nonAdmin.status).toBe(403);
        expectNoStore(nonAdmin);
        const missingCsrf = await (url === adminVerifyUrl ? verifyImap : retryMailboxNotifications)(requestForSession(admin, url, { method: "POST", body, headers: { "content-type": "application/json", "x-csrf-token": "" } }));
        expect(missingCsrf.status).toBe(403);
        expectNoStore(missingCsrf);
        expect((await missingCsrf.json()).error.code).toBe("csrf_failed");
        const wrongCsrf = await (url === adminVerifyUrl ? verifyImap : retryMailboxNotifications)(requestForSession(admin, url, { method: "POST", body, headers: { "content-type": "application/json", "x-csrf-token": "wrong" } }));
        expect(wrongCsrf.status).toBe(403);
        expectNoStore(wrongCsrf);
        expect((await wrongCsrf.json()).error.code).toBe("csrf_failed");
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("returns only safe operation output and does not expose or alter private receipt content", async () => {
    const fixture = await createIntegrationFixture("imap-admin-private-boundary");
    try {
      const admin = await fixture.session("admin");
      const [message] = await getDb().insert(imapIngestionMessages).values({
        mailbox: "private", mailboxUidValidity: "admin-private", mailboxUid: 600,
        contentSha256: randomUUID().replaceAll("-", ""), recipientAliasSha256: "admin-private",
        userId: fixture.users.member.id, householdId: fixture.household.id, status: "pending_review",
        proposal: { title: "Private receipt marker" }, expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "sent",
      }).returning({ id: imapIngestionMessages.id });
      await getDb().insert(imapNotificationDeliveries).values({
        messageId: message.id, userId: fixture.users.member.id, kind: "review_ready", status: "failed",
      });
      const before = (await getDb().select({ proposal: imapIngestionMessages.proposal, status: imapIngestionMessages.status }).from(imapIngestionMessages).where(eq(imapIngestionMessages.id, message.id)))[0];
      const verifyResponse = await verifyImap(requestForSession(admin, adminVerifyUrl, { method: "POST" }));
      const retryResponse = await retryMailboxNotifications(requestForSession(admin, adminRetryUrl, { method: "POST", body: JSON.stringify({ action: "retry_exhausted" }), headers: { "content-type": "application/json" } }));
      const operationsResponse = await getOperations(requestForSession(admin, "http://127.0.0.1:3000/api/admin/operations"));
      for (const response of [verifyResponse, retryResponse, operationsResponse]) {
        expect(response.status).toBe(200);
        expectNoStore(response);
        expect(await response.clone().text()).not.toContain("Private receipt marker");
      }
      expect(await retryResponse.json()).toEqual({ queued: 1 });
      const after = (await getDb().select({ proposal: imapIngestionMessages.proposal, status: imapIngestionMessages.status }).from(imapIngestionMessages).where(eq(imapIngestionMessages.id, message.id)))[0];
      expect(after).toEqual(before);
    } finally {
      await fixture.cleanup();
    }
  });
});
