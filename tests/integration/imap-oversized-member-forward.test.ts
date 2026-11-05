import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { imapIngestionMessages } from "@/db/schema";
import { discardImapReviewItem, listImapInbox } from "@/server/mail-in/imap-inbox";
import { reconcileImapRecipientAliases, runImapIngestionCycle, setImapClientFactoryForTests } from "@/server/mail-in/imap-ingestion";
import { IMAP_ATTACHMENT_LIMITS } from "@/server/mail-in/core/imap-attachment-validation";
import { testImapConfig } from "../support/imap-config";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { attributedHeaders, fakeImapMailbox, verifiedSenderFor } from "./support/mail-in";
import { fixtureDnsLookups } from "./support/dkim-fixture";

/*
 * A-F3 (#1722): an oversized message from an address no member has verified
 * stays unattributed (message_too_large), needs no DNS lookup and is never
 * downloaded. The member case lives in mail-in-dkim-self-verification.test.ts
 * (sender_too_large, note 53119); the two A-F3 lines it does not reach, the
 * discard keeping the code and the delete retry, are pinned at the end here.
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

/*
 * A-F3 (#1722): a member's sender_too_large row is handled like sender_unsigned
 * after it is filed. Removing it keeps its failure code (imap-inbox.ts
 * discardImapReviewItem), and its message stays on the expunge retry list
 * (imap-ingestion.ts awaitingExpunge), so a delete the provider refused is
 * tried again on the next cycle rather than leaving the raw message behind.
 */
describe("a member's sender_too_large row after it is filed (A-F3, #1722)", () => {
  /** A mailbox holding one oversized message; the first `refusals` deletes throw. */
  function oversizedMemberMailbox(uidValidity: number, headers: Buffer, deleted: string[], refusals: number) {
    let refused = 0;
    const { client } = fakeImapMailbox({
      uidValidity,
      messages: [{ uid: 1, headers, size: IMAP_ATTACHMENT_LIMITS.rawMessageBytes + 1 }],
    });
    Object.assign(client, {
      async messageDelete(range: string) {
        if (refused < refusals) { refused += 1; throw new Error("provider refused the delete"); }
        deleted.push(range);
        return true;
      },
    });
    setImapClientFactoryForTests(() => client);
  }

  async function memberRow(uidValidity: number) {
    const [row] = await getDb().select().from(imapIngestionMessages).where(eq(imapIngestionMessages.mailboxUidValidity, String(uidValidity)));
    return row;
  }

  it("keeps its failure code when the member removes it", async () => {
    const fixture = await createIntegrationFixture("oversized-member-discard");
    try {
      const member = fixture.users.member.id;
      const address = await verifiedSenderFor(member);
      await reconcileImapRecipientAliases(config());
      const deleted: string[] = [];
      oversizedMemberMailbox(203, attributedHeaders(address), deleted, 0);
      await runImapIngestionCycle(config());
      const row = await memberRow(203);
      expect(row).toMatchObject({ userId: member, status: "failed", failureCode: "sender_too_large" });

      await discardImapReviewItem(member, row!.id);

      expect(await memberRow(203)).toMatchObject({ userId: member, status: "discarded", failureCode: "sender_too_large" });
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("is deleted from the mailbox on the next cycle when the provider refused the first delete", async () => {
    const fixture = await createIntegrationFixture("oversized-member-expunge");
    try {
      const member = fixture.users.member.id;
      const address = await verifiedSenderFor(member);
      await reconcileImapRecipientAliases(config());
      const deleted: string[] = [];
      oversizedMemberMailbox(204, attributedHeaders(address), deleted, 1);
      await runImapIngestionCycle(config());
      expect(deleted, "the first delete did not land").toEqual([]);
      expect(await memberRow(204)).toMatchObject({ userId: member, status: "failed", failureCode: "sender_too_large" });

      oversizedMemberMailbox(204, attributedHeaders(address), deleted, 0);
      await runImapIngestionCycle(config());

      expect(deleted, "the raw message does not stay in the mailbox").toEqual(["1"]);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
});
