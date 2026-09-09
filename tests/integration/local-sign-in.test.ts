import { hash } from "@node-rs/argon2";
import type { Algorithm } from "@node-rs/argon2";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { auditLog, instanceAuthority, localCredentials, users } from "@/db/schema";
import { claimCookieName, sealClaimProof } from "@/lib/auth/bootstrap";
import { sessionCookieName } from "@/lib/auth/cookies";
import { hashPassword, needsRehash } from "@/lib/auth/password";
import { getAuthConfig } from "@/lib/env";
import {
  createLocalUser,
  LOCAL_LOCKOUT_CEILING_MS,
  LOCAL_LOCKOUT_FLOOR_MS,
  LOCAL_SIGN_IN_FREE_ATTEMPTS,
} from "@/server/local-credentials";
import { cleanupIntegrationEnvironment } from "./support/fixtures";
import { callRoute, loadRoute } from "./support/request-event";
import { readSetCookie } from "./support/set-cookie";

const { POST: bootstrapLocally } = await loadRoute("auth/bootstrap/local");
const { POST: signIn } = await loadRoute("auth/local/login");
const { GET: sessionStatus } = await loadRoute("auth/session");

const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "a-correct-local-password";
const WRONG_PASSWORD = "a-wrong-local-password";

/* The suite shares one database, so every journey here hands the next an
   unclaimed instance with no users. */
