/**
 * #1792 (A-S2; spec-security-fixes.md Part 2, R2, L10, L11, L13): the exports
 * a household and the instance keep are bounded. Each export is kept for the
 * retention (default 6 h, not 24 h); a household keeps at most
 * `keepPerHousehold` live exports (default 2), its oldest replaced by a new
 * one; a changed retention retimes the exports already kept; and an export
 * whose write fails costs no one an archive.
 *
 * node:fs/promises is wrapped as in portable-archive-v2-export-disk.test.ts:
 * a write to a temp file under the archive store fails with ENOSPC after its
 * first chunk when asked to (L13). Everything else is the real file system.
 *
 * The settings module (src/server/archive-retention.ts) is new in #1792, so it
 * is reached through a computed specifier: before the build each case that
 * needs it fails on its own, and R2 (defaults only) fails on its assertions.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, portableArchives } from "@/db/schema";
import { createPortableArchive, purgeExpiredPortableArchives } from "@/server/portable-archive-repository";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";
import { sealStepUpProof, stepUpProofCookieName } from "@/lib/auth/recent-auth";
import { getAuthConfig } from "@/lib/env";
import { errorOf } from "./support/portable-archive-routes";
import { seedStoredDocuments } from "./support/stored-documents";
import { syntheticPdf } from "../support/synthetic-documents";

const disk = vi.hoisted(() => ({ failWrites: false, failedWrites: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  const enospc = () => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", errno: -28, syscall: "write" });
  const wrapped = {
    ...original,
    open: (async (path: Parameters<typeof original.open>[0], ...rest: unknown[]) => {
      const handle = await (original.open as (...args: unknown[]) => ReturnType<typeof original.open>)(path, ...rest);
      if (!disk.failWrites || !String(path).includes("portable-archives") || !String(path).endsWith(".tmp")) return handle;
      let written = 0;
      return new Proxy(handle, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (property !== "write" && property !== "writev" && property !== "appendFile" && property !== "writeFile") {
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async (...args: unknown[]) => {
            if (written > 0) { disk.failedWrites += 1; throw enospc(); }
            written += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    }) as typeof original.open,
  };
  return { ...wrapped, default: wrapped };
});

const HOUR_MS = 3_600_000;
const passphrase = "correct-horse-battery-staple";

const { GET: downloadRoute } = await loadRoute("portable-archives/[archiveId]/download");
const { POST: exportRoute } = await loadRoute("households/[householdId]/portable-archives");

type Values = { retentionHours: number; keepPerHousehold: number; maxTotalGigabytes: number };
type Settings = { version: number; defaults: { retentionHours: number; keepPerHousehold: number; maxTotalBytes: number } };
type RetentionModule = {
  setArchiveRetention(actorUserId: string, expectedVersion: number, values: Values | null): Promise<Settings>;
  readArchiveRetentionSettings(actorUserId: string): Promise<Settings>;
};
const RETENTION_MODULE = "@/server/archive-retention";
const retention = async () => (await import(/* @vite-ignore */ RETENTION_MODULE)) as RetentionModule;

/** An administrator to change the settings with: any fixture's admin. */
let settingsAdmin: IntegrationFixture | null = null;
async function admin(): Promise<IntegrationFixture> {
  settingsAdmin ??= await createIntegrationFixture("arch1792-retention-admin");
  return settingsAdmin;
}

/** Sets the three settings, each left out taking its default; `null` goes back to the defaults. */
async function setRetention(values: Partial<Values> | null) {
  const module = await retention();
  const actor = (await admin()).users.admin.id;
  const current = await module.readArchiveRetentionSettings(actor);
  const { defaults } = current;
  const full = values === null ? null : {
    retentionHours: defaults.retentionHours,
    keepPerHousehold: defaults.keepPerHousehold,
    maxTotalGigabytes: defaults.maxTotalBytes / 1_073_741_824,
    ...values,
  };
  return module.setArchiveRetention(actor, current.version, full);
}

beforeEach(async () => {
  disk.failWrites = false;
  disk.failedWrites = 0;
});

