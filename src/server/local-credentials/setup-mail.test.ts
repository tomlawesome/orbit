import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetadataCipher } from "@/server/metadata/fields";
import { sendSetupLink } from "@/server/local-credentials/setup-mail";

/**
 * Mailing a setup link to an address that is now ciphertext (#969), against
 * an in-memory stand-in for the database.
 *
 * One thing is pinned here that no integration test can state as plainly: an
 * address this instance cannot read is a refusal, not a send. Nothing is
 * mailed, and — because issuing kills the previous link — no token is minted
 * either.
 */

const ADMIN = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  row: null as null | {
    id: string;
    email: string | null;
    emailEnc: string | null;
    displayName: string;
    credential: string | null;
  },
  locked: false,
  auditRows: [] as Array<Record<string, unknown>>,
  issued: [] as string[],
  key: { scope: "instance", householdId: null, keyId: "test-key", dataKey: Buffer.alloc(32, 9) },
}));

vi.mock("@/server/metadata/fields", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/metadata/fields")>();
  return {
    ...original,
    openInstanceMetadataReader: async () => new original.MetadataCipher(
      mocks.locked ? undefined : mocks.key as never,
    ),
  };
});

vi.mock("@/server/local-credentials", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/local-credentials")>();
  return {
    ...original,
    issueSetupToken: async (userId: string) => {
      mocks.issued.push(userId);
      return { token: "setup-token", expiresAt: new Date("2026-09-22T09:00:00.000Z") };
    },
  };
});

vi.mock("@/db", async () => {
  const schema = await import("@/db/schema");
  function makeSelect() {
    const builder = {
      from: () => builder,
      leftJoin: () => builder,
      where: () => builder,
      limit: () => builder,
      then(onFulfilled: (value: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) {
        return Promise.resolve(mocks.row ? [{ ...mocks.row }] : []).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }
  return {
    getDb: () => ({
      select: () => makeSelect(),
      insert: (table: unknown) => ({
        values(value: Record<string, unknown>) {
          if (table === schema.auditLog) mocks.auditRows.push(value);
          return Promise.resolve();
        },
      }),
    }),
  };
});

const sent: Array<{ to: string; subject: string }> = [];
const mailer = { sendEmail: async (message: { to: string; subject: string }) => { sent.push(message); } };

beforeEach(() => {
  process.env.APP_URL = "https://orbit.example.invalid";
  mocks.row = null;
  mocks.locked = false;
  mocks.auditRows = [];
  mocks.issued = [];
  sent.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("sendSetupLink with an encrypted address (#969)", () => {
  it("decrypts the registered address and sends the link there", async () => {
    const cipher = new MetadataCipher(mocks.key as never);
    mocks.row = {
      id: USER,
      email: null,
      emailEnc: cipher.encryptText("users.email", USER, "ada@example.invalid"),
      displayName: "Ada Lovelace",
      credential: null,
    };

    const delivery = await sendSetupLink(ADMIN, USER, { mailer });

    expect(delivery.sendError).toBeNull();
    expect(delivery.sentTo).toBe("ada@example.invalid");
    expect(sent.map((message) => message.to)).toEqual(["ada@example.invalid"]);
    // The audit line names the user and the purpose, and no address.
    expect(mocks.auditRows).toHaveLength(1);
    expect(mocks.auditRows[0]).toMatchObject({ action: "setup_link_sent", entityId: USER });
    expect(JSON.stringify(mocks.auditRows[0])).not.toContain("ada@example.invalid");
  });

  it("still sends to a row the backfill has not reached", async () => {
    mocks.row = {
      id: USER,
      email: "ada@example.invalid",
      emailEnc: null,
      displayName: "Ada Lovelace",
      credential: USER,
    };

    const delivery = await sendSetupLink(ADMIN, USER, { mailer });
    expect(delivery.sentTo).toBe("ada@example.invalid");
    expect(sent).toHaveLength(1);
  });

  it("refuses rather than sending to nothing when the instance is locked", async () => {
    const cipher = new MetadataCipher(mocks.key as never);
    mocks.row = {
      id: USER,
      email: null,
      emailEnc: cipher.encryptText("users.email", USER, "ada@example.invalid"),
      displayName: "Ada Lovelace",
      credential: null,
    };
    mocks.locked = true;

    await expect(sendSetupLink(ADMIN, USER, { mailer }))
      .rejects.toMatchObject({ code: "metadata_locked", status: 503 });
    expect(sent).toEqual([]);
    // No token minted: issuing one would have killed the link this user may
    // already be holding, in exchange for one that cannot be delivered.
    expect(mocks.issued).toEqual([]);
    expect(mocks.auditRows).toEqual([]);
  });

  it("refuses when the account has no address at all", async () => {
    mocks.row = { id: USER, email: null, emailEnc: null, displayName: "Ada Lovelace", credential: null };

    await expect(sendSetupLink(ADMIN, USER, { mailer }))
      .rejects.toMatchObject({ code: "recipient_address_unreadable", status: 409 });
    expect(sent).toEqual([]);
    expect(mocks.issued).toEqual([]);
  });
});
