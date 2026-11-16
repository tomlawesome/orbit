/**
 * #1390 review round 1 (issue note 55214), rulings 1 and 9: the import holds
 * its lease like an optimistic lock, and a second open import row refuses a
 * new import. Written from the rulings alone, before the fixes.
 *
 * Ruling 1: the heartbeat, every staging write and the switch's close change
 * the import row only while it is still open (`finished_at is null`) and still
 * held by this import (the lease matches). If any of them changes 0 rows the
 * import aborts with `archive_import_failed` and never switches. The heartbeat
 * also runs while one document is being staged, not only between documents.
 *
 * Ruling 9: phase 0 refuses a second import while another import row for the
 * household is still open, whether or not the process-wide slot is held (the
 * tests call the route directly, so no slot is involved).
 *
 * "The lease is lost" is simulated the three ways the ruling names: the row is
 * rolled back, the lease is expired, and the loss happens either during one
 * document's staging (the scanner stub runs inside it) or between documents.
 * Archives are the product's own export of a source household.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { documents, items, portableArchiveImports, sections } from "@/db/schema";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import * as repository from "@/server/portable-archive-repository";
import { cleanupIntegrationEnvironment, createIntegrationFixture, withRequiredScanMode, type IntegrationFixture } from "./support/fixtures";
import { archiveForm } from "./support/portable-archive-upload";
import { errorOf, postForm, proofCookie } from "./support/portable-archive-routes";
import { loadRoute } from "./support/request-event";
import { seedStoredDocuments } from "./support/stored-documents";
import { syntheticPdf } from "../support/synthetic-documents";

const hooks = vi.hoisted(() => ({
  afterUpload: null as null | ((index: number) => Promise<void>),
  uploads: 0,
}));

vi.mock("@/server/document-repository", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/document-repository")>();
  return {
    ...original,
    uploadItemDocument: async (...args: Parameters<typeof original.uploadItemDocument>) => {
      const index = hooks.uploads++;
      const result = await original.uploadItemDocument(...args);
      await hooks.afterUpload?.(index);
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

/** The real timer functions, before any test fakes them. */
const real = { setImmediate: globalThis.setImmediate, setTimeout: globalThis.setTimeout, now: Date.now.bind(Date) };
const realDelay = (ms: number) => new Promise<void>((resolve) => real.setTimeout(resolve, ms));

