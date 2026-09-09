import { inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, externalIdentities, instanceAuthority, userPreferences, users } from "@/db/schema";
import {
  generateClaim,
  hasActiveClaim,
  printClaimNotice,
  setActiveClaimForTests,
} from "@/lib/auth/bootstrap";
import { provisionIdentity } from "@/lib/auth/provision";
import type { VerifiedIdentity } from "@/lib/auth/oidc";
import { getAuthConfig, resetAuthConfigForTests } from "@/lib/env";
import { cleanupIntegrationEnvironment } from "./support/fixtures";
import { callRoute, loadRoute } from "./support/request-event";
import { readSetCookie } from "./support/set-cookie";

/* OIDC is off by default since ADR-0023 §1, and the run's environment
   (scripts/test-integration.mjs) leaves it that way. These journeys are about
   the claim standing in front of the provider, so this file — and only this
   file — turns the provider on for itself and puts the key back afterwards. */
const previousOidcKey = process.env.ORBIT_AUTH_OIDC;
process.env.ORBIT_AUTH_OIDC = "true";
resetAuthConfigForTests();

const { GET: startLogin } = await loadRoute("auth/login");
const { POST: claimInstance } = await loadRoute("auth/bootstrap/claim");
const { GET: readAvailability } = await loadRoute("auth/availability");

const ISSUER = "https://oidc.invalid.example";
const ORIGIN = "http://127.0.0.1:3000";
const createdUsers: string[] = [];

function identity(label: string, email = `${label}@bootstrap.invalid`): VerifiedIdentity {
  return {
    issuer: ISSUER,
    subject: `bootstrap-${label}-${Math.random().toString(36).slice(2)}`,
    email,
    emailVerified: true,
    displayName: `Bootstrap ${label}`,
    avatarUrl: null,
  };
}

async function claimRequest(claim: string, cookie?: string): Promise<Response> {
  return callRoute(claimInstance, {
    url: `${ORIGIN}/api/auth/bootstrap/claim`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ claim }),
  });
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.clone().json()) as { error?: { code?: string } };
  return body.error?.code ?? "";
}

async function countUsers(): Promise<number> {
  return (await getDb().select({ id: users.id }).from(users)).length;
}

/** A user made the way `provisionIdentity` would, for the "already taken" case. */
async function seedUser(email: string): Promise<string> {
  const [user] = await getDb().insert(users).values({
    email,
    emailVerified: true,
    displayName: "Existing account",
  }).returning({ id: users.id });
  await getDb().insert(userPreferences).values({ userId: user.id });
  createdUsers.push(user.id);
  return user.id;
}

beforeAll(async () => {
  await getDb().delete(instanceAuthority);
});

/* The authority row is a database-wide singleton and every journey here writes
   users, so each one hands the next an unclaimed, empty instance. */
afterEach(async () => {
  setActiveClaimForTests(undefined);
  const db = getDb();
  await db.delete(instanceAuthority);
  await db.delete(auditLog);
  const created = await db.select({ id: users.id }).from(users);
  const ids = [...new Set([...createdUsers, ...created.map((row) => row.id)])];
  if (ids.length > 0) await db.delete(users).where(inArray(users.id, ids));
  createdUsers.length = 0;
});

afterAll(async () => {
  if (previousOidcKey === undefined) delete process.env.ORBIT_AUTH_OIDC;
  else process.env.ORBIT_AUTH_OIDC = previousOidcKey;
  await cleanupIntegrationEnvironment();
});

