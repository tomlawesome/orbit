import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { auditLog, imapIngestionMessages, imapRecipientRotationState, mailInMailbox, mailInSecrets } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { getDocumentConfig } from "@/server/documents/config";
import { decryptMailInSecret } from "@/server/mail-in/core/secret-crypto";
import {
  readMailboxSettings,
  removeMailboxCredential,
  rotateMailboxPassword,
  runMailboxSetupProbe,
  setMailboxIngestEnabled,
  setMailboxSettings,
  verifyMailboxCredential,
  type MailboxSettingsDependencies,
  type MailboxSettingsInput,
} from "@/server/mail-in/mailbox-settings";
import { createIntegrationFixture, cleanupIntegrationEnvironment, type IntegrationFixture } from "./support/fixtures";

/*
 * ADR-0017 slice 2 (orbit#743): the administrator's mailbox settings against
 * a real database.
 *
 * Every password below is obviously fake and exists only in this file. The
 * suite's central claim is that none of them can be got back out: not from a
 * response, not from an audit row, and not from any read path at all.
 */
const FIRST_PASSWORD = "fake-mailbox-password-one";
const SECOND_PASSWORD = "fake-mailbox-password-two";

const settings: MailboxSettingsInput = {
  host: "imap.example.test",
  port: 993,
  accountUser: "intake@example.test",
  mailbox: "INBOX",
  tlsServerName: "imap.example.test",
  providerProfile: "mailcow",
  trustedRecipientHeader: "X-Original-To",
  pollSeconds: 300,
  password: FIRST_PASSWORD,
};

/** A provider that always authenticates; no socket is ever opened. */
const providerReady: MailboxSettingsDependencies = { verifyImap: async () => "ready" };
/** A provider that always refuses, which is the rotation-failure case. */
const providerRefuses: MailboxSettingsDependencies = { verifyImap: async () => "imap_unavailable" };

let fixture: IntegrationFixture;
let admin: string;

beforeEach(async () => {
  fixture = await createIntegrationFixture("mailbox-settings");
  admin = fixture.users.admin.id;
});

afterEach(async () => {
  const db = getDb();
  await db.delete(imapIngestionMessages);
  await db.delete(imapRecipientRotationState);
  await db.update(mailInMailbox).set({ passwordSecretId: null, aliasKeySecretId: null });
  await db.delete(mailInMailbox);
  await db.delete(mailInSecrets);
  await db.delete(auditLog);
  await fixture.cleanup();
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

async function mailboxActions(): Promise<{ action: string; changes: unknown }[]> {
  const rows = await getDb().select({ action: auditLog.action, changes: auditLog.changes })
    .from(auditLog).where(eq(auditLog.entityType, "mail_in_mailbox"))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id));
  return rows;
}

async function passwordRows() {
  return getDb().select().from(mailInSecrets).where(eq(mailInSecrets.kind, "imap_password"));
}

/** Proves what a row actually holds, which is the only place a password may exist. */
function decryptPassword(row: Awaited<ReturnType<typeof passwordRows>>[number], account: { host: string; user: string }): string {
  const { keyEncryptionKey } = getDocumentConfig();
  return decryptMailInSecret(row.ciphertext, {
    secretId: row.id, kind: "imap_password", host: account.host, user: account.user,
  }, {
    envelopeVersion: row.envelopeVersion as 1,
    algorithm: "aes-256-gcm",
    keyId: row.keyId,
    contentIv: row.contentIv,
    contentAuthTag: row.contentAuthTag,
    wrappedDek: row.wrappedDek,
    wrapIv: row.wrapIv,
    wrapAuthTag: row.wrapAuthTag,
  }, keyEncryptionKey).toString("utf8");
}

async function setUpMailbox() {
  return setMailboxSettings(admin, null, settings, providerReady);
}

