import { and, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, credentialSetupTokens, localCredentials, signInApprovals, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { sealStepUpProof, stepUpProofCookieName } from "@/lib/auth/recent-auth";
import { getAuthConfig } from "@/lib/env";
import { invitationSendErrors } from "@/server/invitations/send";
import { createLocalUserAndSendSetupLink, sendSetupLink } from "@/server/local-credentials/setup-mail";
import type { SmtpNotification } from "@/server/notification-worker";
import { ORIGIN } from "./support/auth";
import {
  accountAddressColumns,
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
  damageEnvelope,
  lockTheInstance,
  type IntegrationFixture,
  type IntegrationSession,
} from "./support/fixtures";
import { clearMailState, fakeTransporter, setUpSending } from "./support/mail-sending-1629";
import { callRoute, callRouteForSession, loadRoute } from "./support/request-event";

/**
 * AN ADMINISTRATOR SETS A MEMBER'S ADDRESS (#1869, decision note on the issue):
 * `PUT /api/admin/users/{userId}/email`, the way out for an account whose
 * stored address cannot be decrypted (#1604) or was simply typed wrong.
 *
 * Written from the decision note alone, before the route exists. Every
 * refusal is paired with a success it guards, so a refusal that passes
 * because the route is merely absent is caught by its twin (writing-tests.md).
 *
 * Mail goes through the real sending path with only nodemailer's transport
 * stood in, the same way mail-sending-settings-1629 does it.
 */

const mocks = vi.hoisted(() => ({ createTransport: vi.fn() }));
vi.mock("nodemailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nodemailer")>();
  const replaced = { ...actual, createTransport: mocks.createTransport };
  return { ...replaced, default: { ...actual.default, createTransport: mocks.createTransport } };
});

const { GET: listUsers } = await loadRoute("admin/users");
const { PUT: setAddress } = await loadRoute("admin/users/[userId]/email");
const { POST: reissueSetupLink } = await loadRoute("admin/users/[userId]/setup-link");
const { POST: consumeSetup } = await loadRoute("auth/local/setup");

const ADMIN_PASSWORD = "the-administrators-own-password";
const NEW_PASSWORD = "a-freshly-chosen-password";

let fixture: IntegrationFixture;
let sendMail: ReturnType<typeof vi.fn>;
/** What the database said about the target's address at the moment each mail went out. */
let addressAtSend: Array<string | null>;
let sentMessages: Array<Record<string, unknown>>;
let currentTargetId: string | null;

beforeEach(async () => {
  fixture = await createIntegrationFixture("admin-set-address-1869");
  addressAtSend = [];
  sentMessages = [];
  currentTargetId = null;
  sendMail = vi.fn(async (message: Record<string, unknown>) => {
    sentMessages.push(message);
    if (currentTargetId) {
      const [row] = await getDb().select({ index: users.emailIndex }).from(users).where(eq(users.id, currentTargetId));
      addressAtSend.push(row?.index ?? null);
    }
    return { messageId: "<fake@orbit-test.example>" };
  });
  mocks.createTransport.mockReset();
  mocks.createTransport.mockImplementation(() => ({ ...fakeTransporter(), sendMail }));
});

