import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { documents, imapIngestionAttachments, imapIngestionMessages, metadataKeys } from "@/db/schema";
import { deriveDocumentKeyId, getDocumentConfig, resetDocumentConfigForTests } from "@/server/documents/config";
import { runKekRotationToCompletion, type RotationKeys } from "@/server/documents/rewrap-worker";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { log } from "@/lib/logger";
import { runDocumentMaintenanceCycle } from "@/server/document-worker";
import { claimScannerRecoveryJobs, processScannerRecoveryJob } from "@/server/document-maintenance/scan-recovery";
import { backfillDocumentContentIndexes } from "@/server/document-maintenance/content-index-backfill";
import { scanAndHoldImapAttachment } from "@/server/mail-in/imap-attachment-holding";
import { decryptPortableArchive } from "@/server/portable-archive";
import { createPortableArchive, readPortableArchive } from "@/server/portable-archive-repository";
import { approveReviewedIntake } from "@/server/reviewed-intake";
import { openMetadataReader, openMetadataWriter } from "@/server/metadata/fields";
import { resetMetadataKeyCacheForTests } from "@/server/metadata/keys";
import {
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
  damageEnvelope,
  withRequiredScanMode as withRequiredScanModeKeepingConfig,
} from "./support/fixtures";
import { archiveForm } from "./support/portable-archive-upload";
import { postForm, proofCookie } from "./support/portable-archive-routes";
import { callRouteForSession, loadRoute } from "./support/request-event";
import { seedStoredDocuments } from "./support/stored-documents";
import { syntheticPdf } from "../support/synthetic-documents";

/* #1771: `documents.content_sha256` moves under the household key.
   Specification: the issue, and build note 55084 (expand -> backfill ->
   contract). In this release:

   - a new document row carries `content_sha256_sealed` (the lowercase hex
     SHA-256 sealed under the household metadata key, column key
     `documents.content_sha256`, bound to the row id and the household) and
     `content_index`, and a NULL `content_sha256`;
   - the #1437 maintenance backfill seals every row that still has a plain hash,
     fills a missing `content_index`, and sets the plain column to NULL, in one
     UPDATE guarded on the plain value it read; batched, idempotent, never at
     boot, a household whose key will not open is skipped and retried;
   - upload retry, scan recovery and archive export read the sealed value and
     fall back to the plain column for a row the backfill has not reached; the
     archive file keeps `contentSha256` in plain;
   - a sealed hash moved to another row or household fails to open; a KEK
     rewrap leaves it readable; duplicate and retry detection work before and
     after the backfill.

   Written from that specification alone. The quarantine integrity check of
   `storage.ts` takes its expectation from its caller, so it is exercised
   through scan recovery, the one caller that reads it from the database. */

const { POST: uploadDocument } = await loadRoute("households/[householdId]/items/[itemId]/documents");
const stageRoute = () => loadRoute("households/[householdId]/documents");
const { POST: importRoute } = await loadRoute("portable-archives/import");
const passphrase = "correct-horse-battery-staple";

vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(),
}));

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

afterEach(() => {
  vi.mocked(scanFileWithClamAv).mockReset();
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
});

const withRequiredScanMode = <T>(work: () => Promise<T>) => withRequiredScanModeKeepingConfig(work, () => {
  vi.mocked(scanFileWithClamAv).mockReset();
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
});

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;
type Session = Awaited<ReturnType<Fixture["session"]>>;

const COLUMN = "documents.content_sha256" as const;
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const pdf = (label: string) => syntheticPdf(`sealed hash test ${label}`);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/* ---- requests ---- */

async function attach(fixture: Fixture, session: Session, body: Buffer, { documentId = randomUUID(), itemId = fixture.item.id, householdId = fixture.household.id } = {}) {
  const response = await callRouteForSession(uploadDocument, session, {
    url: `http://127.0.0.1:3000/api/households/${householdId}/items/${itemId}/documents`,
    method: "POST",
    headers: {
      "content-length": String(body.length),
      "content-type": "application/pdf",
      "x-orbit-filename": encodeURIComponent("Service history.pdf"),
      "x-orbit-document-id": documentId,
    },
    body: new Uint8Array(body),
    params: { householdId, itemId },
  });
  return { response, documentId };
}

async function stage(fixture: Fixture, session: Session, body: Buffer, { documentId = randomUUID(), itemId = randomUUID(), householdId = fixture.household.id } = {}) {
  const { POST } = await stageRoute();
  const response = await callRouteForSession(POST, session, {
    url: `http://127.0.0.1:3000/api/households/${householdId}/documents`,
    method: "POST",
    headers: {
      "content-length": String(body.length),
      "content-type": "application/pdf",
      "x-orbit-filename": encodeURIComponent("Service history.pdf"),
      "x-orbit-document-id": documentId,
      "x-orbit-item-id": itemId,
    },
    body: new Uint8Array(body),
    params: { householdId },
  });
  return { response, documentId, itemId };
}

async function alreadyHeldOf(response: Response): Promise<{ documentId: string } | null | undefined> {
  const { document } = await response.clone().json() as { document: { alreadyHeld?: { documentId: string } | null } };
  return document.alreadyHeld;
}

/* ---- the hash columns, read with SQL so a missing column fails the test that needs it ---- */

type HashColumns = { plain: string | null; sealed: string | null; contentIndex: string | null; householdId: string };

