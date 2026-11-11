/**
 * #1390 review round 1 (issue note 55214), the export and header rulings:
 *   5  scrypt parameters (export writes p=5; earlier p=1 still imports;
 *      a header that would make scrypt fail or run long is archive_invalid, not 500)
 *   6  an export that would be too big to import is refused with a clear message
 *   7  the export's plaintext is zeroed after use, also when it fails
 *   8  the export reads one consistent snapshot (a document never ships without its item)
 * Written from the rulings alone, before the fixes.
 *
 * Ruling 7 can be tested here through three public seams only: the document
 * path's stream (`openDocumentDownload`, wrapped to keep a reference to each
 * decrypted chunk it hands out), `SegmentWriter.push` (the first call is the
 * manifest), and `Buffer` (the writer's parked segment is the one
 * segment-sized buffer it allocates). Not testable from outside, and so not
 * tested: that the manifest's JSON *string* and the rows it was built from are
 * gone from the heap (strings and rows are not zeroable), and that the key
 * buffer is zeroed (already covered by the existing key.fill(0) in a finally).
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { documents, items, portableArchives } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { getDocumentConfig, resetDocumentConfigForTests } from "@/server/documents/config";
import { maxArchiveFileBytes } from "@/server/portable-archive-limits";
import { SegmentWriter } from "@/server/portable-archive-container";
import * as repository from "@/server/portable-archive-repository";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";
import { archiveForm } from "./support/portable-archive-upload";
import { errorOf, postForm, proofCookie } from "./support/portable-archive-routes";
import { loadRoute } from "./support/request-event";
import { seedStoredDocuments } from "./support/stored-documents";
import { syntheticPdf } from "../support/synthetic-documents";
import { openV2, readV2Header, sealV2, v2Header, V2_SEGMENT_BYTES } from "../support/portable-archive-v2";

/** The manifest size cap the export applies; the test of the too-large refusal lowers it (second review, R7). */
const limits = vi.hoisted(() => ({ manifestCap: 64 * 1024 * 1024 }));

vi.mock("@/server/portable-archive-limits", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/portable-archive-limits")>();
  return { ...original, get MAX_MANIFEST_BYTES() { return limits.manifestCap; } };
});

/** Every chunk the document path hands the export, kept so the test can look at it afterwards. */
const spy = vi.hoisted(() => ({ chunks: [] as Uint8Array[] }));

vi.mock("@/server/document-repository", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/document-repository")>();
  return {
    ...original,
    openDocumentDownload: async (...args: Parameters<typeof original.openDocumentDownload>) => {
      const download = await original.openDocumentDownload(...args);
      const keeping = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          spy.chunks.push(chunk);
          controller.enqueue(chunk);
        },
      });
      return { ...download, body: download.body.pipeThrough(keeping) };
    },
  };
});

const MIB = 1_048_576;
const S = V2_SEGMENT_BYTES;
const passphrase = "correct-horse-battery-staple";
const { POST: importRoute } = await loadRoute("portable-archives/import");
const { POST: previewRoute } = await loadRoute("portable-archives/preview");

