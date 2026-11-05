import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { imapIngestionMessages } from "@/db/schema";
import { imapRecipientAlias, runImapIngestionCycle, setImapClientFactoryForTests } from "@/server/mail-in/imap-ingestion";
import { testImapConfig } from "../support/imap-config";
import { syntheticPdf } from "../support/synthetic-documents";
import { sampleMessage } from "../support/dkim-signing";
import { cleanupIntegrationEnvironment, createIntegrationFixture, withRequiredScanMode, type IntegrationFixture } from "./support/fixtures";
import { attributedHeaders, fakeImapMailbox, verifiedSenderFor } from "./support/mail-in";
import { signedSource } from "./support/dkim-fixture";

/*
 * #1727 audit finding A-F1 (spec: note 53652). A forward that was already
 * accepted (a receipt with a member, still `processing`) is not authenticated
 * again when a poll re-fetches it: no key lookup, and neither the
 * DKIM-temporary-failure outcome nor the unsigned outcome applies. It is
 * claimed and processed as a retry is today when DKIM succeeds, so it ends
 * in `pending_review` for the member rather than staying `processing`.
 *
 * The DNS stub publishes the fixture key for every domain (as the other
 * attributed suites do) but can be told to fail, and counts every lookup.
 */
const dns = vi.hoisted(() => ({ lookups: [] as string[], failure: undefined as string | undefined }));
vi.mock("node:dns/promises", async () => {
  const inner = (await import("./support/dkim-fixture")).fixtureDnsModule();
  const resolveTxt = async (name: string) => {
    dns.lookups.push(name);
    if (dns.failure) throw Object.assign(new Error("dns failure"), { code: dns.failure });
    return inner.resolveTxt(name);
  };
  class Resolver { resolveTxt = resolveTxt; setServers() {} cancel() {} }
  return { resolveTxt, Resolver, default: { resolveTxt, Resolver } };
});

// The mailbox path only runs with the scanner required; the verdict is not
// what these tests are about, so it answers clean.
vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(async () => ({ status: "clean" as const })),
}));

const UID = 4100;
let fixture: IntegrationFixture;

beforeEach(async () => {
  fixture = await createIntegrationFixture("mail-in-accepted-forward-retry");
  dns.lookups.length = 0;
  dns.failure = undefined;
});

afterEach(async () => {
  setImapClientFactoryForTests(undefined);
  await fixture.cleanup();
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

const config = () => testImapConfig({
  host: "imap.example.invalid",
  user: "orbit-test",
  password: "test-only-password",
  recipientDomain: "ingest.example.invalid",
  currentAliasSecret: "test-only-current-alias-secret-is-long-enough",
});

const pdfBodyStructure = () => ({
  part: "1", type: "application", subtype: "pdf", disposition: "attachment",
  dispositionParameters: { filename: "receipt.pdf" }, size: 64,
}) as never;

async function receipt() {
  const [row] = await getDb().select({
    userId: imapIngestionMessages.userId,
    status: imapIngestionMessages.status,
    failureCode: imapIngestionMessages.failureCode,
  }).from(imapIngestionMessages).where(and(eq(imapIngestionMessages.mailbox, config().mailbox), eq(imapIngestionMessages.mailboxUid, UID)));
  return row;
}

/** An accepted, attributed receipt that a retry has to finish: `processing`, due now. */
async function insertAcceptedProcessingReceipt() {
  await getDb().insert(imapIngestionMessages).values({
    mailbox: config().mailbox, mailboxUidValidity: "77", mailboxUid: UID,
    contentSha256: randomUUID().replaceAll("-", ""), recipientAliasSha256: "accepted-retry",
    userId: fixture.users.member.id, status: "processing", attributedBy: "sender",
    expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "processing",
    attachmentProcessingNextAttemptAt: new Date(0),
  });
}

async function poll(source: Buffer, sender: string) {
  const alias = imapRecipientAlias(fixture.users.member.id, config());
  const provider = fakeImapMailbox({
    uidValidity: 77,
    messages: [{ uid: UID, headers: attributedHeaders(sender, alias), bodyStructure: pdfBodyStructure(), source, size: 64 }],
    download: () => syntheticPdf("accepted forward retry"),
  });
  setImapClientFactoryForTests(() => provider.client as never);
  await withRequiredScanMode(() => runImapIngestionCycle(config()));
}

describe("an accepted forward is not authenticated again on retry (#1727 A-F1)", () => {
  it("control: with DNS answering, the retry ends in pending_review for the member", async () => {
    const sender = await verifiedSenderFor(fixture.users.member.id);
    await insertAcceptedProcessingReceipt();

    await poll(await signedSource(sender, "retry control"), sender);

    expect(await receipt()).toMatchObject({ userId: fixture.users.member.id, status: "pending_review", failureCode: null });
  }, 30_000);

  it("ends in pending_review when the re-fetch meets a DKIM temporary failure", async () => {
    const sender = await verifiedSenderFor(fixture.users.member.id);
    await insertAcceptedProcessingReceipt();
    dns.failure = "ESERVFAIL";

    await poll(await signedSource(sender, "retry tempfail"), sender);

    expect(await receipt()).toMatchObject({ userId: fixture.users.member.id, status: "pending_review", failureCode: null });
  }, 30_000);

  it("ends in pending_review when the re-fetched message's signature no longer verifies (unsigned)", async () => {
    const sender = await verifiedSenderFor(fixture.users.member.id);
    await insertAcceptedProcessingReceipt();

    await poll(Buffer.from(sampleMessage({ from: sender })), sender);

    expect(await receipt()).toMatchObject({ userId: fixture.users.member.id, status: "pending_review", failureCode: null });
  }, 30_000);

  it("makes no DKIM lookup for that retry", async () => {
    const sender = await verifiedSenderFor(fixture.users.member.id);
    await insertAcceptedProcessingReceipt();
    dns.failure = "ESERVFAIL";

    await poll(await signedSource(sender, "retry no lookup"), sender);

    expect(dns.lookups).toEqual([]);
  }, 30_000);

  it("still holds a fresh message whose key lookup fails temporarily", async () => {
    const sender = await verifiedSenderFor(fixture.users.member.id);
    dns.failure = "ESERVFAIL";

    await poll(await signedSource(sender, "fresh tempfail"), sender);

    expect(await receipt()).toMatchObject({ userId: null, status: "held", failureCode: "sender_dkim_unavailable" });
    expect(dns.lookups.length).toBeGreaterThan(0);
  }, 30_000);
});
