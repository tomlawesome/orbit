import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { imapIngestionMessages, metadataKeyOutages } from "@/db/schema";
import { resetDocumentConfigForTests } from "@/server/documents/config";
import { metadataCryptoAvailable } from "@/server/metadata/keys";
import { purgeExpiredImapStaging } from "@/server/mail-in/imap-inbox";
import { RECEIPT_RETENTION_MS } from "@/server/mail-in/imap-ingestion";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";

// #964: the 45-day retention clock counts elapsed *available* time, not
// wall-clock time (owner ruling, 2026-09-10). A receipt locked the whole
// time the KEK is away was never available to be ignored, so the clock must
// not run for it; a receipt that was available the whole time still burns
// up on the ordinary schedule. The clock is the only thing an open outage
// suspends: purging a disabled member's mail and giving up on an exhausted
// attachment pipeline are unconditional obligations that never read the
// metadata key, so they keep running through the outage too.

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

function lockMetadataKey() {
  const original = process.env.DOCUMENT_KEK;
  delete process.env.DOCUMENT_KEK;
  resetDocumentConfigForTests();
  return () => {
    if (original !== undefined) process.env.DOCUMENT_KEK = original;
    resetDocumentConfigForTests();
  };
}

async function insertReceipt(input: {
  userId: string;
  mailboxUid: number;
  receivedAt: Date;
  expiresAt: Date;
  status?: "pending_review" | "recoverable";
  failureCode?: string;
}) {
  const id = randomUUID();
  await getDb().insert(imapIngestionMessages).values({
    id,
    mailbox: "key-outage",
    mailboxUidValidity: "1",
    mailboxUid: input.mailboxUid,
    contentSha256: randomUUID().replaceAll("-", ""),
    recipientAliasSha256: `key-outage-${input.mailboxUid}`,
    userId: input.userId,
    status: input.status ?? "pending_review",
    failureCode: input.failureCode ?? null,
    receiptStatus: "pending",
    receivedAt: input.receivedAt,
    expiresAt: input.expiresAt,
    createdAt: input.receivedAt,
    updatedAt: input.receivedAt,
  });
  return id;
}

