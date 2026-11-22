/*
 * A refused sign-in forces a password change at the next sign-in (#1881,
 * ADR-0027 amendment; NIST SP 800-63B section 5.1.1 on memorized secrets: force a change of memorized
 * secret on evidence of compromise). Written from the issue and the ratified
 * mock-up (design/v19/password-after-refusal/round-1, direction R) before any
 * code exists, against a real PostgreSQL and the engine's own route handlers,
 * in the shape of sign-in-second-factor.test.ts.
 *
 * What the spec fixes, and these journeys hold:
 *  - pressing "This wasn't me" marks the account's credential;
 *  - the next sign-in, by password (after the email approval) or by provider,
 *    gets NO session; it lands on the set-new-password step instead;
 *  - the mark has no expiry: it is security state, not a notice;
 *  - the new password follows the rules (12 or more characters, typed twice
 *    the same, not the old one) and only a saved one clears the mark and signs
 *    the person in -- a setup or recovery link clears it too;
 *  - a hold that runs out before a password is saved is "lapsed";
 *  - the step shows when the refusal happened, never an address or a device.
 *
 * WHERE THE SPEC IS SILENT, the contract this file pins (each is a decision
 * the test writer made on the most defensive reading, listed in the commit):
 *  - the collecting route answers an approved, marked sign-in with
 *    `{ state: "password_change_required", refusedAt: <ISO time> }`, sets no
 *    session cookie, and sets whatever cookie carries the hold; the tests
 *    replay every cookie it set, so the cookie's name is the build's own;
 *  - the provider callback sets no session cookie either, and likewise sets
 *    the hold's cookie;
 *  - the step is saved with `POST /api/auth/local/login/new-password`,
 *    body `{ password, passwordAgain }`: 200 `{ authenticated: true }` plus a
 *    session cookie; a mismatch is 400 `password_mismatch`, a bounds failure
 *    400 `password_rejected`, the old password 400 `password_unchanged`, a
 *    missing, spent or lapsed hold 4xx (lapsed: `password_change_lapsed`);
 *  - a refused entry leaves the hold standing, so the person may try again;
 *  - the hold lapses after the approval's own ten minutes.
 */
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, instanceAuthority, localCredentials, sessions, signInApprovals, users } from "@/db/schema";
import { passwordChangeCookieName, pendingSignInCookieName, sessionCookieName } from "@/lib/auth/cookies";
import { PasswordChangeRequiredError } from "@/lib/auth/errors";
import * as sessionModule from "@/lib/auth/session";
import * as oidc from "@/lib/auth/oidc";
import type { OidcMetadata } from "@/lib/auth/oidc";
import { hashPassword } from "@/lib/auth/password";
import { getAuthConfig, resetAuthConfigForTests } from "@/lib/env";
import { createLocalUser, LOCAL_LOCKOUT_CEILING_MS, LOCAL_SIGN_IN_FREE_ATTEMPTS } from "@/server/local-credentials";
import { PASSWORD_CHANGE_HOLD_TTL_MS } from "@/lib/auth/password-change-hold";
import { ORIGIN } from "./support/auth";
import { cleanupIntegrationEnvironment } from "./support/fixtures";
import { clearSending, setUpSending } from "./support/mail-sending-1629";
import { callRoute, loadRoute, type RouteHandler } from "./support/request-event";
import { readSetCookie } from "./support/set-cookie";

const mail = vi.hoisted(() => ({
  sent: [] as Array<{ from: string; to: string; subject: string; text: string }>,
}));

vi.mock("nodemailer", () => {
  const createTransport = () => ({
    async sendMail(message: { from: string; to: string; subject: string; text: string }) {
      mail.sent.push({ from: message.from, to: message.to, subject: message.subject, text: message.text });
      return { messageId: "fixture" };
    },
    async verify() { return true; },
    close() {},
  });
  return { default: { createTransport }, createTransport };
});