afterEach(async () => {
  const db = getDb();
  await db.delete(instanceAuthority);
  await db.delete(auditLog);
  const existing = await db.select({ id: users.id }).from(users);
  if (existing.length > 0) await db.delete(users).where(inArray(users.id, existing.map((row) => row.id)));
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

/** The cookie the claim route mints, sealed here rather than re-earned. */
async function claimCookie(): Promise<string> {
  const config = getAuthConfig();
  return `${claimCookieName(config)}=${await sealClaimProof(config)}`;
}

function post(
  handler: typeof bootstrapLocally,
  path: string,
  body: unknown,
  cookie?: string,
): Promise<Response> {
  return callRoute(handler, {
    url: `${ORIGIN}${path}`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function claimLocally(body: unknown, cookie?: string): Promise<Response> {
  return post(bootstrapLocally, "/api/auth/bootstrap/local", body, cookie);
}

function signInWith(body: unknown, cookie?: string): Promise<Response> {
  return post(signIn, "/api/auth/local/login", body, cookie);
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.clone().json()) as { error?: { code?: string } };
  return body.error?.code ?? "";
}

async function countUsers(): Promise<number> {
  return (await getDb().select({ id: users.id }).from(users)).length;
}

/** Reads the session cookie a response set, and asks the session route about it. */
async function whoAmI(response: Response): Promise<Record<string, unknown>> {
  const config = getAuthConfig();
  const token = readSetCookie(response, sessionCookieName(config))?.value;
  if (!token) throw new Error("Response set no session cookie");
  const status = await callRoute(sessionStatus, {
    url: `${ORIGIN}/api/auth/session`,
    headers: { cookie: `${sessionCookieName(config)}=${token}` },
  });
  return (await status.json()) as Record<string, unknown>;
}

async function seedLocalUser(
  label: string,
  options: { password?: string; disabled?: boolean } = {},
): Promise<{ id: string; email: string }> {
  const email = `${label}@local.invalid`;
  const user = await createLocalUser({
    email,
    displayName: `Local ${label}`,
    ...(options.password === undefined ? {} : { passwordHash: await hashPassword(options.password) }),
  });
  if (options.disabled) {
    await getDb().update(users).set({ disabledAt: new Date() }).where(eq(users.id, user.id));
  }
  return { id: user.id, email };
}

async function credentialRow(userId: string) {
  const [row] = await getDb()
    .select({
      passwordHash: localCredentials.passwordHash,
      failedAttemptCount: localCredentials.failedAttemptCount,
      lockedUntil: localCredentials.lockedUntil,
      lastVerifiedAt: localCredentials.lastVerifiedAt,
    })
    .from(localCredentials)
    .where(eq(localCredentials.userId, userId));
  return row;
}

describe("claiming the instance with a password (ADR-0022 §2)", () => {
  it("seats the first administrator, stores only a hash, and hands back a session", async () => {
    const response = await claimLocally(
      { email: "First.Administrator@local.invalid", displayName: "First administrator", password: PASSWORD },
      await claimCookie(),
    );
    expect(response.status).toBe(201);
    expect(await response.clone().json()).toEqual({ claimed: true });
    const raw = await response.clone().text();
    expect(raw).not.toContain(PASSWORD);

    const [seated] = await getDb()
      .select({ id: users.id, email: users.email, isInstanceAdmin: users.isInstanceAdmin })
      .from(users);
    expect(seated.isInstanceAdmin).toBe(true);
    expect(seated.email).toBe("First.Administrator@local.invalid");
    expect(await getDb().select({ primaryUserId: instanceAuthority.primaryUserId }).from(instanceAuthority))
      .toEqual([{ primaryUserId: seated.id }]);

    /* The password itself is nowhere: the row carries the PHC string of
       ADR-0021 §2 and nothing else. */
    const credential = await credentialRow(seated.id);
    expect(credential.passwordHash.startsWith("$argon2id$v=19$m=65536,t=3,p=1$")).toBe(true);
    expect(credential.passwordHash).not.toContain(PASSWORD);
    expect(credential.failedAttemptCount).toBe(0);

    // The audit record names the method and nothing else (plan §2.8).
    expect(await getDb().select({ action: auditLog.action, changes: auditLog.changes }).from(auditLog))
      .toEqual([{ action: "instance_claimed", changes: { method: "local" } }]);

    // The claim is spent: its cookie is cleared and the session replaces it.
    expect(readSetCookie(response, claimCookieName(getAuthConfig()))?.maxAge).toBe(0);
    const session = await whoAmI(response);
    expect(session.authenticated).toBe(true);
    expect((session.user as { isInstanceAdmin: boolean }).isInstanceAdmin).toBe(true);
  });

  it("creates nobody without the claim cookie", async () => {
    const response = await claimLocally({
      email: "uninvited@local.invalid",
      displayName: "Uninvited",
      password: PASSWORD,
    });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("bootstrap_required");
    expect(await countUsers()).toBe(0);
  });

  it("refuses a second claim on state, whatever cookie the caller holds", async () => {
    const cookie = await claimCookie();
    expect((await claimLocally({ email: "one@local.invalid", displayName: "One", password: PASSWORD }, cookie)).status)
      .toBe(201);

    const second = await claimLocally(
      { email: "two@local.invalid", displayName: "Two", password: PASSWORD },
      cookie,
    );
    expect(second.status).toBe(409);
    expect(await errorCode(second)).toBe("bootstrap_claimed");
    expect(await countUsers()).toBe(1);
  });

  it("refuses a password below the floor without creating anything", async () => {
    const response = await claimLocally(
      { email: "short@local.invalid", displayName: "Short", password: "short" },
      await claimCookie(),
    );
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("password_rejected");
    expect(await countUsers()).toBe(0);
    expect(await getDb().select({ primaryUserId: instanceAuthority.primaryUserId }).from(instanceAuthority))
      .toEqual([]);
  });
});

describe("local sign-in (ADR-0023 §4)", () => {
  it("signs a local user in and replaces the browser's previous session", async () => {
    const account = await seedLocalUser("returning", { password: PASSWORD });
    const config = getAuthConfig();

    const first = await signInWith({ email: account.email, password: PASSWORD });
    expect(first.status).toBe(200);
    expect(await first.clone().json()).toEqual({ authenticated: true });
    const firstToken = readSetCookie(first, sessionCookieName(config))!.value;
    expect((await whoAmI(first)).authenticated).toBe(true);

    // The address is matched without regard to case, as the unique index is.
    const second = await signInWith(
      { email: account.email.toUpperCase(), password: PASSWORD },
      `${sessionCookieName(config)}=${firstToken}`,
    );
    expect(second.status).toBe(200);
    expect((await whoAmI(second)).authenticated).toBe(true);

    // The session the browser arrived with is gone, not left running beside it.
    const stale = await callRoute(sessionStatus, {
      url: `${ORIGIN}/api/auth/session`,
      headers: { cookie: `${sessionCookieName(config)}=${firstToken}` },
    });
    expect(stale.status).toBe(401);

    const credential = await credentialRow(account.id);
    expect(credential.lastVerifiedAt).not.toBeNull();
    expect(credential.failedAttemptCount).toBe(0);
  });

  it("answers an unknown address, a wrong password, a disabled account and a passwordless account alike", async () => {
    const known = await seedLocalUser("known", { password: PASSWORD });
    const disabled = await seedLocalUser("disabled", { password: PASSWORD, disabled: true });
    const passwordless = await seedLocalUser("passwordless");

    /* One warm-up first: the process's decoy hash is made on its first use
       (ADR-0021 §5), and that one-off cost would otherwise land on whichever
       case happened to run first and dominate the comparison below. */
    await signInWith({ email: "warmup@local.invalid", password: WRONG_PASSWORD });

    const cases = [
      { email: "stranger@local.invalid", password: PASSWORD },
      { email: known.email, password: WRONG_PASSWORD },
      { email: disabled.email, password: PASSWORD },
      { email: passwordless.email, password: PASSWORD },
    ];
    const attempts: { elapsed: number; status: number; body: string }[] = [];
    for (const attempt of cases) {
      const started = performance.now();
      const response = await signInWith(attempt);
      attempts.push({
        elapsed: performance.now() - started,
        status: response.status,
        body: await response.text(),
      });
    }

    // One status, one body: nothing here says which of the four it was.
    expect(attempts.map((attempt) => attempt.status)).toEqual([401, 401, 401, 401]);
    expect(new Set(attempts.map((attempt) => attempt.body)).size).toBe(1);
    expect(JSON.parse(attempts[0].body).error.code).toBe("credentials_invalid");

    /* And one cost, loosely: each case spends a real derivation, so their
       times overlap rather than separating into "looked something up" and
       "did not". A wide bound on purpose — this is a shared, loaded host, and
       a strict one would measure the runner rather than the code. */
    const times = attempts.map((attempt) => attempt.elapsed);
    expect(Math.min(...times)).toBeGreaterThan(0);
    expect(Math.max(...times)).toBeLessThan(Math.min(...times) * 6);
  });

  it("leaves five failures free, locks on the sixth, and keeps the count in the row", async () => {
    const account = await seedLocalUser("guessed", { password: PASSWORD });

    for (let attempt = 1; attempt <= LOCAL_SIGN_IN_FREE_ATTEMPTS; attempt += 1) {
      const response = await signInWith({ email: account.email, password: WRONG_PASSWORD });
      expect(response.status).toBe(401);
      expect(await errorCode(response)).toBe("credentials_invalid");
    }
    // Five failures are free: nothing is locked yet.
    expect((await credentialRow(account.id)).lockedUntil).toBeNull();

    const startedAt = Date.now();
    const sixth = await signInWith({ email: account.email, password: WRONG_PASSWORD });
    expect(sixth.status).toBe(401);

    /* The counter and the lock are columns, not process memory, so a restart
       hands the next process the same six failures rather than five fresh
       attempts. Read back from the database to say so. */
    const locked = await credentialRow(account.id);
    expect(locked.failedAttemptCount).toBe(LOCAL_SIGN_IN_FREE_ATTEMPTS + 1);
    expect(locked.lockedUntil).not.toBeNull();
    // One second, the floor of the schedule — not the ceiling, and not zero.
    expect(locked.lockedUntil!.getTime()).toBeGreaterThan(startedAt);
    expect(locked.lockedUntil!.getTime()).toBeLessThanOrEqual(Date.now() + LOCAL_LOCKOUT_FLOOR_MS);
  });

  it("doubles the penalty to the fifteen-minute ceiling, and refuses the right password while it holds", async () => {
    const account = await seedLocalUser("persistent", { password: PASSWORD });
    /* Twenty failures already served: the doubling would be years by now, so
       this is the assertion that the ceiling holds. Set directly rather than
       spending twenty derivations to reach the same row. */
    await getDb().update(localCredentials)
      .set({ failedAttemptCount: 20, lockedUntil: new Date(Date.now() - 1_000) })
      .where(eq(localCredentials.userId, account.id));

    const startedAt = Date.now();
    const response = await signInWith({ email: account.email, password: WRONG_PASSWORD });
    expect(response.status).toBe(401);

    const row = await credentialRow(account.id);
    expect(row.failedAttemptCount).toBe(21);
    expect(row.lockedUntil!.getTime()).toBeGreaterThanOrEqual(startedAt + LOCAL_LOCKOUT_CEILING_MS);
    expect(row.lockedUntil!.getTime()).toBeLessThanOrEqual(Date.now() + LOCAL_LOCKOUT_CEILING_MS);

    /* A correct password is refused while the lock holds: knowing the password
       is not a way out of the backoff, which is the whole point of it. */
    const correct = await signInWith({ email: account.email, password: PASSWORD });
    expect(correct.status).toBe(429);
    expect(await errorCode(correct)).toBe("too_many_attempts");
    expect(correct.headers.get("set-cookie")).toBeNull();
    expect((await credentialRow(account.id)).lastVerifiedAt).toBeNull();
  });

  it("clears the counter on success and re-hashes a credential made below policy", async () => {
    const account = await seedLocalUser("upgrading", { password: PASSWORD });
    /* A credential from an older, weaker policy, with three failures behind
       it and an expired lock. Both are cleared by one successful sign-in, and
       the hash is replaced in the same write (ADR-0021 §3). */
    const legacyHash = await hash(PASSWORD, {
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
      outputLen: 32,
      algorithm: 2 as Algorithm,
    });
    expect(needsRehash(legacyHash)).toBe(true);
    await getDb().update(localCredentials)
      .set({ passwordHash: legacyHash, failedAttemptCount: 3, lockedUntil: new Date(Date.now() - 1_000) })
      .where(eq(localCredentials.userId, account.id));

    const response = await signInWith({ email: account.email, password: PASSWORD });
    expect(response.status).toBe(200);

    const row = await credentialRow(account.id);
    expect(row.failedAttemptCount).toBe(0);
    expect(row.lockedUntil).toBeNull();
    expect(row.lastVerifiedAt).not.toBeNull();
    expect(row.passwordHash).not.toBe(legacyHash);
    expect(needsRehash(row.passwordHash)).toBe(false);

    // The upgraded hash still verifies the same password on the next sign-in.
    expect((await signInWith({ email: account.email, password: PASSWORD })).status).toBe(200);
  });

  it("refuses a cross-site post and a malformed body without touching any credential", async () => {
    const account = await seedLocalUser("protected", { password: PASSWORD });

    const crossSite = await callRoute(signIn, {
      url: `${ORIGIN}/api/auth/local/login`,
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.invalid" },
      body: JSON.stringify({ email: account.email, password: PASSWORD }),
    });
    expect(crossSite.status).toBe(403);
    expect(await errorCode(crossSite)).toBe("csrf_failed");

    const malformed = await callRoute(signIn, {
      url: `${ORIGIN}/api/auth/local/login`,
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, "sec-fetch-site": "same-origin" },
      body: "not json",
    });
    expect(malformed.status).toBe(401);
    expect(await errorCode(malformed)).toBe("credentials_invalid");

    expect((await credentialRow(account.id)).failedAttemptCount).toBe(0);
  });
});
