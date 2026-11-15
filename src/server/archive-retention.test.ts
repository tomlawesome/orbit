import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The export-retention settings (#1792). The database is a recording fake;
 * what a real transaction does (locking, the version check against a
 * concurrent writer) is outside it.
 */
const mocks = vi.hoisted(() => ({ getDb: vi.fn(), requireAdmin: vi.fn(), quota: vi.fn() }));

vi.mock("@/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/server/authorization", () => ({ requireInstanceAdministrator: mocks.requireAdmin }));
vi.mock("@/server/documents/config", () => ({ documentHouseholdQuotaBytes: mocks.quota }));

const GIB = 1_073_741_824;
const HOUR_MS = 3_600_000;

type Row = {
  id?: string;
  retentionHours: number | null;
  maxPerHousehold: number | null;
  maxTotalBytes: number | null;
  version: number;
  updatedAt: Date;
};

const row = (over: Partial<Row> = {}): Row => ({
  id: "row-1", retentionHours: null, maxPerHousehold: null, maxTotalBytes: null, version: 3, updatedAt: new Date("2026-11-01T12:00:00Z"), ...over,
});

interface Capture {
  sets: Array<Record<string, unknown>>;
  audits: Array<Record<string, unknown>>;
  forClauses: string[];
}

/** Selects answer from `reads` in order; the transaction's first select is `locked`. */
function fakeDb(options: { reads?: Array<Row | undefined>; locked?: Row | undefined; updated?: Array<{ id: string }>; retimed?: number }) {
  const capture: Capture = { sets: [], audits: [], forClauses: [] };
  const reads = [...(options.reads ?? [])];
  const makeSelect = (answer: () => Row | undefined) => () => {
    const self: Record<string, unknown> = {};
    self.from = (table: unknown) => { void table; return self; };
    self.limit = () => self;
    self.for = (clause: string) => { capture.forClauses.push(clause); return self; };
    self.then = (resolve: (value: unknown) => unknown) => {
      const found = answer();
      return Promise.resolve(found ? [found] : []).then(resolve);
    };
    return self;
  };
  let updateCall = 0;
  const transaction = {
    select: makeSelect(() => options.locked),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        capture.sets.push(values);
        const call = updateCall++ % 2;
        return {
          where: () => ({
            returning: async () => call === 0
              ? (options.updated ?? [{ id: "row-1" }])
              : Array.from({ length: options.retimed ?? 0 }, (_, index) => ({ id: `a${index}` })),
          }),
        };
      },
    }),
    insert: () => ({ values: async (value: Record<string, unknown>) => { capture.audits.push(value); } }),
  };
  mocks.getDb.mockReturnValue({
    select: makeSelect(() => reads.shift()),
    transaction: async (fn: (tx: unknown) => Promise<void>) => fn(transaction),
  });
  return capture;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue(undefined);
  mocks.quota.mockReturnValue(10 * GIB);
});

describe("archiveTotalBytesDefault", () => {
  it.each([
    [0, 1 * GIB],
    [1, 1 * GIB],
    [GIB / 2, 1 * GIB],
    [GIB, 2 * GIB],
    [GIB + 1, 3 * GIB],
    [5 * GIB, 10 * GIB],
    [5 * GIB + 1, 11 * GIB],
  ])("is twice the quota %d rounded up to whole GiB, never under 1 GiB: %d", async (quota, expected) => {
    const { archiveTotalBytesDefault } = await import("@/server/archive-retention");
    expect(archiveTotalBytesDefault({ householdQuotaBytes: quota })).toBe(expected);
  });

  it("reads the configured household quota when none is passed", async () => {
    mocks.quota.mockReturnValue(3 * GIB);
    const { archiveTotalBytesDefault } = await import("@/server/archive-retention");
    expect(archiveTotalBytesDefault()).toBe(6 * GIB);
  });
});

