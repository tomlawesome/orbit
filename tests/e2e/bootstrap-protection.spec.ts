import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { EncryptJWT } from "jose";
import { claimCodeFromLog, claimInstanceAsAdministrator, stackLog } from "./support/bootstrap";

/**
 * THE CLAIM, FROM THE OUTSIDE (#916, ADR-0022).
 *
 * Every other spec in this suite starts by claiming the instance and getting
 * on with its journey. This one is the half hour before that: what a stranger
 * who can resolve the address, but cannot read the container's log, is able
 * to do. The answer has to be "nothing", and "nothing" is only ever proved by
 * trying.
 *
 * ══ HOW THIS FILE IS ISOLATED, since it needs a state that exists once ═════
 *
 * The database is not reset between specs (v19-arrival.spec.ts) and the claim
 * happens once per stack, so an unclaimed instance is a resource exactly one
 * file can hold. Four things give it to this one, and each is deliberate:
 *
 *   1. THE NAME. Playwright runs files in path order and this suite runs on
 *      one worker (playwright.config.ts), so `bootstrap-protection` sorts
 *      ahead of `local-sign-in`, `maintenance`, `signed-out` and every
 *      `v19-*`. Renaming this file to sort later would break it.
 *   2. THE PROJECT. Two projects run every file, and the second would meet an
 *      instance the first had claimed. This is desktop-only for that reason:
 *      it is a protocol test, and nothing in it renders differently on a
 *      phone.
 *   3. NO RETRIES. A retry is a second run against a state that no longer
 *      exists, so it could only ever add a confusing second failure to a real
 *      one. Turned off here rather than suite-wide.
 *   4. IT CLAIMS ON ITS WAY OUT, through `claimInstanceAsAdministrator` --
 *      the same helper every other file's `beforeAll` calls, as the same
 *      "Orbit Administrator". So the instance this file hands on is exactly
 *      the one those files would have made for themselves, and nothing
 *      downstream can tell this file ran at all.
 *
 * And if the order ever does change, the first test below fails loudly on an
 * already-claimed instance rather than skipping: a security spec that quietly
 * stops asserting is worse than one that goes red.
 *
 * ══ WHY THIS IS THE PROVIDER PROFILE, not the local-only one ═══════════════
 *
 * The headline refusal of ADR-0022 §2 is that `GET /api/auth/login` -- the
 * start of a provider sign-in -- is unreachable while the instance is
 * unclaimed, because the first identity the provider returns is the one that
 * would become the administrator. That refusal only exists where there is a
 * provider to refuse, so this file runs against the ordinary acceptance stack
 * (compose/docker-compose.acceptance.yml). The local-only profile's own claim
 * journey is tests/e2e/local-sign-in.spec.ts.
 */

/** Runs once per stack; see note 2 above. */
const DESKTOP_PROJECT = "desktop-chromium";

/** ADR-0022 §2: the claim cookie's five minutes, in seconds. */
const CLAIM_TTL_SECONDS = 300;

/* The proof's own two constants (src/lib/auth/crypto.ts). Restated rather
   than imported because a spec runs against a container, not against this
   checkout's modules -- and `mintClaimCookie` below is self-checking: the
   live cookie it mints has to be ACCEPTED, so a drift in either of these
   turns that assertion red instead of passing a forgery off as an expiry. */
const PROOF_ISSUER = "orbit";
const CLAIM_PROOF_AUDIENCE = "bootstrap-claim";

/** A wrong code of the right shape. Never a real one; nothing prints this. */
const WRONG_CODE = "AAAA-BBBB-CCCC-DDDD";

/** The identity a successful bootstrap would have created, had one worked. */
const WOULD_BE_ADMIN = {
  email: "intruder@example.invalid",
  displayName: "Uninvited",
  password: "orbit-e2e-never-created-this",
};

interface AuthBody { error?: { code?: string } }
interface Availability { claimed: boolean; methods: { local: boolean; oidc: boolean; localAccounts: boolean } }

/**
 * One `docker compose` against this run's own stack, the way
 * tests/e2e/support/bootstrap.ts asks it for the log: `COMPOSE_PROJECT_NAME`
 * is exported by scripts/test-e2e-local.sh and unset in CI, which runs
 * compose without `-p`.
 */
function stackCompose(...args: string[]): string {
  const project = process.env.COMPOSE_PROJECT_NAME;
  return execFileSync(
    "docker",
    [
      "compose",
      ...(project ? ["-p", project] : []),
      "--env-file", ".env-orbit", "-f", "docker-compose.yml",
      ...args,
    ],
    {
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, ORBIT_IMAGE: process.env.ORBIT_IMAGE ?? "orbit-local:000000000000" },
    },
  );
}

