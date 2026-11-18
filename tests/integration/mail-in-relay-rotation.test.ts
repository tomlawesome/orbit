import { readFile } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, imapIngestionMessages, imapRecipientAliases, mailInMailbox, mailInRelays, mailInSecrets, mailInSenderAddresses } from "@/db/schema";
import { getImapIngestionConfig } from "@/server/mail-in/mailbox-config";
import { readMailboxSettings, rotateMailboxAliasKey, setMailboxSettings, type MailboxSettingsDependencies, type MailboxSettingsInput } from "@/server/mail-in/mailbox-settings";
import { readRelaySettings, rotateRelayAddress } from "@/server/mail-in/relay-settings";
import { relayAddressFor, RelayConflictError, rotateRelay } from "@/server/mail-in/relays";
import {
  reconcileImapRecipientAliases,
  runImapIngestionCycle,
  setImapClientFactoryForTests,
} from "@/server/mail-in/imap-ingestion";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";
import { attributedHeaders, verifiedSenderFor, fakeImapMailbox } from "./support/mail-in";
import { signedSource } from "./support/dkim-fixture";

/* #1681: a forward is attributed only on its own DKIM signature, so the
   sources below are signed with the fixture key this stub publishes. */
/* W-R1 (#1848): lets one case make the route's rotate lose its race, which
   the row lock makes impossible to provoke for real. Everything else passes
   straight through. */
const forced = vi.hoisted(() => ({ conflict: false }));
vi.mock("@/server/mail-in/relay-settings", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/mail-in/relay-settings")>();
  return {
    ...original,
    rotateRelayAddress: (...args: Parameters<typeof original.rotateRelayAddress>) => {
      if (forced.conflict) return Promise.reject(new RelayConflictError());
      return original.rotateRelayAddress(...args);
    },
  };
});

vi.mock("node:dns/promises", async () => (await import("./support/dkim-fixture")).fixtureDnsModule());

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
  forced.conflict = false;
  const db = getDb();
  setImapClientFactoryForTests(undefined);
  await db.delete(imapIngestionMessages);
  await db.delete(imapRecipientAliases);
  await db.delete(mailInSenderAddresses);
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

/**
 * A provider fake that offers exactly one message, from a verified member and
 * addressed to whichever relay address we say.
 *
 * The `From` and the message's own DKIM signature are what attribute it
 * since ADR-0017 slice 4 and #1681; the alias is corroboration, and it is the corroboration these cases
 * are about.
 */
