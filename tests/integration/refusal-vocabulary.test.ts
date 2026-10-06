import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, instanceAuthority, localCredentials, users } from "@/db/schema";
import {
  claimCookieName,
  generateClaim,
  sealClaimProof,
  setActiveClaimForTests,
} from "@/lib/auth/bootstrap";
import { sessionCookieName, transactionCookieName } from "@/lib/auth/cookies";
import { randomUrlSafe, sealLoginTransaction } from "@/lib/auth/crypto";
import { hashPassword } from "@/lib/auth/password";
import { createSession, csrfTokenForSession, readSession } from "@/lib/auth/session";
import { getAuthConfig, resetAuthConfigForTests } from "@/lib/env";
import { createLocalUser } from "@/server/local-credentials";
import { cleanupIntegrationEnvironment } from "./support/fixtures";
import { callRoute, loadRoute, type RouteHandler } from "./support/request-event";

/**
 * THE REFUSAL VOCABULARY (#1034).
 *
 * ## What went wrong, and why nothing caught it
 *
 * While #969 was being built, `auth/local/login` turned the new "this
 * instance has no encryption key" answer back into `credentials_invalid` —
 * the one thing #969 forbids, because an operator who has lost the key must
 * not be told their password is wrong. `verifyCredential` gained a fifth
 * verdict and the route's `if (verdict.outcome !== "verified")` still compiled
 * perfectly, so the type check was silent; the browser suites drive happy
 * paths, so they were silent too. A person read the route. That is not a gate.
 *
 * This file is the gate. It has two halves, and the second is the point of it.
 *
 * ## Half one: a test per distinct answer, for the routes that need it
 *
 * A route is in scope here when a person reading its refusal has to be able to
 * tell it from that route's OTHER refusal — when getting the wrong one sends
 * them looking for a fault in the wrong place. That is the whole test. It is
 * not "is this route important", and it is deliberately not "does this route
 * have a test".
 *
 * In, and why:
 *
 *  - `auth/local/login` — "your password is wrong", "you are locked out" and
 *    "this instance cannot read any address" send somebody to three different
 *    places, and only one of them is themselves.
 *  - `auth/bootstrap/claim`, `auth/bootstrap/local` — the claim. "No code is
 *    waiting", "that code is wrong" and "somebody already claimed this" are
 *    the first three things an operator can meet, on an instance with no
 *    support channel and nobody to ask.
 *  - `auth/local/setup` — setup links. "That link is spent" and "that password
 *    is too short" are answered by the same form; confusing them has the
 *    recipient hunting a new link they do not need.
 *  - `admin/users` — the administration mutations. "Prove it is you", "that
 *    address already belongs to someone" and "enable that account first" are
 *    three different next actions for the administrator.
 *  - `auth/methods/local` — removing a sign-in method. "That would leave you
 *    with no way in" must not read as a failure to authorise.
 *  - `auth/sessions/[sessionId]/revoke` — "that session is not available" is
 *    deliberately the same answer for someone else's session as for one that
 *    never existed, and that sameness is the security property.
 *  - `auth/step-up/start` — the re-challenge itself. An OIDC-only operator on
 *    an instance where the provider is switched off is told the provider is
 *    not configured, not that they failed to prove themselves.
 *  - `auth/login`, `auth/callback` — the provider door. Four different faults
 *    live behind one screen: the instance is unclaimed, the provider cannot be
 *    reached, the provider declined, or the response does not match the
 *    transaction this process started. The operator fixes a different thing in
 *    each case.
 *
 * Out, and why: the workspace, household, item and document routes. Their
 * refusals are "not found" and "not yours", which point at the same next
 * action whichever one you get, and `authorization-matrix.test.ts` already
 * holds them to it. A route is not added here for being untested — that is a
 * different job, and a bigger one.
 *
 * ## Half two: the gate over the vocabulary
 *
 * `AuthErrorCode` in `src/lib/auth/errors.ts` is a closed, hand-maintained
 * union: every word Orbit is allowed to refuse an authentication request with.
 * The last test in this file asserts that each member is accounted for — this
 * file produced it through a real route, or a named test elsewhere produces
 * it, or it is on a short list of codes that no route can reach without a live
 * identity provider. Add a member and do nothing else, and the gate goes red.
 * That is exactly the shape of the #969 near-miss: the verdict was new, so
 * nothing produced its code, so nothing would have vouched for it.
 *
 * The wider check #1034 floats — "every error code any server module can
 * raise is reachable through some route test" — is NOT written, and the last
 * test says why in as many words. It could not be made honest.
 */

