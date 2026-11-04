import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { imapIngestionMessages } from "@/db/schema";
import { discardImapReviewItem, listImapInbox } from "@/server/mail-in/imap-inbox";
import { imapRecipientAlias, runImapIngestionCycle, setImapClientFactoryForTests } from "@/server/mail-in/imap-ingestion";
import { testImapConfig } from "../support/imap-config";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { attributedHeaders, fixtureHeaders, TRUSTED_AUTHSERV_ID, verifiedSenderFor, fakeImapMailbox } from "./support/mail-in";

/*
 * #1652: a forward attributed to a member that had nothing to collect is told
 * to that member in the review list, once, with its reason, and can be
 * dismissed. Unattributed and unauthenticated mail stays silent (ADR-0017).
 *
 * The wording is the test author's pick, in the shape "<label> · <message>":
 * the row's label comes from the reason (`nothing to collect`, `too large to
 * collect`, `couldn’t be kept`) and the receipt's `message` is the clause after
 * the dot.
 */
vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(async () => ({ status: "clean" as const })),
}));

afterAll(async () => {
  setImapClientFactoryForTests(undefined);
  await cleanupIntegrationEnvironment();
});

function config() {
  return {
    ...testImapConfig({
      host: "imap.example.invalid", user: "orbit-test", password: "test-only-password",
      recipientDomain: "ingest.example.invalid", currentAliasSecret: "test-only-current-alias-secret-is-long-enough",
    }),
    trustedAuthservId: TRUSTED_AUTHSERV_ID,
  };
}

/** A mailbox holding one message with no attachment at all (a body-only forward). */
function mailboxWithBodyOnly(uid: number, headers: Buffer) {
  const message = { uid, headers, bodyStructure: { part: "1", type: "text", subtype: "plain", size: 12 }, source: Buffer.from("just words"), size: 10 };
  setImapClientFactoryForTests(() => fakeImapMailbox({
    uidValidity: 91,
    search: "all",
    deleted: [],
    messages: [message],
    download: () => { throw new Error("nothing should be downloaded"); },
  }).client);
}

type Listed = { id: string; message: string; reason: string; canDiscard: boolean; canApprove: boolean; status: string };
const listed = async (userId: string) => (await listImapInbox(userId)).receipts as unknown as Listed[];

describe("an attributed message with nothing to collect (#1652)", () => {
  it("lists a no-PDF forward once, with its reason, and lets the member dismiss it", async () => {
    const fixture = await createIntegrationFixture("terminal-no-pdf");
    try {
      const cfg = config();
      const sender = await verifiedSenderFor(fixture.users.member.id);
      const alias = imapRecipientAlias(fixture.users.member.id, cfg);
      mailboxWithBodyOnly(11, attributedHeaders(sender, alias));
      await runImapIngestionCycle(cfg);

      const [row] = await getDb().select().from(imapIngestionMessages).where(eq(imapIngestionMessages.userId, fixture.users.member.id));
      expect(row).toMatchObject({ failureCode: "no_supported_pdf" });

      const rows = await listed(fixture.users.member.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: row.id, reason: "no_document", message: "no PDF attached", canDiscard: true, canApprove: false });

      await discardImapReviewItem(fixture.users.member.id, row.id);
      expect(await listed(fixture.users.member.id)).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it.each([
    ["message_too_large", "failed" as const, "too_large", "message over the size limit"],
    ["attachment_processing_exhausted", "recoverable" as const, "not_kept", "attachment could not be processed"],
  ])("lists a %s outcome once with its own words and lets the member dismiss it", async (failureCode, status, reason, message) => {
    const fixture = await createIntegrationFixture(`terminal-${failureCode}`);
    try {
      const [row] = await getDb().insert(imapIngestionMessages).values({
        mailbox: "terminal", mailboxUidValidity: "92", mailboxUid: 21, contentSha256: randomUUID().replaceAll("-", ""),
        recipientAliasSha256: "terminal", userId: fixture.users.member.id, attributedBy: "sender", status, failureCode,
        receiptStatus: status === "failed" ? "cancelled" : "pending", expiresAt: new Date(Date.now() + 86_400_000),
      }).returning({ id: imapIngestionMessages.id });

      const rows = await listed(fixture.users.member.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: row.id, reason, message, canDiscard: true });

      await discardImapReviewItem(fixture.users.member.id, row.id);
      expect(await listed(fixture.users.member.id)).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("guard: unattributed and unauthenticated mail leaves no row for anyone (ADR-0017)", async () => {
    const fixture = await createIntegrationFixture("terminal-silent");
    try {
      const cfg = config();
      const sender = await verifiedSenderFor(fixture.users.member.id);
      mailboxWithBodyOnly(31, attributedHeaders("stranger@example.invalid"));
      await runImapIngestionCycle(cfg);
      mailboxWithBodyOnly(32, fixtureHeaders({ from: sender }));
      await runImapIngestionCycle(cfg);

      for (const user of Object.values(fixture.users)) expect(await listed(user.id)).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
});
