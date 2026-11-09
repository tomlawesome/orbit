/*
 * The email second factor, at the API (#1033, ADR-0027), against a real
 * PostgreSQL and the engine's own route handlers.
 *
 * What these journeys hold, and the browser cannot show better: with a mail
 * relay configured, a correct password on `POST /api/auth/local/login` signs
 * nobody in -- it opens a pending sign-in, mails one link, and sets a claim
 * cookie, and no session exists until the mailed link has been pressed AND the
 * browser that typed the password collects it. Opening the link decides
 * nothing (mail scanners follow links); only the claim cookie's holder can
 * collect; a spent approval collects once; "this wasn't me" turns the sign-in
 * away, counts against the credential and leaves the account holder one notice
 * for their next successful sign-in; and a provider (OIDC) sign-in is never
 * asked. Moved here from tests/e2e/second-factor.spec.ts (#1612, ADR-0039),
 * which keeps what the door, the waiting card and the approval page look like.
 *
 * The relay is faked at its lowest seam, the transport library itself, so the
 * mailed link is read off the message exactly as a person would read it and
 * nothing opens a socket. The ten-minute life, the resend minute and the five
 * sends an hour are the engine's arithmetic, pinned in
 * src/server/sign-in-approvals.test.ts.
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, instanceAuthority, localCredentials, signInApprovals, users } from "@/db/schema";
import { pendingSignInCookieName, sessionCookieName, transactionCookieName } from "@/lib/auth/cookies";
import * as oidc from "@/lib/auth/oidc";
import type { OidcMetadata, VerifiedIdentity } from "@/lib/auth/oidc";
import { hashPassword } from "@/lib/auth/password";
import { getAuthConfig, resetAuthConfigForTests } from "@/lib/env";
import { createLocalUser } from "@/server/local-credentials";
import { readSignInApproval } from "@/server/sign-in-approvals";
import { ORIGIN } from "./support/auth";
import { cleanupIntegrationEnvironment } from "./support/fixtures";
import { callRoute, loadRoute } from "./support/request-event";
import { readSetCookie } from "./support/set-cookie";
import { clearSending, setUpSending } from "./support/mail-sending-1629";

/* Mail is captured at the transport library, as the relay tests do. */
const mail = vi.hoisted(() => ({
  sent: [] as Array<{ from: string; to: string; subject: string; text: string }>,
}));

/* S-data3-1: the factor's door reads the sending row; this seam lets a case
   make that read fail. Until a case says otherwise the real answer is used. */
const seam = vi.hoisted(() => ({
  sendingConfigured: vi.fn<() => Promise<boolean>>(),
  real: (async () => false) as () => Promise<boolean>,
}));
vi.mock("@/server/mail-in/sending-settings", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/mail-in/sending-settings")>();
  seam.real = original.sendingConfigured;
  seam.sendingConfigured.mockImplementation(seam.real);
  return { ...original, sendingConfigured: seam.sendingConfigured };
});

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

/* The provider leg needs the provider switched on (ADR-0023 §1); the run's
   environment leaves it off, so this file turns it on for itself. */
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

const ISSUER = "https://oidc.invalid.example";
const PASSWORD = "a-correct-local-password";
const created: string[] = [];

const METADATA: OidcMetadata = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
  code_challenge_methods_supported: ["S256"],
};

beforeEach(async () => {
  mail.sent.length = 0;
  /* A relay is configured: that, and only that, is what turns the factor on
     (ADR-0027 §2). Since #1629 that is the sending row an administrator sets
     on the Mail card, not SMTP_*. */
  const administrator = await seedAccount("sending-admin");
  await getDb().update(users).set({ isInstanceAdmin: true }).where(eq(users.id, administrator.id));
  await setUpSending(administrator.id);
  vi.spyOn(oidc, "discoverProvider").mockResolvedValue(METADATA);
});

