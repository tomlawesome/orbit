/**
 * #1390 (design note §4, integration lines 7, 9, 14-17, 22, 26 (gate and
 * sweep), 27, 28 and 30 (fixture and 413); ADR-0045): format v2 archives
 * with the real database and the real document store. Written from the
 * specification alone, before the build.
 *
 * Lines 21, 23-25 and the heartbeat half of 26 need a hook inside the
 * document path and live in portable-archive-v2-stage-switch.test.ts; line 18
 * mocks the file system and lives in portable-archive-v2-export-disk.test.ts;
 * lines 19, 20 and the memory half of 30 are in portable-archive-v2-memory.test.ts.
 *
 * Columns and exports that do not exist before the build (lease_renewed_at,
 * rollBackStaleUnfinishedPortableImports, maxArchiveFileBytes, the V1_
 * constants) are reached through SQL text or a namespace cast, so this file
 * type-checks today and fails at run time.
 */
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { documents, households, items, portableArchiveImports, portableArchives } from "@/db/schema";
import { householdOwnerLockKey } from "@/lib/auth/authority-locks";
import { readDocumentDownload } from "@/server/document-repository";
import { getDocumentConfig, resetDocumentConfigForTests } from "@/server/documents/config";
import * as repository from "@/server/portable-archive-repository";
import * as limitsModule from "@/server/portable-archive-limits";
import { requireHouseholdAccess } from "@/server/workspace-access";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";
import { deferred, waitForAdvisoryLockWaiters } from "./support/concurrency";
import { archiveForm, encodeForm, trackedBody } from "./support/portable-archive-upload";
import { errorOf, postForm, postUpload, proofCookie } from "./support/portable-archive-routes";
import { callRouteForSession, loadRoute } from "./support/request-event";
import { seedStoredDocuments } from "./support/stored-documents";
import { syntheticPdf } from "../support/synthetic-documents";
import {
  openV2,
  readV2Header,
  segmentCount,
  sha256,
  v2Archive,
  v2FileBytes,
  v2HeadSliceBytes,
  V2_HEADER_BYTES,
  V2_MAX_MANIFEST_BYTES,
  V2_SEGMENT_BYTES,
  V2_TAG_BYTES,
  type LimitsV2,
} from "../support/portable-archive-v2";

const MIB = 1_048_576;
const S = V2_SEGMENT_BYTES;
const passphrase = "correct-horse-battery-staple";

const { POST: previewRoute } = await loadRoute("portable-archives/preview");
const { POST: importRoute } = await loadRoute("portable-archives/import");
const { GET: downloadRoute } = await loadRoute("portable-archives/[archiveId]/download");
const { GET: sessionStatus } = await loadRoute("auth/session");

const limits = limitsModule as unknown as LimitsV2 & typeof limitsModule;
const v2Repository = repository as unknown as typeof repository & {
  rollBackStaleUnfinishedPortableImports(): Promise<void>;
};

/** web/src/lib/server/body-limit.js and the browser's archive.js, as other integration tests reach web modules. */
const bodyLimit = (await import(/* @vite-ignore */ new URL("../../web/src/lib/server/body-limit.js", import.meta.url).href)) as {
  SMALL_BODY_LIMIT: number;
  bodyLimitFor(routeId: string | null, readLimit: () => Promise<number>): Promise<{ limit: number; code: string }>;
  limitRequestBody(request: Request, rule: { limit: number; code: string; message: string }): Request | Response;
};
const archiveJs = (await import(/* @vite-ignore */ new URL("../../web/src/routes/household/[id]/archive.js", import.meta.url).href)) as {
  previewSlice?: (file: Blob) => Promise<Blob>;
};

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

const savedQuota = process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES;
afterEach(() => {
  if (savedQuota === undefined) delete process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES;
  else process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES = savedQuota;
  resetDocumentConfigForTests();
});

type Fixture = IntegrationFixture;

/**
 * A real, openable PDF of exactly `size` bytes: the import restores each
 * document through the ordinary upload path, which refuses anything else.
 * Copied from portable-archive-stream-import.test.ts.
 */
function pdfOfSize(size: number, label: string): Buffer {
  let padding = Math.max(0, size - 800);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const pdf = syntheticPdf(`${label} ${"x".repeat(padding)}`);
    if (pdf.length === size) return pdf;
    padding += size - pdf.length;
    if (padding < 0) throw new Error(`no PDF of ${size} bytes`);
  }
  throw new Error(`no PDF of ${size} bytes`);
}