describe("an unclaimed instance (ADR-0022)", () => {
  it("refuses to start a provider sign-in without the claim cookie, and creates nobody", async () => {
    const before = await countUsers();

    const response = await callRoute(startLogin, { url: `${ORIGIN}/api/auth/login` });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("bootstrap_required");
    expect(await countUsers()).toBe(before);

    // The engine refuses the same thing from underneath the route, so a
    // second caller cannot reach provisioning by another road.
    await expect(provisionIdentity(identity("uninvited"))).rejects.toMatchObject({
      code: "bootstrap_required",
      status: 403,
    });
    expect(await countUsers()).toBe(before);
  });

  it("answers a wrong code with the generic refusal and mints nothing", async () => {
    setActiveClaimForTests(generateClaim());
    const response = await claimRequest("AAAA-BBBB-CCCC");
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("bootstrap_invalid");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("says so before a code exists, so a restarted instance cannot be claimed with silence", async () => {
    setActiveClaimForTests(undefined);
    const response = await claimRequest("AAAA-BBBB-CCCC");
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("bootstrap_unavailable");
  });

  it("accepts the printed code, keeps it out of the answer, and opens the provider door", async () => {
    const claim = generateClaim();
    setActiveClaimForTests(claim);

    // Typed as an operator would: lower case, spaced rather than hyphenated.
    const accepted = await claimRequest(claim.display.toLowerCase().replaceAll("-", " "));
    expect(accepted.status).toBe(200);
    const body = await accepted.text();
    expect(body).not.toContain(claim.normalised);
    expect(body).not.toContain(claim.display);
    const cookie = readSetCookie(accepted, "orbit-claim");
    expect(cookie).toBeDefined();
    expect(cookie?.maxAge).toBe(300);
    expect(cookie?.attributes).toContain("HttpOnly");
    expect(cookie?.value).not.toContain(claim.normalised);

    /* With the cookie the request reaches the provider, which does not exist
       here: `discovery_failed` is the proof that the claim gate let it by.
       Discovery is stubbed rather than attempted so this asserts the gate and
       never a name resolver. */
    vi.stubGlobal("fetch", () => Promise.reject(new Error("no provider in this suite")));
    try {
      const started = await callRoute(startLogin, {
        url: `${ORIGIN}/api/auth/login`,
        headers: { cookie: `orbit-claim=${cookie!.value}` },
      });
      expect(await errorCode(started)).toBe("discovery_failed");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses a forged claim cookie at the provider door", async () => {
    const response = await callRoute(startLogin, {
      url: `${ORIGIN}/api/auth/login`,
      headers: { cookie: "orbit-claim=not-a-sealed-proof" },
    });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("bootstrap_required");
  });

  it("reports itself unclaimed to the signed-out door, and claimed once seated", async () => {
    const before = (await (await callRoute(readAvailability, { url: `${ORIGIN}/api/auth/availability` })).json()) as { claimed: boolean };
    expect(before.claimed).toBe(false);

    const user = await seedUser("seated@bootstrap.invalid");
    await getDb().insert(instanceAuthority).values({ primaryUserId: user });
    const after = (await (await callRoute(readAvailability, { url: `${ORIGIN}/api/auth/availability` })).json()) as { claimed: boolean };
    expect(after.claimed).toBe(true);
  });
});

describe("the claim itself", () => {
  it("seats exactly one primary administrator when claimants race, and refuses the losers", async () => {
    const claimants = [identity("racer-1"), identity("racer-2"), identity("racer-3"), identity("racer-4")];
    const outcomes = await Promise.allSettled(
      claimants.map(async (claimant) => provisionIdentity(claimant, { bootstrap: true })),
    );

    const winners = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const losers = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(claimants.length - 1);
    for (const loser of losers) {
      expect((loser as PromiseRejectedResult).reason).toMatchObject({ code: "bootstrap_claimed", status: 409 });
    }

    const authority = await getDb().select({ primaryUserId: instanceAuthority.primaryUserId }).from(instanceAuthority);
    expect(authority).toHaveLength(1);
    const winner = (winners[0] as PromiseFulfilledResult<{ id: string }>).value;
    expect(authority[0].primaryUserId).toBe(winner.id);
    expect(await countUsers()).toBe(1);

    const [seated] = await getDb().select({ isInstanceAdmin: users.isInstanceAdmin }).from(users);
    expect(seated.isInstanceAdmin).toBe(true);

    /* One audit record, and it names the method and nothing else: no email,
       no token, and above all no claim code (ADR-0022 §1). */
    const audit = await getDb().select({ action: auditLog.action, changes: auditLog.changes }).from(auditLog);
    expect(audit).toEqual([{ action: "instance_claimed", changes: { method: "oidc" } }]);
  });

  it("hands the next arrival an ordinary account, and refuses a claim that arrives late", async () => {
    const first = await provisionIdentity(identity("first"), { bootstrap: true });
    const second = await provisionIdentity(identity("second"));

    const [secondRow] = await getDb()
      .select({ isInstanceAdmin: users.isInstanceAdmin })
      .from(users)
      .where(inArray(users.id, [second.id]));
    expect(secondRow.isInstanceAdmin).toBe(false);
    expect(await getDb().select({ primaryUserId: instanceAuthority.primaryUserId }).from(instanceAuthority))
      .toEqual([{ primaryUserId: first.id }]);

    // A claim cookie that survived the claim buys nothing afterwards.
    await expect(provisionIdentity(identity("late"), { bootstrap: true })).rejects.toMatchObject({
      code: "bootstrap_claimed",
    });
    const claimed = await claimRequest("ANY-CODE-AT-ALL");
    expect(claimed.status).toBe(409);
    expect(await errorCode(claimed)).toBe("bootstrap_claimed");
  });

  it("refuses a new subject whose email already belongs to an account, and creates nothing", async () => {
    await provisionIdentity(identity("holder", "shared@bootstrap.invalid"), { bootstrap: true });
    const before = await countUsers();
    const identitiesBefore = (await getDb().select({ id: externalIdentities.id }).from(externalIdentities)).length;

    // Case is not a way around it: the unique index is on lower(email).
    await expect(provisionIdentity(identity("stranger", "SHARED@bootstrap.invalid"))).rejects.toMatchObject({
      code: "link_required",
      status: 403,
    });
    expect(await countUsers()).toBe(before);
    expect((await getDb().select({ id: externalIdentities.id }).from(externalIdentities)).length).toBe(identitiesBefore);
  });
});

describe("the notice at start-up", () => {
  it("prints the link and the code while unclaimed, and nothing at all once claimed", async () => {
    const unclaimed: string[] = [];
    await printClaimNotice({ write: (line) => unclaimed.push(line) });
    expect(unclaimed).toHaveLength(1);
    expect(hasActiveClaim()).toBe(true);
    const notice = unclaimed[0];
    expect(notice).toContain("Orbit is not yet claimed.");
    expect(notice).toContain(`${getAuthConfig().appUrl.origin}/#claim=`);

    const code = notice.split("#claim=")[1].split(/\s/u)[0];
    // The one place a secret is printed: it must be nowhere else, and in
    // particular not in the operational record that accompanies it.
    const claimed = await claimRequest(code);
    expect(claimed.status).toBe(200);

    const user = await seedUser("notice@bootstrap.invalid");
    await getDb().insert(instanceAuthority).values({ primaryUserId: user });
    const afterClaim: string[] = [];
    await printClaimNotice({ write: (line) => afterClaim.push(line) });
    expect(afterClaim).toEqual([]);
    expect(hasActiveClaim()).toBe(false);
  });
});