async function columnsOf(documentId: string): Promise<HashColumns> {
  const rows = await getDb().execute<HashColumns>(sql`
    select content_sha256 as plain, content_sha256_sealed as sealed, content_index as "contentIndex", household_id as "householdId"
    from documents where id = ${documentId}`);
  const row = rows[0];
  expect(row, `document ${documentId} exists`).toBeDefined();
  return row!;
}

async function openSealed(householdId: string, rowId: string, sealed: string | null) {
  const cipher = await openMetadataReader(householdId);
  return cipher.text(COLUMN, rowId, { encrypted: sealed });
}

async function sealFor(householdId: string, rowId: string, hex: string): Promise<string> {
  return (await openMetadataWriter(householdId)).encryptText(COLUMN, rowId, hex)!;
}

async function expectSealedTo(documentId: string, hex: string) {
  const row = await columnsOf(documentId);
  expect(row.sealed, "a sealed hash is stored").not.toBeNull();
  expect(row.sealed).not.toContain(hex);
  expect(await openSealed(row.householdId, documentId, row.sealed)).toMatchObject({ value: hex });
  return row;
}

async function setColumns(documentId: string, plain: string | null, sealed: string | null) {
  await getDb().execute(sql`update documents set content_sha256 = ${plain}, content_sha256_sealed = ${sealed} where id = ${documentId}`);
}

/** Makes an uploaded row look as a row stored before this release does: a plain hash, no sealed one. */
const makeLegacy = (documentId: string, hex: string) => setColumns(documentId, hex, null);

async function plainHashCount(householdIds: string[]): Promise<number> {
  const rows = await getDb().execute(sql`select count(*)::int as n from documents where content_sha256 is not null and household_id in ${householdIds}`);
  return Number((rows[0] as { n: number }).n);
}

/** Runs the maintenance backfill until the given households have no plain hash left. */
async function drain(householdIds: string[]) {
  for (let guard = 0; guard < 200 && await plainHashCount(householdIds) > 0; guard += 1) await backfillDocumentContentIndexes();
  expect(await plainHashCount(householdIds), "no documents row of these households keeps a plain hash").toBe(0);
}
/** As `drain`, for the tests that need the whole table clear first so a bounded batch can only reach the rows they plant. */
async function drainAll() {
  const everyone = async () => Number(((await getDb().execute(sql`select count(*)::int as n from documents where content_sha256 is not null`))[0] as { n: number }).n);
  for (let guard = 0; guard < 200 && await everyone() > 0; guard += 1) await backfillDocumentContentIndexes();
  expect(await everyone(), "no documents row anywhere keeps a plain hash").toBe(0);
}
const drainFor = (fixture: Fixture) => drain([fixture.household.id, fixture.secondHousehold.id]);

async function plantLegacy(fixture: Fixture, which: "first" | "second", hex: string, contentIndex: string | null = null) {
  const id = randomUUID();
  await getDb().insert(documents).values({
    id,
    householdId: which === "first" ? fixture.household.id : fixture.secondHousehold.id,
    itemId: which === "first" ? fixture.item.id : fixture.secondItem.id,
    displayName: `planted-${id}.pdf`, mediaType: "application/pdf", sizeBytes: 10,
    contentSha256: hex, contentIndex, lifecycle: "available", scanStatus: "clean",
  });
  return id;
}

/* ---- new rows are written sealed ---- */

