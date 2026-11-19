import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `completePasswordRenewal` (#1881): saves the new password a
 * change-password hold was issued for. The hold is bound to the exact mark it
 * was issued against; a dead hold (mark cleared, replaced, account disabled
 * or gone) buys nothing and writes nothing. A live one is ADR-0023 section
 * 7's change: the mark cleared in the same statement as the hash, every
 * session revoked, pending sign-in approvals expired (#1898), and the change
 * audited.
 *
 * Also `persistSetupToken`'s address check (#1869): a link mailed to an address
 * the account no longer holds is refused 409 `address_changed`, nothing written.
 * Against a scripted stand-in for the transaction.
 */

type Write = { op: string; table: unknown; values?: Record<string, unknown> };

const state = vi.hoisted(() => ({
  answers: [] as unknown[],
  writes: [] as Array<Write>,
  deleted: [] as unknown[],
}));

vi.mock("@/db", () => {
  function builder(op: string, table: unknown): Record<string, unknown> {
    const record: Write = { op, table };
    const self: Record<string, unknown> = {};
    for (const name of ["from", "where", "for", "limit", "innerJoin"]) self[name] = () => self;
    self.set = (values: Record<string, unknown>) => { record.values = values; return self; };
    self.values = (values: Record<string, unknown>) => { record.values = values; return self; };
    self.returning = () => self;
    self.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
      if (op === "select") return Promise.resolve(state.answers.shift() ?? []).then(resolve, reject);
      state.writes.push(record);
      return Promise.resolve(op === "delete" ? state.deleted : undefined).then(resolve, reject);
    };
    return self;
  }
  const transaction = {
    execute: async () => undefined,
    select: () => builder("select", null),
    update: (table: unknown) => builder("update", table),
    insert: (table: unknown) => builder("insert", table),
    delete: (table: unknown) => builder("delete", table),
  };
  return { getDb: () => ({ transaction: async (run: (tx: typeof transaction) => unknown) => run(transaction) }) };
});

import { auditLog, localCredentials, sessions, signInApprovals } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { completePasswordRenewal, persistSetupToken } from "@/server/local-credentials";

const USER = "00000000-0000-4000-8000-000000000001";
const MARK = new Date("2026-11-17T10:00:00.000Z");

beforeEach(() => {
  state.answers = [];
  state.writes = [];
  state.deleted = [];
});

describe("completePasswordRenewal", () => {
  it.each([
    ["the account has no password", []],
    ["the account is disabled", [{ requiredAt: MARK, disabledAt: new Date() }]],
    ["a later refusal replaced the mark", [{ requiredAt: new Date(MARK.getTime() + 1), disabledAt: null }]],
  ])("answers lapsed and writes nothing when %s", async (_why, rows) => {
    state.answers = [rows];
    await expect(completePasswordRenewal(USER, MARK, "new-hash", "typed-password")).rejects.toMatchObject({
      code: "password_change_lapsed",
      status: 400,
    });
    expect(state.writes).toEqual([]);
  });

  it("answers saved and writes nothing when the mark was cleared by a saved password and the typed one is the stored one (#1901)", async () => {
    state.answers = [[{ requiredAt: null, disabledAt: null, passwordHash: await hashPassword("typed-password-P1-1901") }]];
    await expect(completePasswordRenewal(USER, MARK, "new-hash", "typed-password-P1-1901")).rejects.toMatchObject({
      code: "password_change_saved",
      status: 400,
    });
    expect(state.writes).toEqual([]);
  });

  it("answers lapsed and writes nothing when the mark was cleared elsewhere and the typed password is not the stored one (#1901)", async () => {
    state.answers = [[{ requiredAt: null, disabledAt: null, passwordHash: await hashPassword("stored-password-P0-1901") }]];
    await expect(completePasswordRenewal(USER, MARK, "new-hash", "typed-password-P2-1901")).rejects.toMatchObject({
      code: "password_change_lapsed",
      status: 400,
    });
    expect(state.writes).toEqual([]);
  });

  it("answers saved and writes nothing when the mark was cleared elsewhere but the typed password matches the stored one (#1901)", async () => {
    state.answers = [[{ requiredAt: null, disabledAt: null, passwordHash: await hashPassword("stored-password-P0-1901") }]];
    await expect(completePasswordRenewal(USER, MARK, "new-hash", "stored-password-P0-1901")).rejects.toMatchObject({
      code: "password_change_saved",
      status: 400,
    });
    expect(state.writes).toEqual([]);
  });

  it("saves the hash with the mark cleared, revokes sessions, expires pending approvals and audits the change", async () => {
    state.answers = [[{ requiredAt: new Date(MARK.getTime()), disabledAt: null }], [{ userId: USER }]];
    state.deleted = [{ id: "s1" }, { id: "s2" }];

    await expect(completePasswordRenewal(USER, MARK, "new-hash", "typed-password")).resolves.toEqual({ replaced: true, sessionsRevoked: 2 });

    const credential = state.writes.find((w) => w.op === "update" && w.table === localCredentials);
    expect(credential?.values).toMatchObject({ passwordHash: "new-hash", passwordChangeRequiredAt: null, failedAttemptCount: 0 });
    expect(state.writes.some((w) => w.op === "delete" && w.table === sessions)).toBe(true);
    const approvals = state.writes.find((w) => w.table === signInApprovals);
    expect(approvals?.values).toHaveProperty("expiresAt");
    expect(approvals?.values).not.toHaveProperty("outcome");
    const audit = state.writes.find((w) => w.table === auditLog);
    expect(audit?.values).toMatchObject({
      actorUserId: USER,
      entityId: USER,
      action: "password_changed",
      changes: { sessionsRevoked: 2 },
    });
  });
});

describe("persistSetupToken against an address that changed during the send (#1869)", () => {
  const minted = {
    token: "t",
    tokenHash: "h",
    purpose: "setup" as const,
    expiresAt: new Date("2026-11-25T00:00:00.000Z"),
  };

  it.each([
    ["a different index", "idx-new", "idx-old"],
    ["an index where there was none", "idx-new", null],
    ["no index where there was one", null, "idx-old"],
  ])("refuses 409 and writes nothing when the account now holds %s", async (_why, held, sentTo) => {
    state.answers = [[{ id: USER, emailIndex: held }]];
    await expect(persistSetupToken(USER, minted, USER, { sentToAddressIndex: sentTo })).rejects.toMatchObject({
      code: "address_changed",
      status: 409,
    });
    expect(state.writes).toEqual([]);
  });

  it("writes the link, and audits it, when the account still holds the index the link went to", async () => {
    state.answers = [[{ id: USER, emailIndex: "idx" }]];
    await expect(persistSetupToken(USER, minted, USER, { sentToAddressIndex: "idx" })).resolves.toBe(true);
    expect(state.writes.some((w) => w.op === "insert" && w.values?.tokenHash === "h")).toBe(true);
  });
});