async function exportOf(fixture: Fixture, includeDocuments = true) {
  return repository.createPortableArchive({ userId: fixture.users.owner.id, householdId: fixture.household.id, passphrase, includeDocuments });
}

/** The exported archive file, byte for byte as the download gives it. */
async function exportFile(fixture: Fixture, includeDocuments = true): Promise<{ id: string; file: Buffer }> {
  const archive = await exportOf(fixture, includeDocuments);
  const { bytes } = await repository.readPortableArchive(fixture.users.owner.id, archive.id);
  return { id: archive.id, file: Buffer.from(bytes) };
}

type Manifest = {
  version: number;
  household: Record<string, unknown>;
  sections: Array<Record<string, unknown>>;
  items: Array<Record<string, unknown>>;
  documents: Array<Record<string, unknown>>;
  body: Array<{ id: string; sizeBytes: number; contentSha256: string }>;
};

/** The manifest and the bodies of a v2 file, opened by hand from the layout. */
function unpack(file: Buffer): { manifest: Manifest; bodies: Map<string, Buffer> } {
  const header = readV2Header(file);
  const plaintext = openV2(file, passphrase);
  const manifest = JSON.parse(plaintext.subarray(0, header.manifestBytes).toString("utf8")) as Manifest;
  const bodies = new Map<string, Buffer>();
  let offset = header.manifestBytes;
  for (const entry of manifest.body) {
    bodies.set(entry.id, plaintext.subarray(offset, offset + entry.sizeBytes));
    offset += entry.sizeBytes;
  }
  return { manifest, bodies };
}

async function storedFilePath(archiveId: string): Promise<string> {
  const [row] = await getDb().select({ storageKey: portableArchives.storageKey }).from(portableArchives).where(eq(portableArchives.id, archiveId));
  const root = process.env.DOCUMENTS_ROOT!;
  for (const entry of await readdir(root, { recursive: true })) {
    if (!entry.includes(row.storageKey)) continue;
    const path = join(root, entry);
    if ((await stat(path)).isFile()) return path;
  }
  throw new Error(`no stored file for ${archiveId}`);
}

async function storedFiles(): Promise<string[]> {
  // Files only: deleting a blob leaves its empty shard folder, which holds no document bytes.
  const entries = await readdir(process.env.DOCUMENTS_ROOT!, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).sort();
}

async function previewUpload(fixture: Fixture, file: Buffer) {
  const owner = await fixture.session("owner");
  return postForm(previewRoute, "/api/portable-archives/preview", owner, archiveForm({ householdId: fixture.household.id, passphrase }, file));
}

async function importUpload(fixture: Fixture, file: Buffer) {
  const owner = await fixture.session("owner");
  return postForm(importRoute, "/api/portable-archives/import", owner,
    archiveForm({ householdId: fixture.household.id, passphrase, conflictItemIds: [] }, file), await proofCookie(owner, "archive_import"));
}

/** An import start record, as the import writes one, with its lease columns set by SQL (lease_renewed_at is new in 0010). */
async function openImportRow(fixture: Fixture, options: { startedMinutesAgo: number; renewedMinutesAgo?: number; createdItemIds?: string[] }): Promise<string> {
  const [row] = await getDb().insert(portableArchiveImports).values({
    householdId: fixture.household.id,
    actorUserId: fixture.users.owner.id,
    startedAt: new Date(Date.now() - options.startedMinutesAgo * 60_000),
    finishedAt: null,
    createdSectionIds: [],
    createdItemIds: options.createdItemIds ?? [],
  }).returning({ id: portableArchiveImports.id });
  if (options.renewedMinutesAgo !== undefined) {
    await getDb().execute(sql`update portable_archive_imports set lease_renewed_at = now() - make_interval(mins => ${options.renewedMinutesAgo}) where id = ${row.id}`);
  }
  return row.id;
}

async function importRow(importId: string) {
  const [row] = await getDb().select().from(portableArchiveImports).where(eq(portableArchiveImports.id, importId));
  return row;
}

async function stagedRows(householdId: string) {
  return getDb().select({ id: documents.id }).from(documents).where(and(eq(documents.householdId, householdId), isNull(documents.itemId)));
}

const refusalOf = (work: Promise<unknown>) => work.then(() => null, (error: unknown) => error);

// ---------------------------------------------------------------------------

