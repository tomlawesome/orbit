/**
 * #1390 (design note §4 lines 19, 20 and the memory half of 30): format v2
 * holds a bounded amount of memory whatever the document count, and never
 * writes the scratch directory; v1 keeps the bound pinned today.
 *
 * Each figure comes from a child process (the existing export and import
 * memory children, through tsx), so the test runner's memory never counts.
 * ORBIT_ARCHIVE_SCRATCH_DIR is pointed at a fresh directory the children
 * inherit, and that directory is watched.
 */
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { documents, portableArchives } from "@/db/schema";
import * as repository from "@/server/portable-archive-repository";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";
import { seedStoredDocuments } from "./support/stored-documents";
import { sealedArchiveFile } from "../support/sealed-archive";
import { syntheticPdf } from "../support/synthetic-documents";
import { sha256 } from "../support/portable-archive-v2";

const MIB = 1_048_576;
const DOCUMENT_BYTES = 10 * MIB;
const passphrase = "correct-horse-battery-staple";
type Fixture = IntegrationFixture;
type Measured = { beforeKiB: number; afterKiB: number; result?: Record<string, unknown>; archiveId?: string };

let scratch: string;
let scratchWatcher: FSWatcher | undefined;
let scratchEvents: string[] = [];
const savedScratch = process.env.ORBIT_ARCHIVE_SCRATCH_DIR;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "orbit-1390-scratch-"));
  process.env.ORBIT_ARCHIVE_SCRATCH_DIR = scratch;
  scratchEvents = [];
  scratchWatcher = watch(scratch, (event, name) => { scratchEvents.push(`${event}:${String(name)}`); });
});