afterEach(async () => {
  vi.restoreAllMocks();
  seam.sendingConfigured.mockReset();
  seam.sendingConfigured.mockImplementation(seam.real);
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

function post(handler: typeof signIn, path: string, body: unknown, cookie?: string): Promise<Response> {
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

const typePassword = (email: string, password = PASSWORD) => post(signIn, "/api/auth/local/login", { email, password });
const collectWith = (claim?: string) => post(collect, "/api/auth/local/login/pending", {}, claim ? `${pendingSignInCookieName(getAuthConfig())}=${claim}` : undefined);
const press = (token: string, decision: "approved" | "denied") => post(decide, "/api/auth/approve", { token, decision });

async function seedAccount(label: string): Promise<{ id: string; email: string }> {
  const email = `${label}@factor.invalid`;
  const user = await createLocalUser({ email, displayName: `Factor ${label}`, passwordHash: await hashPassword(PASSWORD) });
  created.push(user.id);
  return { id: user.id, email };
}

/** The claim cookie the sign-in handed the typing browser. */
function claimOf(response: Response): string {
  const claim = readSetCookie(response, pendingSignInCookieName(getAuthConfig()))?.value;
  if (!claim) throw new Error("the sign-in set no pending-sign-in cookie");
  return claim;
}

/** The token in the newest mailed link, read off the message the way a person would. */
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

async function sessionRead(token?: string): Promise<Response> {
  const name = sessionCookieName(getAuthConfig());
  return callRoute(sessionStatus, { url: `${ORIGIN}/api/auth/session`, headers: token ? { cookie: `${name}=${token}` } : undefined });
}

async function sessionUserId(token: string): Promise<string | undefined> {
  const response = await sessionRead(token);
  expect(response.status).toBe(200);
  return ((await response.json()) as { user?: { id?: string } }).user?.id;
}

async function approvalRows(userId: string) {
  return getDb().select().from(signInApprovals).where(eq(signInApprovals.userId, userId));
}

describe("a password with a mail relay (ADR-0027 §1, §4)", () => {
  it("signs nobody in: it opens a pending sign-in, mails one link, and sets a claim cookie and no session", async () => {
    const account = await seedAccount("password-alone");

    const typed = await typePassword(account.email);

    expect(typed.status).toBe(200);
    expect(typed.headers.get("cache-control")).toBe("no-store");
    const body = (await typed.json()) as { authenticated: boolean; pending?: { expiresAt: string; canResendAt: string; limited: boolean } };
    expect(body.authenticated).toBe(false);
    expect(body.pending).toEqual({ expiresAt: expect.any(String), canResendAt: expect.any(String), limited: false });
    // Bounded: the answer never carries the address the link went to, nor the link.
    expect(JSON.stringify(body)).not.toContain(account.email);
    expect(JSON.stringify(body)).not.toContain("/approve/");

    // The claim cookie is the waiting tab's own; there is no session, and the server agrees.
    expect(sessionCookieOf(typed)).toBeUndefined();
    const claimCookie = readSetCookie(typed, pendingSignInCookieName(getAuthConfig()));
    expect(claimCookie?.attributes).toContain("HttpOnly");
    expect(claimCookie?.maxAge).toBe(600);
    expect((await sessionRead()).status).toBe(401);

    // One mail, to the account's own address, with a link to the approval page.
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe(account.email);
    expect(mail.sent[0].text).toContain(`${ORIGIN}/approve/`);
    const [row] = await approvalRows(account.id);
    expect(row.outcome).toBeNull();
    expect(row.sendCount).toBe(1);

    // And the waiting tab, asking, is told to wait.
    const waiting = await collectWith(claimOf(typed));
    expect(await waiting.json()).toEqual({ state: "waiting" });
    expect(sessionCookieOf(waiting)).toBeUndefined();
  });

  it("is not satisfied by opening the link: reading the approval decides nothing, so a mail scanner is not a second factor", async () => {
    const account = await seedAccount("scanner");
    const typed = await typePassword(account.email);

    // What the approval page does on load, which a scanner does too.
    const viewed = await readSignInApproval(mailedToken());
    expect(viewed?.state).toBe("open");

    expect(await (await collectWith(claimOf(typed))).json()).toEqual({ state: "waiting" });
    const [row] = await approvalRows(account.id);
    expect(row.outcome).toBeNull();
  });

  it("lets the mailed approval open the door for the typing browser only, once, and signs in the approver nowhere", async () => {
    const account = await seedAccount("approved");
    const typed = await typePassword(account.email);
    const claim = claimOf(typed);

    // Pressing Approve, from another device: recorded, and that device gets no session.
    const pressed = await press(mailedToken(), "approved");
    expect(pressed.status).toBe(200);
    expect(await pressed.json()).toEqual({ recorded: true, decision: "approved" });
    expect(sessionCookieOf(pressed)).toBeUndefined();

    // Somebody holding only the link, or no cookie at all, collects nothing.
    expect(await (await collectWith()).json()).toEqual({ state: "unknown" });
    expect(await (await collectWith("not-the-claim")).json()).toEqual({ state: "unknown" });

    // The browser that typed the password collects the session, once.
    const collected = await collectWith(claim);
    expect(await collected.json()).toEqual({ state: "approved", authenticated: true });
    const token = sessionCookieOf(collected);
    expect(token).toBeDefined();
    expect(await sessionUserId(token!)).toBe(account.id);

    // Spent: the same claim, asked again, gets nothing.
    expect(await (await collectWith(claim)).json()).toEqual({ state: "unknown" });
  });

  it("answers a second press on the same link with nothing recorded: the first answer stands", async () => {
    const account = await seedAccount("second-press");
    const typed = await typePassword(account.email);
    const token = mailedToken();

    expect((await (await press(token, "approved")).json() as { recorded: boolean }).recorded).toBe(true);
    expect((await (await press(token, "denied")).json() as { recorded: boolean }).recorded).toBe(false);

    // The refusal that was turned away left no trace, and the approval still collects.
    expect(await (await collectWith(claimOf(typed))).json()).toEqual({ state: "approved", authenticated: true });
    expect((await getDb().select().from(auditLog).where(eq(auditLog.action, "sign_in_refused")))).toHaveLength(0);
  });

  it("answers an unknown token with the same generic nothing, and decides nothing", async () => {
    const account = await seedAccount("unknown-token");
    await typePassword(account.email);

    const guessed = await press("a-token-nobody-was-mailed", "approved");

    expect(guessed.status).toBe(200);
    expect(await guessed.json()).toEqual({ recorded: false, decision: "approved" });
    const [row] = await approvalRows(account.id);
    expect(row.outcome).toBeNull();
  });
});

describe("\"this wasn't me\" (ADR-0027 §8 and consequences)", () => {
  it("turns the sign-in away, counts it against the credential, and tells the account holder once, next time", async () => {
    const account = await seedAccount("refused");
    const typed = await typePassword(account.email);
    const claim = claimOf(typed);

    const refusal = await press(mailedToken(), "denied");
    expect(await refusal.json()).toEqual({ recorded: true, decision: "denied" });

    // The waiting tab is told, gets no session, and its cookie is cleared.
    const told = await collectWith(claim);
    expect(await told.json()).toEqual({ state: "denied" });
    expect(sessionCookieOf(told)).toBeUndefined();
    expect(readSetCookie(told, pendingSignInCookieName(getAuthConfig()))?.value).toBe("");
    expect((await sessionRead()).status).toBe(401);

    // The link is spent by the refusal, and the refusal counts as a failed attempt on the credential.
    expect((await (await press(mailedToken(), "approved")).json() as { recorded: boolean }).recorded).toBe(false);
    const [credential] = await getDb().select({ failed: localCredentials.failedAttemptCount })
      .from(localCredentials).where(eq(localCredentials.userId, account.id));
    expect(credential.failed).toBe(1);
    const trail = await getDb().select({ action: auditLog.action }).from(auditLog)
      .where(and(eq(auditLog.entityId, account.id), eq(auditLog.action, "sign_in_refused")));
    expect(trail).toHaveLength(1);

    // The next sign-in that does work carries the notice, once.
    mail.sent.length = 0;
    const again = await typePassword(account.email);
    await press(mailedToken(), "approved");
    const session = sessionCookieOf(await collectWith(claimOf(again)));
    expect(session).toBeDefined();

    const asked = () => callRoute(signInNotice, {
      url: `${ORIGIN}/api/auth/sign-in-notice`,
      headers: { cookie: `${sessionCookieName(getAuthConfig())}=${session}` },
    });
    const first = (await (await asked()).json()) as { notice: { deniedAt: string } | null };
    expect(first.notice?.deniedAt).toEqual(expect.any(String));
    expect(await (await asked()).json()).toEqual({ notice: null });
  });

  it("says nothing when nobody has refused anything", async () => {
    const account = await seedAccount("no-refusal");
    const typed = await typePassword(account.email);
    await press(mailedToken(), "approved");
    const session = sessionCookieOf(await collectWith(claimOf(typed)));

    const response = await callRoute(signInNotice, {
      url: `${ORIGIN}/api/auth/sign-in-notice`,
      headers: { cookie: `${sessionCookieName(getAuthConfig())}=${session}` },
    });

    expect(await response.json()).toEqual({ notice: null });
  });
});

describe("a provider sign-in is never challenged (ADR-0027 §3)", () => {
  it("goes straight in with a session, and no pending sign-in or mail, even with a relay configured", async () => {
    // A claimed instance, so the provider door is open to everyone.
    const seated = await seedAccount("seated");
    await getDb().insert(instanceAuthority).values({ primaryUserId: seated.id });
    const identity: VerifiedIdentity = {
      issuer: ISSUER,
      subject: "factor-provider-reader",
      email: "provider-reader@factor.invalid",
      emailVerified: true,
      displayName: "Factor provider reader",
      avatarUrl: null,
    };
    const config = getAuthConfig();

    const started = await callRoute(startProviderLogin, { url: `${ORIGIN}/api/auth/login?returnTo=%2Fhome` });
    expect(started.status).toBe(302);
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state");
    const transaction = readSetCookie(started, transactionCookieName(config))?.value ?? "";

    vi.spyOn(oidc, "completeAuthorization").mockResolvedValue({ identity, idToken: "header.payload.signature-sentinel" });
    const returned = await callRoute(providerCallback, {
      url: `${ORIGIN}/api/auth/callback?code=provider-code&state=${state}`,
      headers: { cookie: `${transactionCookieName(config)}=${transaction}` },
    });

    expect(returned.status).toBe(303);
    expect(returned.headers.get("location")).toBe(`${ORIGIN}/home`);
    const token = sessionCookieOf(returned);
    expect(token, "the provider sign-in did not create a session").toBeDefined();
    expect(readSetCookie(returned, pendingSignInCookieName(config))).toBeUndefined();
    const userId = await sessionUserId(token!);
    created.push(userId!);
    // Nothing was posted to ask, and nothing is pending.
    expect(mail.sent).toEqual([]);
    expect(await getDb().select().from(signInApprovals)).toEqual([]);
  });
});

describe("with no mail relay the factor is off, as a whole (ADR-0027 §2)", () => {
  it("lets the password alone sign in, as the route did before the factor", async () => {
    await clearSending();
    const account = await seedAccount("no-relay");

    const typed = await typePassword(account.email);

    expect(await typed.json()).toEqual({ authenticated: true });
    const token = sessionCookieOf(typed);
    expect(token).toBeDefined();
    expect(await sessionUserId(token!)).toBe(account.id);
    expect(mail.sent).toEqual([]);
    expect(await approvalRows(account.id)).toEqual([]);
  });
});

describe("the factor fails closed when its setting cannot be read (ADR-0027 §2)", () => {
  it("refuses the sign-in with a temporary 503, signs nobody in, and proceeds normally on the next attempt", async () => {
    const account = await seedAccount("read-fails");
    seam.sendingConfigured.mockRejectedValueOnce(new Error("connection reset"));

    const refused = await typePassword(account.email);

    expect(refused.status).toBe(503);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    const body = (await refused.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("sign_in_unavailable");
    // It must not say which subsystem failed.
    for (const word of ["mail", "sending", "database", "postgres"]) {
      expect((body.error?.message ?? "").toLowerCase()).not.toContain(word);
    }
    expect(sessionCookieOf(refused)).toBeUndefined();
    expect(readSetCookie(refused, pendingSignInCookieName(getAuthConfig()))).toBeUndefined();
    expect(await approvalRows(account.id)).toEqual([]);
    expect(mail.sent).toEqual([]);

    // Temporary: with the read working again the ordinary pending answer follows.
    const retried = await typePassword(account.email);
    expect(retried.status).toBe(200);
    const next = (await retried.json()) as { authenticated: boolean; pending?: unknown };
    expect(next.authenticated).toBe(false);
    expect(next.pending).toBeDefined();
    expect(mail.sent).toHaveLength(1);
    expect(await approvalRows(account.id)).toHaveLength(1);
  });
});