describe("every path that creates a document row seals the hash and leaves the plain column NULL (#1771)", () => {
  it("attach to an item: a sealed hash that opens to the file's SHA-256, a blind index, and no plain hash anywhere in the row or its audit trail", async () => {
    const fixture = await createIntegrationFixture("sealed-attach");
    const member = await fixture.session("member");
    const bytes = pdf("attach");
    const { response, documentId } = await attach(fixture, member, bytes);
    expect(response.status).toBe(201);

    const row = await expectSealedTo(documentId, sha256(bytes));
    expect(row.plain).toBeNull();
    expect(row.contentIndex).not.toBeNull();
    const whole = await getDb().execute(sql`select documents::text as t from documents where id = ${documentId}`);
    expect(String((whole[0] as { t: string }).t)).not.toContain(sha256(bytes));
    const audit = await getDb().execute(sql`select count(*)::int as n from audit_log where household_id = ${fixture.household.id} and changes::text like ${`%${sha256(bytes)}%`}`);
    expect(Number((audit[0] as { n: number }).n)).toBe(0);
  });

  it("the Add form's staged upload: the same", async () => {
    const fixture = await createIntegrationFixture("sealed-staged");
    const member = await fixture.session("member");
    const bytes = pdf("staged");
    const { response, documentId } = await stage(fixture, member, bytes);
    expect(response.status).toBe(201);
    const row = await expectSealedTo(documentId, sha256(bytes));
    expect(row.plain).toBeNull();
    expect(row.contentIndex).not.toBeNull();
  });

  it("the sealed value is the household's own: the same file in two households is sealed differently and opens only under its own key", async () => {
    const fixture = await createIntegrationFixture("sealed-households");
    const bytes = pdf("two households");
    const first = await attach(fixture, await fixture.session("member"), bytes);
    const second = await attach(fixture, await fixture.session("secondOwner"), bytes, {
      itemId: fixture.secondItem.id, householdId: fixture.secondHousehold.id,
    });
    expect(second.response.status).toBe(201);
    const a = await expectSealedTo(first.documentId, sha256(bytes));
    const b = await expectSealedTo(second.documentId, sha256(bytes));
    expect(a.sealed).not.toBe(b.sealed);
    expect(a.contentIndex).not.toBe(b.contentIndex);
    // Moved to the other household, with the row id kept, it does not open.
    const crossed = await openSealed(fixture.secondHousehold.id, first.documentId, a.sealed);
    expect(crossed.value).toBeNull();
    expect(crossed.state).toBeDefined();
  });

  it("a mail-in approval: the document the attachment becomes is sealed, with no plain hash", async () => {
    const fixture = await createIntegrationFixture("sealed-mail-in");
    const bytes = pdf("mail-in");
    const receiptId = randomUUID();
    const held = await scanAndHoldImapAttachment({
      bytes, filename: "held-policy.pdf", declaredMediaType: "application/pdf",
      recipientUserId: fixture.users.member.id, receiptId,
    });
    await getDb().insert(imapIngestionMessages).values({
      id: receiptId, mailbox: "private", mailboxUidValidity: `sealed-${receiptId.slice(0, 8)}`, mailboxUid: 1, contentSha256: randomUUID().replaceAll("-", ""),
      recipientAliasSha256: `sealed-${receiptId.slice(0, 8)}`, userId: fixture.users.member.id, householdId: fixture.household.id,
      status: "pending_review", expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending",
    });
    await getDb().insert(imapIngestionAttachments).values({
      id: held.id, messageId: receiptId, displayName: held.displayName, mediaType: held.mediaType, sizeBytes: held.sizeBytes,
      contentSha256: held.contentSha256, storageKey: held.storageKey, ciphertextSize: held.ciphertextSize, ...held.envelope, status: "stored",
    });
    const result = await approveReviewedIntake(fixture.users.member.id, {
      operationId: randomUUID(),
      source: { kind: "mailbox_draft" as const, receiptId, draftVersion: 1 },
      householdId: fixture.household.id,
      sectionId: fixture.section.id,
      action: "create_separate" as const,
      item: { title: "Sealed hash mail-in", currency: "GBP", status: "active" },
      attachmentIds: [held.id],
    });
    expect(result.outcome).toBe("approved");
    const [attachment] = await getDb().select({ documentId: imapIngestionAttachments.assignedDocumentId })
      .from(imapIngestionAttachments).where(eq(imapIngestionAttachments.id, held.id));
    const row = await expectSealedTo(attachment!.documentId!, sha256(bytes));
    expect(row.plain).toBeNull();
    expect(row.contentIndex).not.toBeNull();
  }, 60_000);

  it("an archive import: every restored document is sealed, with no plain hash", async () => {
    const source = await createIntegrationFixture("sealed-import-source");
    const target = await createIntegrationFixture("sealed-import-target");
    const bytes = pdf("archive import");
    await seedStoredDocuments(source, [bytes]);
    const archive = await createPortableArchive({ userId: source.users.owner.id, householdId: source.household.id, passphrase, includeDocuments: true });
    const file = Buffer.from((await readPortableArchive(source.users.owner.id, archive.id)).bytes);

    const targetOwner = await target.session("owner");
    const imported = await postForm(
      importRoute, "/api/portable-archives/import", targetOwner,
      archiveForm({ householdId: target.household.id, passphrase, conflictItemIds: [] }, file),
      await proofCookie(targetOwner, "archive_import"),
    );
    expect(imported.status).toBe(200);

    const restored = await getDb().execute(sql`
      select id from documents where household_id = ${target.household.id} and size_bytes = ${bytes.length} and item_id is not null`);
    expect(restored.length, "the import restored the document").toBeGreaterThan(0);
    for (const { id } of restored as unknown as Array<{ id: string }>) {
      const row = await expectSealedTo(id, sha256(bytes));
      expect(row.plain).toBeNull();
      expect(row.contentIndex).not.toBeNull();
    }
  }, 300_000);

  it("a scan recovery's rewrite: the staged row is sealed before the scan, and the recovered document is still sealed, plain NULL, and available", async () => {
    const fixture = await createIntegrationFixture("sealed-scan-recovery");
    const member = await fixture.session("member");
    const bytes = pdf("scan recovery");
    const documentId = randomUUID();
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "error", reason: "protocol" });
    await withRequiredScanMode(async () => {
      const first = await attach(fixture, member, bytes, { documentId });
      expect(first.response.status).toBe(202);
      const staged = await expectSealedTo(documentId, sha256(bytes));
      expect(staged.plain).toBeNull();

      await getDb().execute(sql`update document_jobs set next_attempt_at = now() - interval '1 second' where document_id = ${documentId} and kind = 'scan'`);
      vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
      await runDocumentMaintenanceCycle();
      const [done] = await getDb().select({ lifecycle: documents.lifecycle }).from(documents).where(eq(documents.id, documentId));
      expect(done?.lifecycle).toBe("available");
      const recovered = await expectSealedTo(documentId, sha256(bytes));
      expect(recovered.plain).toBeNull();
      expect(recovered.contentIndex).not.toBeNull();
      expect(recovered.contentIndex, "recovery leaves the index it had").toBe(staged.contentIndex);
    });
  });
});

