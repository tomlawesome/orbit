import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `applyWorkspaceCommand`'s "item.upsert" optimistic-concurrency guard
 * (#1151 A4-S4), against an in-memory stand-in for the two tables that
 * guard touches before it ever reaches encryption or the rest of
 * `readWorkspace`'s own, much larger, surface.
 *
 * This file intentionally stops at that guard: `readWorkspace` joins nine
 * tables and runs every row through `workspaceSchema.parse`, and this
 * module carries no fast-suite coverage of that path today (its
 * multi-table shape is the integration suite's job, the same way
 * `acquireActiveHouseholdLock`'s callers are). What is pinned here is the
 * one thing a fake this small can state plainly: a write with no version
 * for a row that already has one is refused, not silently accepted.
 */

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  sections: [] as Row[],
  items: [] as Row[],
}));

vi.mock("@/server/workspace-access", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/workspace-access")>();
  return {
    ...original,
    // The lock and the membership check are real Postgres/real-table
    // concerns the integration suite already proves; this test is only
    // about what happens once both have already let the write through.
    requireHouseholdAccess: async () => {},
    acquireActiveHouseholdLock: async () => {},
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

  function rowsFor(table: unknown): Row[] {
    if (table === schema.sections) return store.sections;
    if (table === schema.items) return store.items;
    throw new Error("the fake database was handed a table it does not hold");
  }

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

  function select(selection: Record<string, unknown> | undefined) {
    let table: unknown;
    let condition: unknown = null;
    const builder = {
      from(from: unknown) { table = from; return builder; },
      where(where: unknown) { condition = where; return builder; },
      limit() { return builder; },
      then(resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) {
        const keys = columnKeys(table as Record<string, { name?: string }>);
        const found = rowsFor(table).filter((row) => condition === null || matches(row, condition, keys));
        const project = (row: Row) => {
          if (!selection) return { ...row };
          const out: Row = {};
          for (const [alias, column] of Object.entries(selection)) {
            const name = (column as { name?: string }).name;
            out[alias] = name ? row[keys.get(name) ?? name] : undefined;
          }
          return out;
        };
        return Promise.resolve().then(() => found.map(project)).then(resolve, reject);
      },
    };
    return builder;
  }

  function transaction(body: (executor: unknown) => unknown) {
    return Promise.resolve(body({ select }));
  }

  return { getDb: () => ({ select, transaction }) };
});

const { applyWorkspaceCommand } = await import("@/server/workspace-repository");

const USER = "22222222-2222-4222-8222-222222222222";
const SESSION = "11111111-1111-4111-8111-111111111111";
const HOUSEHOLD = "33333333-3333-4333-8333-333333333333";
const SECTION = "44444444-4444-4444-8444-444444444444";
const ITEM = "55555555-5555-4555-8555-555555555555";

beforeEach(() => {
  store.sections = [{ id: SECTION, householdId: HOUSEHOLD }];
  store.items = [{ id: ITEM, householdId: HOUSEHOLD, version: 3 }];
});

describe("applyWorkspaceCommand item.upsert (#1151 A4-S4)", () => {
  it("refuses to update an existing item with no version, rather than matching whatever the row already has", async () => {
    const command = {
      type: "item.upsert",
      householdId: HOUSEHOLD,
      item: {
        id: ITEM,
        sectionId: SECTION,
        title: "Boiler service",
        currency: "GBP",
        status: "active",
        // version intentionally omitted: the bug let this always win.
      },
    };

    await expect(applyWorkspaceCommand(USER, SESSION, command as never))
      .rejects.toMatchObject({ code: "version_required" });
  });
});
