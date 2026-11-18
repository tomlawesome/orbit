import { createHash } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, credentialSetupTokens, externalIdentities, localCredentials, signInApprovals, users } from "@/db/schema";
import { ACCOUNT_LIFECYCLE_LOCK_KEY } from "@/lib/auth/authority-locks";
import { hashPassword } from "@/lib/auth/password";
import { sealStepUpProof, stepUpProofCookieName } from "@/lib/auth/recent-auth";
import { getAuthConfig } from "@/lib/env";
import { invitationSendErrors } from "@/server/invitations/send";
import { setUserAddress } from "@/server/local-credentials/address";
import { requireInstanceMetadataWriter } from "@/server/metadata/fields";
import { createLocalUserAndSendSetupLink, sendSetupLink } from "@/server/local-credentials/setup-mail";
import { collectSignInApproval, startSignInApproval } from "@/server/sign-in-approvals";
import type { SmtpNotification } from "@/server/notification-worker";
import { ORIGIN } from "./support/auth";
import { deferred } from "./support/concurrency";
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
 * AN ADMINISTRATOR CHANGES THEIR OWN ADDRESS (#1900 findings W-S4, W-S5; design
 * call on #1869, point 3). For the actor's own account the route needs
 * `confirmEmail` (trimmed, case-insensitive match of `email`); a missing or
 * different one is refused 422 `address_confirmation_required` before anything
 * is written. Another user's account needs none. The audit row records `self`.
 *
 * Setup copied from admin-set-address-1869.test.ts, which this file is
 * a sibling of:
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
  fixture = await createIntegrationFixture("admin-own-address-1900");
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
  // A fixture administrator has a provider identity; an address change is for local accounts (409 address_from_provider otherwise).
  await getDb().delete(externalIdentities).where(eq(externalIdentities.userId, admin.userId));
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


const ADMIN_NEW = "own-new@example.invalid";

async function ownState(admin: IntegrationSession) {
  const db = getDb();
  return {
    address: await stored(admin.userId),
    tokens: await db.select().from(credentialSetupTokens).where(eq(credentialSetupTokens.userId, admin.userId)),
    approvals: await db.select().from(signInApprovals).where(eq(signInApprovals.userId, admin.userId)),
  };
}

async function pendingApproval(userId: string) {
  await getDb().insert(signInApprovals).values({
    userId, tokenHash: crypto.randomUUID(), claimHash: crypto.randomUUID(), expiresAt: new Date(Date.now() + 3_600_000),
  });
}

describe("PUT /api/admin/users/{userId}/email: confirming your own address (#1869 point 3)", () => {
  it("refuses 422 address_confirmation_required when confirmEmail is missing, and changes nothing", async () => {
    const admin = await adminWithPassword();
    await pendingApproval(admin.userId);
    const before = await ownState(admin);
    const refused = await put(admin, admin.userId, { email: ADMIN_NEW, currentPassword: ADMIN_PASSWORD });
    expect(refused.status).toBe(422);
    expect(errorCode(refused.body)).toBe("address_confirmation_required");
    expect(await ownState(admin)).toEqual(before);
    expect(await auditFor(admin.userId)).toEqual([]);
  }, 30_000);

  it("refuses 422 address_confirmation_required when confirmEmail differs, and changes nothing", async () => {
    const admin = await adminWithPassword();
    await pendingApproval(admin.userId);
    const before = await ownState(admin);
    const refused = await put(admin, admin.userId, {
      email: ADMIN_NEW, confirmEmail: "own-typo@example.invalid", currentPassword: ADMIN_PASSWORD,
    });
    expect(refused.status).toBe(422);
    expect(errorCode(refused.body)).toBe("address_confirmation_required");
    expect(await ownState(admin)).toEqual(before);
    expect(await auditFor(admin.userId)).toEqual([]);
  }, 30_000);

  it("changes the address when confirmEmail matches apart from case and surrounding spaces, and audits self: true", async () => {
    const admin = await adminWithPassword();
    const ok = await put(admin, admin.userId, {
      email: ADMIN_NEW, confirmEmail: "  Own-NEW@Example.Invalid ", currentPassword: ADMIN_PASSWORD,
    });
    expect(ok.status).toBe(200);
    expect((await stored(admin.userId)).index).toBe(await indexOf(ADMIN_NEW));
    const audit = await auditFor(admin.userId);
    expect(audit).toHaveLength(1);
    expect(audit[0].changes).toMatchObject({ userId: admin.userId, self: true });
  }, 30_000);

  it("needs no confirmEmail for another user's account (status 200 today), and audits self: false", async () => {
    const admin = await adminWithPassword();
    const target = await localTarget("other-account@example.invalid");
    const ok = await put(admin, target.id, { email: "other-new@example.invalid", currentPassword: ADMIN_PASSWORD });
    expect(ok.status).toBe(200);
    const audit = await auditFor(target.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].changes).toMatchObject({ userId: target.id, self: false });
  }, 30_000);
});
