import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `persistSetupToken`'s own invariant (ADR-0023 §3: writing a link
 * invalidates every earlier unspent one), against an in-memory stand-in for
 * the database.
 *
 * The fake's `execute` understands exactly one thing beyond plain table
 * reads/writes: `pg_advisory_xact_lock`. It models the real guarantee a
 * Postgres advisory lock gives -- a second transaction naming the same key
 * waits until the first one finishes -- with a promise-chain mutex keyed by
 * the raw lock string, released when the owning `transaction()` call
 * settles. That is enough to prove a lock actually serializes two concurrent
 * callers; real lock semantics past that are the integration suite's job.
 */

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  users: [] as Row[],
  setupTokens: [] as Row[],
  audit: [] as Row[],
  nextId: 0,
}));

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
    if (table === schema.users) return store.users;
    if (table === schema.credentialSetupTokens) return store.setupTokens;
    if (table === schema.auditLog) return store.audit;
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
      if (operator === "is null") verdict &&= held === null || held === undefined;
      else if (operator === "is not null") verdict &&= held !== null && held !== undefined;
      else if (operator === "=") verdict &&= String(held) === String(stream[at + 2]?.value);
      else if (operator === ">") verdict &&= held instanceof Date
        && held.getTime() > new Date(stream[at + 2]?.value as string).getTime();
      else throw new Error(`the fake database does not implement "${operator}"`);
    }
    return verdict;
  }

  function select(selection: Record<string, unknown>) {
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

  function insert(table: unknown) {
    return {
      values(value: Row) {
        const row: Row = { id: `row-${store.nextId += 1}`, createdAt: new Date(), consumedAt: null, ...value };
        return {
          then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
            return Promise.resolve().then(() => { rowsFor(table).push(row); }).then(resolve, reject);
          },
        };
      },
    };
  }

  function update(table: unknown) {
    let values: Row = {};
    let condition: unknown = null;
    const builder = {
      set(next: Row) { values = next; return builder; },
      where(where: unknown) { condition = where; return builder; },
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        const keys = columnKeys(table as Record<string, { name?: string }>);
        return Promise.resolve().then(() => {
          for (const row of rowsFor(table)) {
            if (condition === null || matches(row, condition, keys)) Object.assign(row, values);
          }
        }).then(resolve, reject);
      },
    };
    return builder;
  }

  /** One promise chain per advisory-lock key: a real `pg_advisory_xact_lock`'s mutual exclusion. */
  const locks = new Map<string, Promise<void>>();

  function lockKeyOf(query: unknown): string | null {
    const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
    const raw = chunks.find((chunk) => typeof chunk === "string");
    return typeof raw === "string" ? raw : null;
  }

  function transaction(body: (executor: unknown) => unknown) {
    const releases: Array<() => void> = [];
    const executor = {
      select,
      insert,
      update,
      async execute(query: unknown) {
        const key = lockKeyOf(query);
        if (key === null) return [];
        const prior = locks.get(key) ?? Promise.resolve();
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        locks.set(key, prior.then(() => held));
        await prior;
        releases.push(release);
        return [];
      },
    };
    return Promise.resolve(body(executor)).finally(() => { releases.forEach((release) => release()); });
  }

  const db = { select, insert, update, transaction };
  return { getDb: () => db };
});

const { issueSetupToken, mintSetupToken, persistSetupToken } = await import("@/server/local-credentials");

const USER = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  store.users = [{ id: USER }];
  store.setupTokens = [];
  store.audit = [];
  store.nextId = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

/** Every unexpired, unspent token this user currently holds. */
function liveTokens(now: Date): Row[] {
  return store.setupTokens.filter((row) => (
    row.userId === USER && row.consumedAt === null && (row.expiresAt as Date).getTime() > now.getTime()
  ));
}

describe("persistSetupToken (#1151 A1-R4)", () => {
  it("leaves exactly one live link after two concurrent issues, not two", async () => {
    const first = mintSetupToken("setup");
    const second = mintSetupToken("setup");

    await Promise.all([
      persistSetupToken(USER, first, null),
      persistSetupToken(USER, second, null),
    ]);

    /* Without a per-user lock, both calls read "no earlier link to
       supersede" before either had written its own row, so a double-click
       used to leave two live links to the same mailbox instead of one.
       `now` is read only after both calls have settled, so it never lands
       inside the moment either call used as its own "supersede as of". */
    const now = new Date();
    expect(liveTokens(now)).toHaveLength(1);
    expect(liveTokens(now)[0].tokenHash).toBe(second.tokenHash);
  });

  it("still lets a solo issue through, and still invalidates what came before it", async () => {
    const first = await issueSetupToken(USER, "setup");
    const second = await issueSetupToken(USER, "setup");
    const now = new Date();

    expect(first.token).not.toBe(second.token);
    expect(liveTokens(now)).toHaveLength(1);
    expect(store.audit.filter((row) => row.action === "setup_link_issued")).toHaveLength(2);
  });
});