describe("administrator mailbox settings (ADR-0017 decision 1, slice 2)", () => {
  it("sets the mailbox, stores the credential encrypted, and answers with no secret in it (acceptance 1)", async () => {
    const { outcome, settings: view } = await setUpMailbox();

    expect(outcome).toBe("verified");
    expect(view.configured).toBe(true);
    expect(view.enabled).toBe(true);
    expect(view.hasPassword).toBe(true);
    expect(view.hasAliasKey).toBe(true);
    expect(view.verificationState).toBe("verified");
    expect(view.credentialSetBy).toBe("Integration admin");
    /* Derived from the account, not configured: the base is the account's own
       local part and the placeholder stands where a member's code goes, so no
       administrator ever reads a real relay address. */
    expect(view.aliasPattern).toBe("intake+<code>@example.test");
    expect(JSON.stringify(view)).not.toContain(FIRST_PASSWORD);

    const rows = await passwordRows();
    expect(rows).toHaveLength(1);
    expect(decryptPassword(rows[0], { host: settings.host, user: settings.accountUser })).toBe(FIRST_PASSWORD);
    expect(rows[0].ciphertext.toString("utf8")).not.toContain(FIRST_PASSWORD);
    expect(rows[0].createdByUserId).toBe(admin);

    const actions = await mailboxActions();
    expect(actions[0].action).toBe("mail_in_credential_created");
    expect(actions[0].changes).toEqual({ kind: "imap_password", keyId: getDocumentConfig().keyId });
    expect(JSON.stringify(actions)).not.toContain(FIRST_PASSWORD);
  });

  it("writes nothing at all when the provider refuses the credential being set", async () => {
    const { outcome, settings: view } = await setMailboxSettings(admin, null, settings, providerRefuses);

    expect(outcome).toBe("provider_unavailable");
    expect(view.configured).toBe(false);
    expect(await passwordRows()).toHaveLength(0);
    expect(await getDb().select().from(mailInMailbox)).toHaveLength(0);
  });

  it("rotates in one transaction: the new row becomes active and the old row is gone (acceptance 5)", async () => {
    const created = await setUpMailbox();
    const originalId = (await passwordRows())[0].id;

    const rotated = await rotateMailboxPassword(admin, created.settings.version!, SECOND_PASSWORD, providerReady);

    expect(rotated.outcome).toBe("verified");
    const rows = await passwordRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe(originalId);
    expect(decryptPassword(rows[0], { host: settings.host, user: settings.accountUser })).toBe(SECOND_PASSWORD);

    const [mailbox] = await getDb().select().from(mailInMailbox);
    expect(mailbox.passwordSecretId).toBe(rows[0].id);
    expect(mailbox.version).toBe(created.settings.version! + 1);

    const actions = await mailboxActions();
    expect(actions[0].action).toBe("mail_in_credential_rotated");
    expect(actions[0].changes).toEqual({ kind: "imap_password", keyId: getDocumentConfig().keyId });
    expect(JSON.stringify(actions)).not.toContain(SECOND_PASSWORD);
  });

  it("leaves the previous credential active when the new one fails verification (acceptance 2)", async () => {
    const created = await setUpMailbox();
    const originalId = (await passwordRows())[0].id;

    const rotated = await rotateMailboxPassword(admin, created.settings.version!, SECOND_PASSWORD, providerRefuses);

    expect(rotated.outcome).toBe("provider_unavailable");
    const rows = await passwordRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(originalId);
    expect(decryptPassword(rows[0], { host: settings.host, user: settings.accountUser })).toBe(FIRST_PASSWORD);

    const [mailbox] = await getDb().select().from(mailInMailbox);
    expect(mailbox.passwordSecretId).toBe(originalId);
    expect(mailbox.version).toBe(created.settings.version);

    const actions = await mailboxActions();
    expect(actions[0].action).toBe("mail_in_credential_verified");
    expect(actions[0].changes).toEqual({ outcome: "provider_unavailable" });
    expect(JSON.stringify(actions)).not.toContain(SECOND_PASSWORD);
  });

  it("refuses a rotation whose expected version is stale, without touching the credential", async () => {
    const created = await setUpMailbox();

    await expect(rotateMailboxPassword(admin, created.settings.version! + 5, SECOND_PASSWORD, providerReady))
      .rejects.toBeInstanceOf(AppError);
    const rows = await passwordRows();
    expect(rows).toHaveLength(1);
    expect(decryptPassword(rows[0], { host: settings.host, user: settings.accountUser })).toBe(FIRST_PASSWORD);
  });

  it("removes the credential and switches ingest off, keeping receipts and the cursor (acceptance 6)", async () => {
    const created = await setUpMailbox();
    const receiptId = randomUUID();
    await getDb().insert(imapIngestionMessages).values({
      id: receiptId,
      mailbox: "INBOX",
      mailboxUidValidity: "1",
      mailboxUid: 42,
      contentSha256: "a".repeat(64),
      recipientAliasSha256: "b".repeat(64),
      userId: fixture.users.member.id,
      expiresAt: new Date(Date.now() + 86_400_000),
      status: "processing",
    });

    const view = await removeMailboxCredential(admin, created.settings.version!);

    expect(view.enabled).toBe(false);
    expect(view.configured).toBe(false);
    expect(view.hasPassword).toBe(false);
    expect(view.verificationState).toBe("unverified");
    expect(await passwordRows()).toHaveLength(0);
    /* The mailbox row itself stays, so the host, account and folder an
       administrator entered survive removal and only the secret goes. */
    const [mailbox] = await getDb().select().from(mailInMailbox);
    expect(mailbox.host).toBe(settings.host);
    expect(mailbox.aliasKeySecretId).not.toBeNull();

    const [receipt] = await getDb().select().from(imapIngestionMessages)
      .where(eq(imapIngestionMessages.id, receiptId));
    expect(receipt.mailboxUid).toBe(42);
    expect(receipt.status).toBe("processing");

    const actions = await mailboxActions();
    expect(actions[0].action).toBe("mail_in_credential_removed");
    expect(actions[0].changes).toEqual({ kind: "imap_password", keyId: getDocumentConfig().keyId });
  });

  it("clears the alias-rotation singleton when a new alias key is generated", async () => {
    /* Reproduces the failure seen against the real acceptance stack: the
       singleton commits to the alias key that was in force, so a mailbox set
       against a leftover commitment made every poll cycle throw
       ImapRotationStaleError and no mail was ever collected. The singleton
       goes away in slice 3; until then setting a mailbox has to leave it
       describing something that exists. */
    await getDb().insert(imapRecipientRotationState).values({
      currentGeneration: 1,
      currentCommitment: "a".repeat(64),
    });

    await setUpMailbox();

    expect(await getDb().select().from(imapRecipientRotationState)).toHaveLength(0);
  });

  it("keeps the alias key, and the addresses derived from it, when only the host changes", async () => {
    const created = await setUpMailbox();
    const [before] = await getDb().select().from(mailInMailbox);

    await setMailboxSettings(admin, created.settings.version!, {
      ...settings, port: 143, password: SECOND_PASSWORD,
    }, providerReady);

    const [after] = await getDb().select().from(mailInMailbox);
    expect(after.port).toBe(143);
    expect(after.aliasKeySecretId).toBe(before.aliasKeySecretId);
    expect(await getDb().select().from(mailInSecrets).where(eq(mailInSecrets.kind, "alias_key"))).toHaveLength(1);
  });

  it("re-keys aliases when the account moves, because the old key cannot decrypt against a new account", async () => {
    const created = await setUpMailbox();
    const [before] = await getDb().select().from(mailInMailbox);

    await setMailboxSettings(admin, created.settings.version!, {
      ...settings, accountUser: "moved@elsewhere.test", password: SECOND_PASSWORD,
    }, providerReady);

    const [after] = await getDb().select().from(mailInMailbox);
    expect(after.aliasKeySecretId).not.toBe(before.aliasKeySecretId);
    expect(await getDb().select().from(mailInSecrets).where(eq(mailInSecrets.kind, "alias_key"))).toHaveLength(1);
    const view = await readMailboxSettings(admin);
    expect(view.aliasPattern).toBe("moved+<code>@elsewhere.test");
  });

  it("records enable and disable as their own events without touching the credential", async () => {
    const created = await setUpMailbox();

    const disabled = await setMailboxIngestEnabled(admin, created.settings.version!, false);
    expect(disabled.enabled).toBe(false);
    expect((await mailboxActions())[0].action).toBe("mail_in_ingest_disabled");

    const enabled = await setMailboxIngestEnabled(admin, disabled.version!, true);
    expect(enabled.enabled).toBe(true);
    expect((await mailboxActions())[0].action).toBe("mail_in_ingest_enabled");
    expect(await passwordRows()).toHaveLength(1);
  });

  it("records verification as a bounded outcome and marks the mailbox accordingly", async () => {
    await setUpMailbox();

    const refused = await verifyMailboxCredential(admin, providerRefuses);
    expect(refused.outcome).toBe("provider_unavailable");
    expect(refused.settings.verificationState).toBe("failed");
    expect((await mailboxActions())[0].changes).toEqual({ outcome: "provider_unavailable" });

    const accepted = await verifyMailboxCredential(admin, providerReady);
    expect(accepted.outcome).toBe("verified");
    expect(accepted.settings.verificationState).toBe("verified");
    expect((await mailboxActions())[0].changes).toEqual({ outcome: "verified" });
  });

  it("refuses every action to a user who is not an instance administrator", async () => {
    await setUpMailbox();
    const member = fixture.users.member.id;

    await expect(readMailboxSettings(member)).rejects.toBeInstanceOf(AppError);
    await expect(setMailboxSettings(member, null, settings, providerReady)).rejects.toBeInstanceOf(AppError);
    await expect(rotateMailboxPassword(member, 1, SECOND_PASSWORD, providerReady)).rejects.toBeInstanceOf(AppError);
    await expect(removeMailboxCredential(member, 1)).rejects.toBeInstanceOf(AppError);
    await expect(setMailboxIngestEnabled(member, 1, false)).rejects.toBeInstanceOf(AppError);
    await expect(runMailboxSetupProbe(member)).rejects.toBeInstanceOf(AppError);
  });
});