describe("readEffectiveArchiveRetention", () => {
  it("is the defaults when the row is missing", async () => {
    fakeDb({ reads: [undefined] });
    const { readEffectiveArchiveRetention } = await import("@/server/archive-retention");
    await expect(readEffectiveArchiveRetention()).resolves.toEqual({ retentionMs: 6 * HOUR_MS, keepPerHousehold: 2, maxTotalBytes: 20 * GIB });
  });

  it("is the defaults when every override is null", async () => {
    fakeDb({ reads: [row()] });
    const { readEffectiveArchiveRetention } = await import("@/server/archive-retention");
    await expect(readEffectiveArchiveRetention()).resolves.toEqual({ retentionMs: 6 * HOUR_MS, keepPerHousehold: 2, maxTotalBytes: 20 * GIB });
  });

  it("uses each override that is set and in range", async () => {
    fakeDb({ reads: [row({ retentionHours: 48, maxPerHousehold: 5, maxTotalBytes: 7 * GIB })] });
    const { readEffectiveArchiveRetention } = await import("@/server/archive-retention");
    await expect(readEffectiveArchiveRetention()).resolves.toEqual({ retentionMs: 48 * HOUR_MS, keepPerHousehold: 5, maxTotalBytes: 7 * GIB });
  });

  it.each([
    ["hours below the minimum", { retentionHours: 0 }],
    ["hours above the maximum", { retentionHours: 721 }],
    ["hours not whole", { retentionHours: 1.5 }],
    ["hours not finite", { retentionHours: Number.NaN }],
    ["count below the minimum", { maxPerHousehold: 0 }],
    ["count above the maximum", { maxPerHousehold: 11 }],
    ["bytes below 1 GiB", { maxTotalBytes: GIB - 1 }],
    ["bytes above the maximum", { maxTotalBytes: 102_401 * GIB }],
  ] as Array<[string, Partial<Row>]>)("falls back to the default, never widening a bound, for a damaged row: %s", async (_name, over) => {
    fakeDb({ reads: [row(over)] });
    const { readEffectiveArchiveRetention } = await import("@/server/archive-retention");
    await expect(readEffectiveArchiveRetention()).resolves.toEqual({ retentionMs: 6 * HOUR_MS, keepPerHousehold: 2, maxTotalBytes: 20 * GIB });
  });

  it.each([
    [1, 1, GIB],
    [720, 10, 102_400 * GIB],
  ])("accepts the bounds themselves: %d hours, %d exports", async (hours, count, bytes) => {
    fakeDb({ reads: [row({ retentionHours: hours, maxPerHousehold: count, maxTotalBytes: bytes })] });
    const { readEffectiveArchiveRetention } = await import("@/server/archive-retention");
    await expect(readEffectiveArchiveRetention()).resolves.toEqual({ retentionMs: hours * HOUR_MS, keepPerHousehold: count, maxTotalBytes: bytes });
  });

  it("reads the row FOR SHARE when given a transaction, and without a lock otherwise", async () => {
    const capture = fakeDb({ reads: [row()], locked: row({ retentionHours: 12 }) });
    const { readEffectiveArchiveRetention } = await import("@/server/archive-retention");
    const tx = (mocks.getDb() as { transaction: (fn: (t: never) => unknown) => Promise<unknown> });
    const inside = await tx.transaction(async (t) => readEffectiveArchiveRetention(t as never));
    expect((inside as { retentionMs: number }).retentionMs).toBe(12 * HOUR_MS);
    expect(capture.forClauses).toEqual(["share"]);
    await readEffectiveArchiveRetention();
    expect(capture.forClauses).toEqual(["share"]);
  });
});

