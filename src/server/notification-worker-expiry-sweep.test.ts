import { beforeEach, describe, expect, it } from "vitest";
import { items, dueEvents, reminderRules, auditLog } from "@/db/schema";
import { EXPIRY_LINGER_DAYS, sweepEndedExpiries } from "./notification-worker";

/**
 * The daily expiry sweep's own compare-and-set (#1151 A4-S2), against an
 * in-memory stand-in for the database.
 *
 * WHAT THIS PINS. The sweep reads a batch of overdue expiry events, then
 * writes each one in its own transaction. The write used to re-check only
 * `items.status`, so an item RESCHEDULED between the read and that item's
 * write -- which moves the SAME `due_events` row's `due_date` in place
 * (`workspace-repository.ts`'s reschedule path) -- still looked active and
 * was flipped to `expired` anyway, taking the fresh reminder rules the
 * reschedule had just written with it. The fix re-reads the row inside the
 * write's own transaction and compares it against the date the sweep
 * actually read; this suite is what tells the two apart.
 *
 * THE FAKE is scoped to this module's one join shape (`items.id =
 * due_events.item_id`) and the handful of flat `and`-joined conditions the
 * sweep's two queries use -- not a general SQL evaluator.
 */

type Row = Record<string, unknown>;

const store = {
  items: [] as Row[],
  dueEvents: [] as Row[],
  reminderRules: [] as Row[],
  auditLog: [] as Row[],
};

function reset(): void {
  store.items.length = 0;
  store.dueEvents.length = 0;
  store.reminderRules.length = 0;
  store.auditLog.length = 0;
}

function columnKeys(table: Record<string, { name?: string }>): Map<string, string> {
  const keys = new Map<string, string>();
  for (const [property, column] of Object.entries(table)) {
    if (column && typeof column === "object" && typeof column.name === "string") keys.set(column.name, property);
  }
  return keys;
}

const itemKeys = columnKeys(items as unknown as Record<string, { name?: string }>);
const dueEventKeys = columnKeys(dueEvents as unknown as Record<string, { name?: string }>);
const reminderRuleKeys = columnKeys(reminderRules as unknown as Record<string, { name?: string }>);
const tableKeyMaps = new Map<unknown, Map<string, string>>([
  [items, itemKeys],
  [dueEvents, dueEventKeys],
  [reminderRules, reminderRuleKeys],
]);

/** The condition, flattened to [column | operator | value] in written order -- see the sibling fakes in this suite for why a flat stream is enough when a query has no `or`. */
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
  if (typeof column.name === "string" && column.table) out.push({ column: column.name, table: column.table });
  return out;
}

/**
 * `joined` rows (from `joinedRows()`, used only by `select`) carry `items`'
 * columns under an `item.` prefix so they can sit alongside `due_events`'
 * own, bare, in one pseudo-row; a plain single-table row (`update`/`delete`)
 * has no such prefix regardless of which table it is. Conflating the two
 * was this fake's own first bug: an `update(items)...where(eq(items.id,
 * ...))` always missed, against a PLAIN items row, because it went looking
 * for `item.id`.
 */
function heldValue(row: Row, column: string, table: unknown, joined: boolean): unknown {
  const keys = tableKeyMaps.get(table) ?? dueEventKeys;
  const resolved = keys.get(column) ?? column;
  return joined && table === items ? row[`item.${resolved}`] : row[resolved];
}

function matches(row: Row, condition: unknown, joined = false): boolean {
  const stream = tokens(condition) as Array<{ op?: string; value?: unknown; column?: string; table?: unknown }>;
  let verdict = true;
  for (let at = 0; at < stream.length; at += 1) {
    const entry = stream[at];
    if (entry.column === undefined) continue;
    const held = heldValue(row, entry.column, entry.table, joined);
    const operator = stream[at + 1]?.op ?? "";
    if (operator === "is null") verdict &&= held === null || held === undefined;
    else if (operator === "is not null") verdict &&= held !== null && held !== undefined;
    else if (operator === "=") verdict &&= String(held) === String(stream[at + 2]?.value);
    else if (operator === "<") verdict &&= String(held) < String(stream[at + 2]?.value);
    else throw new Error(`the fake database does not implement "${operator}"`);
  }
  return verdict;
}