describe("an upload while the household key will not open still succeeds (#1771, owner ruling)", () => {
  it("stores the plain hash with no seal and no index, then the backfill seals it and clears the plain column once the key opens", async () => {
    const fixture = await createIntegrationFixture("sealed-upload-key-locked");
    await drainAll();
    const member = await fixture.session("member");
    const bytes = pdf("key locked upload");
    const [key] = await getDb().select({ wrapAuthTag: metadataKeys.wrapAuthTag }).from(metadataKeys)
      .where(and(eq(metadataKeys.scope, "household"), eq(metadataKeys.householdId, fixture.household.id)));
    expect(key, "the fixture minted the household's key").toBeTruthy();
    let documentId: string;
    try {
      await getDb().execute(sql`update metadata_keys set wrap_auth_tag = ${randomBytes(16).toString("base64")} where scope = 'household' and household_id = ${fixture.household.id}`);
      resetMetadataKeyCacheForTests();
      const uploaded = await attach(fixture, member, bytes);
      documentId = uploaded.documentId;
      expect(uploaded.response.status, "uploads that work today keep working").toBe(201);
      const row = await columnsOf(documentId);
      expect(row.plain).toBe(sha256(bytes));
      expect(row.sealed).toBeNull();
      expect(row.contentIndex).toBeNull();
    } finally {
      await getDb().update(metadataKeys).set({ wrapAuthTag: key.wrapAuthTag })
        .where(and(eq(metadataKeys.scope, "household"), eq(metadataKeys.householdId, fixture.household.id)));
      resetMetadataKeyCacheForTests();
    }
    for (let guard = 0; guard < 200 && (await columnsOf(documentId)).plain !== null; guard += 1) await runDocumentMaintenanceCycle();
    const sealed = await expectSealedTo(documentId, sha256(bytes));
    expect(sealed.plain).toBeNull();
    expect(sealed.contentIndex).not.toBeNull();
  });
});

describe("the backfill seals only a real hash and survives rows it cannot use (#1771 review)", () => {
  it.each([
    ["an empty value", ""],
    ["a short value", "abc123"],
    ["upper-case hex", "A".repeat(64)],
  ])("leaves %s as it was, and no other row in the batch is blocked", async (_name, odd) => {
    const fixture = await createIntegrationFixture("sealed-backfill-odd-value");
    await drainAll();
    const oddRow = await plantLegacy(fixture, "first", odd);
    const valid = [] as string[];
    for (let n = 0; n < 3; n += 1) valid.push(await plantLegacy(fixture, "first", sha256(`odd neighbour ${n}`)));
    try {
      for (let call = 0; call < 10; call += 1) await backfillDocumentContentIndexes(1);
      const row = await columnsOf(oddRow);
      expect(row.plain, "the plain column is unchanged").toBe(odd);
      expect(row.sealed, "nothing is sealed for it").toBeNull();
      for (const [position, id] of valid.entries()) {
        await expectSealedTo(id, sha256(`odd neighbour ${position}`));
        expect((await columnsOf(id)).plain).toBeNull();
      }
    } finally {
      await getDb().execute(sql`delete from documents where id = ${oddRow}`);
    }
  });

  it("damaged seals with a missing index do not stall the backfill, even past one batch, are reported once each, and valid rows behind them are sealed", async () => {
    const fixture = await createIntegrationFixture("sealed-backfill-damaged");
    await drainAll();
    const damaged: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      const id = randomUUID();
      const good = await sealFor(fixture.household.id, id, sha256(`damaged ${n}`));
      await getDb().execute(sql`
        insert into documents (id, household_id, item_id, display_name, media_type, size_bytes, content_sha256, content_sha256_sealed, content_index, lifecycle, scan_status)
        values (${id}, ${fixture.household.id}, ${fixture.item.id}, 'damaged.pdf', 'application/pdf', 10, null, ${damageEnvelope(good)}, null, 'available', 'clean')`);
      damaged.push(id);
    }
    const valid = [] as string[];
    for (let n = 0; n < 3; n += 1) valid.push(await plantLegacy(fixture, "first", sha256(`behind damaged ${n}`)));
    const warn = vi.spyOn(log, "warn");
    try {
      for (let call = 0; call < 10 && (await plainHashCount([fixture.household.id])) > 0; call += 1) await backfillDocumentContentIndexes(2);
      for (const [position, id] of valid.entries()) {
        await expectSealedTo(id, sha256(`behind damaged ${position}`));
        expect((await columnsOf(id)).plain).toBeNull();
      }
      for (const id of damaged) expect((await columnsOf(id)).sealed, "a damaged seal is left as it is").not.toBeNull();
      // Every damaged row has been reached by now; two more cycles must not report them again.
      await backfillDocumentContentIndexes();
      const reported = warn.mock.calls.length;
      expect(reported, "the damage is reported").toBeGreaterThan(0);
      await backfillDocumentContentIndexes();
      await backfillDocumentContentIndexes();
      expect(warn.mock.calls.length, "and not again on later cycles").toBe(reported);
    } finally {
      warn.mockRestore();
      await getDb().execute(sql`delete from documents where id in ${damaged}`);
    }
  });
});

/* ---- a sealed hash is bound to its row ---- */

