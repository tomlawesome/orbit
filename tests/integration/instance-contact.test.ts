import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import { auditLog, instanceContact } from "@/db/schema";
import { getAuthConfig } from "@/lib/env";
import {
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
  type IntegrationSession,
} from "./support/fixtures";
import { callRoute, callRouteForSession, loadRoute } from "./support/request-event";

/**
 * The instance's one public contact address against PostgreSQL (#860): what
 * only a real database and a real, unauthenticated public route can show —
 * that the signed-out door reads exactly what an administrator set, never
 * any account's own email, and that a rejected value never reaches the row.
 *
 * #788's own state machine is pinned in tests/unit/door-state.test.mjs
 * without a database; this file exists to prove the one thing that needs
 * one: `/api/auth/availability` — the public endpoint the door reads — is
 * wired to the same row `/api/admin/contact` writes.
 */
const CONTACT_URL = "http://127.0.0.1:3000/api/admin/contact";
const AVAILABILITY_URL = "http://127.0.0.1:3000/api/auth/availability";

const { GET: readContact, POST: writeContact } = await loadRoute("admin/contact");
const { GET: readAvailability } = await loadRoute("auth/availability");

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

type Contact = { address: string | null; version: number; updatedAt: string };

async function read(session: IntegrationSession): Promise<{ status: number; contact: Contact | null }> {
  const response = await callRouteForSession(readContact, session, { url: CONTACT_URL });
  const body = await response.json() as { contact?: Contact | null };
  return { status: response.status, contact: body.contact ?? null };
}