const previousOidcKey = process.env.ORBIT_AUTH_OIDC;
process.env.ORBIT_AUTH_OIDC = "true";
resetAuthConfigForTests();

const { POST: signIn } = await loadRoute("auth/local/login");
const { POST: collect } = await loadRoute("auth/local/login/pending");
const { POST: decide } = await loadRoute("auth/approve");
const { GET: sessionStatus } = await loadRoute("auth/session");

/* Loading it inside each case, rather than
   at the top, makes every case fail on its own line instead of the whole file
   failing to import. */
async function saveRoute(): Promise<RouteHandler> {
  const route = await loadRoute("auth/local/login/new-password").catch((error: unknown) => {
    throw new Error(`the set-new-password route (POST /api/auth/local/login/new-password) is missing: ${String(error)}`);
  });
  return route.POST;
}

const ISSUER = "https://oidc.invalid.example";
const OLD_PASSWORD = "the-password-somebody-knew";
const NEW_PASSWORD = "a-brand-new-password-1881";
const created: string[] = [];

const METADATA: OidcMetadata = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
  code_challenge_methods_supported: ["S256"],
};

const SECOND = 1000;

beforeEach(async () => {
  mail.sent.length = 0;
  const administrator = await seedAccount("sending-admin");
  await getDb().update(users).set({ isInstanceAdmin: true }).where(eq(users.id, administrator.id));
  await setUpSending(administrator.id);
  vi.spyOn(oidc, "discoverProvider").mockResolvedValue(METADATA);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await clearSending();
  const db = getDb();
  await db.delete(signInApprovals);
  await db.delete(instanceAuthority);
  await db.delete(auditLog);
  if (created.length > 0) await db.delete(users).where(inArray(users.id, created));
  created.length = 0;
});

afterAll(async () => {
  if (previousOidcKey === undefined) delete process.env.ORBIT_AUTH_OIDC;
  else process.env.ORBIT_AUTH_OIDC = previousOidcKey;
  await cleanupIntegrationEnvironment();
});