describe("a sealed hash fails to open anywhere but where it was written (#1771)", () => {
  it("moved to another document row of the same household", async () => {
    const fixture = await createIntegrationFixture("sealed-moved-row");
    const member = await fixture.session("member");
    const a = await attach(fixture, member, pdf("moved a"));
    const b = await attach(fixture, member, pdf("moved b"));
    const row = await columnsOf(a.documentId);
    const moved = await openSealed(fixture.household.id, b.documentId, row.sealed);
    expect(moved.value).toBeNull();
    expect(moved.state).toBe("metadata_integrity_failed");
  });

  it("moved to another household", async () => {
    const fixture = await createIntegrationFixture("sealed-moved-household");
    const member = await fixture.session("member");
    const a = await attach(fixture, member, pdf("moved household"));
    await openMetadataWriter(fixture.secondHousehold.id); // the other household has a key to try
    const row = await columnsOf(a.documentId);
    const moved = await openSealed(fixture.secondHousehold.id, a.documentId, row.sealed);
    expect(moved.value).toBeNull();
    expect(moved.state).toBe("metadata_integrity_failed");
  });

  it("a damaged value does not open", async () => {
    const fixture = await createIntegrationFixture("sealed-damaged");
    const member = await fixture.session("member");
    const a = await attach(fixture, member, pdf("damaged"));
    const row = await columnsOf(a.documentId);
    const damaged = await openSealed(fixture.household.id, a.documentId, damageEnvelope(row.sealed!));
    expect(damaged.value).toBeNull();
    expect(damaged.state).toBe("metadata_integrity_failed");
  });
});

/* ---- the backfill ---- */

