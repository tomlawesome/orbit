import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, credentialSetupTokens, externalIdentities, instanceAuthority, localCredentials, sessions, userPreferences, users } from "@/db/schema";
import { AuthError } from "@/lib/auth/errors";
import { VerificationGateRefusedError } from "@/lib/auth/verification-gate";

/**
 * The credential repository beyond the setup-token lock (see
 * `local-credentials.test.ts`): the lockout schedule, account creation, the
 * uniform sign-in verdicts, setup and recovery tokens, password changes, the
 * sign-in methods and provider removal, against a scripted stand-in for the
 * database. Each awaited select gets the next scripted answer; every write is
 * recorded and asserted on.
 */

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  oidc: { issuer: "https://idp.example.test" } as { issuer: string } | null,
  cipherLocked: false,
  emailIndex: "index-1" as string | null,
  address: { state: "ok", value: "member@example.test" } as { state: string; value?: string },
  mailReady: true,
}));

vi.mock("@/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/env", () => ({ getAuthConfig: () => ({ oidc: state.oidc }) }));
vi.mock("@/lib/auth/password", () => ({
  hashPassword: vi.fn(async () => "$argon2id$upgraded"),
  verifyAgainstDecoy: vi.fn(async () => undefined),
  verifyPassword: vi.fn(async () => ({ verified: true, needsRehash: false })),
}));
vi.mock("@/server/authorization", () => ({ requireActiveAdministrator: vi.fn(async () => undefined) }));
vi.mock("@/server/invitations/send", () => ({ outgoingMailReady: vi.fn(async () => state.mailReady) }));
vi.mock("@/server/whats-new", () => ({ recordNewAccountSeenVersion: vi.fn(async () => undefined) }));
vi.mock("@/server/metadata/fields", () => ({
  requireInstanceMetadataWriter: async () => ({
    emailIndex: (email: string) => (state.emailIndex === null ? null : `${state.emailIndex}:${email}`),
    encryptText: (column: string, id: string, text: string) => `enc:${column}:${id}:${text}`,
  }),
  openInstanceMetadataReader: async () => ({
    get locked() { return state.cipherLocked; },
    emailIndex: (email: string) => (state.emailIndex === null ? null : `${state.emailIndex}:${email}`),
    text: () => state.address,
  }),
}));
vi.mock("@/server/local-credentials/setup-mail", () => ({
  sendSetupLink: vi.fn(async () => ({ sendError: null })),
  unreadableAddressError: (reason: string) => Object.assign(new Error(reason), { code: `unreadable_${reason}` }),
}));

const repository = await import("./local-credentials");
const { hashPassword, verifyAgainstDecoy, verifyPassword } = await import("@/lib/auth/password");
const { requireActiveAdministrator } = await import("@/server/authorization");
const { outgoingMailReady } = await import("@/server/invitations/send");
const { sendSetupLink } = await import("@/server/local-credentials/setup-mail");
const { recordNewAccountSeenVersion } = await import("@/server/whats-new");

interface Op { kind: string; table?: unknown; args: Record<string, unknown[]>; returning: boolean }
type Step = unknown | Error | ((op: Op, ops: Op[]) => unknown);

function scriptedDb(steps: Step[], options: { execute?: () => unknown } = {}) {
  const ops: Op[] = [];
  const queue = [...steps];
  const take = (op: Op) => {
    if (!queue.length) return [];
    const step = queue.shift();
    const value = typeof step === "function" ? (step as (o: Op, all: Op[]) => unknown)(op, ops) : step;
    if (value instanceof Error) throw value;
    return value;
  };
  const chain = (kind: string, table?: unknown, consumes = true) => {
    const op: Op = { kind, table, args: {}, returning: false };
    ops.push(op);
    const proxy: unknown = new Proxy({}, {
      get(_target, property: string) {
        if (property === "then") {
          return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve().then(() => (consumes || op.returning ? take(op) : [])).then(resolve, reject);
        }
        return (...args: unknown[]) => {
          op.args[property] = args;
          if (property === "returning") op.returning = true;
          if (property === "from" && !op.table) op.table = args[0];
          return proxy;
        };
      },
    });
    return proxy;
  };
  const db: Record<string, unknown> = {
    select: () => chain("select"),
    selectDistinct: () => chain("select"),
    insert: (table: unknown) => chain("insert", table, false),
    update: (table: unknown) => chain("update", table, false),
    delete: (table: unknown) => chain("delete", table, false),
    execute: () => Promise.resolve().then(() => (options.execute ? options.execute() : [])),
    transaction: async (body: (executor: unknown) => unknown) => body(db),
  };
  return { db: db as never, ops, remaining: () => queue.length };
}