function mailboxOf(sender: () => string, recipient: () => string, uidValidity: bigint) {
  setImapClientFactoryForTests(() => fakeImapMailbox({
    uidValidity,
    search: "all",
    deleted: [],
    messages: [{ uid: 1, headers: () => attributedHeaders(sender(), recipient()), source: () => signedSource(sender(), "sibling-message") }],
  }).client);
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
    const bSender = await verifiedSenderFor(b);
    mailboxOf(() => bSender, () => bAddressBefore, 900n);
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

    const memberSender = await verifiedSenderFor(member);
    mailboxOf(() => memberSender, () => oldAddress, 901n);
    await runImapIngestionCycle(config);
    /* The alias corroborates: the message belongs to this member, and the
       receipt records that both the sender and the alias said so. */
    expect(await getDb().select({ userId: imapIngestionMessages.userId, generation: imapIngestionMessages.recipientAliasGeneration, attributedBy: imapIngestionMessages.attributedBy })
      .from(imapIngestionMessages).where(eq(imapIngestionMessages.mailboxUidValidity, "901")))
      .toEqual([{ userId: member, generation: 1, attributedBy: "sender_and_alias" }]);

    /* Past the expiry the same address is not "nearly valid": it is gone, and
       stops corroborating anything. The member's mail still arrives, because
       since ADR-0017 slice 4 it is the verified sender that attributes and the
       alias only ever agreed with it. */
    await getDb().update(mailInRelays)
      .set({ previousExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(mailInRelays.userId, member));
    mailboxOf(() => memberSender, () => oldAddress, 902n);
    await runImapIngestionCycle(config);
    expect(await getDb().select({ userId: imapIngestionMessages.userId, generation: imapIngestionMessages.recipientAliasGeneration, attributedBy: imapIngestionMessages.attributedBy })
      .from(imapIngestionMessages).where(eq(imapIngestionMessages.mailboxUidValidity, "902")))
      .toEqual([{ userId: member, generation: null, attributedBy: "sender" }]);
  }, 20_000);

  it("never reuses a generation across repeated rotate and cut-off (acceptance 3)", async () => {
    const config = await getImapIngestionConfig();
    const member = fixture.users.member.id;
    await reconcileImapRecipientAliases(config);

    const generations: number[] = [1];
    const addresses = new Set([await addressOf(member)]);
    /* Spaced 61 minutes apart so the 2-per-hour limit (#1848) is not what this
       case is about; five rotations stay inside the 5-per-14-days one. */
    const start = Date.now();
    let step = 0;
    for (const mode of ["rotate", "cut_off", "rotate", "cut_off", "rotate"] as const) {
      const result = await rotateRelay(member, mode, config, new Date(start + step++ * 61 * 60_000));
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

/*
 * #1848 W-R1 (notes 59391, 59462, 59466): rotation is a conditional write
 * (`expectedGeneration`, from If-Match) and is limited to 2 per 60 minutes and
 * 5 per 14 days per member, counted from the `mail_in_relay_rotated` audit rows
 * under the relay row's lock. Names the tests fix for the build:
 *   rotateRelay(userId, mode, config, now, expectedGeneration?)
 *   rotateRelayAddress(user, mode, expectedGeneration?, now?)
 * Refusals are thrown with `code` and `status`; the limit one also carries
 * `retryAfterSeconds`. PUT with no If-Match still rotates (as before).
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = new Date("2031-03-01T09:00:00.000Z");
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

async function rotationAuditCount(userId: string): Promise<number> {
  const rows = await getDb().select({ id: auditLog.id }).from(auditLog)
    .where(and(eq(auditLog.action, "mail_in_relay_rotated"), eq(auditLog.actorUserId, userId)));
  return rows.length;
}

async function generationOf(userId: string): Promise<number> {
  const [row] = await getDb().select({ g: mailInRelays.currentGeneration }).from(mailInRelays).where(eq(mailInRelays.userId, userId));
  return row.g;
}

describe("rotation limits (#1848 W-R1)", () => {
  it("the hourly edge: t and t+1 min pass, t+59 min is 429 with Retry-After 60, t+60 min+1 s passes", async () => {
    const config = await getImapIngestionConfig();
    const member = fixture.users.member.id;
    await reconcileImapRecipientAliases(config);

    await rotateRelay(member, "rotate", config, at(0));
    await rotateRelay(member, "rotate", config, at(MINUTE));
    await expect(rotateRelay(member, "rotate", config, at(59 * MINUTE))).rejects.toMatchObject({
      code: "relay_rotation_limited",
      status: 429,
      retryAfterSeconds: 60,
    });
    /* A refusal changes nothing: no third row, no new generation. */
    expect(await rotationAuditCount(member)).toBe(2);
    expect(await generationOf(member)).toBe(3);

    await rotateRelay(member, "rotate", config, at(HOUR + 1_000));
    expect(await rotationAuditCount(member)).toBe(3);
    expect(await generationOf(member)).toBe(4);
  }, 30_000);

  it("the 14-day edge: five over days 0 to 4 pass, a sixth on day 13 is 429, and it passes once the oldest is 14 days and 1 s old", async () => {
    const config = await getImapIngestionConfig();
    const member = fixture.users.member.id;
    await reconcileImapRecipientAliases(config);

    for (const day of [0, 1, 2, 3, 4]) await rotateRelay(member, "rotate", config, at(day * DAY));
    await expect(rotateRelay(member, "rotate", config, at(13 * DAY))).rejects.toMatchObject({
      code: "relay_rotation_limited",
      status: 429,
      retryAfterSeconds: 86_400,
    });
    expect(await rotationAuditCount(member)).toBe(5);

    await rotateRelay(member, "rotate", config, at(14 * DAY + 1_000));
    expect(await rotationAuditCount(member)).toBe(6);
  }, 30_000);

  it("another member's rotations do not count", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    await rotateRelay(fixture.users.owner.id, "rotate", config, at(0));
    await rotateRelay(fixture.users.owner.id, "rotate", config, at(MINUTE));
    await rotateRelay(fixture.users.member.id, "rotate", config, at(2 * MINUTE));
    expect(await generationOf(fixture.users.member.id)).toBe(2);
  }, 30_000);

  it("cut off counts: a rotate, then a cut off, then a third is 429", async () => {
    const config = await getImapIngestionConfig();
    const member = fixture.users.member.id;
    await reconcileImapRecipientAliases(config);

    await rotateRelay(member, "rotate", config, at(0));
    await rotateRelay(member, "cut_off", config, at(MINUTE));
    await expect(rotateRelay(member, "cut_off", config, at(2 * MINUTE))).rejects.toMatchObject({
      code: "relay_rotation_limited",
      status: 429,
    });
    await expect(rotateRelay(member, "rotate", config, at(2 * MINUTE))).rejects.toMatchObject({ code: "relay_rotation_limited" });
  }, 30_000);

  it("the administrator's key rotation is exempt: it neither counts against the member nor is refused", async () => {
    const config = await getImapIngestionConfig();
    const member = fixture.users.member.id;
    const admin = fixture.users.admin.id;
    await reconcileImapRecipientAliases(config);

    await rotateRelay(member, "rotate", config, at(0));
    for (const minutes of [1, 2]) {
      const mailbox = await readMailboxSettings(admin);
      await rotateMailboxAliasKey(admin, mailbox.version as number, 14, { ...providerReady, now: () => at(minutes * MINUTE) });
    }
    const afterAdmin = await getImapIngestionConfig();
    /* One member rotation so far, so exactly one more is allowed... */
    await rotateRelay(member, "rotate", afterAdmin, at(3 * MINUTE));
    /* ...and the administrator's two did not take the member's place. */
    await expect(rotateRelay(member, "rotate", afterAdmin, at(4 * MINUTE))).rejects.toMatchObject({ code: "relay_rotation_limited" });
    expect(await rotationAuditCount(member)).toBe(2);
  }, 60_000);
});

