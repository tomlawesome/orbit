/**
 * #1390 (design note §4 lines 21, 23, 24, 25 and the heartbeat half of 26;
 * ADR-0045 "stage then switch"): a v2 import stages every document unbound
 * (item_id null, sealed_item_id = an id generated up front), and only one
 * closing transaction creates the sections and items, binds the staged rows
 * and finishes the import row. Written from the specification alone, before
 * the build.
 *
 * The document path is wrapped (not replaced) so a test can act between two
 * documents, and the scanner is mocked as the document suites do. Archives
 * come from the product's own export of a source household: the first check
 * in each test is that the export is v2.
 */
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, documents, documentStagingObjects, items, portableArchiveImports, sections } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { runDocumentMaintenanceCycle } from "@/server/document-worker";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import * as repository from "@/server/portable-archive-repository";
import { requireHouseholdAccess } from "@/server/workspace-access";
import { cleanupIntegrationEnvironment, createIntegrationFixture, withRequiredScanMode, type IntegrationFixture } from "./support/fixtures";
import { archiveForm } from "./support/portable-archive-upload";
import { errorOf, postForm, proofCookie } from "./support/portable-archive-routes";
import { loadRoute } from "./support/request-event";
import { seedStoredDocuments } from "./support/stored-documents";
import { syntheticPdf } from "../support/synthetic-documents";

/** Runs after each document upload resolves (index counts from 0); may throw to fail that document. */
const hooks = vi.hoisted(() => ({
  afterUpload: null as null | ((index: number, result: unknown) => Promise<void>),
  beforeUpload: null as null | ((index: number) => Promise<void>),
  count: 0,
}));

vi.mock("@/server/document-repository", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/document-repository")>();
  return {
    ...original,
    uploadItemDocument: async (...args: Parameters<typeof original.uploadItemDocument>) => {
      const index = hooks.count++;
      await hooks.beforeUpload?.(index);
      const result = await original.uploadItemDocument(...args);
      await hooks.afterUpload?.(index, result);
      return result;
    },
  };
});

vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(),
}));

const passphrase = "correct-horse-battery-staple";
const { POST: importRoute } = await loadRoute("portable-archives/import");

