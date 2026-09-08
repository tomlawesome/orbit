import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, mailInMailbox, mailInSecrets } from "@/db/schema";
import { getDocumentConfig } from "@/server/documents/config";
import { encryptMailInSecret, type MailInSecretContext, type MailInSecretKind } from "@/server/mail-in/core/secret-crypto";
import { getImapIngestionConfig, MailInCredentialLockedError } from "@/server/mail-in/mailbox-config";
import { cleanupIntegrationEnvironment } from "./support/fixtures";

/** Captures rendered `orbit`-prefixed log lines without disturbing other console output. */
function captureLogLines() {
  const lines: string[] = [];
  const record = (line: unknown) => { lines.push(String(line)); };
  const errorSpy = vi.spyOn(console, "error").mockImplementation(record);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(record);
  const logSpy = vi.spyOn(console, "log").mockImplementation(record);
  return {
    lines,
    restore: () => {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      logSpy.mockRestore();
    },
  };
}

const account = { host: "imap.example.test", user: "orbit@example.test" };

async function seedSecret(kind: MailInSecretKind, plaintext: string, keyEncryptionKey: Buffer, keyId: string): Promise<string> {
  const id = randomUUID();
  const context: MailInSecretContext = { secretId: id, kind, host: account.host, user: account.user };
  const encrypted = encryptMailInSecret(Buffer.from(plaintext, "utf8"), context, keyEncryptionKey, keyId);
  await getDb().insert(mailInSecrets).values({
    id,
    kind,
    ciphertext: encrypted.ciphertext,
    envelopeVersion: encrypted.envelope.envelopeVersion,
    contentIv: encrypted.envelope.contentIv,
    contentAuthTag: encrypted.envelope.contentAuthTag,
    wrappedDek: encrypted.envelope.wrappedDek,
    wrapIv: encrypted.envelope.wrapIv,
    wrapAuthTag: encrypted.envelope.wrapAuthTag,
    keyId: encrypted.envelope.keyId,
  });
  return id;
}

async function seedMailbox(params: { passwordSecretId?: string; aliasKeySecretId?: string; enabled?: boolean }): Promise<string> {
  const id = randomUUID();
  await getDb().insert(mailInMailbox).values({
    id,
    host: account.host,
    port: 993,
    accountUser: account.user,
    mailbox: "INBOX",
    tlsServerName: account.host,
    providerProfile: "other",
    authMethod: "password",
    trustedRecipientHeader: "X-Original-To",
    pollSeconds: 300,
    enabled: params.enabled ?? true,
    passwordSecretId: params.passwordSecretId,
    aliasKeySecretId: params.aliasKeySecretId,
  });
  return id;
}

afterEach(async () => {
  const db = getDb();
  await db.delete(auditLog).where(eq(auditLog.entityType, "mail_in_mailbox"));
  await db.delete(mailInMailbox);
  await db.delete(mailInSecrets);
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

describe("mail-in credential storage (ADR-0017 decision 1, slice 1)", () => {
  it("resolves the mailbox and its secrets from the database (acceptance 1)", async () => {
    const documentConfig = getDocumentConfig();
    const passwordId = await seedSecret("imap_password", "correct-mailbox-password", documentConfig.keyEncryptionKey, documentConfig.keyId);
    const aliasId = await seedSecret("alias_key", "the-alias-derivation-key-material", documentConfig.keyEncryptionKey, documentConfig.keyId);
    await seedMailbox({ passwordSecretId: passwordId, aliasKeySecretId: aliasId });

    const config = await getImapIngestionConfig();

    expect(config.configured).toBe(true);
    expect(config.enabled).toBe(true);
    expect(config.host).toBe(account.host);
    expect(config.user).toBe(account.user);
    expect(config.password).toBe("correct-mailbox-password");
    expect(config.aliasCurrent.secret).toBe("the-alias-derivation-key-material");
    expect(config.recipientDomain).toBe("example.test");
  });

  it("reports not configured when there is no mailbox row, never an environment fallback", async () => {
    const config = await getImapIngestionConfig();
    expect(config.configured).toBe(false);
    expect(config.enabled).toBe(false);
    expect(config.password).toBe("");
  });

  it("fails closed as credential_locked, with no secret or stack trace in logs, when the wrapping KEK does not match (acceptance 3 and 6)", async () => {
    const wrongKeyEncryptionKey = randomBytes(32);
    // Unique per test run so the per-process locked-audit dedupe in
    // mailbox-config.ts never suppresses this assertion by coincidence.
    const wrongKeyId = `wrong-key-${randomUUID()}`;
    const passwordId = await seedSecret("imap_password", "extremely-secret-mailbox-password", wrongKeyEncryptionKey, wrongKeyId);
    const mailboxId = await seedMailbox({ passwordSecretId: passwordId });

    const capture = captureLogLines();
    let caught: unknown;
    try {
      await getImapIngestionConfig();
    } catch (error) {
      caught = error;
    } finally {
      capture.restore();
    }

    expect(caught).toBeInstanceOf(MailInCredentialLockedError);
    expect((caught as MailInCredentialLockedError).keyId).toBe(wrongKeyId);

    const rendered = capture.lines.join("\n");
    expect(rendered).not.toContain("extremely-secret-mailbox-password");
    expect(rendered).not.toContain("at Object.");
    expect(rendered).not.toContain(".ts:");
    expect(rendered).not.toMatch(/error\.stack|Unsupported state|unable to authenticate data/i);

    const [auditRow] = await getDb().select().from(auditLog)
      .where(eq(auditLog.entityType, "mail_in_mailbox")).limit(1);
    expect(auditRow?.action).toBe("mail_in_credential_locked");
    expect(auditRow?.entityId).toBe(mailboxId);
    expect(auditRow?.changes).toEqual({ keyId: wrongKeyId });
    expect(JSON.stringify(auditRow?.changes)).not.toContain("extremely-secret-mailbox-password");
  });
});
