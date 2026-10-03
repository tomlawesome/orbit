import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The backfill's own arithmetic (#1151 A3-F1, A3-R3), against an in-memory
 * stand-in for the database.
 *
 * WHAT THIS PINS. `runMetadataBackfillBatch` selects a row when ANY ONE of
 * its plaintext/encrypted column pairs is still unconverted, but used to
 * update it only when ALL of them were -- so a row with one pair already
 * converted on its own (the draft-approval path encrypts `items.reference`
 * by itself, independently of this job) matched the select forever and the
 * update never, and `backfillComplete` -- which only counts conversions --
 * would call the job done with that row still plaintext. This suite pins
 * that each column pair now converts on its own. It also pins that a batch
 * that throws is actually retried, on a bounded back-off, rather than the
 * drain loop quietly never running again. The migration, the real crypto and
 * the key hierarchy are the integration suite's job
 * (`tests/integration/metadata-tier1.test.ts` and `metadata-tier2.test.ts`).
 *
 * THE FAKE evaluates the actual condition tree `and`/`or`/`eq`/`isNull`/
 * `isNotNull` build, recursively, because this module's select queries
 * genuinely disjoin across column pairs -- a flat, order-independent token
 * stream (as the lighter fakes elsewhere in this suite use) cannot tell "any
 * one of five" from "all five".
 */

type Row = Record<string, unknown>;

const KEY = { scope: "instance" as const, householdId: null, keyId: "test-key", dataKey: Buffer.alloc(32, 7) };

const store = vi.hoisted(() => ({
  items: [] as Row[],
  receipts: [] as Row[],
  invitations: [] as Row[],
  users: [] as Row[],
  senderAddresses: [] as Row[],
  /** How many more `getDb()` calls should hand back a transaction that
   *  rejects, for the retry test below (#1151 A3-R3). */
  failingCallsRemaining: 0,
  /** Every `getDb()` call, failing or not -- the retry test's clock. */
  dbCalls: 0,
}));

vi.mock("@/server/metadata/keys", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/metadata/keys")>();
  return {
    ...original,
    // One fixed key for every scope: what this suite pins is the batch's own
    // row-by-row arithmetic, not the key hierarchy (that is #954/#955's own
    // integration coverage).
    resolveMetadataKey: async () => KEY,
  };
});