beforeEach(() => {
  hooks.afterUpload = null;
  hooks.beforeUpload = null;
  hooks.count = 0;
  vi.mocked(scanFileWithClamAv).mockReset();
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

type Fixture = IntegrationFixture;

/** A v2 export of a fresh source household holding `count` documents; the target household starts with no documents. */
async function archiveWith(name: string, count: number): Promise<{ source: Fixture; target: Fixture; file: Buffer }> {
  const source = await createIntegrationFixture(`${name}-source`);
  const target = await createIntegrationFixture(`${name}-target`);
  await seedStoredDocuments(source, Array.from({ length: count }, (_, index) => syntheticPdf(`${name} document ${index} ${"y".repeat(2_000)}`)));
  await getDb().delete(documents).where(eq(documents.householdId, target.household.id));
  const archive = await repository.createPortableArchive({ userId: source.users.owner.id, householdId: source.household.id, passphrase, includeDocuments: true });
  const file = Buffer.from((await repository.readPortableArchive(source.users.owner.id, archive.id)).bytes);
  expect(file.subarray(0, 8).toString("latin1"), "the export writes format v2 (§4 line 14)").toBe("ORBITARC");
  return { source, target, file };
}

async function importThroughRoute(target: Fixture, file: Buffer) {
  const owner = await target.session("owner");
  return postForm(importRoute, "/api/portable-archives/import", owner,
    archiveForm({ householdId: target.household.id, passphrase, conflictItemIds: [] }, file), await proofCookie(owner, "archive_import"));
}

const itemIds = async (householdId: string) =>
  (await getDb().select({ id: items.id }).from(items).where(eq(items.householdId, householdId))).map((row) => row.id).sort();
const sectionIds = async (householdId: string) =>
  (await getDb().select({ id: sections.id }).from(sections).where(eq(sections.householdId, householdId))).map((row) => row.id).sort();
const importRows = (householdId: string) => getDb().select().from(portableArchiveImports).where(eq(portableArchiveImports.householdId, householdId));
const documentRows = (householdId: string) =>
  getDb().select({ id: documents.id, itemId: documents.itemId, sealedItemId: documents.sealedItemId }).from(documents).where(eq(documents.householdId, householdId));
/** Every staging object, by storage key: the household's own through its document, and any whose document is gone. */
const stagingKeys = async () =>
  (await getDb().select({ storageKey: documentStagingObjects.storageKey }).from(documentStagingObjects)).map((row) => row.storageKey).sort();
const stagingRowsOf = (householdId: string) =>
  getDb().select({ id: documentStagingObjects.documentId }).from(documentStagingObjects)
    .innerJoin(documents, eq(documents.id, documentStagingObjects.documentId)).where(eq(documents.householdId, householdId));
/** Every file in the document store (objects/ and staging/); files only, since a deleted blob leaves its empty shard folder. */
async function storedFiles(): Promise<string[]> {
  const entries = await readdir(process.env.DOCUMENTS_ROOT!, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).sort();
}

/** A plpgsql trigger that raises, dropped by the returned function. */
async function failingTrigger(table: string, timing: string, when: string): Promise<() => Promise<void>> {
  const suffix = randomUUID().replaceAll("-", "");
  const fn = `fail_1390_${suffix}`;
  const trigger = `fail_1390_trg_${suffix}`;
  await getDb().execute(sql.raw(`create function ${fn}() returns trigger language plpgsql as $$ begin raise exception 'simulated failure (#1390)'; end $$`));
  await getDb().execute(sql.raw(`create trigger ${trigger} ${timing} on ${table} for each row when (${when}) execute function ${fn}()`));
  return async () => {
    await getDb().execute(sql.raw(`drop trigger if exists ${trigger} on ${table}`));
    await getDb().execute(sql.raw(`drop function if exists ${fn}()`));
  };
}

// ---------------------------------------------------------------------------

describe("§4 line 21: items and sections exist only after the switch", () => {
  it("between documents, items and sections are unchanged and the staged rows are unbound with sealed_item_id set; after it, every row is bound and the import row finished", async () => {
    // Catches the old order (items created first, documents attached one by one): members would see half an import.
    const { target, file } = await archiveWith("arch1390-switch", 3);
    const itemsBefore = await itemIds(target.household.id);
    const sectionsBefore = await sectionIds(target.household.id);
    const observed: Array<{ items: string[]; sections: string[]; rows: Awaited<ReturnType<typeof documentRows>>; finished: boolean }> = [];
    hooks.afterUpload = async () => {
      const [row] = await importRows(target.household.id);
      observed.push({
        items: await itemIds(target.household.id),
        sections: await sectionIds(target.household.id),
        rows: await documentRows(target.household.id),
        finished: row ? row.finishedAt !== null : false,
      });
    };

    const response = await importThroughRoute(target, file);
    expect(response.status, JSON.stringify(await errorOf(response.clone()).catch(() => ({})))).toBe(200);

    expect(observed).toHaveLength(3);
    for (const [index, seen] of observed.entries()) {
      expect(seen.items, `items during phase 1 (after document ${index})`).toEqual(itemsBefore);
      expect(seen.sections, `sections during phase 1 (after document ${index})`).toEqual(sectionsBefore);
      expect(seen.rows).toHaveLength(index + 1);
      for (const row of seen.rows) {
        expect(row.itemId, "staged rows are unbound").toBeNull();
        expect(row.sealedItemId, "staged rows carry the pre-generated item id").not.toBeNull();
      }
      expect(seen.finished).toBe(false);
    }

    const after = await documentRows(target.household.id);
    const created = (await itemIds(target.household.id)).filter((id) => !itemsBefore.includes(id));
    expect(after).toHaveLength(3);
    for (const row of after) {
      expect(row.itemId, "bound at the switch").not.toBeNull();
      expect(created).toContain(row.itemId);
      expect(row.itemId, "bound to the id it was sealed to").toBe(observed[2].rows.find((staged) => staged.id === row.id)!.sealedItemId);
    }
    const [finished] = await importRows(target.household.id);
    expect(finished.outcome).toBe("completed");
    expect(finished.createdItemIds.sort()).toEqual(created);
  }, 300_000);

  it("a failure in the switch's audit insert leaves no items, no sections and no finished import row", async () => {
    // Catches a switch split over several transactions: the items would commit and the audit row would not.
    const { target, file } = await archiveWith("arch1390-switch-audit", 2);
    const itemsBefore = await itemIds(target.household.id);
    const sectionsBefore = await sectionIds(target.household.id);
    const drop = await failingTrigger("audit_log", "before insert",
      `new.household_id = '${target.household.id}' and new.action = 'portable_archive_imported'`);
    let response: Response;
    try {
      response = await importThroughRoute(target, file);
    } finally {
      await drop();
    }
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe("archive_import_failed");
    expect(await itemIds(target.household.id)).toEqual(itemsBefore);
    expect(await sectionIds(target.household.id)).toEqual(sectionsBefore);
    for (const row of await importRows(target.household.id)) expect(row.outcome, "never recorded as completed").not.toBe("completed");
    expect(await getDb().select({ id: documents.id }).from(documents).where(and(eq(documents.householdId, target.household.id), isNotNull(documents.itemId)))).toEqual([]);
  }, 300_000);
});

describe("§4 line 26: the lease heartbeat advances after each document", () => {
  it("lease_renewed_at moves forward between documents", async () => {
    // Catches a heartbeat written once at the start: a long import would look stale to the sweep after an hour.
    const { target, file } = await archiveWith("arch1390-heartbeat", 3);
    const renewals: string[] = [];
    hooks.afterUpload = async () => {
      // Each document gets its own moment, so a renewal is visible as a change.
      await new Promise((resolve) => setTimeout(resolve, 25));
    };
    hooks.beforeUpload = async (index) => {
      if (index === 0) return;
      const rows = await getDb().execute(sql`select lease_renewed_at::text as renewed from portable_archive_imports where household_id = ${target.household.id}`);
      renewals.push(String((rows[0] as { renewed: string | null } | undefined)?.renewed));
    };
    const response = await importThroughRoute(target, file);
    expect(response.status).toBe(200);
    expect(renewals).toHaveLength(2);
    expect(renewals[0], "lease_renewed_at is set once a document has staged").not.toMatch(/^(null|undefined)$/);
    expect(renewals[1] > renewals[0], `renewed after document 1 (${renewals[1]}) later than after document 0 (${renewals[0]})`).toBe(true);
  }, 300_000);
});

describe("§4 line 23: an unreachable scanner fails the import as retryable, leaving nothing staged (RANGE-R2/2)", () => {
  it("answers 503 archive_scanner_unavailable; no items, no staged rows, no staging objects, no blob", async () => {
    // Catches the scanner outage treated as the ordinary upload does (202, held for a later scan): an import would wait on a document nobody can see.
    const { target, file } = await archiveWith("arch1390-scanner", 2);
    const itemsBefore = await itemIds(target.household.id);
    // The store is not split by household; the files the import writes are the target's, and these suites run one file at a time.
    const filesBefore = await storedFiles();
    const stagingBefore = await stagingKeys();
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "error", reason: "unavailable" });
    const response = await withRequiredScanMode(() => importThroughRoute(target, file));

    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe("archive_scanner_unavailable");
    expect(await itemIds(target.household.id)).toEqual(itemsBefore);
    expect(await documentRows(target.household.id)).toEqual([]);
    expect(await stagingRowsOf(target.household.id), "no staging object row for the target").toEqual([]);
    expect(await stagingKeys(), "no staging object row left by the import").toEqual(stagingBefore);
    expect(await storedFiles(), "no blob left in the store for the target household").toEqual(filesBefore);
    for (const row of await importRows(target.household.id)) expect(row.finishedAt, "the import row is closed").not.toBeNull();
  }, 300_000);
});

