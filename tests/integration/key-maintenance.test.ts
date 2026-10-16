/**
 * No usable encryption key puts Orbit into maintenance (#1405), against a real
 * PostgreSQL: the API refuses every sign-in and every data route before it
 * reads a credential or a session, health still answers 200 `maintenance`, the
 * door's availability answer names the lock and the one address Orbit can
 * still read, sign-out still works, and the startup self-test finds a key that
 * is not the database's from the database itself.
 *
 * The verdict is held in the process (`src/server/key-state.ts`), so most cases
 * set it with `setKeyStateForTests`, exactly as the server would after its
 * startup self-test. The probe case (29) runs the real self-test against a real
 * wrong key. Sign-out while locked is checked with the cipher really locked too
 * (the key removed from the environment), because that is what makes the
 * provider hand-off impossible, not the verdict.
 *
 * Case numbers are the design's (design-1405 section 9). Case 31 (the bounded
 * log of refused sign-ins) is in tests/unit/api-key-gate.test.mjs, where the
 * clock can be held.
 */
import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  auditLog,
  instanceAuthority,
  instanceContact,
  instanceMaintenance,
  maintenanceUpdates,
  maintenanceWindows,
  metadataDamageSightings,
  metadataKeys,
  sessions,
} from "@/db/schema";
import { sessionCookieName, transactionCookieName } from "@/lib/auth/cookies";
import * as oidc from "@/lib/auth/oidc";
import { createSession } from "@/lib/auth/session";
import { getAuthConfig, resetAuthConfigForTests } from "@/lib/env";
import { log } from "@/lib/logger";
import { deriveDocumentKeyId, getDocumentConfig, resetDocumentConfigForTests } from "@/server/documents/config";
import { openMaintenanceWindow, readMaintenanceState } from "@/server/maintenance";
import { flushMetadataDamageSightings } from "@/server/metadata/damage-sightings";
import { resetMetadataKeyCacheForTests } from "@/server/metadata/keys";
import {
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
  type IntegrationSession,
} from "./support/fixtures";
import { callRoute, callRouteForSession, loadRoute } from "./support/request-event";
import { readSetCookie } from "./support/set-cookie";

/* OIDC is off by default since ADR-0023 §1; the provider routes below are only
   closed by the key if they would otherwise be open, so this file turns it on
   for itself and puts the key back afterwards (as bootstrap.test.ts does). */
const previousOidcKey = process.env.ORBIT_AUTH_OIDC;
process.env.ORBIT_AUTH_OIDC = "true";
resetAuthConfigForTests();

const ORIGIN = "http://127.0.0.1:3000";
const ISSUER = "https://oidc.invalid.example";

const { GET: startLogin } = await loadRoute("auth/login");
const { GET: callback } = await loadRoute("auth/callback");
const { POST: localLogin } = await loadRoute("auth/local/login");
const { POST: localLoginPending } = await loadRoute("auth/local/login/pending");
const { POST: localSetup } = await loadRoute("auth/local/setup");
const { POST: bootstrapClaim } = await loadRoute("auth/bootstrap/claim");
const { POST: bootstrapLocal } = await loadRoute("auth/bootstrap/local");
const { POST: approve } = await loadRoute("auth/approve");
const { GET: sessionStatus } = await loadRoute("auth/session");
const { POST: logout } = await loadRoute("auth/logout");
const { GET: readReminders } = await loadRoute("settings/reminders");
const { GET: adminHealth } = await loadRoute("admin/health");
const { GET: health } = await loadRoute("health");
const { GET: availability } = await loadRoute("auth/availability");

const HELD = "0123456789abcdef01234567";
const STORED = "fedcba9876543210fedcba98";
const UNUSABLE = { verdict: "unusable", reason: "mismatch", heldKeyId: HELD, storedKeyId: STORED } as const;

/* Loaded when a case needs it, so a missing module fails that case with that
   reason instead of keeping the whole file from loading. */
const keyState = () => import("@/server/key-state");
const lock = async () => (await keyState()).setKeyStateForTests(UNUSABLE);
const unlock = async () => (await keyState()).setKeyStateForTests({ verdict: "usable", heldKeyId: getDocumentConfig().keyId });
const probe = async () => (await keyState()).probeEncryptionKey();

