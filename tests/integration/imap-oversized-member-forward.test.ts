import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { imapIngestionMessages } from "@/db/schema";
import { listImapInbox } from "@/server/mail-in/imap-inbox";
import { runImapIngestionCycle, setImapClientFactoryForTests } from "@/server/mail-in/imap-ingestion";
import { IMAP_ATTACHMENT_LIMITS } from "@/server/mail-in/core/imap-attachment-validation";
import { testImapConfig } from "../support/imap-config";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { attributedHeaders, fakeImapMailbox } from "./support/mail-in";
import { fixtureDnsLookups } from "./support/dkim-fixture";

/*
 * A-F3 (#1722): an oversized message from an address no member has verified
 * stays unattributed (message_too_large), needs no DNS lookup and is never
 * downloaded. The member case lives in mail-in-dkim-self-verification.test.ts
 * (sender_too_large, note 53119).
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

function config() {
  return testImapConfig({
    host: "imap.example.invalid", user: "orbit-test", password: "test-only-password",
    recipientDomain: "ingest.example.invalid", currentAliasSecret: "test-only-current-alias-secret-is-long-enough",
  });
}

/** A mailbox holding one message the server reports as over the raw limit; the cycle gets no usable source. */
function oversizedMailbox(uidValidity: number, headers: Buffer, downloads: string[]) {
  setImapClientFactoryForTests(() => fakeImapMailbox({
    uidValidity,
    search: "all",
    deleted: [],
    downloads,
    messages: [{ uid: 1, headers, size: IMAP_ATTACHMENT_LIMITS.rawMessageBytes + 1 }],
    download: () => { throw new Error("an oversized message must not be downloaded"); },
  }).client);
}

type Listed = { message: string; reason: string };
const listed = async (userId: string) => (await listImapInbox(userId)).receipts as unknown as Listed[];

describe("an oversized message from a stranger (A-F3, #1722)", () => {
  it("stays unattributed when no member has verified the sending address", async () => {
    const fixture = await createIntegrationFixture("oversized-stranger");
    try {
      const downloads: string[] = [];
      oversizedMailbox(202, attributedHeaders("stranger@example.invalid"), downloads);
      await runImapIngestionCycle(config());

      const rows = await getDb().select().from(imapIngestionMessages).where(eq(imapIngestionMessages.mailboxUidValidity, "202"));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ userId: null, status: "failed", failureCode: "message_too_large" });
      expect(fixtureDnsLookups).toEqual([]);
      expect(downloads).toEqual([]);
      for (const user of Object.values(fixture.users)) expect(await listed(user.id)).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
});