describe("the maintenance backfill seals rows that still have a plain hash (#1771)", () => {
  it("seals the hash, fills a missing blind index to the value an upload of the same file gets, and clears the plain column", async () => {
    const fixture = await createIntegrationFixture("sealed-backfill-value");
    await drainFor(fixture);
    const member = await fixture.session("member");
    const bytes = pdf("backfill value");
    const uploaded = await attach(fixture, member, bytes);
    const expectedIndex = (await columnsOf(uploaded.documentId)).contentIndex;
    expect(expectedIndex).not.toBeNull();
    const legacy = await plantLegacy(fixture, "first", sha256(bytes));

    await drainFor(fixture);
    const row = await expectSealedTo(legacy, sha256(bytes));
    expect(row.plain).toBeNull();
    expect(row.contentIndex).toBe(expectedIndex);
  });

  it("leaves a blind index that is already there untouched, and still seals and clears", async () => {
    const fixture = await createIntegrationFixture("sealed-backfill-index-kept");
    await drainFor(fixture);
    const hex = sha256("index kept");
    const legacy = await plantLegacy(fixture, "first", hex, "already-set-by-an-earlier-backfill");
    await drainFor(fixture);
    const row = await expectSealedTo(legacy, hex);
    expect(row.plain).toBeNull();
    expect(row.contentIndex).toBe("already-set-by-an-earlier-backfill");
  });

  it("is idempotent: a second pass changes nothing, and a row already sealed is not sealed again", async () => {
    const fixture = await createIntegrationFixture("sealed-backfill-idempotent");
    await drainFor(fixture);
    const hex = sha256("idempotent");
    const legacy = await plantLegacy(fixture, "first", hex);
    await drainFor(fixture);
    const first = await columnsOf(legacy);
    const bytes = pdf("idempotent upload");
    const uploaded = await attach(fixture, await fixture.session("member"), bytes);
    const newRow = await columnsOf(uploaded.documentId);

    await backfillDocumentContentIndexes();
    await backfillDocumentContentIndexes();
    expect(await columnsOf(legacy)).toEqual(first);
    expect(await columnsOf(uploaded.documentId)).toEqual(newRow);
  });

  it("works in bounded batches: a call seals at most the limit it was given, and the batches together reach every row", async () => {
    const fixture = await createIntegrationFixture("sealed-backfill-bounded");
    await drainAll();
    const planted: string[] = [];
    for (let n = 0; n < 5; n += 1) planted.push(await plantLegacy(fixture, n % 2 === 0 ? "first" : "second", sha256(`bounded ${n}`)));
    const sealedCount = async () => {
      const rows = await getDb().execute(sql`select count(*)::int as n from documents where id in ${planted} and content_sha256_sealed is not null`);
      return Number((rows[0] as { n: number }).n);
    };
    expect(await sealedCount()).toBe(0);
    await backfillDocumentContentIndexes(2);
    const afterOne = await sealedCount();
    expect(afterOne).toBeGreaterThan(0);
    expect(afterOne).toBeLessThanOrEqual(2);
    for (let guard = 0; guard < 10 && await sealedCount() < 5; guard += 1) await backfillDocumentContentIndexes(2);
    expect(await sealedCount()).toBe(5);
    for (const id of planted) expect((await columnsOf(id)).plain).toBeNull();
  });

  it("keys each row by its own household: equal hashes in two households seal and index differently", async () => {
    const fixture = await createIntegrationFixture("sealed-backfill-households");
    await drainFor(fixture);
    const hex = sha256("backfill households");
    const a = await plantLegacy(fixture, "first", hex);
    const b = await plantLegacy(fixture, "second", hex);
    await drainFor(fixture);
    const first = await expectSealedTo(a, hex);
    const second = await expectSealedTo(b, hex);
    expect(first.sealed).not.toBe(second.sealed);
    expect(first.contentIndex).not.toBe(second.contentIndex);
  });

  it("leaves no plain hash on any row of a household, the fixture's own placeholder document included", async () => {
    const fixture = await createIntegrationFixture("sealed-backfill-none-left");
    expect(await plainHashCount([fixture.household.id, fixture.secondHousehold.id]), "the fixture starts with old-style rows").toBeGreaterThan(0);
    const placeholderHash = (await columnsOf(fixture.document.id)).plain!;
    await drainFor(fixture);
    expect(await plainHashCount([fixture.household.id, fixture.secondHousehold.id])).toBe(0);
    await expectSealedTo(fixture.document.id, placeholderHash);
  });

  it("is part of the maintenance cycle, not of boot or of the migration", async () => {
    const fixture = await createIntegrationFixture("sealed-backfill-cycle");
    await drainAll();
    const hex = sha256("cycle");
    const legacy = await plantLegacy(fixture, "first", hex);
    // Nothing has run since the row was written, so it is exactly as an old row is.
    expect((await columnsOf(legacy)).sealed).toBeNull();
    for (let guard = 0; guard < 200 && (await columnsOf(legacy)).plain !== null; guard += 1) await runDocumentMaintenanceCycle();
    const row = await expectSealedTo(legacy, hex);
    expect(row.plain).toBeNull();
  });

  it("passes over a household whose key will not open, seals the others, never empties the skipped row, and seals it once the key opens", async () => {
    const fixture = await createIntegrationFixture("sealed-backfill-locked");
    await drainAll();
    const [lockedId, openId] = [fixture.household.id, fixture.secondHousehold.id].sort();
    const which = (id: string) => (id === fixture.household.id ? "first" : "second");
    const lockedHexes = [sha256("locked 1"), sha256("locked 2")];
    const lockedRows = [
      await plantLegacy(fixture, which(lockedId), lockedHexes[0]),
      await plantLegacy(fixture, which(lockedId), lockedHexes[1]),
    ];
    const openHex = sha256("open 1");
    const openRow = await plantLegacy(fixture, which(openId), openHex);
    const [key] = await getDb().select({ wrapAuthTag: metadataKeys.wrapAuthTag }).from(metadataKeys)
      .where(and(eq(metadataKeys.scope, "household"), eq(metadataKeys.householdId, lockedId)));
    expect(key, "the fixture minted the household's key").toBeTruthy();
    try {
      await getDb().execute(sql`update metadata_keys set wrap_auth_tag = ${randomBytes(16).toString("base64")} where scope = 'household' and household_id = ${lockedId}`);
      resetMetadataKeyCacheForTests();

      await backfillDocumentContentIndexes(); // does not throw
      await backfillDocumentContentIndexes();
      await expectSealedTo(openRow, openHex);
      expect((await columnsOf(openRow)).plain).toBeNull();
      for (const [position, id] of lockedRows.entries()) {
        const row = await columnsOf(id);
        expect(row.plain, "the skipped row is neither emptied nor failed").toBe(lockedHexes[position]);
        expect(row.sealed).toBeNull();
      }
    } finally {
      await getDb().update(metadataKeys).set({ wrapAuthTag: key.wrapAuthTag })
        .where(and(eq(metadataKeys.scope, "household"), eq(metadataKeys.householdId, lockedId)));
      resetMetadataKeyCacheForTests();
    }
    await drainFor(fixture);
    for (const [position, id] of lockedRows.entries()) {
      await expectSealedTo(id, lockedHexes[position]);
      expect((await columnsOf(id)).plain).toBeNull();
    }
  });

  it("writes only when the plain value is still the one it read: a hash changed under it is never replaced by a seal of the old one", async () => {
    const fixture = await createIntegrationFixture("sealed-backfill-guard");
    await drainAll();
    const oldHex = sha256("guard old");
    const newHex = sha256("guard new");
    const legacy = await plantLegacy(fixture, "first", oldHex);

    // Another writer holds the row, changes its hash, and lets go only once the backfill is waiting on it.
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = getDb().transaction(async (transaction) => {
      await transaction.execute(sql`select 1 from documents where id = ${legacy} for update`);
      locked();
      await gate;
      await transaction.execute(sql`update documents set content_sha256 = ${newHex} where id = ${legacy}`);
    });
    await lockTaken;
    const running = backfillDocumentContentIndexes();
    for (let waited = 0; waited < 5_000; waited += 50) {
      const rows = await getDb().execute(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
      if (Number((rows[0] as { n: number }).n) > 0) break;
      await sleep(50);
    }
    release();
    await holder;
    await running;

    const mid = await columnsOf(legacy);
    if (mid.sealed !== null) {
      expect((await openSealed(mid.householdId, legacy, mid.sealed)).value, "never a seal of the stale hash").toBe(newHex);
    } else {
      expect(mid.plain, "the changed hash is still there to be sealed").toBe(newHex);
    }
    await drainFor(fixture);
    const row = await expectSealedTo(legacy, newHex);
    expect(row.plain).toBeNull();
  });
});

/* ---- readers: upload retry ---- */

type RowState = "new" | "legacy" | "backfilled";
const STATES: RowState[] = ["new", "legacy", "backfilled"];

async function putInState(documentId: string, bytes: Buffer, state: RowState) {
  if (state === "new") {
    expect((await columnsOf(documentId)).plain, "a row written now has no plain hash").toBeNull();
    return;
  }
  await makeLegacy(documentId, sha256(bytes));
  if (state === "backfilled") await drain([(await columnsOf(documentId)).householdId]);
}

describe("an upload retry is still recognised, before and after the backfill (#1771)", () => {
  it.each(STATES)("the same id and bytes answer the stored document and store nothing new (%s row)", async (state) => {
    const fixture = await createIntegrationFixture(`sealed-retry-${state}`);
    const member = await fixture.session("member");
    const bytes = pdf(`retry ${state}`);
    const first = await attach(fixture, member, bytes);
    expect(first.response.status).toBe(201);
    await putInState(first.documentId, bytes, state);
    const before = await columnsOf(first.documentId);

    const retry = await attach(fixture, member, bytes, { documentId: first.documentId });
    expect([200, 201]).toContain(retry.response.status);
    expect((await retry.response.json() as { document: { id: string } }).document.id).toBe(first.documentId);
    const rows = await getDb().execute(sql`select count(*)::int as n from documents where id = ${first.documentId}`);
    expect(Number((rows[0] as { n: number }).n)).toBe(1);
    expect(await columnsOf(first.documentId)).toEqual(before);
  });

  it.each(STATES)("the same id with other bytes is refused as a conflict (%s row)", async (state) => {
    const fixture = await createIntegrationFixture(`sealed-retry-conflict-${state}`);
    const member = await fixture.session("member");
    const bytes = pdf(`conflict ${state}`);
    const first = await attach(fixture, member, bytes);
    await putInState(first.documentId, bytes, state);

    const other = await attach(fixture, member, Buffer.concat([bytes, Buffer.from("\n% changed")]), { documentId: first.documentId });
    expect(other.response.status).toBe(409);
    expect((await other.response.json() as { error: { code: string } }).error.code).toBe("document_conflict");
  });

  it("a stored hash that cannot be opened is never taken as a match: a damaged value, or one moved from another row, fails the retry", async () => {
    const fixture = await createIntegrationFixture("sealed-retry-unopenable");
    const member = await fixture.session("member");
    const bytes = pdf("retry unopenable");
    const damagedRow = await attach(fixture, member, bytes);
    const movedRow = await attach(fixture, member, bytes); // the same file twice is allowed; each has its own sealed value
    const donor = await columnsOf(damagedRow.documentId);
    await setColumns(damagedRow.documentId, null, damageEnvelope(donor.sealed!));
    await setColumns(movedRow.documentId, null, donor.sealed); // sealed for the other row's id

    for (const documentId of [damagedRow.documentId, movedRow.documentId]) {
      const retry = await attach(fixture, member, bytes, { documentId });
      expect(retry.response.status, "the retry is not accepted on a hash it cannot verify").toBeGreaterThanOrEqual(400);
    }
  });
});

/* ---- readers: duplicate detection ---- */

describe("a duplicate upload is still detected, before and after the backfill (#1771)", () => {
  it.each(STATES)("names the earlier copy (%s row)", async (state) => {
    const fixture = await createIntegrationFixture(`sealed-duplicate-${state}`);
    const member = await fixture.session("member");
    const bytes = pdf(`duplicate ${state}`);
    const first = await attach(fixture, member, bytes);
    await putInState(first.documentId, bytes, state);

    const second = await stage(fixture, member, bytes);
    expect(second.response.status).toBe(201);
    expect(await alreadyHeldOf(second.response)).toMatchObject({ documentId: first.documentId });
  });

  it("an old row with no blind index yet is matched once the backfill has reached it, not before", async () => {
    const fixture = await createIntegrationFixture("sealed-duplicate-no-index");
    await drainFor(fixture);
    const member = await fixture.session("member");
    const bytes = pdf("duplicate no index");
    const first = await attach(fixture, member, bytes);
    await getDb().execute(sql`update documents set content_sha256 = ${sha256(bytes)}, content_sha256_sealed = null, content_index = null where id = ${first.documentId}`);

    const before = await stage(fixture, member, bytes);
    expect(await alreadyHeldOf(before.response)).toBeNull();
    await drainFor(fixture);
    const after = await stage(fixture, member, bytes);
    expect(await alreadyHeldOf(after.response)).toMatchObject({ documentId: first.documentId });
  });
});

/* ---- readers: scan recovery (and the quarantine integrity check it feeds) ---- */

describe("scan recovery checks the recovered bytes against the stored hash, sealed or plain (#1771)", () => {
  async function outageStaged(fixture: Fixture, bytes: Buffer): Promise<string> {
    const documentId = randomUUID();
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "error", reason: "protocol" });
    const { response } = await attach(fixture, await fixture.session("member"), bytes, { documentId });
    expect(response.status).toBe(202);
    await getDb().execute(sql`update document_jobs set next_attempt_at = now() - interval '1 second' where document_id = ${documentId} and kind = 'scan'`);
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
    return documentId;
  }

  async function recover(documentId: string) {
    const jobs = (await claimScannerRecoveryJobs()).filter((job) => job.documentId === documentId);
    expect(jobs, "the recovery job was claimed").toHaveLength(1);
    await processScannerRecoveryJob(jobs[0]!);
    const [row] = await getDb().select({ lifecycle: documents.lifecycle, failureCode: documents.failureCode }).from(documents).where(eq(documents.id, documentId));
    return row!;
  }

  it("recovers a row that has only a sealed hash", async () => {
    const fixture = await createIntegrationFixture("sealed-recovery-new");
    await withRequiredScanMode(async () => {
      const documentId = await outageStaged(fixture, pdf("recovery new"));
      expect((await columnsOf(documentId)).plain).toBeNull();
      expect((await recover(documentId)).lifecycle).toBe("available");
    });
  });

  it("recovers a row the backfill has not reached, from its plain hash", async () => {
    const fixture = await createIntegrationFixture("sealed-recovery-legacy");
    await withRequiredScanMode(async () => {
      const bytes = pdf("recovery legacy");
      const documentId = await outageStaged(fixture, bytes);
      await makeLegacy(documentId, sha256(bytes));
      expect((await recover(documentId)).lifecycle).toBe("available");
    });
  });

  it("rejects the staged bytes when the sealed hash is of other bytes", async () => {
    const fixture = await createIntegrationFixture("sealed-recovery-mismatch");
    await withRequiredScanMode(async () => {
      const documentId = await outageStaged(fixture, pdf("recovery mismatch"));
      await setColumns(documentId, null, await sealFor(fixture.household.id, documentId, sha256("some other file")));
      expect(await recover(documentId)).toEqual({ lifecycle: "rejected", failureCode: "staging_object_invalid" });
    });
  });

  it("rejects the staged bytes when the plain hash of a not-yet-backfilled row is of other bytes", async () => {
    const fixture = await createIntegrationFixture("sealed-recovery-mismatch-legacy");
    await withRequiredScanMode(async () => {
      const documentId = await outageStaged(fixture, pdf("recovery mismatch legacy"));
      await makeLegacy(documentId, sha256("some other file"));
      expect(await recover(documentId)).toEqual({ lifecycle: "rejected", failureCode: "staging_object_invalid" });
    });
  });

  it("never makes a document available on a sealed hash it cannot open", async () => {
    const fixture = await createIntegrationFixture("sealed-recovery-unopenable");
    await withRequiredScanMode(async () => {
      const documentId = await outageStaged(fixture, pdf("recovery unopenable"));
      const row = await columnsOf(documentId);
      await setColumns(documentId, null, damageEnvelope(row.sealed!));
      const outcome = await recover(documentId);
      expect(outcome.lifecycle).not.toBe("available");
    });
  });
});

