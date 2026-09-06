import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The administrator mailbox state machine (ADR-0017 decision 1, slice 2,
 * orbit#743), against an in-memory stand-in for the database.
 *
 * The integration suite proves the same module against real Postgres; this
 * one exists to pin the decisions the module makes *before* it touches a
 * table, which are the ones a reader has to trust: what counts as a
 * configured mailbox, which provider answer becomes which bounded outcome,
 * which operations refuse rather than half-apply, and that no credential
 * survives into anything the module returns, audits or derives.
 *
 * Only the seams the module already declares are stubbed: the provider
 * connect, the SMTP sender, authorization, and the document key. The
 * encryption, the alias derivation, the version checks and the transaction
 * boundaries are the real code — a rolled-back transaction here really does
 * leave the store as it was.
 *
 * Every password below is an obvious placeholder. The suite's own claim is
 * that none of them can be read back out.
 */

const FIRST_PASSWORD = "fake-mailbox-password-one";
const SECOND_PASSWORD = "fake-mailbox-password-two";
const ADMIN = "11111111-1111-4111-8111-111111111111";
const OUTSIDER = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  /** table name -> rows, the whole database for one test. */
  tables: {} as Record<string, Record<string, unknown>[]>,
  keyEncryptionKey: Buffer.alloc(32, 0x2b),
  keyId: "test-document-key-1",
  administrators: new Set<string>(),
  verifyImap: vi.fn(),
  preflight: vi.fn(),
  createImapClient: vi.fn((): unknown => { throw new Error("no socket in a unit test"); }),
}));

