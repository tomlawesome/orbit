import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `setUserAddress` (#1869): an administrator replaces a member's address.
 * Run against a scripted stand-in for the transaction: each awaited query
 * takes the next queued answer, and every write is recorded, so the tests can
 * assert what was refused and what was (not) written.
 */

const state = vi.hoisted(() => ({
  answers: [] as unknown[],
  writes: [] as Array<{ op: string; table: unknown; values?: Record<string, unknown> }>,
  transactions: 0,
  getDbCalls: 0,
  uniqueOnUpdate: false,
  failOnUpdate: null as Error | null,
  previous: null as string | null,
  emailIndex: "index-new" as string | null,
  send: vi.fn(),
}));

vi.mock("@/db", () => {
  function builder(op: string, table: unknown): Record<string, unknown> {
    const record: { op: string; table: unknown; values?: Record<string, unknown> } = { op, table };
    const self: Record<string, unknown> = {};
    for (const name of ["from", "where", "for", "limit", "innerJoin"]) self[name] = () => self;
    self.set = (values: Record<string, unknown>) => { record.values = values; return self; };
    self.values = (values: Record<string, unknown>) => { record.values = values; return self; };
    self.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
      if (op === "select") return Promise.resolve(state.answers.shift() ?? []).then(resolve, reject);
      state.writes.push(record);
      if (op === "update" && state.uniqueOnUpdate && state.writes.filter((w) => w.op === "update").length === 1) {
        return Promise.reject(Object.assign(new Error("wrapped"), { cause: { code: "23505" } })).then(resolve, reject);
      }
      if (op === "update" && state.failOnUpdate && state.writes.filter((w) => w.op === "update").length === 1) {
        return Promise.reject(state.failOnUpdate).then(resolve, reject);
      }
      return Promise.resolve(undefined).then(resolve, reject);
    };
    return self;
  }
  const transaction = {
    execute: async () => undefined,
    select: () => builder("select", null),
    update: (table: unknown) => builder("update", table),
    insert: (table: unknown) => builder("insert", table),
  };
  return {
    getDb: () => {
      state.getDbCalls += 1;
      return { transaction: async (run: (tx: typeof transaction) => unknown) => { state.transactions += 1; return run(transaction); } };
    },
  };
});

vi.mock("@/server/metadata/fields", () => ({
  requireInstanceMetadataWriter: async () => ({
    emailIndex: () => state.emailIndex,
    encryptText: (_field: string, _id: string, value: string) => `enc(${value})`,
  }),
  openInstanceMetadataReader: async () => ({
    text: () => ({ value: state.previous, state: state.previous === null ? "unreadable" : "readable" }),
  }),
}));

vi.mock("@/server/invitations/send", () => ({ sendBoundedMail: state.send }));

import { auditLog, signInApprovals, users } from "@/db/schema";
import { setUserAddress } from "./address";

const ACTOR = "00000000-0000-4000-8000-000000000001";
const MEMBER = "00000000-0000-4000-8000-000000000002";
const TARGET = { id: MEMBER, displayName: "Priya Raman", emailEnc: "cipher" };

beforeEach(() => {
  state.answers = [];
  state.writes = [];
  state.transactions = 0;
  state.getDbCalls = 0;
  state.uniqueOnUpdate = false;
  state.failOnUpdate = null;
  state.previous = "old@example.com";
  state.emailIndex = "index-new";
  state.send.mockReset();
  state.send.mockResolvedValue({ sentAt: new Date(), sendError: null });
});

describe("setUserAddress refusals before anything is written", () => {
  it("refuses an address that is not an email, without opening a transaction", async () => {
    await expect(setUserAddress(ACTOR, MEMBER, "  not-an-address ")).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
    });
    expect(state.getDbCalls).toBe(0);
  });

  it("makes an administrator send their own address again, and refuses a mismatch with nothing written", async () => {
    await expect(setUserAddress(ACTOR, ACTOR, "new@example.com")).rejects.toMatchObject({
      code: "address_confirmation_required",
      status: 422,
    });
    await expect(
      setUserAddress(ACTOR, ACTOR, "new@example.com", { confirmEmail: "other@example.com" }),
    ).rejects.toMatchObject({ code: "address_confirmation_required" });
    expect(state.getDbCalls).toBe(0);
  });

  it("answers 404 for a member who is gone", async () => {
    state.answers = [[]];
    await expect(setUserAddress(ACTOR, MEMBER, "new@example.com")).rejects.toMatchObject({
      code: "user_not_found",
      status: 404,
    });
    expect(state.writes).toEqual([]);
  });

  it("refuses an account whose address comes from its sign-in provider, writing nothing", async () => {
    state.answers = [[TARGET], [{ id: "identity" }]];
    await expect(setUserAddress(ACTOR, MEMBER, "new@example.com")).rejects.toMatchObject({
      code: "address_from_provider",
      status: 409,
    });
    expect(state.writes).toEqual([]);
  });

  it("refuses an address another account already holds, writing nothing", async () => {
    state.answers = [[TARGET], [], [{ id: "someone-else" }]];
    await expect(setUserAddress(ACTOR, MEMBER, "taken@example.com")).rejects.toMatchObject({
      code: "email_in_use",
      status: 409,
    });
    expect(state.writes).toEqual([]);
  });

  it("turns a unique-index violation on the write into the same refusal, however deeply wrapped", async () => {
    state.answers = [[TARGET], [], []];
    state.uniqueOnUpdate = true;
    await expect(setUserAddress(ACTOR, MEMBER, "race@example.com")).rejects.toMatchObject({ code: "email_in_use" });
    expect(state.writes.some((w) => w.op === "insert")).toBe(false);
  });
});