afterEach(async () => {
  scratchWatcher?.close();
  if (savedScratch === undefined) delete process.env.ORBIT_ARCHIVE_SCRATCH_DIR;
  else process.env.ORBIT_ARCHIVE_SCRATCH_DIR = savedScratch;
  await rm(scratch, { recursive: true, force: true });
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

function pdfOfSize(size: number, label: string): Buffer {
  let padding = Math.max(0, size - 800);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const pdf = syntheticPdf(`${label} ${"x".repeat(padding)}`);
    if (pdf.length === size) return pdf;
    padding += size - pdf.length;
  }
  throw new Error(`no PDF of ${size} bytes`);
}

async function runChild(script: string, args: string[]): Promise<Measured> {
  const tsx = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const child = fileURLToPath(new URL(`./support/${script}`, import.meta.url));
  const run = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const proc = spawn(process.execPath, [tsx, child, ...args], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
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

const growthMiB = (measured: Measured) => (measured.afterKiB - measured.beforeKiB) / 1024;

async function householdWith(name: string, count: number): Promise<Fixture> {
  const fixture = await createIntegrationFixture(name);
  for (let index = 0; index < count; index += 1) await seedStoredDocuments(fixture, [pdfOfSize(DOCUMENT_BYTES, `${name} ${index}`)]);
  return fixture;
}

async function exportToFile(fixture: Fixture): Promise<string> {
  const archive = await repository.createPortableArchive({ userId: fixture.users.owner.id, householdId: fixture.household.id, passphrase, includeDocuments: true });
  const file = Buffer.from((await repository.readPortableArchive(fixture.users.owner.id, archive.id)).bytes);
  expect(file.subarray(0, 8).toString("latin1"), "the export writes format v2").toBe("ORBITARC");
  const path = join(await mkdtemp(join(tmpdir(), "orbit-1390-archive-")), "archive.orbit");
  await writeFile(path, file, { mode: 0o600 });
  return path;
}

async function expectScratchUntouched(): Promise<void> {
  expect(await readdir(scratch), "nothing is left in the scratch directory").toEqual([]);
  expect(scratchEvents, "v2 never creates a file in the scratch directory").toEqual([]);
}

describe("§4 line 19: the export's memory does not grow with the document count", () => {
  it("grows by under 64 MiB at 12 x 10 MiB and at 24 x 10 MiB, and the two growths differ by under 16 MiB", async () => {
    // Catches anything held per document (an index, a buffer list, base64 of each body) that the old plaintext-size bound let through.
    const growths: number[] = [];
    for (const count of [12, 24]) {
      const fixture = await householdWith(`arch1390-export-memory-${count}`, count);
      const measured = await runChild("archive-export-memory-child.ts", [fixture.users.owner.id, fixture.household.id]);
      const [row] = await getDb().select({ sizeBytes: portableArchives.sizeBytes }).from(portableArchives).where(eq(portableArchives.id, measured.archiveId!));
      expect(row.sizeBytes, "the archive holds every document").toBeGreaterThan(count * DOCUMENT_BYTES);
      growths.push(growthMiB(measured));
      expect(growthMiB(measured), `export of ${count} documents grew ${growthMiB(measured).toFixed(1)} MiB`).toBeLessThan(64);
    }
    expect(Math.abs(growths[1] - growths[0]), `growths ${growths.map((g) => g.toFixed(1)).join(" and ")} MiB`).toBeLessThan(16);
  }, 1_200_000);
});

describe("§4 line 20: v2 preview and import keep the per-document bound and never touch the scratch directory", () => {
  // The bound pinned today for 10 MiB documents (#1607): 104 MiB.
  const perDocumentBoundMiB = 104;

  for (const count of [12, 24]) {
    it(`at ${count} documents: preview and import each grow by under 104 MiB, every document is restored, and the scratch directory stays empty`, async () => {
      // Catches v2 still parking the plaintext in the scratch file, or a reader whose memory follows the count.
      const source = await householdWith(`arch1390-import-memory-source-${count}`, count);
      const archiveFile = await exportToFile(source);
      const previewTarget = await createIntegrationFixture(`arch1390-preview-memory-${count}`);
      const importTarget = await createIntegrationFixture(`arch1390-import-memory-${count}`);

      const preview = await runChild("archive-import-memory-child.ts", ["preview", previewTarget.users.owner.id, previewTarget.household.id, archiveFile]);
      expect(preview.result).toMatchObject({ documents: count, items: 1, documentsExcluded: false });
      expect(growthMiB(preview), `preview grew ${growthMiB(preview).toFixed(1)} MiB`).toBeLessThan(perDocumentBoundMiB);

      const imported = await runChild("archive-import-memory-child.ts", ["import", importTarget.users.owner.id, importTarget.household.id, archiveFile]);
      expect(imported.result).toEqual({ importedItems: 1, documentsExcluded: 0 });
      expect(growthMiB(imported), `import grew ${growthMiB(imported).toFixed(1)} MiB`).toBeLessThan(perDocumentBoundMiB);
      const restored = await getDb().select({ displayName: documents.displayName, sizeBytes: documents.sizeBytes }).from(documents).where(eq(documents.householdId, importTarget.household.id));
      expect(restored.filter((row) => row.displayName.startsWith("stored-") && row.sizeBytes === DOCUMENT_BYTES)).toHaveLength(count);

      await expectScratchUntouched();
    }, 1_200_000);
  }
});

describe("§4 line 30 (memory): a v1 archive keeps the bound pinned today", () => {
  it("imports a 12 x 10 MiB v1 archive growing by under 104 MiB, and leaves no scratch file behind", async () => {
    // Pins existing behaviour (#1607's bound for v1); catches the v1 path regressing while v2 is added beside it.
    const count = 12;
    const sectionId = randomUUID();
    const itemId = randomUUID();
    const bodies = Array.from({ length: count }, (_, index) => ({ id: randomUUID(), bytes: pdfOfSize(DOCUMENT_BYTES, `v1 memory ${index} ${randomBytes(4).toString("hex")}`) }));
    const payload = {
      format: "orbit-portable-archive", version: 1, exportedAt: new Date().toISOString(),
      household: { name: "v1 memory household" },
      sections: [{ id: sectionId, slug: `v1-${sectionId.slice(0, 8)}`, name: "Section", icon: "home", accent: "blue", position: 0, visible: true }],
      items: [{ id: itemId, sectionId, title: "v1 memory item", currency: "GBP", status: "active" }],
      dueEvents: [], reminderRules: [],
      documents: bodies.map((body, index) => ({ id: body.id, itemId, displayName: `stored-${index}.pdf`, mediaType: "application/pdf", sizeBytes: body.bytes.length, contentSha256: sha256(body.bytes), lifecycle: "available" })),
      documentBytes: bodies.map((body) => ({ id: body.id, contentBase64: body.bytes.toString("base64") })),
    };
    const file = await sealedArchiveFile(Buffer.from(JSON.stringify(payload)), passphrase);
    const archiveFile = join(await mkdtemp(join(tmpdir(), "orbit-1390-v1-")), "archive.json");
    await writeFile(archiveFile, file, { mode: 0o600 });
    const target = await createIntegrationFixture("arch1390-v1-memory");

    const imported = await runChild("archive-import-memory-child.ts", ["import", target.users.owner.id, target.household.id, archiveFile]);
    expect(imported.result).toEqual({ importedItems: 1, documentsExcluded: 0 });
    expect(growthMiB(imported), `v1 import grew ${growthMiB(imported).toFixed(1)} MiB`).toBeLessThan(104);
    expect(await readdir(scratch), "the v1 payload file is removed after the import").toEqual([]);
  }, 1_200_000);
});