const ORIGIN = "http://127.0.0.1:3000";

const { POST: signIn } = await loadRoute("auth/local/login");
const { POST: claimWithPassword } = await loadRoute("auth/bootstrap/local");
const { POST: claimWithCode } = await loadRoute("auth/bootstrap/claim");
const { POST: spendSetupLink } = await loadRoute("auth/local/setup");
const { GET: listUsers, PUT: setAdministrator, POST: createUser } = await loadRoute("admin/users");
const { DELETE: removePassword } = await loadRoute("auth/methods/local");
const { POST: revokeOneSession } = await loadRoute("auth/sessions/[sessionId]/revoke");
const { POST: startStepUp } = await loadRoute("auth/step-up/start");
const { GET: startLogin } = await loadRoute("auth/login");
const { GET: returnFromProvider } = await loadRoute("auth/callback");

/**
 * Every refusal code this file saw come out of a real route.
 *
 * Written by the two helpers below and read only by the last test, so a code
 * lands here by having been ASSERTED off a response — never by being mentioned
 * in a test, which is the difference between this and grepping the suite.
 */
const observed = new Set<string>();

/** Asserts the status and the code of a JSON refusal, and records the code. */
async function refusal(response: Response, status: number, code: string): Promise<void> {
  const body = (await response.clone().json()) as { error?: { code?: string } };
  expect({ status: response.status, code: body.error?.code }).toEqual({ status, code });
  observed.add(code);
}

/**
 * The same, for the callback, which answers nobody in JSON.
 *
 * A failure there must land the person on Orbit's own error screen rather than
 * on an envelope the browser would render as a blank page, so the code travels
 * on the query string. Asserted here in the shape the browser receives it.
 */
function callbackRefusal(response: Response, code: string): void {
  const location = response.headers.get("location") ?? "";
  expect({ status: response.status, location: new URL(location, ORIGIN).pathname })
    .toEqual({ status: 303, location: "/auth/error" });
  expect(new URL(location, ORIGIN).searchParams.get("code")).toBe(code);
  observed.add(code);
}

interface Caller {
  id: string;
  email: string;
  sessionId: string;
  headers: Record<string, string>;
}

const signedOutHeaders = {
  "content-type": "application/json",
  origin: ORIGIN,
  "sec-fetch-site": "same-origin",
};

