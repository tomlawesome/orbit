import { beforeEach, describe, expect, it, vi } from "vitest";
import { MetadataCipher } from "@/server/metadata/fields";

/**
 * `readInstanceUser` (#1869): one user shaped as `listInstanceUsers` shapes
 * it, or null when there is none. The caller has checked the administrator.
 */

const state = vi.hoisted(() => ({
  userRows: [] as unknown[],
  primaryUserId: null as string | null,
  key: { scope: "instance", householdId: null, keyId: "test-key", dataKey: Buffer.alloc(32, 5) },
  locked: false,
}));

vi.mock("@/server/authorization", () => ({ requireInstanceAdministrator: async () => undefined }));

vi.mock("@/server/metadata/fields", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/metadata/fields")>();
  return {
    ...original,
    openInstanceMetadataReader: async () => new original.MetadataCipher(state.locked ? undefined : state.key as never),
  };
});

vi.mock("@/db", async () => {
  const schema = await import("@/db/schema");
  function select() {
    let table: unknown;
    const self: Record<string, unknown> = {};
    self.from = (source: unknown) => { table = source; return self; };
    self.where = () => self;
    self.limit = () => self;
    self.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(table === schema.instanceAuthority ? [{ primaryUserId: state.primaryUserId }] : state.userRows)
        .then(resolve, reject);
    return self;
  }
  const db = {
    select,
    transaction: async (run: (tx: { select: typeof select }) => unknown) => run({ select }),
  };
  return { getDb: () => db };
});

import { readInstanceUser } from "@/server/admin-repository";

const ID = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "aaaaaaaa-0000-4000-8000-000000000002";

function row(email: string) {
  return {
    id: ID,
    displayName: "Ada Lovelace",
    emailEnc: new MetadataCipher(state.key as never).encryptText("users.email", ID, email),
    isInstanceAdmin: true,
    disabledAt: null,
  };
}

beforeEach(() => {
  state.userRows = [];
  state.primaryUserId = null;
  state.locked = false;
});

describe("readInstanceUser", () => {
  it("is null for a user that does not exist", async () => {
    await expect(readInstanceUser(ID)).resolves.toBeNull();
  });

  it("decrypts the address and marks the primary administrator", async () => {
    state.userRows = [row("ada@example.invalid")];
    state.primaryUserId = ID;
    await expect(readInstanceUser(ID)).resolves.toEqual({
      id: ID,
      displayName: "Ada Lovelace",
      email: "ada@example.invalid",
      metadataStatus: undefined,
      isInstanceAdmin: true,
      isPrimaryAdministrator: true,
      disabledAt: null,
    });
  });

  it("does not mark a user who is not the primary administrator", async () => {
    state.userRows = [row("ada@example.invalid")];
    state.primaryUserId = OTHER;
    expect((await readInstanceUser(ID))?.isPrimaryAdministrator).toBe(false);
  });

  it("reports a locked address as no address with the reason, never as an empty one", async () => {
    state.userRows = [row("ada@example.invalid")];
    state.locked = true;
    const user = await readInstanceUser(ID);
    expect(user?.email).toBeNull();
    expect(user?.metadataStatus).toEqual({ email: "metadata_locked" });
  });
});