describe("§4 line 14: the export writes a v2 file", () => {
  it("has the stated 64-byte header, ceil(T/S) segments, 64 + T + 16n bytes on disk, the recorded hash of the file, and downloads as .orbit octet-stream", async () => {
    // Catches an export still writing v1 JSON, a header field out of place, padding or truncation, or the old download name and type.
    const fixture = await createIntegrationFixture("arch1390-v2-file");
    const contents = [pdfOfSize(1_001, "a"), pdfOfSize(S + 17, "b"), pdfOfSize(3 * S - 1, "c")];
    await seedStoredDocuments(fixture, contents);
    const { id, file } = await exportFile(fixture);

    const header = readV2Header(file);
    expect(header.magic.toString("ascii")).toBe("ORBITARC");
    expect([header.version, header.kdf, header.log2N, header.r, header.p]).toEqual([2, 1, 14, 8, 5]);
    expect(header.segmentBytes).toBe(S);
    expect(header.reserved.equals(Buffer.alloc(8))).toBe(true);
    expect(header.manifestBytes).toBeGreaterThan(0);
    expect(header.manifestBytes).toBeLessThanOrEqual(header.plaintextBytes);

    const onDisk = await readFile(await storedFilePath(id));
    expect(onDisk.equals(file)).toBe(true);
    expect(onDisk.length).toBe(V2_HEADER_BYTES + header.plaintextBytes + V2_TAG_BYTES * segmentCount(header.plaintextBytes));
    expect(onDisk.length).toBe(v2FileBytes(header.plaintextBytes));
    const [row] = await getDb().select({ contentSha256: portableArchives.contentSha256, sizeBytes: portableArchives.sizeBytes }).from(portableArchives).where(eq(portableArchives.id, id));
    expect(row.contentSha256).toBe(createHash("sha256").update(onDisk).digest("hex"));
    expect(row.sizeBytes).toBe(onDisk.length);

    const { manifest, bodies } = unpack(file);
    expect(manifest.version).toBe(2);
    expect(manifest).not.toHaveProperty("documentBytes");
    expect(header.plaintextBytes).toBe(header.manifestBytes + manifest.body.reduce((sum, entry) => sum + entry.sizeBytes, 0));
    for (const content of contents) {
      const entry = manifest.body.find((candidate) => candidate.contentSha256 === sha256(content));
      expect(entry, "every document travels as a body").toBeDefined();
      expect(bodies.get(entry!.id)!.equals(content), "raw bytes, not base64").toBe(true);
    }

    const owner = await fixture.session("owner");
    const download = await callRouteForSession(downloadRoute, owner, { url: "http://127.0.0.1:3000/api/portable-archives/download", params: { archiveId: id } });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toBe(`attachment; filename="orbit-export-${id}.orbit"`);
    expect(Buffer.from(await download.arrayBuffer()).equals(file)).toBe(true);
  }, 300_000);
});

describe("§6.3: an export recorded above 2 GiB inserts (size_bytes is bigint)", () => {
  it("records and reads back a 5 GiB archive size exactly", async () => {
    // Catches size_bytes as int4 (the insert fails past 2,147,483,647) or read back in a mode that loses it.
    const fixture = await createIntegrationFixture("arch1390-size-bigint");
    const sizeBytes = 5 * 1024 * MIB + 17;
    const [row] = await getDb().insert(portableArchives).values({
      householdId: fixture.household.id,
      requestedByUserId: fixture.users.owner.id,
      storageKey: randomUUID(),
      contentSha256: "0".repeat(64),
      sizeBytes,
      expiresAt: new Date(Date.now() + 86_400_000),
    }).returning({ id: portableArchives.id });
    const [read] = await getDb().select({ sizeBytes: portableArchives.sizeBytes }).from(portableArchives).where(eq(portableArchives.id, row.id));
    expect(read.sizeBytes).toBe(sizeBytes);
  }, 60_000);
});

describe("§4 line 7: the same key never meets the same nonce", () => {
  it("two exports of one household under one passphrase have different salts and different nonce prefixes", async () => {
    // Catches a fixed or reused salt (same key) together with a fixed prefix (same nonces): GCM's one fatal misuse.
    const fixture = await createIntegrationFixture("arch1390-fresh-nonce");
    const first = readV2Header((await exportFile(fixture, false)).file);
    const second = readV2Header((await exportFile(fixture, false)).file);
    expect(first.salt.equals(second.salt)).toBe(false);
    expect(first.noncePrefix.equals(second.noncePrefix)).toBe(false);
  }, 120_000);
});