function project(row: Row, selection: Record<string, unknown>, joined = true): Row {
  const out: Row = {};
  for (const [alias, column] of Object.entries(selection)) {
    const table = (column as { table?: unknown }).table;
    const name = (column as { name?: string }).name;
    out[alias] = name ? heldValue(row, name, table, joined) : undefined;
  }
  return out;
}

/** `due_events` joined to `items` (this module's one join shape), as one flat pseudo-row carrying both tables' columns -- items' under an `item.` prefix, due_events' bare. */
function joinedRows(): Row[] {
  return store.dueEvents.flatMap((event) => {
    const item = store.items.find((candidate) => candidate.id === event.itemId);
    if (!item) return [];
    const prefixed: Row = {};
    for (const [key, value] of Object.entries(item)) prefixed[`item.${key}`] = value;
    return [{ ...event, ...prefixed }];
  });
}

/**
 * Fires exactly once, right before the NEXT select whose condition is not
 * the batch query (it carries no `<`, the one operator only the batch's
 * `lt(dueDate, boundary)` produces) -- i.e. right before the per-row
 * compare-and-set recheck `sweepEndedExpiries` runs inside each item's own
 * transaction. Lets a test land a concurrent write exactly between the
 * batch read and that item's own recheck, which is the window #1151 A4-S2
 * is about.
 */
let onBeforeRecheck: (() => void) | null = null;

function select(selection: Record<string, unknown>) {
  let condition: unknown = null;
  const builder = {
    from() { return builder; },
    innerJoin() { return builder; },
    where(where: unknown) { condition = where; return builder; },
    for() { return builder; },
    limit() { return builder; },
    then(resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) {
      try {
        const isBatchQuery = tokens(condition).some((token) => (token as { op?: string }).op === "<");
        if (!isBatchQuery && onBeforeRecheck) {
          const hook = onBeforeRecheck;
          onBeforeRecheck = null;
          hook();
        }
        const found = joinedRows().filter((row) => condition === null || matches(row, condition, true));
        return Promise.resolve(found.map((row) => project(row, selection))).then(resolve, reject);
      } catch (error) {
        return Promise.resolve().then(() => { throw error; }).then(resolve, reject);
      }
    },
  };
  return builder;
}

function update(table: unknown) {
  let values: Row = {};
  let condition: unknown = null;
  const rows = table === items ? store.items : table === dueEvents ? store.dueEvents : null;
  if (!rows) throw new Error("the fake database was handed a table it does not hold for update");
  const apply = () => {
    // These updates are keyed on the row's own id, never on a joined
    // condition, so matching against the bare (non-prefixed) row is exactly
    // what the real column names resolve to here.
    const touched = rows.filter((row) => condition === null || matches(row, condition));
    for (const row of touched) {
      for (const [key, value] of Object.entries(values)) {
        row[key] = value && typeof value === "object" && (value as { constructor?: { name?: string } }).constructor?.name === "SQL"
          ? Number(row[key] ?? 0) + 1
          : value;
      }
    }
    return touched;
  };
  const builder = {
    set(next: Row) { values = next; return builder; },
    where(where: unknown) { condition = where; return builder; },
    returning(selection: Record<string, unknown>) {
      return Promise.resolve(apply().map((row) => project(row, selection, false)));
    },
    then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
      try {
        apply();
        return Promise.resolve([]).then(resolve, reject);
      } catch (error) {
        return Promise.resolve().then(() => { throw error; }).then(resolve, reject);
      }
    },
  };
  return builder;
}

function del(table: unknown) {
  let condition: unknown = null;
  const rows = table === reminderRules ? store.reminderRules : null;
  if (!rows) throw new Error("the fake database was handed a table it does not hold for delete");
  const builder = {
    where(where: unknown) {
      condition = where;
      const keep = rows.filter((row) => !(condition === null || matches(row, condition)));
      rows.length = 0;
      rows.push(...keep);
      return Promise.resolve();
    },
  };
  return builder;
}