/**
 * The key the application derives from `SESSION_SECRET`, read from the host
 * file Compose bind-mounts as the `orbit-session-secret` secret. Both
 * harnesses write it: scripts/configure.sh for the local run, and
 * scripts/ci/create-test-configuration.sh through the same script in CI.
 *
 * The value is disposable stack material and is never logged or asserted on;
 * only the cookies derived from it cross into a test.
 */
function proofKey(): Uint8Array {
  const directory = process.env.ORBIT_SECRETS_DIR ?? ".orbit-secrets";
  // The application's own reader strips exactly one trailing newline
  // (src/lib/runtime-secret.ts), so this has to as well.
  const secret = readFileSync(`${directory}/session-secret`, "utf8").replace(/\r?\n$/u, "");
  return createHash("sha256").update(`oidc-transaction:${secret}`, "utf8").digest();
}

/**
 * A claim cookie as the claim route would have minted it, with its clock
 * moved: `ageSeconds` 0 is one issued this instant, 360 is one issued six
 * minutes ago and therefore a minute past its five (ADR-0022 §2).
 *
 * Six rather than five and a bit, because `openProof` allows five seconds of
 * clock tolerance and a boundary this test does not own is not the boundary
 * it is asserting.
 */
async function mintClaimCookie(ageSeconds: number): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000) - ageSeconds;
  return new EncryptJWT({ claim: true })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuer(PROOF_ISSUER)
    .setAudience(CLAIM_PROOF_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + CLAIM_TTL_SECONDS)
    .encrypt(proofKey());
}

/**
 * Both spellings of the cookie name, the way signed-out.spec.ts sends both
 * spellings of the session cookie: which one the application reads depends on
 * whether it thinks it is behind TLS (`claimCookieName`), and a test that
 * guessed wrong would prove a refusal it had engineered itself.
 */
function claimCookieHeader(value: string): Record<string, string> {
  return { cookie: `orbit-claim=${value}; __Secure-orbit-claim=${value}` };
}

/**
 * Every signed-out write here asserts same-origin instead of a CSRF token,
 * because none of these routes has a session to derive one from. A browser
 * sends `Origin` by itself; Playwright's API context does not, so a POST
 * without this would be refused as `csrf_failed` and every assertion below
 * would be proving a refusal the test had arranged. `baseURL` rather than a
 * literal, so nothing here names a host or a port (#741).
 */
function sameOrigin(baseURL: string | undefined, extra: Record<string, string> = {}): Record<string, string> {
  expect(baseURL, "the suite has no baseURL to send as the request origin").toBeTruthy();
  return { origin: baseURL as string, ...extra };
}

async function availability(request: APIRequestContext): Promise<Availability> {
  const response = await request.get("/api/auth/availability");
  expect(response.ok()).toBe(true);
  return (await response.json()) as Availability;
}

/** The bounded code from an auth refusal, which is all a caller ever learns. */
async function refusal(response: { json: () => Promise<unknown> }): Promise<string | undefined> {
  return ((await response.json()) as AuthBody).error?.code;
}

test.describe.configure({ mode: "serial", retries: 0 });

test.beforeAll(() => {
  test.skip(
    test.info().project.name !== DESKTOP_PROJECT,
    "the unclaimed state exists once per stack, so this file runs under one project",
  );
});

test("an unclaimed instance offers a claim card and nothing else", async ({ page, request }) => {
  const before = await availability(request);
  expect(
    before.claimed,
    "this instance is already claimed, so nothing below can be proved. This file has to "
      + "run before anything that claims -- see the ordering note at the top of it.",
  ).toBe(false);
  /* The stack this file expects: a provider is configured, and no account
     has a password yet. */
  expect(before.methods.oidc).toBe(true);
  expect(before.methods.localAccounts).toBe(false);

  await page.goto("/login");

  /* The claim card, in the ring, and not one thing else: no gate to a
     provider, and no identity fields to create anybody with. Absent rather
     than hidden, so there is nothing here for a keyboard or a screen reader
     to reach either. */
  await expect(page.locator("#claimcode")).toBeVisible();
  await expect(page.locator("#gate")).toHaveCount(0);
  await expect(page.locator("#idemail")).toHaveCount(0);
  await expect(page.locator("#idname")).toHaveCount(0);
  await expect(page.locator("#idpassword")).toHaveCount(0);
  await expect(page.locator("#localopen")).toHaveCount(0);
  /* The one sentence that says where the code is -- the only help an operator
     gets, and the only help anybody else gets either. */
  await expect(page.locator(".card .note")).toContainText("docker compose logs orbit-app");

  /* And the rest of Orbit is where it always is. An unclaimed instance is not
     an open one: the signed-out gate still stands in front of every screen. */
  for (const path of ["/home", "/settings", "/administration"]) {
    const gated = await request.get(path, { maxRedirects: 0 });
    expect(gated.status(), path).toBe(303);
    expect(gated.headers()["location"], path).toContain("/login");
  }
});