const NOW = new Date("2026-11-01T12:00:00.000Z");
const USER = "22222222-2222-4222-8222-222222222222";
const IDENTITY = "33333333-3333-4333-8333-333333333333";
const use = (steps: Step[]) => {
  const script = scriptedDb(steps);
  state.db = script.db;
  return script;
};
const rows = (ops: Op[], kind: string, table: unknown) => ops.filter((op) => op.kind === kind && op.table === table);
const values = (ops: Op[], table: unknown) => rows(ops, "insert", table).map((op) => op.args.values![0] as Record<string, unknown>);
const sets = (ops: Op[], table: unknown) => rows(ops, "update", table).map((op) => op.args.set![0] as Record<string, unknown>);
const audits = (ops: Op[]) => values(ops, auditLog);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  state.oidc = { issuer: "https://idp.example.test" };
  state.cipherLocked = false;
  state.emailIndex = "index-1";
  state.address = { state: "ok", value: "member@example.test" };
  state.mailReady = true;
  vi.mocked(verifyPassword).mockResolvedValue({ verified: true, needsRehash: false });
  vi.mocked(verifyAgainstDecoy).mockResolvedValue(undefined);
  vi.mocked(hashPassword).mockResolvedValue("$argon2id$upgraded");
  vi.mocked(requireActiveAdministrator).mockClear();
  vi.mocked(requireActiveAdministrator).mockResolvedValue(undefined);
  vi.mocked(outgoingMailReady).mockClear();
  vi.mocked(sendSetupLink).mockReset();
  vi.mocked(sendSetupLink).mockResolvedValue({ sendError: null } as never);
  vi.mocked(verifyAgainstDecoy).mockClear();
  vi.mocked(verifyPassword).mockClear();
});
afterEach(() => { vi.useRealTimers(); state.db = undefined; });

describe("lockoutMs (ADR-0023 §4)", () => {
  it("is zero for the five free attempts, then a second doubling each failure to the fifteen-minute ceiling", () => {
    for (const failures of [-1, 0, 1, 5]) expect(repository.lockoutMs(failures)).toBe(0);
    expect(repository.lockoutMs(6)).toBe(1_000);
    expect(repository.lockoutMs(7)).toBe(2_000);
    expect(repository.lockoutMs(10)).toBe(16_000);
    expect(repository.lockoutMs(15)).toBe(512_000);
    expect(repository.lockoutMs(16)).toBe(900_000);
    expect(repository.lockoutMs(500)).toBe(repository.LOCAL_LOCKOUT_CEILING_MS);
  });
});

describe("setup link lifetimes", () => {
  it.each([undefined, 1, 7, 14])("accepts %s", (days) => {
    expect(() => repository.assertSetupTokenLifetime(days)).not.toThrow();
  });

  it.each([0, 15, 1.5, -3, Number.NaN])("refuses %s days with a 400", (days) => {
    expect(() => repository.assertSetupTokenLifetime(days)).toThrow(AuthError);
    try { repository.assertSetupTokenLifetime(days); } catch (error) { expect(error).toMatchObject({ code: "invalid_request", status: 400 }); }
  });

  it("mints a recovery token that lasts five minutes whatever lifetime was asked for", () => {
    const minted = repository.mintSetupToken("recovery", 99);
    expect(minted.expiresAt.getTime()).toBe(NOW.getTime() + repository.RECOVERY_TOKEN_TTL_MS);
    expect(minted.purpose).toBe("recovery");
  });

  it("mints a setup token for seven days by default, or the days chosen, and refuses a bad choice", () => {
    expect(repository.mintSetupToken("setup").expiresAt.getTime()).toBe(NOW.getTime() + 7 * 86_400_000);
    expect(repository.mintSetupToken("setup", 14).expiresAt.getTime()).toBe(NOW.getTime() + 14 * 86_400_000);
    expect(() => repository.mintSetupToken("setup", 15)).toThrow(AuthError);
  });

  it("keeps only the token's sha256 at rest, and never mints the same token twice", () => {
    const first = repository.mintSetupToken("setup");
    const second = repository.mintSetupToken("setup");
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first.tokenHash).toBe(createHash("sha256").update(first.token).digest("hex"));
    expect(first.token).not.toBe(second.token);
  });
});