beforeEach(() => {
  hooks.afterUpload = null;
  hooks.uploads = 0; // each test counts its own uploads, so the file passes in order as well as alone
  vi.mocked(scanFileWithClamAv).mockReset();
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

type Fixture = IntegrationFixture;

async function archiveWith(name: string, count: number): Promise<{ source: Fixture; target: Fixture; file: Buffer }> {
  const source = await createIntegrationFixture(`${name}-source`);
  const target = await createIntegrationFixture(`${name}-target`);
  await seedStoredDocuments(source, Array.from({ length: count }, (_, index) => syntheticPdf(`${name} document ${index} ${"y".repeat(2_000)}`)));
  await getDb().delete(documents).where(eq(documents.householdId, target.household.id));
  const archive = await repository.createPortableArchive({ userId: source.users.owner.id, householdId: source.household.id, passphrase, includeDocuments: true });
  const file = Buffer.from((await repository.readPortableArchive(source.users.owner.id, archive.id)).bytes);
  expect(file.subarray(0, 8).toString("latin1"), "the export writes format v2").toBe("ORBITARC");
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
const boundDocuments = async (householdId: string) =>
  getDb().select({ id: documents.id }).from(documents).where(and(eq(documents.householdId, householdId), isNotNull(documents.itemId)));

/** What the sweep (or anyone) does to a lost import: the row is closed as rolled back. */
const rollTheRowBack = (householdId: string) =>
  getDb().execute(sql`update portable_archive_imports set finished_at = now(), outcome = 'rolled_back' where household_id = ${householdId} and finished_at is null`);

/** What an hour of silence does to it: the lease reads as expired. */
const expireTheLease = (householdId: string) =>
  getDb().execute(sql`update portable_archive_imports set lease_renewed_at = now() - interval '2 hours', started_at = now() - interval '2 hours' where household_id = ${householdId} and finished_at is null`);

/** Runs `lose` once, inside the first scan (so while the first document is being staged). */
function loseDuringFirstScan(lose: () => Promise<unknown>) {
  let done = false;
  vi.mocked(scanFileWithClamAv).mockImplementation(async () => {
    if (!done) {
      done = true;
      await lose();
    }
    return { status: "clean" };
  });
}

async function expectNothingSwitched(target: Fixture, before: { items: string[]; sections: string[] }) {
  expect(await itemIds(target.household.id), "no item was created").toEqual(before.items);
  expect(await sectionIds(target.household.id), "no section was created").toEqual(before.sections);
  expect(await boundDocuments(target.household.id), "no document was bound to an item").toEqual([]);
}

describe("ruling 1: a lost lease stops the import (optimistic lock)", () => {
  it("the row is rolled back while the first document is staging: the import answers 422 archive_import_failed, the row stays rolled_back, nothing switches", async () => {
    // Catches today's import, which carries on, switches and marks the row completed with documents missing.
    const { target, file } = await archiveWith("arch1390-lost-rolled", 2);
    const before = { items: await itemIds(target.household.id), sections: await sectionIds(target.household.id) };
    loseDuringFirstScan(() => rollTheRowBack(target.household.id));

    const response = await withRequiredScanMode(() => importThroughRoute(target, file));

    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe("archive_import_failed");
    const rows = await importRows(target.household.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome, "the row stays as the sweep left it").toBe("rolled_back");
    await expectNothingSwitched(target, before);
  }, 300_000);

  it("the row is rolled back after the last document staged, before the switch: the switch's close changes 0 rows, the import answers archive_import_failed and nothing switches", async () => {
    // Catches a switch whose closing update does not check that the row is still open and held.
    const { target, file } = await archiveWith("arch1390-lost-before-switch", 1);
    const before = { items: await itemIds(target.household.id), sections: await sectionIds(target.household.id) };
    hooks.afterUpload = async () => { await rollTheRowBack(target.household.id); };

    const response = await withRequiredScanMode(() => importThroughRoute(target, file));

    expect((await errorOf(response)).code).toBe("archive_import_failed");
    expect(response.status).toBe(422);
    const rows = await importRows(target.household.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("rolled_back");
    await expectNothingSwitched(target, before);
  }, 300_000);

  it("the lease expires while the first document is staging: the import answers archive_import_failed, never completes and nothing switches", async () => {
    // Catches a heartbeat that renews whatever row has its id, expired or not, and so quietly revives a lease the sweep may already have given away.
    const { target, file } = await archiveWith("arch1390-lost-expired", 2);
    const before = { items: await itemIds(target.household.id), sections: await sectionIds(target.household.id) };
    loseDuringFirstScan(() => expireTheLease(target.household.id));

    const response = await withRequiredScanMode(() => importThroughRoute(target, file));

    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe("archive_import_failed");
    for (const row of await importRows(target.household.id)) expect(row.outcome, "an import that lost its lease is never recorded as completed").not.toBe("completed");
    await expectNothingSwitched(target, before);
  }, 300_000);

  it("the lease expires between two documents: the import stops before the second document is staged", async () => {
    // Catches a heartbeat after each document that does not check what it changed.
    const { target, file } = await archiveWith("arch1390-lost-between", 3);
    const before = { items: await itemIds(target.household.id), sections: await sectionIds(target.household.id) };
    let uploaded = 0;
    hooks.afterUpload = async (index) => {
      uploaded = index + 1;
      if (index === 0) await expireTheLease(target.household.id);
    };

    const response = await withRequiredScanMode(() => importThroughRoute(target, file));

    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe("archive_import_failed");
    expect(uploaded, "no document is staged after the lease was lost").toBe(1);
    await expectNothingSwitched(target, before);
  }, 300_000);
});

describe("ruling 1: the heartbeat runs while one long document is being staged", () => {
  it("lease_renewed_at moves forward during a single document whose scan takes ten minutes", async () => {
    // Catches a heartbeat that fires only between documents: one 100 MiB document on a slow scanner could outlive the 1 h lease.
    const { target, file } = await archiveWith("arch1390-heartbeat-inside", 1);
    const leaseOf = async () => {
      const rows = await getDb().execute(sql`select lease_renewed_at as renewed from portable_archive_imports where household_id = ${target.household.id} and finished_at is null`);
      const value = (rows[0] as { renewed: Date | string | null } | undefined)?.renewed;
      return value ? new Date(value).getTime() : null;
    };
    const observed: { before: number | null; after: number | null } = { before: null, after: null };
    vi.mocked(scanFileWithClamAv).mockImplementation(async () => {
      observed.before = await leaseOf();
      await realDelay(25);
      // Ten minutes of the document's staging pass, a minute at a time; each step lets the pending database work finish.
      for (let minute = 0; minute < 10; minute += 1) {
        await vi.advanceTimersByTimeAsync(60_000);
        await realDelay(25);
      }
      observed.after = await leaseOf();
      return { status: "clean" };
    });

    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
    let response: Response;
    try {
      response = await withRequiredScanMode(() => importThroughRoute(target, file));
    } finally {
      vi.useRealTimers();
    }

    expect(observed.before, "the import row has a lease when the document starts staging").not.toBeNull();
    expect(observed.after, "and still has one").not.toBeNull();
    expect(observed.after!, "the lease was renewed during the document, not only after it").toBeGreaterThan(observed.before!);
    expect(response.status, JSON.stringify(await errorOf(response.clone()).catch(() => ({})))).toBe(200);
  }, 300_000);
});

describe("ruling 9: phase 0 refuses a second open import in the household", () => {
  async function openRow(fixture: Fixture, options: { renewedMinutesAgo: number }): Promise<string> {
    const [row] = await getDb().insert(portableArchiveImports).values({
      householdId: fixture.household.id,
      actorUserId: fixture.users.owner.id,
      startedAt: new Date(Date.now() - options.renewedMinutesAgo * 60_000),
      finishedAt: null,
      createdSectionIds: [],
      createdItemIds: [],
    }).returning({ id: portableArchiveImports.id });
    await getDb().execute(sql`update portable_archive_imports set lease_renewed_at = now() - make_interval(mins => ${options.renewedMinutesAgo}) where id = ${row.id}`);
    return row.id;
  }

  it("a live open import row for the household (here the same owner, a second tab) refuses the import with 409, adds no row and creates nothing; no slot is involved", async () => {
    // Catches phase 0 that checks only for a stale row: two imports of one household would run side by side.
    const { target, file } = await archiveWith("arch1390-second-open", 1);
    const before = { items: await itemIds(target.household.id), sections: await sectionIds(target.household.id) };
    const firstId = await openRow(target, { renewedMinutesAgo: 1 });

    const response = await importThroughRoute(target, file);

    expect(response.status).toBe(409);
    expect((await errorOf(response)).code ?? "").toMatch(/import/u);
    const rows = await importRows(target.household.id);
    expect(rows.map((row) => row.id), "no second row was written").toEqual([firstId]);
    expect(rows[0].finishedAt, "the first import's row is untouched").toBeNull();
    await expectNothingSwitched(target, before);
  }, 300_000);

  it("a stale open row (lease ran out) does not refuse: it is rolled back and the import goes ahead", async () => {
    // Pins the existing sweep: refusing must apply to live rows only, or a crash would lock the household for good.
    const { target, file } = await archiveWith("arch1390-stale-open", 1);
    const staleId = await openRow(target, { renewedMinutesAgo: 90 });

    const response = await importThroughRoute(target, file);

    expect(response.status).toBe(200);
    const rows = await importRows(target.household.id);
    expect(rows.find((row) => row.id === staleId)?.outcome).toBe("rolled_back");
    expect(rows.filter((row) => row.outcome === "completed")).toHaveLength(1);
  }, 300_000);
});