describe("mailbox setup probe (ratified degradation ladder, rung 1)", () => {
  const smtpConfig = () => ({
    smtpUrl: "smtps://fake:fake@smtp.example.test:465",
    smtpSecurity: "implicit_tls" as const,
    smtpFrom: "orbit@example.test",
    vapidSubject: "",
    vapidPublicKey: "",
    vapidPrivateKey: "",
    pollMilliseconds: 60_000,
    maxAttempts: 5,
  });

  /** Sends to whatever address the probe derived, and hands it back unchanged. */
  function provider(behaviour: "preserves" | "strips" | "loses") {
    let sentTo = "";
    return {
      ...providerReady,
      smtpConfig,
      sendProbeMail: async (message: { to: string }) => { sentTo = message.to; },
      findProbeMessage: async () => {
        if (behaviour === "loses") return undefined;
        return { trustedRecipient: behaviour === "preserves" ? sentTo : undefined };
      },
    } satisfies MailboxSettingsDependencies;
  }

  it("reports delivered when the self-addressed message comes back with its envelope recipient (acceptance 4)", async () => {
    await setUpMailbox();
    const { outcome } = await runMailboxSetupProbe(admin, provider("preserves"));
    expect(outcome).toBe("delivered");
    expect((await mailboxActions())[0].changes).toEqual({ outcome: "delivered" });
  });

  it("separates a provider that delivers sub-addressed mail but strips the envelope recipient", async () => {
    await setUpMailbox();
    const { outcome } = await runMailboxSetupProbe(admin, provider("strips"));
    expect(outcome).toBe("delivered_without_recipient_header");
  });

  it("reports not delivered when the message never arrives", async () => {
    await setUpMailbox();
    const { outcome } = await runMailboxSetupProbe(admin, provider("loses"));
    expect(outcome).toBe("not_delivered");
  });

  it("reports not configured before a mailbox exists, and never sends anything", async () => {
    let sent = 0;
    const { outcome } = await runMailboxSetupProbe(admin, {
      ...provider("preserves"),
      sendProbeMail: async () => { sent += 1; },
    });
    expect(outcome).toBe("not_configured");
    expect(sent).toBe(0);
  });
});