vi.mock("@/db", async () => {
  const schema = await import("@/db/schema");

  function rowsFor(table: unknown): Row[] {
    if (table === schema.items) return store.items;
    if (table === schema.imapIngestionMessages) return store.receipts;
    if (table === schema.householdInvitations) return store.invitations;
    if (table === schema.users) return store.users;
    if (table === schema.mailInSenderAddresses) return store.senderAddresses;
    throw new Error("the fake database was handed a table it does not hold");
  }

  function columnKeys(table: Record<string, { name?: string }>): Map<string, string> {
    const keys = new Map<string, string>();
    for (const [property, column] of Object.entries(table)) {
      if (column && typeof column === "object" && typeof column.name === "string") keys.set(column.name, property);
    }
    return keys;
  }

  /** Evaluates the real condition tree `and`/`or`/`eq`/`isNull`/`isNotNull`/the
   *  jsonb "not empty" check build, recursively -- see the file doc comment
   *  for why a flat token stream cannot stand in for this module's queries. */
  function evalNode(node: unknown, row: Row, keys: Map<string, string>): boolean {
    const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
    if (!chunks) throw new Error("the fake database was handed something that is not a condition");

    /* Pure structural noise: the parens `and`/`or` wrap their operands in,
       and the empty leading chunk every leaf comparison starts with. */
    const isNoise = (chunk: unknown): boolean => {
      const ctor = (chunk as { constructor?: { name?: string } }).constructor?.name;
      if (ctor !== "StringChunk") return false;
      const text = (chunk as { value: string[] }).value.join("").trim();
      return text === "" || text === "(" || text === ")";
    };
    const significant = chunks.filter((chunk) => !isNoise(chunk));

    /* Three or more operands nest as one further SQL node holding the whole
       operand/join/operand sequence, wrapped in its own parens -- unwrap it
       rather than mistaking the wrapper for a leaf. */
    if (significant.length === 1 && (significant[0] as { constructor?: { name?: string } }).constructor?.name === "SQL") {
      return evalNode(significant[0], row, keys);
    }

    const joinAt = significant.findIndex((chunk) => joinWord(chunk) !== null);

    if (joinAt === -1) {
      let column: string | undefined;
      let operatorText = "";
      let param: unknown;
      for (const chunk of chunks) {
        const ctor = (chunk as { constructor?: { name?: string } }).constructor?.name;
        if (ctor === "StringChunk") {
          operatorText += (chunk as { value: string[] }).value.join("");
        } else if (ctor === "Param") {
          param = (chunk as { value: unknown }).value;
        } else {
          const asColumn = chunk as { name?: string; table?: unknown };
          if (typeof asColumn.name === "string" && asColumn.table) column = asColumn.name;
        }
      }
      const held = row[keys.get(column ?? "") ?? column ?? ""];
      const operator = operatorText.trim();
      if (operator === "is null") return held === null || held === undefined;
      if (operator === "is not null") return held !== null && held !== undefined;
      if (operator === "=") return String(held) === String(param);
      if (operator === "<> '{}'::jsonb") return hasJsonContent(held);
      throw new Error(`the fake database does not implement "${operator}"`);
    }

    const operator = joinWord(significant[joinAt]);
    // A single and()/or() call joins every operand with the SAME word, so
    // dropping every chunk that word matches (not just the first) leaves
    // exactly the operands, however many there are.
    const operands = significant.filter((chunk) => joinWord(chunk) !== operator);
    const results = operands.map((operand) => evalNode(operand, row, keys));
    return operator === "and" ? results.every(Boolean) : results.some(Boolean);
  }

  function joinWord(chunk: unknown): string | null {
    const ctor = (chunk as { constructor?: { name?: string } }).constructor?.name;
    if (ctor !== "StringChunk") return null;
    const text = (chunk as { value: string[] }).value.join("").trim();
    return text === "and" || text === "or" ? text : null;
  }

  function hasJsonContent(value: unknown): boolean {
    return value !== null && typeof value === "object" && Object.keys(value as Record<string, unknown>).length > 0;
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
    const builder = {
      from(from: unknown) { table = from; return builder; },
      where(where: unknown) { condition = where; return builder; },
      limit() { return builder; },
      then(resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) {
        try {
          const rows = rowsFor(table);
          const keys = columnKeys(table as Record<string, { name?: string }>);
          const found = rows.filter((row) => condition === null || evalNode(condition, row, keys));
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
    let condition: unknown = null;
    const builder = {
      set(next: Row) { values = next; return builder; },
      where(where: unknown) { condition = where; return builder; },
      returning(selection: Record<string, unknown>) {
        const keys = columnKeys(table as Record<string, { name?: string }>);
        const touched = rowsFor(table).filter((row) => condition === null || evalNode(condition, row, keys));
        touched.forEach((row) => Object.assign(row, values));
        return Promise.resolve(touched.map((row) => project(row, selection, keys)));
      },
    };
    return builder;
  }

  const db = {
    select,
    update,
    transaction: (body: (executor: unknown) => unknown) => Promise.resolve(body(db)),
  };
  const failingDb = { transaction: () => Promise.reject(new Error("connection reset")) };
  return {
    getDb: () => {
      store.dbCalls += 1;
      if (store.failingCallsRemaining > 0) {
        store.failingCallsRemaining -= 1;
        return failingDb;
      }
      return db;
    },
  };
});

const {
  backfillComplete,
  backfillRetryDelayMs,
  BACKFILL_RETRY_CEILING_MS,
  BACKFILL_RETRY_FLOOR_MS,
  BACKFILL_RETRY_SURFACE_THRESHOLD,
  runMetadataBackfillBatch,
  startMetadataBackfill,
} = await import("@/server/metadata/backfill");

const HOUSEHOLD = "33333333-3333-4333-8333-333333333333";

function itemRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "item-1",
    householdId: HOUSEHOLD,
    reference: null,
    referenceEnc: null,
    referenceIndex: null,
    notes: null,
    notesEnc: null,
    title: null,
    titleEnc: null,
    provider: null,
    providerEnc: null,
    costMinor: null,
    costMinorEnc: null,
    ...overrides,
  };
}

function receiptRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "receipt-1",
    householdId: HOUSEHOLD,
    proposal: {},
    proposalEnc: null,
    fieldEvidence: {},
    fieldEvidenceEnc: null,
    ...overrides,
  };
}