describe("§4 line 24: a failure after the switch committed is not a failed import (AR2-1 read-back)", () => {
  it("answers 200 with the normal result, rolls nothing back, and leaves one completed import row", async () => {
    // Catches an import that trusts the client's answer over the database: it would undo (or report failed) an import that happened.
    const { target, file } = await archiveWith("arch1390-readback", 2);
    const db = getDb();
    const original = db.transaction.bind(db);
    let injected = false;
    vi.spyOn(db, "transaction").mockImplementation((async (...args: Parameters<typeof db.transaction>) => {
      const result = await original(...args);
      if (!injected) {
        const [row] = await importRows(target.household.id);
        if (row?.outcome === "completed") {
          injected = true;
          throw new Error("connection lost after commit (#1390 injected)");
        }
      }
      return result;
    }) as typeof db.transaction);

    const response = await importThroughRoute(target, file);
    expect(injected, "the fault was injected after the switch committed").toBe(true);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ importedItems: 1, documentsExcluded: 0 });
    const rows = await importRows(target.household.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("completed");
    expect(await db.select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.householdId, target.household.id), eq(auditLog.action, "portable_archive_import_rolled_back")))).toEqual([]);
    expect((await documentRows(target.household.id)).every((row) => row.itemId !== null)).toBe(true);
  }, 300_000);
});

