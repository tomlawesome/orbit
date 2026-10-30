/**
 * Preview and import of a portable archive are streamed too (#1521), as the
 * export is (#1506, portable-archive-stream.test.ts). Specification: both
 * operations hold about one document plus fixed buffers, never the archive
 * several times over; a maximum-size archive must fit the 2 GiB default
 * without swap, with export's 247 MiB as the reference; the archive format
 * does not change, so an export imports into another household with identical
 * documents and metadata.
 *
 * The temporary-file and tamper-refusal rules are pinned in
 * src/server/portable-archive-import-stream.test.ts, which needs no database.
 * Here, with the real database and the real document store: nothing from a
 * tampered archive reaches either, and the memory bound.
 *
 * #1566 moved the round trip and the tamper refusal to the new wire: the
 * exported file, as written, is posted to the preview and import routes as
 * the last part of a multipart upload. The memory child now takes its
 * baseline before the file is read and streams it from disk, and a case with
 * one 50 MiB document is added.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { documents, items } from "@/db/schema";
import { readDocumentDownload } from "@/server/document-repository";
import { decryptPortableArchive } from "@/server/portable-archive";
import { createPortableArchive, readPortableArchive } from "@/server/portable-archive-repository";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { archiveForm } from "./support/portable-archive-upload";
import { errorOf, postForm, proofCookie } from "./support/portable-archive-routes";
import { loadRoute } from "./support/request-event";
import { seedStoredDocuments } from "./support/stored-documents";
import { syntheticPdf } from "../support/synthetic-documents";

const MIB = 1_048_576;
const passphrase = "correct-horse-battery-staple";

const { POST: previewRoute } = await loadRoute("portable-archives/preview");
const { POST: importRoute } = await loadRoute("portable-archives/import");

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;

/** The exported archive file, byte for byte as the download gives it. */
async function exportFile(fixture: Fixture, includeDocuments: boolean): Promise<Buffer> {
  const archive = await createPortableArchive({
    userId: fixture.users.owner.id,
    householdId: fixture.household.id,
    passphrase,
    includeDocuments,
  });
  const { bytes } = await readPortableArchive(fixture.users.owner.id, archive.id);
  return Buffer.from(bytes);
}

async function exportParsed(fixture: Fixture, includeDocuments: boolean) {
  return JSON.parse((await exportFile(fixture, includeDocuments)).toString("utf8")) as { ciphertext: string; authTag: string };
}

/** Preview, as the owner's browser posts it. */
async function previewUpload(fixture: Fixture, file: Buffer | object) {
  const owner = await fixture.session("owner");
  return postForm(previewRoute, "/api/portable-archives/preview", owner, archiveForm({ householdId: fixture.household.id, passphrase }, file));
}

/** Import, as the owner's browser posts it, with a fresh proof that it is them. */
async function importUpload(fixture: Fixture, file: Buffer | object) {
  const owner = await fixture.session("owner");
  return postForm(
    importRoute,
    "/api/portable-archives/import",
    owner,
    archiveForm({ householdId: fixture.household.id, passphrase, conflictItemIds: [] }, file),
    await proofCookie(owner, "archive_import"),
  );
}

type Payload = {
  sections: Array<Record<string, unknown>>;
  items: Array<Record<string, unknown>>;
  documents: Array<Record<string, unknown>>;
  documentBytes: Array<{ id: string; contentBase64: string }>;
};

async function exportedPayload(fixture: Fixture): Promise<Payload> {
  const archive = await exportParsed(fixture, true);
  return JSON.parse(decryptPortableArchive(archive as never, passphrase).toString("utf8")) as Payload;
}

/**
 * A real, openable PDF of exactly `size` bytes. The import restores each
 * document through the ordinary upload path, which refuses bytes that are not
 * a PDF, JPEG or PNG, so random bytes will not do. The page text is padded.
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

/** Every file under the document root, so a refused import can be shown to have added none. */
async function storedFiles(): Promise<string[]> {
  return (await readdir(process.env.DOCUMENTS_ROOT!, { recursive: true })).sort();
}