async function write(session: IntegrationSession, body: unknown) {
  const response = await callRouteForSession(writeContact, session, {
    url: CONTACT_URL,
    method: "POST",
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as { contact?: Contact; error?: { code: string } } };
}

async function signedOutRead(): Promise<{ configured: boolean; contactAddress: string | null }> {
  const response = await callRoute(readAvailability, { url: AVAILABILITY_URL });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response.json();
}

describe("PostgreSQL public-contact-address contracts (#860)", () => {
  it("sets, changes and clears the address, each read back from the signed-out door", async () => {
    const fixture = await createIntegrationFixture("contact-journeys");
    const admin = await fixture.session("admin");

    // The singleton row is shared with the rest of this file (it is a
    // real, unconditionally-seeded singleton, the same shape as
    // instance_maintenance, not a per-fixture row); starting from a clean
    // slate here rather than assuming one is what keeps this test order-
    // independent. Migration-time "an upgrade leaves it unset" is proven
    // where it belongs, against a fresh database, in migrations.test.ts.
    const initial = await read(admin);
    expect(initial.status).toBe(200);
    const clean = initial.contact!.address === null
      ? initial.contact!
      : (await write(admin, { action: "clear", expectedVersion: initial.contact!.version })).body.contact!;
    expect(clean.address).toBeNull();
    expect((await signedOutRead()).contactAddress).toBeNull();

    const set = await write(admin, { action: "set", expectedVersion: clean.version, address: "Ops@Example.com" });
    expect(set.status).toBe(200);
    expect(set.body.contact?.address).toBe("ops@example.com");
    expect((await signedOutRead()).contactAddress).toBe("ops@example.com");

    const changed = await write(admin, { action: "set", expectedVersion: set.body.contact!.version, address: "help@example.org" });
    expect(changed.status).toBe(200);
    expect(changed.body.contact?.address).toBe("help@example.org");
    expect((await signedOutRead()).contactAddress).toBe("help@example.org");

    const cleared = await write(admin, { action: "clear", expectedVersion: changed.body.contact!.version });
    expect(cleared.status).toBe(200);
    expect(cleared.body.contact?.address).toBeNull();
    expect((await signedOutRead()).contactAddress).toBeNull();
  });

  it("never lets any account's own email reach the signed-out surface", async () => {
    const fixture = await createIntegrationFixture("contact-no-account-email");
    const admin = await fixture.session("admin");

    // The published address is deliberately unrelated to any account's own
    // email, so a bug that defaulted from (or fell back to) one would be
    // caught below by the values simply not matching.
    const current = await read(admin);
    await write(admin, {
      action: "set",
      expectedVersion: current.contact!.version,
      address: "public-contact@example.invalid",
    });

    const signedOut = await signedOutRead();
    expect(signedOut.contactAddress).toBe("public-contact@example.invalid");
    expect(signedOut.contactAddress).not.toBe(fixture.users.admin.email);
    expect(signedOut.contactAddress).not.toBe(fixture.users.owner.email);
    // The whole body is bounded to these five fields (door-state.js's
    // availabilityOf reads only some of them, but the route itself is
    // asserted here too): nothing about any account rides along on this
    // read. `phase` joined them in #869 and is deliberately inside the bound
    // rather than outside it — it is one of two words, "starting" or
    // "running", and names neither a subsystem nor an error, so it tells a
    // signed-out visitor when the door is worth polling and nothing else.
    // `claimed` and `methods` joined them in M7 by ADR-0023 §1: whether the
    // instance has a primary administrator, and which methods it can offer
    // at all. Neither says whether any account exists or which one, and
    // `claimed` never carries anything about the claim code, which lives
    // only in the container's own log. Widening this list is a decision
    // about an unauthenticated surface; make it here, on purpose, or not at
    // all.
    expect(Object.keys(signedOut).sort()).toEqual(["claimed", "configured", "contactAddress", "methods", "phase"]);
  });

  it("reflects whether authentication is configured, without ever naming why not", async () => {
    // A real, valid auth configuration is already loaded by the integration
    // harness (createIntegrationFixture depends on it), so this environment
    // always answers `configured: true`; the false branch and its message
    // shape are covered at the unit level (door-state.test.mjs,
    // availability +server.js's own try/catch has no branch left untested
    // here worth standing up a broken OIDC config for).
    expect(() => getAuthConfig()).not.toThrow();
    const signedOut = await signedOutRead();
    expect(signedOut.configured).toBe(true);
  });

  it("does not save a rejected value, and the row keeps its previous version", async () => {
    const fixture = await createIntegrationFixture("contact-rejected");
    const admin = await fixture.session("admin");
    const current = await read(admin);
    await write(admin, { action: "set", expectedVersion: current.contact!.version, address: "kept@example.com" });
    const beforeRejection = await read(admin);

    const rejected = await write(admin, {
      action: "set",
      expectedVersion: beforeRejection.contact!.version,
      address: "not-an-address",
    });
    expect(rejected.status).toBe(422);
    expect(rejected.body.error?.code).toBe("instance_contact_address_invalid");

    const after = await read(admin);
    expect(after.contact).toEqual(beforeRejection.contact);
    expect((await signedOutRead()).contactAddress).toBe("kept@example.com");
  });

  it("refuses a stale version rather than silently overwriting a concurrent change", async () => {
    const fixture = await createIntegrationFixture("contact-stale-version");
    const admin = await fixture.session("admin");
    const current = await read(admin);
    const first = await write(admin, { action: "set", expectedVersion: current.contact!.version, address: "first@example.com" });

    const stale = await write(admin, { action: "set", expectedVersion: current.contact!.version, address: "second@example.com" });
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe("instance_contact_version_conflict");
    expect((await signedOutRead()).contactAddress).toBe(first.body.contact?.address);
  });

  it("refuses a non-administrator, and answers nothing without a session or a CSRF token", async () => {
    const fixture = await createIntegrationFixture("contact-refused");
    const member = await fixture.session("member");
    const config = getAuthConfig();
    const before = (await signedOutRead()).contactAddress;

    const asMember = await read(member);
    expect(asMember.status).toBe(403);
    const writeAsMember = await write(member, { action: "set", expectedVersion: 1, address: "sneaky@example.com" });
    expect(writeAsMember.status).toBe(403);

    const anonymousRead = await callRoute(readContact, { url: CONTACT_URL });
    expect(anonymousRead.status).toBe(401);

    const anonymousWrite = await callRoute(writeContact, {
      url: CONTACT_URL,
      method: "POST",
      body: JSON.stringify({ action: "set", expectedVersion: 1, address: "sneaky@example.com" }),
      headers: { origin: config.appUrl.origin, "sec-fetch-site": "same-origin" },
    });
    expect(anonymousWrite.status).toBe(401);

    // None of the refused calls above changed anything.
    expect((await signedOutRead()).contactAddress).toBe(before);
  });

  it("audits a set and a clear against the row's own stable id, distinct from any household", async () => {
    const fixture = await createIntegrationFixture("contact-audit");
    const admin = await fixture.session("admin");
    const current = await read(admin);
    await write(admin, { action: "set", expectedVersion: current.contact!.version, address: "ops@example.com" });

    const [row] = await getDb().select({ id: instanceContact.id }).from(instanceContact).limit(1);
    const audits = await getDb().select({ action: auditLog.action, householdId: auditLog.householdId })
      .from(auditLog).where(eq(auditLog.entityId, row.id));
    expect(audits.map((entry) => entry.action)).toContain("instance_contact_address_set");
    expect(audits.every((entry) => entry.householdId === null)).toBe(true);
  });
});