/* ---- readers: archive export ---- */

describe("an archive export keeps contentSha256 in plain inside the encrypted archive (#1771)", () => {
  async function exportedHash(fixture: Fixture, documentId: string): Promise<string | undefined> {
    const archive = await createPortableArchive({ userId: fixture.users.owner.id, householdId: fixture.household.id, passphrase, includeDocuments: false });
    const { bytes } = await readPortableArchive(fixture.users.owner.id, archive.id);
    const payload = JSON.parse(decryptPortableArchive(JSON.parse(bytes.toString("utf8")), passphrase).toString("utf8")) as {
      documents: Array<{ id: string; contentSha256?: string }>;
    };
    return payload.documents.find((document) => document.id === documentId)?.contentSha256;
  }

  it.each(STATES)("writes the file's SHA-256 for a row in the %s state, and the database holds none", async (state) => {
    const fixture = await createIntegrationFixture(`sealed-export-${state}`);
    const bytes = pdf(`export ${state}`);
    const { documentId } = await attach(fixture, await fixture.session("member"), bytes);
    await putInState(documentId, bytes, state);
    expect(await exportedHash(fixture, documentId)).toBe(sha256(bytes));
    if (state !== "legacy") expect((await columnsOf(documentId)).plain).toBeNull();
  });
});

