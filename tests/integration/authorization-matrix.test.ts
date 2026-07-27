import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { documents, households, portableArchives, sessions, users } from "@/db/schema";
import { getAuthConfig } from "@/lib/env";
import { sessionCookieName } from "@/lib/auth/cookies";
import { encryptPortableArchive } from "@/server/portable-archive";
import { GET as readWorkspace } from "@/app/api/workspace/route";
import { POST as applyWorkspaceCommand } from "@/app/api/workspace/commands/route";
import { GET as listMembers, POST as addMember } from "@/app/api/households/[householdId]/members/route";
import { POST as lifecycle } from "@/app/api/households/[householdId]/lifecycle/route";
import { GET as listDocuments } from "@/app/api/households/[householdId]/items/[itemId]/documents/route";
import { DELETE as deleteDocument } from "@/app/api/documents/[documentId]/route";
import { GET as downloadDocument } from "@/app/api/documents/[documentId]/download/route";
import { POST as restoreDocument } from "@/app/api/documents/[documentId]/restore/route";
import { POST as createArchive } from "@/app/api/households/[householdId]/portable-archives/route";
import { GET as downloadArchive } from "@/app/api/portable-archives/[archiveId]/download/route";
import { POST as previewImport } from "@/app/api/portable-archives/preview/route";
import { POST as importArchive } from "@/app/api/portable-archives/import/route";
import { GET as listUsers, PATCH as disableUser } from "@/app/api/admin/users/route";
import { GET as listOperations } from "@/app/api/admin/operations/route";
import {
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
  requestForSession,
  requestWithoutSession,
} from "./support/fixtures";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

function householdContext(householdId: string) {
  return { params: Promise.resolve({ householdId }) };
}

function itemDocumentsContext(householdId: string, itemId: string) {
  return { params: Promise.resolve({ householdId, itemId }) };
}

function documentContext(documentId: string) {
  return { params: Promise.resolve({ documentId }) };
}

function archiveContext(archiveId: string) {
  return { params: Promise.resolve({ archiveId }) };
}

