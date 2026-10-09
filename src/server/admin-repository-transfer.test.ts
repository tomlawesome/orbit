import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Primary-administrator transfer's own eligibility check (#1151 SS1-S1),
 * against an in-memory stand-in for the database.
 *
 * WHAT THIS PINS. The check used to ask only "does the target have a row in
 * `external_identities`", never whether the provider that row belongs to is
 * still switched on -- unlike the symmetric unlink checks in
 * `local-credentials.ts`, which already refuse to leave a reader with
 * nothing but an identity row for a disabled provider. A target whose only
 * sign-in method was a leftover identity from a provider the owner had since
 * turned off passed the old check and could receive primary authority with
 * no way to actually sign in and use it.
 */

const ACTOR = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  users: [] as Row[],
  instanceAuthority: { primaryUserId: null as string | null },
  externalIdentities: [] as Row[],
  localCredentials: [] as Row[],
  auditLog: [] as Row[],
  identitiesUsable: true,
}));

const requireInstanceAdministrator = vi.hoisted(() => vi.fn(async () => undefined));
// Only the list guard is stubbed: the in-transaction actor check
// (requireActiveAdministrator) runs for real against the fake database below.
vi.mock("@/server/authorization", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/authorization")>(),
  requireInstanceAdministrator,
}));

vi.mock("@/server/local-credentials", () => ({
  identitiesAreUsable: () => mocks.identitiesUsable,
}));

vi.mock("@/server/metadata/fields", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/metadata/fields")>();
  return {
    ...original,
    // Every address in this suite is plaintext, so an unlocked reader over
    // no key is all the post-transfer `listInstanceUsers` read needs.
    openInstanceMetadataReader: async () => new original.MetadataCipher(undefined),
  };
});

vi.mock("@/db", async () => {
  const schema = await import("@/db/schema");

  function columnKeys(table: Record<string, { name?: string }>): Map<string, string> {
    const keys = new Map<string, string>();
    for (const [property, column] of Object.entries(table)) {
      if (column && typeof column === "object" && typeof column.name === "string") keys.set(column.name, property);
    }
    return keys;
  }

  function rowsFor(table: unknown): Row[] | null {
    if (table === schema.users) return mocks.users;
    if (table === schema.externalIdentities) return mocks.externalIdentities;
    if (table === schema.localCredentials) return mocks.localCredentials;
    if (table === schema.auditLog) return mocks.auditLog;
    return null;
  }

  /** The condition, flattened to [column | operator | value] -- every query
   *  this module runs is a single flat `eq`, if it has a condition at all. */
  function tokens(node: unknown, out: unknown[] = []): unknown[] {
    if (node === null || node === undefined) return out;
    const shape = (node as { constructor?: { name?: string } }).constructor?.name;
    if (shape === "SQL") {
      for (const chunk of (node as { queryChunks: unknown[] }).queryChunks) tokens(chunk, out);
      return out;
    }
    if (shape === "StringChunk") {
      for (const piece of (node as { value: string[] }).value) {
        const word = piece.trim();
        if (word && word !== "(" && word !== ")") out.push({ op: word });
      }
      return out;
    }
    if (shape === "Param") {
      out.push({ value: (node as { value: unknown }).value });
      return out;
    }
    const column = node as { name?: string; table?: unknown };
    if (typeof column.name === "string" && column.table) out.push({ column: column.name });
    return out;
  }

  function matches(row: Row, condition: unknown, keys: Map<string, string>): boolean {
    const stream = tokens(condition) as Array<{ op?: string; value?: unknown; column?: string }>;
    let verdict = true;
    for (let at = 0; at < stream.length; at += 1) {
      const column = stream[at].column;
      if (column === undefined) continue;
      const held = row[keys.get(column) ?? column];
      const operator = stream[at + 1]?.op ?? "";
      if (operator === "=") verdict &&= String(held) === String(stream[at + 2]?.value);
      else throw new Error(`the fake database does not implement "${operator}"`);
    }
    return verdict;
  }

  function project(row: Row, selection: Record<string, unknown>, keys: Map<string, string>): Row {
    const out: Row = {};
    for (const [alias, column] of Object.entries(selection)) {
      const name = (column as { name?: string }).name;
      out[alias] = name ? row[keys.get(name) ?? name] : undefined;
    }
    return out;
  }

  function select(selection: Record<string, unknown>) {
    let table: unknown;
    let condition: unknown = null;
    let limit = Number.POSITIVE_INFINITY;
    const builder = {
      from(from: unknown) { table = from; return builder; },
      where(where: unknown) { condition = where; return builder; },
      orderBy() { return builder; },
      limit(count: number) { limit = count; return builder; },
      then(resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) {
        try {
          if (table === schema.instanceAuthority) {
            return Promise.resolve([{ primaryUserId: mocks.instanceAuthority.primaryUserId }]).then(resolve, reject);
          }
          if (table === schema.users && "totalCount" in selection) {
            return Promise.resolve([{ totalCount: mocks.users.length }]).then(resolve, reject);
          }
          const rows = rowsFor(table);
          if (!rows) throw new Error("the fake database was handed a table it does not hold");
          const keys = columnKeys(table as Record<string, { name?: string }>);
          const found = rows.filter((row) => condition === null || matches(row, condition, keys)).slice(0, limit);
          return Promise.resolve(found.map((row) => project(row, selection, keys))).then(resolve, reject);
        } catch (error) {
          return Promise.resolve().then(() => { throw error; }).then(resolve, reject);
        }
      },
    };
    return builder;
  }

  function update(table: unknown) {
    let values: Row = {};
    const builder = {
      set(next: Row) { values = next; return builder; },
      where() { return builder; },
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        try {
          if (table === schema.instanceAuthority) {
            mocks.instanceAuthority.primaryUserId = values.primaryUserId as string;
          }
          return Promise.resolve([]).then(resolve, reject);
        } catch (error) {
          return Promise.resolve().then(() => { throw error; }).then(resolve, reject);
        }
      },
    };
    return builder;
  }

  function insert(table: unknown) {
    return {
      values(value: Row) {
        if (table === schema.auditLog) mocks.auditLog.push(value);
        return Promise.resolve();
      },
    };
  }

  const db = {
    select,
    update,
    insert,
    execute: () => Promise.resolve([]),
    transaction: (body: (executor: unknown) => unknown) => Promise.resolve(body(db)),
  };
  return { getDb: () => db };
});