vi.mock("@/db", async () => {
  const { Column, Param, getTableColumns, getTableName, is } = await import("drizzle-orm");
  const schema = await import("@/db/schema");
  const { randomUUID } = await import("node:crypto");

  /* Drizzle conditions carry Column objects, not the property names the row
     objects use, so the schema is walked once to map one to the other. */
  const columnKeys = new Map<unknown, { table: string; key: string }>();
  for (const candidate of Object.values(schema)) {
    let columns: Record<string, unknown> | undefined;
    try {
      columns = getTableColumns(candidate as never) as Record<string, unknown> | undefined;
    } catch {
      continue;
    }
    if (!columns || typeof columns !== "object") continue;
    const table = getTableName(candidate as never);
    for (const [key, column] of Object.entries(columns)) columnKeys.set(column, { table, key });
  }

  type Row = Record<string, unknown>;
  type Sources = Record<string, Row | null | undefined>;

  const rowsOf = (table: string): Row[] => (mocks.tables[table] ??= []);

  function resolve(node: unknown, sources: Sources): unknown {
    if (is(node, Param)) return (node as { value: unknown }).value;
    const meta = columnKeys.get(node);
    if (!meta) return undefined;
    return sources[meta.table]?.[meta.key] ?? null;
  }

  /** Only `eq` is used by this module, so pairs of operands are enough. */
  function matches(condition: unknown, sources: Sources): boolean {
    if (!condition) return true;
    const operands = ((condition as { queryChunks?: unknown[] }).queryChunks ?? [])
      .filter((chunk) => is(chunk, Column) || is(chunk, Param));
    for (let index = 0; index + 1 < operands.length; index += 2) {
      const left = resolve(operands[index], sources);
      const right = resolve(operands[index + 1], sources);
      const same = left instanceof Date && right instanceof Date
        ? left.getTime() === right.getTime()
        : (left ?? null) === (right ?? null);
      if (!same) return false;
    }
    return true;
  }

  function project(projection: unknown, table: string, row: Row): Row {
    if (!projection) return { ...row };
    return Object.fromEntries(Object.entries(projection as Record<string, unknown>)
      .map(([key, column]) => [key, resolve(column, { [table]: row })]));
  }

  /* Column defaults the module relies on the database to supply. */
  const defaults: Record<string, () => Row> = {
    mail_in_mailbox: () => ({
      singleton: true, id: randomUUID(), host: "", port: 993, accountUser: "", mailbox: "INBOX",
      tlsServerName: "", providerProfile: "other", authMethod: "password", trustedRecipientHeader: "",
      pollSeconds: 300, enabled: false, verificationState: "unverified", verifiedAt: null,
      passwordSecretId: null, aliasKeySecretId: null, version: 1,
      createdAt: new Date(), updatedAt: new Date(),
    }),
    mail_in_secrets: () => ({ id: randomUUID(), createdByUserId: null, createdAt: new Date(), updatedAt: new Date() }),
    audit_log: () => ({ id: randomUUID(), createdAt: new Date() }),
    mail_in_relays: () => ({ currentGeneration: 1, previousGeneration: null, previousExpiresAt: null, ingestPausedAt: null, rotatedAt: null, version: 1, createdAt: new Date(), updatedAt: new Date() }),
    imap_recipient_aliases: () => ({ id: randomUUID(), status: "active", activeUntil: null, createdAt: new Date(), updatedAt: new Date() }),
  };

  function makeSelect(projection?: unknown) {
    let base = "";
    let selected: Sources[] = [];
    const builder: Record<string, unknown> = {
      from(table: unknown) {
        base = getTableName(table as never);
        selected = rowsOf(base).map((row) => ({ [base]: row }));
        return builder;
      },
      leftJoin(table: unknown, condition: unknown) {
        const name = getTableName(table as never);
        selected = selected.map((sources) => ({
          ...sources,
          [name]: rowsOf(name).find((row) => matches(condition, { ...sources, [name]: row })) ?? null,
        }));
        return builder;
      },
      where(condition: unknown) {
        selected = selected.filter((sources) => matches(condition, sources));
        return builder;
      },
      for: () => builder,
      orderBy: () => builder,
      limit(count: number) {
        selected = selected.slice(0, count);
        return builder;
      },
      then(onFulfilled: (value: Row[]) => unknown, onRejected?: (reason: unknown) => unknown) {
        const result = selected.map((sources) => (projection
          ? Object.fromEntries(Object.entries(projection as Record<string, unknown>)
            .map(([key, column]) => [key, resolve(column, sources)]))
          : { ...sources[base] }));
        return Promise.resolve(result).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  const fakeDb: Record<string, unknown> = {
    select: (projection?: unknown) => makeSelect(projection),
    insert: (table: unknown) => {
      const name = getTableName(table as never);
      return {
        values(values: Row | Row[]) {
          const inserted = (Array.isArray(values) ? values : [values])
            .map((value) => ({ ...defaults[name]?.(), ...value }));
          rowsOf(name).push(...inserted);
          return {
            returning: (projection?: unknown) => Promise.resolve(inserted.map((row) => project(projection, name, row))),
            then: (onFulfilled: (value: number) => unknown) => Promise.resolve(inserted.length).then(onFulfilled),
          };
        },
      };
    },
    update: (table: unknown) => {
      const name = getTableName(table as never);
      return {
        set: (values: Row) => {
          const apply = (condition?: unknown) => {
            const rows = rowsOf(name);
            const changed: Row[] = [];
            for (let index = 0; index < rows.length; index += 1) {
              if (!matches(condition, { [name]: rows[index] })) continue;
              rows[index] = { ...rows[index], ...values };
              changed.push(rows[index]);
            }
            return changed;
          };
          return {
            where(condition: unknown) {
              const changed = apply(condition);
              return {
                returning: (projection?: unknown) => Promise.resolve(changed.map((row) => project(projection, name, row))),
                then: (onFulfilled: (value: number) => unknown) => Promise.resolve(changed.length).then(onFulfilled),
              };
            },
            /* An UPDATE with no WHERE is the whole table, which is exactly what
               a moved mailbox account means for every relay (ADR-0017 slice 3). */
            then: (onFulfilled: (value: number) => unknown) => Promise.resolve(apply().length).then(onFulfilled),
          };
        },
      };
    },
    delete: (table: unknown) => {
      const name = getTableName(table as never);
      const run = (condition?: unknown) => {
        mocks.tables[name] = rowsOf(name).filter((row) => !matches(condition, { [name]: row }));
      };
      return {
        where(condition: unknown) {
          return { then: (onFulfilled: (value: number) => unknown) => { run(condition); return Promise.resolve(0).then(onFulfilled); } };
        },
        then(onFulfilled: (value: number) => unknown) {
          run(undefined);
          return Promise.resolve(0).then(onFulfilled);
        },
      };
    },
    /* Real rollback semantics: a throw restores the tables as they were, so a
       refusal mid-transaction is observably all-or-nothing. */
    async transaction(callback: (transaction: unknown) => Promise<unknown>) {
      const snapshot = Object.fromEntries(Object.entries(mocks.tables).map(([name, rows]) => [name, [...rows]]));
      try {
        return await callback(fakeDb);
      } catch (error) {
        mocks.tables = snapshot;
        throw error;
      }
    },
  };

  return { getDb: () => fakeDb };
});

vi.mock("@/server/authorization", () => ({
  requireInstanceAdministrator: async (userId: string) => {
    const { AppError } = await import("@/lib/errors");
    if (!mocks.administrators.has(userId)) {
      throw new AppError("administrator_required", "Orbit administrator access is required", 403);
    }
  },
}));

vi.mock("@/server/documents/config", () => ({
  getDocumentConfig: () => ({ keyEncryptionKey: mocks.keyEncryptionKey, keyId: mocks.keyId }),
}));

vi.mock("./imap-ingestion", () => ({
  verifyImapProvider: mocks.verifyImap,
  getImapProviderPreflightState: mocks.preflight,
  createImapClient: mocks.createImapClient,
}));

vi.mock("@/server/notification-worker", () => ({
  getNotificationWorkerConfig: () => { throw new Error("SMTP_URL is not configured"); },
  createSmtpTransport: () => { throw new Error("no transport in a unit test"); },
}));

vi.mock("@/lib/logger", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { randomUUID } from "node:crypto";
import { getTableName } from "drizzle-orm";
import { auditLog, imapRecipientAliases, mailInMailbox, mailInSecrets } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { decryptMailInSecret } from "./core/secret-crypto";
import { imapAliasBaseFromAccount, normalizeImapRecipientAlias } from "./core/imap-recipient";
import { resetMailInCredentialLockAuditForTests } from "./mailbox-config";
import {
  mailboxSettingsInputSchema,
  readMailboxSettings,
  removeMailboxCredential,
  rotateMailboxPassword,
  runMailboxSetupProbe,
  setMailboxIngestEnabled,
  setMailboxSettings,
  verifyMailboxCredential,
  type MailboxSettingsDependencies,
  type MailboxSettingsInput,
} from "./mailbox-settings";

const settings: MailboxSettingsInput = {
  host: "imap.example.test",
  port: 993,
  accountUser: "intake@example.test",
  mailbox: "INBOX",
  tlsServerName: "imap.example.test",
  providerProfile: "mailcow",
  trustedRecipientHeader: "X-Original-To",
  trustedAuthservId: "mx.provider.test",
  pollSeconds: 300,
  password: FIRST_PASSWORD,
};

/** A provider that authenticates; no socket is ever opened. */
const providerReady: MailboxSettingsDependencies = { verifyImap: async () => "ready" };
/** A provider that refuses, which is the rotation- and set-failure case. */
const providerRefuses: MailboxSettingsDependencies = { verifyImap: async () => "imap_unavailable" };

const smtp = {
  smtpUrl: "smtp://smtp.example.test:587",
  smtpSecurity: "starttls" as const,
  smtpFrom: "orbit@example.test",
  vapidSubject: "",
  vapidPublicKey: "",
  vapidPrivateKey: "",
  pollMilliseconds: 30_000,
  maxAttempts: 5,
};

function rows(table: unknown): Record<string, unknown>[] {
  return mocks.tables[getTableName(table as never)] ?? [];
}

function mailbox(): Record<string, unknown> | undefined {
  return rows(mailInMailbox)[0];
}

function secretsOfKind(kind: string): Record<string, unknown>[] {
  return rows(mailInSecrets).filter((row) => row.kind === kind);
}

function auditActions(): string[] {
  return rows(auditLog).map((row) => String(row.action));
}

/** Reads a stored secret back the way the runtime does, to prove what was written. */
function decryptStored(row: Record<string, unknown>, account: { host: string; user: string }): string {
  return decryptMailInSecret(
    row.ciphertext as Buffer,
    { secretId: row.id as string, kind: row.kind as "imap_password", host: account.host, user: account.user },
    {
      envelopeVersion: 1,
      algorithm: "aes-256-gcm",
      keyId: row.keyId as string,
      contentIv: row.contentIv as string,
      contentAuthTag: row.contentAuthTag as string,
      wrappedDek: row.wrappedDek as string,
      wrapIv: row.wrapIv as string,
      wrapAuthTag: row.wrapAuthTag as string,
    },
    mocks.keyEncryptionKey,
  ).toString("utf8");
}

/** Puts a configured, verified mailbox in place and answers its version. */
async function configureMailbox(input: MailboxSettingsInput = settings): Promise<number> {
  const current = mailbox();
  const expected = current ? (current.version as number) : null;
  const { outcome } = await setMailboxSettings(ADMIN, expected, input, providerReady);
  expect(outcome).toBe("verified");
  return mailbox()?.version as number;
}

beforeEach(() => {
  mocks.tables = {};
  mocks.administrators = new Set([ADMIN]);
  mocks.verifyImap.mockReset();
  mocks.preflight.mockReset();
  mocks.createImapClient.mockReset();
  mocks.createImapClient.mockImplementation(() => { throw new Error("no socket in a unit test"); });
  mocks.preflight.mockReturnValue({
    status: "verification_pending", smtp: "not_configured", imap: "not_configured", checkedAt: null,
  });
  resetMailInCredentialLockAuditForTests();
});

afterEach(() => {
  resetMailInCredentialLockAuditForTests();
});

describe("what makes a mailbox configured (ADR-0017 decision 1, slice 2)", () => {
  it("reports an instance that has never been set up, without inventing a row", async () => {
    const view = await readMailboxSettings(ADMIN);
    expect(view.configured).toBe(false);
    expect(view.enabled).toBe(false);
    expect(view.version).toBeNull();
    expect(view.hasPassword).toBe(false);
    expect(view.hasAliasKey).toBe(false);
    expect(view.aliasPattern).toBeNull();
    expect(view.credentialSetAt).toBeNull();
    expect(rows(mailInMailbox)).toHaveLength(0);
  });

  it("counts a mailbox as configured only once host, account and a stored credential all exist", async () => {
    await configureMailbox();

    const view = await readMailboxSettings(ADMIN);
    expect(view.configured).toBe(true);
    expect(view.hasPassword).toBe(true);
    expect(view.hasAliasKey).toBe(true);
    expect(view.enabled).toBe(true);
    expect(view.verificationState).toBe("verified");
    expect(view.version).toBe(1);

    /* Removing the credential leaves the provider settings in place, so
       everything except the credential is still there and the mailbox is no
       longer configured. */
    const after = await removeMailboxCredential(ADMIN, 1);
    expect(after.configured).toBe(false);
    expect(after.hasPassword).toBe(false);
    expect(after.host).toBe(settings.host);
    expect(after.accountUser).toBe(settings.accountUser);
    expect(after.hasAliasKey).toBe(true);
    expect(after.enabled).toBe(false);
    expect(after.verificationState).toBe("unverified");
    expect(after.verifiedAt).toBeNull();
    expect(after.version).toBe(2);
  });

  it("shows the alias shape without ever printing a real member address", async () => {
    await configureMailbox();
    const view = await readMailboxSettings(ADMIN);
    expect(view.aliasPattern).toBe("intake+<code>@example.test");
  });

  it("falls back to a safe view when the account has no domain to derive addresses from", async () => {
    await configureMailbox();
    /* A row that predates validation, or one edited outside the API: the read
       path must still answer rather than throw. */
    const row = mailbox();
    if (row) row.accountUser = "intake";
    const view = await readMailboxSettings(ADMIN);
    expect(view.aliasPattern).toBeNull();
  });

  it("refuses every operation to a user who is not an instance administrator", async () => {
    await configureMailbox();
    const version = mailbox()?.version as number;
    const refusals: (() => Promise<unknown>)[] = [
      () => readMailboxSettings(OUTSIDER),
      () => setMailboxSettings(OUTSIDER, version, settings, providerReady),
      () => rotateMailboxPassword(OUTSIDER, version, SECOND_PASSWORD, providerReady),
      () => removeMailboxCredential(OUTSIDER, version),
      () => setMailboxIngestEnabled(OUTSIDER, version, false),
      () => verifyMailboxCredential(OUTSIDER, providerReady),
      () => runMailboxSetupProbe(OUTSIDER),
    ];
    for (const refusal of refusals) {
      await expect(refusal()).rejects.toMatchObject({ code: "administrator_required", status: 403 });
    }
    expect(mailbox()?.version).toBe(version);
  });
});

describe("no credential ever comes back out", () => {
  it("keeps the password out of the settings view, the audit trail and the stored row", async () => {
    await configureMailbox();
    const view = await readMailboxSettings(ADMIN);

    expect(JSON.stringify(view)).not.toContain(FIRST_PASSWORD);
    expect(JSON.stringify(rows(auditLog))).not.toContain(FIRST_PASSWORD);
    expect(JSON.stringify(mailbox())).not.toContain(FIRST_PASSWORD);

    const [stored] = secretsOfKind("imap_password");
    expect((stored.ciphertext as Buffer).toString("utf8")).not.toContain(FIRST_PASSWORD);
    expect(decryptStored(stored, { host: settings.host, user: settings.accountUser })).toBe(FIRST_PASSWORD);
  });

  it("records the credential's provenance without recording the credential", async () => {
    await configureMailbox();
    const [stored] = secretsOfKind("imap_password");
    expect(stored.createdByUserId).toBe(ADMIN);

    const view = await readMailboxSettings(ADMIN);
    expect(view.credentialSetAt).toBe((stored.createdAt as Date).toISOString());
    /* No `users` row is seeded here, so the display name is genuinely absent
       rather than defaulted to something that looks like a person. */
    expect(view.credentialSetBy).toBeNull();
  });

  it("audits a bounded action and key id, never the secret's kind of detail", async () => {
    await configureMailbox();
    const [entry] = rows(auditLog);
    expect(entry.action).toBe("mail_in_credential_created");
    expect(entry.entityType).toBe("mail_in_mailbox");
    expect(entry.changes).toEqual({ kind: "imap_password", keyId: mocks.keyId });
  });
});

describe("verification outcomes are a bounded vocabulary", () => {
  const cases: [string, MailboxSettingsDependencies, string][] = [
    ["an authenticated connect", { verifyImap: async () => "ready" }, "verified"],
    ["a provider that reports nothing to connect to", { verifyImap: async () => "imap_unconfigured" }, "not_configured"],
    ["a provider that refuses or cannot be reached", { verifyImap: async () => "imap_unavailable" }, "provider_unavailable"],
    ["a verification that throws", { verifyImap: async () => { throw new Error("ECONNREFUSED 10.0.0.1:993"); } }, "provider_unavailable"],
  ];

  for (const [description, dependencies, expected] of cases) {
    it(`maps ${description} to ${expected}`, async () => {
      const { outcome } = await setMailboxSettings(ADMIN, null, settings, dependencies);
      expect(outcome).toBe(expected);
    });
  }

  it("never lets the provider's own error text reach the caller or the audit trail", async () => {
    await configureMailbox();
    const leak = "AUTHENTICATIONFAILED user intake@example.test password rejected";
    const { outcome } = await setMailboxSettings(ADMIN, 1, settings, {
      verifyImap: async () => { throw new Error(leak); },
    });
    expect(outcome).toBe("provider_unavailable");
    expect(JSON.stringify(rows(auditLog))).not.toContain("AUTHENTICATIONFAILED");
  });

  it("writes nothing at all when the credential being set fails verification", async () => {
    const { outcome, settings: view } = await setMailboxSettings(ADMIN, null, settings, providerRefuses);
    expect(outcome).toBe("provider_unavailable");
    expect(view.configured).toBe(false);
    expect(rows(mailInMailbox)).toHaveLength(0);
    expect(rows(mailInSecrets)).toHaveLength(0);
    /* Nothing was configured, so there is nothing to attribute the failure
       to and no audit row is written either. */
    expect(rows(auditLog)).toHaveLength(0);
  });

  it("leaves an already-configured mailbox exactly as it was when a re-set fails verification", async () => {
    await configureMailbox();
    const before = { ...mailbox() };

    const { outcome } = await setMailboxSettings(ADMIN, 1, { ...settings, host: "imap.elsewhere.test" }, providerRefuses);
    expect(outcome).toBe("provider_unavailable");

    const after = mailbox();
    expect(after?.host).toBe(settings.host);
    expect(after?.version).toBe(before.version);
    expect(after?.passwordSecretId).toBe(before.passwordSecretId);
    expect(after?.verificationState).toBe("verified");
    expect(secretsOfKind("imap_password")).toHaveLength(1);
    expect(auditActions()).toContain("mail_in_credential_verified");
  });

  it("marks the stored mailbox verified or failed when the credential is checked on its own", async () => {
    await configureMailbox();

    const failed = await verifyMailboxCredential(ADMIN, providerRefuses);
    expect(failed.outcome).toBe("provider_unavailable");
    expect(mailbox()?.verificationState).toBe("failed");
    /* A failed re-check must not erase the time the credential last worked. */
    expect(failed.settings.verifiedAt).not.toBeNull();

    const passed = await verifyMailboxCredential(ADMIN, providerReady);
    expect(passed.outcome).toBe("verified");
    expect(mailbox()?.verificationState).toBe("verified");
  });

  it("answers not_configured, and checks nothing, before a mailbox exists", async () => {
    const verify = vi.fn();
    const { outcome } = await verifyMailboxCredential(ADMIN, { verifyImap: verify });
    expect(outcome).toBe("not_configured");
    expect(verify).not.toHaveBeenCalled();
    expect(rows(auditLog)).toHaveLength(0);
  });
});

describe("a credential that cannot be decrypted locks rather than silently disabling", () => {
  /** Re-points the stored password at a different account, which its own AAD refuses. */
  function breakStoredCredential(): void {
    const row = mailbox();
    if (row) row.accountUser = "someone-else@example.test";
  }

  it("reports credential_locked instead of a decryption error, and never a plaintext", async () => {
    await configureMailbox();
    breakStoredCredential();

    const { outcome, settings: view } = await verifyMailboxCredential(ADMIN, providerReady);
    expect(outcome).toBe("credential_locked");
    expect(view.health.credentialLocked).toBe(true);
    expect(view.health.status).toBe("credential_locked");
    expect(view.health.imap).toBe("unsafe_input");
    expect(mailbox()?.verificationState).toBe("failed");
    expect(JSON.stringify(rows(auditLog))).not.toContain(FIRST_PASSWORD);
  });

  it("still answers the settings read, so the administrator can see why ingest stopped", async () => {
    await configureMailbox();
    breakStoredCredential();

    const view = await readMailboxSettings(ADMIN);
    expect(view.health.credentialLocked).toBe(true);
    expect(view.configured).toBe(true);
    expect(view.hasPassword).toBe(true);
  });

  it("audits one locked event per distinct key rather than one per read", async () => {
    await configureMailbox();
    breakStoredCredential();

    await readMailboxSettings(ADMIN);
    await readMailboxSettings(ADMIN);
    await readMailboxSettings(ADMIN);

    expect(auditActions().filter((action) => action === "mail_in_credential_locked")).toHaveLength(1);
  });
});

describe("rotation", () => {
  it("refuses when there is no mailbox at all", async () => {
    await expect(rotateMailboxPassword(ADMIN, 1, SECOND_PASSWORD, providerReady))
      .rejects.toMatchObject({ code: "mailbox_not_configured", status: 409 });
    expect(rows(mailInSecrets)).toHaveLength(0);
  });

  it("refuses when the mailbox exists but has no credential to rotate", async () => {
    await configureMailbox();
    await removeMailboxCredential(ADMIN, 1);
    const version = mailbox()?.version as number;

    await expect(rotateMailboxPassword(ADMIN, version, SECOND_PASSWORD, providerReady))
      .rejects.toMatchObject({ code: "mailbox_not_configured", status: 409 });
    expect(secretsOfKind("imap_password")).toHaveLength(0);
  });

  it("refuses a password the provider could never authenticate with", async () => {
    await configureMailbox();
    await expect(rotateMailboxPassword(ADMIN, 1, "control\u0007character", providerReady)).rejects.toThrow();
    expect(mailbox()?.version).toBe(1);
  });

  it("makes the new credential active and deletes the superseded row in one transaction", async () => {
    await configureMailbox();
    const supersededId = mailbox()?.passwordSecretId;

    const { outcome } = await rotateMailboxPassword(ADMIN, 1, SECOND_PASSWORD, providerReady);
    expect(outcome).toBe("verified");

    const stored = secretsOfKind("imap_password");
    expect(stored).toHaveLength(1);
    expect(stored[0].id).not.toBe(supersededId);
    expect(mailbox()?.passwordSecretId).toBe(stored[0].id);
    expect(mailbox()?.version).toBe(2);
    expect(decryptStored(stored[0], { host: settings.host, user: settings.accountUser })).toBe(SECOND_PASSWORD);
    expect(auditActions()).toContain("mail_in_credential_rotated");
  });

  it("leaves the previous credential active, and writes no new secret, when the new one fails", async () => {
    await configureMailbox();
    const activeId = mailbox()?.passwordSecretId;

    const { outcome } = await rotateMailboxPassword(ADMIN, 1, SECOND_PASSWORD, providerRefuses);
    expect(outcome).toBe("provider_unavailable");

    const stored = secretsOfKind("imap_password");
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(activeId);
    expect(decryptStored(stored[0], { host: settings.host, user: settings.accountUser })).toBe(FIRST_PASSWORD);
    expect(mailbox()?.version).toBe(1);
    expect(auditActions()).not.toContain("mail_in_credential_rotated");
  });
});

describe("removal", () => {
  it("refuses when there is no mailbox at all, because no version can match an absent row", async () => {
    await expect(removeMailboxCredential(ADMIN, 1))
      .rejects.toMatchObject({ code: "mailbox_version_conflict", status: 409 });
  });

  it("refuses a second removal, because there is nothing left to remove", async () => {
    await configureMailbox();
    await removeMailboxCredential(ADMIN, 1);
    const version = mailbox()?.version as number;

    await expect(removeMailboxCredential(ADMIN, version))
      .rejects.toMatchObject({ code: "mailbox_not_configured", status: 409 });
    /* The refusal rolls back: the version must not have advanced. */
    expect(mailbox()?.version).toBe(version);
  });

  it("deletes the secret row, switches ingest off and keeps the alias key", async () => {
    await configureMailbox();
    const aliasKeyId = mailbox()?.aliasKeySecretId;

    await removeMailboxCredential(ADMIN, 1);

    expect(secretsOfKind("imap_password")).toHaveLength(0);
    expect(secretsOfKind("alias_key")).toHaveLength(1);
    expect(mailbox()?.aliasKeySecretId).toBe(aliasKeyId);
    expect(mailbox()?.enabled).toBe(false);
    expect(auditActions()).toContain("mail_in_credential_removed");
  });
});

describe("enabling and disabling ingest", () => {
  it("switches polling without touching the credential", async () => {
    await configureMailbox();
    const credentialId = mailbox()?.passwordSecretId;

    const disabled = await setMailboxIngestEnabled(ADMIN, 1, false);
    expect(disabled.enabled).toBe(false);
    expect(mailbox()?.passwordSecretId).toBe(credentialId);

    const enabled = await setMailboxIngestEnabled(ADMIN, 2, true);
    expect(enabled.enabled).toBe(true);
    expect(mailbox()?.passwordSecretId).toBe(credentialId);
    expect(auditActions()).toContain("mail_in_ingest_disabled");
    expect(auditActions()).toContain("mail_in_ingest_enabled");
  });

  it("refuses to enable ingest when there is no credential to poll with", async () => {
    await configureMailbox();
    await removeMailboxCredential(ADMIN, 1);
    const version = mailbox()?.version as number;

    await expect(setMailboxIngestEnabled(ADMIN, version, true))
      .rejects.toMatchObject({ code: "mailbox_not_configured", status: 409 });
    expect(mailbox()?.enabled).toBe(false);
    expect(mailbox()?.version).toBe(version);
  });

  it("refuses when there is no mailbox at all, because no version can match an absent row", async () => {
    await expect(setMailboxIngestEnabled(ADMIN, 1, false))
      .rejects.toMatchObject({ code: "mailbox_version_conflict", status: 409 });
  });
});

describe("the version check stops two administrators overwriting each other", () => {
  it("refuses a first setup that claims a version, because there is no row to have a version", async () => {
    const { outcome } = await setMailboxSettings(ADMIN, null, settings, providerReady);
    expect(outcome).toBe("verified");
    mocks.tables = {};

    await expect(setMailboxSettings(ADMIN, 0, settings, providerReady))
      .rejects.toBeInstanceOf(AppError);
    expect(rows(mailInMailbox)).toHaveLength(0);
    expect(rows(mailInSecrets)).toHaveLength(0);
  });

  it("refuses a set whose expected version is stale, before it reaches the provider", async () => {
    await configureMailbox();
    const verify = vi.fn(async () => "ready" as const);

    await expect(setMailboxSettings(ADMIN, 99, { ...settings, host: "imap.elsewhere.test" }, { verifyImap: verify }))
      .rejects.toMatchObject({ code: "mailbox_version_conflict", status: 409 });
    expect(verify).not.toHaveBeenCalled();
    expect(mailbox()?.host).toBe(settings.host);
    expect(mailbox()?.version).toBe(1);
  });

  it("refuses a stale rotation without touching the credential", async () => {
    await configureMailbox();
    const activeId = mailbox()?.passwordSecretId;

    await expect(rotateMailboxPassword(ADMIN, 99, SECOND_PASSWORD, providerReady))
      .rejects.toMatchObject({ code: "mailbox_version_conflict", status: 409 });
    expect(mailbox()?.passwordSecretId).toBe(activeId);
    expect(secretsOfKind("imap_password")).toHaveLength(1);
  });

  it("refuses a stale removal and a stale enable, leaving the row untouched", async () => {
    await configureMailbox();

    await expect(removeMailboxCredential(ADMIN, 99))
      .rejects.toMatchObject({ code: "mailbox_version_conflict", status: 409 });
    await expect(setMailboxIngestEnabled(ADMIN, 99, false))
      .rejects.toMatchObject({ code: "mailbox_version_conflict", status: 409 });

    expect(mailbox()?.version).toBe(1);
    expect(mailbox()?.enabled).toBe(true);
    expect(secretsOfKind("imap_password")).toHaveLength(1);
  });

  it("advances the version by exactly one per accepted change", async () => {
    await configureMailbox();
    expect(mailbox()?.version).toBe(1);
    await rotateMailboxPassword(ADMIN, 1, SECOND_PASSWORD, providerReady);
    expect(mailbox()?.version).toBe(2);
    await setMailboxIngestEnabled(ADMIN, 2, false);
    expect(mailbox()?.version).toBe(3);
    await removeMailboxCredential(ADMIN, 3);
    expect(mailbox()?.version).toBe(4);
  });
});

describe("the alias key follows the account, not the edit", () => {
  it("keeps the alias key, and every address derived from it, when neither host nor account changes", async () => {
    await configureMailbox();
    const aliasKeyId = mailbox()?.aliasKeySecretId;
    const aliasCiphertext = secretsOfKind("alias_key")[0].ciphertext;

    /* A port correction and a new password: nothing the alias key is bound to. */
    await configureMailbox({ ...settings, port: 143, password: SECOND_PASSWORD });

    expect(mailbox()?.port).toBe(143);
    expect(mailbox()?.aliasKeySecretId).toBe(aliasKeyId);
    expect(secretsOfKind("alias_key")).toHaveLength(1);
    expect(secretsOfKind("alias_key")[0].ciphertext).toEqual(aliasCiphertext);
  });

  it("re-keys when the account moves, because the old key can no longer decrypt", async () => {
    await configureMailbox();
    const aliasKeyId = mailbox()?.aliasKeySecretId;

    await configureMailbox({ ...settings, accountUser: "post@example.test" });

    expect(mailbox()?.aliasKeySecretId).not.toBe(aliasKeyId);
    /* One row, not two: the superseded key is deleted in the same transaction. */
    expect(secretsOfKind("alias_key")).toHaveLength(1);
    expect((await readMailboxSettings(ADMIN)).aliasPattern).toBe("post+<code>@example.test");
  });

  it("re-keys when the host moves too, because the key is bound to host as well as account", async () => {
    await configureMailbox();
    const aliasKeyId = mailbox()?.aliasKeySecretId;

    await configureMailbox({ ...settings, host: "imap2.example.test" });

    /* The alias key's own AAD names the host, so a key kept across a host
       change would never decrypt again. Addresses are unchanged in shape
       because they are derived from the account, which did not move. */
    expect(mailbox()?.aliasKeySecretId).not.toBe(aliasKeyId);
    expect(secretsOfKind("alias_key")).toHaveLength(1);
    expect((await readMailboxSettings(ADMIN)).aliasPattern).toBe("intake+<code>@example.test");
  });

  it("retires every alias row when a new alias key is generated, so no dead address stays eligible", async () => {
    await configureMailbox();
    mocks.tables[getTableName(imapRecipientAliases)] = [
      { id: randomUUID(), userId: randomUUID(), generation: 1, aliasSha256: "a".repeat(64), status: "active", activeUntil: null },
      { id: randomUUID(), userId: randomUUID(), generation: 1, aliasSha256: "b".repeat(64), status: "active", activeUntil: null },
    ];

    await configureMailbox({ ...settings, accountUser: "moved@example.test" });

    expect(rows(imapRecipientAliases).map((row) => row.status)).toEqual(["legacy_inactive", "legacy_inactive"]);
  });

  it("leaves every alias row alone when the alias key is kept", async () => {
    await configureMailbox();
    mocks.tables[getTableName(imapRecipientAliases)] = [
      { id: randomUUID(), userId: randomUUID(), generation: 1, aliasSha256: "a".repeat(64), status: "active", activeUntil: null },
    ];

    await configureMailbox({ ...settings, pollSeconds: 600 });

    expect(rows(imapRecipientAliases).map((row) => row.status)).toEqual(["active"]);
  });
});

describe("the setup probe (degradation ladder rung 1)", () => {
  const probeDependencies = (overrides: MailboxSettingsDependencies = {}): MailboxSettingsDependencies => ({
    smtpConfig: () => smtp,
    sendProbeMail: async () => undefined,
    findProbeMessage: async () => undefined,
    ...overrides,
  });

  it("answers not_configured, and sends nothing, before a mailbox exists", async () => {
    const send = vi.fn();
    const { outcome } = await runMailboxSetupProbe(ADMIN, probeDependencies({ sendProbeMail: send }));
    expect(outcome).toBe("not_configured");
    expect(send).not.toHaveBeenCalled();
  });

  it("answers not_configured, and sends nothing, when the mailbox has no credential", async () => {
    await configureMailbox();
    await removeMailboxCredential(ADMIN, 1);
    const send = vi.fn();

    const { outcome } = await runMailboxSetupProbe(ADMIN, probeDependencies({ sendProbeMail: send }));
    expect(outcome).toBe("not_configured");
    expect(send).not.toHaveBeenCalled();
  });

  it("answers credential_locked, and sends nothing, when the stored credential cannot be decrypted", async () => {
    await configureMailbox();
    const row = mailbox();
    if (row) row.accountUser = "someone-else@example.test";
    const send = vi.fn();

    const { outcome } = await runMailboxSetupProbe(ADMIN, probeDependencies({ sendProbeMail: send }));
    expect(outcome).toBe("credential_locked");
    expect(send).not.toHaveBeenCalled();
  });

  it("separates a missing SMTP sender from an SMTP sender that will not send", async () => {
    await configureMailbox();

    const noConfig = await runMailboxSetupProbe(ADMIN, probeDependencies({
      smtpConfig: () => { throw new Error("SMTP_URL is not configured"); },
    }));
    expect(noConfig.outcome).toBe("smtp_not_configured");

    const noSender = await runMailboxSetupProbe(ADMIN, probeDependencies({
      smtpConfig: () => ({ ...smtp, smtpFrom: "" }),
    }));
    expect(noSender.outcome).toBe("smtp_not_configured");

    const refused = await runMailboxSetupProbe(ADMIN, probeDependencies({
      sendProbeMail: async () => { throw new Error("connect ECONNREFUSED"); },
    }));
    expect(refused.outcome).toBe("smtp_unavailable");
  });

  it("separates a mailbox that never received the message from one that could not be searched", async () => {
    await configureMailbox();

    const missing = await runMailboxSetupProbe(ADMIN, probeDependencies({ findProbeMessage: async () => undefined }));
    expect(missing.outcome).toBe("not_delivered");

    const unreachable = await runMailboxSetupProbe(ADMIN, probeDependencies({
      findProbeMessage: async () => { throw new Error("connection closed"); },
    }));
    expect(unreachable.outcome).toBe("provider_unavailable");
  });

  it("reports delivered only when the message comes back carrying its own envelope recipient", async () => {
    await configureMailbox();
    let sentTo = "";

    const delivered = await runMailboxSetupProbe(ADMIN, probeDependencies({
      sendProbeMail: async (message) => { sentTo = message.to; },
      findProbeMessage: async () => ({ trustedRecipient: sentTo }),
    }));
    expect(delivered.outcome).toBe("delivered");

    /* Same round trip, but the provider stripped the header: mail arrives and
       can never be attributed, which is a different remedy. */
    const stripped = await runMailboxSetupProbe(ADMIN, probeDependencies({
      sendProbeMail: async (message) => { sentTo = message.to; },
      findProbeMessage: async () => ({}),
    }));
    expect(stripped.outcome).toBe("delivered_without_recipient_header");

    /* A header naming some other address is not proof either. */
    const wrongAddress = await runMailboxSetupProbe(ADMIN, probeDependencies({
      findProbeMessage: async () => ({ trustedRecipient: "intake+someone-else@example.test" }),
    }));
    expect(wrongAddress.outcome).toBe("delivered_without_recipient_header");
  });

  it("addresses the probe to a plus-address that belongs to nobody and is different every run", async () => {
    await configureMailbox();
    const addressed: string[] = [];
    const subjects: string[] = [];
    const dependencies = probeDependencies({
      sendProbeMail: async (message) => {
        addressed.push(message.to);
        subjects.push(message.subject);
      },
    });

    await runMailboxSetupProbe(ADMIN, dependencies);
    await runMailboxSetupProbe(ADMIN, dependencies);

    const base = imapAliasBaseFromAccount(settings.accountUser);
    for (const address of addressed) {
      expect(normalizeImapRecipientAlias(address, base)).toBe(address.toLowerCase());
      expect(address.startsWith("intake+")).toBe(true);
      expect(address.endsWith("@example.test")).toBe(true);
    }
    expect(addressed[0]).not.toBe(addressed[1]);
    expect(subjects[0]).not.toBe(subjects[1]);
    expect(addressed[0]).not.toContain(ADMIN);
  });

  it("records the probe's answer as one bounded word, and does not mark the mailbox failed", async () => {
    await configureMailbox();
    await runMailboxSetupProbe(ADMIN, probeDependencies());

    const verified = rows(auditLog).filter((row) => row.action === "mail_in_credential_verified");
    expect(verified).toHaveLength(1);
    expect(verified[0].changes).toEqual({ outcome: "not_delivered" });
    /* The probe reports; only an explicit verification re-states the mailbox. */
    expect(mailbox()?.verificationState).toBe("verified");
  });
});

describe("finding the probe's own message in the mailbox", () => {
  /**
   * The probe's default search, driven through the IMAP client seam rather
   * than a stubbed answer, so the parts that are this module's own work are
   * exercised: searching by the random subject, reading the configured
   * trusted-recipient header out of the raw headers, and taking the message
   * back out of the mailbox afterwards.
   */
  interface FakeClientCalls {
    searched: Record<string, unknown>[];
    deleted: string[];
    loggedOut: number;
    released: number;
  }

  function installClient(options: {
    uids: number[];
    headers?: (sentTo: string) => string;
    refuseDelete?: boolean;
    sentTo: () => string;
  }): FakeClientCalls {
    const calls: FakeClientCalls = { searched: [], deleted: [], loggedOut: 0, released: 0 };
    mocks.createImapClient.mockImplementation(() => ({
      connect: async () => undefined,
      getMailboxLock: async () => ({ release: () => { calls.released += 1; } }),
      search: async (query: Record<string, unknown>) => {
        calls.searched.push(query);
        return options.uids;
      },
      fetchOne: async () => ({
        headers: Buffer.from(options.headers ? options.headers(options.sentTo()) : "", "utf8"),
      }),
      messageDelete: async (uid: string) => {
        calls.deleted.push(uid);
        if (options.refuseDelete) throw new Error("EXPUNGE refused");
        return true;
      },
      logout: async () => { calls.loggedOut += 1; },
    }));
    return calls;
  }

  it("searches by the probe's own random subject, reads the header, and expunges the message", async () => {
    await configureMailbox();
    let sentTo = "";
    let subject = "";
    const calls = installClient({
      uids: [17, 42],
      headers: (to) => `From: orbit@example.test\r\nX-Original-To: ${to}\r\nSubject: whatever\r\n`,
      sentTo: () => sentTo,
    });

    const { outcome } = await runMailboxSetupProbe(ADMIN, {
      smtpConfig: () => smtp,
      sendProbeMail: async (message) => { sentTo = message.to; subject = message.subject; },
    });

    expect(outcome).toBe("delivered");
    expect(calls.searched).toEqual([{ subject }]);
    /* The newest match, and only that one UID, is taken back out. */
    expect(calls.deleted).toEqual(["42"]);
    expect(calls.released).toBe(1);
    expect(calls.loggedOut).toBe(1);
  });

  it("reports delivered_without_recipient_header when the provider stripped the header", async () => {
    await configureMailbox();
    let sentTo = "";
    installClient({
      uids: [7],
      headers: () => "From: orbit@example.test\r\nSubject: whatever\r\n",
      sentTo: () => sentTo,
    });

    const { outcome } = await runMailboxSetupProbe(ADMIN, {
      smtpConfig: () => smtp,
      sendProbeMail: async (message) => { sentTo = message.to; },
    });

    expect(outcome).toBe("delivered_without_recipient_header");
  });

  it("still answers delivered when the provider refuses to expunge the probe's message", async () => {
    await configureMailbox();
    let sentTo = "";
    const calls = installClient({
      uids: [3],
      headers: (to) => `x-original-to: ${to}\r\n`,
      refuseDelete: true,
      sentTo: () => sentTo,
    });

    const { outcome } = await runMailboxSetupProbe(ADMIN, {
      smtpConfig: () => smtp,
      sendProbeMail: async (message) => { sentTo = message.to; },
    });

    /* The answer was already known; a refused cleanup must not turn a
       successful probe into a failed one. */
    expect(outcome).toBe("delivered");
    expect(calls.deleted).toEqual(["3"]);
    expect(calls.loggedOut).toBe(1);
  });
});

describe("the settings a mailbox will accept", () => {
  const valid = { ...settings };

  it("requires a full mailbox address, not a bare local part or a domain", () => {
    for (const accountUser of ["intake", "@example.test", "intake@", "  "]) {
      expect(mailboxSettingsInputSchema.safeParse({ ...valid, accountUser }).success).toBe(false);
    }
    expect(mailboxSettingsInputSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a password with a control character rather than silently trimming it", () => {
    /* Trimming would store a credential that can never authenticate. */
    for (const password of ["fake\u0000password", "fake\npassword", "fake\u007fpassword", ""]) {
      expect(mailboxSettingsInputSchema.safeParse({ ...valid, password }).success).toBe(false);
    }
    expect(mailboxSettingsInputSchema.safeParse({ ...valid, password: "fake password with spaces" }).success).toBe(true);
  });

  it("bounds the port, the poll interval and the trusted header's shape", () => {
    expect(mailboxSettingsInputSchema.safeParse({ ...valid, port: 0 }).success).toBe(false);
    expect(mailboxSettingsInputSchema.safeParse({ ...valid, port: 70_000 }).success).toBe(false);
    expect(mailboxSettingsInputSchema.safeParse({ ...valid, pollSeconds: 29 }).success).toBe(false);
    expect(mailboxSettingsInputSchema.safeParse({ ...valid, pollSeconds: 3_601 }).success).toBe(false);
    expect(mailboxSettingsInputSchema.safeParse({ ...valid, trustedRecipientHeader: "X Original To" }).success).toBe(false);
    expect(mailboxSettingsInputSchema.safeParse({ ...valid, trustedRecipientHeader: "" }).success).toBe(false);
  });

  it("accepts only the provider profiles the settings screen offers", () => {
    for (const providerProfile of ["mailcow", "gmail", "outlook", "other"]) {
      expect(mailboxSettingsInputSchema.safeParse({ ...valid, providerProfile }).success).toBe(true);
    }
    expect(mailboxSettingsInputSchema.safeParse({ ...valid, providerProfile: "fastmail" }).success).toBe(false);
  });
});
