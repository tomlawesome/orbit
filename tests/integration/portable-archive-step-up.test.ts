/*
 * Writing a household out and bringing an archive in re-challenge the person
 * in front of the screen (#1132, ADR-0023 §5).
 *
 * The fixture's owner signs in through a provider and has no password, so the
 * challenge is a step-up proof cookie. A session on its own is never enough,
 * however new; a proof earned for one archive act does not pay for the other;
 * and somebody who may not do the act at all is told so before being asked to
 * prove anything.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { items, portableArchives } from "@/db/schema";
import { sealStepUpProof, stepUpProofCookieName, type StepUpIntent } from "@/lib/auth/recent-auth";
import { getAuthConfig } from "@/lib/env";
import { encryptPortableArchive } from "@/server/portable-archive";
import {
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
  type IntegrationFixture,
  type IntegrationSession,
} from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

const { POST: createArchive } = await loadRoute("households/[householdId]/portable-archives");
const { POST: importArchive } = await loadRoute("portable-archives/import");

const ORIGIN = "http://127.0.0.1:3000";
const PASSPHRASE = "integration-passphrase";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

async function proofCookie(session: IntegrationSession, intent: StepUpIntent): Promise<string> {
  const config = getAuthConfig();
  const proof = await sealStepUpProof(session.sessionId, intent, config);
  return `${session.headers.cookie}; ${stepUpProofCookieName(config)}=${proof}`;
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.clone().json()) as { error?: { code?: string } };
  return body.error?.code ?? "";
}

function exportAs(session: IntegrationSession, fixture: IntegrationFixture, cookie?: string): Promise<Response> {
  return callRouteForSession(createArchive, session, {
    url: `${ORIGIN}/api/households/${fixture.household.id}/portable-archives`,
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ passphrase: PASSPHRASE, includeDocuments: false }),
    params: { householdId: fixture.household.id },
  });
}

function importAs(session: IntegrationSession, fixture: IntegrationFixture, cookie?: string): Promise<Response> {
  const payload = {
    format: "orbit-portable-archive",
    version: 1,
    household: { name: fixture.household.name },
    sections: [{ id: fixture.section.id, slug: "imported", name: "Imported", icon: "home", accent: "sage", position: 1, visible: true }],
    items: [{ id: randomUUID(), sectionId: fixture.section.id, title: `Imported ${randomUUID()}`, currency: "GBP", status: "active" as const }],
    dueEvents: [],
    reminderRules: [],
    documents: [],
  };
  const archive = encryptPortableArchive(Buffer.from(JSON.stringify(payload)), PASSPHRASE);
  return callRouteForSession(importArchive, session, {
    url: `${ORIGIN}/api/portable-archives/import`,
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ householdId: fixture.household.id, archive, passphrase: PASSPHRASE, conflictItemIds: [] }),
  });
}

async function archiveCount(householdId: string): Promise<number> {
  return (await getDb().select({ id: portableArchives.id }).from(portableArchives)
    .where(eq(portableArchives.householdId, householdId))).length;
}

async function itemCount(householdId: string): Promise<number> {
  return (await getDb().select({ id: items.id }).from(items).where(eq(items.householdId, householdId))).length;
}

describe("portable archive export: recent authentication (#1132)", () => {
  it("refuses a session with no proof, and a proof for another act, and writes nothing", async () => {
    const fixture = await createIntegrationFixture("archive-export-step-up");
    const owner = await fixture.session("owner");
    const before = await archiveCount(fixture.household.id);

    const bare = await exportAs(owner, fixture);
    expect(bare.status).toBe(403);
    expect(await errorCode(bare)).toBe("recent_authentication_required");

    const wrongAct = await exportAs(owner, fixture, await proofCookie(owner, "archive_import"));
    expect(wrongAct.status).toBe(403);
    expect(await errorCode(wrongAct)).toBe("recent_authentication_required");

    expect(await archiveCount(fixture.household.id)).toBe(before);
  });

  it("writes the archive once the owner has just proved it is them", async () => {
    const fixture = await createIntegrationFixture("archive-export-proved");
    const owner = await fixture.session("owner");
    const before = await archiveCount(fixture.household.id);

    const response = await exportAs(owner, fixture, await proofCookie(owner, "archive_export"));
    expect(response.status).toBe(200);
    expect(await archiveCount(fixture.household.id)).toBe(before + 1);
  });

  it("tells somebody who may not export so, without asking them to prove anything", async () => {
    const fixture = await createIntegrationFixture("archive-export-outsider");
    const member = await fixture.session("member");
    const outsider = await fixture.session("outsider");

    const notOwner = await exportAs(member, fixture);
    expect(notOwner.status).toBe(403);
    expect(await errorCode(notOwner)).toBe("owner_required");

    const notMember = await exportAs(outsider, fixture);
    expect(notMember.status).toBe(404);
    expect(await errorCode(notMember)).toBe("household_not_found");
  });
});

describe("portable archive import: recent authentication (#1132)", () => {
  it("refuses a session with no proof, and a proof for another act, and brings nothing in", async () => {
    const fixture = await createIntegrationFixture("archive-import-step-up");
    const owner = await fixture.session("owner");
    const before = await itemCount(fixture.household.id);

    const bare = await importAs(owner, fixture);
    expect(bare.status).toBe(403);
    expect(await errorCode(bare)).toBe("recent_authentication_required");

    const wrongAct = await importAs(owner, fixture, await proofCookie(owner, "archive_export"));
    expect(wrongAct.status).toBe(403);
    expect(await errorCode(wrongAct)).toBe("recent_authentication_required");

    expect(await itemCount(fixture.household.id)).toBe(before);
  });

  it("brings the archive in once the importer has just proved it is them", async () => {
    const fixture = await createIntegrationFixture("archive-import-proved");
    const owner = await fixture.session("owner");
    const before = await itemCount(fixture.household.id);

    const response = await importAs(owner, fixture, await proofCookie(owner, "archive_import"));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { importedItems: number }).importedItems).toBe(1);
    expect(await itemCount(fixture.household.id)).toBe(before + 1);
  });

  it("tells somebody outside the household so, without asking them to prove anything", async () => {
    const fixture = await createIntegrationFixture("archive-import-outsider");
    const outsider = await fixture.session("outsider");

    const response = await importAs(outsider, fixture);
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("household_not_found");
  });
});