describe("§4 line 15: round trip through the routes, the preview posting only the head", () => {
  it("previews from the head slice (64 + ceil(M/S)(S+16) bytes) with today's preview object, imports the whole file, and every document, item and section field comes across", async () => {
    // Catches a preview that needs the bodies, a previewSlice that cuts wrongly, or a v2 import that changes any field (#1521's round trip).
    const source = await createIntegrationFixture("arch1390-roundtrip-source");
    const target = await createIntegrationFixture("arch1390-roundtrip-target");
    const contents = [1_001, 65_536, S - 1, S, S + 1, 3 * S + 7].map((size, index) => pdfOfSize(size, `round trip ${index}`));
    await seedStoredDocuments(source, contents);
    await getDb().delete(documents).where(eq(documents.id, target.document.id));
    const { file } = await exportFile(source);
    const header = readV2Header(file);

    expect(archiveJs.previewSlice, "archive.js exports previewSlice (§3)").toBeTypeOf("function");
    const head = Buffer.from(await (await archiveJs.previewSlice!(new Blob([new Uint8Array(file)]))).arrayBuffer());
    expect(head.length).toBe(Math.min(file.length, V2_HEADER_BYTES + Math.ceil(header.manifestBytes / S) * (S + V2_TAG_BYTES)));
    expect(head.length).toBe(v2HeadSliceBytes(file));
    expect(head.length, "the head is less than the file (the bodies stay behind)").toBeLessThan(file.length);
    expect(head.equals(file.subarray(0, head.length))).toBe(true);

    const previewed = await previewUpload(target, head);
    expect(previewed.status, JSON.stringify(await errorOf(previewed).catch(() => ({})))).toBe(200);
    expect(((await previewed.json()) as { preview: unknown }).preview)
      .toEqual({ householdName: source.household.name, sections: expect.any(Number), items: 1, documents: contents.length, conflicts: [], documentsExcluded: false });

    const imported = await importUpload(target, file);
    expect(imported.status, JSON.stringify(await errorOf(imported).catch(() => ({})))).toBe(200);
    expect(await imported.json()).toEqual({ importedItems: 1, documentsExcluded: 0 });

    const before = unpack((await exportFile(source)).file).manifest;
    const after = unpack((await exportFile(target)).file);
    const sourceItem = before.items.find((item) => item.id === source.item.id)!;
    const importedItem = after.manifest.items.find((item) => item.title === sourceItem.title);
    expect(importedItem, "the item came across").toBeDefined();
    for (const field of ["title", "subtype", "provider", "reference", "costMinor", "currency", "startDate", "expiryDate", "renewalDate", "serviceDate", "recurrenceMonths", "snoozedUntil", "notes", "externalDocumentUrl", "status"]) {
      expect(importedItem![field] ?? null, field).toEqual(sourceItem[field] ?? null);
    }
    const sourceSection = before.sections.find((section) => section.id === sourceItem.sectionId)!;
    const importedSection = after.manifest.sections.find((section) => section.id === importedItem!.sectionId)!;
    for (const field of ["slug", "name", "icon", "accent", "position", "visible", "archivedAt"]) {
      expect(importedSection[field] ?? null, field).toEqual(sourceSection[field] ?? null);
    }
    const importedDocuments = after.manifest.documents.filter((document) => document.itemId === importedItem!.id);
    expect(importedDocuments).toHaveLength(contents.length);
    for (const [index, content] of contents.entries()) {
      const wanted = before.documents.find((document) => document.displayName === `stored-${index}.pdf`)!;
      const got = importedDocuments.find((document) => document.displayName === `stored-${index}.pdf`);
      expect(got, `stored-${index}.pdf came across`).toBeDefined();
      for (const field of ["mediaType", "sizeBytes", "contentSha256", "lifecycle"]) expect(got![field], field).toEqual(wanted[field]);
      const downloaded = await readDocumentDownload(target.users.owner.id, got!.id as string);
      expect(downloaded.bytes.equals(content), `stored-${index}.pdf bytes`).toBe(true);
      expect(after.bodies.get(got!.id as string)!.equals(content)).toBe(true);
    }
  }, 600_000);

  it("previewSlice sends a v1 file, and a file whose head does not parse, whole", async () => {
    // Catches a slice applied to v1 (it has no header; cutting it breaks its preview).
    expect(archiveJs.previewSlice, "archive.js exports previewSlice (§3)").toBeTypeOf("function");
    const v1 = await readFile(new URL("../fixtures/portable-archive-v1.json", import.meta.url));
    for (const file of [v1, Buffer.from("ORBITAR"), Buffer.from("not an archive at all, but longer than sixty-four bytes of text, surely")]) {
      const sliced = await archiveJs.previewSlice!(new Blob([new Uint8Array(file)]));
      expect(sliced.size).toBe(file.length);
    }
  });
});