test("without the code nobody reaches the provider or creates a user", async ({ baseURL, request }) => {
  /* THE ONE THAT MATTERS MOST (ADR-0022 §2). The provider sign-in is what
     creates the first administrator, so anyone who can start it can seize the
     instance. Unclaimed and without the claim cookie, it does not start. */
  const providerStart = await request.get("/api/auth/login?returnTo=%2F", { maxRedirects: 0 });
  expect(providerStart.status()).toBe(403);
  expect(await refusal(providerStart)).toBe("bootstrap_required");
  /* No redirect was prepared either: nothing about the provider leaks out of
     a refusal, not even where it lives. */
  expect(providerStart.headers()["location"]).toBeUndefined();

  /* The other door to the same room: creating the first administrator
     directly. A complete, entirely valid body, so what refuses it is the
     missing claim and nothing about the request. */
  const created = await request.post("/api/auth/bootstrap/local", { headers: sameOrigin(baseURL), data: WOULD_BE_ADMIN });
  expect(created.status()).toBe(403);
  expect(await refusal(created)).toBe("bootstrap_required");

  /* And guessing costs a guess. Every refusal is the one generic answer, so a
     caller learns whether they had the code and not one thing more. */
  const guessed = await request.post("/api/auth/bootstrap/claim", { headers: sameOrigin(baseURL), data: { claim: WRONG_CODE } });
  expect(guessed.status()).toBe(403);
  expect(await refusal(guessed)).toBe("bootstrap_invalid");

  /* Nothing happened. Not "no session was issued" -- no user exists. */
  const after = await availability(request);
  expect(after.claimed).toBe(false);
  expect(after.methods.localAccounts).toBe(false);
});

test("a claim cookie past its five minutes buys nothing", async ({ baseURL, request }) => {
  /* A live cookie first, and it has to be ACCEPTED. That is what makes the
     expired one below evidence: both are minted the same way, from the same
     stack secret, so if this half were wrong the other half would be refused
     for the wrong reason and this test would pass on a forgery. An empty body
     stops the accepted request at the field check -- 400, not 403 -- which
     proves the cookie authorised it without creating anybody. */
  const live = await request.post("/api/auth/bootstrap/local", {
    headers: sameOrigin(baseURL, claimCookieHeader(await mintClaimCookie(0))),
    data: {},
  });
  expect(live.status(), "a live claim cookie was refused: the proof is not being minted correctly").toBe(400);
  expect(await refusal(live)).toBe("invalid_request");

  /* Now the same cookie, six minutes old. ADR-0022 §2 gives it five, on the
     reasoning that the operator has just clicked the link and is at the
     keyboard. */
  const staleCookie = claimCookieHeader(await mintClaimCookie(CLAIM_TTL_SECONDS + 60));
  const stale = sameOrigin(baseURL, staleCookie);

  const created = await request.post("/api/auth/bootstrap/local", { headers: stale, data: WOULD_BE_ADMIN });
  expect(created.status()).toBe(403);
  expect(await refusal(created)).toBe("bootstrap_required");

  /* Expired is not a state of its own: it is refused with the same code, and
     on the same routes, as never having claimed at all. */
  const providerStart = await request.get("/api/auth/login?returnTo=%2F", { headers: staleCookie, maxRedirects: 0 });
  expect(providerStart.status()).toBe(403);
  expect(await refusal(providerStart)).toBe("bootstrap_required");

  const after = await availability(request);
  expect(after.claimed).toBe(false);
  expect(after.methods.localAccounts).toBe(false);
});

