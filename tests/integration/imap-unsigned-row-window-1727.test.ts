import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { imapIngestionMessages } from "@/db/schema";
import { IMAP_ATTACHMENT_LIMITS } from "@/server/mail-in/core/imap-attachment-validation";
import { reconcileImapRecipientAliases, runImapIngestionCycle, setImapClientFactoryForTests } from "@/server/mail-in/imap-ingestion";
import { setRelayIngestPaused } from "@/server/mail-in/relays";
import { sampleMessage } from "../support/dkim-signing";
import { testImapConfig } from "../support/imap-config";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { attributedHeaders, fakeImapMailbox, verifiedSenderFor } from "./support/mail-in";
import { fixtureDnsLookups, signedSource } from "./support/dkim-fixture";

/*
 * #1727 A-R2: at most one sender_unsigned row per sending address per rolling
 * 24 hours. The claim is mail_in_sender_addresses.last_forward_unsigned_at;
 * unsigned mail that loses the claim is recorded as discarded (receipt
 * cancelled), never listed, and deleted from the mailbox. The cycle has no
 * clock hook, so "after 24 hours" moves the stored mark back 25 hours.
 */
vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(async () => ({ status: "clean" as const })),
}));
vi.mock("node:dns/promises", async () => (await import("./support/dkim-fixture")).fixtureDnsModule());

afterAll(async () => {
  setImapClientFactoryForTests(undefined);
  await cleanupIntegrationEnvironment();
});

beforeEach(() => { fixtureDnsLookups.length = 0; });

const HOUR_MS = 3_600_000;
const config = () => testImapConfig({
  host: "imap.example.invalid", user: "orbit-test", password: "test-only-password",
  recipientDomain: "ingest.example.invalid", currentAliasSecret: "test-only-current-alias-secret-is-long-enough",
});

/** An unsigned, forged forward: it names the address, carries no DKIM signature. */
const unsignedSource = (address: string, body: string) => Buffer.from(sampleMessage({ from: address, body }));

/** Every UID the mailbox was asked to delete, whether sent singly or as a range or list. */
const uidsIn = (deleted: string[]) => deleted.flatMap((range) => range.split(",")).flatMap((part) => {
  const [from, to] = part.split(":").map(Number);
  return to === undefined ? [from] : Array.from({ length: to - from + 1 }, (_, i) => from + i);
}).sort((a, b) => a - b);

interface Sent { uid: number; source?: Buffer; size?: number }

async function cycle(uidValidity: number, address: string, items: Sent[], deleted: string[]) {
  setImapClientFactoryForTests(() => fakeImapMailbox({
    uidValidity, search: "all", deleted,
    messages: items.map((item) => ({ uid: item.uid, headers: attributedHeaders(address), source: item.source, size: item.size })),
  }).client);
  await runImapIngestionCycle(config());
}

async function rowsFor(uidValidity: number) {
  const rows = await getDb().select({
    uid: imapIngestionMessages.mailboxUid, userId: imapIngestionMessages.userId, status: imapIngestionMessages.status,
    failureCode: imapIngestionMessages.failureCode, receiptStatus: imapIngestionMessages.receiptStatus,
  }).from(imapIngestionMessages).where(eq(imapIngestionMessages.mailboxUidValidity, String(uidValidity)));
  return rows.sort((a, b) => Number(a.uid) - Number(b.uid));
}

async function mark(userId: string): Promise<Date | null> {
  const rows = await getDb().execute(sql`
    SELECT last_forward_unsigned_at AS at FROM mail_in_sender_addresses WHERE user_id = ${userId}
  `) as unknown as Array<{ at: Date | string | null }>;
  expect(rows).toHaveLength(1);
  return rows[0].at === null ? null : new Date(rows[0].at);
}

async function setMark(userId: string, at: Date | null) {
  await getDb().execute(sql`UPDATE mail_in_sender_addresses SET last_forward_unsigned_at = ${at} WHERE user_id = ${userId}`);
}

async function member(name: string) {
  const fixture = await createIntegrationFixture(name);
  const userId = fixture.users.member.id;
  const address = await verifiedSenderFor(userId);
  await reconcileImapRecipientAliases(config());
  return { fixture, userId, address };
}

const filed = (userId: string) => ({ userId, status: "failed", failureCode: "sender_unsigned" });
const quiet = (userId: string) => ({ userId, status: "discarded", failureCode: "sender_unsigned", receiptStatus: "cancelled" });