// Sizes that straddle the 3-byte base64 groups and the 196,608-byte pieces an export writes.
const documentSizes = [1_001, 1_002, 1_003, 65_536, 196_607, 196_608, 196_609, MIB + 17, 3 * MIB - 1];

describe("an export imports into another household with identical documents and metadata (#1521, format unchanged)", () => {
  it("restores every document's bytes, name, type and size, and every item and section field", async () => {
    const source = await createIntegrationFixture("arch1521-roundtrip-source");
    const target = await createIntegrationFixture("arch1521-roundtrip-target");
    const contents = documentSizes.map((size, index) => pdfOfSize(size, `round trip ${index}`));
    await seedStoredDocuments(source, contents);
    // The target is exported too, and the fixture's own placeholder document has
    // a row but no stored file, which would stop that export.
    await getDb().delete(documents).where(eq(documents.id, target.document.id));

    const file = await exportFile(source, true);
    const previewed = await previewUpload(target, file);
    expect(previewed.status, JSON.stringify(await errorOf(previewed).catch(() => ({})))).toBe(200);
    expect(((await previewed.json()) as { preview: unknown }).preview)
      .toMatchObject({ documents: contents.length, sections: expect.any(Number), items: 1, documentsExcluded: false });

    const imported = await importUpload(target, file);
    expect(imported.status, JSON.stringify(await errorOf(imported).catch(() => ({})))).toBe(200);
    expect(await imported.json()).toEqual({ importedItems: 1, documentsExcluded: 0 });

    const before = await exportedPayload(source);
    const after = await exportedPayload(target);

    // Metadata: the imported item and its section carry the same fields (ids are new).
    const sourceItem = before.items.find((item) => item.id === source.item.id)!;
    const importedItem = after.items.find((item) => item.title === sourceItem.title);
    expect(importedItem, "the item came across").toBeDefined();
    for (const field of ["title", "subtype", "provider", "reference", "costMinor", "currency", "startDate", "expiryDate", "renewalDate", "serviceDate", "recurrenceMonths", "snoozedUntil", "notes", "externalDocumentUrl", "status"]) {
      expect(importedItem![field] ?? null, field).toEqual(sourceItem[field] ?? null);
    }
    const sourceSection = before.sections.find((section) => section.id === sourceItem.sectionId)!;
    const importedSection = after.sections.find((section) => section.id === importedItem!.sectionId)!;
    for (const field of ["slug", "name", "icon", "accent", "position", "visible", "archivedAt"]) {
      expect(importedSection[field] ?? null, field).toEqual(sourceSection[field] ?? null);
    }

    // Documents: same names, types and sizes, and byte-identical content.
    const importedDocuments = after.documents.filter((document) => document.itemId === importedItem!.id);
    expect(importedDocuments).toHaveLength(contents.length);
    for (const [index, content] of contents.entries()) {
      const wanted = before.documents.find((document) => document.displayName === `stored-${index}.pdf`)!;
      const got = importedDocuments.find((document) => document.displayName === `stored-${index}.pdf`);
      expect(got, `stored-${index}.pdf came across`).toBeDefined();
      for (const field of ["mediaType", "sizeBytes", "contentSha256", "lifecycle"]) {
        if (field in wanted) expect(got![field], field).toEqual(wanted[field]);
      }
      const downloaded = await readDocumentDownload(target.users.owner.id, got!.id as string);
      expect(downloaded.bytes.length).toBe(content.length);
      expect(createHash("sha256").update(downloaded.bytes).digest("hex")).toBe(createHash("sha256").update(content).digest("hex"));
      expect(downloaded.bytes.equals(content)).toBe(true);
      const carried = after.documentBytes.find((entry) => entry.id === got!.id);
      expect(Buffer.from(carried!.contentBase64, "base64").equals(content)).toBe(true);
    }
  }, 300_000);
});

