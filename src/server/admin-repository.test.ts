import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetadataCipher } from "@/server/metadata/fields";
import { listInstanceUsers } from "@/server/admin-repository";

/**
 * The administration user list once the address is encrypted (#969), against
 * an in-memory stand-in for the database.
 *
 * The integration suite proves the list, its cap and its authority rules
 * against real Postgres; this one pins what moved when `users.email` went
 * behind the encryption key. SQL can no longer order by an address, so the
 * database orders by display name and the tiebreak between equal display
 * names happens here, after decryption — and a row whose address cannot be
 * read is reported as having none rather than as an empty one.
 */

const PRIMARY = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";

type UserRow = {
  id: string;
  displayName: string;
  email: string | null;
  emailEnc: string | null;
  isInstanceAdmin: boolean;
  disabledAt: Date | null;
};

const mocks = vi.hoisted(() => ({
  rows: [] as UserRow[],
  /** Rows past the display-name-ordered cap, reachable only by id (#592). */
  beyondCap: [] as UserRow[],
  primaryUserId: null as string | null,
  locked: false,
  /** Real key material, so fixtures are encrypted by the code that reads them. */
  key: { scope: "instance", householdId: null, keyId: "test-key", dataKey: Buffer.alloc(32, 7) },
}));

vi.mock("@/server/authorization", () => ({
  requireInstanceAdministrator: async () => undefined,
}));

vi.mock("@/server/metadata/fields", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/metadata/fields")>();
  return {
    ...original,
    // A real cipher over real key material; `locked` is the instance holding
    // no usable key, which is what makes an address unreadable without
    // damaging anything.
    openInstanceMetadataReader: async () => new original.MetadataCipher(
      mocks.locked ? undefined : mocks.key as never,
    ),
  };
});

vi.mock("@/db", async () => {
  const { is, Param } = await import("drizzle-orm");
  const schema = await import("@/db/schema");

  /** The only shape `eq()` is ever used with here: a column against a literal. */
  function literalOf(condition: unknown): unknown {
    const chunks = (condition as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? [];
    const param = chunks.find((chunk) => is(chunk, Param));
    return param ? (param as { value: unknown }).value : undefined;
  }

  function makeSelect(projection: Record<string, unknown>) {
    let table: unknown;
    let identifier: unknown;
    let limit = Number.POSITIVE_INFINITY;
    let ordered = false;
    function rowsFor(): unknown[] {
      if (table === schema.instanceAuthority) return [{ primaryUserId: mocks.primaryUserId }];
      if ("totalCount" in projection) {
        return [{ totalCount: mocks.rows.length + mocks.beyondCap.length }];
      }
      if (identifier !== undefined) {
        return [...mocks.rows, ...mocks.beyondCap].filter((row) => row.id === identifier).slice(0, limit);
      }
      const page = [...mocks.rows];
      // Stable, like the query it stands in for: equal display names keep the
      // order they arrived in, which is precisely what the module reorders.
      if (ordered) page.sort((left, right) => left.displayName.localeCompare(right.displayName));
      return page.slice(0, limit);
    }
    const builder = {
      from(source: unknown) {
        table = source;
        return builder;
      },
      where(condition: unknown) {
        identifier = literalOf(condition);
        return builder;
      },
      /** The database's own order: display name, and nothing else since #969. */
      orderBy() {
        ordered = true;
        return builder;
      },
      limit(count: number) {
        limit = count;
        return builder;
      },
      then(onFulfilled: (value: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) {
        return Promise.resolve(rowsFor()).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  return {
    getDb: () => ({ select: (projection: Record<string, unknown>) => makeSelect(projection) }),
  };
});

/** A row as the backfill leaves it: ciphertext in `email_enc`, no plaintext. */
function encrypted(id: string, displayName: string, email: string): UserRow {
  const cipher = new MetadataCipher(mocks.key as never);
  return {
    id,
    displayName,
    email: null,
    emailEnc: cipher.encryptText("users.email", id, email),
    isInstanceAdmin: false,
    disabledAt: null,
  };
}

/** A row the backfill has not reached: plaintext, readable with or without a key. */
function plaintext(id: string, displayName: string, email: string | null): UserRow {
  return { id, displayName, email, emailEnc: null, isInstanceAdmin: false, disabledAt: null };
}

beforeEach(() => {
  mocks.rows = [];
  mocks.beyondCap = [];
  mocks.primaryUserId = null;
  mocks.locked = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("listInstanceUsers with encrypted addresses (#969)", () => {
  it("decrypts the stored address and still breaks equal display names by it", async () => {
    // Deliberately the wrong way round in the page the database returns: the
    // old `asc(users.email)` cannot run on ciphertext, so this ordering comes
    // out right only if the tiebreak happens after decryption.
    mocks.rows = [
      encrypted("aaaaaaaa-0000-4000-8000-000000000002", "Sam Carter", "zoe@example.invalid"),
      encrypted("aaaaaaaa-0000-4000-8000-000000000001", "Sam Carter", "alex@example.invalid"),
      encrypted("aaaaaaaa-0000-4000-8000-000000000003", "Ada Lovelace", "ada@example.invalid"),
    ];

    const list = await listInstanceUsers(ADMIN);

    expect(list.users.map((user) => user.email)).toEqual([
      "ada@example.invalid",
      "alex@example.invalid",
      "zoe@example.invalid",
    ]);
    expect(list.users.every((user) => user.metadataStatus === undefined)).toBe(true);
    expect(list.totalCount).toBe(3);
    expect(list.truncated).toBe(false);
  });

  it("reads a row the backfill has not reached from its plaintext column", async () => {
    mocks.rows = [plaintext("aaaaaaaa-0000-4000-8000-000000000004", "Ada Lovelace", "ada@example.invalid")];

    const [user] = (await listInstanceUsers(ADMIN)).users;
    expect(user.email).toBe("ada@example.invalid");
    expect(user.metadataStatus).toBeUndefined();
  });

  it("reports a locked address as no address, never as an empty one, and sorts it last", async () => {
    const unreadable = encrypted("aaaaaaaa-0000-4000-8000-000000000005", "Sam Carter", "zoe@example.invalid");
    mocks.rows = [
      unreadable,
      // Still plaintext, so this one reads whether or not the instance has its key.
      plaintext("aaaaaaaa-0000-4000-8000-000000000006", "Sam Carter", "alex@example.invalid"),
    ];
    mocks.locked = true;

    const list = await listInstanceUsers(ADMIN);
    expect(list.users.map((user) => user.email)).toEqual(["alex@example.invalid", null]);
    expect(list.users.map((user) => user.metadataStatus?.email)).toEqual([undefined, "metadata_locked"]);
    // Unreadable last, which is where `asc(users.email)` put a null too.
    expect(list.users[1].id).toBe(unreadable.id);
  });

  it("#592: keeps the primary administrator first, outside the address tiebreak", async () => {
    mocks.rows = [encrypted(ADMIN, "Ada Lovelace", "ada@example.invalid")];
    mocks.beyondCap = [encrypted(PRIMARY, "Zoe Zephyr", "zoe@example.invalid")];
    mocks.primaryUserId = PRIMARY;

    const list = await listInstanceUsers(ADMIN);
    expect(list.users.map((user) => user.id)).toEqual([PRIMARY, ADMIN]);
    expect(list.users[0].isPrimaryAdministrator).toBe(true);
    expect(list.users[0].email).toBe("zoe@example.invalid");
  });
});