describe("setUserAddress committing", () => {
  it("writes the new ciphertext, retires links and approvals, audits it, and tells the old address", async () => {
    state.answers = [[TARGET], [], []];
    const result = await setUserAddress(ACTOR, MEMBER, "  New@Example.com ");

    const userUpdate = state.writes.find((w) => w.op === "update" && w.table === users);
    expect(userUpdate?.values).toMatchObject({ emailEnc: "enc(New@Example.com)", emailIndex: "index-new" });
    const approvals = state.writes.find((w) => w.table === signInApprovals);
    expect(approvals?.values).toHaveProperty("consumedAt");
    expect(approvals?.values).not.toHaveProperty("outcome");
    const audit = state.writes.find((w) => w.table === auditLog);
    expect(audit?.values).toMatchObject({
      actorUserId: ACTOR,
      entityId: MEMBER,
      action: "email_address_set",
      changes: { userId: MEMBER, previous: "readable", self: false },
    });

    expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.send.mock.calls[0][0]).toBe("old@example.com");
    expect(state.send.mock.calls[0][1].text).not.toContain("example.com/");
    expect(state.send.mock.calls[0][1].text).not.toContain("New@Example.com");
    expect(result).toEqual({ noticeError: null });
  });

  it("reports the bounded reason when the notice cannot go, after the change has committed", async () => {
    state.answers = [[TARGET], [], []];
    state.send.mockResolvedValue({ sentAt: null, sendError: "smtp_unavailable" });
    await expect(setUserAddress(ACTOR, MEMBER, "new@example.com")).resolves.toEqual({ noticeError: "smtp_unavailable" });
    expect(state.writes.some((w) => w.table === auditLog)).toBe(true);

    state.send.mockRejectedValue(new Error("boom"));
    state.answers = [[TARGET], [], []];
    await expect(setUserAddress(ACTOR, MEMBER, "new2@example.com")).resolves.toEqual({ noticeError: "unknown" });
  });

  it("sends no notice when the old address was unreadable, and records that it was", async () => {
    state.answers = [[TARGET], [], []];
    state.previous = null;
    await expect(setUserAddress(ACTOR, MEMBER, "new@example.com")).resolves.toEqual({ noticeError: null });
    expect(state.send).not.toHaveBeenCalled();
    const audit = state.writes.find((w) => w.table === auditLog);
    expect(audit?.values).toMatchObject({ changes: { previous: "unreadable" } });
  });

  it("sends no notice when only the letter case of the address changed", async () => {
    state.answers = [[TARGET], [], []];
    state.previous = "Old@Example.com";
    await expect(setUserAddress(ACTOR, MEMBER, "old@example.com")).resolves.toEqual({ noticeError: null });
    expect(state.send).not.toHaveBeenCalled();
  });

  it("lets an administrator set their own address when they confirm it, case aside", async () => {
    state.answers = [[{ ...TARGET, id: ACTOR }], [], []];
    await setUserAddress(ACTOR, ACTOR, "me@example.com", { confirmEmail: " ME@example.com " });
    const audit = state.writes.find((w) => w.table === auditLog);
    expect(audit?.values).toMatchObject({ changes: { self: true } });
  });

  it("lets any other failure of the write through unchanged, and audits nothing", async () => {
    state.answers = [[TARGET], [], []];
    state.failOnUpdate = new Error("connection lost");
    await expect(setUserAddress(ACTOR, MEMBER, "new@example.com")).rejects.toThrow("connection lost");
    expect(state.writes.some((w) => w.table === auditLog)).toBe(false);
  });

  it("skips the in-use check when the address has no blind index, as for an unusable key state", async () => {
    state.emailIndex = null;
    state.answers = [[TARGET], []];
    await expect(setUserAddress(ACTOR, MEMBER, "new@example.com")).resolves.toBeDefined();
    const userUpdate = state.writes.find((w) => w.op === "update" && w.table === users);
    expect(userUpdate?.values).toMatchObject({ emailIndex: null });
  });
});