describe("conditional rotate (#1848 W-R1)", () => {
  it("a matching expectedGeneration rotates; a stale one is relay_changed (412) and changes nothing", async () => {
    const config = await getImapIngestionConfig();
    const member = fixture.users.member.id;
    await reconcileImapRecipientAliases(config);

    await rotateRelay(member, "rotate", config, at(0), 1);
    expect(await generationOf(member)).toBe(2);

    const rowsBefore = await aliasRowsOf(member);
    await expect(rotateRelay(member, "rotate", config, at(MINUTE), 1)).rejects.toMatchObject({ code: "relay_changed", status: 412 });
    expect(await generationOf(member)).toBe(2);
    expect(await aliasRowsOf(member)).toEqual(rowsBefore);
    expect(await rotationAuditCount(member)).toBe(1);
  }, 30_000);

  it("the check precedes the count: a stale press at the limit is 412, not 429", async () => {
    const config = await getImapIngestionConfig();
    const member = fixture.users.member.id;
    await reconcileImapRecipientAliases(config);
    await rotateRelay(member, "rotate", config, at(0));
    await rotateRelay(member, "rotate", config, at(MINUTE));
    await expect(rotateRelay(member, "rotate", config, at(2 * MINUTE), 1)).rejects.toMatchObject({ code: "relay_changed" });
    await expect(rotateRelay(member, "rotate", config, at(2 * MINUTE), 3)).rejects.toMatchObject({ code: "relay_rotation_limited" });
  }, 30_000);

  it("held-open double press: two presses on the same generation while the row is held, one rotates, the other is 412, one audit row, generation +1", async () => {
    const config = await getImapIngestionConfig();
    const member = fixture.users.member.id;
    await reconcileImapRecipientAliases(config);
    const db = getDb();

    /* The held-open transaction: this holds the relay row's lock, as the
       first press's own transaction does, so both presses are queued behind it
       with the same If-Match (generation 1) and are decided only afterwards. */
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    const blocker = db.transaction(async (transaction) => {
      await transaction.execute(sql`select 1 from mail_in_relays where user_id = ${member} for update`);
      held();
      await gate;
    });
    await holding;

    const first = rotateRelay(member, "rotate", config, at(0), 1).then(() => "rotated", (error: { code?: string }) => error.code);
    const second = rotateRelay(member, "rotate", config, at(MINUTE), 1).then(() => "rotated", (error: { code?: string }) => error.code);
    await new Promise((resolve) => setTimeout(resolve, 750));
    release();
    await blocker;
    const outcomes = (await Promise.all([first, second])).sort();

    expect(outcomes).toEqual(["relay_changed", "rotated"]);
    expect(await rotationAuditCount(member)).toBe(1);
    expect(await generationOf(member)).toBe(2);
  }, 60_000);

  it("two simultaneous presses with no If-Match cannot both pass a limit of one remaining (the lock makes the count safe)", async () => {
    const config = await getImapIngestionConfig();
    const member = fixture.users.member.id;
    await reconcileImapRecipientAliases(config);
    await rotateRelay(member, "rotate", config, at(0));
    const outcomes = await Promise.all([
      rotateRelay(member, "rotate", config, at(MINUTE)).then(() => "rotated", (error: { code?: string }) => error.code),
      rotateRelay(member, "rotate", config, at(MINUTE)).then(() => "rotated", (error: { code?: string }) => error.code),
    ]);
    expect(outcomes.filter((outcome) => outcome === "rotated")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "relay_rotation_limited")).toHaveLength(1);
    expect(await rotationAuditCount(member)).toBe(2);
  }, 60_000);
});

