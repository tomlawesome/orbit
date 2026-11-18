/*
 * A password change cancels every sign-in approval still waiting (#1898).
 * Standard rule: invalidate outstanding authentication grants when the
 * credential changes (OWASP Session Management Cheat Sheet).
 *
 * Spec, from the issue: changing a password by any route (the signed-in
 * change, the setup link, the #1881 renew step) cancels every pending approval
 * for the account. Pressing an old approval afterwards is the existing
 * "expired" outcome (`{ recorded: false }`), and the waiting sign-in is
 * refused: no session, and the waiting tab's poll answers `{ state: "unknown" }`
 * (start again). Written from the issue, against a real PostgreSQL and the
 * engine's own route handlers, in the shape of forced-reset-after-refusal-1881.
 */
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, instanceAuthority, localCredentials, sessions, signInApprovals, users } from "@/db/schema";
import { pendingSignInCookieName, sessionCookieName } from "@/lib/auth/cookies";
import { hashPassword } from "@/lib/auth/password";
import { getAuthConfig } from "@/lib/env";
import { createLocalUser, issueSetupToken } from "@/server/local-credentials";
import { actorFor, ORIGIN } from "./support/auth";
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

const { POST: signIn } = await loadRoute("auth/local/login");
const { POST: collect } = await loadRoute("auth/local/login/pending");
const { POST: decide } = await loadRoute("auth/approve");
const { POST: consumeSetup } = await loadRoute("auth/local/setup");
const { POST: changePassword } = await loadRoute("auth/local/password");
const { POST: saveNewPassword } = await loadRoute("auth/local/login/new-password");

const OLD_PASSWORD = "the-old-password-for-1898";
const NEW_PASSWORD = "a-brand-new-password-1898";
const created: string[] = [];

beforeEach(async () => {
  mail.sent.length = 0;
  const administrator = await seedAccount("sending-admin");
  await getDb().update(users).set({ isInstanceAdmin: true }).where(eq(users.id, administrator.id));
  await setUpSending(administrator.id);
});

afterEach(async () => {
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
  await cleanupIntegrationEnvironment();
});

function post(handler: RouteHandler, path: string, body: unknown, cookie?: string, extra: Record<string, string> = {}): Promise<Response> {
  return callRoute(handler, {
    url: `${ORIGIN}${path}`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      ...(cookie ? { cookie } : {}),
      ...extra,
    },
    body: JSON.stringify(body),
  });
}

const typePassword = (email: string, password: string) =>
  post(signIn, "/api/auth/local/login", { email, password });
const collectWith = (claim: string) =>
  post(collect, "/api/auth/local/login/pending", {}, `${pendingSignInCookieName(getAuthConfig())}=${claim}`);
const press = (token: string, decision: "approved" | "denied") =>
  post(decide, "/api/auth/approve", { token, decision });

async function seedAccount(label: string): Promise<{ id: string; email: string }> {
  const email = `${label}@cancel-approvals.invalid`;
  const user = await createLocalUser({ email, displayName: `Cancel ${label}`, passwordHash: await hashPassword(OLD_PASSWORD) });
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

async function sessionCount(userId: string): Promise<number> {
  return (await getDb().select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId))).length;
}

/** Every live cookie a response set, as a request header (carries the #1881 hold). */
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

/** Password A typed, approval mailed and left unpressed. */
async function leaveAnApprovalPending(email: string): Promise<{ token: string; claim: string }> {
  const typed = await typePassword(email, OLD_PASSWORD);
  expect(typed.status).toBe(200);
  const claim = claimOf(typed);
  expect(await (await collectWith(claim)).json()).toEqual({ state: "waiting" });
  return { token: mailedToken(), claim };
}

/** What the spec fixes after the change: expired press, waiting tab told to start again, no session. */
async function expectCancelled(userId: string, pending: { token: string; claim: string }): Promise<void> {
  const pressed = await press(pending.token, "approved");
  expect(await pressed.json(), "an old approval was still accepted after the password changed")
    .toEqual({ recorded: false, decision: "approved" });
  expect(await (await collectWith(pending.claim)).json(), "the waiting sign-in was not told to start again")
    .toEqual({ state: "unknown" });
  expect(await sessionCount(userId), "a session was made for a sign-in that began before the password change").toBe(0);
  const poll = await collectWith(pending.claim);
  expect(readSetCookie(poll, sessionCookieName(getAuthConfig()))?.value).toBeUndefined();
}

