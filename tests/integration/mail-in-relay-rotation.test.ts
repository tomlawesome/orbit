import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { auditLog, imapIngestionMessages, imapRecipientAliases, mailInMailbox, mailInRelays, mailInSecrets } from "@/db/schema";
import { getImapIngestionConfig } from "@/server/mail-in/mailbox-config";
import { setMailboxSettings, type MailboxSettingsDependencies, type MailboxSettingsInput } from "@/server/mail-in/mailbox-settings";
import { readRelaySettings, rotateRelayAddress } from "@/server/mail-in/relay-settings";
import { relayAddressFor, rotateRelay } from "@/server/mail-in/relays";
import {
  reconcileImapRecipientAliases,
  runImapIngestionCycle,
  setImapClientFactoryForTests,
} from "@/server/mail-in/imap-ingestion";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

/*
 * ADR-0017 slice 3 (orbit#744): per-user relay generations, against a real
 * database.
 *
 * The claim under test is the SIBLING INVARIANT. One member rotating or
 * cutting off their own address must leave every other member's rows, derived
 * address and incoming mail exactly as they were — and the route that does it
 * must have no way to name a user at all.
 */
const settings: MailboxSettingsInput = {
  host: "imap.example.test",
  port: 993,
  accountUser: "intake@example.test",
  mailbox: "INBOX",
  tlsServerName: "imap.example.test",
  providerProfile: "mailcow",
  trustedRecipientHeader: "X-Original-To",
  pollSeconds: 300,
  password: "fake-relay-rotation-password",
};
const providerReady: MailboxSettingsDependencies = { verifyImap: async () => "ready" };

const RELAY_URL = "http://127.0.0.1:3000/api/settings/mail-relay";
/* Loaded inside the cases that need it, not at module scope: the route is a
   SvelteKit module, so a checkout without the web workspace's own
   `node_modules` can still run every case that does not go through HTTP. */
const relayRoute = async () => (await loadRoute("settings/mail-relay")).PUT;

let fixture: IntegrationFixture;

beforeEach(async () => {
  fixture = await createIntegrationFixture("relay-rotation");
  await setMailboxSettings(fixture.users.admin.id, null, settings, providerReady);
});