beforeEach(() => {
  store.items.length = 0;
  store.receipts.length = 0;
  store.invitations.length = 0;
  store.users.length = 0;
  store.senderAddresses.length = 0;
});

describe("one column pair converting independently of the rest (#1151 A3-F1)", () => {
  it("still converts the pair that is outstanding on an item with another pair already converted", async () => {
    // `referenceEnc` is already set, as the draft-approval path leaves it --
    // and `reference` is already cleared, per this file's own invariant that
    // a converted pair never leaves plaintext behind. `notes` is still
    // outstanding.
    store.items.push(itemRow({
      referenceEnc: "mdv1.already-converted",
      notes: "Written before encryption",
    }));

    const batch = await runMetadataBackfillBatch(100);

    expect(batch.items).toBe(1);
    expect(store.items[0].notes).toBeNull();
    expect((store.items[0].notesEnc as string).startsWith("mdv1.")).toBe(true);
    // The pair that was already converted is left exactly as it was.
    expect(store.items[0].referenceEnc).toBe("mdv1.already-converted");

    // Resumable and idempotent (as the integration suite also pins): a
    // second run finds nothing left to do, and says so.
    const second = await runMetadataBackfillBatch(100);
    expect(second.items).toBe(0);
    expect(backfillComplete(second)).toBe(true);
  });

  it("converts the outstanding JSON pair on a receipt with the other already converted", async () => {
    store.receipts.push(receiptRow({
      proposalEnc: "mdv1.already-converted",
      fieldEvidence: { title: { source: "subject", confidence: "high" } },
    }));

    const batch = await runMetadataBackfillBatch(100);

    expect(batch.receipts).toBe(1);
    expect(store.receipts[0].fieldEvidence).toEqual({});
    expect((store.receipts[0].fieldEvidenceEnc as string).startsWith("mdv1.")).toBe(true);
    expect(store.receipts[0].proposalEnc).toBe("mdv1.already-converted");

    const second = await runMetadataBackfillBatch(100);
    expect(second.receipts).toBe(0);
  });

  it("leaves an empty receipt draft alone rather than encrypting an empty object", async () => {
    store.receipts.push(receiptRow({ proposalEnc: "mdv1.already-converted" }));

    const batch = await runMetadataBackfillBatch(100);

    expect(batch.receipts).toBe(0);
    expect(store.receipts[0].fieldEvidenceEnc).toBeNull();
  });
});

describe("a batch that throws (#1151 A3-R3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete (globalThis as Record<string, unknown>).__orbitMetadataBackfillStarted;
    store.dbCalls = 0;
    store.failingCallsRemaining = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules a real retry, on a doubling back-off, instead of silently never running again", async () => {
    store.failingCallsRemaining = 2;

    startMetadataBackfill(100);
    await vi.advanceTimersByTimeAsync(0); // the first (failing) attempt
    expect(store.dbCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(BACKFILL_RETRY_FLOOR_MS - 1);
    expect(store.dbCalls).toBe(1); // too soon for the first retry

    await vi.advanceTimersByTimeAsync(1);
    expect(store.dbCalls).toBe(2); // first retry, after the floor delay -- and it fails again

    await vi.advanceTimersByTimeAsync(2 * BACKFILL_RETRY_FLOOR_MS - 1);
    expect(store.dbCalls).toBe(2); // too soon for the second retry: the delay doubled

    await vi.advanceTimersByTimeAsync(1);
    expect(store.dbCalls).toBe(3); // second retry -- and it succeeds, against the empty fake database
  });

  it("doubles the delay up to the ceiling, and names it the same bounded word other workers use once it is", () => {
    expect(backfillRetryDelayMs(1)).toBe(BACKFILL_RETRY_FLOOR_MS);
    expect(backfillRetryDelayMs(2)).toBe(BACKFILL_RETRY_FLOOR_MS * 2);
    expect(backfillRetryDelayMs(3)).toBe(BACKFILL_RETRY_FLOOR_MS * 4);
    expect(backfillRetryDelayMs(30)).toBe(BACKFILL_RETRY_CEILING_MS);
    expect(BACKFILL_RETRY_SURFACE_THRESHOLD).toBeGreaterThan(1);
  });
});
