import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `listHouseholdInvitations`'s own reconciliation (#1151 SR1-R5), against an
 * in-memory stand-in for `household_invitations`.
 *
 * WHAT THIS PINS. `sendHouseholdInvitation` commits the invitation row
 * before attempting the mail and writes the outcome back afterwards (by
 * design -- see its own doc comment). If the process dies in between, the
 * row is left with neither `sentAt` nor `sendError`, and nothing was ever
 * going to revisit it: there is no background retry here, only "resend"
 * pressed by somebody who can see it is needed. This suite is about the
 * reconciliation that makes that visible, not the full send -- the send
 * path's own rules are the integration suite's job
 * (`tests/integration/household-invitations.test.ts`).
 *
 * THE FAKE UNDERSTANDS ONLY WHAT THIS READ ASKS FOR: one table, `and`-joined
 * `=` and `is null`, no transaction.
 */

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  invitations: [] as Row[],
}));

vi.mock("@/server/workspace-access", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/workspace-access")>();
  return { ...original, requireHouseholdAccess: async () => {} };
});

vi.mock("@/server/metadata/fields", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/metadata/fields")>();
  return {
    ...original,
    /* Every address in this suite is plaintext (no backfill involved), so an
       unlocked reader over no key is all a list read needs. */
    openMetadataReader: async () => new original.MetadataCipher(undefined),
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
    if (table === schema.householdInvitations) return store.invitations;
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
      else if (operator === "=") verdict &&= String(held) === String(stream[at + 2]?.value);
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
    const builder = {
      from(from: unknown) { table = from; return builder; },
      where(where: unknown) { condition = where; return builder; },
      orderBy() { return builder; },
      then(resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) {
        try {
          const rows = rowsFor(table);
          const keys = columnKeys(table as Record<string, { name?: string }>);
          const found = rows.filter((row) => condition === null || matches(row, condition, keys));
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
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        try {
          const keys = columnKeys(table as Record<string, { name?: string }>);
          const touched = rowsFor(table).filter((row) => condition === null || matches(row, condition, keys));
          for (const row of touched) Object.assign(row, values);
          return Promise.resolve([]).then(resolve, reject);
        } catch (error) {
          return Promise.resolve().then(() => { throw error; }).then(resolve, reject);
        }
      },
    };
    return builder;
  }

  return { getDb: () => ({ select, update }) };
});

const { listHouseholdInvitations } = await import("@/server/invitations");

const OWNER = "11111111-1111-4111-8111-111111111111";
const HOUSEHOLD = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-09-20T12:00:00.000Z");

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "row-1",
    householdId: HOUSEHOLD,
    email: "sam@example.invalid",
    emailEnc: null,
    createdAt: NOW,
    sentAt: null,
    sendError: null,
    expiresAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
    redeemedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  store.invitations.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a send Orbit never recorded an outcome for (#1151 SR1-R5)", () => {
  it("still shows as pending while a real send could still be running", async () => {
    store.invitations.push(row({ id: "fresh", createdAt: NOW }));
    const justUnderTwoMinutes = new Date(NOW.getTime() + 119_000);

    const [invitation] = await listHouseholdInvitations(OWNER, HOUSEHOLD, justUnderTwoMinutes);

    expect(invitation.sentAt).toBeNull();
    expect(invitation.sendError).toBeNull();
    expect(store.invitations[0].sendError).toBeNull();
  });

  it("is reconciled to the one bounded failure word once no real send could still be running", async () => {
    store.invitations.push(row({ id: "stuck", createdAt: NOW }));
    const wellPastTwoMinutes = new Date(NOW.getTime() + 5 * 60 * 1000);

    const [invitation] = await listHouseholdInvitations(OWNER, HOUSEHOLD, wellPastTwoMinutes);

    expect(invitation.sendError).toBe("unknown");
    expect(invitation.sentAt).toBeNull();
    // Written back, not just shown once: the next read -- and a resend's own
    // read of the open invitations -- sees the same answer.
    expect(store.invitations[0].sendError).toBe("unknown");
  });

  it("never overwrites a row that did resolve, however old it is", async () => {
    store.invitations.push(row({ id: "sent-ok", createdAt: NOW, sentAt: NOW }));
    store.invitations.push(row({ id: "failed-ok", createdAt: NOW, sendError: "smtp_rejected" }));
    const wellPastTwoMinutes = new Date(NOW.getTime() + 5 * 60 * 1000);

    const invitations = await listHouseholdInvitations(OWNER, HOUSEHOLD, wellPastTwoMinutes);

    expect(invitations.find((i) => i.id === "sent-ok")?.sendError).toBeNull();
    expect(invitations.find((i) => i.id === "failed-ok")?.sendError).toBe("smtp_rejected");
  });
});