describe("§4 line 25: a failed restore whose undo also fails (AR2-1)", () => {
  it("answers 422 archive_import_failed naming the document, the reason and 'up to an hour'; the worker's next reconcile rolls the row back and reopens the household", async () => {
    // Catches the double failure reported as the restore failure alone, or left for a restart that the reconcile should do.
    const { target, file } = await archiveWith("arch1390-undo-fails", 2);
    hooks.afterUpload = async (index) => {
      if (index === 1) throw new AppError("document_invalid", "the file is not a readable PDF", 422);
    };
    const drop = await failingTrigger("portable_archive_imports", "before update",
      `new.household_id = '${target.household.id}' and new.outcome = 'rolled_back'`);
    let response: Response;
    try {
      response = await importThroughRoute(target, file);
    } finally {
      await drop();
    }

    expect(response.status).toBe(422);
    const error = await errorOf(response);
    expect(error.code).toBe("archive_import_failed");
    expect(error.message).toMatch(/stored-1\.pdf/);
    expect(error.message).toMatch(/the file is not a readable PDF/);
    expect(error.message).toMatch(/up to an hour/);

    const [open] = await importRows(target.household.id);
    expect(open.finishedAt, "the undo failed, so the row is still open").toBeNull();
    await expect(requireHouseholdAccess(target.users.member.id, target.household.id)).rejects.toMatchObject({ code: "household_import_in_progress" });

    // The lease runs out (an hour without a heartbeat); the worker's next cycle finds the row.
    await getDb().execute(sql`update portable_archive_imports set started_at = now() - interval '62 minutes', lease_renewed_at = now() - interval '61 minutes' where id = ${open.id}`);
    await runDocumentMaintenanceCycle();
    const [closed] = await importRows(target.household.id);
    expect(closed.outcome).toBe("rolled_back");
    await expect(requireHouseholdAccess(target.users.member.id, target.household.id)).resolves.toBeUndefined();
    expect(await getDb().select({ id: documents.id }).from(documents).where(and(eq(documents.householdId, target.household.id), isNull(documents.itemId)))).toEqual([]);
  }, 300_000);
});