beforeEach(() => {
  vi.spyOn(oidc, "discoverProvider").mockResolvedValue({
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/jwks`,
    end_session_endpoint: `${ISSUER}/logout`,
    code_challenge_methods_supported: ["S256"],
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await unlock().catch(() => undefined);
  await getDb().delete(instanceAuthority);
  await getDb().update(instanceMaintenance).set({
    active: false, currentWindowId: null, expectedEndAt: null, version: 1, updatedAt: new Date(),
  });
  await getDb().delete(maintenanceUpdates);
  await getDb().delete(maintenanceWindows);
  await getDb().delete(auditLog).where(inArray(auditLog.entityType, ["instance_maintenance", "maintenance_window"]));
});

afterAll(async () => {
  if (previousOidcKey === undefined) delete process.env.ORBIT_AUTH_OIDC;
  else process.env.ORBIT_AUTH_OIDC = previousOidcKey;
  resetAuthConfigForTests();
  await cleanupIntegrationEnvironment();
});

/** A claimed instance, which is what every real one is once it has been set up. */
async function claimedBy(userId: string): Promise<void> {
  await getDb().insert(instanceAuthority).values({ primaryUserId: userId }).onConflictDoNothing();
}

const sessionCount = async () => (await getDb().select({ id: sessions.id }).from(sessions)).length;

async function refusedAs(response: Response): Promise<void> {
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("retry-after")).toBeNull();
  expect(await response.json()).toEqual({ error: "encryption_key_unavailable" });
}

/** Takes the key away from the process for real, as an instance that has lost its KEK file has. */
function removeTheKeyFromTheEnvironment(): () => void {
  const original = process.env.DOCUMENT_KEK;
  delete process.env.DOCUMENT_KEK;
  resetDocumentConfigForTests();
  resetMetadataKeyCacheForTests();
  return () => {
    if (original === undefined) delete process.env.DOCUMENT_KEK;
    else process.env.DOCUMENT_KEK = original;
    resetDocumentConfigForTests();
    resetMetadataKeyCacheForTests();
  };
}

describe("no sign-in of any kind while Orbit has no usable key (24)", () => {
  const post = (handler: typeof localLogin, path: string) => callRoute(handler, {
    url: `${ORIGIN}${path}`,
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ email: "someone@example.invalid", password: "a-correct-local-password", claim: "AAAA-BBBB-CCCC", token: "x" }),
  });

  it.each([
    ["password sign-in", localLogin, "/api/auth/local/login"],
    ["the emailed sign-in confirmation", localLoginPending, "/api/auth/local/login/pending"],
    ["setting a password from a setup or recovery link", localSetup, "/api/auth/local/setup"],
    ["claiming the instance", bootstrapClaim, "/api/auth/bootstrap/claim"],
    ["the first administrator's local account", bootstrapLocal, "/api/auth/bootstrap/local"],
    ["approving a sign-in from a mailed link", approve, "/api/auth/approve"],
  ])("refuses %s as unavailable, makes no session, and never reaches a credential check", async (_label, handler, path) => {
    await claimedBy((await createIntegrationFixture("key-gate-sign-in")).users.admin.id);
    const logged: string[] = [];
    for (const level of ["info", "warn", "error"] as const) {
      vi.spyOn(log, level).mockImplementation((entry) => { logged.push(String((entry as { event?: string }).event)); });
    }
    await lock();
    const before = await sessionCount();

    await refusedAs(await post(handler as typeof localLogin, path));

    expect(await sessionCount()).toBe(before);
    expect(logged).not.toContain("auth.local");
  });

  it("refuses the provider sign-in start as unavailable", async () => {
    await claimedBy((await createIntegrationFixture("key-gate-oidc-start")).users.admin.id);
    await lock();
    const before = await sessionCount();

    await refusedAs(await callRoute(startLogin, { url: `${ORIGIN}/api/auth/login` }));

    expect(await sessionCount()).toBe(before);
    expect(oidc.discoverProvider).not.toHaveBeenCalled();
  });

  it("sends a provider's return to the error screen and makes no session, even when the person started while the key was fine", async () => {
    await claimedBy((await createIntegrationFixture("key-gate-callback")).users.admin.id);
    const config = getAuthConfig();
    const started = await callRoute(startLogin, { url: `${ORIGIN}/api/auth/login` });
    expect(started.status).toBe(302);
    const transactionCookie = readSetCookie(started, transactionCookieName(config))?.value ?? "";
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state");
    expect(transactionCookie).not.toBe("");
    vi.mocked(oidc.discoverProvider).mockClear();
    const exchange = vi.spyOn(oidc, "completeAuthorization");
    await lock();
    const before = await sessionCount();

    const returned = await callRoute(callback, {
      url: `${ORIGIN}/api/auth/callback?code=provider-code&state=${state}`,
      headers: { cookie: `${transactionCookieName(config)}=${transactionCookie}` },
    });

    expect(returned.status).toBe(303);
    expect(new URL(returned.headers.get("location") ?? "", ORIGIN).pathname).toBe("/auth/error");
    expect(readSetCookie(returned, sessionCookieName(config))?.value ?? "").toBe("");
    expect(await sessionCount()).toBe(before);
    expect(exchange).not.toHaveBeenCalled();
    expect(oidc.discoverProvider).not.toHaveBeenCalled();
  });
});

describe("no data and no existing session while Orbit has no usable key (25)", () => {
  it.each([
    ["the session read", sessionStatus, "/api/auth/session"],
    ["a settings read", readReminders, "/api/settings/reminders"],
    ["an administration read", adminHealth, "/api/admin/health"],
  ])("answers %s as unavailable, for an administrator with a valid session", async (_label, handler, path) => {
    const fixture = await createIntegrationFixture("key-gate-data");
    const admin = await fixture.session("admin");
    await lock();

    await refusedAs(await callRouteForSession(handler, admin, { url: `${ORIGIN}${path}` }));
  });

  it("answers the key, not maintenance, when an operator's window is also open (30)", async () => {
    const fixture = await createIntegrationFixture("key-gate-and-maintenance");
    const member = await fixture.session("member");
    const state = await readMaintenanceState();
    await openMaintenanceWindow(fixture.users.admin.id, state.version, { body: "Planned upgrade underway.", expectedEndAt: null });
    await lock();

    await refusedAs(await callRouteForSession(readReminders, member, { url: `${ORIGIN}/api/settings/reminders` }));
  });
});

describe("a member can still leave (26)", () => {
  const signOut = (session: IntegrationSession) => callRouteForSession(logout, session, {
    url: `${ORIGIN}/api/auth/logout`,
    method: "POST",
    headers: { accept: "application/json" },
  });

  it("ends the session, clears the cookie and sends the browser nowhere", async () => {
    const fixture = await createIntegrationFixture("key-gate-logout");
    const member = await fixture.session("member");
    await lock();

    const response = await signOut(member);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ redirectTo: null });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await getDb().select({ id: sessions.id }).from(sessions).where(eq(sessions.id, member.sessionId))).toHaveLength(0);
  });

  it("does the same for a session that holds a provider ID token, with the key really gone, and calls that locked, not damaged", async () => {
    const fixture = await createIntegrationFixture("key-gate-logout-token");
    const member = await fixture.session("member", { idToken: "header.payload.signature-sentinel" });
    const restore = removeTheKeyFromTheEnvironment();
    try {
      await lock();

      const response = await signOut(member);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ redirectTo: null });
      expect(await getDb().select({ id: sessions.id }).from(sessions).where(eq(sessions.id, member.sessionId))).toHaveLength(0);
      await flushMetadataDamageSightings();
      expect(await getDb().select().from(metadataDamageSightings).where(eq(metadataDamageSightings.rowId, member.sessionId))).toHaveLength(0);
    } finally {
      restore();
    }
  });
});

describe("what the door and the healthcheck are told (27)", () => {
  it("answers health 200 maintenance while locked, even with no operator window", async () => {
    await createIntegrationFixture("key-gate-health");
    await lock();

    const response = await callRoute(health, { url: `${ORIGIN}/api/health` });

    expect(response.status).toBe(200);
    expect((await response.json() as { status: string }).status).toBe("maintenance");
    expect((await readMaintenanceState()).effectivelyActive).toBe(false);
  });

  it("answers availability 200 with the lock named and the public contact address Orbit can still read", async () => {
    await createIntegrationFixture("key-gate-availability");
    /* The address is stored in the clear on purpose (ADR-0024): it is the one
       thing Orbit can still read, and the screen may show it. */
    await getDb().update(instanceContact).set({ publicAddress: "help@example.invalid" });
    await lock();

    const response = await callRoute(availability, { url: `${ORIGIN}/api/auth/availability` });
    const body = await response.json() as { encryptionKey: string; contactAddress: string | null };

    expect(response.status).toBe(200);
    expect(body.encryptionKey).toBe("unusable");
    expect(body.contactAddress).toBe("help@example.invalid");
    expect(JSON.stringify(body)).not.toContain(HELD);
    expect(JSON.stringify(body)).not.toContain(STORED);
    await getDb().update(instanceContact).set({ publicAddress: null });
  });

  it("says usable when the key is", async () => {
    await createIntegrationFixture("key-gate-availability-usable");
    const response = await callRoute(availability, { url: `${ORIGIN}/api/auth/availability` });
    expect((await response.json() as { encryptionKey: string }).encryptionKey).toBe("usable");
  });
});

describe("no session can be made without a key (28)", () => {
  it("refuses at createSession itself, so a route that forgot its wrapper still cannot sign anyone in", async () => {
    const fixture = await createIntegrationFixture("key-gate-create-session");
    await lock();
    const before = await sessionCount();

    const { KeyUnavailableError } = await keyState();
    await expect(createSession(fixture.users.member.id, getAuthConfig())).rejects.toBeInstanceOf(KeyUnavailableError);

    expect(await sessionCount()).toBe(before);
  });

  it("makes one, as ever, when the key is usable", async () => {
    const fixture = await createIntegrationFixture("key-gate-create-session-usable");
    const before = await sessionCount();

    await createSession(fixture.users.member.id, getAuthConfig());

    expect(await sessionCount()).toBe(before + 1);
  });
});

describe("the startup self-test finds a wrong key from the database itself (29)", () => {
  it("says mismatch for a key the database was not written under, changes nothing, and says usable again with the right key", async () => {
    await createIntegrationFixture("key-probe");
    const [instanceRow] = await getDb().select().from(metadataKeys).where(eq(metadataKeys.scope, "instance"));
    expect(instanceRow, "the fixture should have minted the instance key").toBeDefined();
    const original = process.env.DOCUMENT_KEK;
    const heldBefore = getDocumentConfig().keyId;
    expect(instanceRow.keyId).toBe(heldBefore);

    const otherKek = randomBytes(32);
    try {
      process.env.DOCUMENT_KEK = otherKek.toString("hex");
      resetDocumentConfigForTests();
      resetMetadataKeyCacheForTests();

      const verdict = await probe();

      expect(verdict).toMatchObject({
        verdict: "unusable",
        reason: "mismatch",
        heldKeyId: deriveDocumentKeyId(otherKek),
        storedKeyId: heldBefore,
      });
      expect(deriveDocumentKeyId(otherKek)).not.toBe(heldBefore);
      expect(await getDb().select().from(metadataKeys).where(eq(metadataKeys.scope, "instance"))).toEqual([instanceRow]);

      process.env.DOCUMENT_KEK = original;
      resetDocumentConfigForTests();
      resetMetadataKeyCacheForTests();

      expect(await probe()).toEqual({ verdict: "usable", heldKeyId: heldBefore });
      expect(await getDb().select().from(metadataKeys).where(eq(metadataKeys.scope, "instance"))).toEqual([instanceRow]);
    } finally {
      if (original === undefined) delete process.env.DOCUMENT_KEK;
      else process.env.DOCUMENT_KEK = original;
      resetDocumentConfigForTests();
      resetMetadataKeyCacheForTests();
    }
  });

  it("calls the held key's own damaged row a damaged key row, not a wrong key", async () => {
    await createIntegrationFixture("key-probe-damaged");
    const [instanceRow] = await getDb().select().from(metadataKeys).where(eq(metadataKeys.scope, "instance"));
    try {
      await getDb().update(metadataKeys).set({ wrapAuthTag: instanceRow.wrapAuthTag.replace(/^./u, (c) => (c === "A" ? "B" : "A")) })
        .where(eq(metadataKeys.id, instanceRow.id));
      resetMetadataKeyCacheForTests();

      expect(await probe()).toMatchObject({
        verdict: "unusable",
        reason: "key_row_damaged",
        heldKeyId: instanceRow.keyId,
      });
    } finally {
      await getDb().update(metadataKeys).set({ wrapAuthTag: instanceRow.wrapAuthTag }).where(eq(metadataKeys.id, instanceRow.id));
      resetMetadataKeyCacheForTests();
    }
  });

  it("is usable on an instance that has never written an encrypted value: any key is the right one", async () => {
    await createIntegrationFixture("key-probe-fresh");
    const saved = await getDb().select().from(metadataKeys);
    try {
      await getDb().delete(metadataKeys);
      resetMetadataKeyCacheForTests();

      expect(await probe()).toEqual({ verdict: "usable", heldKeyId: getDocumentConfig().keyId });
      expect(await getDb().select().from(metadataKeys)).toEqual([]);
    } finally {
      if (saved.length > 0) await getDb().insert(metadataKeys).values(saved).onConflictDoNothing();
      resetMetadataKeyCacheForTests();
    }
  });

  it("says missing, without asking the database, when there is no key in the environment", async () => {
    await createIntegrationFixture("key-probe-missing");
    const restore = removeTheKeyFromTheEnvironment();
    try {
      expect(await probe()).toMatchObject({ verdict: "unusable", reason: "missing" });
    } finally {
      restore();
    }
  });
});