afterEach(async () => {
  await clearMailState();
  await fixture.cleanup();
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

async function adminWithPassword(): Promise<IntegrationSession> {
  const admin = await fixture.session("admin");
  await getDb().insert(localCredentials).values({ userId: admin.userId, passwordHash: await hashPassword(ADMIN_PASSWORD) });
  return admin;
}

/**
 * A local account (no provider identity) with a live setup link, made the way
 * the application makes one. `token` is the link as the recipient reads it.
 */
async function localTarget(address: string, displayName = "Target Person") {
  const sent: SmtpNotification[] = [];
  const created = await createLocalUserAndSendSetupLink(
    fixture.users.admin.id,
    { email: address, displayName },
    { mailer: { async sendEmail(notification: SmtpNotification) { sent.push(notification); } } },
  );
  const link = /https?:\/\/\S*\/setup\/(\S+)/u.exec(sent.at(-1)?.text ?? "");
  if (!link) throw new Error("the setup mail carried no link");
  return { id: created.user.id, address, token: decodeURIComponent(link[1]) };
}

/** What #1604 left behind: ciphertext that no longer opens, index intact. */
async function damageAddress(userId: string): Promise<void> {
  const [row] = await getDb().select({ enc: users.emailEnc }).from(users).where(eq(users.id, userId));
  await getDb().update(users).set({ emailEnc: damageEnvelope(row.enc as string) }).where(eq(users.id, userId));
}

async function put(
  session: IntegrationSession,
  userId: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const response = await callRouteForSession(setAddress, session, {
    url: `${ORIGIN}/api/admin/users/${userId}/email`,
    params: { userId },
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.clone().json()) as Record<string, unknown>, response };
}

const errorCode = (body: Record<string, unknown>) => (body.error as { code: string } | undefined)?.code;

/** The route answers the refreshed user row; tolerate it being wrapped as `{ user }`. */
function answeredUser(body: Record<string, unknown>): Record<string, unknown> {
  return (body.user as Record<string, unknown> | undefined) ?? body;
}

async function listedUser(admin: IntegrationSession, userId: string) {
  const response = await callRouteForSession(listUsers, admin, { url: `${ORIGIN}/api/admin/users`, method: "GET" });
  const list = (await response.json()) as { users: Array<Record<string, unknown>> };
  return list.users.find((entry) => entry.id === userId);
}

async function stored(userId: string) {
  const [row] = await getDb()
    .select({ enc: users.emailEnc, index: users.emailIndex, verified: users.emailVerified })
    .from(users).where(eq(users.id, userId));
  return row;
}

async function indexOf(address: string): Promise<string | null> {
  return (await accountAddressColumns(fixture.users.admin.id, address)).emailIndex;
}

async function unchanged(userId: string, before: Awaited<ReturnType<typeof stored>>) {
  expect(await stored(userId)).toEqual(before);
}

async function auditFor(userId: string) {
  const rows = await getDb().select({ action: auditLog.action, changes: auditLog.changes, actorUserId: auditLog.actorUserId })
    .from(auditLog).where(eq(auditLog.action, "email_address_set"));
  return rows.filter((row) => (row.changes as { userId?: string } | null)?.userId === userId);
}

async function redeem(token: string) {
  const response = await callRoute(consumeSetup, {
    url: `${ORIGIN}/api/auth/local/setup`,
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ token, password: NEW_PASSWORD }),
  });
  return { status: response.status, body: (await response.clone().json()) as Record<string, unknown> };
}