describe("a tampered archive reaches neither the database nor the document store (#1521)", () => {
  it("refuses a changed ciphertext character and a truncated tag, leaving the household and the stored files as they were", async () => {
    const source = await createIntegrationFixture("arch1521-tamper-source");
    const target = await createIntegrationFixture("arch1521-tamper-target");
    await seedStoredDocuments(source, [pdfOfSize(2 * MIB + 5, "a"), pdfOfSize(MIB + 1, "b"), pdfOfSize(70_001, "c")]);
    const archive = await exportParsed(source, true);

    // Control: the untouched archive is acceptable, so the refusals below come from the change.
    expect((await previewUpload(target, archive)).status).toBe(200);

    const position = 64;
    const flipped = { ...archive, ciphertext: archive.ciphertext.slice(0, position) + (archive.ciphertext[position] === "A" ? "B" : "A") + archive.ciphertext.slice(position + 1) };
    const truncated = { ...archive, authTag: Buffer.from(archive.authTag, "base64url").subarray(0, 8).toString("base64url") };

    const filesBefore = await storedFiles();
    const documentsBefore = (await getDb().select({ id: documents.id }).from(documents).where(eq(documents.householdId, target.household.id))).length;

    for (const tampered of [flipped, truncated]) {
      const previewed = await previewUpload(target, tampered);
      expect(previewed.status).toBe(422);
      expect((await errorOf(previewed)).code).toBe("archive_passphrase_invalid");
      const imported = await importUpload(target, tampered);
      expect(imported.status).toBe(422);
      expect((await errorOf(imported)).code).toBe("archive_passphrase_invalid");
    }

    expect(await getDb().select({ id: items.id }).from(items).where(eq(items.householdId, target.household.id)))
      .toEqual([{ id: target.item.id }]);
    expect((await getDb().select({ id: documents.id }).from(documents).where(eq(documents.householdId, target.household.id))).length)
      .toBe(documentsBefore);
    expect(await storedFiles(), "no document was written to the store").toEqual(filesBefore);
  }, 300_000);
});

// ---------------------------------------------------------------------------

type Measured = { beforeKiB: number; afterKiB: number; result: Record<string, unknown> };

