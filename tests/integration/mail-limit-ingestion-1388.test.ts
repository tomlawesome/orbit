import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { imapIngestionMessages } from "@/db/schema";
import { reconcileImapRecipientAliases, runImapIngestionCycle, setImapClientFactoryForTests } from "@/server/mail-in/imap-ingestion";
import { testImapConfig } from "../support/imap-config";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";
import { attributedHeaders, fakeImapMailbox, verifiedSenderFor } from "./support/mail-in";
import { fixtureDnsLookups, signedSource } from "./support/dkim-fixture";

/*
 * #1388, design note 54592: the mail limit decides what a collected message
 * may weigh, apart from the upload limit. A message over it is refused
 * (`message_too_large` for a stranger, `sender_too_large` filed for a member);
 * one under it is collected. It is read once per ingestion cycle, so a change
 * applies from the next cycle with no restart; the upload limit no longer
 * touches mail.
 */
vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(async () => ({ status: "clean" as const })),
}));
vi.mock("node:dns/promises", async () => (await import("./support/dkim-fixture")).fixtureDnsModule());

const MIB = 1_048_576;

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

let nextValidity = 138_800;
const freshValidity = () => (nextValidity += 1);

async function rowFor(uidValidity: number) {
  const [row] = await getDb().select().from(imapIngestionMessages).where(eq(imapIngestionMessages.mailboxUidValidity, String(uidValidity)));
  return row;
}

/** One message the server reports as `size` bytes, from `from`; a real small signed source stands behind it. */
async function collect(from: string, size: number) {
  const uidValidity = freshValidity();
  const downloads: string[] = [];
  const headers = attributedHeaders(from);
  const source = await signedSource(from, "mail-limit-1388\r\n");
  setImapClientFactoryForTests(() => fakeImapMailbox({
    uidValidity, search: "all", deleted: [], downloads,
    messages: [{ uid: 1, headers, source, size }],
    download: () => { throw new Error("no attachment is expected"); },
  }).client);
  await runImapIngestionCycle(config());
  const row = await rowFor(uidValidity);
  return { row, failureCode: row?.failureCode ?? null };
}

const TOO_LARGE = ["message_too_large", "sender_too_large"];

/** Sets the mail limit through the module the route uses, as the administrator. */
async function setMail(fixture: IntegrationFixture, bytes: number | null) {
  const { readMailLimitSettings, setMailLimit } = await import("@/server/mail-limit");
  const admin = fixture.users.admin.id;
  const current = await readMailLimitSettings(admin);
  await setMailLimit(admin, current.version, bytes);
}

async function setUpload(fixture: IntegrationFixture, bytes: number | null) {
  const { readUploadLimitSettings, setUploadLimit } = await import("@/server/upload-limit");
  const admin = fixture.users.admin.id;
  const current = await readUploadLimitSettings(admin);
  await setUploadLimit(admin, current.version, bytes);
}

describe("mail size limit in ingestion (#1388)", () => {
  it("at a 10 MiB limit refuses a message of limit+1 and collects one of limit-1", async () => {
    const fixture = await createIntegrationFixture("mail-limit-boundary");
    try {
      await setMail(fixture, 10 * MIB);
      const stranger = await collect("stranger@example.invalid", 10 * MIB + 1);
      expect(stranger.row).toMatchObject({ userId: null, status: "failed", failureCode: "message_too_large" });

      const member = fixture.users.member.id;
      const address = await verifiedSenderFor(member);
      await reconcileImapRecipientAliases(config());
      const over = await collect(address, 10 * MIB + 1);
      expect(over.row).toMatchObject({ userId: member, status: "failed", failureCode: "sender_too_large" });
      const under = await collect(address, 10 * MIB - 1);
      expect(under.row, "the message under the limit was collected").toBeDefined();
      expect(TOO_LARGE).not.toContain(under.failureCode);
      expect(under.row).toMatchObject({ userId: member });
    } finally {
      await setMail(fixture, null);
      await fixture.cleanup();
    }
  }, 60_000);

  it("collects a message between 25 and 50 MiB once the limit is raised, and refuses it at the default", async () => {
    const fixture = await createIntegrationFixture("mail-limit-raised");
    try {
      const member = fixture.users.member.id;
      const address = await verifiedSenderFor(member);
      await reconcileImapRecipientAliases(config());
      const size = 30 * MIB;
      expect((await collect(address, size)).failureCode).toBe("sender_too_large");
      await setMail(fixture, 40 * MIB);
      const raised = await collect(address, size);
      expect(TOO_LARGE).not.toContain(raised.failureCode);
      expect(raised.row).toMatchObject({ userId: member });
    } finally {
      await setMail(fixture, null);
      await fixture.cleanup();
    }
  }, 60_000);

  it("no longer refuses mail because the upload limit sits below the mail limit", async () => {
    const fixture = await createIntegrationFixture("mail-limit-upload-lower");
    try {
      await setMail(fixture, 10 * MIB);
      await setUpload(fixture, 1 * MIB);
      const member = fixture.users.member.id;
      const address = await verifiedSenderFor(member);
      await reconcileImapRecipientAliases(config());
      const result = await collect(address, 5 * MIB);
      expect(TOO_LARGE).not.toContain(result.failureCode);
      expect(result.row).toMatchObject({ userId: member });
      // And a stranger's 5 MiB message is not "too large" either.
      const stranger = await collect("stranger@example.invalid", 5 * MIB);
      expect(stranger.failureCode).not.toBe("message_too_large");
    } finally {
      await setUpload(fixture, null);
      await setMail(fixture, null);
      await fixture.cleanup();
    }
  }, 60_000);

  it("applies a change from the next cycle, in the same process, without a restart", async () => {
    const fixture = await createIntegrationFixture("mail-limit-next-cycle");
    try {
      await setMail(fixture, 2 * MIB);
      expect((await collect("stranger@example.invalid", 3 * MIB)).failureCode).toBe("message_too_large");

      await setMail(fixture, 4 * MIB);
      expect((await collect("stranger@example.invalid", 3 * MIB)).failureCode).not.toBe("message_too_large");

      await setMail(fixture, 1 * MIB);
      expect((await collect("stranger@example.invalid", 3 * MIB)).failureCode).toBe("message_too_large");
    } finally {
      await setMail(fixture, null);
      await fixture.cleanup();
    }
  }, 60_000);

  it("reads the limit once per cycle, not once per message", async () => {
    const fixture = await createIntegrationFixture("mail-limit-once-per-cycle");
    try {
      const mailLimit = await import("@/server/mail-limit");
      const spy = vi.spyOn(mailLimit, "readEffectiveMailLimit");
      const uidValidity = freshValidity();
      setImapClientFactoryForTests(() => fakeImapMailbox({
        uidValidity, search: "all", deleted: [],
        messages: [1, 2, 3].map((uid) => ({ uid, headers: attributedHeaders(`stranger${uid}@example.invalid`), size: 100 * MIB })),
        download: () => { throw new Error("must not download"); },
      }).client);
      await runImapIngestionCycle(config());
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);
});