describe("createLocalUser", () => {
  const draft = { email: "  Ada@Example.test ", displayName: "  Ada  ", passwordHash: "$argon2id$hash" };

  it.each([
    ["an invalid address", { ...draft, email: "not-an-address" }],
    ["an address over 320 characters", { ...draft, email: `${"a".repeat(320)}@example.test` }],
    ["an empty name", { ...draft, displayName: "   " }],
    ["a name over 128 characters", { ...draft, displayName: "n".repeat(129) }],
  ])("refuses %s before touching the database", async (_name, input) => {
    const { ops } = use([]);
    await expect(repository.createLocalUser(input)).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(ops).toHaveLength(0);
  });

  it("creates the account with its address encrypted under its own id, preferences and credential, answering with the trimmed address", async () => {
    const { ops } = use([[], [{ id: "new-user", displayName: "Ada" }]]);
    const created = await repository.createLocalUser(draft);
    expect(created).toEqual({ id: "new-user", displayName: "Ada", email: "Ada@Example.test" });
    const [user] = values(ops, users);
    expect(user).toMatchObject({ emailIndex: "index-1:Ada@Example.test", emailVerified: false, displayName: "Ada", isInstanceAdmin: false });
    expect(user!.emailEnc).toBe(`enc:users.email:${user!.id}:Ada@Example.test`);
    expect(values(ops, userPreferences)).toEqual([{ userId: "new-user" }]);
    expect(values(ops, localCredentials)).toEqual([{ userId: "new-user", passwordHash: "$argon2id$hash" }]);
    expect(recordNewAccountSeenVersion).toHaveBeenCalledWith("new-user", process.env.ORBIT_VERSION, expect.anything());
    expect(audits(ops)).toHaveLength(0);
  });

  it("creates no credential for a user who has not chosen a password, and audits the administrator who made them", async () => {
    const { ops } = use([[], [{ id: "new-user", displayName: "Ada" }]]);
    await repository.createLocalUser({ email: "ada@example.test", displayName: "Ada" }, { createdByUserId: "admin", bootstrap: false });
    expect(values(ops, localCredentials)).toHaveLength(0);
    expect(audits(ops)).toEqual([{
      householdId: null, actorUserId: "admin", entityType: "user", entityId: "new-user", action: "local_user_created", changes: { userId: "new-user" },
    }]);
  });

  it("refuses an address another account already holds with the link-it guidance, creating nothing", async () => {
    const { ops } = use([[{ id: "other" }]]);
    await expect(repository.createLocalUser(draft)).rejects.toMatchObject({ code: "link_required", status: 403 });
    expect(values(ops, users)).toHaveLength(0);
  });

  it("skips the address check when the key has no index to look up, and still creates", async () => {
    state.emailIndex = null;
    const { ops } = use([[{ id: "new-user", displayName: "Ada" }]]);
    await repository.createLocalUser(draft);
    expect(values(ops, users)[0]!.emailIndex).toBeNull();
  });

  it("the claim seats the first administrator and its authority row, and records the claim", async () => {
    const { ops } = use([[{ seats: 0 }], [], [{ id: "first", displayName: "Ada" }]]);
    await repository.createLocalUser(draft, { bootstrap: true, createdByUserId: "ignored" });
    expect(values(ops, users)[0]).toMatchObject({ isInstanceAdmin: true });
    expect(values(ops, instanceAuthority)).toEqual([{ primaryUserId: "first" }]);
    expect(audits(ops)).toEqual([{
      householdId: null, actorUserId: "first", entityType: "user", entityId: "first", action: "instance_claimed", changes: { method: "local" },
    }]);
  });

  it("a claim on an instance that already has an authority is refused, creating nothing", async () => {
    const { ops } = use([[{ seats: 1 }]]);
    await expect(repository.createLocalUser(draft, { bootstrap: true })).rejects.toMatchObject({ code: "bootstrap_claimed", status: 409 });
    expect(values(ops, users)).toHaveLength(0);
  });
});