function householdUpdate(householdId: string, name = "Updated integration household") {
  return {
    type: "household.update" as const,
    householdId,
    name,
    timezone: "Europe/London",
    currency: "GBP",
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function expectError(response: Response, status: number, code: string, message: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await json(response)).toEqual({ error: { code, message } });
}

describe("persisted identity and session transitions", () => {
  it("rejects signed-out, malformed and expired sessions", async () => {
    const fixture = await createIntegrationFixture("session-boundary");
    const signedOut = await readWorkspace(requestWithoutSession("http://127.0.0.1:3000/api/workspace"));
    await expectError(signedOut, 401, "session_required", "A valid session is required");

    const config = getAuthConfig();
    const malformed = await readWorkspace(requestWithoutSession("http://127.0.0.1:3000/api/workspace", {
      headers: { cookie: `${sessionCookieName(config)}=malformed-token` },
    }));
    await expectError(malformed, 401, "session_required", "A valid session is required");

    const expiredSession = await fixture.session("member");
    await fixture.expireSession(expiredSession);
    const expired = await readWorkspace(requestForSession(expiredSession, "http://127.0.0.1:3000/api/workspace"));
    await expectError(expired, 401, "session_required", "A valid session is required");
    const [persisted] = await getDb().select({ id: sessions.id }).from(sessions).where(eq(sessions.id, expiredSession.sessionId));
    expect(persisted).toBeUndefined();
  });

  it("rejects a disabled user using a cookie issued before disable", async () => {
    const fixture = await createIntegrationFixture("disabled-session");
    const disabledSession = await fixture.session("disabled");
    await fixture.disableUser("disabled");

    const response = await readWorkspace(requestForSession(disabledSession, "http://127.0.0.1:3000/api/workspace"));
    await expectError(response, 401, "session_required", "A valid session is required");
    const [persisted] = await getDb().select({ id: sessions.id }).from(sessions).where(eq(sessions.id, disabledSession.sessionId));
    expect(persisted).toBeUndefined();
  });

  it("honours live membership removal on the next request", async () => {
    const fixture = await createIntegrationFixture("membership-transition");
    const member = await fixture.session("member");
    await fixture.removeMember();

    const response = await listDocuments(
      requestForSession(member, "http://127.0.0.1:3000/api/households/invalid/items/invalid/documents"),
      itemDocumentsContext(fixture.household.id, fixture.item.id),
    );
    await expectError(response, 404, "item_not_found", "That item is not available");
  });
});

describe("workspace, household and lifecycle authorization", () => {
  it("rejects unsafe workspace mutations before parsing or changing state", async () => {
    const fixture = await createIntegrationFixture("workspace-matrix");
    const owner = await fixture.session("owner");
    const member = await fixture.session("member");
    const outsider = await fixture.session("outsider");
    const command = householdUpdate(fixture.household.id);
    const beforeAudit = await fixture.auditCount(fixture.household.id);

    const missingCsrf = await applyWorkspaceCommand(requestWithoutSession("http://127.0.0.1:3000/api/workspace/commands", {
      method: "POST",
      headers: {
        cookie: owner.headers.cookie,
        origin: owner.headers.origin,
        "sec-fetch-site": owner.headers["sec-fetch-site"],
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...command, name: "Must not persist" }),
    }));
    await expectError(missingCsrf, 403, "csrf_failed", "The CSRF token is missing or invalid");
    expect(await fixture.auditCount(fixture.household.id)).toBe(beforeAudit);

    const wrongCsrf = await applyWorkspaceCommand(requestForSession(owner, "http://127.0.0.1:3000/api/workspace/commands", {
      method: "POST",
      headers: { "x-csrf-token": "wrong-token", "content-type": "application/json" },
      body: JSON.stringify({ ...command, name: "Must not persist" }),
    }));
    await expectError(wrongCsrf, 403, "csrf_failed", "The CSRF token is missing or invalid");

    const crossOrigin = await applyWorkspaceCommand(requestForSession(owner, "http://127.0.0.1:3000/api/workspace/commands", {
      method: "POST",
      headers: { origin: "https://cross-site.invalid", "content-type": "application/json" },
      body: JSON.stringify({ ...command, name: "Must not persist" }),
    }));
    await expectError(crossOrigin, 403, "csrf_failed", "The request origin could not be verified");

    const memberDenied = await applyWorkspaceCommand(requestForSession(member, "http://127.0.0.1:3000/api/workspace/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    }));
    await expectError(memberDenied, 403, "owner_required", "Only a household owner can make this change");

    const outsiderDenied = await applyWorkspaceCommand(requestForSession(outsider, "http://127.0.0.1:3000/api/workspace/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    }));
    await expectError(outsiderDenied, 404, "household_not_found", "That household is not available");

    const [unchanged] = await getDb().select({ name: households.name }).from(households).where(eq(households.id, fixture.household.id));
    expect(unchanged?.name).toBe(fixture.household.name);
    expect(await fixture.auditCount(fixture.household.id)).toBe(beforeAudit);

    const allowed = await applyWorkspaceCommand(requestForSession(owner, "http://127.0.0.1:3000/api/workspace/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(householdUpdate(fixture.household.id, "Owner update")),
    }));
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("cache-control")).toBe("no-store");
    expect((await json(allowed)).workspace).toEqual(expect.objectContaining({
      households: expect.arrayContaining([expect.objectContaining({ name: "Owner update" })]),
    }));
    const [persistedUpdate] = await getDb().select({ name: households.name }).from(households).where(eq(households.id, fixture.household.id));
    expect(persistedUpdate?.name).toBe("Owner update");
  });

  it("enforces member visibility and owner-only membership changes", async () => {
    const fixture = await createIntegrationFixture("household-members");
    const member = await fixture.session("member");
    const outsider = await fixture.session("outsider");
    const owner = await fixture.session("owner");
    const context = householdContext(fixture.household.id);

    const visible = await listMembers(requestForSession(member, "http://127.0.0.1:3000/api/households/members"), context);
    expect(visible.status).toBe(200);
    expect(visible.headers.get("cache-control")).toBe("no-store");
    expect((await json(visible)).members).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: fixture.users.member.id }),
    ]));

    const outsiderDenied = await listMembers(requestForSession(outsider, "http://127.0.0.1:3000/api/households/members"), context);
    await expectError(outsiderDenied, 404, "household_not_found", "That household is not available");

    const beforeAudit = await fixture.auditCount(fixture.household.id);
    const memberMutation = await addMember(requestForSession(member, "http://127.0.0.1:3000/api/households/members", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: fixture.users.outsider.id }),
    }), context);
    await expectError(memberMutation, 403, "owner_required", "Only a household owner can make this change");
    expect(await fixture.auditCount(fixture.household.id)).toBe(beforeAudit);

    const ownerVisible = await listMembers(requestForSession(owner, "http://127.0.0.1:3000/api/households/members"), context);
    expect(ownerVisible.status).toBe(200);
    expect(ownerVisible.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps lifecycle records private while allowing an owner to restore a request", async () => {
    const fixture = await createIntegrationFixture("lifecycle-matrix");
    const member = await fixture.session("member");
    const owner = await fixture.session("owner");
    const context = householdContext(fixture.household.id);
    const beforeAudit = await fixture.auditCount(fixture.household.id);

    const denied = await lifecycle(requestForSession(member, "http://127.0.0.1:3000/api/households/lifecycle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete", confirmation: fixture.household.name }),
    }), context);
    await expectError(denied, 404, "household_not_found", "That household is not available");
    expect(await fixture.auditCount(fixture.household.id)).toBe(beforeAudit);

    const requested = await lifecycle(requestForSession(owner, "http://127.0.0.1:3000/api/households/lifecycle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete", confirmation: fixture.household.name }),
    }), context);
    expect(requested.status).toBe(200);
    expect(requested.headers.get("cache-control")).toBe("no-store");

    const restored = await lifecycle(requestForSession(owner, "http://127.0.0.1:3000/api/households/lifecycle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "restore" }),
    }), context);
    expect(restored.status).toBe(200);
    expect(restored.headers.get("cache-control")).toBe("no-store");
    expect((await json(restored)).restored).toBe(true);
  });
});