describe("PUT /api/admin/users/{userId}/email: the refusals", () => {
  it("refuses a caller who is not an administrator, and writes nothing", async () => {
    const target = await localTarget("refuse-nonadmin@example.invalid");
    const before = await stored(target.id);
    const member = await fixture.session("member");
    const refused = await put(member, target.id, { email: "elsewhere@example.invalid" });
    expect(refused.status).toBe(403);
    await unchanged(target.id, before);
    // The twin: the same request from an administrator succeeds.
    const admin = await adminWithPassword();
    const ok = await put(admin, target.id, { email: "elsewhere@example.invalid", currentPassword: ADMIN_PASSWORD });
    expect(ok.status).toBe(200);
  }, 30_000);

  it("refuses a missing, wrong, or wrong-intent step-up, and accepts email_address_set", async () => {
    const target = await localTarget("refuse-stepup@example.invalid");
    const before = await stored(target.id);
    // An OIDC-only administrator (no local credential) is challenged with a proof cookie.
    const admin = await fixture.session("admin");
    const config = getAuthConfig();
    const body = { email: "stepup-new@example.invalid" };

    const none = await put(admin, target.id, body);
    expect(none.status).toBe(403);
    expect(errorCode(none.body)).toBe("recent_authentication_required");

    // A proof taken for the setup link must not pay for an address change.
    const wrongIntent = await sealStepUpProof(admin.sessionId, "setup_link_issue", config);
    const refused = await put(admin, target.id, body, {
      cookie: `${admin.headers.cookie}; ${stepUpProofCookieName(config)}=${wrongIntent}`,
    });
    expect(refused.status).toBe(403);
    expect(errorCode(refused.body)).toBe("recent_authentication_required");
    await unchanged(target.id, before);

    const proof = await sealStepUpProof(admin.sessionId, "email_address_set" as never, config);
    const ok = await put(admin, target.id, body, {
      cookie: `${admin.headers.cookie}; ${stepUpProofCookieName(config)}=${proof}`,
    });
    expect(ok.status).toBe(200);
    expect((await stored(target.id)).index).toBe(await indexOf("stepup-new@example.invalid"));
  }, 30_000);

  it("refuses a wrong current password for an administrator who has one", async () => {
    const target = await localTarget("refuse-password@example.invalid");
    const before = await stored(target.id);
    const admin = await adminWithPassword();
    const refused = await put(admin, target.id, { email: "pw-new@example.invalid", currentPassword: "not-the-password" });
    expect(refused.status).toBe(403);
    expect(errorCode(refused.body)).toBe("recent_authentication_required");
    await unchanged(target.id, before);
  }, 30_000);

  it("refuses an address that is not valid or is too long with 400 invalid_request", async () => {
    const target = await localTarget("refuse-bad@example.invalid");
    const before = await stored(target.id);
    const admin = await adminWithPassword();
    for (const email of ["not-an-address", "", "   ", `${"a".repeat(310)}@example.invalid`]) {
      const refused = await put(admin, target.id, { email, currentPassword: ADMIN_PASSWORD });
      expect(refused.status, JSON.stringify(email)).toBe(400);
      expect(errorCode(refused.body)).toBe("invalid_request");
    }
    await unchanged(target.id, before);
    // The twin: a valid address, with surrounding spaces trimmed, is taken.
    const ok = await put(admin, target.id, { email: "  Good.Address@Example.Invalid  ", currentPassword: ADMIN_PASSWORD });
    expect(ok.status).toBe(200);
    // The index comes from the lower-cased address, as account creation does it.
    expect((await stored(target.id)).index).toBe(await indexOf("good.address@example.invalid"));
    expect(String((await listedUser(admin, target.id))?.email).toLowerCase()).toBe("good.address@example.invalid");
  }, 30_000);

  it("answers 422 invalid_identifier for a userId that is not a UUID, and 404 user_not_found for an unknown one", async () => {
    const admin = await adminWithPassword();
    const bad = await put(admin, "not-a-uuid", { email: "x@example.invalid", currentPassword: ADMIN_PASSWORD });
    expect(bad.status).toBe(422);
    expect(errorCode(bad.body)).toBe("invalid_identifier");
    const missingId = "00000000-0000-4000-8000-000000000000";
    const missing = await put(admin, missingId, { email: "x@example.invalid", currentPassword: ADMIN_PASSWORD });
    expect(missing.status).toBe(404);
    expect(errorCode(missing.body)).toBe("user_not_found");
  }, 30_000);

  it("answers 503 metadata_locked when the instance key is unavailable, and writes nothing", async () => {
    const target = await localTarget("refuse-locked@example.invalid");
    const before = await stored(target.id);
    const admin = await adminWithPassword();
    const unlock = lockTheInstance();
    try {
      const refused = await put(admin, target.id, { email: "locked-new@example.invalid", currentPassword: ADMIN_PASSWORD });
      expect(refused.status).toBe(503);
      expect(errorCode(refused.body)).toBe("metadata_locked");
    } finally {
      unlock();
    }
    await unchanged(target.id, before);
    // The twin: with the key back, the same request succeeds.
    const ok = await put(admin, target.id, { email: "locked-new@example.invalid", currentPassword: ADMIN_PASSWORD });
    expect(ok.status).toBe(200);
  }, 30_000);

  it("answers 409 email_in_use when another account holds the address, in any letter case, and writes nothing", async () => {
    const target = await localTarget("refuse-inuse@example.invalid");
    const before = await stored(target.id);
    const admin = await adminWithPassword();
    const holder = fixture.users.member.email;
    for (const email of [holder, holder.toUpperCase()]) {
      const refused = await put(admin, target.id, { email, currentPassword: ADMIN_PASSWORD });
      expect(refused.status, email).toBe(409);
      expect(errorCode(refused.body)).toBe("email_in_use");
    }
    await unchanged(target.id, before);
  }, 30_000);

  it("does not count the target's own row as a clash: a damaged row can be given its own index again", async () => {
    const target = await localTarget("own-row@example.invalid");
    await damageAddress(target.id);
    const before = await stored(target.id);
    const admin = await adminWithPassword();
    const ok = await put(admin, target.id, { email: "own-row@example.invalid", currentPassword: ADMIN_PASSWORD });
    expect(ok.status).toBe(200);
    const after = await stored(target.id);
    expect(after.index).toBe(before.index);
    expect(after.enc).not.toBe(before.enc);
    expect((await listedUser(admin, target.id))?.email).toBe("own-row@example.invalid");
  }, 30_000);

  it("answers 409 address_from_provider for an account with a linked provider identity, and writes nothing", async () => {
    // Fixture members carry an external_identities row.
    const memberId = fixture.users.member.id;
    const before = await stored(memberId);
    const admin = await adminWithPassword();
    const refused = await put(admin, memberId, { email: "from-provider@example.invalid", currentPassword: ADMIN_PASSWORD });
    expect(refused.status).toBe(409);
    expect(errorCode(refused.body)).toBe("address_from_provider");
    await unchanged(memberId, before);
    expect(await auditFor(memberId)).toEqual([]);
  }, 30_000);
});