describe("a password change cancels pending sign-in approvals (#1898)", () => {
  it("the setup link", async () => {
    const account = await seedAccount("setup-link");
    const pending = await leaveAnApprovalPending(account.email);

    const { token } = await issueSetupToken(account.id, "recovery");
    const saved = await post(consumeSetup, "/api/auth/local/setup", { token, password: NEW_PASSWORD });
    expect(saved.status).toBe(200);
    // The setup link signs the browser in by itself; clear that session so only the stale approval could make one.
    await getDb().delete(sessions).where(eq(sessions.userId, account.id));

    await expectCancelled(account.id, pending);
  });

  it("the signed-in password change", async () => {
    const account = await seedAccount("signed-in");
    const actor = await actorFor(account.id);
    const pending = await leaveAnApprovalPending(account.email);

    const changed = await post(changePassword, "/api/auth/local/password",
      { password: NEW_PASSWORD, currentPassword: OLD_PASSWORD }, actor.cookie, { "x-csrf-token": actor.csrfToken });
    expect(changed.status).toBe(200);
    await getDb().delete(sessions).where(eq(sessions.userId, account.id));

    await expectCancelled(account.id, pending);
  });

  it("the renew step for a marked account (#1881)", async () => {
    const account = await seedAccount("renew");
    // Mark the account: one refused sign-in.
    const refused = await typePassword(account.email, OLD_PASSWORD);
    await press(mailedToken(), "denied");
    expect(await (await collectWith(claimOf(refused))).json()).toEqual({ state: "denied" });
    mail.sent.length = 0;

    // Land on the renew step with an approved sign-in, holding the hold.
    const landing = await typePassword(account.email, OLD_PASSWORD);
    await press(mailedToken(), "approved");
    const landed = await collectWith(claimOf(landing));
    expect(((await landed.clone().json()) as { state?: string }).state).toBe("password_change_required");
    const hold = replayCookies(landed);
    mail.sent.length = 0;

    // A further sign-in with the old password waits for its approval.
    const pending = await leaveAnApprovalPending(account.email);

    const saved = await post(saveNewPassword, "/api/auth/local/login/new-password",
      { password: NEW_PASSWORD, passwordAgain: NEW_PASSWORD }, hold);
    expect(saved.status).toBe(200);
    await getDb().delete(sessions).where(eq(sessions.userId, account.id));

    await expectCancelled(account.id, pending);
  });

  it("control: an approval asked for after the change still works", async () => {
    const account = await seedAccount("control");
    const { token } = await issueSetupToken(account.id, "recovery");
    expect((await post(consumeSetup, "/api/auth/local/setup", { token, password: NEW_PASSWORD })).status).toBe(200);
    await getDb().delete(sessions).where(eq(sessions.userId, account.id));
    await new Promise((resolve) => setTimeout(resolve, 20));
    mail.sent.length = 0;

    const typed = await typePassword(account.email, NEW_PASSWORD);
    expect(typed.status).toBe(200);
    expect(await (await press(mailedToken(), "approved")).json()).toEqual({ recorded: true, decision: "approved" });
    const collected = await collectWith(claimOf(typed));
    expect(await collected.json()).toEqual({ state: "approved", authenticated: true });
    expect(await sessionCount(account.id)).toBe(1);
  });

  it("an old approval's 'This wasn't me' after the change does not mark the new password", async () => {
    // Already held by forced-reset-after-refusal-1881 ("refusing an approval made before the last
    // password change leaves the new password unmarked"); this holds it for the cancelled case too.
    const account = await seedAccount("not-me");
    const pending = await leaveAnApprovalPending(account.email);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { token } = await issueSetupToken(account.id, "recovery");
    expect((await post(consumeSetup, "/api/auth/local/setup", { token, password: NEW_PASSWORD })).status).toBe(200);

    await press(pending.token, "denied");
    const [row] = await getDb().select({ at: localCredentials.passwordChangeRequiredAt }).from(localCredentials)
      .where(eq(localCredentials.userId, account.id));
    expect(row.at).toBeNull();
  });
});