const { transferPrimaryAdministrator } = await import("@/server/admin-repository");

function recentAuthentication(userId: string) {
  return { userId, intent: "primary_transfer" as const, method: "password" as const };
}

function adminRow(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    displayName: id,
    email: `${id}@example.invalid`,
    emailEnc: null,
    isInstanceAdmin: true,
    disabledAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.users = [adminRow(ACTOR), adminRow(TARGET)];
  mocks.instanceAuthority = { primaryUserId: ACTOR };
  mocks.externalIdentities = [];
  mocks.localCredentials = [];
  mocks.auditLog = [];
  mocks.identitiesUsable = true;
  requireInstanceAdministrator.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("transferPrimaryAdministrator's eligibility check (#1151 SS1-S1)", () => {
  it("refuses a target whose only sign-in method is an identity from a now-disabled provider", async () => {
    mocks.externalIdentities = [{ id: "identity-1", userId: TARGET }];
    mocks.identitiesUsable = false;

    await expect(transferPrimaryAdministrator(ACTOR, recentAuthentication(ACTOR), TARGET))
      .rejects.toMatchObject({ code: "transfer_target_ineligible", status: 409 });
    // Refused before any write: the primary authority never moved.
    expect(mocks.instanceAuthority.primaryUserId).toBe(ACTOR);
    expect(mocks.auditLog).toEqual([]);
  });

  it("allows a target whose identity's provider is still switched on", async () => {
    mocks.externalIdentities = [{ id: "identity-1", userId: TARGET }];
    mocks.identitiesUsable = true;

    await transferPrimaryAdministrator(ACTOR, recentAuthentication(ACTOR), TARGET);

    expect(mocks.instanceAuthority.primaryUserId).toBe(TARGET);
    expect(mocks.auditLog).toHaveLength(1);
  });

  it("allows a target with a password, whether or not any provider is usable", async () => {
    mocks.localCredentials = [{ userId: TARGET }];
    mocks.identitiesUsable = false;

    await transferPrimaryAdministrator(ACTOR, recentAuthentication(ACTOR), TARGET);

    expect(mocks.instanceAuthority.primaryUserId).toBe(TARGET);
  });

  it("still refuses a target with no sign-in method at all", async () => {
    await expect(transferPrimaryAdministrator(ACTOR, recentAuthentication(ACTOR), TARGET))
      .rejects.toMatchObject({ code: "transfer_target_ineligible", status: 409 });
  });
});

describe("transferPrimaryAdministrator's return (#1151 A1-Q1)", () => {
  it("builds the post-transfer list without re-running the admin check its own transaction already passed", async () => {
    mocks.localCredentials = [{ userId: TARGET }];

    await transferPrimaryAdministrator(ACTOR, recentAuthentication(ACTOR), TARGET);

    // The transaction above verified the actor directly against `users`;
    // `requireInstanceAdministrator` is only `listInstanceUsers`'s own guard,
    // so a call here would mean the return value re-asked a question this
    // function had just answered for the same actor.
    expect(requireInstanceAdministrator).not.toHaveBeenCalled();
  });
});