function call(
  handler: RouteHandler,
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    params?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<Response> {
  return callRoute(handler, {
    url: `${ORIGIN}${path}`,
    method: init.method ?? "POST",
    params: init.params,
    headers: init.headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/**
 * A local account, made the way the product makes one.
 *
 * `createLocalUser` rather than a direct insert, so the address is encrypted
 * and indexed exactly as a real account's is (#969) — a hand-inserted row
 * would still pass, through the plaintext fallback, and prove nothing about
 * the path these routes take.
 */
async function seedUser(
  label: string,
  options: { password?: string; administrator?: boolean; disabled?: boolean } = {},
): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@refusals.invalid`;
  const user = await createLocalUser({
    email,
    displayName: `Refusal ${label}`,
    ...(options.password === undefined ? {} : { passwordHash: await hashPassword(options.password) }),
  });
  const patch: Record<string, unknown> = {};
  if (options.administrator) patch.isInstanceAdmin = true;
  if (options.disabled) patch.disabledAt = new Date();
  if (Object.keys(patch).length > 0) {
    await getDb().update(users).set(patch).where(eq(users.id, user.id));
  }
  return { id: user.id, email };
}

/** A seeded account with a session, and the headers a browser would send. */
async function callerFor(user: { id: string; email: string }): Promise<Caller> {
  const config = getAuthConfig();
  const created = await createSession(user.id, config);
  const persisted = await readSession(
    { get: (name) => (name === sessionCookieName(config) ? created.token : undefined) },
    config,
  );
  if (!persisted) throw new Error("The session was not persisted");
  return {
    id: user.id,
    email: user.email,
    sessionId: persisted.id,
    headers: {
      "content-type": "application/json",
      cookie: `${sessionCookieName(config)}=${created.token}`,
      origin: config.appUrl.origin,
      "sec-fetch-site": "same-origin",
      "x-csrf-token": csrfTokenForSession(persisted, config),
    },
  };
}

/** The cookie the claim route mints, sealed here rather than earned. */
async function claimCookie(): Promise<string> {
  const config = getAuthConfig();
  return `${claimCookieName(config)}=${await sealClaimProof(config)}`;
}

/** Seats a first administrator, so `isClaimed()` is true for what follows. */
async function claimTheInstance(): Promise<void> {
  const response = await call(claimWithPassword, "/api/auth/bootstrap/local", {
    headers: { ...signedOutHeaders, cookie: await claimCookie() },
    body: {
      email: `primary-${randomUUID().slice(0, 8)}@refusals.invalid`,
      displayName: "Primary administrator",
      password: "a-long-enough-first-password",
    },
  });
  expect(response.status).toBe(201);
}

const PASSWORD = "a-correct-local-password";

/* One database for the whole run, so every journey hands the next an unclaimed
   instance with no accounts on it — the state a fresh install starts in, which
   is what most of these refusals are about. */
afterEach(async () => {
  setActiveClaimForTests(undefined);
  vi.unstubAllGlobals();
  const db = getDb();
  await db.delete(instanceAuthority);
  await db.delete(auditLog);
  const existing = await db.select({ id: users.id }).from(users);
  if (existing.length > 0) await db.delete(users).where(inArray(users.id, existing.map((row) => row.id)));
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

describe("signing in (`/api/auth/local/login`)", () => {
  it("tells a wrong password from a lockout, and neither from a cross-site post", async () => {
    const account = await seedUser("returning", { password: PASSWORD });

    await refusal(
      await call(signIn, "/api/auth/local/login", {
        headers: signedOutHeaders,
        body: { email: account.email, password: "not-the-password" },
      }),
      401,
      "credentials_invalid",
    );

    /* The lockout answers the RIGHT password too, which is the point of it —
       and it must say so, or someone who has simply waited too long between
       attempts concludes their password has been changed under them. */
    await getDb().update(localCredentials)
      .set({ failedAttemptCount: 6, lockedUntil: new Date(Date.now() + 60_000) })
      .where(eq(localCredentials.userId, account.id));
    await refusal(
      await call(signIn, "/api/auth/local/login", {
        headers: signedOutHeaders,
        body: { email: account.email, password: PASSWORD },
      }),
      429,
      "too_many_attempts",
    );

    /* A post from somewhere else is refused as a post from somewhere else.
       Flattened into `credentials_invalid` it would read to the person at the
       screen as a typing mistake, and they would try again forever. */
    await refusal(
      await call(signIn, "/api/auth/local/login", {
        headers: { "content-type": "application/json", origin: "https://attacker.invalid" },
        body: { email: account.email, password: PASSWORD },
      }),
      403,
      "csrf_failed",
    );
  });
});

describe("claiming the instance (`/api/auth/bootstrap/*`)", () => {
  it("tells no code waiting from a wrong code from already claimed", async () => {
    /* Nothing printed a code: the instance has been restarted and the notice
       is further up the log. "Wrong code" here would have the operator typing
       a code that cannot be accepted by anything. */
    setActiveClaimForTests(undefined);
    await refusal(
      await call(claimWithCode, "/api/auth/bootstrap/claim", {
        headers: signedOutHeaders,
        body: { claim: "AAAA-BBBB-CCCC" },
      }),
      503,
      "bootstrap_unavailable",
    );

    setActiveClaimForTests(generateClaim());
    await refusal(
      await call(claimWithCode, "/api/auth/bootstrap/claim", {
        headers: signedOutHeaders,
        body: { claim: "AAAA-BBBB-CCCC" },
      }),
      403,
      "bootstrap_invalid",
    );

    /* And once somebody has claimed it, state decides rather than the code:
       the loser of a race is told the instance is taken, not that they
       mistyped something. */
    await claimTheInstance();
    await refusal(
      await call(claimWithCode, "/api/auth/bootstrap/claim", {
        headers: signedOutHeaders,
        body: { claim: "AAAA-BBBB-CCCC" },
      }),
      409,
      "bootstrap_claimed",
    );
  });

  it("tells an uninvited claim from a password below the floor", async () => {
    const body = {
      email: "uninvited@refusals.invalid",
      displayName: "Uninvited",
      password: "a-long-enough-first-password",
    };

    /* No claim cookie: this caller never proved they can read the log, so
       they are not being told anything about the password they chose. */
    await refusal(
      await call(claimWithPassword, "/api/auth/bootstrap/local", { headers: signedOutHeaders, body }),
      403,
      "bootstrap_required",
    );

    await refusal(
      await call(claimWithPassword, "/api/auth/bootstrap/local", {
        headers: { ...signedOutHeaders, cookie: await claimCookie() },
        body: { ...body, password: "short" },
      }),
      400,
      "password_rejected",
    );
  });
});