function post(handler: RouteHandler, path: string, body: unknown, cookie?: string): Promise<Response> {
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

const typePassword = (email: string, password = OLD_PASSWORD) =>
  post(signIn, "/api/auth/local/login", { email, password });
const collectWith = (claim?: string) =>
  post(collect, "/api/auth/local/login/pending", {}, claim ? `${pendingSignInCookieName(getAuthConfig())}=${claim}` : undefined);
const press = (token: string, decision: "approved" | "denied") =>
  post(decide, "/api/auth/approve", { token, decision });

async function save(body: unknown, cookie?: string): Promise<Response> {
  return post(await saveRoute(), "/api/auth/local/login/new-password", body, cookie);
}

async function seedAccount(label: string, password = OLD_PASSWORD): Promise<{ id: string; email: string }> {
  const email = `${label}@sign-in-hold-1901.invalid`;
  const user = await createLocalUser({ email, displayName: `Reset ${label}`, passwordHash: await hashPassword(password) });
  created.push(user.id);
  return { id: user.id, email };
}

function claimOf(response: Response): string {
  const claim = readSetCookie(response, pendingSignInCookieName(getAuthConfig()))?.value;
  if (!claim) throw new Error("the sign-in set no pending-sign-in cookie");
  return claim;
}

function mailedToken(): string {
  const message = mail.sent.at(-1);
  if (!message) throw new Error("no approval mail was sent");
  const match = /\/approve\/([^\s"'<>]+)/u.exec(message.text);
  if (!match) throw new Error("the mail carries no approval link");
  return decodeURIComponent(match[1]);
}

function sessionCookieOf(response: Response): string | undefined {
  return readSetCookie(response, sessionCookieName(getAuthConfig()))?.value;
}

async function sessionCount(userId: string): Promise<number> {
  return (await getDb().select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId))).length;
}

/** Every live cookie a response set, as a request header: the hold's carrier, whatever the build names it. */
function replayCookies(response: Response): string {
  const live: string[] = [];
  for (const header of response.headers.getSetCookie()) {
    const [pair, ...attributes] = header.split("; ");
    const value = pair.slice(pair.indexOf("=") + 1);
    const expired = attributes.some((part) => /^max-age=0$/iu.test(part));
    if (value !== "" && !expired) live.push(pair);
  }
  return live.join("; ");
}

/** A password sign-in carried through the email approval; returns the collecting answer. */
async function signInByPassword(email: string, password = OLD_PASSWORD): Promise<Response> {
  const typed = await typePassword(email, password);
  expect(typed.status).toBe(200);
  expect((await press(mailedToken(), "approved")).status).toBe(200);
  return collectWith(claimOf(typed));
}

/** "This wasn't me", pressed on a password sign-in. */
async function refuseASignIn(email: string, password = OLD_PASSWORD): Promise<void> {
  const typed = await typePassword(email, password);
  expect(await (await press(mailedToken(), "denied")).json()).toEqual({ recorded: true, decision: "denied" });
  expect(await (await collectWith(claimOf(typed))).json()).toEqual({ state: "denied" });
}

/** What every "forced to the change step" answer looks like: no session, and the state named. */
async function expectForced(response: Response, userId: string): Promise<{ refusedAt: string; hold: string }> {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = (await response.clone().json()) as Record<string, unknown>;
  expect(body.state).toBe("password_change_required");
  expect(body.authenticated).not.toBe(true);
  expect(typeof body.refusedAt).toBe("string");
  expect(Number.isNaN(Date.parse(String(body.refusedAt)))).toBe(false);
  expect(sessionCookieOf(response), "a marked account was handed a session").toBeUndefined();
  expect(await sessionCount(userId), "a session row exists for a marked account").toBe(0);
  const hold = replayCookies(response);
  expect(hold, "the answer set no cookie to carry the hold to the save step").not.toBe("");
  return { refusedAt: String(body.refusedAt), hold };
}

async function expectSavedAndSignedIn(response: Response, userId: string): Promise<void> {
  expect(response.status).toBe(200);
  expect(await response.clone().json()).toEqual({ authenticated: true });
  const token = sessionCookieOf(response);
  expect(token, "saving a new password set no session cookie").toBeDefined();
  const name = sessionCookieName(getAuthConfig());
  const who = await callRoute(sessionStatus, { url: `${ORIGIN}/api/auth/session`, headers: { cookie: `${name}=${token}` } });
  expect(who.status).toBe(200);
  expect(((await who.json()) as { user?: { id?: string } }).user?.id).toBe(userId);
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.clone().json()) as { error?: { code?: string } }).error?.code ?? "";
}

/** Marks an account (one refusal) and brings it to an approved, unsaved sign-in. */
async function landOnTheStep(label: string) {
  const account = await seedAccount(label);
  await refuseASignIn(account.email);
  mail.sent.length = 0;
  const landed = await signInByPassword(account.email);
  const forced = await expectForced(landed, account.id);
  return { account, ...forced };
}


async function markOf(userId: string): Promise<Date | null> {
  const [row] = await getDb().select({ at: localCredentials.passwordChangeRequiredAt })
    .from(localCredentials).where(eq(localCredentials.userId, userId));
  return row?.at ?? null;
}