describe("verifying a sign-in", () => {
  const account = { userId: USER, disabledAt: null, passwordHash: "$argon2id$stored", lockedUntil: null };

  it("verifies, clears the failure counter and records the time, answering with the user", async () => {
    const { ops } = use([[account]]);
    expect(await repository.verifyCredential(" ada@example.test ", "pw")).toEqual({ outcome: "verified", userId: USER });
    expect(verifyPassword).toHaveBeenCalledWith("$argon2id$stored", "pw");
    expect(sets(ops, localCredentials)[0]).toMatchObject({ failedAttemptCount: 0, lockedUntil: null, lastVerifiedAt: NOW });
    expect(sets(ops, localCredentials)[0]).not.toHaveProperty("passwordHash");
  });

  it("looks the account up by the blind index of the trimmed address", async () => {
    const { ops } = use([[account]]);
    await repository.verifyCredential("  ada@example.test ", "pw");
    const found: unknown[] = [];
    const walk = (node: unknown, seen = new Set<unknown>()): void => {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (typeof (node as { value?: unknown }).value === "string") found.push((node as { value: string }).value);
      for (const child of Object.values(node)) if (child && typeof child === "object" && !(child as { dataType?: unknown }).dataType) walk(child, seen);
    };
    walk(ops[0]!.args.where![0]);
    expect(found).toContain("index-1:ada@example.test");
  });

  it("upgrades a hash made below policy in the same write", async () => {
    vi.mocked(verifyPassword).mockResolvedValue({ verified: true, needsRehash: true });
    const { ops } = use([[account]]);
    await repository.verifyCredential("a@example.test", "pw");
    expect(hashPassword).toHaveBeenCalledWith("pw");
    expect(sets(ops, localCredentials)[0]).toMatchObject({ passwordHash: "$argon2id$upgraded" });
  });

  it("signs in on the old hash when the upgrade is refused", async () => {
    vi.mocked(verifyPassword).mockResolvedValue({ verified: true, needsRehash: true });
    vi.mocked(hashPassword).mockRejectedValue(new VerificationGateRefusedError("queue_full"));
    const { ops } = use([[account]]);
    expect(await repository.verifyCredentialForUser(USER, "pw")).toEqual({ outcome: "verified", userId: USER });
    expect(sets(ops, localCredentials)[0]).not.toHaveProperty("passwordHash");
  });

  it.each([
    ["no such account", [[]]],
    ["a disabled account", [[{ ...account, disabledAt: NOW }]]],
    ["an account with no password yet", [[{ ...account, passwordHash: null }]]],
  ])("answers %s exactly as a wrong password, spending the decoy derivation and counting nothing", async (_name, steps) => {
    const { ops } = use(steps as Step[]);
    expect(await repository.verifyCredentialForUser(USER, "pw")).toEqual({ outcome: "rejected" });
    expect(verifyAgainstDecoy).toHaveBeenCalledWith("pw");
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(rows(ops, "update", localCredentials)).toHaveLength(0);
  });

  it("answers rejected, with the decoy, for an address that cannot match (key locked or no index)", async () => {
    state.cipherLocked = true;
    const { ops } = use([]);
    expect(await repository.verifyCredential("a@example.test", "pw")).toEqual({ outcome: "rejected" });
    expect(verifyAgainstDecoy).toHaveBeenCalledTimes(1);
    state.cipherLocked = false;
    state.emailIndex = null;
    expect(await repository.verifyCredential("a@example.test", "pw")).toEqual({ outcome: "rejected" });
    expect(ops).toHaveLength(0);
  });

  it("is throttled, without checking the password, while the persisted lock runs", async () => {
    use([[{ ...account, lockedUntil: new Date(NOW.getTime() + 5_000) }]]);
    expect(await repository.verifyCredential("a@example.test", "pw")).toEqual({ outcome: "throttled" });
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("checks the password again once the lock has run out", async () => {
    use([[{ ...account, lockedUntil: new Date(NOW.getTime() - 1) }]]);
    expect(await repository.verifyCredential("a@example.test", "pw")).toMatchObject({ outcome: "verified" });
  });

  it("counts a wrong password: free until the sixth failure, which locks for a second", async () => {
    vi.mocked(verifyPassword).mockResolvedValue({ verified: false, needsRehash: false });
    const free = use([[account], [{ failedAttemptCount: 3 }]]);
    expect(await repository.verifyCredential("a@example.test", "bad")).toEqual({ outcome: "rejected" });
    expect(sets(free.ops, localCredentials)[0]).toMatchObject({ failedAttemptCount: 4, lockedUntil: null });
    const sixth = use([[account], [{ failedAttemptCount: 5 }]]);
    await repository.verifyCredential("a@example.test", "bad");
    expect(sets(sixth.ops, localCredentials)[0]).toMatchObject({ failedAttemptCount: 6, lockedUntil: new Date(NOW.getTime() + 1_000) });
  });

  it("counts nothing for a credential row that vanished meanwhile", async () => {
    vi.mocked(verifyPassword).mockResolvedValue({ verified: false, needsRehash: false });
    const { ops } = use([[account], []]);
    await repository.verifyCredential("a@example.test", "bad");
    expect(rows(ops, "update", localCredentials)).toHaveLength(0);
  });

  it("answers throttled when the verification gate refuses, and lets any other failure through", async () => {
    vi.mocked(verifyPassword).mockRejectedValue(new VerificationGateRefusedError("queue_timeout"));
    use([[account]]);
    expect(await repository.verifyCredential("a@example.test", "pw")).toEqual({ outcome: "throttled" });
    vi.mocked(verifyPassword).mockRejectedValue(new Error("database"));
    use([[account]]);
    await expect(repository.verifyCredential("a@example.test", "pw")).rejects.toThrow("database");
  });

  it("recordLocalCredentialFailure applies the schedule under the caller's executor", async () => {
    const { db, ops } = scriptedDb([[{ failedAttemptCount: 9 }]]);
    await repository.recordLocalCredentialFailure(db, USER);
    expect(sets(ops, localCredentials)[0]).toMatchObject({ failedAttemptCount: 10, lockedUntil: new Date(NOW.getTime() + 16_000) });
  });
});

describe("persisting and issuing setup tokens", () => {
  it("refuses a user who no longer exists, writing nothing", async () => {
    const { ops } = use([[]]);
    await expect(repository.persistSetupToken(USER, repository.mintSetupToken("setup"), null)).rejects.toMatchObject({ code: "user_not_found", status: 404 });
    expect(ops.filter((op) => op.kind !== "select")).toHaveLength(0);
  });

  it("writes nothing and answers false when a live link exists and the caller asked not to retire it", async () => {
    const { ops } = use([[{ id: USER }], [{ id: "live" }]]);
    expect(await repository.persistSetupToken(USER, repository.mintSetupToken("setup"), null, { onlyIfNoLiveLink: true })).toBe(false);
    expect(ops.filter((op) => op.kind !== "select")).toHaveLength(0);
  });

  it("writes the link, expires earlier unspent ones, and audits the issue with no token in it", async () => {
    const minted = repository.mintSetupToken("recovery");
    const { ops } = use([[{ id: USER }], []]);
    expect(await repository.persistSetupToken(USER, minted, "admin", { onlyIfNoLiveLink: true })).toBe(true);
    expect(sets(ops, credentialSetupTokens)).toEqual([{ expiresAt: NOW }]);
    expect(values(ops, credentialSetupTokens)).toEqual([{ userId: USER, tokenHash: minted.tokenHash, purpose: "recovery", expiresAt: minted.expiresAt, createdByUserId: "admin" }]);
    expect(audits(ops)).toEqual([{ householdId: null, actorUserId: "admin", entityType: "user", entityId: USER, action: "setup_link_issued", changes: { userId: USER, purpose: "recovery" } }]);
    expect(JSON.stringify(audits(ops))).not.toContain(minted.token);
  });

  it("issueSetupToken hands back the token itself and its expiry, storing only the digest", async () => {
    const { ops } = use([[{ id: USER }]]);
    const issued = await repository.issueSetupToken(USER, "setup", { createdByUserId: "admin", expiresInDays: 3 });
    expect(issued.expiresAt.getTime()).toBe(NOW.getTime() + 3 * 86_400_000);
    expect(values(ops, credentialSetupTokens)[0]).toMatchObject({
      tokenHash: createHash("sha256").update(issued.token).digest("hex"), createdByUserId: "admin",
    });
    use([[{ id: USER }]]);
    await repository.issueSetupToken(USER, "recovery");
    await expect(repository.issueSetupToken(USER, "setup", { expiresInDays: 0 })).rejects.toBeInstanceOf(AuthError);
  });
});

describe("setting a password", () => {
  it("a first password revokes nothing and records password_set", async () => {
    const { ops } = use([[]]);
    expect(await repository.setPassword(USER, "$hash", "actor")).toEqual({ replaced: false, sessionsRevoked: 0 });
    expect(values(ops, localCredentials)).toEqual([{ userId: USER, passwordHash: "$hash" }]);
    expect(rows(ops, "delete", sessions)).toHaveLength(0);
    expect(audits(ops)[0]).toMatchObject({ action: "password_set", changes: {}, actorUserId: "actor", entityId: USER });
  });

  it("a replacement resets the counter and lock, revokes every session, and records how many", async () => {
    const { ops } = use([[{ userId: USER }], [{ id: "s1" }, { id: "s2" }]]);
    expect(await repository.setPassword(USER, "$new", "actor")).toEqual({ replaced: true, sessionsRevoked: 2 });
    expect(sets(ops, localCredentials)[0]).toMatchObject({ passwordHash: "$new", failedAttemptCount: 0, lockedUntil: null, passwordChangedAt: NOW });
    expect(audits(ops)[0]).toMatchObject({ action: "password_changed", changes: { sessionsRevoked: 2 } });
  });

  it("hasLocalCredential and hasAnyLocalCredential answer from the rows", async () => {
    use([[{ userId: USER }]]);
    expect(await repository.hasLocalCredential(USER)).toBe(true);
    use([[]]);
    expect(await repository.hasLocalCredential(USER)).toBe(false);
    use([[{ userId: USER }]]);
    expect(await repository.hasAnyLocalCredential()).toBe(true);
    use([[]]);
    expect(await repository.hasAnyLocalCredential()).toBe(false);
  });
});

describe("consumeSetupToken", () => {
  const live = { id: "t1", userId: USER, purpose: "setup", expiresAt: new Date(NOW.getTime() + 60_000), consumedAt: null };

  it.each([
    ["unknown", []],
    ["already consumed", [{ ...live, consumedAt: new Date(NOW.getTime() - 1) }]],
    ["expired", [{ ...live, expiresAt: new Date(NOW.getTime() - 1) }]],
    ["expiring this instant", [{ ...live, expiresAt: NOW }]],
  ])("answers one generic refusal for a token that is %s, changing nothing", async (_name, found) => {
    const { ops } = use([found]);
    await expect(repository.consumeSetupToken("tok", "$hash")).rejects.toMatchObject({ code: "setup_token_invalid", status: 400 });
    expect(ops.filter((op) => op.kind !== "select")).toHaveLength(0);
  });

  it("spends the token and sets the owner's first password, with the owner as the actor", async () => {
    const { ops } = use([[live], []]);
    expect(await repository.consumeSetupToken("tok", "$hash")).toEqual({ userId: USER, purpose: "setup", replaced: false, sessionsRevoked: 0 });
    expect(sets(ops, credentialSetupTokens)[0]).toEqual({ consumedAt: NOW });
    expect(ops[0]!.args.where![0]).toBeDefined();
    expect(audits(ops)[0]).toMatchObject({ actorUserId: USER, action: "password_set" });
  });

  it("a recovery token replaces the password and ends the sessions", async () => {
    use([[{ ...live, purpose: "recovery" }], [{ userId: USER }], [{ id: "s1" }]]);
    expect(await repository.consumeSetupToken("tok", "$hash")).toEqual({ userId: USER, purpose: "recovery", replaced: true, sessionsRevoked: 1 });
  });
});

describe("sign-in methods", () => {
  it("lists the caller's password state and linked providers without their subjects", async () => {
    const changed = new Date("2026-10-01T00:00:00.000Z");
    const identity = { id: IDENTITY, issuer: "https://idp.example.test", linkedAt: changed, lastLoginAt: NOW };
    use([[{ changedAt: changed }], [identity]]);
    expect(await repository.listMethods(USER)).toEqual({ local: { set: true, changedAt: changed }, oidc: [identity] });
    use([[], []]);
    expect(await repository.listMethods(USER)).toEqual({ local: { set: false, changedAt: null }, oidc: [] });
  });

  it("links a provider identity to the account and audits it", async () => {
    const { ops } = use([[], [{ id: USER, disabledAt: null }], [{ id: "link1" }]]);
    expect(await repository.linkIdentity(USER, { issuer: "https://idp.example.test", subject: "sub-1" } as never)).toEqual({ identityId: "link1" });
    expect(values(ops, externalIdentities)).toEqual([{ userId: USER, issuer: "https://idp.example.test", subject: "sub-1" }]);
    expect(audits(ops)[0]).toMatchObject({ action: "identity_linked", actorUserId: USER, changes: { identityId: "link1" } });
  });

  it("never moves or duplicates a linked identity, and refuses a missing or disabled account", async () => {
    const identity = { issuer: "https://idp.example.test", subject: "sub-1" } as never;
    const taken = use([[{ id: "link0" }]]);
    await expect(repository.linkIdentity(USER, identity)).rejects.toMatchObject({ code: "link_exists", status: 409 });
    expect(values(taken.ops, externalIdentities)).toHaveLength(0);
    use([[], []]);
    await expect(repository.linkIdentity(USER, identity)).rejects.toMatchObject({ code: "user_not_found", status: 404 });
    use([[], [{ id: USER, disabledAt: NOW }]]);
    await expect(repository.linkIdentity(USER, identity)).rejects.toMatchObject({ code: "account_disabled", status: 403 });
  });
});

describe("removing a sign-in method", () => {
  const receipt = { userId: USER, intent: "unlink_method", method: "password" } as never;

  it.each([
    ["someone else's receipt", { userId: "other", intent: "unlink_method", method: "password" }],
    ["a receipt for another action", { userId: USER, intent: "change_password", method: "password" }],
  ])("refuses %s before the database is touched", async (_name, wrong) => {
    const { ops } = use([]);
    await expect(repository.unlinkLocal(USER, wrong as never)).rejects.toMatchObject({ code: "recent_authentication_required", status: 403 });
    await expect(repository.unlinkIdentity(USER, IDENTITY, wrong as never)).rejects.toMatchObject({ code: "recent_authentication_required" });
    expect(ops).toHaveLength(0);
  });

  it("unlinkLocal removes the password only while a provider identity remains and is usable", async () => {
    const { ops } = use([[{ userId: USER }], [{ id: IDENTITY }]]);
    expect(await repository.unlinkLocal(USER, receipt)).toEqual({ removed: true });
    expect(rows(ops, "delete", localCredentials)).toHaveLength(1);
    expect(audits(ops)[0]).toMatchObject({ action: "password_removed", actorUserId: USER });
  });

  it("unlinkLocal keeps the last way in: no identity, or the provider switched off", async () => {
    const none = use([[{ userId: USER }], []]);
    await expect(repository.unlinkLocal(USER, receipt)).rejects.toMatchObject({ code: "link_last_method", status: 409 });
    expect(rows(none.ops, "delete", localCredentials)).toHaveLength(0);
    state.oidc = null;
    use([[{ userId: USER }], [{ id: IDENTITY }]]);
    await expect(repository.unlinkLocal(USER, receipt)).rejects.toMatchObject({ code: "link_last_method" });
  });

  it("unlinkLocal says there is no such method when there is no password", async () => {
    use([[]]);
    await expect(repository.unlinkLocal(USER, receipt)).rejects.toMatchObject({ code: "credential_not_found", status: 404 });
  });

  it("unlinkIdentity treats a malformed or foreign id as simply not found", async () => {
    use([]);
    await expect(repository.unlinkIdentity(USER, "not-a-uuid", receipt)).rejects.toMatchObject({ code: "identity_not_found", status: 404 });
    use([[]]);
    await expect(repository.unlinkIdentity(USER, IDENTITY, receipt)).rejects.toMatchObject({ code: "identity_not_found", status: 404 });
  });

  it("unlinkIdentity removes it when a password remains, even with the provider off", async () => {
    state.oidc = null;
    const { ops } = use([[{ id: IDENTITY }], [{ userId: USER }], []]);
    expect(await repository.unlinkIdentity(USER, IDENTITY, receipt)).toEqual({ removed: true });
    expect(rows(ops, "delete", externalIdentities)).toHaveLength(1);
    expect(audits(ops)[0]).toMatchObject({ action: "identity_unlinked", changes: { identityId: IDENTITY } });
  });

  it("unlinkIdentity removes it when another identity remains and the provider is on", async () => {
    use([[{ id: IDENTITY }], [], [{ id: "other-identity" }]]);
    expect(await repository.unlinkIdentity(USER, IDENTITY, receipt)).toEqual({ removed: true });
  });

  it("unlinkIdentity keeps the last way in: nothing else, or another identity on an instance with the provider off", async () => {
    const last = use([[{ id: IDENTITY }], [], []]);
    await expect(repository.unlinkIdentity(USER, IDENTITY, receipt)).rejects.toMatchObject({ code: "link_last_method" });
    expect(rows(last.ops, "delete", externalIdentities)).toHaveLength(0);
    state.oidc = null;
    use([[{ id: IDENTITY }], [], [{ id: "other-identity" }]]);
    await expect(repository.unlinkIdentity(USER, IDENTITY, receipt)).rejects.toMatchObject({ code: "link_last_method" });
  });
});

describe("requirePrimaryAdministratorWithPassword (#1676)", () => {
  it("accepts the primary administrator who has a password", async () => {
    use([[{ primaryUserId: "admin" }], [{ userId: "admin" }]]);
    await expect(repository.requirePrimaryAdministratorWithPassword("admin")).resolves.toBeUndefined();
  });

  it("refuses anyone else, or no authority at all, before looking at passwords", async () => {
    const other = use([[{ primaryUserId: "someone" }]]);
    await expect(repository.requirePrimaryAdministratorWithPassword("admin")).rejects.toMatchObject({ code: "primary_administrator_only", status: 403 });
    expect(other.ops).toHaveLength(1);
    use([[]]);
    await expect(repository.requirePrimaryAdministratorWithPassword("admin")).rejects.toMatchObject({ code: "primary_administrator_only" });
  });

  it("refuses a primary administrator with no password: they could not sign in once the provider is gone", async () => {
    use([[{ primaryUserId: "admin" }], []]);
    await expect(repository.requirePrimaryAdministratorWithPassword("admin")).rejects.toMatchObject({ code: "primary_administrator_needs_password", status: 409 });
  });
});

describe("previewProviderLinks", () => {
  it("groups members by issuer, marks the configured provider, and strands only members who need a link", async () => {
    const links = [
      { issuer: "https://idp.example.test", userId: "a", displayName: "Ada", disabledAt: null },
      { issuer: "https://old.example.test", userId: "b", displayName: "Bo", disabledAt: null },
      { issuer: "https://old.example.test", userId: "c", displayName: "Cy", disabledAt: NOW },
      { issuer: "https://old.example.test", userId: "d", displayName: "Di", disabledAt: null },
    ];
    use([
      links,
      [],
      [{ userId: "b", disabledAt: null }, { userId: "c", disabledAt: NOW }],
      [{ id: "admin-row", userId: "admin", displayName: "Root" }],
      [{ userId: "admin" }],
    ]);
    const preview = await repository.previewProviderLinks("admin");
    expect(requireActiveAdministrator).toHaveBeenCalledWith("admin");
    expect(preview.providers).toEqual([
      { issuer: "https://idp.example.test", configured: true, members: [{ userId: "a", displayName: "Ada" }], stranded: [] },
      {
        issuer: "https://old.example.test", configured: false,
        members: [{ userId: "b", displayName: "Bo" }, { userId: "c", displayName: "Cy" }, { userId: "d", displayName: "Di" }],
        stranded: [{ userId: "b", displayName: "Bo" }],
      },
    ]);
    expect(preview).toMatchObject({ primary: { userId: "admin" }, viewerIsPrimary: true, viewerHasPassword: true });
  });

  it("with no providers linked and another primary, shows the viewer neither primary nor with a password", async () => {
    state.oidc = null;
    use([[], [{ userId: "boss", displayName: "Boss" }], []]);
    expect(await repository.previewProviderLinks("admin")).toEqual({
      providers: [], primary: { userId: "boss", displayName: "Boss" }, viewerIsPrimary: false, viewerHasPassword: false,
    });
    use([[], [], []]);
    expect(await repository.previewProviderLinks("admin")).toMatchObject({ primary: null, viewerIsPrimary: false });
  });

  it("refuses a non-administrator before reading anything", async () => {
    vi.mocked(requireActiveAdministrator).mockRejectedValueOnce(new Error("forbidden"));
    const { ops } = use([]);
    await expect(repository.previewProviderLinks("member")).rejects.toThrow("forbidden");
    expect(ops).toHaveLength(0);
  });
});

describe("removeProviderLinks (#1676)", () => {
  const OLD = "https://old.example.test";
  const primaryOk: Step[] = [[{ primaryUserId: "admin" }], [{ userId: "admin" }]];
  const commit = (removed: unknown[], ended: unknown[]): Step[] => [removed, ...(removed.length ? [ended] : [])];

  it("refuses a non-primary administrator, or one with no password, before anything else", async () => {
    use([[{ primaryUserId: "someone" }]]);
    await expect(repository.removeProviderLinks("admin", OLD)).rejects.toMatchObject({ code: "primary_administrator_only" });
    vi.mocked(requireActiveAdministrator).mockRejectedValueOnce(new Error("forbidden"));
    const { ops } = use([]);
    await expect(repository.removeProviderLinks("member", OLD)).rejects.toThrow("forbidden");
    expect(ops).toHaveLength(0);
  });

  it("refuses the provider still in Orbit's configuration, since its next sign-in would link members again", async () => {
    const { ops } = use([...primaryOk]);
    await expect(repository.removeProviderLinks("admin", "https://idp.example.test")).rejects.toMatchObject({ code: "provider_still_configured", status: 409 });
    expect(ops.filter((op) => op.kind === "delete")).toHaveLength(0);
  });

  it("bare mode refuses when members would be left with no way in, counting them in the words", async () => {
    use([...primaryOk, ...primaryOk, [{ userId: "a", disabledAt: null }]]);
    await expect(repository.removeProviderLinks("admin", OLD)).rejects.toMatchObject({ code: "provider_removal_strands_members", message: expect.stringContaining("1 member would") });
    use([...primaryOk, ...primaryOk, [{ userId: "a", disabledAt: null }, { userId: "b", disabledAt: null }]]);
    await expect(repository.removeProviderLinks("admin", OLD)).rejects.toMatchObject({ message: expect.stringContaining("2 members would") });
  });

  it("bare mode deletes the links, ends only provider sessions, and audits counts alone; a disabled member does not block it", async () => {
    const script = use([...primaryOk, ...primaryOk, [{ userId: "gone", disabledAt: NOW }], ...commit([{ userId: "a" }, { userId: "a" }, { userId: "b" }], [{ id: "s1" }])]);
    const result = await repository.removeProviderLinks("admin", OLD);
    expect(result).toEqual({ removed: 3, members: 2, mailed: 0, mailFailed: 0, sessionsEnded: 1, recipients: [] });
    expect(rows(script.ops, "delete", externalIdentities)).toHaveLength(1);
    expect(rows(script.ops, "delete", sessions)).toHaveLength(1);
    expect(audits(script.ops)[0]).toMatchObject({
      action: "provider_links_removed", actorUserId: "admin", entityId: "admin",
      changes: { removed: 3, members: 2, mailed: 0, mailFailed: 0, sessionsEnded: 1 },
    });
  });

  it("with no links to remove it ends no sessions", async () => {
    const script = use([...primaryOk, ...primaryOk, [], ...commit([], [])]);
    expect(await repository.removeProviderLinks("admin", OLD)).toMatchObject({ removed: 0, members: 0, sessionsEnded: 0 });
    expect(rows(script.ops, "delete", sessions)).toHaveLength(0);
  });

  it("works when the provider is off altogether: nothing counts as a usable identity", async () => {
    state.oidc = null;
    use([...primaryOk, ...primaryOk, [{ userId: "a", disabledAt: null }]]);
    await expect(repository.removeProviderLinks("admin", OLD)).rejects.toMatchObject({ code: "provider_removal_strands_members" });
  });

  it("mail mode refuses a bad lifetime before reading anything beyond the administrator check", async () => {
    use([...primaryOk]);
    await expect(repository.removeProviderLinks("admin", OLD, { mailStranded: true, expiresInDays: 30 })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("mail mode needs outgoing mail only when someone needs a link", async () => {
    state.mailReady = false;
    use([...primaryOk, ...primaryOk, [{ userId: "a", disabledAt: null }]]);
    await expect(repository.removeProviderLinks("admin", OLD, { mailStranded: true })).rejects.toMatchObject({ code: "mail_not_ready", status: 409 });
    expect(outgoingMailReady).toHaveBeenCalledWith(undefined);
    vi.mocked(outgoingMailReady).mockClear();
    use([...primaryOk, ...primaryOk, [{ userId: "gone", disabledAt: NOW }], ...primaryOk, [{ userId: "gone", disabledAt: NOW }], ...commit([{ userId: "gone" }], [])]);
    await expect(repository.removeProviderLinks("admin", OLD, { mailStranded: true })).resolves.toBeDefined();
    expect(outgoingMailReady).not.toHaveBeenCalled();
  });

  it("mail mode refuses when a stranded member's address cannot be read, naming why", async () => {
    state.address = { state: "metadata_locked" };
    use([...primaryOk, ...primaryOk, [{ userId: "a", disabledAt: null }], [{ id: "a", emailEnc: "e" }]]);
    await expect(repository.removeProviderLinks("admin", OLD, { mailStranded: true })).rejects.toMatchObject({ code: "unreadable_metadata_locked" });
  });

  it("mail mode mails each stranded member, never a disabled one, and records who got it and who did not", async () => {
    vi.mocked(sendSetupLink)
      .mockResolvedValueOnce({ sendError: null } as never)
      .mockResolvedValueOnce({ sendError: "smtp_unavailable" } as never)
      .mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "mailer_broke" }))
      .mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "Bad Code!" }))
      .mockRejectedValueOnce(null);
    const stranded = ["a", "b", "c", "d", "e"].map((userId) => ({ userId, disabledAt: null }));
    const script = use([
      ...primaryOk, ...primaryOk, [...stranded, { userId: "off", disabledAt: NOW }], [{ id: "a", emailEnc: "e" }],
      ...primaryOk, [...stranded, { userId: "off", disabledAt: NOW }, { userId: "late", disabledAt: null }, { userId: "late-off", disabledAt: NOW }],
      ...commit([{ userId: "a" }, { userId: "b" }], [{ id: "s1" }, { id: "s2" }]),
    ]);
    const mailer = { send: vi.fn() } as never;
    const result = await repository.removeProviderLinks("admin", OLD, { mailStranded: true, expiresInDays: 2, mailer });
    expect(outgoingMailReady).toHaveBeenCalledWith(mailer);
    expect(sendSetupLink).toHaveBeenCalledTimes(5);
    expect(sendSetupLink).toHaveBeenCalledWith("admin", "a", { expiresInDays: 2, mailer });
    expect(result.recipients).toEqual([
      { userId: "a", mailed: true, reason: null },
      { userId: "b", mailed: false, reason: "smtp_unavailable" },
      { userId: "c", mailed: false, reason: "mailer_broke" },
      { userId: "d", mailed: false, reason: "unknown" },
      { userId: "e", mailed: false, reason: "unknown" },
      { userId: "off", mailed: false, reason: "member_disabled" },
      { userId: "late", mailed: false, reason: "stranded_after_check" },
      { userId: "late-off", mailed: false, reason: "member_disabled" },
    ]);
    expect(result).toMatchObject({ removed: 2, members: 2, mailed: 1, mailFailed: 7, sessionsEnded: 2 });
    expect(audits(script.ops)[0]!.changes).toEqual({ removed: 2, members: 2, mailed: 1, mailFailed: 7, sessionsEnded: 2 });
    expect(JSON.stringify(audits(script.ops))).not.toContain("@");
  });
});
