import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { localCredentials, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { sealStepUpProof, stepUpProofCookieName } from "@/lib/auth/recent-auth";
import { getAuthConfig } from "@/lib/env";
import { ORIGIN } from "./support/auth";
import {
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
  type IntegrationFixture,
  type IntegrationSession,
} from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

/**
 * GIVING OR REMOVING ADMINISTRATOR ACCESS IS CHALLENGED (#1633, design note
 * "The confirmation"): `PUT /api/admin/users` asks for the actor's recent
 * authentication under the `administrator_set` intent before it calls
 * setInstanceAdministrator, the way the setup link (#1052) and the address
 * change (#1869) do. Written from the note before the check exists.
 *
 * Every refusal is paired with the success it guards, so a refusal that
 * passes because the route refuses everything is caught by its twin.
 * The three guards (primary, last administrator, self) are
 * tests/integration/primary-administrator.test.ts and account-lifecycle.test.ts.
 */

const { PUT: setAdministrator } = await loadRoute("admin/users");

const ADMIN_PASSWORD = "the-administrators-own-password";

let fixture: IntegrationFixture;

beforeEach(async () => {
  fixture = await createIntegrationFixture("admin-set-administrator-1633");
});

afterEach(async () => {
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

async function put(session: IntegrationSession, body: unknown, headers: Record<string, string> = {}) {
  const response = await callRouteForSession(setAdministrator, session, {
    url: `${ORIGIN}/api/admin/users`,
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.clone().json()) as Record<string, unknown> };
}

const errorCode = (body: Record<string, unknown>) => (body.error as { code: string } | undefined)?.code;

async function isAdministrator(userId: string): Promise<boolean> {
  const [row] = await getDb().select({ admin: users.isInstanceAdmin }).from(users).where(eq(users.id, userId));
  return row.admin;
}

/** The proof an OIDC-only administrator brings back from a step-up, as a cookie. */
async function withProof(admin: IntegrationSession, intent: string) {
  const config = getAuthConfig();
  const proof = await sealStepUpProof(admin.sessionId, intent as never, config);
  return { cookie: `${admin.headers.cookie}; ${stepUpProofCookieName(config)}=${proof}` };
}

describe("PUT /api/admin/users: recent authentication (#1633)", () => {
  it("refuses to give administrator access without recent authentication, changes nothing, and gives it with an administrator_set proof", async () => {
    const target = fixture.users.member.id;
    // An OIDC-only administrator (no local credential) is challenged with a proof cookie.
    const admin = await fixture.session("admin");

    const none = await put(admin, { userId: target, administrator: true });
    expect(none.status).toBe(403);
    expect(errorCode(none.body)).toBe("recent_authentication_required");
    expect(await isAdministrator(target)).toBe(false);

    // A proof taken for the setup link must not pay for an elevation.
    const wrongIntent = await put(admin, { userId: target, administrator: true }, await withProof(admin, "setup_link_issue"));
    expect(wrongIntent.status).toBe(403);
    expect(errorCode(wrongIntent.body)).toBe("recent_authentication_required");
    expect(await isAdministrator(target)).toBe(false);

    const ok = await put(admin, { userId: target, administrator: true }, await withProof(admin, "administrator_set"));
    expect(ok.status).toBe(200);
    expect(await isAdministrator(target)).toBe(true);
  }, 30_000);

  it("refuses to remove administrator access without recent authentication, changes nothing, and removes it with an administrator_set proof", async () => {
    const target = fixture.users.owner.id;
    await getDb().update(users).set({ isInstanceAdmin: true }).where(eq(users.id, target));
    const admin = await fixture.session("admin");

    const none = await put(admin, { userId: target, administrator: false });
    expect(none.status).toBe(403);
    expect(errorCode(none.body)).toBe("recent_authentication_required");
    expect(await isAdministrator(target)).toBe(true);

    const ok = await put(admin, { userId: target, administrator: false }, await withProof(admin, "administrator_set"));
    expect(ok.status).toBe(200);
    expect(await isAdministrator(target)).toBe(false);
  }, 30_000);

  it("takes the actor's currentPassword: a wrong one is refused and changes nothing, the right one goes through", async () => {
    const target = fixture.users.member.id;
    const admin = await adminWithPassword();

    const missing = await put(admin, { userId: target, administrator: true });
    expect(missing.status).toBe(403);
    expect(errorCode(missing.body)).toBe("recent_authentication_required");

    const wrong = await put(admin, { userId: target, administrator: true, currentPassword: "not-the-password" });
    expect(wrong.status).toBe(403);
    expect(errorCode(wrong.body)).toBe("recent_authentication_required");
    expect(await isAdministrator(target)).toBe(false);

    const ok = await put(admin, { userId: target, administrator: true, currentPassword: ADMIN_PASSWORD });
    expect(ok.status).toBe(200);
    expect(await isAdministrator(target)).toBe(true);
  }, 30_000);
});