describe("§4 line 16: a preview of the whole file gives the same answer and reads the body away", () => {
  it("answers as the head-slice preview does, and the request body is read to its end (the connection is reusable)", async () => {
    // Catches a preview that stops reading after the manifest and leaves the upload unread (the client's connection hangs).
    const source = await createIntegrationFixture("arch1390-preview-whole-source");
    const target = await createIntegrationFixture("arch1390-preview-whole-target");
    await seedStoredDocuments(source, [pdfOfSize(3 * S + 5, "whole a"), pdfOfSize(2 * S, "whole b")]);
    const { file } = await exportFile(source);

    const headAnswer = await previewUpload(target, file.subarray(0, v2HeadSliceBytes(file)));
    expect(headAnswer.status).toBe(200);

    const owner = await target.session("owner");
    const upload = await encodeForm(archiveForm({ householdId: target.household.id, passphrase }, file));
    const tracked = trackedBody(upload.bytes);
    const whole = await postUpload(previewRoute, { path: "/api/portable-archives/preview", session: owner, body: tracked.body, contentType: upload.contentType });
    expect(whole.status).toBe(200);
    expect(await whole.json()).toEqual(await headAnswer.json());
    for (let waited = 0; !tracked.stats.done && waited < 5_000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tracked.stats.done, "the rest of the body was read away").toBe(true);
    expect(tracked.stats.pulledBytes).toBe(upload.bytes.length);
  }, 300_000);
});

describe("§4 line 17: the export lists only bound documents (PR-5/PR-52)", () => {
  it("leaves a staged, unbound upload out of documents[] and body[], and the preview does not say documents were excluded", async () => {
    // Catches the documents query without isNotNull(documents.itemId): a stranger's staged draft would ship in the archive.
    const fixture = await createIntegrationFixture("arch1390-pr5-source");
    const target = await createIntegrationFixture("arch1390-pr5-target");
    const [bound, staged] = await seedStoredDocuments(fixture, [pdfOfSize(70_001, "bound"), pdfOfSize(80_001, "staged")]);
    await getDb().update(documents)
      .set({ itemId: null, sealedItemId: randomUUID(), deleteAfter: new Date(Date.now() + 86_400_000) })
      .where(eq(documents.id, staged));

    const { file } = await exportFile(fixture);
    const { manifest } = unpack(file);
    expect(manifest.documents.map((document) => document.id)).toEqual([bound]);
    expect(manifest.body.map((entry) => entry.id)).toEqual([bound]);

    const previewed = await previewUpload(target, file);
    expect(previewed.status).toBe(200);
    expect(((await previewed.json()) as { preview: unknown }).preview).toMatchObject({ documents: 1, documentsExcluded: false });
  }, 120_000);
});

describe("§4 line 9 (real store): a body whose bytes do not match its contentSha256 leaves no staged row and no blob", () => {
  it("refuses with archive_invalid, and the household's documents and the store are as they were", async () => {
    // Catches the hash compared but the staged document (row and blob) left behind for the reconcile to find.
    const target = await createIntegrationFixture("arch1390-hash-target");
    const sectionId = randomUUID();
    const itemId = randomUUID();
    const good = pdfOfSize(70_001, "good");
    const bad = pdfOfSize(90_001, "bad");
    const claimed = sha256(pdfOfSize(90_001, "something else"));
    const ids = [randomUUID(), randomUUID()];
    const manifest = {
      format: "orbit-portable-archive", version: 2, exportedAt: new Date().toISOString(),
      household: { name: "Imported household" },
      sections: [{ id: sectionId, slug: `imported-${sectionId.slice(0, 8)}`, name: "Imported section", icon: "home", accent: "blue", position: 0, visible: true }],
      items: [{ id: itemId, sectionId, title: "Imported item", currency: "GBP", status: "active" }],
      dueEvents: [], reminderRules: [],
      documents: [
        { id: ids[0], itemId, displayName: "good.pdf", mediaType: "application/pdf", sizeBytes: good.length, contentSha256: sha256(good), lifecycle: "available" },
        { id: ids[1], itemId, displayName: "bad.pdf", mediaType: "application/pdf", sizeBytes: bad.length, contentSha256: claimed, lifecycle: "available" },
      ],
      body: [{ id: ids[0], sizeBytes: good.length, contentSha256: sha256(good) }, { id: ids[1], sizeBytes: bad.length, contentSha256: claimed }],
    };
    const { file } = v2Archive(manifest, [{ id: ids[0], bytes: good }, { id: ids[1], bytes: bad }], passphrase);
    const filesBefore = await storedFiles();
    const rowsBefore = (await getDb().select({ id: documents.id }).from(documents).where(eq(documents.householdId, target.household.id))).length;

    const imported = await importUpload(target, file);
    expect(imported.status).toBe(422);
    expect((await errorOf(imported)).code).toBe("archive_invalid");
    expect(await stagedRows(target.household.id)).toEqual([]);
    expect((await getDb().select({ id: documents.id }).from(documents).where(eq(documents.householdId, target.household.id))).length).toBe(rowsBefore);
    expect(await getDb().select({ id: items.id }).from(items).where(eq(items.householdId, target.household.id))).toEqual([{ id: target.item.id }]);
    expect(await storedFiles(), "no blob left in the store").toEqual(filesBefore);
  }, 120_000);
});