describe("PUT /api/admin/users/{userId}/email: the success path", () => {
  it("replaces an unreadable address, answers the refreshed row, audits it without any address, and sends no setup link", async () => {
    const admin = await adminWithPassword();
    await setUpSending(admin.userId);
    const target = await localTarget("was-unreadable@example.invalid");
    await damageAddress(target.id);
    const [{ verified: verifiedBefore }] = [await stored(target.id)];
    sendMail.mockClear();
    sentMessages.length = 0;

    const ok = await put(admin, target.id, { email: "Fresh@Example.Invalid", currentPassword: ADMIN_PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.response.headers.get("cache-control")).toBe("no-store");

    const after = await stored(target.id);
    expect(after.index).toBe(await indexOf("fresh@example.invalid"));
    expect(after.verified).toBe(verifiedBefore);
    const row = await listedUser(admin, target.id);
    expect(String(row?.email).toLowerCase()).toBe("fresh@example.invalid");
    expect(row?.metadataStatus).toBeUndefined();
    // The answer is the row as the list shapes it (JSON round trip drops undefined).
    expect(answeredUser(ok.body)).toEqual(JSON.parse(JSON.stringify(row)));

    const audit = await auditFor(target.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].actorUserId).toBe(admin.userId);
    expect(audit[0].changes).toEqual({ userId: target.id, previous: "unreadable" });
    const everything = JSON.stringify(await getDb().select().from(auditLog));
    expect(everything.toLowerCase()).not.toContain("fresh@example.invalid");
    expect(everything.toLowerCase()).not.toContain("was-unreadable@example.invalid");

    // No readable old address: nobody to notify, and no setup link goes out.
    expect(sendMail).not.toHaveBeenCalled();
    expect(ok.body.noticeError ?? null).toBeNull();
    expect(JSON.stringify(ok.body)).not.toContain("/setup/");
  }, 30_000);

  it("then lets the administrator send a setup link, which was refused 409 while the address was unreadable", async () => {
    const admin = await adminWithPassword();
    await setUpSending(admin.userId);
    const target = await localTarget("link-after@example.invalid");
    await damageAddress(target.id);

    const before = await callRouteForSession(reissueSetupLink, admin, {
      url: `${ORIGIN}/api/admin/users/${target.id}/setup-link`,
      params: { userId: target.id },
      method: "POST",
      body: JSON.stringify({ currentPassword: ADMIN_PASSWORD }),
    });
    expect(before.status).toBe(409);

    expect((await put(admin, target.id, { email: "link-after-new@example.invalid", currentPassword: ADMIN_PASSWORD })).status).toBe(200);
    sendMail.mockClear();
    const after = await callRouteForSession(reissueSetupLink, admin, {
      url: `${ORIGIN}/api/admin/users/${target.id}/setup-link`,
      params: { userId: target.id },
      method: "POST",
      body: JSON.stringify({ currentPassword: ADMIN_PASSWORD }),
    });
    expect(after.status).toBe(200);
    const answer = (await after.json()) as { sentTo: string; sendError: string | null };
    expect(answer.sentTo).toBe("link-after-new@example.invalid");
    expect(answer.sendError).toBeNull();
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0]).toMatchObject({ to: "link-after-new@example.invalid" });
  }, 30_000);

  it("retires the live setup link, so the old link stops working", async () => {
    const admin = await adminWithPassword();
    const target = await localTarget("setup-retired@example.invalid");
    const live = await getDb().select({ id: credentialSetupTokens.id }).from(credentialSetupTokens)
      .where(and(eq(credentialSetupTokens.userId, target.id), isNull(credentialSetupTokens.consumedAt)));
    expect(live).toHaveLength(1);

    expect((await put(admin, target.id, { email: "setup-retired-new@example.invalid", currentPassword: ADMIN_PASSWORD })).status).toBe(200);

    const refused = await redeem(target.token);
    expect(refused.status).toBe(400);
    expect(errorCode(refused.body)).toBe("setup_token_invalid");
    expect(await getDb().select().from(localCredentials).where(eq(localCredentials.userId, target.id))).toEqual([]);
  }, 30_000);

  it("retires a live recovery link too", async () => {
    const admin = await adminWithPassword();
    const target = await localTarget("recovery-retired@example.invalid");
    await getDb().insert(localCredentials).values({ userId: target.id, passwordHash: await hashPassword("an-older-password") });
    const captured: SmtpNotification[] = [];
    const delivery = await sendSetupLink(admin.userId, target.id, {
      mailer: { async sendEmail(notification: SmtpNotification) { captured.push(notification); } },
    });
    expect(delivery.sendError).toBeNull();
    const link = /https?:\/\/\S*\/setup\/(\S+)/u.exec(captured.at(-1)?.text ?? "");
    const recoveryToken = decodeURIComponent(link![1]);
    const [liveRecovery] = await getDb().select({ purpose: credentialSetupTokens.purpose }).from(credentialSetupTokens)
      .where(and(eq(credentialSetupTokens.userId, target.id), isNull(credentialSetupTokens.consumedAt)));
    expect(liveRecovery.purpose).toBe("recovery");

    expect((await put(admin, target.id, { email: "recovery-retired-new@example.invalid", currentPassword: ADMIN_PASSWORD })).status).toBe(200);

    const refused = await redeem(recoveryToken);
    expect(refused.status).toBe(400);
    expect(errorCode(refused.body)).toBe("setup_token_invalid");
  }, 30_000);

  it("expires the account's pending sign-in approvals without denying them, and leaves other accounts' alone", async () => {
    const admin = await adminWithPassword();
    const target = await localTarget("approvals@example.invalid");
    const hour = 60 * 60 * 1000;
    const pending = (userId: string) => ({
      userId, tokenHash: crypto.randomUUID(), claimHash: crypto.randomUUID(), expiresAt: new Date(Date.now() + hour),
    });
    const [mine, theirs] = await getDb().insert(signInApprovals)
      .values([pending(target.id), pending(fixture.users.member.id)])
      .returning({ id: signInApprovals.id });

    expect((await put(admin, target.id, { email: "approvals-new@example.invalid", currentPassword: ADMIN_PASSWORD })).status).toBe(200);

    const [expired] = await getDb().select().from(signInApprovals).where(eq(signInApprovals.id, mine.id));
    // Consumed with no outcome: expired, not denied (no backoff count, no "wasn't me" notice).
    expect(expired.consumedAt).not.toBeNull();
    expect(expired.outcome).toBeNull();
    expect(expired.decidedAt).toBeNull();
    const [other] = await getDb().select().from(signInApprovals).where(eq(signInApprovals.id, theirs.id));
    expect(other.consumedAt).toBeNull();
    expect(other.outcome).toBeNull();
  }, 30_000);

  it("notices the old readable address after commit, never names the new one, and sends no setup link", async () => {
    const admin = await adminWithPassword();
    await setUpSending(admin.userId);
    const target = await localTarget("old-readable@example.invalid");
    currentTargetId = target.id;
    sendMail.mockClear();
    sentMessages.length = 0;
    addressAtSend.length = 0;

    const ok = await put(admin, target.id, { email: "brand-new@example.invalid", currentPassword: ADMIN_PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.noticeError ?? null).toBeNull();

    // Exactly one mail, to the OLD address.
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sentMessages[0]).toMatchObject({ to: "old-readable@example.invalid" });
    // After commit: when the mail left, the new address was already stored.
    expect(addressAtSend).toEqual([await indexOf("brand-new@example.invalid")]);
    // The notice never names the new address, and carries no link.
    const mailText = JSON.stringify(sentMessages[0]).toLowerCase();
    expect(mailText).not.toContain("brand-new@example.invalid");
    expect(mailText).not.toContain("/setup/");
    expect(await auditFor(target.id)).toEqual([
      expect.objectContaining({ changes: { userId: target.id, previous: "readable" } }),
    ]);
  }, 30_000);

  it("keeps the change when the notice cannot be sent, and says why in one bounded word", async () => {
    const admin = await adminWithPassword();
    await setUpSending(admin.userId);
    const target = await localTarget("notice-fails@example.invalid");
    sendMail.mockReset();
    sendMail.mockRejectedValue(Object.assign(new Error("connect refused relay.example"), { code: "ECONNREFUSED" }));

    const ok = await put(admin, target.id, { email: "notice-fails-new@example.invalid", currentPassword: ADMIN_PASSWORD });
    expect(ok.status).toBe(200);
    expect(invitationSendErrors as readonly unknown[]).toContain(ok.body.noticeError);
    expect(JSON.stringify(ok.body)).not.toContain("relay.example");
    expect((await stored(target.id)).index).toBe(await indexOf("notice-fails-new@example.invalid"));
    expect(await auditFor(target.id)).toHaveLength(1);
  }, 30_000);

  it("reports smtp_unconfigured in noticeError when no mail is set up, and still changes the address", async () => {
    const admin = await adminWithPassword();
    const target = await localTarget("no-mail-setup@example.invalid");
    const ok = await put(admin, target.id, { email: "no-mail-setup-new@example.invalid", currentPassword: ADMIN_PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.noticeError).toBe("smtp_unconfigured");
    expect((await stored(target.id)).index).toBe(await indexOf("no-mail-setup-new@example.invalid"));
  }, 30_000);

  it("sends no notice when the old address is the same as the new one", async () => {
    const admin = await adminWithPassword();
    await setUpSending(admin.userId);
    const target = await localTarget("same-address@example.invalid");
    sendMail.mockClear();
    const ok = await put(admin, target.id, { email: "same-address@example.invalid", currentPassword: ADMIN_PASSWORD });
    expect(ok.status).toBe(200);
    expect(sendMail).not.toHaveBeenCalled();
  }, 30_000);

  it("works for a disabled account", async () => {
    const admin = await adminWithPassword();
    const target = await localTarget("disabled-target@example.invalid");
    await getDb().update(users).set({ disabledAt: new Date() }).where(eq(users.id, target.id));
    const ok = await put(admin, target.id, { email: "disabled-target-new@example.invalid", currentPassword: ADMIN_PASSWORD });
    expect(ok.status).toBe(200);
    expect((await stored(target.id)).index).toBe(await indexOf("disabled-target-new@example.invalid"));
  }, 30_000);

  it("changes nothing at all when the transaction's checks fail part-way: a clash leaves links and approvals alone", async () => {
    const admin = await adminWithPassword();
    const target = await localTarget("atomic@example.invalid");
    const [approval] = await getDb().insert(signInApprovals).values({
      userId: target.id, tokenHash: crypto.randomUUID(), claimHash: crypto.randomUUID(), expiresAt: new Date(Date.now() + 3_600_000),
    }).returning({ id: signInApprovals.id });
    const refused = await put(admin, target.id, { email: fixture.users.member.email, currentPassword: ADMIN_PASSWORD });
    expect(refused.status).toBe(409);
    // The link still works and the approval is still pending: nothing was retired.
    const [row] = await getDb().select().from(signInApprovals).where(eq(signInApprovals.id, approval.id));
    expect(row.consumedAt).toBeNull();
    expect((await redeem(target.token)).status).toBe(200);
  }, 30_000);
});
