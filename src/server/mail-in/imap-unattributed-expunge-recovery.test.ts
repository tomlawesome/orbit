import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SR1-R4: an unattributed message is answered and then queued for deletion,
 * but the delete itself runs in its own read-write lock after the whole
 * read-only pass (`deleteUnattributedMessages`, called once at the end of
 * `runImapIngestionCycle`). A crash between the receipt committing
 * (`status: "unattributed"`) and that delete running left the message in the
 * mailbox forever: the checkpoint above is `max(mailboxUid)` over every
 * receipt row, so the UID already reads as "seen" and is never refetched.
 *
 * The fix re-collects every still-unattributed, unexpired receipt for the
 * mailbox's current UIDVALIDITY epoch on every cycle and retries their
 * delete alongside whatever this pass found fresh. This proves that a
 * receipt left over from an earlier, interrupted cycle gets its delete
 * retried on the next one, with no new message arriving at all.
 */

const mocks = vi.hoisted(() => ({
  selectQueues: new Map<string, unknown[][]>(),
  deleted: [] as string[],
}));

function queue(table: string, rows: unknown[]) {
  const existing = mocks.selectQueues.get(table) ?? [];
  existing.push(rows);
  mocks.selectQueues.set(table, existing);
}

function nextRows(table: string): unknown[] {
  const list = mocks.selectQueues.get(table);
  if (!list || list.length === 0) return [];
  return list.shift()!;
}

vi.mock("@/db", async () => {
  const { getTableName } = await import("drizzle-orm");

  function selectBuilder() {
    let table = "";
    const chain: Record<string, unknown> = {
      from(t: unknown) {
        table = getTableName(t as never);
        return chain;
      },
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      then: (resolve: (rows: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(nextRows(table)).then(resolve, reject),
    };
    return chain;
  }

  const fakeDb: Record<string, unknown> = {
    select: () => selectBuilder(),
  };

  return { getDb: () => fakeDb };
});

// Only the reconciliation path matters here; the relay bookkeeping these
// call into does its own (real) database work that this file's minimal
// `@/db` fake cannot answer for.
vi.mock("./relays", () => ({
  ensureRelayAliases: async () => undefined,
  ensureRelayRow: async () => undefined,
  expireLapsedRelayAliases: async () => undefined,
  relayIngestIsPaused: async () => false,
  retireAliasesForDisabledUsers: async () => undefined,
}));

const { runImapIngestionCycle, setImapClientFactoryForTests } = await import("./imap-ingestion");
const { parseImapIngestionConfigFromEnvironment } = await import("./core/config");

function testConfig() {
  return parseImapIngestionConfigFromEnvironment({
    IMAP_HOST: "imap.example.test",
    IMAP_USER: "orbit",
    IMAP_PASSWORD: "test-password",
    IMAP_RECIPIENT_DOMAIN: "ingest.example.test",
    IMAP_ALIAS_CURRENT_GENERATION: "1",
    IMAP_ALIAS_CURRENT_SECRET: "test-current-alias-secret-that-is-long-enough",
    IMAP_TRUSTED_RECIPIENT_HEADER: "X-Original-To",
    SMTP_HOST: "smtp.example.test",
    NODE_ENV: "test",
  } as NodeJS.ProcessEnv);
}

function fakeClient() {
  return {
    mailbox: { uidValidity: 1001n, uidNext: 1 },
    async connect() {},
    async logout() {},
    async getMailboxLock() { return { release() {} }; },
    async search() { return []; },
    async messageDelete(range: string) { mocks.deleted.push(range); return true; },
  } as unknown as import("imapflow").ImapFlow;
}

beforeEach(() => {
  mocks.selectQueues.clear();
  mocks.deleted.length = 0;
  setImapClientFactoryForTests(fakeClient);
});

afterEach(() => {
  setImapClientFactoryForTests(undefined);
});

describe("unattributed-message expunge recovery (#1151 SR1-R4)", () => {
  it("retries deleting a receipt an earlier, interrupted cycle never got to expunge", async () => {
    // reconcileImapStagingObjects's own select.
    queue("imap_ingestion_staging_objects", []);
    // reconcileImapRecipientAliases's `users` scan.
    queue("users", []);
    // retryRows: nothing mid-processing.
    queue("imap_ingestion_messages", []);
    // checkpoint: max(mailboxUid) — nothing recorded yet, so nextUid is 1,
    // which is not below uidNext (1): the new-mail scan is skipped and no
    // message is fetched or processed this cycle at all.
    queue("imap_ingestion_messages", [{ lastUid: null }]);
    // pendingExpungeRows: a receipt an earlier cycle already marked
    // unattributed and never got to delete before crashing.
    queue("imap_ingestion_messages", [{ uid: 42 }]);

    await runImapIngestionCycle(testConfig());

    expect(mocks.deleted).toEqual(["42"]);
  });

  it("deletes nothing when there is no leftover unattributed receipt", async () => {
    queue("imap_ingestion_staging_objects", []);
    queue("users", []);
    queue("imap_ingestion_messages", []);
    queue("imap_ingestion_messages", [{ lastUid: null }]);
    queue("imap_ingestion_messages", []);

    await runImapIngestionCycle(testConfig());

    expect(mocks.deleted).toEqual([]);
  });
});