describe("§4 line 22: the rollback takes the household lock (RANGE-R2/1)", () => {
  async function holdOwnerLock(householdId: string) {
    const held = deferred<void>();
    const release = deferred<void>();
    const holder = getDb().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${householdOwnerLockKey(householdId)}, 0))`);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    return { release: async () => { release.resolve(); await holder; } };
  }

  it("waits for the owner-lock key held by another transaction, then rolls the import back", async () => {
    // Catches a rollback without pg_advisory_xact_lock: it would run (and finish) while the lock is held.
    const fixture = await createIntegrationFixture("arch1390-rollback-lock");
    const importId = await openImportRow(fixture, { startedMinutesAgo: 5, createdItemIds: [fixture.item.id] });
    const lock = await holdOwnerLock(fixture.household.id);
    let settled = false;
    const rollback = repository.rollBackPortableImport(importId).finally(() => { settled = true; });
    try {
      await waitForAdvisoryLockWaiters(1);
      expect(settled, "the rollback waits behind the lock").toBe(false);
      expect((await importRow(importId)).finishedAt).toBeNull();
    } finally {
      await lock.release();
    }
    await rollback;
    expect((await importRow(importId)).outcome).toBe("rolled_back");
  }, 60_000);

  it("still rolls back an import of a household marked for deletion", async () => {
    // Catches the lock taken through the "household is active" check, which refuses a household marked for deletion.
    const fixture = await createIntegrationFixture("arch1390-rollback-deleting");
    const importId = await openImportRow(fixture, { startedMinutesAgo: 5, createdItemIds: [fixture.item.id] });
    await getDb().update(households).set({ deletionRequestedAt: new Date() }).where(eq(households.id, fixture.household.id));
    await repository.rollBackPortableImport(importId);
    const row = await importRow(importId);
    expect(row.finishedAt).not.toBeNull();
    expect(row.outcome).toBe("rolled_back");
  }, 60_000);
});

describe("§4 line 26: the lease is measured from the last heartbeat (gate and stale sweep)", () => {
  it("the gate still refuses a member when started_at is 2 h old but lease_renewed_at is 5 min old", async () => {
    // Catches the gate reading started_at alone: a long, live import would reopen the household after an hour.
    const fixture = await createIntegrationFixture("arch1390-lease-gate");
    await openImportRow(fixture, { startedMinutesAgo: 120, renewedMinutesAgo: 5 });
    await expect(requireHouseholdAccess(fixture.users.member.id, fixture.household.id)).rejects.toMatchObject({ code: "household_import_in_progress" });
  }, 60_000);

  it("the stale sweep rolls back a row renewed 61 min ago and leaves one renewed 59 min ago", async () => {
    // Catches a sweep measured from started_at (both rows are 2 h old) or a lease of the wrong length.
    const stale = await createIntegrationFixture("arch1390-lease-stale");
    const live = await createIntegrationFixture("arch1390-lease-live");
    const staleId = await openImportRow(stale, { startedMinutesAgo: 120, renewedMinutesAgo: 61 });
    const liveId = await openImportRow(live, { startedMinutesAgo: 120, renewedMinutesAgo: 59 });
    expect(v2Repository.rollBackStaleUnfinishedPortableImports, "exported for the worker (§3)").toBeTypeOf("function");
    await v2Repository.rollBackStaleUnfinishedPortableImports();
    expect((await importRow(staleId)).outcome).toBe("rolled_back");
    expect((await importRow(liveId)).finishedAt).toBeNull();
  }, 60_000);
});

describe("§4 line 27: an archive over the household's remaining quota is refused before any body is read", () => {
  it("answers 413 archive_over_quota at the manifest's end, staging nothing", async () => {
    // Catches a quota found only by the document path part-way through (some documents staged, minutes of upload spent).
    const source = await createIntegrationFixture("arch1390-quota-source");
    const target = await createIntegrationFixture("arch1390-quota-target");
    await seedStoredDocuments(source, [pdfOfSize(14 * MIB, "quota a"), pdfOfSize(13 * MIB, "quota b")]);
    const { file } = await exportFile(source);
    const header = readV2Header(file);
    // The smallest quota the configuration accepts: 25 MiB, under the 27 MiB the archive carries.
    process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES = String(25 * MIB);
    resetDocumentConfigForTests();

    const owner = await target.session("owner");
    const upload = await encodeForm(archiveForm({ householdId: target.household.id, passphrase, conflictItemIds: [] }, file));
    const tracked = trackedBody(upload.bytes);
    const response = await postUpload(importRoute, { path: "/api/portable-archives/import", session: owner, body: tracked.body, contentType: upload.contentType, cookie: await proofCookie(owner, "archive_import") });
    // Read when the answer arrives: afterwards the route drains the rest of the body away (as portable-archive-upload.test.ts does).
    const pulledAtResponse = tracked.stats.pulledBytes;

    expect(response.status).toBe(413);
    expect((await errorOf(response)).code).toBe("archive_over_quota");
    expect(await stagedRows(target.household.id)).toEqual([]);
    expect(await getDb().select({ id: portableArchiveImports.id }).from(portableArchiveImports).where(eq(portableArchiveImports.householdId, target.household.id))).toEqual([]);
    // Pulled before the refusal: the form fields, the header and the manifest's segments, plus a piece of read-ahead; not the 27 MiB of bodies.
    const manifestEnd = V2_HEADER_BYTES + Math.ceil(header.manifestBytes / S) * (S + V2_TAG_BYTES);
    expect(pulledAtResponse - (upload.bytes.length - file.length), "bytes of the file read before the refusal").toBeLessThan(manifestEnd + 2 * (S + V2_TAG_BYTES));
  }, 300_000);
});

describe("§4 line 28: the session's limit, the import route's 413 and the export agree", () => {
  const IMPORT_ROUTE = "/api/portable-archives/import";

  async function sessionLimit(fixture: Fixture): Promise<number> {
    const response = await callRouteForSession(sessionStatus, await fixture.session("owner"), { url: "http://127.0.0.1:3000/api/auth/session" });
    expect(response.status).toBe(200);
    return ((await response.json()) as { limits: { archiveFileBytes: number } }).limits.archiveFileBytes;
  }

  it("limits.archiveFileBytes is quota + MAX_MANIFEST_BYTES + 64 + ceil(that / S) x 16, from the configuration", async () => {
    // Catches a constant ceiling, or one that forgets the header or the per-segment tags.
    const fixture = await createIntegrationFixture("arch1390-limits-formula");
    for (const quota of [undefined, String(25 * MIB)]) {
      if (quota === undefined) delete process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES;
      else process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES = quota;
      resetDocumentConfigForTests();
      const plaintext = getDocumentConfig().householdQuotaBytes + V2_MAX_MANIFEST_BYTES;
      const expected = plaintext + V2_HEADER_BYTES + Math.ceil(plaintext / S) * V2_TAG_BYTES;
      expect(limits.MAX_MANIFEST_BYTES).toBe(V2_MAX_MANIFEST_BYTES);
      expect(limits.maxArchiveFileBytes(getDocumentConfig())).toBe(expected);
      expect(await sessionLimit(fixture)).toBe(expected);
    }
  }, 60_000);

  it("the import route takes a body of the file ceiling plus the form's small allowance, and answers 413 request_too_large one byte over", async () => {
    // Catches the body limit still sized from the v1 constants (343 MiB) while the card says 5.1 GiB.
    const fixture = await createIntegrationFixture("arch1390-limits-413");
    const ceiling = await sessionLimit(fixture);
    const rule = await bodyLimit.bodyLimitFor(IMPORT_ROUTE, async () => 50 * MIB);
    expect(rule.limit).toBe(ceiling + bodyLimit.SMALL_BODY_LIMIT);
    const declared = (size: number) => new Request(`http://127.0.0.1:3000${IMPORT_ROUTE}`, {
      method: "POST",
      headers: { "content-length": String(size), "content-type": "multipart/form-data; boundary=x" },
      body: new ReadableStream<Uint8Array>({ pull(controller) { controller.close(); } }),
      duplex: "half",
    } as RequestInit);
    const atLimit = bodyLimit.limitRequestBody(declared(rule.limit), { ...rule, message: "That request is too large" });
    expect(atLimit).not.toBeInstanceOf(Response);
    const over = bodyLimit.limitRequestBody(declared(rule.limit + 1), { ...rule, message: "That request is too large" });
    expect(over).toBeInstanceOf(Response);
    expect((over as Response).status).toBe(413);
    expect(((await (over as Response).json()) as { error: { code: string } }).error.code).toBe("request_too_large");
  }, 60_000);

  it("the export of a household at its quota is under the ceiling", async () => {
    // Catches a ceiling that the export can exceed: a file Orbit wrote that Orbit then refuses.
    process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES = String(25 * MIB);
    resetDocumentConfigForTests();
    const fixture = await createIntegrationFixture("arch1390-limits-at-quota");
    await seedStoredDocuments(fixture, [pdfOfSize(10 * MIB, "q1"), pdfOfSize(10 * MIB, "q2"), pdfOfSize(5 * MIB, "q3")]);
    const { file } = await exportFile(fixture);
    expect(file.length).toBeLessThanOrEqual(await sessionLimit(fixture));
    expect(file.length).toBeLessThanOrEqual(limits.maxArchiveFileBytes(getDocumentConfig()));
  }, 300_000);
});