/* ---- key rotation ---- */

describe("a KEK rewrap leaves every sealed hash readable (#1771)", () => {
  it("opens sealed hashes after the rotation, recognises retries and duplicates, and does not need the backfill to run again", async () => {
    const fixture = await createIntegrationFixture("sealed-kek-rotation");
    await drainFor(fixture);
    const member = await fixture.session("member");
    const newBytes = pdf("rotation new");
    const oldBytes = pdf("rotation backfilled");
    const newRow = await attach(fixture, member, newBytes);
    const oldRow = await attach(fixture, member, oldBytes);
    await makeLegacy(oldRow.documentId, sha256(oldBytes));
    await drainFor(fixture);
    await expectSealedTo(newRow.documentId, sha256(newBytes));
    await expectSealedTo(oldRow.documentId, sha256(oldBytes));

    const current = getDocumentConfig();
    const originalKek = process.env.DOCUMENT_KEK;
    const nextKek = randomBytes(32);
    const keys: RotationKeys = {
      currentKek: current.keyEncryptionKey, currentKeyId: current.keyId, nextKek, nextKeyId: deriveDocumentKeyId(nextKek),
    };
    try {
      process.env.DOCUMENT_KEK_NEXT = nextKek.toString("hex");
      resetDocumentConfigForTests();
      resetMetadataKeyCacheForTests();
      await runKekRotationToCompletion(keys);
      process.env.DOCUMENT_KEK = nextKek.toString("hex");
      delete process.env.DOCUMENT_KEK_NEXT;
      resetDocumentConfigForTests();
      resetMetadataKeyCacheForTests();

      await expectSealedTo(newRow.documentId, sha256(newBytes));
      await expectSealedTo(oldRow.documentId, sha256(oldBytes));
      const retry = await attach(fixture, member, newBytes, { documentId: newRow.documentId });
      expect([200, 201]).toContain(retry.response.status);
      const duplicate = await stage(fixture, member, oldBytes);
      expect(await alreadyHeldOf(duplicate.response)).toMatchObject({ documentId: oldRow.documentId });
    } finally {
      process.env.DOCUMENT_KEK = nextKek.toString("hex");
      process.env.DOCUMENT_KEK_NEXT = current.keyEncryptionKey.toString("hex");
      resetDocumentConfigForTests();
      resetMetadataKeyCacheForTests();
      await runKekRotationToCompletion({
        currentKek: nextKek, currentKeyId: keys.nextKeyId, nextKek: current.keyEncryptionKey, nextKeyId: current.keyId,
      });
      if (originalKek === undefined) delete process.env.DOCUMENT_KEK;
      else process.env.DOCUMENT_KEK = originalKek;
      delete process.env.DOCUMENT_KEK_NEXT;
      resetDocumentConfigForTests();
      resetMetadataKeyCacheForTests();
    }
  });
});