describe("one sender_unsigned row per sending address per day (#1727 A-R2)", () => {
  it("files 1 failed row and 2 discarded rows for 3 unsigned forgeries in one cycle, and deletes all 3", async () => {
    const { fixture, userId, address } = await member("unsigned-window-three");
    try {
      const deleted: string[] = [];
      await cycle(7001, address, [1, 2, 3].map((uid) => ({ uid, source: unsignedSource(address, `forgery ${uid}`) })), deleted);

      const rows = await rowsFor(7001);
      expect(rows.map((row) => row.status).sort()).toEqual(["discarded", "discarded", "failed"]);
      expect(rows.filter((row) => row.status === "failed")).toEqual([expect.objectContaining(filed(userId))]);
      expect(rows.filter((row) => row.status === "discarded")).toEqual([
        expect.objectContaining(quiet(userId)), expect.objectContaining(quiet(userId)),
      ]);
      expect(uidsIn(deleted)).toEqual([1, 2, 3]);
    } finally { await fixture.cleanup(); }
  }, 30_000);

  it("files a row again once the window has passed (mark older than 24 hours)", async () => {
    const { fixture, userId, address } = await member("unsigned-window-reopen");
    try {
      const deleted: string[] = [];
      await cycle(7002, address, [{ uid: 1, source: unsignedSource(address, "first") }], deleted);
      expect(await rowsFor(7002)).toEqual([expect.objectContaining(filed(userId))]);
      await cycle(7003, address, [{ uid: 1, source: unsignedSource(address, "inside window") }], deleted);
      expect(await rowsFor(7003)).toEqual([expect.objectContaining(quiet(userId))]);

      await setMark(userId, new Date(Date.now() - 25 * HOUR_MS));
      await cycle(7004, address, [{ uid: 1, source: unsignedSource(address, "next day") }], deleted);

      expect(await rowsFor(7004)).toEqual([expect.objectContaining(filed(userId))]);
      expect(Date.now() - (await mark(userId))!.getTime()).toBeLessThan(HOUR_MS);
    } finally { await fixture.cleanup(); }
  }, 30_000);

  it("a signed forward clears the mark, and the next unsigned one files", async () => {
    const { fixture, userId, address } = await member("unsigned-window-signed");
    try {
      const deleted: string[] = [];
      await cycle(7005, address, [{ uid: 1, source: unsignedSource(address, "first") }], deleted);
      expect(await mark(userId)).not.toBeNull();

      await cycle(7006, address, [{ uid: 1, source: await signedSource(address, "genuine") }], deleted);
      expect(await mark(userId), "a signed forward clears the mark").toBeNull();

      await cycle(7007, address, [{ uid: 1, source: unsignedSource(address, "again") }], deleted);
      expect(await rowsFor(7007)).toEqual([expect.objectContaining(filed(userId))]);
      expect(await mark(userId)).not.toBeNull();
    } finally { await fixture.cleanup(); }
  }, 30_000);

  it("sets the mark exactly once, by the filed row: lost claims leave it untouched", async () => {
    const { fixture, userId, address } = await member("unsigned-window-mark-once");
    try {
      const deleted: string[] = [];
      expect(await mark(userId)).toBeNull();
      await cycle(7008, address, [{ uid: 1, source: unsignedSource(address, "a") }], deleted);
      const first = await mark(userId);
      expect(first).not.toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 50));
      await cycle(7009, address, [2, 3].map((uid) => ({ uid, source: unsignedSource(address, `b${uid}`) })), deleted);

      expect((await rowsFor(7009)).map((row) => row.status)).toEqual(["discarded", "discarded"]);
      expect((await mark(userId))!.getTime(), "the mark did not move").toBe(first!.getTime());
    } finally { await fixture.cleanup(); }
  }, 30_000);

  it("a paused member: the first unsigned forward is discarded, and the mark is set", async () => {
    const { fixture, userId, address } = await member("unsigned-window-paused");
    try {
      await setRelayIngestPaused(userId, true);
      const deleted: string[] = [];
      await cycle(7010, address, [{ uid: 1, source: unsignedSource(address, "paused") }], deleted);

      expect(await rowsFor(7010)).toEqual([expect.objectContaining(quiet(userId))]);
      expect(await mark(userId)).not.toBeNull();
      expect(uidsIn(deleted)).toEqual([1]);
    } finally { await fixture.cleanup(); }
  }, 30_000);

  it("oversized forwards are unaffected: each files sender_too_large, and the mark is neither claimed nor moved", async () => {
    const { fixture, userId, address } = await member("unsigned-window-oversized");
    try {
      const size = IMAP_ATTACHMENT_LIMITS.rawMessageBytes + 1;
      const deleted: string[] = [];
      await cycle(7011, address, [{ uid: 1, size }, { uid: 2, size }], deleted);
      expect(await rowsFor(7011)).toEqual([
        expect.objectContaining({ userId, status: "failed", failureCode: "sender_too_large" }),
        expect.objectContaining({ userId, status: "failed", failureCode: "sender_too_large" }),
      ]);
      expect(await mark(userId), "oversized mail does not set the mark").toBeNull();

      /* And an open claim is not taken by them: the window is still free for an unsigned forward. */
      await cycle(7012, address, [{ uid: 1, source: unsignedSource(address, "after oversized") }], deleted);
      expect(await rowsFor(7012)).toEqual([expect.objectContaining(filed(userId))]);

      const before = await mark(userId);
      await cycle(7013, address, [{ uid: 1, size }], deleted);
      expect((await rowsFor(7013))[0]).toMatchObject({ status: "failed", failureCode: "sender_too_large" });
      expect((await mark(userId))!.getTime()).toBe(before!.getTime());
    } finally { await fixture.cleanup(); }
  }, 30_000);

  it("two cycles racing on the same address file one row between them", async () => {
    const { fixture, userId, address } = await member("unsigned-window-race");
    try {
      const deleted: string[] = [];
      /* The factory hands each concurrent cycle its own mailbox (own uidValidity), one unsigned forgery each. */
      const mailboxes = [7014, 7015].map((uidValidity) => fakeImapMailbox({
        uidValidity, search: "all", deleted,
        messages: [{ uid: 1, headers: attributedHeaders(address), source: unsignedSource(address, `race ${uidValidity}`) }],
      }).client);
      let next = 0;
      setImapClientFactoryForTests(() => mailboxes[next++ % mailboxes.length]);

      await Promise.all([runImapIngestionCycle(config()), runImapIngestionCycle(config())]);

      const rows = [...await rowsFor(7014), ...await rowsFor(7015)];
      expect(rows, "both messages were recorded").toHaveLength(2);
      expect(rows.filter((row) => row.status === "failed")).toEqual([expect.objectContaining(filed(userId))]);
      expect(rows.filter((row) => row.status === "discarded")).toEqual([expect.objectContaining(quiet(userId))]);
      expect(uidsIn(deleted)).toEqual([1, 1]);
    } finally { await fixture.cleanup(); }
  }, 30_000);
});
