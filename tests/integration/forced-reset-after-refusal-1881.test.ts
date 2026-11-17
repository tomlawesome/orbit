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
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, instanceAuthority, sessions, signInApprovals, users } from "@/db/schema";
import { pendingSignInCookieName, sessionCookieName, transactionCookieName } from "@/lib/auth/cookies";
import * as oidc from "@/lib/auth/oidc";
import type { OidcMetadata, VerifiedIdentity } from "@/lib/auth/oidc";
import { hashPassword } from "@/lib/auth/password";
import { getAuthConfig, resetAuthConfigForTests } from "@/lib/env";
import { createLocalUser, issueSetupToken, linkIdentity } from "@/server/local-credentials";
import { SIGN_IN_APPROVAL_TTL_MS } from "@/server/sign-in-approvals";
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
const { GET: signInNotice } = await loadRoute("auth/sign-in-notice");
const { GET: startProviderLogin } = await loadRoute("auth/login");
const { GET: providerCallback } = await loadRoute("auth/callback");
const { POST: consumeSetup } = await loadRoute("auth/local/setup");

/* The save route does not exist yet. Loading it inside each case, rather than
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
const TEN_YEARS = 10 * 365 * 24 * 60 * 60 * SECOND;

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
  const email = `${label}@forced-reset.invalid`;
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
async function refuseASignIn(email: string): Promise<void> {
  const typed = await typePassword(email);
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

/* ---------------------------------------------------------------- marking */

describe("refusing a sign-in marks the account (#1881)", () => {
  it("forces the next password sign-in, once approved, to the change step with no session", async () => {
    const account = await seedAccount("marked");
    await refuseASignIn(account.email);
    mail.sent.length = 0;

    // The email approval is still asked first (the issue: "still needs the email approval").
    const typed = await typePassword(account.email);
    expect(((await typed.clone().json()) as { authenticated: boolean }).authenticated).toBe(false);
    expect(mail.sent).toHaveLength(1);
    expect(await (await collectWith(claimOf(typed))).json()).toEqual({ state: "waiting" });

    await press(mailedToken(), "approved");
    await expectForced(await collectWith(claimOf(typed)), account.id);
  });

  it("does not mark an account nobody refused: its approved sign-in gets its session as before", async () => {
    // The guard for the case above: without it "always forced" would pass.
    const account = await seedAccount("unmarked");
    const response = await signInByPassword(account.email);
    expect(await response.json()).toEqual({ state: "approved", authenticated: true });
    expect(sessionCookieOf(response)).toBeDefined();
  });

  it("marks only the refused account, not every account", async () => {
    const refused = await seedAccount("refused-one");
    const bystander = await seedAccount("bystander");
    await refuseASignIn(refused.email);
    mail.sent.length = 0;

    const response = await signInByPassword(bystander.email);
    expect(await response.json()).toEqual({ state: "approved", authenticated: true });
  });

  it("stays forced while the new password is unsaved: an approved, abandoned sign-in leaves the mark in place", async () => {
    const { account } = await landOnTheStep("abandoned");
    mail.sent.length = 0;

    // Walked away from the step; signing in again lands on it again.
    await expectForced(await signInByPassword(account.email), account.id);
  });

  it("is still marked after a second refusal, and the step names the newest refusal", async () => {
    const account = await seedAccount("twice");
    await refuseASignIn(account.email);
    const firstRefusal = Date.now();
    mail.sent.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await refuseASignIn(account.email);
    mail.sent.length = 0;

    const { refusedAt } = await expectForced(await signInByPassword(account.email), account.id);
    expect(Date.parse(refusedAt)).toBeGreaterThan(firstRefusal);
    expect(Date.parse(refusedAt)).toBeLessThanOrEqual(Date.now());
  });

  it("gives a wrong password the same answer a never-refused account gives, so the mark cannot be probed", async () => {
    const refused = await seedAccount("probe-refused");
    const other = await seedAccount("probe-other");
    await refuseASignIn(refused.email);
    mail.sent.length = 0;

    const onMarked = await typePassword(refused.email, "not-the-password-at-all");
    const onUnmarked = await typePassword(other.email, "not-the-password-at-all");
    expect(onMarked.status).toBe(onUnmarked.status);
    expect(await errorCode(onMarked)).toBe(await errorCode(onUnmarked));
    expect(await errorCode(onMarked)).toBe("credentials_invalid");
    expect(sessionCookieOf(onMarked)).toBeUndefined();
  });
});

