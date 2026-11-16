import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { imapIngestionMessages, imapIngestionStagingObjects, metadataKeys } from "@/db/schema";
import { commitStagedAttachment, imapRecipientAlias, runImapIngestionCycle, setImapClientFactoryForTests } from "@/server/mail-in/imap-ingestion";
import { MetadataKeyLockedError, resetMetadataKeyCacheForTests } from "@/server/metadata/keys";
import { testImapConfig } from "../support/imap-config";
import { holdAttachmentBytes } from "../support/imap-holding";
import { syntheticPdf } from "../support/synthetic-documents";
import { cleanupIntegrationEnvironment, createIntegrationFixture, withRequiredScanMode } from "./support/fixtures";
import { attributedHeaders, fakeImapMailbox, verifiedSenderFor } from "./support/mail-in";
import { signedSource } from "./support/dkim-fixture";
import {
  attachmentColumns, attachmentsOfMessage, indexFor, openSeal, seedReceipt, sha256Of, stubPdfinfo,
} from "./support/imap-attachment-hash";

/* #1778, build note C (design note 58551): the writers. What a new mail-in
   row carries after this change:
   - `imap_ingestion_messages` has no `content_sha256` at all;
   - a committed attachment has `content_sha256_sealed` (the SHA-256 sealed
     under the receipt's scope key: instance key while `household_id` is null,
     which it is for every freshly recorded receipt), `content_index` (blind
     index under the INSTANCE key over `<messageId>:<sha256>`, never re-keyed)
     and a NULL plain `content_sha256`;
   - the per-mail dedupe is the unique (message_id, content_index): the same
     bytes twice in one mail are stored once, the same bytes in two mails are
     both stored;
   - a key that locks between the cycle's gate and a commit is not an attempt:
     the receipt stays `processing`, attempts unchanged, failure code
     `key_unavailable`, and the next cycle finishes it.
   Written from the note alone. */

vi.mock("node:dns/promises", async () => (await import("./support/dkim-fixture")).fixtureDnsModule());

vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(async () => ({ status: "clean" as const })),
}));

/* Wraps the writers a commit may use, so a key that locks in the window
   between the cycle's gate (which only reads) and the commit can be made to
   happen deterministically. Passed through unless `lockWriters.on`. */
const lockWriters = { on: false };
vi.mock("@/server/metadata/fields", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/metadata/fields")>();
  const guarded = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    if (lockWriters.on) throw new (await import("@/server/metadata/keys")).MetadataKeyLockedError();
    return fn(...args);
  };
  return {
    ...actual,
    requireInstanceMetadataWriter: guarded(actual.requireInstanceMetadataWriter),
    openReceiptMetadataWriter: guarded(actual.openReceiptMetadataWriter),
  };
});

afterAll(async () => {
  setImapClientFactoryForTests(undefined);
  await cleanupIntegrationEnvironment();
});

let unstubPdfinfo = () => {};
const stubbedPdfinfo = () => { unstubPdfinfo(); unstubPdfinfo = stubPdfinfo(); };

afterEach(() => {
  lockWriters.on = false;
  unstubPdfinfo();
});

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;
const pdf = (label: string) => syntheticPdf(`attachment hash test ${label}`);

/** A receipt mid-processing with a live lease, as `commitStagedAttachment` requires. */
async function leasedReceipt(fixture: Fixture, householdId: string | null = null) {
  const leaseToken = randomUUID();
  const receiptId = await seedReceipt({
    userId: fixture.users.member.id, householdId, status: "processing", leaseToken, lockedAt: new Date(),
  });
  return { receiptId, leaseToken };
}

/** Holds `bytes` and opens the ledger row the commit transitions, as the cycle does before it commits. */
async function stagedHold(fixture: Fixture, receiptId: string, leaseToken: string, bytes: Buffer, displayName = "a.pdf") {
  const held = await holdAttachmentBytes({ bytes, displayName, mediaType: "application/pdf", recipientUserId: fixture.users.member.id, receiptId });
  await getDb().insert(imapIngestionStagingObjects).values({ messageId: receiptId, leaseToken, storageKey: held.storageKey, status: "pending" });
  return held;
}

const messageColumns = async () => (await getDb().execute<{ column_name: string }>(sql`
  select column_name from information_schema.columns where table_name = 'imap_ingestion_messages'`)).map((row) => row.column_name);

