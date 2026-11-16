import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import { auditLog } from "@/db/schema";
import {
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
  type IntegrationSession,
} from "./support/fixtures";
import { callRoute, callRouteForSession, loadRoute } from "./support/request-event";
import { getAuthConfig } from "@/lib/env";

/**
 * The mail size limit against PostgreSQL (#1388, design note 54592): the real
 * route, the real row and real sessions. The limit is its own setting, 1 to 50
 * MiB, default 25 MiB; only an administrator changes it; a stale version is a
 * 409; the same set sent twice at once has one winner.
 */
const URL_ = "http://127.0.0.1:3000/api/admin/mail-limit";
const MIB = 1_048_576;

// Loaded inside the tests, so a missing route fails each case rather than the file.
const routes = async () => loadRoute("admin/mail-limit");

type MailLimit = {
  maxBytes: number; defaultBytes: number; overrideBytes: number | null;
  minBytes: number; ceilingBytes: number; version: number;
};
type Body = { mailLimit?: MailLimit; error?: { code: string } };

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

async function read(session: IntegrationSession) {
  const { GET } = await routes();
  const response = await callRouteForSession(GET, session, { url: URL_ });
  const body = await response.json() as Body;
  return { status: response.status, mailLimit: body.mailLimit ?? null };
}

async function write(session: IntegrationSession, body: unknown) {
  const { POST } = await routes();
  const response = await callRouteForSession(POST, session, { url: URL_, method: "POST", body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Body };
}

/** Back to the default, whatever an earlier test left. */
async function reset(admin: IntegrationSession): Promise<MailLimit> {
  const current = (await read(admin)).mailLimit!;
  if (current.overrideBytes === null) return current;
  return (await write(admin, { action: "default", expectedVersion: current.version })).body.mailLimit!;
}

describe("PostgreSQL mail size limit contracts (#1388)", () => {
  it("exports the 1 to 50 MiB range with a 25 MiB default as code constants", async () => {
    const module = await import("@/server/mail-limit");
    expect(module.MAIL_LIMIT_FLOOR).toBe(1 * MIB);
    expect(module.MAIL_LIMIT_CEILING).toBe(50 * MIB);
    expect(module.MAIL_LIMIT_DEFAULT).toBe(25 * MIB);
  });

  it("reads 25 MiB when nothing is set, and the settings payload carries the whole picture", async () => {
    const fixture = await createIntegrationFixture("mail-limit-payload");
    const admin = await fixture.session("admin");
    const clean = await reset(admin);
    expect(clean).toMatchObject({
      maxBytes: 25 * MIB, defaultBytes: 25 * MIB, overrideBytes: null, minBytes: 1 * MIB, ceilingBytes: 50 * MIB,
    });
    expect(clean.version).toBeGreaterThanOrEqual(1);
    const { readEffectiveMailLimit } = await import("@/server/mail-limit");
    await expect(readEffectiveMailLimit()).resolves.toBe(25 * MIB);
  });

  it("round-trips a limit across the range, applies it at once, and goes back to the default", async () => {
    const fixture = await createIntegrationFixture("mail-limit-journey");
    const admin = await fixture.session("admin");
    const { readEffectiveMailLimit } = await import("@/server/mail-limit");
    let current = await reset(admin);
    for (const megabytes of [1, 7, 50]) {
      const set = await write(admin, { action: "set", expectedVersion: current.version, megabytes });
      expect(set.status).toBe(200);
      expect(set.body.mailLimit).toMatchObject({ maxBytes: megabytes * MIB, overrideBytes: megabytes * MIB });
      expect(set.body.mailLimit!.version).toBeGreaterThan(current.version);
      await expect(readEffectiveMailLimit()).resolves.toBe(megabytes * MIB);
      current = set.body.mailLimit!;
    }
    const back = await write(admin, { action: "default", expectedVersion: current.version });
    expect(back.status).toBe(200);
    expect(back.body.mailLimit).toMatchObject({ maxBytes: 25 * MIB, overrideBytes: null });
    await expect(readEffectiveMailLimit()).resolves.toBe(25 * MIB);
  });

  it("refuses 0, 51 and fractional megabytes as 422, and the row keeps its version", async () => {
    const fixture = await createIntegrationFixture("mail-limit-bounds");
    const admin = await fixture.session("admin");
    const before = await reset(admin);
    for (const megabytes of [0, 51, 100, 2.5]) {
      const refused = await write(admin, { action: "set", expectedVersion: before.version, megabytes });
      expect(refused.status).toBe(422);
    }
    expect((await read(admin)).mailLimit).toEqual(before);
  });

  it("refuses a value out of range at the server with mail_limit_out_of_range (422)", async () => {
    const fixture = await createIntegrationFixture("mail-limit-server-range");
    const admin = await fixture.session("admin");
    const before = await reset(admin);
    const { setMailLimit } = await import("@/server/mail-limit");
    for (const bytes of [MIB - 1, 50 * MIB + 1]) {
      await expect(setMailLimit(fixture.users.admin.id, before.version, bytes))
        .rejects.toMatchObject({ code: "mail_limit_out_of_range", status: 422 });
    }
    expect((await read(admin)).mailLimit).toEqual(before);
  });

  it("refuses a non-administrator, and answers nothing without a session", async () => {
    const fixture = await createIntegrationFixture("mail-limit-refused");
    const admin = await fixture.session("admin");
    const member = await fixture.session("member");
    const before = await reset(admin);

    expect((await read(member)).status).toBe(403);
    const asMember = await write(member, { action: "set", expectedVersion: before.version, megabytes: 1 });
    expect(asMember.status).toBe(403);
    expect(asMember.body.error?.code).toBe("administrator_required");

    const { POST } = await routes();
    const anonymous = await callRoute(POST, {
      url: URL_,
      method: "POST",
      body: JSON.stringify({ action: "set", expectedVersion: before.version, megabytes: 1 }),
      headers: { origin: getAuthConfig().appUrl.origin, "sec-fetch-site": "same-origin" },
    });
    expect(anonymous.status).toBe(401);
    expect((await read(admin)).mailLimit).toEqual(before);
  });

  it("refuses a stale version with mail_limit_version_conflict (409), and audits each change", async () => {
    const fixture = await createIntegrationFixture("mail-limit-conflict");
    const admin = await fixture.session("admin");
    const before = await reset(admin);
    const set = await write(admin, { action: "set", expectedVersion: before.version, megabytes: 10 });
    expect(set.status).toBe(200);
    const stale = await write(admin, { action: "set", expectedVersion: before.version, megabytes: 20 });
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe("mail_limit_version_conflict");
    expect((await read(admin)).mailLimit?.overrideBytes).toBe(10 * MIB);
    await reset(admin);

    const audits = await getDb().select({ action: auditLog.action, actorUserId: auditLog.actorUserId, householdId: auditLog.householdId })
      .from(auditLog).where(eq(auditLog.actorUserId, fixture.users.admin.id));
    const own = audits.map((entry) => entry.action);
    expect(own).toEqual(expect.arrayContaining(["instance_mail_limit_set", "instance_mail_limit_reset"]));
    expect(audits.filter((entry) => entry.action.startsWith("instance_mail_limit")).every((entry) => entry.householdId === null)).toBe(true);
  });

  it("lets one of two identical sets sent at once win, and gives the other the version conflict", async () => {
    const fixture = await createIntegrationFixture("mail-limit-double-submit");
    const admin = await fixture.session("admin");
    const before = await reset(admin);
    const request = { action: "set", expectedVersion: before.version, megabytes: 12 };

    const [first, second] = await Promise.all([write(admin, request), write(admin, request)]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const loser = first.status === 409 ? first : second;
    expect(loser.body.error?.code).toBe("mail_limit_version_conflict");
    const after = (await read(admin)).mailLimit!;
    expect(after.overrideBytes).toBe(12 * MIB);
    // One write landed: the version moved once.
    expect(after.version).toBe(before.version + 1);
    await reset(admin);
  });

  it("leaves the upload limit alone when the mail limit changes", async () => {
    const fixture = await createIntegrationFixture("mail-limit-independent");
    const admin = await fixture.session("admin");
    const { readEffectiveUploadLimit } = await import("@/server/upload-limit");
    const uploadBefore = await readEffectiveUploadLimit();
    const before = await reset(admin);
    const set = await write(admin, { action: "set", expectedVersion: before.version, megabytes: 3 });
    expect(set.status).toBe(200);
    await expect(readEffectiveUploadLimit()).resolves.toBe(uploadBefore);
    await reset(admin);
  });
});