const savedQuota = process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES;
afterEach(() => {
  limits.manifestCap = 64 * 1024 * 1024;
  vi.restoreAllMocks();
  spy.chunks.length = 0;
  if (savedQuota === undefined) delete process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES;
  else process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES = savedQuota;
  resetDocumentConfigForTests();
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

type Fixture = IntegrationFixture;

const realDelay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isZero = (bytes: Uint8Array) => bytes.every((byte) => byte === 0);

const exportOf = (fixture: Fixture, includeDocuments = true) =>
  repository.createPortableArchive({ userId: fixture.users.owner.id, householdId: fixture.household.id, passphrase, includeDocuments });

async function exportFile(fixture: Fixture, includeDocuments = true): Promise<Buffer> {
  const archive = await exportOf(fixture, includeDocuments);
  return Buffer.from((await repository.readPortableArchive(fixture.users.owner.id, archive.id)).bytes);
}

type Manifest = { items: Array<{ id: string }>; documents: Array<{ id: string; itemId: string | null }>; body: Array<{ id: string; sizeBytes: number }> };
const manifestOf = (file: Buffer): Manifest => {
  const header = readV2Header(file);
  return JSON.parse(openV2(file, passphrase).subarray(0, header.manifestBytes).toString("utf8")) as Manifest;
};

const importUpload = async (fixture: Fixture, file: Buffer) => {
  const owner = await fixture.session("owner");
  return postForm(importRoute, "/api/portable-archives/import", owner,
    archiveForm({ householdId: fixture.household.id, passphrase, conflictItemIds: [] }, file), await proofCookie(owner, "archive_import"));
};
const previewUpload = async (fixture: Fixture, file: Buffer) => {
  const owner = await fixture.session("owner");
  return postForm(previewRoute, "/api/portable-archives/preview", owner, archiveForm({ householdId: fixture.household.id, passphrase }, file));
};

/** The same plaintext, sealed by hand under scrypt cost parameters of the test's choosing. */
function resealed(file: Buffer, p: number): Buffer {
  const header = readV2Header(file);
  return sealV2(openV2(file, passphrase), passphrase, { manifestBytes: header.manifestBytes, header: { log2N: header.log2N, r: header.r, p } });
}

// ---------------------------------------------------------------------------

describe("ruling 5: scrypt parameters", () => {
  it("an export writes N=2^14, r=8, p=5 in its header (OWASP's equivalent of N=2^17, r=8, p=1 at 16 MiB), and the file still opens", async () => {
    // Catches p=1: the cheaper-to-attack setting the review replaced.
    const fixture = await createIntegrationFixture("arch1390-scrypt-export");
    const file = await exportFile(fixture, false);
    const header = readV2Header(file);
    expect([header.log2N, header.r, header.p]).toEqual([14, 8, 5]);
    expect(128 * 2 ** header.log2N * header.r, "the memory the key derivation needs stays at 16 MiB, under the 64 MiB bound").toBe(16 * MIB);
    expect(manifestOf(file).items.length, "the file opens under the parameters its header states").toBeGreaterThan(0);
  }, 120_000);

  it("a file the export wrote (p=5) imports into another household", async () => {
    // Catches an import whose header check still caps p at 1: Orbit would refuse its own export.
    const source = await createIntegrationFixture("arch1390-scrypt-roundtrip-source");
    const target = await createIntegrationFixture("arch1390-scrypt-roundtrip-target");
    const file = await exportFile(source, false);
    expect(readV2Header(file).p, "the export writes p=5").toBe(5);
    const response = await importUpload(target, file);
    expect(response.status, JSON.stringify(await errorOf(response.clone()).catch(() => ({})))).toBe(200);
  }, 120_000);

  it("an earlier v2 export (p=1) still previews and imports", async () => {
    // Pins compatibility: archives already written and downloaded must stay openable.
    const source = await createIntegrationFixture("arch1390-scrypt-old-source");
    const target = await createIntegrationFixture("arch1390-scrypt-old-target");
    const old = resealed(await exportFile(source, false), 1);
    expect(readV2Header(old).p).toBe(1);
    expect((await previewUpload(target, old)).status).toBe(200);
    const response = await importUpload(target, old);
    expect(response.status, JSON.stringify(await errorOf(response.clone()).catch(() => ({})))).toBe(200);
  }, 120_000);

  /**
   * Headers that pass the magic, version and size checks but would make scrypt
   * throw (memory over maxmem: 128 N r > 64 MiB) or run for minutes (p over its
   * cap). They are refused from the header, before any key derivation.
   */
  const crafted: Array<[string, { log2N: number; r: number; p: number }]> = [
    ["N=2^17, r=8 (128 MiB of memory)", { log2N: 17, r: 8, p: 1 }],
    ["N=2^20, r=1 (128 MiB of memory)", { log2N: 20, r: 1, p: 1 }],
    ["N=2^18, r=4 (128 MiB of memory)", { log2N: 18, r: 4, p: 1 }],
    ["N=2^14, r=8, p=255 (far above the cap on p)", { log2N: 14, r: 8, p: 255 }],
    // Exactly 64 MiB of memory for N and r alone: scrypt also needs room for p, so it throws at maxmem 64 MiB (second review, F2).
    ["N=2^16, r=8 (64 MiB for N and r, none left for p)", { log2N: 16, r: 8, p: 1 }],
    ["N=2^17, r=4 (64 MiB for N and r, none left for p)", { log2N: 17, r: 4, p: 1 }],
  ];

  it("a header at the top of what is allowed, N=2^15, r=8, p=5 (32 MiB), still previews and imports", async () => {
    // Pins that the memory bound is tightened to what scrypt accepts and no further.
    const source = await createIntegrationFixture("arch1390-scrypt-top-source");
    const target = await createIntegrationFixture("arch1390-scrypt-top-target");
    const base = await exportFile(source, false);
    const header = readV2Header(base);
    const top = sealV2(openV2(base, passphrase), passphrase, { manifestBytes: header.manifestBytes, header: { log2N: 15, r: 8, p: 5 } });
    expect((await previewUpload(target, top)).status).toBe(200);
    expect((await importUpload(target, top)).status).toBe(200);
  }, 120_000);

  it.each(crafted)("import of a header with %s answers 400 archive_invalid, not 500", async (_label, cost) => {
    // Catches a header check that lets the key derivation throw on a crafted file: a 500 for a client's mistake.
    const target = await createIntegrationFixture("arch1390-scrypt-crafted-import");
    const file = Buffer.concat([v2Header({ ...cost, manifestBytes: 32, plaintextBytes: 32 }), randomBytes(32 + 16)]);
    const response = await importUpload(target, file);
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe("archive_invalid");
  }, 120_000);

  it.each(crafted)("preview of a header with %s answers 400 archive_invalid, not 500", async (_label, cost) => {
    const target = await createIntegrationFixture("arch1390-scrypt-crafted-preview");
    const file = Buffer.concat([v2Header({ ...cost, manifestBytes: 32, plaintextBytes: 32 }), randomBytes(32 + 16)]);
    const response = await previewUpload(target, file);
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe("archive_invalid");
  }, 120_000);
});

/**
 * A real, openable PDF of exactly `size` bytes (the restore path re-checks each
 * document), as in portable-archive-v2.test.ts.
 */
function pdfOfSize(size: number, label: string): Buffer {
  let padding = Math.max(0, size - 800);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const pdf = syntheticPdf(`${label} ${"x".repeat(padding)}`);
    if (pdf.length === size) return pdf;
    padding += size - pdf.length;
  }
  throw new Error(`no PDF of ${size} bytes`);
}

/**
 * #1799 spec (issue note 56637), replacing ruling 6: the export's ceiling
 * follows what the household stores, so a backup can always be taken.
 */
describe("#1799: the export ceiling follows what the household stores", () => {
  /** A household whose stored documents (3 x 30 MiB) are over the 25 MiB quota AND over quota + 64 MiB, the quota lowered after they were stored. */
  async function overLoweredQuota(name: string): Promise<Fixture> {
    const fixture = await createIntegrationFixture(name);
    await seedStoredDocuments(fixture, [pdfOfSize(30 * MIB, `${name} a`), pdfOfSize(30 * MIB, `${name} b`), pdfOfSize(30 * MIB, `${name} c`)]);
    process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES = String(25 * MIB); // the smallest the configuration accepts
    resetDocumentConfigForTests();
    expect(getDocumentConfig().householdQuotaBytes).toBe(25 * MIB);
    return fixture;
  }

  it("exports documents that exceed the (lowered) quota and writes the file", async () => {
    // Catches the old refusal: archive_export_too_large for a household whose stored documents passed quota + 64 MiB.
    const fixture = await overLoweredQuota("arch1799-export-over-quota");
    const rowsBefore = await getDb().select({ id: portableArchives.id }).from(portableArchives).where(eq(portableArchives.householdId, fixture.household.id));

    const file = await exportFile(fixture);

    expect(file.length, "a file bigger than the lowered ceiling was written").toBeGreaterThan(limits_maxArchiveFileBytes());
    const manifest = manifestOf(file);
    expect(manifest.body).toHaveLength(3);
    expect(manifest.body.reduce((sum, entry) => sum + entry.sizeBytes, 0)).toBe(90 * MIB);
    expect(await getDb().select({ id: portableArchives.id }).from(portableArchives).where(eq(portableArchives.householdId, fixture.household.id)), "an archive row was added").toHaveLength(rowsBefore.length + 1);
  }, 300_000);

  it("restoring that archive here is still refused (upload and restore keep the quota)", async () => {
    // Catches the ceiling being lifted on the import side as well: the owner kept the limit for upload and restore.
    const source = await overLoweredQuota("arch1799-restore-source");
    const file = await exportFile(source);
    const target = await createIntegrationFixture("arch1799-restore-target");
    const idsOf = async () => (await getDb().select({ id: documents.id }).from(documents).where(eq(documents.householdId, target.household.id))).map((row) => row.id).sort();
    const before = await idsOf();

    const response = await importUpload(target, file);

    expect(response.status).toBe(413);
    const refusal = await errorOf(response);
    expect(refusal.code).toBe("archive_over_quota");
    expect(refusal.message).toMatch(/raise/iu);
    expect(refusal.message).toMatch(/storage limit/iu);
    expect(await idsOf(), "no document was restored").toEqual(before);
  }, 300_000);

  it("an export without documents is unaffected by a household over its quota", async () => {
    // Catches a ceiling raised (or a refusal made) for documents the export does not include.
    const fixture = await overLoweredQuota("arch1799-no-documents");
    const file = await exportFile(fixture, false);
    const manifest = manifestOf(file);
    expect(manifest.body).toEqual([]);
    expect(file.length).toBeLessThan(limits_maxArchiveFileBytes());
  }, 300_000);

  it("the manifest cap still refuses an export of documents over the quota", async () => {
    // Pins archive_manifest_too_large staying a refusal; the sizes are recorded, so nothing needs to be that big on disk.
    process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES = String(25 * MIB);
    resetDocumentConfigForTests();
    const fixture = await createIntegrationFixture("arch1799-manifest-cap");
    await seedStoredDocuments(fixture, [syntheticPdf("manifest cap")]);
    await getDb().update(documents).set({ sizeBytes: 95 * MIB }).where(eq(documents.householdId, fixture.household.id));
    limits.manifestCap = 1_000;
    const failure = await exportOf(fixture).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe("archive_manifest_too_large");
  }, 120_000);

  it("archive_export_too_large is gone from the export", async () => {
    // The refusal and its error (archiveTooLargeToImportError) are removed, not renamed.
    const source = await readFile(new URL("../../src/server/portable-archive-repository.ts", import.meta.url), "utf8");
    expect(source).not.toContain("archive_export_too_large");
    expect(source).not.toContain("archiveTooLargeToImportError");
  });
});

/** The file ceiling for the current (lowered) quota: what the old export refused above. */
function limits_maxArchiveFileBytes(): number {
  return maxArchiveFileBytes({ householdQuotaBytes: getDocumentConfig().householdQuotaBytes });
}

describe("ruling 7: the export's plaintext is zeroed after use", () => {
  /** Segment-sized buffers allocated while `work` runs: the writer's parked segment. */
  async function watchingParkedSegments<T>(work: () => Promise<T>): Promise<{ result: T | { failed: unknown }; parked: Buffer[] }> {
    const parked: Buffer[] = [];
    for (const name of ["alloc", "allocUnsafe", "allocUnsafeSlow"] as const) {
      const original = Buffer[name].bind(Buffer) as (size: number, ...rest: unknown[]) => Buffer;
      vi.spyOn(Buffer, name).mockImplementation(((size: number, ...rest: unknown[]) => {
        const made = original(size, ...rest);
        if (size === S) parked.push(made);
        return made;
      }) as never);
    }
    try {
      return { result: await work().catch((failed: unknown) => ({ failed })), parked };
    } finally {
      for (const name of ["alloc", "allocUnsafe", "allocUnsafeSlow"] as const) vi.mocked(Buffer[name]).mockRestore();
    }
  }

  /** The buffers handed to SegmentWriter.push, in order (the first is the manifest). */
  function watchingPushes() {
    const pushed: Uint8Array[] = [];
    const original = SegmentWriter.prototype.push;
    return {
      pushed,
      install(failOnCall?: number) {
        vi.spyOn(SegmentWriter.prototype, "push").mockImplementation(async function (this: SegmentWriter, plaintext: Uint8Array) {
          pushed.push(plaintext);
          const result = await original.call(this, plaintext);
          if (failOnCall !== undefined && pushed.length === failOnCall) throw new Error("the disk filled up (#1390 injected)");
          return result;
        });
      },
    };
  }

  it("after a successful export of a household with documents, the manifest buffer, every decrypted chunk and the parked segment are zero", async () => {
    // Catches plaintext left in memory after use: the manifest (the household's details), the decrypted documents, the last segment.
    const fixture = await createIntegrationFixture("arch1390-zero-success");
    await seedStoredDocuments(fixture, [syntheticPdf(`zero ${"z".repeat(200_000)}`), syntheticPdf(`zero two ${"q".repeat(50_000)}`)]);
    const pushes = watchingPushes();
    pushes.install();
    const { result, parked } = await watchingParkedSegments(() => exportOf(fixture));

    expect(result, "the export succeeds").not.toHaveProperty("failed");
    expect(spy.chunks.length, "the documents went through the wrapped document path").toBeGreaterThan(0);
    expect(pushes.pushed.length).toBeGreaterThan(1);
    expect(spy.chunks.every(isZero), "every decrypted document chunk is zeroed once used").toBe(true);
    expect(isZero(pushes.pushed[0]), "the manifest buffer is zeroed once written").toBe(true);
    expect(parked.length, "the writer parked at least one segment").toBeGreaterThan(0);
    expect(parked.every(isZero)).toBe(true);
  }, 120_000);

  it("when the manifest is refused as too large, the manifest buffer is zeroed before the refusal", async () => {
    // Catches the early return at the manifest cap (second review, R7): the household's plaintext details sat in memory after the refusal.
    const fixture = await createIntegrationFixture("arch1390-zero-manifest-too-large");
    limits.manifestCap = 1_000; // a real household's manifest is some KiB, so it is "too large" now
    const manifests: Buffer[] = [];
    const real = Buffer.from.bind(Buffer);
    vi.spyOn(Buffer, "from").mockImplementation(((...args: unknown[]) => {
      const made = (real as (...a: unknown[]) => Buffer)(...args);
      if (typeof args[0] === "string" && args[1] === "utf8" && made.length > 1_000) manifests.push(made);
      return made;
    }) as typeof Buffer.from);

    const failure = await exportOf(fixture).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe("archive_manifest_too_large");
    expect(manifests.length, "the manifest was made as a buffer").toBeGreaterThan(0);
    expect(manifests.every(isZero), "the manifest buffer is zeroed when the export refuses it").toBe(true);
  }, 120_000);

  it("when a document does not match its recorded size and the export fails, nothing it held is left: chunks, manifest and parked segment are zero", async () => {
    // Catches cleanup only on the happy path: the failure is where plaintext is most likely to linger.
    const fixture = await createIntegrationFixture("arch1390-zero-integrity");
    await seedStoredDocuments(fixture, [syntheticPdf(`zero fail ${"z".repeat(200_000)}`)]);
    await getDb().update(documents).set({ sizeBytes: 10 }).where(eq(documents.householdId, fixture.household.id));
    const pushes = watchingPushes();
    pushes.install();
    const { result, parked } = await watchingParkedSegments(() => exportOf(fixture));

    expect(result).toHaveProperty("failed");
    expect(spy.chunks.every(isZero), "any decrypted chunk that was refused is zeroed").toBe(true);
    expect(isZero(pushes.pushed[0]), "the manifest buffer is zeroed").toBe(true);
    expect(parked.length, "the writer parked at least one segment").toBeGreaterThan(0);
    expect(parked.every(isZero), "the parked segment held the manifest and is zeroed").toBe(true);
  }, 120_000);

  it("when SegmentWriter.push throws part-way (a full disk), the same buffers are zero", async () => {
    // The throw-in-push case: the writer parked bytes, the write failed, nothing may be left.
    const fixture = await createIntegrationFixture("arch1390-zero-push-throws");
    await seedStoredDocuments(fixture, [syntheticPdf(`zero push ${"z".repeat(200_000)}`)]);
    const pushes = watchingPushes();
    pushes.install(2); // the first document chunk is pushed and then the push throws
    const { result, parked } = await watchingParkedSegments(() => exportOf(fixture));

    expect(result).toMatchObject({ failed: expect.objectContaining({ message: expect.stringContaining("disk filled up") }) });
    expect(pushes.pushed.length).toBeGreaterThanOrEqual(2);
    expect(spy.chunks.every(isZero)).toBe(true);
    expect(isZero(pushes.pushed[0])).toBe(true);
    expect(parked.every(isZero), "the parked segment is zeroed when push throws").toBe(true);
  }, 120_000);
});

describe("ruling 8: the export reads one consistent snapshot", () => {
  /**
   * Starts an export, holds it at a table lock, lets `change` run in the
   * lock-holder's transaction once the export is waiting, then releases it.
   * Which statement waits depends on the implementation (today's separate
   * queries, or one transaction's sequence); either way the export has taken
   * a snapshot or read some tables before the change commits.
   */
  async function exportWhileChanging(fixture: Fixture, lockedTable: "items" | "documents", change: (transaction: Pick<ReturnType<typeof getDb>, "execute">) => Promise<void>) {
    const db = getDb();
    let exporting!: Promise<{ file: Buffer } | { failed: unknown }>;
    // The manifest is the first thing the export writes. It is copied as it is
    // pushed, because the export may go on to fail (its document was deleted)
    // and a refusal later must not hide an inconsistent manifest.
    const original = SegmentWriter.prototype.push;
    manifestPushed = undefined;
    vi.spyOn(SegmentWriter.prototype, "push").mockImplementation(async function (this: SegmentWriter, plaintext: Uint8Array) {
      manifestPushed ??= Buffer.from(plaintext);
      return original.call(this, plaintext);
    });
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`set local lock_timeout = '30s'`);
      await transaction.execute(sql.raw(`lock table ${lockedTable} in access exclusive mode`));
      exporting = exportFile(fixture).then((file) => ({ file }), (failed: unknown) => ({ failed }));
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting = await transaction.execute(sql`select 1 from pg_locks l join pg_class c on c.oid = l.relation where not l.granted and c.relname = ${lockedTable}`);
        if (waiting.length > 0) break;
        await realDelay(100);
      }
      await realDelay(500); // the export's other reads finish and wait or complete
      await change(transaction);
    });
    return exporting;
  }

  let manifestPushed: Buffer | undefined;

  function expectNoDocumentWithoutItem(outcome: { file: Buffer } | { failed: unknown }) {
    // Judged on the manifest the export wrote, whether or not it then finished.
    expect(manifestPushed, "the export got as far as writing its manifest").toBeDefined();
    const manifest = JSON.parse(manifestPushed!.toString("utf8")) as ReturnType<typeof manifestOf>;
    if ("failed" in outcome) expect(outcome.failed).toBeInstanceOf(AppError);
    const itemIds = new Set(manifest.items.map((item) => item.id));
    for (const document of manifest.documents) expect(itemIds.has(document.itemId ?? ""), `document ${document.id} ships with its item ${document.itemId}`).toBe(true);
    const documentIds = new Set(manifest.documents.map((document) => document.id));
    for (const entry of manifest.body) expect(documentIds.has(entry.id), "every body belongs to a listed document").toBe(true);
  }

  it("an item deleted while the export is reading never leaves a document whose item is missing from the archive", async () => {
    // Catches the export's separate, unsynchronised queries: items read after the delete, documents before it.
    const fixture = await createIntegrationFixture("arch1390-snapshot-item");
    await seedStoredDocuments(fixture, [syntheticPdf("snapshot item")]);
    const outcome = await exportWhileChanging(fixture, "items", async (transaction) => {
      await transaction.execute(sql`delete from items where id = ${fixture.item.id}`);
    });
    expectNoDocumentWithoutItem(outcome);
  }, 120_000);

  it("a document deleted while the export is reading never leaves a document whose item is missing, nor a body without its document", async () => {
    // Guards the other order of the same race; a snapshot that lists a document the store no longer has must fail cleanly or ship consistently.
    const fixture = await createIntegrationFixture("arch1390-snapshot-document");
    const [documentId] = await seedStoredDocuments(fixture, [syntheticPdf("snapshot document")]);
    const outcome = await exportWhileChanging(fixture, "documents", async (transaction) => {
      await transaction.execute(sql`delete from documents where id = ${documentId}`);
    });
    expectNoDocumentWithoutItem(outcome);
  }, 120_000);

  it("the same item deletion before the export starts gives an archive without the item and without its document (the rule is about consistency, not about keeping the item)", async () => {
    // Pins the plain case so a fix cannot satisfy the race tests by shipping stale rows.
    const fixture = await createIntegrationFixture("arch1390-snapshot-plain");
    await seedStoredDocuments(fixture, [syntheticPdf("snapshot plain")]);
    await getDb().delete(items).where(eq(items.id, fixture.item.id));
    const manifest = manifestOf(await exportFile(fixture));
    expect(manifest.items.map((item) => item.id)).not.toContain(fixture.item.id);
    expect(manifest.documents).toEqual([]);
    expect(manifest.body).toEqual([]);
  }, 120_000);
});
