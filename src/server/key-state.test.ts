import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1405: whether Orbit holds a usable encryption key is decided once, at
 * startup, by a self-test (design-1405 section 1) and held in the process the
 * way `bootPhase` is. This file pins the verdict and its five faults, with
 * the database, the configuration and the key unwrap stood in for, so every
 * assertion is about the decision and none about plumbing:
 *
 *   missing | unreadable | malformed | both_forms   found from the settings
 *   mismatch                                        the database was written
 *                                                   under a key not held
 *   key_row_damaged                                 held key, row will not open
 *
 * The real database and a real wrong key are tests/integration/key-maintenance.test.ts.
 */

const mocks = vi.hoisted(() => ({
  documentKeyProblem: vi.fn(),
  getDocumentConfig: vi.fn(),
  keyEncryptionKeyFor: vi.fn(),
  unwrapMetadataKey: vi.fn(),
  rows: vi.fn(),
  queries: vi.fn(),
  writes: vi.fn(),
}));

vi.mock("@/server/documents/config", () => ({
  documentKeyProblem: mocks.documentKeyProblem,
  getDocumentConfig: mocks.getDocumentConfig,
  keyEncryptionKeyFor: mocks.keyEncryptionKeyFor,
}));
vi.mock("@/server/metadata/crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/metadata/crypto")>()),
  unwrapMetadataKey: mocks.unwrapMetadataKey,
}));

/* A statement of any shape: every builder call returns the same thenable, and
   awaiting it answers whatever rows the test set. The probe's own query style
   (select builder or raw execute) is not what is under test. Both spellings of
   each column are present so the answer fits either. */
function statement(): unknown {
  const settled = () => Promise.resolve().then(() => mocks.rows());
  const chain: unknown = new Proxy(function chainable() { /* callable target */ }, {
    get(_target, property) {
      if (property === "then") return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => settled().then(resolve, reject);
      return () => chain;
    },
    apply: () => chain,
  });
  mocks.queries();
  return chain;
}
vi.mock("@/db", () => ({
  getDb: () => ({
    select: statement,
    execute: statement,
    insert: () => { mocks.writes("insert"); return statement(); },
    update: () => { mocks.writes("update"); return statement(); },
    delete: () => { mocks.writes("delete"); return statement(); },
    transaction: (callback: (executor: unknown) => unknown) => callback({ select: statement, execute: statement }),
  }),
}));

import {
  assertKeyUsable,
  getKeyState,
  KeyUnavailableError,
  probeEncryptionKey,
  setKeyStateForTests,
} from "./key-state";

const HELD = "aaaaaaaaaaaaaaaaaaaaaaaa";
const STORED = "bbbbbbbbbbbbbbbbbbbbbbbb";

const instanceKeyRow = (keyId: string) => ({
  keyId, key_id: keyId,
  wrappedDek: "wrapped", wrapped_dek: "wrapped",
  wrapIv: "iv", wrap_iv: "iv",
  wrapAuthTag: "tag", wrap_auth_tag: "tag",
});

beforeEach(() => {
  vi.useRealTimers();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.documentKeyProblem.mockReturnValue(null);
  mocks.getDocumentConfig.mockReturnValue({
    keyId: HELD,
    keyEncryptionKey: Buffer.alloc(32, 1),
    nextKeyId: null,
    nextKeyEncryptionKey: null,
  });
  mocks.keyEncryptionKeyFor.mockImplementation((config: { keyId: string; keyEncryptionKey: Buffer }, keyId: string) =>
    keyId === config.keyId ? config.keyEncryptionKey : undefined);
  mocks.unwrapMetadataKey.mockImplementation(() => Buffer.alloc(32, 7));
  mocks.rows.mockReturnValue([]);
  setKeyStateForTests(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  setKeyStateForTests(undefined);
});

describe("what a process knows about its key before the self-test has run", () => {
  it("is unknown, and a gate must read unknown as closed", () => {
    expect(getKeyState()).toEqual({ verdict: "unknown" });
    expect(() => assertKeyUsable()).toThrow(KeyUnavailableError);
  });

  it("opens only for a usable verdict", () => {
    setKeyStateForTests({ verdict: "usable", heldKeyId: HELD });
    expect(() => assertKeyUsable()).not.toThrow();
    expect(getKeyState()).toEqual({ verdict: "usable", heldKeyId: HELD });

    setKeyStateForTests({ verdict: "unusable", reason: "mismatch", heldKeyId: HELD, storedKeyId: STORED });
    expect(() => assertKeyUsable()).toThrow(KeyUnavailableError);
  });

  it("carries a message that names no key", () => {
    setKeyStateForTests({ verdict: "unusable", reason: "mismatch", heldKeyId: HELD, storedKeyId: STORED });
    let failure: unknown;
    try {
      assertKeyUsable();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(KeyUnavailableError);
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure as object))).not.toContain(HELD);
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure as object))).not.toContain(STORED);
  });
});