describe("a committed mail-in attachment carries a sealed hash and a blind index, never the plain hash (#1778)", () => {
  it("unattributed receipt: the seal opens under the instance key to the file's SHA-256, not under a household's; plain is NULL; the index is under the instance key over <messageId>:<sha256>", async () => {
    const fixture = await createIntegrationFixture("attach-hash-commit-unattributed");
    try {
      const { receiptId, leaseToken } = await leasedReceipt(fixture);
      const bytes = pdf("unattributed");
      const sha = sha256Of(bytes);
      const held = await stagedHold(fixture, receiptId, leaseToken, bytes);
      expect(await commitStagedAttachment(receiptId, leaseToken, held)).toBe("inserted");

      const row = await attachmentColumns(held.id);
      expect(row.plain, "no plain hash is stored").toBeNull();
      expect(row.sealed, "a sealed hash is stored").not.toBeNull();
      expect(row.sealed).not.toContain(sha);
      expect(await openSeal("instance", held.id, row.sealed)).toEqual({ ok: true, sha256: sha });
      expect((await openSeal({ household: fixture.household.id }, held.id, row.sealed)).ok, "a household's key does not open an unattributed receipt's seal").toBe(false);
      expect(row.contentIndex).toBe(await indexFor(receiptId, sha));
      expect(row.contentIndex).not.toContain(sha);
    } finally {
      await fixture.cleanup();
    }
  });

  it("a receipt that already has a household seals under that household's key, and still indexes under the instance key", async () => {
    const fixture = await createIntegrationFixture("attach-hash-commit-attributed");
    try {
      const { receiptId, leaseToken } = await leasedReceipt(fixture, fixture.household.id);
      const bytes = pdf("attributed");
      const sha = sha256Of(bytes);
      const held = await stagedHold(fixture, receiptId, leaseToken, bytes);
      expect(await commitStagedAttachment(receiptId, leaseToken, held)).toBe("inserted");

      const row = await attachmentColumns(held.id);
      expect(row.plain).toBeNull();
      expect(await openSeal({ household: fixture.household.id }, held.id, row.sealed)).toEqual({ ok: true, sha256: sha });
      expect((await openSeal("instance", held.id, row.sealed)).ok).toBe(false);
      expect(row.contentIndex).toBe(await indexFor(receiptId, sha));
    } finally {
      await fixture.cleanup();
    }
  });

  it("the same bytes twice in one mail are stored once: the second commit answers duplicate and its staging object is purge_pending", async () => {
    const fixture = await createIntegrationFixture("attach-hash-dedupe-one-mail");
    try {
      const { receiptId, leaseToken } = await leasedReceipt(fixture);
      const bytes = pdf("twice in one mail");
      const first = await stagedHold(fixture, receiptId, leaseToken, bytes, "one.pdf");
      const second = await stagedHold(fixture, receiptId, leaseToken, bytes, "two.pdf");
      expect(await commitStagedAttachment(receiptId, leaseToken, first)).toBe("inserted");
      expect(await commitStagedAttachment(receiptId, leaseToken, second)).toBe("duplicate");

      const rows = await attachmentsOfMessage(receiptId);
      expect(rows.map((row) => row.id)).toEqual([first.id]);
      expect(rows[0].plain, "the kept row has no plain hash").toBeNull();
      expect(rows[0].sealed).not.toBeNull();
      const [ledger] = await getDb().select({ status: imapIngestionStagingObjects.status }).from(imapIngestionStagingObjects)
        .where(and(eq(imapIngestionStagingObjects.messageId, receiptId), eq(imapIngestionStagingObjects.storageKey, second.storageKey)));
      expect(ledger?.status).toBe("purge_pending");
    } finally {
      await fixture.cleanup();
    }
  });

  it("two different files in one mail are both stored", async () => {
    const fixture = await createIntegrationFixture("attach-hash-two-files");
    try {
      const { receiptId, leaseToken } = await leasedReceipt(fixture);
      const first = await stagedHold(fixture, receiptId, leaseToken, pdf("file one"));
      const second = await stagedHold(fixture, receiptId, leaseToken, pdf("file two"));
      expect(await commitStagedAttachment(receiptId, leaseToken, first)).toBe("inserted");
      expect(await commitStagedAttachment(receiptId, leaseToken, second)).toBe("inserted");
      const rows = await attachmentsOfMessage(receiptId);
      expect(rows).toHaveLength(2);
      expect(rows[0].contentIndex).not.toBe(rows[1].contentIndex);
    } finally {
      await fixture.cleanup();
    }
  });

  it("the same bytes in two mails to one recipient are both stored, with different content_index values", async () => {
    const fixture = await createIntegrationFixture("attach-hash-two-mails");
    try {
      const bytes = pdf("same file two mails");
      const a = await leasedReceipt(fixture);
      const b = await leasedReceipt(fixture);
      const heldA = await stagedHold(fixture, a.receiptId, a.leaseToken, bytes);
      const heldB = await stagedHold(fixture, b.receiptId, b.leaseToken, bytes);
      expect(await commitStagedAttachment(a.receiptId, a.leaseToken, heldA)).toBe("inserted");
      expect(await commitStagedAttachment(b.receiptId, b.leaseToken, heldB)).toBe("inserted");
      const rowA = await attachmentColumns(heldA.id);
      const rowB = await attachmentColumns(heldB.id);
      expect(rowA.contentIndex).not.toBeNull();
      expect(rowB.contentIndex).not.toBeNull();
      expect(rowA.contentIndex, "a dump cannot see that two mails carried one file").not.toBe(rowB.contentIndex);
    } finally {
      await fixture.cleanup();
    }
  });

  it("a duplicate is still caught after the receipt gains a household: the index does not depend on the household", async () => {
    const fixture = await createIntegrationFixture("attach-hash-dedupe-after-attribution");
    try {
      const { receiptId, leaseToken } = await leasedReceipt(fixture);
      const bytes = pdf("retry after attribution");
      const first = await stagedHold(fixture, receiptId, leaseToken, bytes);
      expect(await commitStagedAttachment(receiptId, leaseToken, first)).toBe("inserted");
      await getDb().update(imapIngestionMessages).set({ householdId: fixture.household.id }).where(eq(imapIngestionMessages.id, receiptId));
      const again = await stagedHold(fixture, receiptId, leaseToken, bytes);
      expect(await commitStagedAttachment(receiptId, leaseToken, again)).toBe("duplicate");
      expect(await attachmentsOfMessage(receiptId)).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("a receipt whose household changes under a commit is not sealed under the old one (#1778)", () => {
  it("refuses with staging_lease_lost and writes no attachment row and no seal", async () => {
    const fixture = await createIntegrationFixture("attach-hash-commit-household-moves");
    try {
      const { receiptId, leaseToken } = await leasedReceipt(fixture);
      const held = await stagedHold(fixture, receiptId, leaseToken, pdf("household moves under commit"));

      /* Another writer holds the receipt row and attributes it only once the commit is waiting on that row. */
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const holder = getDb().transaction(async (transaction) => {
        await transaction.execute(sql`select 1 from imap_ingestion_messages where id = ${receiptId} for update`);
        locked();
        await gate;
        await transaction.execute(sql`update imap_ingestion_messages set household_id = ${fixture.household.id} where id = ${receiptId}`);
      });
      await lockTaken;
      const committing = commitStagedAttachment(receiptId, leaseToken, held).then(() => "committed" as const, (error: unknown) => error);
      for (let waited = 0; waited < 5_000; waited += 50) {
        const rows = await getDb().execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
        if (Number(rows[0]!.n) > 0) break;
        await new Promise((done) => setTimeout(done, 50));
      }
      release();
      await holder;
      const outcome = await committing;

      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe("staging_lease_lost");
      expect(await attachmentsOfMessage(receiptId), "no row, so no seal under the old scope").toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("the message row keeps no content hash (#1778)", () => {
  it("imap_ingestion_messages has no content_sha256 column", async () => {
    expect(await messageColumns()).not.toContain("content_sha256");
  });

  it("a receipt is still recorded once per (mailbox, uidvalidity, uid), the only dedupe it ever had", async () => {
    const fixture = await createIntegrationFixture("attach-hash-message-tuple");
    try {
      const insert = (uid: number) => getDb().execute(sql`
        insert into imap_ingestion_messages (mailbox, mailbox_uid_validity, mailbox_uid, recipient_alias_sha256, user_id, status, expires_at)
        values ('INBOX', 'uidvalidity-a', ${uid}, 'alias', ${fixture.users.owner.id}, 'pending_review', now() + interval '1 day')
        on conflict do nothing returning id`);
      expect(await insert(1)).toHaveLength(1);
      expect(await insert(1)).toHaveLength(0);
      expect(await insert(2)).toHaveLength(1);
      const [{ n }] = await getDb().execute<{ n: number }>(sql`
        select count(*)::int as n from imap_ingestion_messages where mailbox_uid_validity = 'uidvalidity-a' and user_id = ${fixture.users.owner.id}`);
      expect(n, "uid 1 once, uid 2 once").toBe(2);
    } finally {
      await fixture.cleanup();
    }
  });
});

/* ---- the key locks between the cycle's gate and a commit ---- */

function mailboxConfig() {
  return testImapConfig({
    host: "imap.example.invalid",
    user: "orbit-test",
    password: "test-only-password",
    recipientDomain: "ingest.example.invalid",
    currentAliasSecret: "test-only-current-alias-secret-is-long-enough",
  });
}
const pdfBodyStructure = () => ({
  part: "1", type: "application", subtype: "pdf", disposition: "attachment",
  dispositionParameters: { filename: "receipt.pdf" }, size: 64,
}) as never;

describe("a key that locks between the gate and a commit is not an attempt (#1778)", () => {
  it("commitStagedAttachment with the instance key locked throws MetadataKeyLockedError and writes nothing, plain or sealed", async () => {
    const fixture = await createIntegrationFixture("attach-hash-commit-locked");
    const { receiptId, leaseToken } = await leasedReceipt(fixture);
    const held = await stagedHold(fixture, receiptId, leaseToken, pdf("locked commit"));
    const [key] = await getDb().select({ wrapAuthTag: metadataKeys.wrapAuthTag }).from(metadataKeys).where(eq(metadataKeys.scope, "instance"));
    expect(key, "the instance key exists").toBeTruthy();
    try {
      await getDb().execute(sql`update metadata_keys set wrap_auth_tag = ${randomBytes(16).toString("base64")} where scope = 'instance'`);
      resetMetadataKeyCacheForTests();
      await expect(commitStagedAttachment(receiptId, leaseToken, held)).rejects.toBeInstanceOf(MetadataKeyLockedError);
      expect(await attachmentsOfMessage(receiptId), "nothing, in plain or sealed form, was written").toHaveLength(0);
    } finally {
      await getDb().update(metadataKeys).set({ wrapAuthTag: key.wrapAuthTag }).where(eq(metadataKeys.scope, "instance"));
      resetMetadataKeyCacheForTests();
      await fixture.cleanup();
    }
  });

  it("a cycle whose commit meets a locked key leaves the receipt processing with attempts unchanged and failure code key_unavailable, then finishes it once the key is back", async () => {
    const fixture = await createIntegrationFixture("attach-hash-cycle-key-locked");
    try {
      const config = mailboxConfig();
      const memberSender = await verifiedSenderFor(fixture.users.member.id);
      const alias = imapRecipientAlias(fixture.users.member.id, config);
      const receiptId = await seedReceipt({
        userId: fixture.users.member.id, householdId: null, status: "processing",
        mailbox: config.mailbox, uidValidity: "77", uid: 830, attempts: 2,
      });
      await getDb().update(imapIngestionMessages).set({ attachmentProcessingNextAttemptAt: new Date(0) }).where(eq(imapIngestionMessages.id, receiptId));
      const provider = fakeImapMailbox({
        uidValidity: 77,
        messages: [{ uid: 830, headers: attributedHeaders(memberSender, alias), bodyStructure: pdfBodyStructure(), source: await signedSource(memberSender, "key locks mid cycle"), size: 64 }],
        download: () => pdf("cycle attachment"),
      });
      setImapClientFactoryForTests(() => provider.client as never);
      stubbedPdfinfo();

      lockWriters.on = true;
      await withRequiredScanMode(() => runImapIngestionCycle(config));
      lockWriters.on = false;
      const [locked] = await getDb().select().from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId));
      expect(provider.downloads, "the attachment was reached, so the lock hit the commit").toEqual(["830:1"]);
      expect(locked).toMatchObject({ status: "processing", attachmentProcessingAttempts: 2, failureCode: "key_unavailable", attachmentProcessingFailureCode: "key_unavailable" });
      expect(locked!.attachmentProcessingNextAttemptAt, "a retry is scheduled at the normal delay").not.toBeNull();
      expect(await attachmentsOfMessage(receiptId), "nothing was stored while the key was away").toHaveLength(0);

      await getDb().update(imapIngestionMessages).set({ attachmentProcessingNextAttemptAt: new Date(0) }).where(eq(imapIngestionMessages.id, receiptId));
      await withRequiredScanMode(() => runImapIngestionCycle(config));
      const [done] = await getDb().select().from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId));
      expect(done).toMatchObject({ status: "pending_review", failureCode: null });
      const rows = await attachmentsOfMessage(receiptId);
      expect(rows).toHaveLength(1);
      expect(rows[0].plain).toBeNull();
      expect(rows[0].sealed).not.toBeNull();
    } finally {
      lockWriters.on = false;
      setImapClientFactoryForTests(undefined);
      await fixture.cleanup();
    }
  }, 30_000);

  it("a locked key does not count towards the five attempts: a receipt on attempt four is not made exhausted by it", async () => {
    const fixture = await createIntegrationFixture("attach-hash-cycle-key-locked-fifth");
    try {
      const config = mailboxConfig();
      const memberSender = await verifiedSenderFor(fixture.users.member.id);
      const alias = imapRecipientAlias(fixture.users.member.id, config);
      const receiptId = await seedReceipt({
        userId: fixture.users.member.id, householdId: null, status: "processing",
        mailbox: config.mailbox, uidValidity: "77", uid: 831, attempts: 4,
      });
      await getDb().update(imapIngestionMessages).set({ attachmentProcessingNextAttemptAt: new Date(0) }).where(eq(imapIngestionMessages.id, receiptId));
      const provider = fakeImapMailbox({
        uidValidity: 77,
        messages: [{ uid: 831, headers: attributedHeaders(memberSender, alias), bodyStructure: pdfBodyStructure(), source: await signedSource(memberSender, "fifth attempt"), size: 64 }],
        download: () => pdf("cycle attachment"),
      });
      setImapClientFactoryForTests(() => provider.client as never);
      stubbedPdfinfo();
      lockWriters.on = true;
      await withRequiredScanMode(() => runImapIngestionCycle(config));
      lockWriters.on = false;
      const [receipt] = await getDb().select().from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId));
      expect(receipt).toMatchObject({ status: "processing", attachmentProcessingAttempts: 4, failureCode: "key_unavailable" });
    } finally {
      lockWriters.on = false;
      setImapClientFactoryForTests(undefined);
      await fixture.cleanup();
    }
  }, 30_000);
});

/* ---- a mail recorded by the cycle itself ---- */

describe("a mail recorded by a real cycle is written in the new shape (#1778)", () => {
  it("records a receipt with no message hash and holds its attachment sealed under the instance key (household_id is null), with the plain column NULL", async () => {
    const fixture = await createIntegrationFixture("attach-hash-real-cycle");
    try {
      const config = mailboxConfig();
      const memberSender = await verifiedSenderFor(fixture.users.member.id);
      const alias = imapRecipientAlias(fixture.users.member.id, config);
      const bytes = pdf("real cycle");
      const expectedSha = sha256Of(bytes); // ingest zeroes the buffer it downloads, so hash before
      const provider = fakeImapMailbox({
        uidValidity: 91,
        messages: [{ uid: 1, headers: attributedHeaders(memberSender, alias), bodyStructure: pdfBodyStructure(), source: await signedSource(memberSender, "real cycle"), size: 64 }],
        download: () => Buffer.from(bytes),
      });
      setImapClientFactoryForTests(() => provider.client as never);
      stubbedPdfinfo();
      await withRequiredScanMode(() => runImapIngestionCycle(config));

      const [receipt] = await getDb().select().from(imapIngestionMessages)
        .where(and(eq(imapIngestionMessages.mailbox, config.mailbox), eq(imapIngestionMessages.mailboxUidValidity, "91"), eq(imapIngestionMessages.mailboxUid, 1)));
      expect(receipt, "the receipt was recorded").toBeTruthy();
      expect(receipt!.householdId).toBeNull();
      expect(Object.keys(receipt!), "the receipt row has no content hash").not.toContain("contentSha256");
      const rows = await attachmentsOfMessage(receipt!.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].plain).toBeNull();
      expect(await openSeal("instance", rows[0].id, rows[0].sealed)).toEqual({ ok: true, sha256: expectedSha });
      expect(rows[0].contentIndex).toBe(await indexFor(receipt!.id, expectedSha));
    } finally {
      setImapClientFactoryForTests(undefined);
      await fixture.cleanup();
    }
  }, 30_000);
});
