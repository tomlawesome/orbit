import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The #1881 pure reads and the refused-password rule in `local-credentials`,
 * plus `readDeniedSignInNotice` (sign-in-approvals): a refused sign-in marks
 * the password; only a saved, different password clears it.
 * Against a scripted stand-in for the database: each query takes the next
 * queued answer.
 */

const state = vi.hoisted(() => ({
  answers: [] as unknown[],
  verify: vi.fn(),
}));

vi.mock("@/db", () => {
  const self: Record<string, unknown> = {};
  for (const name of ["from", "where", "limit", "innerJoin"]) self[name] = () => self;
  self.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(state.answers.shift() ?? []).then(resolve, reject);
  return { getDb: () => ({ select: () => self }) };
});

vi.mock("@/lib/auth/password", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/password")>()),
  verifyPassword: state.verify,
}));

import { VerificationGateRefusedError } from "@/lib/auth/verification-gate";
import {
  assertNotRefusedPassword,
  passwordChangeRequiredAt,
  setupTokenOwner,
} from "@/server/local-credentials";
import { readDeniedSignInNotice } from "@/server/sign-in-approvals";

const USER = "00000000-0000-4000-8000-000000000001";
const MARK = new Date("2026-11-17T10:00:00.000Z");

beforeEach(() => {
  state.answers = [];
  state.verify.mockReset();
});

describe("passwordChangeRequiredAt and readDeniedSignInNotice", () => {
  it("reads the mark's moment, and null for an unmarked password or no password", async () => {
    state.answers = [[{ requiredAt: MARK }], [{ requiredAt: null }], []];
    expect(await passwordChangeRequiredAt(USER)).toEqual(MARK);
    expect(await passwordChangeRequiredAt(USER)).toBeNull();
    expect(await passwordChangeRequiredAt(USER)).toBeNull();
  });

  it("reports the notice as the mark's moment, repeatably, and null when unmarked", async () => {
    state.answers = [[{ requiredAt: MARK }], [{ requiredAt: MARK }], [{ requiredAt: null }], []];
    expect(await readDeniedSignInNotice(USER)).toEqual({ deniedAt: MARK });
    expect(await readDeniedSignInNotice(USER)).toEqual({ deniedAt: MARK });
    expect(await readDeniedSignInNotice(USER)).toBeNull();
    expect(await readDeniedSignInNotice(USER)).toBeNull();
  });
});

describe("assertNotRefusedPassword", () => {
  it("costs no derivation for an account that carries no mark, or has no password", async () => {
    state.answers = [[{ passwordHash: "h", requiredAt: null }], []];
    await expect(assertNotRefusedPassword(USER, "anything")).resolves.toBeUndefined();
    await expect(assertNotRefusedPassword(USER, "anything")).resolves.toBeUndefined();
    expect(state.verify).not.toHaveBeenCalled();
  });

  it("refuses the very password that was refused at sign-in", async () => {
    state.answers = [[{ passwordHash: "h", requiredAt: MARK }]];
    state.verify.mockResolvedValue({ verified: true });
    await expect(assertNotRefusedPassword(USER, "old-password")).rejects.toMatchObject({
      code: "password_unchanged",
      status: 400,
    });
    expect(state.verify).toHaveBeenCalledWith("h", "old-password");
  });

  it("accepts a different password for a marked account", async () => {
    state.answers = [[{ passwordHash: "h", requiredAt: MARK }]];
    state.verify.mockResolvedValue({ verified: false });
    await expect(assertNotRefusedPassword(USER, "new-password")).resolves.toBeUndefined();
  });

  it("answers 429 when the verification gate is full, and lets other failures through unchanged", async () => {
    state.answers = [[{ passwordHash: "h", requiredAt: MARK }], [{ passwordHash: "h", requiredAt: MARK }]];
    state.verify.mockRejectedValueOnce(new VerificationGateRefusedError("queue_full"));
    await expect(assertNotRefusedPassword(USER, "x")).rejects.toMatchObject({
      code: "too_many_attempts",
      status: 429,
    });
    const broken = new Error("hash store down");
    state.verify.mockRejectedValueOnce(broken);
    await expect(assertNotRefusedPassword(USER, "x")).rejects.toBe(broken);
  });
});

describe("setupTokenOwner", () => {
  const future = new Date(Date.now() + 60_000);
  const past = new Date(Date.now() - 60_000);

  it("names the account for an open token", async () => {
    state.answers = [[{ userId: USER, expiresAt: future, consumedAt: null }]];
    expect(await setupTokenOwner("a-token")).toBe(USER);
  });

  it("names nobody for a token that is empty, unknown, spent or expired", async () => {
    state.answers = [
      [],
      [{ userId: USER, expiresAt: future, consumedAt: new Date() }],
      [{ userId: USER, expiresAt: past, consumedAt: null }],
    ];
    expect(await setupTokenOwner("")).toBeNull();
    expect(state.answers).toHaveLength(3);
    expect(await setupTokenOwner("unknown")).toBeNull();
    expect(await setupTokenOwner("spent")).toBeNull();
    expect(await setupTokenOwner("expired")).toBeNull();
  });
});
