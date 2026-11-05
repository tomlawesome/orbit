import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  auditLog,
  imapIngestionMessages,
  imapRecipientAliases,
  mailInMailbox,
  mailInRelays,
  mailInSecrets,
  mailInSenderAddresses,
  mailInUnattributedReplies,
} from "@/db/schema";
import { IMAP_ATTACHMENT_LIMITS } from "@/server/mail-in/core/imap-attachment-validation";
import { getImapIngestionConfig } from "@/server/mail-in/mailbox-config";
import { setMailboxSettings, type MailboxSettingsDependencies, type MailboxSettingsInput } from "@/server/mail-in/mailbox-settings";
import { runImapIngestionCycle, setImapClientFactoryForTests } from "@/server/mail-in/imap-ingestion";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";
import { fixtureHeaders } from "./support/mail-in";

/*
 * #1724: a message over the raw size limit from an address no verified member
 * owns was recorded failed/message_too_large with no user and never deleted,
 * so such messages filled the relay mailbox. It must be deleted like other
 * unattributed mail, with the same retry, with no reply to the stranger, no
 * body download and no DNS lookup. The message is faked by size only: the
 * provider reports a size over the limit and hands back no source.
 */
const dns = vi.hoisted(() => ({ lookups: [] as string[] }));
vi.mock("node:dns/promises", () => {
  const resolveTxt = async (name: string) => {
    dns.lookups.push(name);
    throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  };
  class Resolver { resolveTxt = resolveTxt; setServers() {} cancel() {} }
  return { resolveTxt, Resolver, default: { resolveTxt, Resolver } };
});

const settings = {
  host: "imap.example.test",
  port: 993,
  accountUser: "intake@example.test",
  mailbox: "INBOX",
  tlsServerName: "imap.example.test",
  providerProfile: "mailcow",
  trustedRecipientHeader: "X-Original-To",
  pollSeconds: 300,
  password: "fake-oversized-password",
} as MailboxSettingsInput;
const providerReady: MailboxSettingsDependencies = { verifyImap: async () => "ready" };
const smtp = { smtpUrl: "smtps://smtp.example.test", smtpFrom: "orbit@example.test" } as never;

let fixture: IntegrationFixture;
let deleted: string[];
let downloads: string[];
let sent: Array<{ to: string; subject: string; text: string }>;

beforeEach(async () => {
  fixture = await createIntegrationFixture("imap-oversized-stranger-expunge");
  deleted = [];
  downloads = [];
  sent = [];
  dns.lookups.length = 0;
  await setMailboxSettings(fixture.users.admin.id, null, settings, providerReady);
});

afterEach(async () => {
  const db = getDb();
  setImapClientFactoryForTests(undefined);
  await db.delete(imapIngestionMessages);
  await db.delete(imapRecipientAliases);
  await db.delete(mailInRelays);
  await db.delete(mailInSenderAddresses);
  await db.delete(mailInUnattributedReplies);
  await db.update(mailInMailbox).set({ passwordSecretId: null, aliasKeySecretId: null });
  await db.delete(mailInMailbox);
  await db.delete(mailInSecrets);
  await db.delete(auditLog);
  await fixture.cleanup();
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

const replyDependencies = {
  smtpConfig: () => smtp,
  sendMail: async (message: { to: string; subject: string; text: string }) => { sent.push(message); },
};

/** One oversized message from a stranger; the provider refuses the first `failures` deletes. */
function mailboxHoldingOversized(uidValidity: bigint, failures: number) {
  let refused = 0;
  const headers = fixtureHeaders({ from: "stranger@nowhere.example.test" });
  setImapClientFactoryForTests(() => ({
    mailbox: { uidValidity, uidNext: 1_000_000 },
    async connect() {},
    async logout() {},
    async getMailboxLock() { return { release() {} }; },
    async search() { return [1]; },
    async messageDelete(range: string) {
      if (refused < failures) { refused += 1; throw new Error("provider refused the delete"); }
      deleted.push(range);
      return true;
    },
    async download(uid: number, part: string) { downloads.push(`${uid}:${part}`); throw new Error("the body must not be downloaded"); },
    async fetchOne() {
      return { uid: 1, headers: Buffer.from(headers), size: IMAP_ATTACHMENT_LIMITS.rawMessageBytes + 1 };
    },
  } as unknown as import("imapflow").ImapFlow));
}

async function cycle(uidValidity: bigint, failures = 0) {
  const config = await getImapIngestionConfig();
  mailboxHoldingOversized(uidValidity, failures);
  await runImapIngestionCycle(config, replyDependencies);
}

async function receipts(uidValidity: string) {
  return getDb().select({
    userId: imapIngestionMessages.userId,
    status: imapIngestionMessages.status,
    failureCode: imapIngestionMessages.failureCode,
  }).from(imapIngestionMessages).where(eq(imapIngestionMessages.mailboxUidValidity, uidValidity));
}

describe("an oversized message from a stranger is deleted from the relay mailbox (#1724)", () => {
  it("is expunged in the same cycle, with no reply, no download and no DNS lookup, and the receipt keeps its outcome", async () => {
    await cycle(7001n);

    expect(await receipts("7001")).toEqual([{ userId: null, status: "failed", failureCode: "message_too_large" }]);
    expect(deleted, "the raw message does not stay in the mailbox").toEqual(["1"]);
    expect(sent, "the stranger is told nothing").toEqual([]);
    expect(downloads).toEqual([]);
    expect(dns.lookups).toEqual([]);
  }, 20_000);

  it("is deleted by the next cycle when the provider refused the delete in the first", async () => {
    await cycle(7002n, 1);
    expect(deleted, "the first delete did not land").toEqual([]);
    expect(await receipts("7002")).toEqual([{ userId: null, status: "failed", failureCode: "message_too_large" }]);

    await cycle(7002n, 0);

    expect(deleted, "a later cycle retries the delete").toEqual(["1"]);
    expect(sent).toEqual([]);
    expect(downloads).toEqual([]);
    expect(dns.lookups).toEqual([]);
  }, 30_000);

  it("makes no second receipt when the same UID is read again", async () => {
    await cycle(7003n, 1);
    await cycle(7003n, 1);
    await cycle(7003n, 0);

    expect(await receipts("7003")).toEqual([{ userId: null, status: "failed", failureCode: "message_too_large" }]);
    expect(sent).toEqual([]);
  }, 30_000);
});