describe("a retry after a save is told the password is saved, not that the sign-in lapsed (#1901 ruling 1)", () => {
  it("answers password_change_saved (400) to the hold's second use after a normal save", async () => {
    const { account, hold } = await landOnTheStep("retry-saved");
    await expectSavedAndSignedIn(await save({ password: NEW_PASSWORD, passwordAgain: NEW_PASSWORD }, hold), account.id);

    const retry = await save({ password: NEW_PASSWORD, passwordAgain: NEW_PASSWORD }, hold);
    expect(retry.status).toBe(400);
    expect(await errorCode(retry)).toBe("password_change_saved");
    const body = (await retry.clone().json()) as { error?: { message?: string } };
    expect(body.error?.message).toBe("Your new password is already saved; sign in with it");
    expect(sessionCookieOf(retry)).toBeUndefined();
  });

  it("a mint that fails after the save answers sign_in_again, clears the hold, and the retry is password_change_saved", async () => {
    const { account, hold } = await landOnTheStep("lost-response");
    vi.spyOn(sessionModule, "createSession").mockRejectedValueOnce(new Error("database unavailable"));

    const answered = await save({ password: NEW_PASSWORD, passwordAgain: NEW_PASSWORD }, hold);
    expect(answered.status).toBe(200);
    expect(await answered.clone().json()).toEqual({ saved: true, state: "sign_in_again" });
    expect(sessionCookieOf(answered)).toBeUndefined();
    expect(await sessionCount(account.id)).toBe(0);
    expect(await markOf(account.id)).toBeNull();
    const cleared = readSetCookie(answered, passwordChangeCookieName(getAuthConfig()));
    expect(cleared, "the hold cookie was not cleared").toBeDefined();
    expect(cleared?.value ?? "").toBe("");

    const retry = await save({ password: NEW_PASSWORD, passwordAgain: NEW_PASSWORD }, hold);
    expect(retry.status).toBe(400);
    expect(await errorCode(retry)).toBe("password_change_saved");
  });

  it("a refusal between save and mint answers saved with a fresh hold that saves", async () => {
    const { account, hold } = await landOnTheStep("remark-between");
    const remarked = new Date(Date.now() + SECOND);
    vi.spyOn(sessionModule, "createSession").mockImplementationOnce(async () => {
      await getDb().update(localCredentials).set({ passwordChangeRequiredAt: remarked })
        .where(eq(localCredentials.userId, account.id));
      throw new PasswordChangeRequiredError(account.id, remarked);
    });

    const answered = await save({ password: NEW_PASSWORD, passwordAgain: NEW_PASSWORD }, hold);
    expect(answered.status).toBe(200);
    expect(await answered.clone().json()).toEqual({
      saved: true,
      state: "password_change_required",
      refusedAt: remarked.toISOString(),
    });
    expect(sessionCookieOf(answered)).toBeUndefined();
    const third = "a-third-password-after-the-race";
    await expectSavedAndSignedIn(
      await save({ password: third, passwordAgain: third }, replayCookies(answered)),
      account.id,
    );
  });
});

describe("a cleared mark is 'saved' only if the typed password is the stored one (#1901 ruling 1 review)", () => {
  const OTHER_PATH_PASSWORD = "set-by-a-recovery-link-1901";
  const TYPED_BY_HOLD = "typed-by-the-hold-after-clear-1901";

  async function storedHash(userId: string): Promise<string | undefined> {
    const [row] = await getDb().select({ hash: localCredentials.passwordHash })
      .from(localCredentials).where(eq(localCredentials.userId, userId));
    return row?.hash;
  }

  /* What a recovery link or a signed-in change does: new hash, mark cleared. */
  async function clearElsewhere(userId: string): Promise<string> {
    const hash = await hashPassword(OTHER_PATH_PASSWORD);
    await getDb().update(localCredentials).set({ passwordHash: hash, passwordChangeRequiredAt: null })
      .where(eq(localCredentials.userId, userId));
    return hash;
  }

  it("(a) the hold saves P1, a retry with P1 answers password_change_saved", async () => {
    const { account, hold } = await landOnTheStep("clear-own-save");
    await expectSavedAndSignedIn(await save({ password: NEW_PASSWORD, passwordAgain: NEW_PASSWORD }, hold), account.id);
    const retry = await save({ password: NEW_PASSWORD, passwordAgain: NEW_PASSWORD }, hold);
    expect(retry.status).toBe(400);
    expect(await errorCode(retry)).toBe("password_change_saved");
  });

  it("(b) mark cleared elsewhere with P0, the hold submits P2: password_change_lapsed, stored hash still P0", async () => {
    const { account, hold } = await landOnTheStep("clear-elsewhere-other");
    const before = await clearElsewhere(account.id);
    const answered = await save({ password: TYPED_BY_HOLD, passwordAgain: TYPED_BY_HOLD }, hold);
    expect(answered.status).toBe(400);
    expect(await errorCode(answered)).toBe("password_change_lapsed");
    expect(sessionCookieOf(answered)).toBeUndefined();
    expect(await storedHash(account.id)).toBe(before);
  });

  it("(c) mark cleared elsewhere with P0, the hold submits P0: password_change_saved, nothing written", async () => {
    const { account, hold } = await landOnTheStep("clear-elsewhere-same");
    const before = await clearElsewhere(account.id);
    const answered = await save({ password: OTHER_PATH_PASSWORD, passwordAgain: OTHER_PATH_PASSWORD }, hold);
    expect(answered.status).toBe(400);
    expect(await errorCode(answered)).toBe("password_change_saved");
    expect(await storedHash(account.id)).toBe(before);
  });
});