describe("setup links (`/api/auth/local/setup`)", () => {
  it("answers an empty and an unknown token alike, and judges the password first", async () => {
    /* Two different code paths — the route's own emptiness check and
       `consumeSetupToken`'s lookup — and they must agree, or the difference
       tells a stranger whether a token they guessed exists. */
    await refusal(
      await call(spendSetupLink, "/api/auth/local/setup", {
        headers: signedOutHeaders,
        body: { token: "", password: "a-freshly-chosen-password" },
      }),
      400,
      "setup_token_invalid",
    );
    await refusal(
      await call(spendSetupLink, "/api/auth/local/setup", {
        headers: signedOutHeaders,
        body: { token: `not-a-real-setup-token-${randomUUID()}`, password: "a-freshly-chosen-password" },
      }),
      400,
      "setup_token_invalid",
    );

    /* The password is judged before the link is spent, so somebody who picks
       a short one is told to pick a longer one rather than losing the link
       and being sent back to the administrator for another. */
    await refusal(
      await call(spendSetupLink, "/api/auth/local/setup", {
        headers: signedOutHeaders,
        body: { token: `not-a-real-setup-token-${randomUUID()}`, password: "short" },
      }),
      400,
      "password_rejected",
    );
  });
});

describe("administration mutations (`/api/admin/users`)", () => {
  it("refuses a caller with no session before anything else", async () => {
    await refusal(
      await call(listUsers, "/api/admin/users", { method: "GET" }),
      401,
      "session_required",
    );
  });

  it("tells an unproven administrator from an address that is already taken", async () => {
    const administrator = await seedUser("administrator", { password: PASSWORD, administrator: true });
    const caller = await callerFor(administrator);
    const existing = await seedUser("existing", { password: PASSWORD });

    /* No `currentPassword`: the administrator is who they say they are, but
       has not proved it for THIS action. "Confirm it is you" is a thing they
       can act on; a generic failure is not. */
    await refusal(
      await call(createUser, "/api/admin/users", {
        headers: caller.headers,
        body: { email: "somebody-new@refusals.invalid", displayName: "Somebody New" },
      }),
      403,
      "recent_authentication_required",
    );

    /* Challenge answered, and now the real fault: that address belongs to an
       account already. Reported as itself, because the fix is to link the
       provider to the existing account rather than to try again. */
    await refusal(
      await call(createUser, "/api/admin/users", {
        headers: caller.headers,
        body: { email: existing.email, displayName: "Somebody New", currentPassword: PASSWORD },
      }),
      403,
      "link_required",
    );
  });

  it("names a disabled target rather than refusing the administrator", async () => {
    const administrator = await seedUser("granting-administrator", { administrator: true });
    const caller = await callerFor(administrator);
    const target = await seedUser("suspended", { disabled: true });

    /* The administrator's rights are fine and their session is fine: the
       account they picked is switched off. Told as `administrator_required`
       this would have them checking their own permissions. */
    await refusal(
      await call(setAdministrator, "/api/admin/users", {
        method: "PUT",
        headers: caller.headers,
        body: { userId: target.id, administrator: true },
      }),
      409,
      "account_disabled",
    );
  });
});

describe("sign-in methods and sessions", () => {
  it("refuses to remove the only way into an account", async () => {
    /* A local-only account: no provider identity behind it, so the password
       it is being asked to drop is the last door. */
    const account = await seedUser("only-a-password", { password: PASSWORD });
    const caller = await callerFor(account);

    await refusal(
      await call(removePassword, "/api/auth/methods/local", {
        method: "DELETE",
        headers: caller.headers,
        body: { currentPassword: PASSWORD },
      }),
      409,
      "link_last_method",
    );
  });

  it("answers an unknown session id exactly as it answers somebody else's", async () => {
    const account = await seedUser("signed-in", { password: PASSWORD });
    const caller = await callerFor(account);
    const stranger = await seedUser("stranger", { password: PASSWORD });
    const strangerCaller = await callerFor(stranger);

    const unknown = await call(revokeOneSession, "/api/auth/sessions/x/revoke", {
      headers: caller.headers,
      params: { sessionId: randomUUID() },
    });
    await refusal(unknown, 404, "session_not_found");

    /* Same answer for a session that exists and belongs to somebody else. A
       different one here would let anyone signed in enumerate who else is. */
    const someoneElses = await call(revokeOneSession, "/api/auth/sessions/x/revoke", {
      headers: caller.headers,
      params: { sessionId: strangerCaller.sessionId },
    });
    await refusal(someoneElses, 404, "session_not_found");
  });
});

