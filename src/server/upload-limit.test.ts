import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The administrator's upload size limit (#1285), against an in-memory
 * stand-in for the database: "stored override, falling back to configured
 * default". The integration suite (tests/integration/upload-limit.test.ts)
 * proves the route and the real row; this pins the decisions the module makes
 * on its own — how the effective limit is resolved, the hard bounds, that a
 * refused value never reaches the row, the version gate, and the audit.
 */

const ADMIN = "11111111-1111-4111-8111-111111111111";
const OUTSIDER = "22222222-2222-4222-8222-222222222222";
const MIB = 1_048_576;

const mocks = vi.hoisted(() => ({
  administrators: new Set<string>(),
  configuredDefault: 50 * 1_048_576,
  row: null as null | { singleton: boolean; id: string; maxBytes: number | null; version: number; updatedAt: Date },
  auditRows: [] as Array<{ action: string; actorUserId: string | null; entityType: string; householdId: string | null; changes: unknown }>,
}));

vi.mock("@/server/documents/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/documents/config")>();
  return { ...actual, getDocumentConfig: () => ({ maxBytes: mocks.configuredDefault }) };
});

vi.mock("@/db", async () => {
  const { is, Param } = await import("drizzle-orm");
  const schema = await import("@/db/schema");

  function literalOf(condition: unknown): unknown {
    const chunks = (condition as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? [];
    const param = chunks.find((chunk) => is(chunk, Param));
    return param ? (param as { value: unknown }).value : undefined;
  }

  function makeSelect() {
    let table: unknown;
    const builder = {
      from(t: unknown) {
        table = t;
        return builder;
      },
      for: () => builder,
      limit: () => builder,
      then(onFulfilled: (value: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) {
        const rows = table === schema.instanceUploadLimit && mocks.row ? [{ ...mocks.row }] : [];
        return Promise.resolve(rows).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  const fakeDb = {
    select: () => makeSelect(),
    insert: (table: unknown) => ({
      values(value: Record<string, unknown>) {
        if (table === schema.auditLog) mocks.auditRows.push(value as never);
        return Promise.resolve();
      },
    }),
    update: (table: unknown) => ({
      set(values: Record<string, unknown>) {
        return {
          where(condition: unknown) {
            return {
              returning() {
                if (table !== schema.instanceUploadLimit || !mocks.row) return Promise.resolve([]);
                if (mocks.row.version !== literalOf(condition)) return Promise.resolve([]);
                mocks.row = { ...mocks.row, ...values } as typeof mocks.row;
                return Promise.resolve([{ id: mocks.row.id }]);
              },
            };
          },
        };
      },
    }),
    async transaction(callback: (transaction: unknown) => Promise<unknown>) {
      const snapshot = mocks.row ? { ...mocks.row } : null;
      try {
        return await callback(fakeDb);
      } catch (error) {
        mocks.row = snapshot;
        throw error;
      }
    },
  };

  return { getDb: () => fakeDb };
});

vi.mock("@/server/authorization", () => ({
  requireInstanceAdministrator: async (userId: string) => {
    const { AppError } = await import("@/lib/app-error");
    if (!mocks.administrators.has(userId)) {
      throw new AppError("administrator_required", "Orbit administrator access is required", 403);
    }
  },
}));

import {
  readEffectiveUploadLimit,
  readUploadLimitSettings,
  resolveUploadLimit,
  setUploadLimit,
  uploadLimitBytesFromMegabytes,
} from "./upload-limit";
import { DOCUMENT_MAX_BYTES_CEILING, DOCUMENT_MAX_BYTES_FLOOR, type DocumentConfig } from "./documents/config";

function seedRow(overrides: Partial<NonNullable<typeof mocks.row>> = {}) {
  mocks.row = {
    singleton: true,
    id: "aaaaaaaa-0000-4000-8000-000000000049",
    maxBytes: null,
    version: 1,
    updatedAt: new Date("2026-10-07T00:00:00.000Z"),
    ...overrides,
  };
}

const configWith = (maxBytes: number) => ({ maxBytes }) as DocumentConfig;

afterEach(() => {
  mocks.administrators.clear();
  mocks.row = null;
  mocks.auditRows = [];
});

describe("the effective upload limit (#1285)", () => {
  it("is the configured default when no override is set", () => {
    expect(resolveUploadLimit(null, 50 * MIB)).toBe(50 * MIB);
    expect(resolveUploadLimit(undefined, 25 * MIB)).toBe(25 * MIB);
  });

  it("is the administrator's override when one is set, raising or lowering the default", () => {
    expect(resolveUploadLimit(10 * MIB, 50 * MIB)).toBe(10 * MIB);
    expect(resolveUploadLimit(80 * MIB, 50 * MIB)).toBe(80 * MIB);
    expect(resolveUploadLimit(DOCUMENT_MAX_BYTES_FLOOR, 50 * MIB)).toBe(MIB);
    expect(resolveUploadLimit(DOCUMENT_MAX_BYTES_CEILING, 50 * MIB)).toBe(100 * MIB);
  });

  it("falls back to the default, never wider, when a stored override is outside the hard bounds", () => {
    expect(resolveUploadLimit(MIB - 1, 50 * MIB)).toBe(50 * MIB);
    expect(resolveUploadLimit(100 * MIB + 1, 50 * MIB)).toBe(50 * MIB);
    expect(resolveUploadLimit(0, 50 * MIB)).toBe(50 * MIB);
  });

  it("takes whole MB from 1 to 100 and refuses anything else", () => {
    expect(uploadLimitBytesFromMegabytes(1)).toBe(MIB);
    expect(uploadLimitBytesFromMegabytes(100)).toBe(100 * MIB);
    for (const refused of [0, 101, 2.5, -1, Number.NaN]) {
      expect(() => uploadLimitBytesFromMegabytes(refused)).toThrow(expect.objectContaining({ code: "upload_limit_out_of_range", status: 422 }));
    }
  });

  it("is read fresh on every call, so a change applies to the next upload with no restart", async () => {
    seedRow();
    await expect(readEffectiveUploadLimit(configWith(50 * MIB))).resolves.toBe(50 * MIB);
    mocks.row!.maxBytes = 5 * MIB;
    await expect(readEffectiveUploadLimit(configWith(50 * MIB))).resolves.toBe(5 * MIB);
  });

  it("is the configured default on a database that has no row yet", async () => {
    await expect(readEffectiveUploadLimit(configWith(50 * MIB))).resolves.toBe(50 * MIB);
  });
});

describe("the administrator's upload limit setting (#1285)", () => {
  it("sets a limit and goes back to the configured default", async () => {
    mocks.administrators.add(ADMIN);
    seedRow();

    const initial = await readUploadLimitSettings(ADMIN);
    expect(initial).toMatchObject({ maxBytes: 50 * MIB, defaultBytes: 50 * MIB, overrideBytes: null, minBytes: MIB, ceilingBytes: 100 * MIB, version: 1 });

    const lowered = await setUploadLimit(ADMIN, 1, 2 * MIB);
    expect(lowered).toMatchObject({ maxBytes: 2 * MIB, overrideBytes: 2 * MIB, version: 2 });
    await expect(readEffectiveUploadLimit()).resolves.toBe(2 * MIB);

    const reset = await setUploadLimit(ADMIN, 2, null);
    expect(reset).toMatchObject({ maxBytes: 50 * MIB, overrideBytes: null, version: 3 });
    await expect(readEffectiveUploadLimit()).resolves.toBe(50 * MIB);
  });

  it("refuses a value outside the hard bounds, and it never reaches the row", async () => {
    mocks.administrators.add(ADMIN);
    seedRow({ maxBytes: 10 * MIB, version: 4 });
    for (const refused of [MIB - 1, 100 * MIB + 1, 0]) {
      await expect(setUploadLimit(ADMIN, 4, refused)).rejects.toMatchObject({ code: "upload_limit_out_of_range", status: 422 });
    }
    expect(mocks.row).toMatchObject({ maxBytes: 10 * MIB, version: 4 });
    expect(mocks.auditRows).toEqual([]);
  });

  it("refuses a stale version rather than silently overwriting a concurrent change", async () => {
    mocks.administrators.add(ADMIN);
    seedRow({ maxBytes: 10 * MIB, version: 5 });
    await expect(setUploadLimit(ADMIN, 4, 20 * MIB)).rejects.toMatchObject({ code: "upload_limit_version_conflict", status: 409 });
    expect(mocks.row?.maxBytes).toBe(10 * MIB);
  });

  it("refuses a non-administrator, for both the read and the write", async () => {
    seedRow();
    await expect(readUploadLimitSettings(OUTSIDER)).rejects.toMatchObject({ code: "administrator_required", status: 403 });
    await expect(setUploadLimit(OUTSIDER, 1, 2 * MIB)).rejects.toMatchObject({ code: "administrator_required", status: 403 });
    expect(mocks.row?.maxBytes).toBeNull();
  });

  it("audits a set and a reset against the row, with the old and new values", async () => {
    mocks.administrators.add(ADMIN);
    seedRow();
    await setUploadLimit(ADMIN, 1, 2 * MIB);
    await setUploadLimit(ADMIN, 2, null);
    expect(mocks.auditRows).toEqual([
      expect.objectContaining({ action: "instance_upload_limit_set", entityType: "instance_upload_limit", householdId: null, actorUserId: ADMIN, changes: { from: null, to: 2 * MIB } }),
      expect.objectContaining({ action: "instance_upload_limit_reset", changes: { from: 2 * MIB, to: null } }),
    ]);
  });
});