describe("probeEncryptionKey (#1405 section 1)", () => {
  it("is unusable at once for a fault in the settings, without asking the database", async () => {
    mocks.documentKeyProblem.mockReturnValue("missing");

    const verdict = await probeEncryptionKey();

    expect(verdict).toMatchObject({ verdict: "unusable", reason: "missing" });
    expect(getKeyState()).toMatchObject({ verdict: "unusable", reason: "missing" });
    expect(mocks.queries).not.toHaveBeenCalled();
  });

  it.each(["unreadable", "malformed", "both_forms"] as const)("carries the %s reason through", async (reason) => {
    mocks.documentKeyProblem.mockReturnValue(reason);
    expect(await probeEncryptionKey()).toMatchObject({ verdict: "unusable", reason });
  });

  it("is usable, holding the configured key id, when no key has ever been written (a fresh instance)", async () => {
    mocks.rows.mockReturnValue([]);

    const verdict = await probeEncryptionKey();

    expect(verdict).toEqual({ verdict: "usable", heldKeyId: HELD });
    expect(getKeyState()).toEqual({ verdict: "usable", heldKeyId: HELD });
    expect(mocks.unwrapMetadataKey).not.toHaveBeenCalled();
  });

  it("is a mismatch, naming both ids, when the stored key is wrapped under a key this instance does not hold", async () => {
    mocks.rows.mockReturnValue([instanceKeyRow(STORED)]);

    const verdict = await probeEncryptionKey();

    expect(verdict).toMatchObject({ verdict: "unusable", reason: "mismatch", heldKeyId: HELD, storedKeyId: STORED });
    expect(HELD).not.toBe(STORED);
    expect(mocks.unwrapMetadataKey).not.toHaveBeenCalled();
  });

  it("is usable when the stored key unwraps under a key that is held, including the next key during a rotation", async () => {
    const next = "cccccccccccccccccccccccc";
    mocks.getDocumentConfig.mockReturnValue({
      keyId: HELD, keyEncryptionKey: Buffer.alloc(32, 1), nextKeyId: next, nextKeyEncryptionKey: Buffer.alloc(32, 2),
    });
    mocks.keyEncryptionKeyFor.mockImplementation((config: { keyId: string; nextKeyId: string; keyEncryptionKey: Buffer; nextKeyEncryptionKey: Buffer }, keyId: string) =>
      keyId === config.keyId ? config.keyEncryptionKey : keyId === config.nextKeyId ? config.nextKeyEncryptionKey : undefined);
    mocks.rows.mockReturnValue([instanceKeyRow(next)]);

    expect(await probeEncryptionKey()).toMatchObject({ verdict: "usable", heldKeyId: HELD });
    expect(mocks.unwrapMetadataKey).toHaveBeenCalledTimes(1);
  });

  it("is a damaged key row, not a wrong key, when the held key's own row will not unwrap", async () => {
    mocks.rows.mockReturnValue([instanceKeyRow(HELD)]);
    mocks.unwrapMetadataKey.mockImplementation(() => { throw new Error("Unsupported state or unable to authenticate data"); });

    const verdict = await probeEncryptionKey();

    expect(verdict).toMatchObject({ verdict: "unusable", reason: "key_row_damaged", heldKeyId: HELD, storedKeyId: HELD });
  });

  it("zeroes the key it unwrapped and keeps no copy: it probes, it does not load", async () => {
    const unwrapped = Buffer.alloc(32, 7);
    mocks.rows.mockReturnValue([instanceKeyRow(HELD)]);
    mocks.unwrapMetadataKey.mockReturnValue(unwrapped);

    expect(await probeEncryptionKey()).toMatchObject({ verdict: "usable" });

    expect(unwrapped.every((byte) => byte === 0)).toBe(true);
  });

  it("writes nothing", async () => {
    mocks.rows.mockReturnValue([instanceKeyRow(HELD)]);
    await probeEncryptionKey();
    mocks.rows.mockReturnValue([instanceKeyRow(STORED)]);
    await probeEncryptionKey();
    mocks.rows.mockReturnValue([]);
    await probeEncryptionKey();
    expect(mocks.queries).toHaveBeenCalled();
    expect(mocks.writes).not.toHaveBeenCalled();
  });

  it("never puts a key's bytes in the verdict", async () => {
    const kek = Buffer.alloc(32, 1);
    mocks.rows.mockReturnValue([instanceKeyRow(STORED)]);

    const verdict = await probeEncryptionKey();

    expect(JSON.stringify(verdict)).not.toContain(kek.toString("hex"));
    expect(JSON.stringify(verdict)).not.toContain(kek.toString("base64"));
  });
});

describe("when the database cannot answer (an outage is not this mode)", () => {
  it("tries again every five seconds and settles when the database comes back", async () => {
    vi.useFakeTimers();
    mocks.rows
      .mockImplementationOnce(() => { throw new Error("connect ECONNREFUSED"); })
      .mockImplementationOnce(() => { throw new Error("connect ECONNREFUSED"); })
      .mockImplementation(() => []);

    const settled = vi.fn();
    const result = probeEncryptionKey().then(settled, settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    expect(mocks.queries).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.queries).toHaveBeenCalledTimes(2);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    await result;
    expect(mocks.queries).toHaveBeenCalledTimes(3);
    expect(settled).toHaveBeenCalledWith({ verdict: "usable", heldKeyId: HELD });
    expect(getKeyState()).toEqual({ verdict: "usable", heldKeyId: HELD });
  });

  it("gives up with a rejection once the startup window has passed, and does not call the key unusable", async () => {
    vi.useFakeTimers();
    mocks.rows.mockImplementation(() => { throw new Error("connect ECONNREFUSED"); });

    const outcome = probeEncryptionKey().then(() => "resolved", () => "rejected");
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(await outcome).toBe("rejected");
    expect(getKeyState()).toEqual({ verdict: "unknown" });
  });
});