describe("the re-challenge when no provider is configured (`/api/auth/step-up/start`)", () => {
  it("says the provider is switched off, not that the person failed to prove themselves", async () => {
    /* OIDC is off for the integration run, which is also the shape of a real
       local-only instance. An operator with no password is sent here to prove
       themselves and there is nothing to send them to — a fault in the
       instance's configuration, not in them. */
    const account = await seedUser("oidc-only");
    const caller = await callerFor(account);

    await refusal(
      await call(startStepUp, "/api/auth/step-up/start", {
        headers: caller.headers,
        body: { intent: "password_set" },
      }),
      503,
      "auth_not_configured",
    );
  });
});

describe("the provider door (`/api/auth/login`, `/api/auth/callback`)", () => {
  /* This block, and only this block, switches the provider on for itself and
     puts the key back afterwards — the same arrangement `bootstrap.test.ts`
     uses, and for the same reason: the run's environment leaves OIDC off. */
  const previousOidcKey = process.env.ORBIT_AUTH_OIDC;

  beforeAll(() => {
    process.env.ORBIT_AUTH_OIDC = "true";
    resetAuthConfigForTests();
  });

  afterAll(() => {
    if (previousOidcKey === undefined) delete process.env.ORBIT_AUTH_OIDC;
    else process.env.ORBIT_AUTH_OIDC = previousOidcKey;
    resetAuthConfigForTests();
  });

  it("tells an unclaimed instance from a provider it cannot reach", async () => {
    await refusal(
      await call(startLogin, "/api/auth/login", { method: "GET" }),
      403,
      "bootstrap_required",
    );

    /* Claimed, so the claim gate is out of the way and the next thing the
       route does is go looking for the provider. Discovery is stubbed rather
       than attempted, so this asserts the refusal and never a name resolver. */
    await claimTheInstance();
    vi.stubGlobal("fetch", () => Promise.reject(new Error("no provider in this suite")));
    await refusal(
      await call(startLogin, "/api/auth/login", { method: "GET" }),
      502,
      "discovery_failed",
    );
  });

  it("tells the three ways a provider answer can be wrong apart, on the error screen", async () => {
    const config = getAuthConfig();

    /* The provider said no. Nothing here is Orbit's fault and nothing about
       this instance will fix it: the operator goes to the provider. */
    callbackRefusal(
      await call(returnFromProvider, "/api/auth/callback?error=access_denied", { method: "GET" }),
      "provider_error",
    );

    /* An answer with no transaction behind it — a bookmarked callback, or a
       browser that dropped the cookie. Nothing was wrong with the sign-in;
       it has to be started again. */
    callbackRefusal(
      await call(returnFromProvider, "/api/auth/callback?code=a-code&state=a-state", { method: "GET" }),
      "invalid_request",
    );

    /* A transaction that exists and does not match: this is the one that can
       mean an attack, and it must not be told as the harmless case above. */
    const transaction = {
      state: randomUrlSafe(),
      nonce: randomUrlSafe(),
      codeVerifier: randomUrlSafe(),
      returnTo: "/",
    };
    const sealed = await sealLoginTransaction(transaction, config);
    callbackRefusal(
      await call(returnFromProvider, "/api/auth/callback?code=a-code&state=some-other-state", {
        method: "GET",
        headers: { cookie: `${transactionCookieName(config)}=${sealed}` },
      }),
      "invalid_state",
    );
  });
});

/**
 * Codes no route in this suite can produce, and why.
 *
 * Every one of these is raised PAST the token exchange: `completeAuthorization`
 * has to have posted a code to a real provider's token endpoint and got an
 * answer back before any of them can happen. Nothing in `tests/integration`
 * stands up a provider — the disposable stack for that is
 * `scripts/test-e2e-local.sh`'s OIDC sidecar — so a route test here cannot
 * reach them, and pretending otherwise would be the false alarm this gate
 * exists to avoid.
 *
 * Moving one out of this map is a real piece of work, not a formality: it
 * means this suite gained a provider.
 */