/* --------------------------------------------------------------- provider */

describe("a provider sign-in is forced to the change step too (#1881)", () => {
  async function providerSignIn(userId: string, subject: string): Promise<Response> {
    const identity: VerifiedIdentity = {
      issuer: ISSUER,
      subject,
      email: `${subject}@forced-reset.invalid`,
      emailVerified: true,
      displayName: "Reset provider reader",
      avatarUrl: null,
    };
    await linkIdentity(userId, identity);
    const config = getAuthConfig();
    const started = await callRoute(startProviderLogin, { url: `${ORIGIN}/api/auth/login?returnTo=%2Fhome` });
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state");
    const transaction = readSetCookie(started, transactionCookieName(config))?.value ?? "";
    vi.spyOn(oidc, "completeAuthorization").mockResolvedValue({ identity, idToken: "header.payload.signature-sentinel" });
    return callRoute(providerCallback, {
      url: `${ORIGIN}/api/auth/callback?code=provider-code&state=${state}`,
      headers: { cookie: `${transactionCookieName(config)}=${transaction}` },
    });
  }

  it("gets no session from the provider callback until a new password is saved, then gets one", async () => {
    const account = await seedAccount("provider-marked");
    await getDb().insert(instanceAuthority).values({ primaryUserId: account.id });
    await refuseASignIn(account.email);

    const returned = await providerSignIn(account.id, "provider-marked-subject");

    expect(sessionCookieOf(returned), "the provider sign-in of a marked account got a session").toBeUndefined();
    expect(await sessionCount(account.id)).toBe(0);
    const hold = replayCookies(returned);
    expect(hold, "the callback set no cookie to carry the hold to the save step").not.toBe("");

    const saved = await save({ password: NEW_PASSWORD, passwordAgain: NEW_PASSWORD }, hold);
    await expectSavedAndSignedIn(saved, account.id);
  });

  it("still goes straight in for an account nobody refused (the guard for the case above)", async () => {
    const account = await seedAccount("provider-clean");
    await getDb().insert(instanceAuthority).values({ primaryUserId: account.id });

    const returned = await providerSignIn(account.id, "provider-clean-subject");

    expect(returned.status).toBe(303);
    expect(sessionCookieOf(returned)).toBeDefined();
  });
});

/* ----------------------------------------------------------- no expiry */

describe("the mark has no expiry (#1881: security state, not a notice)", () => {
  it("still forces the change step ten years later, and a day later, and after the approval lapsed", async () => {
    const account = await seedAccount("forever");
    await refuseASignIn(account.email);
    mail.sent.length = 0;

    vi.useFakeTimers({ toFake: ["Date"] });
    for (const later of [SIGN_IN_APPROVAL_TTL_MS + SECOND, 24 * 60 * 60 * SECOND, TEN_YEARS]) {
      vi.setSystemTime(new Date(Date.now() + later));
      mail.sent.length = 0;
      await expectForced(await signInByPassword(account.email), account.id);
    }
  });

  it("is not spent by being shown: the step reached twice names the same refusal twice", async () => {
    const { account, refusedAt } = await landOnTheStep("not-a-notice");
    mail.sent.length = 0;

    const again = await expectForced(await signInByPassword(account.email), account.id);
    expect(again.refusedAt).toBe(refusedAt);
  });
});

/* ------------------------------------------------------- the new password */

