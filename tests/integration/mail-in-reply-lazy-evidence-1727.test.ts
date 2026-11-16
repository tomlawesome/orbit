import { createHash } from "node:crypto";
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
import { getImapIngestionConfig } from "@/server/mail-in/mailbox-config";
import { setMailboxSettings, type MailboxSettingsDependencies, type MailboxSettingsInput } from "@/server/mail-in/mailbox-settings";
import { reconcileImapRecipientAliases, runImapIngestionCycle, setImapClientFactoryForTests } from "@/server/mail-in/imap-ingestion";
import { parseMailHeaders } from "@/server/mail-in/core/sender-authentication";
import { replyToUnattributedSender, UNATTRIBUTED_REPLY_INTERVAL_MS } from "@/server/mail-in/unattributed-reply";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";
import { fixtureHeaders, TRUSTED_AUTHSERV_ID, fakeImapMailbox } from "./support/mail-in";
import { fixtureDnsLookups, fromOfHeaders, signedSource } from "./support/dkim-fixture";

vi.mock("node:dns/promises", async () => (await import("./support/dkim-fixture")).fixtureDnsModule());

/*
 * #1727 A-R1: the stranger's signing evidence is computed lazily. The third
 * argument of replyToUnattributedSender is a function returning the verified
 * signing domains; it runs at most once, and only after every cheap reason not
 * to reply has passed (readable, not automated, SMTP configured, not answered
 * within the interval). An unauthenticated message claims nothing.
 */
const settings = {
  host: "imap.example.test",
  port: 993,
  accountUser: "intake@example.test",
  mailbox: "INBOX",
  tlsServerName: "imap.example.test",
  providerProfile: "mailcow",
  trustedRecipientHeader: "X-Original-To",
  trustedAuthservId: TRUSTED_AUTHSERV_ID,
  pollSeconds: 300,
  password: "fake-lazy-evidence-password",
} as MailboxSettingsInput;
const providerReady: MailboxSettingsDependencies = { verifyImap: async () => "ready" };
const smtp = { smtpUrl: "smtps://smtp.example.test", smtpFrom: "orbit@example.test" } as never;

const SENDER = "stranger@example.test";
const NOW = new Date("2026-09-06T09:00:00.000Z");

let fixture: IntegrationFixture;
let sent: Array<{ to: string; subject: string; text: string }>;
let deleted: string[];