describe("mail-in key outage retention (#964)", () => {
  it("does not destroy a receipt locked past 45 days, and credits it once the key returns", async () => {
    const fixture = await createIntegrationFixture("mail-in-key-outage");
    const restoreKey = lockMetadataKey();
    try {
      expect(metadataCryptoAvailable()).toBe(false);

      const outageStart = new Date("2026-01-01T00:00:00.000Z");
      // Opens the outage window; no receipts exist yet, so nothing to sweep.
      await purgeExpiredImapStaging(outageStart, 10);

      const receivedAt = new Date(outageStart.getTime() + 60 * 60_000); // 1h into the outage
      const originalExpiresAt = new Date(receivedAt.getTime() + RECEIPT_RETENTION_MS);
      const receiptId = await insertReceipt({ userId: fixture.users.member.id, mailboxUid: 1, receivedAt, expiresAt: originalExpiresAt });

      // Well past the naive 45-day mark, key still locked.
      const stillLockedNow = new Date(receivedAt.getTime() + 46 * 86_400_000);
      await purgeExpiredImapStaging(stillLockedNow, 10);

      const [afterLockedSweep] = await getDb().select({ status: imapIngestionMessages.status, expiredAt: imapIngestionMessages.expiredAt })
        .from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId)).limit(1);
      // This is the reproduction assertion (#964): on unfixed code the naive
      // expiresAt < now sweep destroys this receipt here, even though it was
      // locked -- never available -- for its entire life so far.
      expect(afterLockedSweep?.status).toBe("pending_review");
      expect(afterLockedSweep?.expiredAt).toBeNull();

      const [openWindow] = await getDb().select().from(metadataKeyOutages).where(eq(metadataKeyOutages.status, "open")).limit(1);
      expect(openWindow?.startedAt.getTime()).toBe(outageStart.getTime());

      restoreKey();
      expect(metadataCryptoAvailable()).toBe(true);

      const keyReturnsAt = new Date(stillLockedNow.getTime() + 60_000);
      await purgeExpiredImapStaging(keyReturnsAt, 10);

      const [closedWindow] = await getDb().select().from(metadataKeyOutages).where(eq(metadataKeyOutages.id, openWindow!.id)).limit(1);
      expect(closedWindow?.status).toBe("closed");
      expect(closedWindow?.endedAt?.getTime()).toBe(keyReturnsAt.getTime());

      // Credited for the whole slice it existed under lock (from its own
      // arrival, since it arrived after the outage started): the clock
      // effectively restarts from the moment the key returned.
      const [afterCredit] = await getDb().select({ status: imapIngestionMessages.status, expiresAt: imapIngestionMessages.expiresAt })
        .from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId)).limit(1);
      expect(afterCredit?.status).toBe("pending_review");
      const expectedExpiresAt = keyReturnsAt.getTime() + RECEIPT_RETENTION_MS;
      expect(afterCredit?.expiresAt.getTime()).toBe(expectedExpiresAt);

      // And it does not get swept on this same cycle, now that it is
      // credited past `keyReturnsAt`.
      await purgeExpiredImapStaging(keyReturnsAt, 10);
      const [stillAlive] = await getDb().select({ status: imapIngestionMessages.status })
        .from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId)).limit(1);
      expect(stillAlive?.status).toBe("pending_review");
    } finally {
      restoreKey();
      await fixture.cleanup();
    }
  });

  it("still purges a disabled member's staged mail while the metadata key is locked", async () => {
    const fixture = await createIntegrationFixture("mail-in-key-outage");
    const restoreKey = lockMetadataKey();
    try {
      expect(metadataCryptoAvailable()).toBe(false);

      const outageStart = new Date("2026-03-01T00:00:00.000Z");
      await purgeExpiredImapStaging(outageStart, 10); // opens the outage window

      const receivedAt = new Date(outageStart.getTime() + 60 * 60_000);
      // Nowhere near its 45-day deadline: this must not be purged for being
      // "expired" -- the clock arm is not even in the query while the key is
      // locked -- only for the disabled member.
      const farExpiresAt = new Date(receivedAt.getTime() + RECEIPT_RETENTION_MS);
      const receiptId = await insertReceipt({ userId: fixture.users.disabled.id, mailboxUid: 3, receivedAt, expiresAt: farExpiresAt });
      await fixture.disableUser("disabled");

      const stillLockedNow = new Date(receivedAt.getTime() + 60_000);
      await purgeExpiredImapStaging(stillLockedNow, 10);

      const [after] = await getDb().select({
        status: imapIngestionMessages.status,
        expiredAt: imapIngestionMessages.expiredAt,
        failureCode: imapIngestionMessages.failureCode,
      }).from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId)).limit(1);
      expect(after?.status).toBe("expired");
      expect(after?.expiredAt?.getTime()).toBe(stillLockedNow.getTime());
      expect(after?.failureCode).toBe("account_disabled");
    } finally {
      restoreKey();
      // Close the outage window before cleanup: an open row left behind
      // would outlive this test's fixture.cleanup() (which does not touch
      // metadata_key_outages) and get picked up -- and credited against --
      // the next test's sweep.
      await purgeExpiredImapStaging(new Date(), 10);
      await fixture.cleanup();
    }
  });

  it("still purges a recoverable receipt whose attachment pipeline gave up, while the metadata key is locked", async () => {
    const fixture = await createIntegrationFixture("mail-in-key-outage");
    const restoreKey = lockMetadataKey();
    try {
      expect(metadataCryptoAvailable()).toBe(false);

      const outageStart = new Date("2026-04-01T00:00:00.000Z");
      await purgeExpiredImapStaging(outageStart, 10); // opens the outage window

      const receivedAt = new Date(outageStart.getTime() + 60 * 60_000);
      // Same reasoning as the disabled-member case: far from its deadline,
      // purged only because the attachment pipeline already gave up on it.
      const farExpiresAt = new Date(receivedAt.getTime() + RECEIPT_RETENTION_MS);
      const receiptId = await insertReceipt({
        userId: fixture.users.member.id,
        mailboxUid: 4,
        receivedAt,
        expiresAt: farExpiresAt,
        status: "recoverable",
        failureCode: "attachment_processing_exhausted",
      });

      const stillLockedNow = new Date(receivedAt.getTime() + 60_000);
      await purgeExpiredImapStaging(stillLockedNow, 10);

      const [after] = await getDb().select({
        status: imapIngestionMessages.status,
        expiredAt: imapIngestionMessages.expiredAt,
        failureCode: imapIngestionMessages.failureCode,
      }).from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId)).limit(1);
      expect(after?.status).toBe("failed");
      expect(after?.expiredAt?.getTime()).toBe(stillLockedNow.getTime());
      expect(after?.failureCode).toBe("attachment_processing_exhausted");
    } finally {
      restoreKey();
      // See the same note in the disabled-member test above: close the
      // outage before cleanup so it cannot leak into the next test.
      await purgeExpiredImapStaging(new Date(), 10);
      await fixture.cleanup();
    }
  });

  it("still expires a receipt that was available and unreviewed for 45 days", async () => {
    const fixture = await createIntegrationFixture("mail-in-key-outage");
    try {
      expect(metadataCryptoAvailable()).toBe(true);

      const receivedAt = new Date("2026-02-01T00:00:00.000Z");
      const expiresAt = new Date(receivedAt.getTime() + RECEIPT_RETENTION_MS);
      const receiptId = await insertReceipt({ userId: fixture.users.member.id, mailboxUid: 2, receivedAt, expiresAt });

      const now = new Date(expiresAt.getTime() + 60_000);
      await purgeExpiredImapStaging(now, 10);

      const [after] = await getDb().select({ status: imapIngestionMessages.status, expiredAt: imapIngestionMessages.expiredAt })
        .from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId)).limit(1);
      expect(after?.status).toBe("expired");
      expect(after?.expiredAt?.getTime()).toBe(now.getTime());
    } finally {
      await fixture.cleanup();
    }
  });
});