afterEach(async () => {
  const db = getDb();
  setImapClientFactoryForTests(undefined);
  await db.delete(imapIngestionMessages);
  await db.delete(imapRecipientAliases);
  await db.delete(mailInRelays);
  await db.update(mailInMailbox).set({ passwordSecretId: null, aliasKeySecretId: null });
  await db.delete(mailInMailbox);
  await db.delete(mailInSecrets);
  await db.delete(auditLog);
  await fixture.cleanup();
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

/** Every alias row a member holds, in a shape two snapshots can be compared by. */
async function aliasRowsOf(userId: string) {
  return getDb().select({
    generation: imapRecipientAliases.generation,
    aliasSha256: imapRecipientAliases.aliasSha256,
    status: imapRecipientAliases.status,
    activeUntil: imapRecipientAliases.activeUntil,
  }).from(imapRecipientAliases)
    .where(eq(imapRecipientAliases.userId, userId))
    .orderBy(imapRecipientAliases.generation);
}

/** A provider fake that offers exactly one message, addressed where we say. */
function mailboxOf(recipient: () => string, uidValidity: bigint) {
  setImapClientFactoryForTests(() => ({
    mailbox: { uidValidity, uidNext: 1_000_000 },
    async connect() {},
    async logout() {},
    async getMailboxLock() { return { release() {} }; },
    async search() { return [1]; },
    async fetchOne() {
      return { uid: 1, headers: Buffer.from(`X-Original-To: ${recipient()}\r\n`), source: Buffer.from("sibling-message") };
    },
  } as unknown as import("imapflow").ImapFlow));
}

describe("per-user relay generations (ADR-0017 slice 3)", () => {
  it("leaves a sibling's rows, address and mail untouched when one member rotates (acceptance 1)", async () => {
    const config = await getImapIngestionConfig();
    const a = fixture.users.owner.id;
    const b = fixture.users.member.id;
    await reconcileImapRecipientAliases(config);

    const bBefore = await readRelaySettings({ id: b, isInstanceAdmin: false });
    const bAddressBefore = bBefore.address as string;
    const bRowsBefore = await aliasRowsOf(b);

    await rotateRelayAddress({ id: a, isInstanceAdmin: false }, "rotate");

    /* Byte-identical: not "equivalent", not "still valid" — the same string
       and the same rows, because nothing on A's path may name B. */
    expect(await addressOf(b)).toBe(bAddressBefore);
    expect(await aliasRowsOf(b)).toEqual(bRowsBefore);
    expect(await getDb().select({ currentGeneration: mailInRelays.currentGeneration, version: mailInRelays.version })
      .from(mailInRelays).where(eq(mailInRelays.userId, b))).toEqual([{ currentGeneration: 1, version: 1 }]);
    expect(await getDb().select({ currentGeneration: mailInRelays.currentGeneration })
      .from(mailInRelays).where(eq(mailInRelays.userId, a))).toEqual([{ currentGeneration: 2 }]);

    /* And B's mail still arrives, which is the half of the invariant a rows
       comparison alone cannot prove. */
    mailboxOf(() => bAddressBefore, 900n);
    await runImapIngestionCycle(config);
    expect(await getDb().select({ userId: imapIngestionMessages.userId, generation: imapIngestionMessages.recipientAliasGeneration })
      .from(imapIngestionMessages).where(eq(imapIngestionMessages.mailboxUidValidity, "900")))
      .toEqual([{ userId: b, generation: 1 }]);
  }, 20_000);

  it("attributes mail to the previous address until it expires, and refuses it after (acceptance 2)", async () => {
    const config = await getImapIngestionConfig();
    const member = fixture.users.member.id;
    await reconcileImapRecipientAliases(config);
    const oldAddress = await addressOf(member);

    const rotatedAt = new Date();
    const rotation = await rotateRelay(member, "rotate", config, rotatedAt);
    expect(rotation.previousExpiresAt.getTime()).toBe(rotatedAt.getTime() + 14 * 86_400_000);

    mailboxOf(() => oldAddress, 901n);
    await runImapIngestionCycle(config);
    /* Attribution is the claim: the message belongs to this member at the
       generation the outgoing address names. What happens to its attachments
       afterwards is another module's business, and this fake carries none. */
    expect(await getDb().select({ userId: imapIngestionMessages.userId, generation: imapIngestionMessages.recipientAliasGeneration })
      .from(imapIngestionMessages).where(eq(imapIngestionMessages.mailboxUidValidity, "901")))
      .toEqual([{ userId: member, generation: 1 }]);

    /* Past the expiry the same address is not "nearly valid": it is gone, and
       the receipt says which failure it is rather than a generic refusal. */
    await getDb().update(mailInRelays)
      .set({ previousExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(mailInRelays.userId, member));
    mailboxOf(() => oldAddress, 902n);
    await runImapIngestionCycle(config);
    expect(await getDb().select({ userId: imapIngestionMessages.userId, status: imapIngestionMessages.status, failureCode: imapIngestionMessages.failureCode })
      .from(imapIngestionMessages).where(eq(imapIngestionMessages.mailboxUidValidity, "902")))
      .toEqual([{ userId: null, status: "quarantined", failureCode: "recipient_alias_expired" }]);
  }, 20_000);

  it("never reuses a generation across repeated rotate and cut-off (acceptance 3)", async () => {
    const config = await getImapIngestionConfig();
    const member = fixture.users.member.id;
    await reconcileImapRecipientAliases(config);

    const generations: number[] = [1];
    const addresses = new Set([await addressOf(member)]);
    for (const mode of ["rotate", "cut_off", "rotate", "cut_off", "rotate"] as const) {
      const result = await rotateRelay(member, mode, config);
      generations.push(result.toGeneration);
      addresses.add(relayAddressFor(member, result.toGeneration, config));
    }

    expect(generations).toEqual([1, 2, 3, 4, 5, 6]);
    expect(addresses.size).toBe(6);
    /* Every generation this member ever held still has a row, and only the
       newest is eligible — the counter is a ledger, not a pointer. */
    const rows = await aliasRowsOf(member);
    expect(rows.map((row) => row.generation)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows.filter((row) => row.status === "active" && row.activeUntil === null).map((row) => row.generation)).toEqual([6]);

    const audits = await getDb().select({ action: auditLog.action, entityId: auditLog.entityId, changes: auditLog.changes })
      .from(auditLog).where(eq(auditLog.action, "mail_in_relay_rotated"));
    expect(audits).toHaveLength(5);
    expect(audits.every((row) => row.entityId === member)).toBe(true);
    expect(JSON.stringify(audits)).not.toContain(relayAddressFor(member, 6, config));
  }, 20_000);

  it("takes no user id from the request, so a member can only ever rotate their own (acceptance 4)", async () => {
    const config = await getImapIngestionConfig();
    const owner = fixture.users.owner.id;
    const member = fixture.users.member.id;
    await reconcileImapRecipientAliases(config);
    const memberRowsBefore = await aliasRowsOf(member);

    const session = await callRouteForSession(await relayRoute(), await fixture.session("owner"), {
      url: RELAY_URL,
      method: "PUT",
      headers: { "content-type": "application/json" },
      /* Every one of these is an attempt to name somebody else. The route has
         no field for any of them, so all of them are ignored. */
      body: JSON.stringify({ action: "cut_off", userId: member, user: member, id: member, generation: 99 }),
    });

    expect(session.status).toBe(200);
    expect(session.headers.get("cache-control")).toBe("no-store");
    const answered = await session.json();
    expect(answered.relay.address).toBe(relayAddressFor(owner, 2, config));

    expect(await aliasRowsOf(member)).toEqual(memberRowsBefore);
    expect(await getDb().select({ currentGeneration: mailInRelays.currentGeneration })
      .from(mailInRelays).where(eq(mailInRelays.userId, member))).toEqual([{ currentGeneration: 1 }]);
    expect(await getDb().select({ currentGeneration: mailInRelays.currentGeneration })
      .from(mailInRelays).where(eq(mailInRelays.userId, owner))).toEqual([{ currentGeneration: 2 }]);
  }, 20_000);

  it("has no field in the route source that could name another member (acceptance 4, read as source)", async () => {
    /* The functional case above proves the behaviour; this proves the shape,
       and it runs anywhere. A user identifier appearing in this file would be
       the one change that could break the sibling invariant without breaking
       any existing test, so it is asserted directly against the source. */
    const source = await readFile(new URL("../../web/src/routes/api/settings/mail-relay/+server.js", import.meta.url), "utf8");
    const handlerBody = source.slice(source.indexOf("export const PUT"));
    expect(handlerBody).toContain("session.user");
    for (const field of ["userId", "user_id", "body.user", "body.id", "params.user"]) {
      expect(handlerBody).not.toContain(field);
    }
  });

  it("refuses an action it does not recognise rather than guessing at one", async () => {
    const before = await getDb().select({ userId: mailInRelays.userId }).from(mailInRelays);
    const answer = await callRouteForSession(await relayRoute(), await fixture.session("owner"), {
      url: RELAY_URL,
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete_everyone" }),
    });
    expect(answer.status).toBe(400);
    expect((await answer.json()).error.code).toBe("relay_action_invalid");
    expect(await getDb().select({ userId: mailInRelays.userId }).from(mailInRelays)).toEqual(before);
  });
});

/** The address a member's own relay row currently derives to. */
async function addressOf(userId: string): Promise<string> {
  const config = await getImapIngestionConfig();
  const [relay] = await getDb().select({ currentGeneration: mailInRelays.currentGeneration })
    .from(mailInRelays).where(eq(mailInRelays.userId, userId));
  return relayAddressFor(userId, relay.currentGeneration, config);
}
