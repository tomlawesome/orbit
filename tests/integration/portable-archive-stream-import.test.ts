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
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { documents, items } from "@/db/schema";
import { readDocumentDownload } from "@/server/document-repository";
import { decryptPortableArchive } from "@/server/portable-archive";
import { createPortableArchive, importPortableArchive, previewPortableImport, readPortableArchive } from "@/server/portable-archive-repository";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { seedStoredDocuments } from "./support/stored-documents";
import { syntheticPdf } from "../support/synthetic-documents";

const MIB = 1_048_576;
const passphrase = "correct-horse-battery-staple";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;

async function exportParsed(fixture: Fixture, includeDocuments: boolean) {
  const archive = await createPortableArchive({
    userId: fixture.users.owner.id,
    householdId: fixture.household.id,
    passphrase,
    includeDocuments,
  });
  const { bytes } = await readPortableArchive(fixture.users.owner.id, archive.id);
  return JSON.parse(bytes.toString("utf8")) as { ciphertext: string; authTag: string };
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

    const archive = await exportParsed(source, true);
    const preview = await previewPortableImport(target.users.owner.id, target.household.id, archive, passphrase);
    expect(preview).toMatchObject({ documents: contents.length, sections: expect.any(Number), items: 1, documentsExcluded: false });

    const outcome = await importPortableArchive({
      userId: target.users.owner.id,
      householdId: target.household.id,
      archive,
      passphrase,
      conflictItemIds: [],
    });
    expect(outcome).toEqual({ importedItems: 1, documentsExcluded: 0 });

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
    await expect(previewPortableImport(target.users.owner.id, target.household.id, archive, passphrase)).resolves.toBeDefined();

    const position = 64;
    const flipped = { ...archive, ciphertext: archive.ciphertext.slice(0, position) + (archive.ciphertext[position] === "A" ? "B" : "A") + archive.ciphertext.slice(position + 1) };
    const truncated = { ...archive, authTag: Buffer.from(archive.authTag, "base64url").subarray(0, 8).toString("base64url") };

    const filesBefore = await storedFiles();
    const documentsBefore = (await getDb().select({ id: documents.id }).from(documents).where(eq(documents.householdId, target.household.id))).length;

    for (const tampered of [flipped, truncated]) {
      await expect(previewPortableImport(target.users.owner.id, target.household.id, tampered, passphrase))
        .rejects.toMatchObject({ code: "archive_passphrase_invalid", status: 422 });
      await expect(importPortableArchive({ userId: target.users.owner.id, householdId: target.household.id, archive: tampered, passphrase, conflictItemIds: [] }))
        .rejects.toMatchObject({ code: "archive_passphrase_invalid", status: 422 });
    }

    expect(await getDb().select({ id: items.id }).from(items).where(eq(items.householdId, target.household.id)))
      .toEqual([{ id: target.item.id }]);
    expect((await getDb().select({ id: documents.id }).from(documents).where(eq(documents.householdId, target.household.id))).length)
      .toBe(documentsBefore);
    expect(await storedFiles(), "no document was written to the store").toEqual(filesBefore);
  }, 300_000);
});

// ---------------------------------------------------------------------------

describe("preview and import hold about one document in memory, not the archive (#1521)", () => {
  // The same shape as the export's test (#1506): 12 x 10 MiB, more than
  // 100 MiB of documents, and the same bound -- the archive's plaintext size.
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
    const archive = await exportParsed(source, true);
    scratch = await mkdtemp(join(tmpdir(), "orbit-1521-memory-"));
    archiveFile = join(scratch, "archive.json");
    await writeFile(archiveFile, JSON.stringify(archive), { mode: 0o600 });
  }, 600_000);

  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  async function measure(mode: "preview" | "import", fixture: Fixture) {
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
    return JSON.parse(line!.slice("MEMORY_RESULT ".length)) as { beforeKiB: number; afterKiB: number; result: Record<string, unknown> };
  }

  function expectBounded(measured: { beforeKiB: number; afterKiB: number }, what: string) {
    const growthKiB = measured.afterKiB - measured.beforeKiB;
    expect(
      growthKiB,
      `${what}: peak RSS grew ${(growthKiB / 1024).toFixed(0)} MiB; bound is ${(plaintextKiB / 1024).toFixed(0)} MiB (the archive's plaintext)`,
    ).toBeLessThan(plaintextKiB);
  }

  it("raises the previewing process's peak memory by less than the archive's plaintext size", async () => {
    const target = await createIntegrationFixture("arch1521-memory-preview");
    const measured = await measure("preview", target);
    expect(measured.result).toMatchObject({ documents: documentCount, items: 1, documentsExcluded: false });
    expectBounded(measured, "preview");
  }, 600_000);

  it("raises the importing process's peak memory by less than the archive's plaintext size, and restores every document", async () => {
    const target = await createIntegrationFixture("arch1521-memory-import");
    const measured = await measure("import", target);
    expect(measured.result).toEqual({ importedItems: 1, documentsExcluded: 0 });
    const restored = await getDb().select({ displayName: documents.displayName, sizeBytes: documents.sizeBytes }).from(documents)
      .where(eq(documents.householdId, target.household.id));
    expect(restored.filter((row) => row.displayName.startsWith("stored-"))).toHaveLength(documentCount);
    expect(restored.filter((row) => row.displayName.startsWith("stored-")).every((row) => row.sizeBytes === documentBytes)).toBe(true);
    expectBounded(measured, "import");
  }, 600_000);
});