/** Runs one preview or import in a child process and reads back its peak-memory growth. */
async function measure(mode: "preview" | "import", fixture: Fixture, archiveFile: string): Promise<Measured> {
  const tsx = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const child = fileURLToPath(new URL("./support/archive-import-memory-child.ts", import.meta.url));
  const run = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const proc = spawn(process.execPath, [tsx, child, mode, fixture.users.owner.id, fixture.household.id, archiveFile], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  expect(run.code, run.stderr).toBe(0);
  const line = run.stdout.split("\n").find((candidate) => candidate.startsWith("MEMORY_RESULT "));
  expect(line, `child output: ${run.stdout}\n${run.stderr}`).toBeDefined();
  return JSON.parse(line!.slice("MEMORY_RESULT ".length)) as Measured;
}

function expectGrowthBelow(measured: Measured, boundKiB: number, what: string, boundName: string) {
  const growthKiB = measured.afterKiB - measured.beforeKiB;
  expect(
    growthKiB,
    `${what}: peak RSS grew ${(growthKiB / 1024).toFixed(0)} MiB; bound is ${(boundKiB / 1024).toFixed(0)} MiB (${boundName})`,
  ).toBeLessThan(boundKiB);
}

describe("preview and import hold about one document in memory, not the archive (#1521)", () => {
  // The same shape as the export's test (#1506): 12 x 10 MiB, more than
  // 100 MiB of documents, and the same bound -- the archive's plaintext size.
  // #1566: the child's baseline now comes before the file is read, so the
  // bound covers the request body too (it did not before, note 46283).
  const documentBytes = 10 * MIB;
  const documentCount = 12;
  const plaintextKiB = (Math.ceil(documentBytes / 3) * 4 * documentCount) / 1024;
  let source: Fixture;
  let scratch: string;
  let archiveFile: string;

  beforeAll(async () => {
    source = await createIntegrationFixture("arch1521-memory-source");
    for (let index = 0; index < documentCount; index += 1) {
      await seedStoredDocuments(source, [pdfOfSize(documentBytes, `memory ${index}`)]);
    }
    scratch = await mkdtemp(join(tmpdir(), "orbit-1521-memory-"));
    archiveFile = join(scratch, "archive.json");
    await writeFile(archiveFile, await exportFile(source, true), { mode: 0o600 });
  }, 600_000);

  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("raises the previewing process's peak memory by less than the archive's plaintext size", async () => {
    const target = await createIntegrationFixture("arch1521-memory-preview");
    const measured = await measure("preview", target, archiveFile);
    expect(measured.result).toMatchObject({ documents: documentCount, items: 1, documentsExcluded: false });
    expectGrowthBelow(measured, plaintextKiB, "preview", "the archive's plaintext");
  }, 600_000);

  it("raises the importing process's peak memory by less than the archive's plaintext size, and restores every document", async () => {
    const target = await createIntegrationFixture("arch1521-memory-import");
    const measured = await measure("import", target, archiveFile);
    expect(measured.result).toEqual({ importedItems: 1, documentsExcluded: 0 });
    const restored = await getDb().select({ displayName: documents.displayName, sizeBytes: documents.sizeBytes }).from(documents)
      .where(eq(documents.householdId, target.household.id));
    expect(restored.filter((row) => row.displayName.startsWith("stored-"))).toHaveLength(documentCount);
    expect(restored.filter((row) => row.displayName.startsWith("stored-")).every((row) => row.sizeBytes === documentBytes)).toBe(true);
    expectGrowthBelow(measured, plaintextKiB, "import", "the archive's plaintext");
  }, 600_000);
});

describe("one large document: the upload is never held whole (#1566)", () => {
  // Note 46292: one 50 MiB document. Preview must grow by less than the
  // archive FILE's size (about 89 MiB with this one document): holding the
  // body even once breaks it. Import must grow by less than eight times the
  // document's bytes (400 MiB), the allowance for the per-document copies of
  // the ordinary upload path; this bound drops to the archive's plaintext
  // when #1567 (document path holds each document whole) lands.
  const documentBytes = 50 * MIB;
  let source: Fixture;
  let content: Buffer;
  let scratch: string;
  let archiveFile: string;
  let archiveFileKiB: number;

  beforeAll(async () => {
    source = await createIntegrationFixture("arch1566-large-source");
    content = pdfOfSize(documentBytes, "large single document");
    await seedStoredDocuments(source, [content]);
    scratch = await mkdtemp(join(tmpdir(), "orbit-1566-memory-"));
    archiveFile = join(scratch, "archive.json");
    await writeFile(archiveFile, await exportFile(source, true), { mode: 0o600 });
    archiveFileKiB = (await stat(archiveFile)).size / 1024;
  }, 600_000);

  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("raises the previewing process's peak memory by less than the archive file's size", async () => {
    const target = await createIntegrationFixture("arch1566-large-preview");
    const measured = await measure("preview", target, archiveFile);
    expect(measured.result).toMatchObject({ documents: 1, items: 1, documentsExcluded: false });
    expectGrowthBelow(measured, archiveFileKiB, "preview", "the archive file's size");
  }, 600_000);

  it("raises the importing process's peak memory by less than eight times the document, and the document round-trips byte for byte", async () => {
    const target = await createIntegrationFixture("arch1566-large-import");
    const measured = await measure("import", target, archiveFile);
    expect(measured.result).toEqual({ importedItems: 1, documentsExcluded: 0 });
    expectGrowthBelow(measured, (8 * documentBytes) / 1024, "import", "eight times the document, until #1567");

    const restored = (await getDb().select({ id: documents.id, displayName: documents.displayName, sizeBytes: documents.sizeBytes }).from(documents)
      .where(eq(documents.householdId, target.household.id))).find((row) => row.displayName === "stored-0.pdf")!;
    expect(restored, "the document came across").toBeDefined();
    expect(restored.sizeBytes).toBe(documentBytes);
    const downloaded = await readDocumentDownload(target.users.owner.id, restored.id);
    expect(downloaded.bytes.length).toBe(content.length);
    expect(downloaded.bytes.equals(content)).toBe(true);
  }, 600_000);
});