describe("§4 line 30: v1 archives still import end to end", () => {
  const FIXTURE_PASSPHRASE = "orbit-v1-fixture-passphrase-1390";
  const FIXTURE_PDF_SHA256 = "343703ed9a7c56c5e461cf4258f3e66271f92b3b320c20589f1a422923d6fe75";

  it("imports the committed fixture through the route and its document downloads byte for byte", async () => {
    // Pins existing behaviour: today's v1 path imports this file; the stage-then-switch rewrite must keep it.
    const target = await createIntegrationFixture("arch1390-v1-fixture");
    const v1 = await readFile(new URL("../fixtures/portable-archive-v1.json", import.meta.url));
    const owner = await target.session("owner");
    const imported = await postForm(importRoute, "/api/portable-archives/import", owner,
      archiveForm({ householdId: target.household.id, passphrase: FIXTURE_PASSPHRASE, conflictItemIds: [] }, v1), await proofCookie(owner, "archive_import"));
    expect(imported.status, JSON.stringify(await errorOf(imported).catch(() => ({})))).toBe(200);
    expect(await imported.json()).toEqual({ importedItems: 1, documentsExcluded: 0 });
    const [restored] = await getDb().select({ id: documents.id }).from(documents)
      .where(and(eq(documents.householdId, target.household.id), eq(documents.displayName, "fixture-policy.pdf")));
    expect(restored, "the fixture's document came across").toBeDefined();
    const downloaded = await readDocumentDownload(target.users.owner.id, restored.id);
    expect(sha256(downloaded.bytes)).toBe(FIXTURE_PDF_SHA256);
  }, 120_000);

  it("keeps the v1 limits under V1_ names with today's values, and refuses a v1 file one byte over V1_MAX_ARCHIVE_FILE_BYTES with 413", async () => {
    // Catches the v1 path handed the v2 ceiling (it would park a 5 GiB plaintext on the 320 MiB scratch tmpfs).
    expect(limits.V1_MAX_ARCHIVE_BYTES).toBe(256 * MIB);
    expect(limits.V1_MAX_ARCHIVE_FILE_BYTES).toBe(Math.ceil((256 * MIB) / 3) * 4 + 64 * 1024);
    const target = await createIntegrationFixture("arch1390-v1-413");
    const total = limits.V1_MAX_ARCHIVE_FILE_BYTES + 1;
    const head = Buffer.from(`{"version":1,"algorithm":"aes-256-gcm","kdf":"scrypt","salt":"c2FsdHNhbHRzYWx0c2FsdA","iv":"aXZpdml2aXZpdml2","ciphertext":"`);
    const tail = Buffer.from(`","authTag":"dGFndGFndGFndGFndGFndA"}`);
    const block = Buffer.alloc(65_536, "A");
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 0) { sent += head.length; controller.enqueue(new Uint8Array(head)); return; }
        const middle = total - head.length - tail.length;
        if (sent < head.length + middle) {
          const size = Math.min(block.length, head.length + middle - sent);
          sent += size;
          controller.enqueue(new Uint8Array(block.subarray(0, size)));
          return;
        }
        if (sent < total) { sent += tail.length; controller.enqueue(new Uint8Array(tail)); return; }
        controller.close();
      },
    }, { highWaterMark: 0 });
    const refusal = await refusalOf(repository.previewPortableImport(target.users.owner.id, target.household.id, stream, passphrase));
    expect(refusal).toMatchObject({ status: 413 });
  }, 600_000);
});
