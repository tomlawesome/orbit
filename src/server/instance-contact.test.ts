import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The instance's one public contact address (#860), against an in-memory
 * stand-in for the database.
 *
 * The integration suite (tests/integration/instance-contact.test.ts) proves
 * the same module, and the routes built on it, against real Postgres and a
 * real session; this one pins the decisions the module makes on its own: what
 * counts as a usable address, that a rejected value never reaches the row,
 * that a stale version is refused rather than silently overwritten, and that
 * the signed-out read takes no actor and touches nothing but this one row.
 */

const ADMIN = "11111111-1111-4111-8111-111111111111";
const OUTSIDER = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  administrators: new Set<string>(),
  row: null as null | { singleton: boolean; id: string; publicAddress: string | null; version: number; updatedAt: Date },
  auditRows: [] as Array<{ id: string; householdId: string | null; actorUserId: string | null; entityType: string; entityId: string; action: string; changes: unknown; createdAt: Date }>,
}));

vi.mock("@/db", async () => {
  const { is, Param } = await import("drizzle-orm");
  const { randomUUID } = await import("node:crypto");
  const schema = await import("@/db/schema");

  /** The only shape `eq()` is ever used with here: a column against a literal. */
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
        const rows = table === schema.instanceContact && mocks.row ? [{ ...mocks.row }] : [];
        return Promise.resolve(rows).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  const fakeDb = {
    select: () => makeSelect(),
    insert: (table: unknown) => ({
      values(value: Record<string, unknown>) {
        if (table === schema.auditLog) {
          mocks.auditRows.push({ id: randomUUID(), createdAt: new Date(), ...value } as never);
        }
        return Promise.resolve();
      },
    }),
    update: (table: unknown) => ({
      set(values: Record<string, unknown>) {
        return {
          where(condition: unknown) {
            return {
              returning(_projection?: unknown) {
                if (table !== schema.instanceContact || !mocks.row) return Promise.resolve([]);
                if (mocks.row.version !== literalOf(condition)) return Promise.resolve([]);
                mocks.row = { ...mocks.row, ...values } as typeof mocks.row;
                return Promise.resolve([{ id: mocks.row.id }]);
              },
            };
          },
        };
      },
    }),
    async transaction(callback: (transaction: typeof fakeDb) => Promise<unknown>) {
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
    const { AppError } = await import("@/lib/errors");
    if (!mocks.administrators.has(userId)) {
      throw new AppError("administrator_required", "Orbit administrator access is required", 403);
    }
  },
}));

import {
  readInstanceContactSettings,
  readPublicContactAddress,
  setPublicContactAddress,
} from "./instance-contact";

function seedRow(overrides: Partial<NonNullable<typeof mocks.row>> = {}) {
  mocks.row = {
    singleton: true,
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    publicAddress: null,
    version: 1,
    updatedAt: new Date("2026-09-06T00:00:00.000Z"),
    ...overrides,
  };
}

describe("the instance's one public contact address (#860)", () => {
  afterEach(() => {
    mocks.administrators.clear();
    mocks.row = null;
    mocks.auditRows = [];
  });

  it("sets, changes and clears the address, each readable from the signed-out door", async () => {
    mocks.administrators.add(ADMIN);
    seedRow();

    await expect(readPublicContactAddress()).resolves.toBeNull();

    const set = await setPublicContactAddress(ADMIN, 1, "ops@example.com");
    expect(set.address).toBe("ops@example.com");
    await expect(readPublicContactAddress()).resolves.toBe("ops@example.com");

    const changed = await setPublicContactAddress(ADMIN, set.version, "help@example.org");
    expect(changed.address).toBe("help@example.org");
    await expect(readPublicContactAddress()).resolves.toBe("help@example.org");

    const cleared = await setPublicContactAddress(ADMIN, changed.version, null);
    expect(cleared.address).toBeNull();
    await expect(readPublicContactAddress()).resolves.toBeNull();
  });

  it("lower-cases and trims a set address before it is stored", async () => {
    mocks.administrators.add(ADMIN);
    seedRow();
    const set = await setPublicContactAddress(ADMIN, 1, "  Ops@Example.COM  ");
    expect(set.address).toBe("ops@example.com");
  });

  it("never returns any account's own email -- the signed-out read touches nothing but this one row", async () => {
    seedRow({ publicAddress: "ops@example.com" });
    // The public read takes no actor at all: there is no parameter through
    // which any user's own account could even be named, let alone leaked.
    expect(readPublicContactAddress).toHaveLength(0);
    await expect(readPublicContactAddress()).resolves.toBe("ops@example.com");
  });

  it("refuses a rejected value, and it never reaches the row", async () => {
    mocks.administrators.add(ADMIN);
    seedRow({ publicAddress: "keep@example.com", version: 3 });

    await expect(setPublicContactAddress(ADMIN, 3, "not-an-address")).rejects.toMatchObject({
      code: "instance_contact_address_invalid",
      status: 422,
    });
    await expect(readPublicContactAddress()).resolves.toBe("keep@example.com");
    expect(mocks.row?.version).toBe(3);
    expect(mocks.auditRows).toEqual([]);
  });

  it("refuses a stale version rather than silently overwriting a concurrent change", async () => {
    mocks.administrators.add(ADMIN);
    seedRow({ publicAddress: "first@example.com", version: 5 });

    await expect(setPublicContactAddress(ADMIN, 4, "second@example.com")).rejects.toMatchObject({
      code: "instance_contact_version_conflict",
      status: 409,
    });
    await expect(readPublicContactAddress()).resolves.toBe("first@example.com");
  });

  it("refuses a non-administrator, for both the read and the write", async () => {
    seedRow();
    await expect(readInstanceContactSettings(OUTSIDER)).rejects.toMatchObject({
      code: "administrator_required",
      status: 403,
    });
    await expect(setPublicContactAddress(OUTSIDER, 1, "ops@example.com")).rejects.toMatchObject({
      code: "administrator_required",
      status: 403,
    });
    await expect(readPublicContactAddress()).resolves.toBeNull();
  });

  it("audits a set and a clear as distinct, human-legible actions", async () => {
    mocks.administrators.add(ADMIN);
    seedRow();

    await setPublicContactAddress(ADMIN, 1, "ops@example.com");
    await setPublicContactAddress(ADMIN, 2, null);

    expect(mocks.auditRows.map((row) => row.action)).toEqual([
      "instance_contact_address_set",
      "instance_contact_address_cleared",
    ]);
    expect(mocks.auditRows.every((row) => row.actorUserId === ADMIN)).toBe(true);
  });
});