beforeEach(async () => {
  fixture = await createIntegrationFixture("mail-in-lazy-evidence");
  sent = [];
  deleted = [];
  fixtureDnsLookups.length = 0;
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

const deps = () => ({
  now: () => NOW,
  smtpConfig: () => smtp,
  sendMail: async (message: { to: string; subject: string; text: string }) => { sent.push(message); },
});

const headersOf = (extra: string[] = []) => parseMailHeaders(fixtureHeaders({ from: SENDER, extra }));
const claimRows = () => getDb().select().from(mailInUnattributedReplies);
const digest = (address: string) => createHash("sha256").update(address, "utf8").digest("hex");

/** An evidence function that counts its calls. */
function evidence(domains: string[] | Error) {
  const fn = vi.fn(async (): Promise<string[]> => {
    if (domains instanceof Error) throw domains;
    return domains;
  });
  return fn;
}

describe("replyToUnattributedSender computes its evidence lazily (#1727 A-R1)", () => {
  it("never calls the evidence function for automated mail", async () => {
    const fn = evidence(["example.test"]);
    const result = await replyToUnattributedSender(headersOf(["Precedence: bulk"]), SENDER, fn, deps());
    expect(result).toEqual({ sent: false, suppressed: "automated_mail" });
    expect(fn).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("never calls the evidence function when SMTP is not configured", async () => {
    const fn = evidence(["example.test"]);
    const unconfigured = { ...deps(), smtpConfig: () => ({}) as never };
    const result = await replyToUnattributedSender(headersOf(), SENDER, fn, unconfigured);
    expect(result).toEqual({ sent: false, suppressed: "smtp_not_configured" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("never calls the evidence function when the sender was answered within the interval", async () => {
    await getDb().insert(mailInUnattributedReplies).values({
      addressSha256: digest(SENDER),
      lastRepliedAt: new Date(NOW.getTime() - UNATTRIBUTED_REPLY_INTERVAL_MS / 2),
      updatedAt: new Date(NOW.getTime() - UNATTRIBUTED_REPLY_INTERVAL_MS / 2),
    });
    const fn = evidence(["example.test"]);
    const result = await replyToUnattributedSender(headersOf(), SENDER, fn, deps());
    expect(result).toEqual({ sent: false, suppressed: "already_replied_today" });
    expect(fn).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("never calls the evidence function when the headers or address are unreadable", async () => {
    const fn = evidence(["example.test"]);
    expect(await replyToUnattributedSender(undefined, SENDER, fn, deps())).toEqual({ sent: false, suppressed: "sender_unreadable" });
    expect(await replyToUnattributedSender(headersOf(), undefined, fn, deps())).toEqual({ sent: false, suppressed: "sender_unreadable" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("an unauthenticated message writes no claim row", async () => {
    const fn = evidence([]);
    const result = await replyToUnattributedSender(headersOf(), SENDER, fn, deps());
    expect(result).toEqual({ sent: false, suppressed: "sender_unauthenticated" });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await claimRows()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("an unauthenticated message leaves an expired claim row untouched", async () => {
    const old = new Date(NOW.getTime() - 2 * UNATTRIBUTED_REPLY_INTERVAL_MS);
    await getDb().insert(mailInUnattributedReplies).values({ addressSha256: digest(SENDER), lastRepliedAt: old, updatedAt: old });
    const result = await replyToUnattributedSender(headersOf(), SENDER, evidence(["other.test"]), deps());
    expect(result).toEqual({ sent: false, suppressed: "sender_unauthenticated" });
    const [row] = await getDb().select().from(mailInUnattributedReplies).where(eq(mailInUnattributedReplies.addressSha256, digest(SENDER)));
    expect(row.lastRepliedAt.getTime()).toBe(old.getTime());
    expect(row.updatedAt.getTime()).toBe(old.getTime());
  });

  it("an evidence function that throws gives sender_unauthenticated and no claim", async () => {
    const fn = evidence(new Error("dns timeout"));
    const result = await replyToUnattributedSender(headersOf(), SENDER, fn, deps());
    expect(result).toEqual({ sent: false, suppressed: "sender_unauthenticated" });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await claimRows()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("the happy path calls the evidence once and sends exactly once", async () => {
    const fn = evidence(["example.test"]);
    const result = await replyToUnattributedSender(headersOf(), SENDER, fn, deps());
    expect(result).toEqual({ sent: true });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(SENDER);
    expect(await claimRows()).toHaveLength(1);
  });

  it("two concurrent calls for one sender send once", async () => {
    const fn = evidence(["example.test"]);
    const results = await Promise.all([
      replyToUnattributedSender(headersOf(), SENDER, fn, deps()),
      replyToUnattributedSender(headersOf(), SENDER, fn, deps()),
    ]);
    expect(sent).toHaveLength(1);
    expect(results.filter((r) => r.sent)).toHaveLength(1);
    expect(results).toContainEqual({ sent: false, suppressed: "already_replied_today" });
    expect(fn.mock.calls.length).toBeLessThanOrEqual(2);
    expect(await claimRows()).toHaveLength(1);
  });
});

describe("a stranger through the poll cycle costs no DKIM lookup unless a reply could go out (#1727 A-R1)", () => {
  async function cycleWith(uidValidity: bigint, headers: Buffer, dependencies: Record<string, unknown>) {
    await setMailboxSettings(fixture.users.admin.id, null, settings, providerReady);
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    const source = await signedSource(fromOfHeaders(headers)!, "lazy-evidence-message\r\n");
    setImapClientFactoryForTests(() => fakeImapMailbox({
      uidValidity,
      search: "all",
      deleted,
      messages: [{ uid: 1, headers, source: Buffer.from(source) }],
    }).client);
    await runImapIngestionCycle(config, { now: () => NOW, ...dependencies });
  }

  it("a non-automated, aligned-signature stranger with SMTP unconfigured never reaches the DKIM resolver", async () => {
    await cycleWith(7001n, fixtureHeaders({ from: SENDER }), { smtpConfig: () => ({}) as never, sendMail: deps().sendMail });
    expect(fixtureDnsLookups).toEqual([]);
    expect(sent).toEqual([]);
    expect(deleted).toEqual(["1"]);
  }, 30_000);

  it("a stranger answered within the interval never reaches the DKIM resolver", async () => {
    await getDb().insert(mailInUnattributedReplies).values({ addressSha256: digest(SENDER), lastRepliedAt: NOW, updatedAt: NOW });
    await cycleWith(7002n, fixtureHeaders({ from: SENDER }), { smtpConfig: deps().smtpConfig, sendMail: deps().sendMail });
    expect(fixtureDnsLookups).toEqual([]);
    expect(sent).toEqual([]);
  }, 30_000);

  it("a stranger whose reply can go out is still looked up and answered once", async () => {
    await cycleWith(7003n, fixtureHeaders({ from: SENDER }), { smtpConfig: deps().smtpConfig, sendMail: deps().sendMail });
    expect(fixtureDnsLookups.length).toBeGreaterThan(0);
    expect(sent).toHaveLength(1);
  }, 30_000);
});