describe("the relay route (#1848 W-R1)", () => {
  const getRoute = async () => (await loadRoute("settings/mail-relay")).GET;

  it("GET answers ETag \"<generation>\", and the tag moves with a rotation", async () => {
    const config = await getImapIngestionConfig();
    const owner = fixture.users.owner.id;
    await reconcileImapRecipientAliases(config);
    const first = await callRouteForSession(await getRoute(), await fixture.session("owner"), { url: RELAY_URL });
    expect(first.status).toBe(200);
    expect(first.headers.get("etag")).toBe('"1"');
    expect(first.headers.get("cache-control")).toBe("no-store");

    await rotateRelay(owner, "rotate", config, new Date());
    const second = await callRouteForSession(await getRoute(), await fixture.session("owner"), { url: RELAY_URL });
    expect(second.headers.get("etag")).toBe('"2"');
  }, 30_000);

  it("a PUT with the current If-Match rotates", async () => {
    const config = await getImapIngestionConfig();
    const owner = fixture.users.owner.id;
    await reconcileImapRecipientAliases(config);
    const answer = await callRouteForSession(await relayRoute(), await fixture.session("owner"), {
      url: RELAY_URL,
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": '"1"' },
      body: JSON.stringify({ action: "rotate" }),
    });
    expect(answer.status).toBe(200);
    expect((await answer.json()).relay.address).toBe(relayAddressFor(owner, 2, config));
  }, 30_000);

  it("a stale PUT is 412 relay_changed and the generation is unchanged", async () => {
    const config = await getImapIngestionConfig();
    const owner = fixture.users.owner.id;
    await reconcileImapRecipientAliases(config);
    await rotateRelay(owner, "rotate", config, new Date());
    const rowsBefore = await aliasRowsOf(owner);

    for (const action of ["rotate", "cut_off"]) {
      const answer = await callRouteForSession(await relayRoute(), await fixture.session("owner"), {
        url: RELAY_URL,
        method: "PUT",
        headers: { "content-type": "application/json", "if-match": '"1"' },
        body: JSON.stringify({ action }),
      });
      expect(answer.status).toBe(412);
      expect((await answer.json()).error.code).toBe("relay_changed");
    }
    expect(await generationOf(owner)).toBe(2);
    expect(await aliasRowsOf(owner)).toEqual(rowsBefore);
    expect(await rotationAuditCount(owner)).toBe(1);
  }, 30_000);

  it("over the limit the route is 429 relay_rotation_limited with Retry-After in whole seconds, and the address is unchanged", async () => {
    const config = await getImapIngestionConfig();
    const owner = fixture.users.owner.id;
    await reconcileImapRecipientAliases(config);
    await rotateRelay(owner, "rotate", config, new Date());
    await rotateRelay(owner, "cut_off", config, new Date());

    const answer = await callRouteForSession(await relayRoute(), await fixture.session("owner"), {
      url: RELAY_URL,
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "rotate" }),
    });
    expect(answer.status).toBe(429);
    expect((await answer.json()).error.code).toBe("relay_rotation_limited");
    const retryAfter = answer.headers.get("retry-after");
    expect(retryAfter).toMatch(/^\d+$/);
    expect(Number(retryAfter)).toBeGreaterThan(3_500);
    expect(Number(retryAfter)).toBeLessThanOrEqual(3_600);
    expect(await generationOf(owner)).toBe(3);
  }, 30_000);

  it("a lost race (RelayConflictError) is 409 relay_conflict, not 500", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    forced.conflict = true;
    const answer = await callRouteForSession(await relayRoute(), await fixture.session("owner"), {
      url: RELAY_URL,
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "rotate" }),
    });
    expect(answer.status).toBe(409);
    expect((await answer.json()).error.code).toBe("relay_conflict");
  }, 30_000);
});
