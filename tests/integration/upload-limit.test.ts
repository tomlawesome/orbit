import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import { auditLog, instanceUploadLimit } from "@/db/schema";
import { getAuthConfig } from "@/lib/env";
import { getDocumentConfig } from "@/server/documents/config";
import { readEffectiveUploadLimit } from "@/server/upload-limit";
import {
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
  type IntegrationSession,
} from "./support/fixtures";
import { callRoute, callRouteForSession, loadRoute } from "./support/request-event";

/**
 * The administrator's upload size limit against PostgreSQL (#1285): the real
 * route, the real row and a real session. What this file exists to prove is
 * that only an instance administrator can change the limit — refused on the
 * server, whatever the screen shows — and that a change reaches the limit
 * every upload path reads, with no restart.
 */
const URL_ = "http://127.0.0.1:3000/api/admin/upload-limit";
const MIB = 1_048_576;

const { GET: readLimitRoute, POST: writeLimitRoute } = await loadRoute("admin/upload-limit");

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

type UploadLimit = { maxBytes: number; defaultBytes: number; overrideBytes: number | null; version: number };

async function read(session: IntegrationSession) {
  const response = await callRouteForSession(readLimitRoute, session, { url: URL_ });
  const body = await response.json() as { uploadLimit?: UploadLimit };
  return { status: response.status, uploadLimit: body.uploadLimit ?? null };
}

async function write(session: IntegrationSession, body: unknown) {
  const response = await callRouteForSession(writeLimitRoute, session, { url: URL_, method: "POST", body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as { uploadLimit?: UploadLimit; error?: { code: string } } };
}

/** Back to the configured default, whatever an earlier test left. */
async function reset(admin: IntegrationSession): Promise<UploadLimit> {
  const current = (await read(admin)).uploadLimit!;
  if (current.overrideBytes === null) return current;
  return (await write(admin, { action: "default", expectedVersion: current.version })).body.uploadLimit!;
}

describe("PostgreSQL upload size limit contracts (#1285)", () => {
  it("sets a limit every upload path reads at once, and goes back to the configured default", async () => {
    const fixture = await createIntegrationFixture("upload-limit-journey");
    const admin = await fixture.session("admin");
    const clean = await reset(admin);
    expect(clean.maxBytes).toBe(getDocumentConfig().maxBytes);
    await expect(readEffectiveUploadLimit()).resolves.toBe(getDocumentConfig().maxBytes);

    const lowered = await write(admin, { action: "set", expectedVersion: clean.version, megabytes: 2 });
    expect(lowered.status).toBe(200);
    expect(lowered.body.uploadLimit).toMatchObject({ maxBytes: 2 * MIB, overrideBytes: 2 * MIB });
    await expect(readEffectiveUploadLimit()).resolves.toBe(2 * MIB);

    const back = await write(admin, { action: "default", expectedVersion: lowered.body.uploadLimit!.version });
    expect(back.status).toBe(200);
    expect(back.body.uploadLimit?.overrideBytes).toBeNull();
    await expect(readEffectiveUploadLimit()).resolves.toBe(getDocumentConfig().maxBytes);
  });

  it("refuses a value outside 1 to 100 MB, and the row keeps its version", async () => {
    const fixture = await createIntegrationFixture("upload-limit-bounds");
    const admin = await fixture.session("admin");
    const before = await reset(admin);
    for (const megabytes of [0, 101, 2.5]) {
      const refused = await write(admin, { action: "set", expectedVersion: before.version, megabytes });
      expect(refused.status).toBe(422);
    }
    expect((await read(admin)).uploadLimit).toEqual(before);
  });

  it("refuses a non-administrator, and answers nothing without a session", async () => {
    const fixture = await createIntegrationFixture("upload-limit-refused");
    const admin = await fixture.session("admin");
    const member = await fixture.session("member");
    const before = await reset(admin);

    expect((await read(member)).status).toBe(403);
    const asMember = await write(member, { action: "set", expectedVersion: before.version, megabytes: 1 });
    expect(asMember.status).toBe(403);
    expect(asMember.body.error?.code).toBe("administrator_required");

    const anonymousWrite = await callRoute(writeLimitRoute, {
      url: URL_,
      method: "POST",
      body: JSON.stringify({ action: "set", expectedVersion: before.version, megabytes: 1 }),
      headers: { origin: getAuthConfig().appUrl.origin, "sec-fetch-site": "same-origin" },
    });
    expect(anonymousWrite.status).toBe(401);

    // None of the refused calls changed anything.
    expect((await read(admin)).uploadLimit).toEqual(before);
    await expect(readEffectiveUploadLimit()).resolves.toBe(getDocumentConfig().maxBytes);
  });

  it("refuses a stale version, and audits each change against the row's own id", async () => {
    const fixture = await createIntegrationFixture("upload-limit-audit");
    const admin = await fixture.session("admin");
    const before = await reset(admin);
    const set = await write(admin, { action: "set", expectedVersion: before.version, megabytes: 10 });
    expect(set.status).toBe(200);
    const stale = await write(admin, { action: "set", expectedVersion: before.version, megabytes: 20 });
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe("upload_limit_version_conflict");
    await reset(admin);

    const [row] = await getDb().select({ id: instanceUploadLimit.id }).from(instanceUploadLimit).limit(1);
    const audits = await getDb().select({ action: auditLog.action, householdId: auditLog.householdId, actorUserId: auditLog.actorUserId })
      .from(auditLog).where(eq(auditLog.entityId, row.id));
    // The row is a shared singleton, so earlier tests' administrators have
    // audit entries on it too; this one's own two changes must be there.
    const own = audits.filter((entry) => entry.actorUserId === fixture.users.admin.id);
    expect(own.map((entry) => entry.action)).toEqual(expect.arrayContaining(["instance_upload_limit_set", "instance_upload_limit_reset"]));
    expect(audits.every((entry) => entry.householdId === null)).toBe(true);
  });
});
