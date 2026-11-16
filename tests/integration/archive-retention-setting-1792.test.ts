import { and, desc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import { auditLog } from "@/db/schema";
import { getDocumentConfig } from "@/server/documents/config";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationSession } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

/**
 * The three export settings against PostgreSQL (#1792, spec-security-fixes.md
 * 2.2, L9): the real route `admin/archive-storage`, the real singleton row,
 * real sessions. Kept for (1 to 720 h, default 6), kept per system (1 to 10,
 * default 2), space for all exports (1 to 102 400 GiB, default twice the
 * household quota). Only an administrator changes them; a value equal to its
 * default is stored as null; a stale version is a 409; every write is
 * audited with `from` and `to`. Shape of mail-limit-1388.test.ts.
 */
const URL_ = "http://127.0.0.1:3000/api/admin/archive-storage";
const GIB = 1_073_741_824;

// Loaded inside the tests, so a missing route or module fails each case rather than the file.
const routes = async () => loadRoute("admin/archive-storage");
type RetentionModule = {
  setArchiveRetention(actorUserId: string, expectedVersion: number, values: { retentionHours: number; keepPerHousehold: number; maxTotalGigabytes: number } | null): Promise<Settings>;
  readEffectiveArchiveRetention(): Promise<{ retentionMs: number; keepPerHousehold: number; maxTotalBytes: number }>;
  archiveTotalBytesDefault(): number;
  ARCHIVE_RETENTION_HOURS_DEFAULT: number;
  ARCHIVE_KEEP_PER_HOUSEHOLD_DEFAULT: number;
};
const RETENTION_MODULE = "@/server/archive-retention";
const retention = async () => (await import(/* @vite-ignore */ RETENTION_MODULE)) as RetentionModule;

type Triple = { retentionHours: number; keepPerHousehold: number; maxTotalBytes: number };
type Settings = Triple & {
  defaults: Triple;
  overrides: { retentionHours: number | null; keepPerHousehold: number | null; maxTotalBytes: number | null };
  bounds: { retentionHours: [number, number]; keepPerHousehold: [number, number]; maxTotalGigabytes: [number, number] };
  version: number;
  updatedAt: string | null;
};
type Body = { archiveStorage?: Settings; error?: { code: string } };

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

const defaultTotalBytes = () => 2 * getDocumentConfig().householdQuotaBytes;
const defaultTotalGigabytes = () => defaultTotalBytes() / GIB;

async function read(session: IntegrationSession) {
  const { GET } = await routes();
  const response = await callRouteForSession(GET, session, { url: URL_ });
  const body = await response.json() as Body;
  return { status: response.status, settings: body.archiveStorage ?? null, error: body.error };
}