test("the code the container printed never leaves its own log", async ({ baseURL, request }) => {
  const log = stackLog();
  const code = claimCodeFromLog(log);
  expect(code, "no claim notice in the stack's log: has orbit-app started?").toBeDefined();
  const printed = code as string;

  /* EVERY SIGNED-OUT ANSWER (ADR-0022 §1). The code lives in this process's
     memory and in the notice; a response that echoed it -- a debug field, an
     error message quoting the input, a header -- would put it in front of the
     stranger the claim exists to keep out. */
  for (const path of ["/", "/login", "/logout", "/api/auth/availability", "/api/health"]) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(await response.text(), `${path} body`).not.toContain(printed);
    expect(JSON.stringify(response.headers()), `${path} headers`).not.toContain(printed);
  }
  /* Including the two refusals that have actually seen a code, right or
     wrong: the claim route is handed one on every attempt. */
  for (const claim of [WRONG_CODE, printed]) {
    const response = await request.post("/api/auth/bootstrap/claim", { headers: sameOrigin(baseURL), data: { claim } });
    expect(await response.text()).not.toContain(printed);
    expect(JSON.stringify(response.headers())).not.toContain(printed);
  }

  /* AND EVERY OPERATIONAL RECORD. `printClaimNotice` is the one documented
     bypass of the `operationalDetail` protocol, so the notice is allowed to
     carry the code and nothing else is -- not the `bootstrap_unclaimed`
     warning beside it, and not the `bootstrap_rejected` one the wrong guess
     above just produced. */
  const carrying = log.split("\n").filter((line) => line.includes(printed));
  expect(carrying.length, "the notice itself is missing from the log").toBeGreaterThan(0);
  for (const line of carrying) {
    expect(
      line.includes(`#claim=${printed}`) || line.includes(`by hand on the sign-in screen: ${printed}`),
      "an operational-log line other than the boot notice carries the claim code",
    ).toBe(true);
  }
});

test("a restart prints a different code, and the old one is dead", async ({ baseURL, request }) => {
  test.setTimeout(180_000);
  const before = claimCodeFromLog(stackLog());
  expect(before, "no claim notice to rotate").toBeDefined();

  /* ADR-0022 §4, in full: rotation is a restart. There is no command, no file
     and no key, because the code has no storage to rotate. */
  stackCompose("restart", "orbit-app");
  await expect.poll(
    async () => {
      try {
        const health = await request.get("/api/health", { timeout: 5_000 });
        return health.ok() ? ((await health.json()) as { status?: string }).status : "down";
      } catch {
        return "down";
      }
    },
    { timeout: 120_000, intervals: [1_000] },
  ).toBe("ready");

  const after = claimCodeFromLog(stackLog());
  expect(after).toBeDefined();
  expect(after, "the restarted process reprinted the same code").not.toBe(before);

  /* The old value went with the old process -- it is not stored, so there is
     nothing left for it to match against. */
  const replayed = await request.post("/api/auth/bootstrap/claim", { headers: sameOrigin(baseURL), data: { claim: before } });
  expect(replayed.status()).toBe(403);
  expect(await refusal(replayed)).toBe("bootstrap_invalid");

  /* The new one works, and what it hands back is a cookie and no secret: the
     code never leaves the process that printed it. */
  const accepted = await request.post("/api/auth/bootstrap/claim", { headers: sameOrigin(baseURL), data: { claim: after } });
  expect(accepted.status()).toBe(200);
  expect(await accepted.text()).not.toContain(after as string);
  const setCookie = accepted.headersArray()
    .filter((header) => header.name.toLowerCase() === "set-cookie")
    .map((header) => header.value)
    .join("\n");
  expect(setCookie).toMatch(/orbit-claim=/u);
  expect(setCookie).toContain(`Max-Age=${CLAIM_TTL_SECONDS}`);
  expect(setCookie).toContain("HttpOnly");
});

test("once the instance is claimed the code is spent, cookie or no cookie", async ({ baseURL, browser, request }) => {
  test.setTimeout(180_000);
  const code = claimCodeFromLog(stackLog());
  expect(code, "no claim notice to replay").toBeDefined();

  /* The real bootstrap, walked by the helper every other file uses, as the
     administrator every other file expects. From here on this stack is
     indistinguishable from one that never met this spec. */
  await claimInstanceAsAdministrator(browser);
  expect((await availability(request)).claimed).toBe(true);

  /* The still-valid code, replayed. State decides, not the code and not the
     cookie: single use is enforced by there being an `instance_authority`
     row, which is why a second claimant racing the first gets this too. */
  const replayed = await request.post("/api/auth/bootstrap/claim", { headers: sameOrigin(baseURL), data: { claim: code } });
  expect(replayed.status()).toBe(409);
  expect(await refusal(replayed)).toBe("bootstrap_claimed");

  /* And a cookie that outlived somebody else's claim is worth nothing: it is
     a live, correctly sealed one, and the answer is still the same. */
  const created = await request.post("/api/auth/bootstrap/local", {
    headers: sameOrigin(baseURL, claimCookieHeader(await mintClaimCookie(0))),
    data: WOULD_BE_ADMIN,
  });
  expect(created.status()).toBe(409);
  expect(await refusal(created)).toBe("bootstrap_claimed");

  /* The gate that was shut in the second test is open now, for everyone: a
     claimed instance is an ordinary one, and the provider is reachable
     without a claim because there is nothing left to seize. */
  const providerStart = await request.get("/api/auth/login?returnTo=%2F", { maxRedirects: 0 });
  expect(providerStart.status()).toBe(302);
});