function insert(table: unknown) {
  const rows = table === auditLog ? store.auditLog : null;
  if (!rows) throw new Error("the fake database was handed a table it does not hold for insert");
  return {
    values(value: Row) {
      rows.push(value);
      return { onConflictDoNothing: () => Promise.resolve() };
    },
  };
}

const fakeDb = {
  select,
  update,
  delete: del,
  insert,
  transaction: (body: (executor: unknown) => unknown) => Promise.resolve(body(fakeDb)),
};

function fakeDatabase(): Parameters<typeof sweepEndedExpiries>[0] {
  return fakeDb as unknown as Parameters<typeof sweepEndedExpiries>[0];
}

const NOW = new Date("2026-09-20T09:00:00.000Z");
const LONG_OVERDUE = new Date(NOW.getTime() - (EXPIRY_LINGER_DAYS + 5) * 86_400_000).toISOString().slice(0, 10);

function seedOverdueItem(overrides: { itemStatus?: string; dueDate?: string } = {}): { itemId: string; eventId: string } {
  const itemId = "11111111-1111-4111-8111-111111111111";
  const eventId = "22222222-2222-4222-8222-222222222222";
  store.items.push({ id: itemId, householdId: "household-1", status: overrides.itemStatus ?? "active", version: 1 });
  store.dueEvents.push({
    id: eventId,
    householdId: "household-1",
    itemId,
    kind: "expiry",
    dueDate: overrides.dueDate ?? LONG_OVERDUE,
    completedAt: null,
  });
  store.reminderRules.push({ id: "rule-1", itemId, daysBefore: 3, emailEnabled: true, pushEnabled: true });
  return { itemId, eventId };
}

describe("sweepEndedExpiries's compare-and-set (#1151 A4-S2)", () => {
  beforeEach(() => {
    reset();
    onBeforeRecheck = null;
  });

  it("expires an item whose overdue expiry never changed", async () => {
    const { itemId } = seedOverdueItem();

    const swept = await sweepEndedExpiries(fakeDatabase(), NOW);

    expect(swept).toBe(1);
    expect(store.items.find((row) => row.id === itemId)?.status).toBe("expired");
    expect(store.dueEvents[0].completedAt).not.toBeNull();
    expect(store.reminderRules).toHaveLength(0);
    expect(store.auditLog).toHaveLength(1);
  });

  it("does not expire an item rescheduled to a fresh date after the sweep read it", async () => {
    const { itemId } = seedOverdueItem();
    const fresh = new Date(NOW.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);

    // Lands exactly between the batch read (which still sees the overdue
    // row) and this item's own compare-and-set recheck -- the same window a
    // real concurrent reschedule would land in. The reschedule moves the
    // SAME due_events row's date in place and adds a fresh reminder rule,
    // exactly as `workspace-repository.ts`'s reschedule path does.
    onBeforeRecheck = () => {
      store.dueEvents[0].dueDate = fresh;
      store.reminderRules.push({ id: "rule-2", itemId, daysBefore: 14, emailEnabled: true, pushEnabled: true });
    };

    const swept = await sweepEndedExpiries(fakeDatabase(), NOW);

    expect(swept).toBe(0);
    expect(store.items.find((row) => row.id === itemId)?.status).toBe("active");
    expect(store.dueEvents[0].completedAt).toBeNull();
    // The fresh rule survives: the old guard deleted every rule for the
    // item unconditionally once it (wrongly) decided to expire it.
    expect(store.reminderRules).toHaveLength(2);
    expect(store.auditLog).toHaveLength(0);
  });

  it("does not expire an item that stopped being active after the sweep read it", async () => {
    const { itemId } = seedOverdueItem();
    store.items.find((row) => row.id === itemId)!.status = "retired";

    const swept = await sweepEndedExpiries(fakeDatabase(), NOW);

    expect(swept).toBe(0);
    expect(store.items.find((row) => row.id === itemId)?.status).toBe("retired");
  });
});