describe("document authorization and non-disclosure", () => {
  it("uses the same item/document denial contracts without leaking metadata", async () => {
    const fixture = await createIntegrationFixture("document-matrix");
    const member = await fixture.session("member");
    const outsider = await fixture.session("outsider");
    const secondOwner = await fixture.session("secondOwner");
    const itemContext = itemDocumentsContext(fixture.household.id, fixture.item.id);
    const missingItemContext = itemDocumentsContext(fixture.household.id, randomUUID());

    const memberVisible = await listDocuments(requestForSession(member, "http://127.0.0.1:3000/api/documents"), itemContext);
    expect(memberVisible.status).toBe(200);
    expect(memberVisible.headers.get("cache-control")).toBe("no-store");
    expect((await json(memberVisible)).documents).toEqual([expect.objectContaining({ id: fixture.document.id })]);

    const outsiderResponse = await listDocuments(requestForSession(outsider, "http://127.0.0.1:3000/api/documents"), itemContext);
    const crossHouseholdResponse = await listDocuments(requestForSession(secondOwner, "http://127.0.0.1:3000/api/documents"), itemContext);
    const missingResponse = await listDocuments(requestForSession(outsider, "http://127.0.0.1:3000/api/documents"), missingItemContext);
    await expectError(outsiderResponse, 404, "item_not_found", "That item is not available");
    await expectError(crossHouseholdResponse, 404, "item_not_found", "That item is not available");
    await expectError(missingResponse, 404, "item_not_found", "That item is not available");
  });

  it("keeps document download, delete and restore private and mutation-free on denial", async () => {
    const fixture = await createIntegrationFixture("document-actions");
    const outsider = await fixture.session("outsider");
    const secondOwner = await fixture.session("secondOwner");
    const context = documentContext(fixture.document.id);
    const beforeAudit = await fixture.auditCount(fixture.document.id);

    const download = await downloadDocument(requestForSession(outsider, "http://127.0.0.1:3000/api/documents/download"), context);
    const crossHouseholdDownload = await downloadDocument(requestForSession(secondOwner, "http://127.0.0.1:3000/api/documents/download"), context);
    const missingDownload = await downloadDocument(requestForSession(outsider, "http://127.0.0.1:3000/api/documents/download"), documentContext(randomUUID()));
    await expectError(download, 404, "document_not_found", "That document is not available");
    await expectError(crossHouseholdDownload, 404, "document_not_found", "That document is not available");
    await expectError(missingDownload, 404, "document_not_found", "That document is not available");

    const deletion = await deleteDocument(requestForSession(outsider, "http://127.0.0.1:3000/api/documents/delete", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
    }), context);
    await expectError(deletion, 404, "document_not_found", "That document is not available");

    const restore = await restoreDocument(requestForSession(outsider, "http://127.0.0.1:3000/api/documents/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }), context);
    await expectError(restore, 404, "document_not_found", "That document is not available");

    const [unchanged] = await getDb().select({ lifecycle: documents.lifecycle }).from(documents).where(eq(documents.id, fixture.document.id));
    expect(unchanged?.lifecycle).toBe("available");
    expect(await fixture.auditCount(fixture.document.id)).toBe(beforeAudit);
  });

  it("rejects cross-origin document deletion before mutation", async () => {
    const fixture = await createIntegrationFixture("document-csrf");
    const member = await fixture.session("member");
    const beforeAudit = await fixture.auditCount(fixture.document.id);
    const response = await deleteDocument(requestForSession(member, "http://127.0.0.1:3000/api/documents/delete", {
      method: "DELETE",
      headers: { origin: "https://cross-site.invalid", "content-type": "application/json" },
    }), documentContext(fixture.document.id));
    await expectError(response, 403, "csrf_failed", "The request origin could not be verified");
    const [unchanged] = await getDb().select({ lifecycle: documents.lifecycle }).from(documents).where(eq(documents.id, fixture.document.id));
    expect(unchanged?.lifecycle).toBe("available");
    expect(await fixture.auditCount(fixture.document.id)).toBe(beforeAudit);
  });
});

describe("portable archive and administrator authorization", () => {
  it("allows an owner to create and preview synthetic archives while denying an outsider", async () => {
    const fixture = await createIntegrationFixture("archive-matrix");
    const owner = await fixture.session("owner");
    const outsider = await fixture.session("outsider");
    const secondOwner = await fixture.session("secondOwner");
    const householdId = fixture.household.id;
    const context = householdContext(householdId);

    const created = await createArchive(requestForSession(owner, "http://127.0.0.1:3000/api/archives", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "integration-passphrase", includeDocuments: false }),
    }), context);
    expect(created.status).toBe(200);
    expect(created.headers.get("cache-control")).toBe("no-store");
    expect((await json(created)).archive).toEqual(expect.objectContaining({ includesDocuments: false }));

    const beforeDeniedArchiveIds = (await getDb().select({ id: portableArchives.id }).from(portableArchives)
      .where(eq(portableArchives.householdId, fixture.household.id))).map(({ id }) => id).sort();
    const beforeDeniedAudit = await fixture.auditCount(fixture.household.id);
    const denied = await createArchive(requestForSession(outsider, "http://127.0.0.1:3000/api/archives", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "integration-passphrase", includeDocuments: false }),
    }), context);
    await expectError(denied, 404, "household_not_found", "That household is not available");
    const afterDeniedArchiveIds = (await getDb().select({ id: portableArchives.id }).from(portableArchives)
      .where(eq(portableArchives.householdId, fixture.household.id))).map(({ id }) => id).sort();
    expect(afterDeniedArchiveIds).toEqual(beforeDeniedArchiveIds);
    expect(await fixture.auditCount(fixture.household.id)).toBe(beforeDeniedAudit);

    const archivePayload = {
      format: "orbit-portable-archive",
      version: 1,
      household: { name: fixture.household.name },
      sections: [{ id: fixture.section.id, slug: "imported", name: "Imported", icon: "home", accent: "sage", position: 1, visible: true }],
      items: [{ id: randomUUID(), sectionId: fixture.section.id, title: `Imported ${randomUUID()}`, subtype: null, provider: null, reference: null, costMinor: null, currency: "GBP", startDate: null, expiryDate: null, renewalDate: null, serviceDate: null, recurrenceMonths: null, snoozedUntil: null, notes: null, externalDocumentUrl: null, status: "active" as const }],
      dueEvents: [],
      reminderRules: [],
      documents: [],
    };
    const encrypted = encryptPortableArchive(Buffer.from(JSON.stringify(archivePayload)), "integration-passphrase");
    const preview = await previewImport(requestForSession(owner, "http://127.0.0.1:3000/api/archives/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ householdId, archive: encrypted, passphrase: "integration-passphrase" }),
    }));
    expect(preview.status).toBe(200);
    expect(preview.headers.get("cache-control")).toBe("no-store");
    expect((await json(preview)).preview).toEqual(expect.objectContaining({ householdName: fixture.household.name, items: 1 }));

    const imported = await importArchive(requestForSession(owner, "http://127.0.0.1:3000/api/archives/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ householdId, archive: encrypted, passphrase: "integration-passphrase", conflictItemIds: [] }),
    }));
    expect(imported.status).toBe(200);
    expect(imported.headers.get("cache-control")).toBe("no-store");
    expect((await json(imported)).importedItems).toBe(1);

    const crossHouseholdDenied = await downloadArchive(requestForSession(secondOwner, "http://127.0.0.1:3000/api/archives/download"), archiveContext(fixture.archive.id));
    const crossHouseholdMissing = await downloadArchive(requestForSession(secondOwner, "http://127.0.0.1:3000/api/archives/download"), archiveContext(randomUUID()));
    await expectError(crossHouseholdDenied, 404, "archive_not_found", "That export is not available");
    await expectError(crossHouseholdMissing, 404, "archive_not_found", "That export is not available");
  });

  it("does not disclose existing archives to outsiders", async () => {
    const fixture = await createIntegrationFixture("archive-disclosure");
    const outsider = await fixture.session("outsider");
    const existing = await downloadArchive(requestForSession(outsider, "http://127.0.0.1:3000/api/archives/download"), archiveContext(fixture.archive.id));
    const missing = await downloadArchive(requestForSession(outsider, "http://127.0.0.1:3000/api/archives/download"), archiveContext(randomUUID()));
    await expectError(existing, 404, "archive_not_found", "That export is not available");
    await expectError(missing, 404, "archive_not_found", "That export is not available");
  });

  it("restricts administrator operations and invalidates disabled-user sessions", async () => {
    const fixture = await createIntegrationFixture("administrator-matrix");
    const admin = await fixture.session("admin");
    const owner = await fixture.session("owner");
    const member = await fixture.session("member");
    const outsider = await fixture.session("outsider");
    const oldMemberSession = await fixture.session("member");

    const signedOutUsers = await listUsers(requestWithoutSession("http://127.0.0.1:3000/api/admin/users"));
    await expectError(signedOutUsers, 401, "session_required", "A valid session is required");

    const ownerOperations = await listOperations(requestForSession(owner, "http://127.0.0.1:3000/api/admin/operations"));
    const outsiderOperations = await listOperations(requestForSession(outsider, "http://127.0.0.1:3000/api/admin/operations"));
    const memberUsers = await listUsers(requestForSession(member, "http://127.0.0.1:3000/api/admin/users"));
    await expectError(ownerOperations, 403, "administrator_required", "Orbit administrator access is required");
    await expectError(outsiderOperations, 403, "administrator_required", "Orbit administrator access is required");
    await expectError(memberUsers, 403, "administrator_required", "Orbit administrator access is required");

    const usersResponse = await listUsers(requestForSession(admin, "http://127.0.0.1:3000/api/admin/users"));
    expect(usersResponse.status).toBe(200);
    expect(usersResponse.headers.get("cache-control")).toBe("no-store");
    expect((await json(usersResponse)).users).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: fixture.users.admin.id, isInstanceAdmin: true }),
    ]));

    const adminMembers = await listMembers(requestForSession(admin, "http://127.0.0.1:3000/api/households/members"), householdContext(fixture.household.id));
    expect(adminMembers.status).toBe(200);
    expect(adminMembers.headers.get("cache-control")).toBe("no-store");
    expect((await json(adminMembers)).members).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: fixture.users.owner.id }),
    ]));

    const beforeAudit = await fixture.auditCount(fixture.users.member.id);
    const unsafe = await disableUser(requestForSession(admin, "http://127.0.0.1:3000/api/admin/users", {
      method: "PATCH",
      headers: { "x-csrf-token": "wrong-token", "content-type": "application/json" },
      body: JSON.stringify({ userId: fixture.users.member.id, disabled: true }),
    }));
    await expectError(unsafe, 403, "csrf_failed", "The CSRF token is missing or invalid");
    const [stillEnabled] = await getDb().select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, fixture.users.member.id));
    expect(stillEnabled?.disabledAt).toBeNull();
    expect(await fixture.auditCount(fixture.users.member.id)).toBe(beforeAudit);

    const disabled = await disableUser(requestForSession(admin, "http://127.0.0.1:3000/api/admin/users", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: fixture.users.member.id, disabled: true }),
    }));
    expect(disabled.status).toBe(200);
    expect(await fixture.auditCount(fixture.users.member.id)).toBe(beforeAudit + 1);
    const afterDisable = await readWorkspace(requestForSession(oldMemberSession, "http://127.0.0.1:3000/api/workspace"));
    await expectError(afterDisable, 401, "session_required", "A valid session is required");

    const operations = await listOperations(requestForSession(admin, "http://127.0.0.1:3000/api/admin/operations"));
    expect(operations.status).toBe(200);
    expect(operations.headers.get("cache-control")).toBe("no-store");
  });
});