describe("a miss on a cleared mark counts as a failed password attempt, as at the door (#1901)", () => {
  const OTHER_PATH_PASSWORD = "set-by-a-recovery-link-1901";

  async function failureState(userId: string) {
    const [row] = await getDb()
      .select({ count: localCredentials.failedAttemptCount, lockedUntil: localCredentials.lockedUntil })
      .from(localCredentials).where(eq(localCredentials.userId, userId));
    return row;
  }

  async function clearElsewhere(userId: string): Promise<void> {
    await getDb().update(localCredentials)
      .set({ passwordHash: await hashPassword(OTHER_PATH_PASSWORD), passwordChangeRequiredAt: null })
      .where(eq(localCredentials.userId, userId));
  }

  it("each wrong password raises failedAttemptCount by one, and past the door's free attempts the account locks as at the door", async () => {
    const { account, hold } = await landOnTheStep("miss-counts");
    await clearElsewhere(account.id);
    const before = (await failureState(account.id))?.count ?? 0;
    const free = LOCAL_SIGN_IN_FREE_ATTEMPTS;

    for (let miss = 1; miss <= free + 1; miss += 1) {
      const guess = `a-wrong-guess-number-${miss}-1901`;
      const answered = await save({ password: guess, passwordAgain: guess }, hold);
      expect(await errorCode(answered)).toBe("password_change_lapsed");
      const after = await failureState(account.id);
      expect(after?.count, `after miss ${miss}`).toBe(before + miss);
      if (before + miss <= free) expect(after?.lockedUntil).toBeNull();
    }
    const locked = await failureState(account.id);
    expect(locked?.lockedUntil, "the account was not locked past the free attempts").not.toBeNull();
    expect(locked!.lockedUntil!.getTime()).toBeLessThanOrEqual(Date.now() + LOCAL_LOCKOUT_CEILING_MS);
  });

  it("a match leaves failedAttemptCount unchanged", async () => {
    const { account, hold } = await landOnTheStep("match-uncounted");
    await clearElsewhere(account.id);
    await getDb().update(localCredentials).set({ failedAttemptCount: 2 }).where(eq(localCredentials.userId, account.id));
    const answered = await save({ password: OTHER_PATH_PASSWORD, passwordAgain: OTHER_PATH_PASSWORD }, hold);
    expect(await errorCode(answered)).toBe("password_change_saved");
    expect((await failureState(account.id))?.count).toBe(2);
  });
});