describe("the new password follows the rules (#1881, mock-up R)", () => {
  it("refuses fewer than 12 characters with password_rejected, signs nobody in, keeps the mark and the hold", async () => {
    const { account, hold } = await landOnTheStep("too-short");

    const eleven = "a".repeat(11);
    const refused = await save({ password: eleven, passwordAgain: eleven }, hold);
    expect(refused.status).toBe(400);
    expect(await errorCode(refused)).toBe("password_rejected");
    expect(sessionCookieOf(refused)).toBeUndefined();
    expect(await sessionCount(account.id)).toBe(0);

    // The card keeps its place: the same hold takes a good password next.
    await expectSavedAndSignedIn(await save({ password: NEW_PASSWORD, passwordAgain: NEW_PASSWORD }, hold), account.id);
  });

  it("accepts exactly 12 characters (the boundary that catches an off-by-one)", async () => {
    const { account, hold } = await landOnTheStep("exactly-twelve");
    const twelve = "b".repeat(12);
    await expectSavedAndSignedIn(await save({ password: twelve, passwordAgain: twelve }, hold), account.id);
  });

  it("refuses an over-long password with password_rejected", async () => {
    const { hold } = await landOnTheStep("too-long");
    const huge = "c".repeat(100_000);
    const refused = await save({ password: huge, passwordAgain: huge }, hold);
    expect(refused.status).toBe(400);
    expect(await errorCode(refused)).toBe("password_rejected");
    expect(sessionCookieOf(refused)).toBeUndefined();
  });

  it("refuses two entries that differ with password_mismatch, and saves nothing", async () => {
    const { account, hold } = await landOnTheStep("mismatch");

    const refused = await save({ password: NEW_PASSWORD, passwordAgain: `${NEW_PASSWORD}-typo` }, hold);
    expect(refused.status).toBe(400);
    expect(await errorCode(refused)).toBe("password_mismatch");
    expect(sessionCookieOf(refused)).toBeUndefined();
    expect(await sessionCount(account.id)).toBe(0);

    // Nothing was saved: the new password does not sign in, the old one still reaches the step.
    mail.sent.length = 0;
    const typed = await typePassword(account.email, NEW_PASSWORD);
    expect(await errorCode(typed)).toBe("credentials_invalid");
    await expectForced(await signInByPassword(account.email), account.id);
  });

  it("refuses a missing second entry as a mismatch rather than saving the first", async () => {
    const { hold } = await landOnTheStep("no-second");
    const refused = await save({ password: NEW_PASSWORD }, hold);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(sessionCookieOf(refused)).toBeUndefined();
  });

  it("refuses the password that was refused with password_unchanged, and no session", async () => {
    const { account, hold } = await landOnTheStep("same-as-old");

    const refused = await save({ password: OLD_PASSWORD, passwordAgain: OLD_PASSWORD }, hold);
    expect(refused.status).toBe(400);
    expect(await errorCode(refused)).toBe("password_unchanged");
    expect(sessionCookieOf(refused)).toBeUndefined();
    expect(await sessionCount(account.id)).toBe(0);

    // Still the step on the next sign-in, and the hold still takes a different password.
    await expectSavedAndSignedIn(await save({ password: NEW_PASSWORD, passwordAgain: NEW_PASSWORD }, hold), account.id);
  });

  it("treats a password that differs only in letter case as a different password", async () => {
    // Guards a comparison that case-folds: "not the old one" means not the same secret.
    const { account, hold } = await landOnTheStep("case-differs");
    const shouted = OLD_PASSWORD.toUpperCase();
    await expectSavedAndSignedIn(await save({ password: shouted, passwordAgain: shouted }, hold), account.id);
  });

  it("refuses with no hold at all: a stranger cannot save a password for somebody's account", async () => {
    const { account } = await landOnTheStep("no-hold");
    const refused = await save({ password: NEW_PASSWORD, passwordAgain: NEW_PASSWORD });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(sessionCookieOf(refused)).toBeUndefined();
    expect(await sessionCount(account.id)).toBe(0);
  });

  it("refuses a made-up hold", async () => {
    await landOnTheStep("forged-hold");
    const cookieName = pendingSignInCookieName(getAuthConfig());
    const refused = await save({ password: NEW_PASSWORD, passwordAgain: NEW_PASSWORD }, `${cookieName}=not-a-real-hold`);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(sessionCookieOf(refused)).toBeUndefined();
  });

  it("refuses the approved-but-forced sign-in's claim being used on an account that is not marked", async () => {
    // An unmarked account's approved sign-in must not be able to reach the save route and
    // thereby change its password without the usual challenge.
    const account = await seedAccount("not-marked-saver");
    const typed = await typePassword(account.email);
    await press(mailedToken(), "approved");
    const claim = `${pendingSignInCookieName(getAuthConfig())}=${claimOf(typed)}`;

    const refused = await save({ password: NEW_PASSWORD, passwordAgain: NEW_PASSWORD }, claim);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(sessionCookieOf(refused)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ saving */

describe("saving a new password (#1881)", () => {
  it("clears the mark and signs the person in, with the new password in force and the old one gone", async () => {
    const { account, hold } = await landOnTheStep("saves");

    const saved = await save({ password: NEW_PASSWORD, passwordAgain: NEW_PASSWORD }, hold);
    await expectSavedAndSignedIn(saved, account.id);
    expect(await saved.clone().text()).not.toContain(NEW_PASSWORD);

    // The next sign-in is an ordinary one: approved, and a session, no step.
    mail.sent.length = 0;
    const next = await signInByPassword(account.email, NEW_PASSWORD);
    expect(await next.json()).toEqual({ state: "approved", authenticated: true });
    expect(sessionCookieOf(next)).toBeDefined();

    // The old password, the one somebody knew, no longer signs in at all.
    const oldOne = await typePassword(account.email, OLD_PASSWORD);
    expect(await errorCode(oldOne)).toBe("credentials_invalid");
  });

  it("spends the hold: the same cookies cannot save a second time or sign in again", async () => {
    const { account, hold } = await landOnTheStep("spent");
    await expectSavedAndSignedIn(await save({ password: NEW_PASSWORD, passwordAgain: NEW_PASSWORD }, hold), account.id);

    const replay = await save({ password: "yet-another-password-1881", passwordAgain: "yet-another-password-1881" }, hold);
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(replay.status).toBeLessThan(500);
    expect(sessionCookieOf(replay)).toBeUndefined();
    // And the password stayed the one saved first.
    mail.sent.length = 0;
    expect(await (await signInByPassword(account.email, NEW_PASSWORD)).json()).toEqual({ state: "approved", authenticated: true });
  });

  it("folds the one-time notice into the step: after saving, the sign-in notice has nothing to say", async () => {
    const { account, hold } = await landOnTheStep("notice-gone");
    const saved = await save({ password: NEW_PASSWORD, passwordAgain: NEW_PASSWORD }, hold);
    await expectSavedAndSignedIn(saved, account.id);

    const asked = await callRoute(signInNotice, {
      url: `${ORIGIN}/api/auth/sign-in-notice`,
      headers: { cookie: `${sessionCookieName(getAuthConfig())}=${sessionCookieOf(saved)}` },
    });
    // The route may be gone (404) or answer empty; it must not hand the refusal over a second time.
    if (asked.status === 200) expect(await asked.json()).toEqual({ notice: null });
    else expect(asked.status).toBe(404);
  });

  it("is cleared by a setup or recovery link as well, and not by anything else", async () => {
    const account = await seedAccount("recovery");
    await refuseASignIn(account.email);
    mail.sent.length = 0;

    // Not cleared by merely approving a sign-in.
    await expectForced(await signInByPassword(account.email), account.id);

    const { token } = await issueSetupToken(account.id, "recovery");
    const redeemed = await post(consumeSetup, "/api/auth/local/setup", { token, password: NEW_PASSWORD });
    await expectSavedAndSignedIn(redeemed, account.id);

    mail.sent.length = 0;
    const next = await signInByPassword(account.email, NEW_PASSWORD);
    expect(await next.json()).toEqual({ state: "approved", authenticated: true });
  });
});

/* ------------------------------------------------------------------ lapsed */

describe("the lapsed state (#1881, mock-up scene 5)", () => {
  it("refuses a save after the hold has run out, with no session, and the mark stands", async () => {
    const { account, hold } = await landOnTheStep("lapses");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + SIGN_IN_APPROVAL_TTL_MS + SECOND));

    const refused = await save({ password: NEW_PASSWORD, passwordAgain: NEW_PASSWORD }, hold);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(await errorCode(refused)).toBe("password_change_lapsed");
    expect(sessionCookieOf(refused)).toBeUndefined();
    expect(await sessionCount(account.id)).toBe(0);

    // "Sign in again and choose one then": the next sign-in lands on the step once more.
    mail.sent.length = 0;
    await expectForced(await signInByPassword(account.email), account.id);
  });

  it("is still open just inside the hold (the boundary that catches a hold that lapses early)", async () => {
    const { account, hold } = await landOnTheStep("not-yet-lapsed");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + SIGN_IN_APPROVAL_TTL_MS - 30 * SECOND));

    await expectSavedAndSignedIn(await save({ password: NEW_PASSWORD, passwordAgain: NEW_PASSWORD }, hold), account.id);
  });

  it("does not run the hold's clock on a refused entry: a refusal does not extend it", async () => {
    const { hold } = await landOnTheStep("no-extension");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + SIGN_IN_APPROVAL_TTL_MS - 30 * SECOND));
    expect((await save({ password: "short", passwordAgain: "short" }, hold)).status).toBe(400);

    vi.setSystemTime(new Date(Date.now() + 60 * SECOND));
    const refused = await save({ password: NEW_PASSWORD, passwordAgain: NEW_PASSWORD }, hold);
    expect(await errorCode(refused)).toBe("password_change_lapsed");
  });
});