async function write(session: IntegrationSession, body: unknown) {
  const { POST } = await routes();
  const response = await callRouteForSession(POST, session, { url: URL_, method: "POST", body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Body };
}

/** Back to the defaults, whatever an earlier test left. */
async function reset(admin: IntegrationSession): Promise<Settings> {
  const current = (await read(admin)).settings!;
  const { overrides } = current;
  if (overrides.retentionHours === null && overrides.keepPerHousehold === null && overrides.maxTotalBytes === null) return current;
  return (await write(admin, { action: "default", expectedVersion: current.version })).body.archiveStorage!;
}

const set = (version: number, values: Partial<{ retentionHours: number; keepPerHousehold: number; maxTotalGigabytes: number }>) => ({
  action: "set",
  expectedVersion: version,
  retentionHours: 6,
  keepPerHousehold: 2,
  maxTotalGigabytes: defaultTotalGigabytes(),
  ...values,
});

async function auditsOf(actorUserId: string) {
  return getDb().select({ action: auditLog.action, changes: auditLog.changes, householdId: auditLog.householdId })
    .from(auditLog)
    .where(and(eq(auditLog.actorUserId, actorUserId), eq(auditLog.entityType, "instance_archive_retention")))
    .orderBy(desc(auditLog.createdAt));
}

describe("#1792 L9: the export settings (admin/archive-storage)", () => {
  it("reads the defaults when nothing is set: 6 h, 2 per system, twice the household quota, every override null", async () => {
    // Catches a default that does not follow the quota, or an override reported where none is set.
    const fixture = await createIntegrationFixture("arch1792-retention-defaults");
    const admin = await fixture.session("admin");
    const clean = await reset(admin);
    const total = defaultTotalBytes();
    expect(clean).toMatchObject({
      retentionHours: 6,
      keepPerHousehold: 2,
      maxTotalBytes: total,
      defaults: { retentionHours: 6, keepPerHousehold: 2, maxTotalBytes: total },
      overrides: { retentionHours: null, keepPerHousehold: null, maxTotalBytes: null },
      bounds: { retentionHours: [1, 720], keepPerHousehold: [1, 10], maxTotalGigabytes: [1, 102_400] },
    });
    expect(clean.version).toBeGreaterThanOrEqual(1);
    const module = await retention();
    await expect(module.readEffectiveArchiveRetention()).resolves.toEqual({ retentionMs: 6 * 3_600_000, keepPerHousehold: 2, maxTotalBytes: total });
    expect(module.archiveTotalBytesDefault()).toBe(total);
  });

  it("refuses a non-administrator with 403", async () => {
    const fixture = await createIntegrationFixture("arch1792-retention-refused");
    const admin = await fixture.session("admin");
    const member = await fixture.session("member");
    const before = await reset(admin);

    expect((await read(member)).status).toBe(403);
    const asMember = await write(member, set(before.version, { retentionHours: 2 }));
    expect(asMember.status).toBe(403);
    expect(asMember.body.error?.code).toBe("administrator_required");
    expect((await read(admin)).settings).toEqual(before);
  });

  it("sets retention to 2 h: in force at once, its override 2, the others null; a value equal to its default stays null", async () => {
    // Catches an override stored for a value equal to its default (the screen would show "set here" for the default).
    const fixture = await createIntegrationFixture("arch1792-retention-set");
    const admin = await fixture.session("admin");
    const before = await reset(admin);
    const changed = await write(admin, set(before.version, { retentionHours: 2, keepPerHousehold: 2 }));
    expect(changed.status).toBe(200);
    expect(changed.body.archiveStorage).toMatchObject({
      retentionHours: 2,
      keepPerHousehold: 2,
      overrides: { retentionHours: 2, keepPerHousehold: null, maxTotalBytes: null },
    });
    expect(changed.body.archiveStorage!.version).toBe(before.version + 1);
    const module = await retention();
    expect((await module.readEffectiveArchiveRetention()).retentionMs).toBe(2 * 3_600_000);
    await reset(admin);
  });

  it("saving only a new hours value from the editor stores no space override: the default is whole GiB, rounded up (FR-4)", async () => {
    // Catches a default of 4.5 GiB that the editor pre-fills as 5 GB: saving it would store a 5 GiB override, "set here" for a value never chosen.
    const quota = "2415919104"; // 2.25 GiB
    const previous = process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES;
    process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES = quota;
    try {
      const fixture = await createIntegrationFixture("arch1792-retention-whole-gib");
      const admin = await fixture.session("admin");
      const { defaults, version } = await reset(admin);
      expect(defaults.maxTotalBytes % GIB, "the default is a multiple of GiB").toBe(0);
      expect(defaults.maxTotalBytes).toBe(5 * GIB);

      const saved = await write(admin, set(version, { retentionHours: 2, keepPerHousehold: 2, maxTotalGigabytes: Math.round(defaults.maxTotalBytes / GIB) }));
      expect(saved.status).toBe(200);
      expect(saved.body.archiveStorage!.overrides).toEqual({ retentionHours: 2, keepPerHousehold: null, maxTotalBytes: null });
      expect(saved.body.archiveStorage!.maxTotalBytes).toBe(5 * GIB);
      expect(saved.body.archiveStorage!.maxTotalBytes % GIB).toBe(0);
      await reset(admin);
    } finally {
      if (previous === undefined) delete process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES;
      else process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES = previous;
    }
  });

  it("stores 7 GiB as an override at a 2.25 GiB quota, and the default action clears every override", async () => {
    const previous = process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES;
    process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES = "2415919104";
    try {
      const fixture = await createIntegrationFixture("arch1792-retention-whole-gib-set");
      const admin = await fixture.session("admin");
      const before = await reset(admin);
      const changed = await write(admin, set(before.version, { maxTotalGigabytes: 7 }));
      expect(changed.status).toBe(200);
      expect(changed.body.archiveStorage!.overrides.maxTotalBytes).toBe(7 * GIB);
      expect(changed.body.archiveStorage!.maxTotalBytes).toBe(7 * GIB);

      const cleared = await write(admin, { action: "default", expectedVersion: changed.body.archiveStorage!.version });
      expect(cleared.status).toBe(200);
      expect(cleared.body.archiveStorage!.overrides).toEqual({ retentionHours: null, keepPerHousehold: null, maxTotalBytes: null });
    } finally {
      if (previous === undefined) delete process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES;
      else process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES = previous;
    }
  });

  it("refuses 0 h, 11 per system, 0 GB and 721 h with 422 at the route, and the row keeps its version", async () => {
    // Catches a range not enforced at the route.
    const fixture = await createIntegrationFixture("arch1792-retention-route-range");
    const admin = await fixture.session("admin");
    const before = await reset(admin);
    for (const values of [{ retentionHours: 0 }, { keepPerHousehold: 11 }, { maxTotalGigabytes: 0 }, { retentionHours: 721 }]) {
      const refused = await write(admin, set(before.version, values));
      expect(refused.status, JSON.stringify(values)).toBe(422);
    }
    expect((await read(admin)).settings).toEqual(before);
  });

  it("refuses the same values at the engine with archive_retention_out_of_range (422)", async () => {
    // Catches a range enforced only by the route's schema (any other caller could widen it).
    const fixture = await createIntegrationFixture("arch1792-retention-server-range");
    const admin = await fixture.session("admin");
    const before = await reset(admin);
    const { setArchiveRetention } = await retention();
    const base = { retentionHours: 6, keepPerHousehold: 2, maxTotalGigabytes: defaultTotalGigabytes() };
    for (const values of [{ retentionHours: 0 }, { keepPerHousehold: 11 }, { maxTotalGigabytes: 0 }, { retentionHours: 721 }, { retentionHours: 2.5 }]) {
      await expect(setArchiveRetention(fixture.users.admin.id, before.version, { ...base, ...values }), JSON.stringify(values))
        .rejects.toMatchObject({
          code: "archive_retention_out_of_range",
          status: 422,
          message: "The archive settings must be whole numbers: hours from 1 to 720, exports per system from 1 to 10, space from 1 to 102400 GB",
        });
    }
    expect((await read(admin)).settings).toEqual(before);
  });

  it("refuses a stale version with archive_retention_version_conflict (409); default puts every override back to null; one audit row per write with from and to", async () => {
    const fixture = await createIntegrationFixture("arch1792-retention-conflict");
    const admin = await fixture.session("admin");
    const before = await reset(admin);
    const auditsBefore = (await auditsOf(fixture.users.admin.id)).length;

    const changed = await write(admin, set(before.version, { retentionHours: 3, keepPerHousehold: 4, maxTotalGigabytes: 7 }));
    expect(changed.status).toBe(200);
    expect(changed.body.archiveStorage!.overrides).toEqual({ retentionHours: 3, keepPerHousehold: 4, maxTotalBytes: 7 * GIB });

    const stale = await write(admin, set(before.version, { retentionHours: 5 }));
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe("archive_retention_version_conflict");
    expect((await read(admin)).settings?.overrides.retentionHours).toBe(3);

    const back = await write(admin, { action: "default", expectedVersion: changed.body.archiveStorage!.version });
    expect(back.status).toBe(200);
    expect(back.body.archiveStorage).toMatchObject({
      retentionHours: 6,
      keepPerHousehold: 2,
      maxTotalBytes: defaultTotalBytes(),
      overrides: { retentionHours: null, keepPerHousehold: null, maxTotalBytes: null },
    });

    const audits = await auditsOf(fixture.users.admin.id);
    expect(audits.length - auditsBefore, "one row per write, none for the refused one").toBe(2);
    const [reset_, set_] = audits;
    expect(set_.action).toBe("instance_archive_retention_set");
    expect(reset_.action).toBe("instance_archive_retention_reset");
    for (const entry of [set_, reset_]) {
      expect(entry.householdId).toBeNull();
      const changes = entry.changes as { from?: Record<string, unknown>; to?: Record<string, unknown> };
      expect(changes.from, entry.action).toBeDefined();
      expect(changes.to, entry.action).toBeDefined();
    }
    expect((set_.changes as { to: Record<string, unknown> }).to).toMatchObject({ retentionHours: 3, keepPerHousehold: 4 });
  });

  it("lets one of two identical sets sent at once win, and gives the other the version conflict", async () => {
    const fixture = await createIntegrationFixture("arch1792-retention-double-submit");
    const admin = await fixture.session("admin");
    const before = await reset(admin);
    const request = set(before.version, { retentionHours: 12 });

    const [first, second] = await Promise.all([write(admin, request), write(admin, request)]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const loser = first.status === 409 ? first : second;
    expect(loser.body.error?.code).toBe("archive_retention_version_conflict");
    const after = (await read(admin)).settings!;
    expect(after.overrides.retentionHours).toBe(12);
    expect(after.version).toBe(before.version + 1);
    await reset(admin);
  });
});