describe("a lost pending answer is re-issued from the spent approval (#1901 ruling 2, W-R2)", () => {
  /** Lands on the step once, and keeps the claim so the same tab can poll again. */
  async function landKeepingTheClaim(label: string) {
    const account = await seedAccount(label);
    await refuseASignIn(account.email);
    mail.sent.length = 0;
    const typed = await typePassword(account.email);
    expect(typed.status).toBe(200);
    expect((await press(mailedToken(), "approved")).status).toBe(200);
    const claim = claimOf(typed);
    const first = await expectForced(await collectWith(claim), account.id);
    return { account, claim, first };
  }

  it("answers password_change_required again for the same claim, with the same refusal moment and a hold that saves", async () => {
    const { account, claim, first } = await landKeepingTheClaim("reissue");

    const again = await collectWith(claim);
    const forced = await expectForced(again, account.id);
    expect(forced.refusedAt).toBe(first.refusedAt);

    await expectSavedAndSignedIn(
      await save({ password: NEW_PASSWORD, passwordAgain: NEW_PASSWORD }, forced.hold),
      account.id,
    );
  });

  it("never extends the hold: it lapses at consumedAt + TTL, however late the re-issue", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { account, claim } = await landKeepingTheClaim("never-extended");
    const consumedAt = Date.now();

    vi.setSystemTime(consumedAt + PASSWORD_CHANGE_HOLD_TTL_MS - 60_000);
    const forced = await expectForced(await collectWith(claim), account.id);

    vi.setSystemTime(consumedAt + PASSWORD_CHANGE_HOLD_TTL_MS + 1_000);
    const late = await save({ password: NEW_PASSWORD, passwordAgain: NEW_PASSWORD }, forced.hold);
    expect(late.status).toBe(400);
    expect(await errorCode(late)).toBe("password_change_lapsed");
    expect(await markOf(account.id), "a lapsed hold saved a password").not.toBeNull();
  });

  it("a re-issue inside the window still saves before it lapses", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { account, claim } = await landKeepingTheClaim("inside-window");
    const consumedAt = Date.now();

    vi.setSystemTime(consumedAt + PASSWORD_CHANGE_HOLD_TTL_MS - 120_000);
    const forced = await expectForced(await collectWith(claim), account.id);
    vi.setSystemTime(consumedAt + PASSWORD_CHANGE_HOLD_TTL_MS - 60_000);
    await expectSavedAndSignedIn(
      await save({ password: NEW_PASSWORD, passwordAgain: NEW_PASSWORD }, forced.hold),
      account.id,
    );
  });

  it("answers as today (unknown, no hold) once consumedAt is past the TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { claim } = await landKeepingTheClaim("outside-ttl");
    vi.setSystemTime(Date.now() + PASSWORD_CHANGE_HOLD_TTL_MS + 1_000);

    const again = await collectWith(claim);
    expect(again.status).toBe(200);
    expect(await again.clone().json()).toEqual({ state: "unknown" });
    expect(readSetCookie(again, passwordChangeCookieName(getAuthConfig()))?.value ?? "").toBe("");
  });

  it("answers as today (unknown, no hold) once the mark is gone", async () => {
    const { account, claim } = await landKeepingTheClaim("mark-gone");
    await getDb().update(localCredentials).set({ passwordChangeRequiredAt: null })
      .where(eq(localCredentials.userId, account.id));

    const again = await collectWith(claim);
    expect(await again.clone().json()).toEqual({ state: "unknown" });
    expect(readSetCookie(again, passwordChangeCookieName(getAuthConfig()))?.value ?? "").toBe("");
  });

  it("a spent ordinary approval (no mark) still answers unknown on the second poll", async () => {
    const account = await seedAccount("ordinary-spent");
    const typed = await typePassword(account.email);
    expect((await press(mailedToken(), "approved")).status).toBe(200);
    const claim = claimOf(typed);
    expect(await (await collectWith(claim)).json()).toEqual({ state: "approved", authenticated: true });
    expect(await (await collectWith(claim)).json()).toEqual({ state: "unknown" });
  });
});