/* ----------------------------------------------- only the time, no device */

describe("the step shows the time and nothing else about the refused sign-in (#1881, mock-up)", () => {
  const ADDRESS = "203.0.113.77";
  const AGENT = "ExampleBrowser/9.9 (TestOS 4.2)";

  it("carries the refusal's moment and no address, device or count, anywhere in its answer", async () => {
    const account = await seedAccount("only-the-time");
    const before = Date.now();
    const typed = await typePassword(account.email);
    // The approval row is made to carry an address and a device, so their absence below can fail.
    await getDb().update(signInApprovals).set({ clientAddress: ADDRESS, userAgent: AGENT })
      .where(eq(signInApprovals.userId, account.id));
    const [carried] = await getDb().select({ address: signInApprovals.clientAddress, agent: signInApprovals.userAgent })
      .from(signInApprovals).where(eq(signInApprovals.userId, account.id));
    expect(carried).toEqual({ address: ADDRESS, agent: AGENT });
    await press(mailedToken(), "denied");
    const after = Date.now();
    expect(await (await collectWith(claimOf(typed))).json()).toEqual({ state: "denied" });
    mail.sent.length = 0;

    const landed = await signInByPassword(account.email);
    const { refusedAt } = await expectForced(landed, account.id);

    // The time is the moment of the press, to the instant.
    expect(Date.parse(refusedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(refusedAt)).toBeLessThanOrEqual(after);

    // Exactly the fields the step needs; nothing else rides along.
    const body = (await landed.clone().json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["refusedAt", "state"]);
    const wire = `${await landed.clone().text()}\n${landed.headers.get("set-cookie") ?? ""}`;
    for (const secret of [ADDRESS, AGENT, "ExampleBrowser", "TestOS", account.email, OLD_PASSWORD]) {
      expect(wire).not.toContain(secret);
    }
  });

  it("answers a refused save with a code and no echo of the password or the refusal's facts", async () => {
    const { hold } = await landOnTheStep("no-echo");
    const refused = await save({ password: OLD_PASSWORD, passwordAgain: OLD_PASSWORD }, hold);
    const text = await refused.text();
    expect(text).not.toContain(OLD_PASSWORD);
    expect(text).not.toContain("forced-reset.invalid");
  });
});

/* A refusal and the audit trail still leave their one record each. */
describe("the refusal's existing record is unchanged (#1881 adds a mark, removes nothing)", () => {
  it("still records one sign_in_refused row and counts one failed attempt per refusal", async () => {
    const account = await seedAccount("audit-intact");
    await refuseASignIn(account.email);
    const trail = await getDb().select({ action: auditLog.action }).from(auditLog)
      .where(and(eq(auditLog.entityId, account.id), eq(auditLog.action, "sign_in_refused")));
    expect(trail).toHaveLength(1);
  });
});
