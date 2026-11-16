/**
 * #1792 (spec-security-fixes.md 2.3 steps 1 and 3, L12): the space for all
 * exports. When the live exports of every household together pass
 * `maxTotalBytes`, archives are marked purged until they fit: downloaded ones
 * first, oldest first, then the rest, oldest first; the new one never. An
 * export larger than the whole limit by itself is refused before anything is
 * written (507 archive_store_full).
 *
 * The smallest limit an administrator can set (1 GiB) is too big to exercise
 * with fixtures, so the engine's read of the settings is mocked: the limit is
 * set to two and a half archives. The instance's live exports are purged
 * before each case, so only this case's archives count towards it.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, portableArchives } from "@/db/schema";
import { createPortableArchive } from "@/server/portable-archive-repository";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";
import { seedStoredDocuments } from "./support/stored-documents";
import { syntheticPdf } from "../support/synthetic-documents";

const settings = vi.hoisted(() => ({ retentionMs: 6 * 3_600_000, keepPerHousehold: 10, maxTotalBytes: Number.MAX_SAFE_INTEGER }));

vi.mock("@/server/archive-retention", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readEffectiveArchiveRetention: async () => ({ ...settings }),
}));

const passphrase = "correct-horse-battery-staple";
const { GET: downloadRoute } = await loadRoute("portable-archives/[archiveId]/download");

beforeEach(async () => {
  settings.keepPerHousehold = 10;
  settings.maxTotalBytes = Number.MAX_SAFE_INTEGER;
  // Only this case's archives count towards the instance's total.
  await getDb().update(portableArchives).set({ purgedAt: new Date() }).where(isNull(portableArchives.purgedAt));
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

/** A household with the same two small documents as every other here, so its archives are all about the same size. Names are the same length for the same reason. */
async function seeded(name: string): Promise<IntegrationFixture> {
  const fixture = await createIntegrationFixture(name);
  await seedStoredDocuments(fixture, [syntheticPdf("arch1792 total a"), syntheticPdf("arch1792 total b")]);
  await getDb().update(portableArchives).set({ purgedAt: new Date() }).where(eq(portableArchives.householdId, fixture.household.id));
  return fixture;
}

async function exportOf(fixture: IntegrationFixture): Promise<string> {
  return (await createPortableArchive({ userId: fixture.users.owner.id, householdId: fixture.household.id, passphrase, includeDocuments: true })).id;
}

/** The size of one archive of a household like these, measured by writing one and putting it away again. */
async function oneArchiveBytes(): Promise<number> {
  const probe = await seeded("arch1792-l12-pp");
  const id = await exportOf(probe);
  const [row] = await getDb().select({ sizeBytes: portableArchives.sizeBytes }).from(portableArchives).where(eq(portableArchives.id, id));
  await getDb().update(portableArchives).set({ purgedAt: new Date() }).where(eq(portableArchives.id, id));
  return row.sizeBytes;
}

async function liveIds(ids: string[]): Promise<string[]> {
  return (await getDb().select({ id: portableArchives.id }).from(portableArchives)
    .where(and(inArray(portableArchives.id, ids), isNull(portableArchives.purgedAt)))).map((row) => row.id).sort();
}

async function auditsOf(action: string, ids: string[]) {
  return getDb().select({ entityId: auditLog.entityId, changes: auditLog.changes }).from(auditLog)
    .where(and(eq(auditLog.action, action), inArray(auditLog.entityId, ids)));
}

async function archiveStoreFiles(): Promise<string[]> {
  const root = join(process.env.DOCUMENTS_ROOT!, "portable-archives");
  return (await readdir(root, { recursive: true }).catch(() => [] as string[])).map(String).sort();
}

async function downloadOf(fixture: IntegrationFixture, archiveId: string) {
  const owner = await fixture.session("owner");
  const response = await callRouteForSession(downloadRoute, owner, { url: "http://127.0.0.1:3000/api/portable-archives/download", params: { archiveId } });
  expect(response.status).toBe(200);
  await response.arrayBuffer();
}

describe("#1792 L12: the space for all exports", () => {
  it("three exports across two households, with room for two and a half: the oldest is evicted (reason total), two stay live", async () => {
    // Catches no instance-wide bound: households each within their own limit can still fill the shared volume.
    settings.maxTotalBytes = Math.floor(2.5 * await oneArchiveBytes());
    const a = await seeded("arch1792-l12-aa");
    const b = await seeded("arch1792-l12-bb");
    const ids = [await exportOf(a), await exportOf(b), await exportOf(a)];
    const [oldest, middle, newest] = ids;

    expect(await liveIds(ids)).toEqual([middle, newest].sort());
    const evicted = await auditsOf("portable_archive_evicted", ids);
    expect(evicted.map((entry) => entry.entityId)).toEqual([oldest]);
    expect(evicted[0].changes).toEqual({ byArchiveId: newest, reason: "total" });
    expect(await auditsOf("portable_archive_replaced", ids), "the per-household limit took no part").toEqual([]);
  }, 180_000);

  it("evicts a downloaded export before an older one not yet downloaded", async () => {
    // Catches eviction by age alone: the oldest may be the one nobody has fetched yet, while a downloaded one has served its purpose.
    settings.maxTotalBytes = Math.floor(2.5 * await oneArchiveBytes());
    const a = await seeded("arch1792-l12-cc");
    const b = await seeded("arch1792-l12-dd");
    const oldest = await exportOf(a);
    const middle = await exportOf(b);
    await downloadOf(b, middle);
    const newest = await exportOf(a);

    expect(await liveIds([oldest, middle, newest])).toEqual([oldest, newest].sort());
    expect((await auditsOf("portable_archive_evicted", [oldest, middle, newest])).map((entry) => entry.entityId)).toEqual([middle]);
  }, 180_000);

  it("refuses an export larger than the whole limit with 507 archive_store_full, writing nothing and replacing nothing", async () => {
    // Catches a limit that evicts every other household's export to make room for one that can never fit.
    const one = await oneArchiveBytes();
    const a = await seeded("arch1792-l12-ee");
    const kept = await exportOf(a);
    settings.maxTotalBytes = Math.floor(one / 2);
    const filesBefore = await archiveStoreFiles();

    const refusal = await exportOf(a).then(() => null, (error: unknown) => error);

    expect(refusal).toMatchObject({ code: "archive_store_full", status: 507 });
    expect((refusal as { message: string }).message).toMatch(
      /^Orbit keeps at most \d+ GB of exports and this one would be about \d+\.\d GB on its own; ask your administrator to raise the space for exports$/u,
    );
    expect(await archiveStoreFiles(), "nothing written").toEqual(filesBefore);
    expect(await liveIds([kept]), "nothing replaced").toEqual([kept]);
    expect(await auditsOf("portable_archive_evicted", [kept])).toEqual([]);
    expect(await auditsOf("portable_archive_replaced", [kept])).toEqual([]);
  }, 180_000);
});