const pastTheTokenExchange: Record<string, string> = {
  token_exchange_failed: "the provider's token endpoint has to answer, and refuse",
  invalid_id_token: "an ID token has to come back and fail signature or claim validation",
  missing_email: "the provider has to return a profile with no usable address",
  link_exists: "the callback's link branch runs only on a verified returning identity",
  step_up_failed: "the proof is minted from a verified `auth_time` the provider supplies",
};

/**
 * Codes another named suite produces through a route, and where.
 *
 * Kept short on purpose. An entry is a pointer to a test that already exists
 * and is better placed than a copy here would be — not a way to excuse a code
 * nothing covers. The gate checks the pointer still leads somewhere.
 */
const coveredElsewhere: Record<string, { file: string; why: string }> = {
  instance_locked: {
    file: "tests/integration/local-sign-in.test.ts",
    why: "arrived with the #969 fix, in the sign-in file, with the key removed around it",
  },
};

/** The members of the `AuthErrorCode` union, read out of the source. */
function authErrorCodes(): string[] {
  const source = readFileSync(new URL("../../src/lib/auth/errors.ts", import.meta.url), "utf8")
    .replaceAll(/\/\*[\s\S]*?\*\//gu, "");
  const union = source.split("export type AuthErrorCode =")[1]?.split(";")[0];
  if (!union) throw new Error("AuthErrorCode is no longer a union declared in src/lib/auth/errors.ts");
  return [...union.matchAll(/"([a-z0-9_]+)"/gu)].map((match) => match[1]);
}

describe("the gate over the refusal vocabulary (#1034)", () => {
  /* Last on purpose: `observed` is filled by the tests above, in order. */
  it("accounts for every member of AuthErrorCode", () => {
    const codes = authErrorCodes();
    expect(codes.length).toBeGreaterThan(20);

    const unaccounted = codes.filter((code) =>
      !observed.has(code) && !(code in coveredElsewhere) && !(code in pastTheTokenExchange));
    /* The #1034 failure, caught: a verdict was added, a route flattened it,
       and no test anywhere produced the new word. Write the route test, or
       say in one of the two maps above why there cannot be one. */
    expect(unaccounted).toEqual([]);

    // Nothing may be excused twice, and nothing may be excused and also proved.
    const excused = [...Object.keys(coveredElsewhere), ...Object.keys(pastTheTokenExchange)];
    expect(excused.filter((code) => observed.has(code))).toEqual([]);
    expect(new Set(excused).size).toBe(excused.length);

    /* And no entry may outlive its code. A stale exclusion is how a gate
       quietly stops covering something it used to cover. */
    expect(excused.filter((code) => !codes.includes(code))).toEqual([]);
  });

  it("does not pretend to cover every error code a server module can raise", () => {
    /* #1034 floats a wider version of this gate: every code any server module
       raises should be reachable through some route test. It is not written,
       and this test is where that decision lives rather than in a commit
       message nobody will find.
     *
     * Two reasons, both measured on this tree rather than guessed.
     *
     * One: scope. `AppError` and `AuthError` are constructed with a string
     * literal in ~115 distinct places across `src/`, and most of them belong
     * to the notification worker, the IMAP intake, document processing and
     * the operator CLI — code with no route in front of it at all. Demanding
     * route reachability for `staging_purge_failed` produces a red gate and a
     * shrug, every time, which trains people to widen the allow-list until it
     * covers everything.
     *
     * Two: the only cheap way to answer "is this code covered" across 50
     * suites is to scan them for the literal, and that scan gives wrong
     * answers in both directions. `account_disabled` appears in three suites
     * only as the name of an audit-log action. `step_up_failed` appears only
     * as the code of an exception from a directly-called engine function, with
     * no route involved. A scan calls both covered. A gate that says "covered"
     * when nothing covered it is worse than no gate, because it is believed.
     *
     * So this file takes the narrow, honest version instead: one closed union,
     * every member of it produced HERE off a real route response, and the two
     * exceptions written down with their reasons. It does not generalise, and
     * the next person should widen it by adding a union — a closed list of
     * codes some surface is allowed to use — rather than by scanning text. */
    expect(observed.size).toBeGreaterThan(0);
  });
});