describe("readArchiveRetentionSettings", () => {
  it("requires an administrator and refuses before reading when the check throws", async () => {
    mocks.requireAdmin.mockRejectedValue(new Error("forbidden"));
    fakeDb({ reads: [row()] });
    const { readArchiveRetentionSettings } = await import("@/server/archive-retention");
    await expect(readArchiveRetentionSettings("u1")).rejects.toThrow("forbidden");
    expect(mocks.requireAdmin).toHaveBeenCalledWith("u1");
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("fails with a 500 when the seeded row is missing", async () => {
    fakeDb({ reads: [undefined] });
    const { readArchiveRetentionSettings } = await import("@/server/archive-retention");
    await expect(readArchiveRetentionSettings("u1")).rejects.toMatchObject({ code: "archive_retention_state_missing", status: 500 });
  });

  it("returns what is in force, the defaults, the raw overrides, the bounds, the version and the time", async () => {
    fakeDb({ reads: [row({ retentionHours: 24, maxPerHousehold: null, maxTotalBytes: 3 * GIB })] });
    const { readArchiveRetentionSettings } = await import("@/server/archive-retention");
    await expect(readArchiveRetentionSettings("u1")).resolves.toEqual({
      retentionHours: 24,
      keepPerHousehold: 2,
      maxTotalBytes: 3 * GIB,
      defaults: { retentionHours: 6, keepPerHousehold: 2, maxTotalBytes: 20 * GIB },
      overrides: { retentionHours: 24, keepPerHousehold: null, maxTotalBytes: 3 * GIB },
      bounds: { retentionHours: [1, 720], keepPerHousehold: [1, 10], maxTotalGigabytes: [1, 102_400] },
      version: 3,
      updatedAt: "2026-11-01T12:00:00.000Z",
    });
  });
});

describe("setArchiveRetention", () => {
  const valid = { retentionHours: 24, keepPerHousehold: 4, maxTotalGigabytes: 50 };

  it("refuses a non-administrator before touching the database", async () => {
    mocks.requireAdmin.mockRejectedValue(new Error("forbidden"));
    fakeDb({});
    const { setArchiveRetention } = await import("@/server/archive-retention");
    await expect(setArchiveRetention("u1", 3, valid)).rejects.toThrow("forbidden");
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it.each([
    ["hours 0", { ...valid, retentionHours: 0 }],
    ["hours 721", { ...valid, retentionHours: 721 }],
    ["hours fractional", { ...valid, retentionHours: 2.5 }],
    ["keep 0", { ...valid, keepPerHousehold: 0 }],
    ["keep 11", { ...valid, keepPerHousehold: 11 }],
    ["space 0", { ...valid, maxTotalGigabytes: 0 }],
    ["space 102401", { ...valid, maxTotalGigabytes: 102_401 }],
    ["space NaN", { ...valid, maxTotalGigabytes: Number.NaN }],
    ["hours as text", { ...valid, retentionHours: "5" as unknown as number }],
  ])("refuses %s with a 422 and writes nothing", async (_name, values) => {
    const capture = fakeDb({ locked: row() });
    const { setArchiveRetention } = await import("@/server/archive-retention");
    await expect(setArchiveRetention("u1", 3, values)).rejects.toMatchObject({ code: "archive_retention_out_of_range", status: 422 });
    expect(capture.sets).toEqual([]);
    expect(capture.audits).toEqual([]);
  });

  it("fails with a 500 when the seeded row is missing", async () => {
    fakeDb({ locked: undefined });
    const { setArchiveRetention } = await import("@/server/archive-retention");
    await expect(setArchiveRetention("u1", 3, valid)).rejects.toMatchObject({ code: "archive_retention_state_missing", status: 500 });
  });

  it("refuses a stale version with a 409 and writes nothing", async () => {
    const capture = fakeDb({ locked: row({ version: 4 }) });
    const { setArchiveRetention } = await import("@/server/archive-retention");
    await expect(setArchiveRetention("u1", 3, valid)).rejects.toMatchObject({ code: "archive_retention_version_conflict", status: 409 });
    expect(capture.sets).toEqual([]);
  });

  it("refuses with a 409 when the guarded update matches no row", async () => {
    const capture = fakeDb({ locked: row(), updated: [] });
    const { setArchiveRetention } = await import("@/server/archive-retention");
    await expect(setArchiveRetention("u1", 3, valid)).rejects.toMatchObject({ code: "archive_retention_version_conflict", status: 409 });
    expect(capture.audits).toEqual([]);
  });

  it("stores the values, bumps the version, retimes kept exports and audits from/to and the count retimed", async () => {
    const capture = fakeDb({ locked: row({ retentionHours: 12 }), reads: [row({ version: 4 })], retimed: 3 });
    const { setArchiveRetention } = await import("@/server/archive-retention");
    const result = await setArchiveRetention("admin-1", 3, valid);
    expect(capture.sets[0]).toMatchObject({ retentionHours: 24, maxPerHousehold: 4, maxTotalBytes: 50 * GIB, version: 4 });
    expect(capture.sets[0].updatedAt).toBeInstanceOf(Date);
    expect(capture.sets[1]).toHaveProperty("expiresAt");
    expect(capture.audits).toEqual([{
      householdId: null,
      actorUserId: "admin-1",
      entityType: "instance_archive_retention",
      entityId: "row-1",
      action: "instance_archive_retention_set",
      changes: {
        from: { retentionHours: 12, keepPerHousehold: 2, maxTotalBytes: 20 * GIB },
        to: { retentionHours: 24, keepPerHousehold: 4, maxTotalBytes: 50 * GIB },
        rowsRetimed: 3,
      },
    }]);
    expect(result.version).toBe(4);
  });

  it("stores a value equal to its default as null, so only a differing value shows as set", async () => {
    const capture = fakeDb({ locked: row(), reads: [row({ version: 4 })] });
    const { setArchiveRetention } = await import("@/server/archive-retention");
    await setArchiveRetention("u1", 3, { retentionHours: 6, keepPerHousehold: 2, maxTotalGigabytes: 20 });
    expect(capture.sets[0]).toMatchObject({ retentionHours: null, maxPerHousehold: null, maxTotalBytes: null });
  });

  it("stores only the values that differ when some equal their defaults", async () => {
    const capture = fakeDb({ locked: row(), reads: [row({ version: 4 })] });
    const { setArchiveRetention } = await import("@/server/archive-retention");
    await setArchiveRetention("u1", 3, { retentionHours: 6, keepPerHousehold: 9, maxTotalGigabytes: 20 });
    expect(capture.sets[0]).toMatchObject({ retentionHours: null, maxPerHousehold: 9, maxTotalBytes: null });
  });

  it("with null goes back to every default, audited as a reset", async () => {
    const capture = fakeDb({ locked: row({ retentionHours: 12, maxPerHousehold: 5, maxTotalBytes: 3 * GIB }), reads: [row({ version: 4 })] });
    const { setArchiveRetention } = await import("@/server/archive-retention");
    await setArchiveRetention("u1", 3, null);
    expect(capture.sets[0]).toMatchObject({ retentionHours: null, maxPerHousehold: null, maxTotalBytes: null, version: 4 });
    expect(capture.audits[0]).toMatchObject({
      action: "instance_archive_retention_reset",
      changes: {
        from: { retentionHours: 12, keepPerHousehold: 5, maxTotalBytes: 3 * GIB },
        to: { retentionHours: 6, keepPerHousehold: 2, maxTotalBytes: 20 * GIB },
        rowsRetimed: 0,
      },
    });
  });

  it.each([
    [{ retentionHours: 720, keepPerHousehold: 10, maxTotalGigabytes: 102_400 }, { retentionHours: 720, maxPerHousehold: 10, maxTotalBytes: 102_400 * GIB }],
    [{ retentionHours: 1, keepPerHousehold: 1, maxTotalGigabytes: 1 }, { retentionHours: 1, maxPerHousehold: 1, maxTotalBytes: GIB }],
  ])("accepts the bounds themselves: %j", async (values, stored) => {
    const capture = fakeDb({ locked: row(), reads: [row({ version: 4 })] });
    const { setArchiveRetention } = await import("@/server/archive-retention");
    await setArchiveRetention("u1", 3, values);
    expect(capture.sets[0]).toMatchObject(stored);
  });
});