afterEach(async () => {
  // The next case starts from the defaults; before the build there is nothing to reset.
  await setRetention(null).catch(() => undefined);
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

/** A household with two small stored documents, holding no live export of its own yet. */
async function seeded(name: string): Promise<IntegrationFixture> {
  const fixture = await createIntegrationFixture(name);
  await seedStoredDocuments(fixture, [syntheticPdf(`${name} a`), syntheticPdf(`${name} b`)]);
  // The fixture inserts one archive row with no file behind it; out of the way, so the counts below are this test's exports only.
  await getDb().update(portableArchives).set({ purgedAt: new Date() }).where(eq(portableArchives.householdId, fixture.household.id));
  return fixture;
}

async function exportOf(fixture: IntegrationFixture): Promise<string> {
  const archive = await createPortableArchive({ userId: fixture.users.owner.id, householdId: fixture.household.id, passphrase, includeDocuments: true });
  return archive.id;
}

async function rowsOf(ids: string[]) {
  const rows = await getDb().select().from(portableArchives).where(inArray(portableArchives.id, ids));
  return ids.map((id) => rows.find((row) => row.id === id)!);
}

async function liveIdsOf(householdId: string): Promise<string[]> {
  return (await getDb().select({ id: portableArchives.id }).from(portableArchives)
    .where(and(eq(portableArchives.householdId, householdId), isNull(portableArchives.purgedAt), sql`${portableArchives.expiresAt} > now()`)))
    .map((row) => row.id).sort();
}

async function archiveFilesOf(ids: string[]): Promise<string[]> {
  const keys = new Set((await rowsOf(ids)).map((row) => row.storageKey));
  const root = join(process.env.DOCUMENTS_ROOT!, "portable-archives");
  const names = (await readdir(root).catch(() => [] as string[])).map(String);
  return names.filter((name) => name.endsWith(".archive") && keys.has(name.slice(0, -".archive".length))).sort();
}

async function download(fixture: IntegrationFixture, archiveId: string) {
  const owner = await fixture.session("owner");
  return callRouteForSession(downloadRoute, owner, { url: "http://127.0.0.1:3000/api/portable-archives/download", params: { archiveId } });
}

async function auditsFor(householdId: string, action: string) {
  return getDb().select({ entityId: auditLog.entityId, changes: auditLog.changes }).from(auditLog)
    .where(and(eq(auditLog.householdId, householdId), eq(auditLog.action, action)));
}

/**
 * How long a row is kept, to the nearest second: `created_at` is the
 * database's clock and `expires_at` may be computed in the process a moment
 * apart, so only whole seconds are compared.
 */
const lifetimeMs = (row: { expiresAt: Date; createdAt: Date }) => Math.round((row.expiresAt.getTime() - row.createdAt.getTime()) / 1_000) * 1_000;

describe("R2: three exports at the defaults", () => {
  it("leave two live rows and two .archive files; the oldest is replaced (purged, audited, 404); the two newest download; each was kept for 6 h", async () => {
    // Catches the unbounded store: today every export is kept, for 24 h, so an owner looping exports fills the shared volume for a day.
    const fixture = await seeded("arch1792-r2");
    const ids = [await exportOf(fixture), await exportOf(fixture), await exportOf(fixture)];
    const [oldest, middle, newest] = ids;

    expect.soft(await liveIdsOf(fixture.household.id), "two live exports").toEqual([middle, newest].sort());
    expect.soft(await archiveFilesOf(ids), "two archive files on disk").toHaveLength(2);
    const rows = await rowsOf(ids);
    expect.soft(rows[0].purgedAt, "the oldest is marked purged").not.toBeNull();
    const replaced = await auditsFor(fixture.household.id, "portable_archive_replaced");
    expect.soft(replaced.map((entry) => entry.entityId), "an audit row for the replaced archive").toEqual([oldest]);
    expect.soft(replaced[0]?.changes).toEqual({ byArchiveId: newest });

    const gone = await download(fixture, oldest);
    expect.soft(gone.status).toBe(404);
    if (gone.status === 404) expect.soft((await errorOf(gone)).code).toBe("archive_not_found");
    for (const id of [middle, newest]) {
      const kept = await download(fixture, id);
      expect.soft(kept.status, `${id} downloads`).toBe(200);
      await kept.arrayBuffer();
    }
    for (const row of rows) expect.soft(lifetimeMs(row), "kept for 6 hours").toBe(6 * HOUR_MS);
  }, 120_000);
});

describe("L10: a changed retention retimes the exports already kept", () => {
  it("1 h, then 48 h, retimes the row from its created_at; with it written 2 h ago, 1 h makes it unavailable and the worker purges it", async () => {
    // Catches a setting applied only to new exports (an administrator shortening it would still leave a day's worth on disk).
    const fixture = await seeded("arch1792-l10");
    const id = await exportOf(fixture);
    expect(lifetimeMs((await rowsOf([id]))[0])).toBe(6 * HOUR_MS);

    await setRetention({ retentionHours: 1 });
    expect(lifetimeMs((await rowsOf([id]))[0]), "retimed to 1 h").toBe(HOUR_MS);
    await setRetention({ retentionHours: 48 });
    expect(lifetimeMs((await rowsOf([id]))[0]), "retimed to 48 h").toBe(48 * HOUR_MS);

    await getDb().update(portableArchives).set({ createdAt: sql`${portableArchives.createdAt} - interval '2 hours'` }).where(eq(portableArchives.id, id));
    await setRetention({ retentionHours: 1 });
    const [row] = await rowsOf([id]);
    expect(lifetimeMs(row)).toBe(HOUR_MS);
    expect(row.expiresAt.getTime(), "already past").toBeLessThan(Date.now());

    const gone = await download(fixture, id);
    expect(gone.status).toBe(404);
    expect((await errorOf(gone)).code).toBe("archive_not_found");
    await purgeExpiredPortableArchives();
    expect((await rowsOf([id]))[0].purgedAt, "the worker's next cycle purges it").not.toBeNull();
    expect((await auditsFor(fixture.household.id, "portable_archive_expired")).map((entry) => entry.entityId)).toContain(id);

    const settingAudits = await getDb().select({ changes: auditLog.changes }).from(auditLog)
      .where(and(eq(auditLog.actorUserId, (await admin()).users.admin.id), eq(auditLog.action, "instance_archive_retention_set")));
    const retimed = settingAudits.map((entry) => (entry.changes as { rowsRetimed?: unknown }).rowsRetimed);
    expect(retimed.length).toBeGreaterThanOrEqual(3);
    for (const count of retimed) expect(count, "each setting write records how many exports it retimed").toEqual(expect.any(Number));
    expect(Math.max(...(retimed as number[]))).toBeGreaterThanOrEqual(1);
  }, 120_000);
});

describe("L11: the per-household limit", () => {
  it("at 1 a second export replaces the first", async () => {
    const fixture = await seeded("arch1792-l11-one");
    await setRetention({ keepPerHousehold: 1 });
    const first = await exportOf(fixture);
    const second = await exportOf(fixture);
    expect(await liveIdsOf(fixture.household.id)).toEqual([second]);
    expect((await auditsFor(fixture.household.id, "portable_archive_replaced")).map((entry) => entry.entityId)).toEqual([first]);
  }, 120_000);

  it("at 3 three exports all stay live, and the fourth replaces the oldest", async () => {
    // Catches a limit that ignores the setting (the default 2 would replace the first at the third).
    const fixture = await seeded("arch1792-l11-three");
    await setRetention({ keepPerHousehold: 3 });
    const ids = [await exportOf(fixture), await exportOf(fixture), await exportOf(fixture)];
    expect(await liveIdsOf(fixture.household.id)).toEqual([...ids].sort());
    const fourth = await exportOf(fixture);
    expect(await liveIdsOf(fixture.household.id)).toEqual([ids[1], ids[2], fourth].sort());
  }, 120_000);

  it("counts each household on its own: household A's exports never replace household B's", async () => {
    // Catches a per-household limit counted across the instance.
    const a = await seeded("arch1792-l11-a");
    const b = await seeded("arch1792-l11-b");
    const fromB = [await exportOf(b), await exportOf(b)];
    const fromA = [await exportOf(a), await exportOf(a), await exportOf(a)];
    expect(await liveIdsOf(b.household.id), "B keeps both of its own").toEqual([...fromB].sort());
    expect(await liveIdsOf(a.household.id), "A keeps its last two").toEqual([fromA[1], fromA[2]].sort());
    expect(await auditsFor(b.household.id, "portable_archive_replaced")).toEqual([]);
  }, 120_000);
});

describe("L13: a failed export costs nothing", () => {
  it("with one live export and a limit of 1, a second export whose write fails with ENOSPC leaves the first live and downloadable, and replaces nothing", async () => {
    // Catches the replacement done before the new file is safely written (a full disk would cost the household its only archive).
    const fixture = await seeded("arch1792-l13");
    await setRetention({ keepPerHousehold: 1 });
    const first = await exportOf(fixture);
    disk.failWrites = true;
    const refusal = await exportOf(fixture).then(() => null, (error: unknown) => error);
    disk.failWrites = false;
    expect(disk.failedWrites, "a write hit ENOSPC").toBeGreaterThan(0);
    expect(refusal).toMatchObject({ code: "archive_storage_full", status: 507 });
    expect(await liveIdsOf(fixture.household.id)).toEqual([first]);
    const kept = await download(fixture, first);
    expect(kept.status).toBe(200);
    await kept.arrayBuffer();
    expect(await auditsFor(fixture.household.id, "portable_archive_replaced")).toEqual([]);
  }, 120_000);
});

describe("L14: the export's answer says how many are kept", () => {
  /** Writes an export through the real route, as the owner who has just proved it is them, and returns the answer's body. */
  async function exportThroughRoute(fixture: IntegrationFixture) {
    const owner = await fixture.session("owner");
    const config = getAuthConfig();
    const cookie = `${owner.headers.cookie}; ${stepUpProofCookieName(config)}=${await sealStepUpProof(owner.sessionId, "archive_export", config)}`;
    const response = await callRouteForSession(exportRoute, owner, {
      url: `http://127.0.0.1:3000/api/households/${fixture.household.id}/portable-archives`,
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ passphrase, includeDocuments: false }),
      params: { householdId: fixture.household.id },
    });
    expect(response.status).toBe(200);
    return await response.json() as { archive: { keepPerHousehold?: number; expiresAt: string } };
  }

  it("carries keepPerHousehold: 2 at the defaults, and 1 once an administrator sets 1", async () => {
    // Catches a card that cannot say how many exports Orbit keeps, so a household learns of the replacement only when its old link fails.
    const fixture = await seeded("arch1792-l14");
    expect((await exportThroughRoute(fixture)).archive.keepPerHousehold).toBe(2);
    await setRetention({ keepPerHousehold: 1 });
    expect((await exportThroughRoute(fixture)).archive.keepPerHousehold).toBe(1);
  }, 120_000);
});
