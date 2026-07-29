import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  auditLog,
  documentCrypto,
  documents,
  households,
  items,
  memberships,
  portableArchives,
  sections,
  users,
} from "@/db/schema";
import { POST as lifecycle } from "@/app/api/households/[householdId]/lifecycle/route";
import { GET as workspace } from "@/app/api/workspace/route";
import { hardDeleteHousehold, purgeExpiredHouseholds, requestHouseholdDeletion, restoreHousehold } from "@/server/household-lifecycle";
import { transferHouseholdOwnership } from "@/server/workspace-repository";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { getDocumentConfig } from "@/server/documents/config";
import { PortableArchiveStorage } from "@/server/portable-archive-storage";
import { reconcileDocumentStorage } from "@/server/document-worker";
import { reconcilePortableArchiveStorage } from "@/server/portable-archive-repository";
import { householdOwnerLockKey } from "@/lib/auth/authority-locks";
import { POST as uploadDocument } from "@/app/api/households/[householdId]/items/[itemId]/documents/route";
import {
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
  requestForSession,
} from "./support/fixtures";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

function lifecycleContext(householdId: string) {
  return { params: Promise.resolve({ householdId }) };
}

function itemDocumentsContext(householdId: string, itemId: string) {
  return { params: Promise.resolve({ householdId, itemId }) };
}

function documentContext(documentId: string) {
  return { params: Promise.resolve({ documentId }) };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

async function waitForAdvisoryLockWaiter(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await getDb().execute(sql<{ waiting: number }>`
      select count(*)::int as waiting
      from pg_locks
      where locktype = 'advisory' and granted = false
    `);
    if (Number(rows[0]?.waiting) > 0) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Lifecycle request did not wait for the held advisory lock");
}

async function holdLifecycleLockWhileChangingAuthority<T>(
  householdId: string,
  beginRequest: () => Promise<T>,
  changeAuthority: (transaction: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0]) => Promise<void>,
): Promise<T> {
  const acquired = deferred<void>();
  const release = deferred<void>();
  let request!: Promise<T>;
  const holdingTransaction = getDb().transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${householdOwnerLockKey(householdId)}, 0))`);
    acquired.resolve();
    request = beginRequest();
    await waitForAdvisoryLockWaiter();
    await changeAuthority(transaction);
    release.resolve();
    await release.promise;
  });
  await acquired.promise;
  await holdingTransaction;
  return request;
}

function syntheticPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let value = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(value));
    value += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(value);
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  value += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  value += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(value);
}

async function expectApiError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await response.json()).error).toMatchObject({ code });
}

async function uploadSyntheticDocument(fixture: Awaited<ReturnType<typeof createIntegrationFixture>>) {
  const session = await fixture.session("member");
  const contents = syntheticPdf();
  const response = await uploadDocument(requestForSession(session, `http://127.0.0.1:3000/api/households/${fixture.household.id}/items/${fixture.item.id}/documents`, {
    method: "POST",
    headers: {
      "content-length": String(contents.length),
      "content-type": "application/pdf",
      "x-orbit-filename": encodeURIComponent("lifecycle-document.pdf"),
    },
    body: contents as unknown as BodyInit,
  }), itemDocumentsContext(fixture.household.id, fixture.item.id));
  expect(response.status).toBe(201);
  return { session, documentId: (await response.json() as { document: { id: string } }).document.id };
}

describe("transactional household lifecycle", () => {
  it("requires exact confirmation and rechecks active authority inside the mutation", async () => {
    const fixture = await createIntegrationFixture("lifecycle-confirmation");
    const member = await fixture.session("member");
    const outsider = await fixture.session("outsider");
    const beforeAudit = await fixture.auditCount(fixture.household.id);

    await expect(requestHouseholdDeletion(fixture.users.owner.id, fixture.household.id, ` ${fixture.household.name} `))
      .rejects.toMatchObject({ code: "household_confirmation_failed" });
    await expect(requestHouseholdDeletion(fixture.users.owner.id, fixture.household.id, ""))
      .rejects.toMatchObject({ code: "household_confirmation_failed" });

    const memberDenied = await lifecycle(requestForSession(member, "http://127.0.0.1:3000/api/households/lifecycle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete", confirmation: fixture.household.name }),
    }), lifecycleContext(fixture.household.id));
    await expectApiError(memberDenied, 404, "household_not_found");

    const outsiderDenied = await lifecycle(requestForSession(outsider, "http://127.0.0.1:3000/api/households/lifecycle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete", confirmation: fixture.household.name }),
    }), lifecycleContext(fixture.household.id));
    await expectApiError(outsiderDenied, 404, "household_not_found");

    await fixture.disableUser("owner");
    await expect(requestHouseholdDeletion(fixture.users.owner.id, fixture.household.id, fixture.household.name))
      .rejects.toMatchObject({ code: "household_not_found" });
    expect(await fixture.auditCount(fixture.household.id)).toBe(beforeAudit);
  });

  it("keeps scheduled households private and serializes repeated schedule/restore requests", async () => {
    const fixture = await createIntegrationFixture("lifecycle-privacy");
    const owner = await fixture.session("owner");
    const member = await fixture.session("member");

    const [first, second] = await Promise.allSettled([
      requestHouseholdDeletion(fixture.users.owner.id, fixture.household.id, fixture.household.name),
      requestHouseholdDeletion(fixture.users.owner.id, fixture.household.id, fixture.household.name),
    ]);
    expect([first, second].filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect([first, second].filter((result) => result.status === "rejected" && result.reason?.code === "household_deletion_pending")).toHaveLength(1);

    const memberWorkspace = await workspace(requestForSession(member, "http://127.0.0.1:3000/api/workspace"));
    expect(memberWorkspace.status).toBe(200);
    expect((await memberWorkspace.json()).workspace.households).toEqual([]);

    await expect(requestHouseholdDeletion(fixture.users.owner.id, fixture.household.id, fixture.household.name))
      .rejects.toMatchObject({ code: "household_deletion_pending" });

    await restoreHousehold(fixture.users.owner.id, fixture.household.id, owner.sessionId);
    await expect(restoreHousehold(fixture.users.owner.id, fixture.household.id, owner.sessionId))
      .rejects.toMatchObject({ code: "household_not_recoverable" });
  });

  it("rechecks ownership after a serialized ownership transfer", async () => {
    const fixture = await createIntegrationFixture("lifecycle-ownership-race");
    await transferHouseholdOwnership(fixture.users.owner.id, fixture.household.id, fixture.users.member.id);

    await expect(requestHouseholdDeletion(fixture.users.owner.id, fixture.household.id, fixture.household.name))
      .rejects.toMatchObject({ code: "household_not_found" });
    await expect(requestHouseholdDeletion(fixture.users.member.id, fixture.household.id, fixture.household.name))
      .resolves.toMatchObject({ deleteAfter: expect.any(String) });
  });

  it("denies a stale schedule after authority changes while it waits on the lifecycle lock", async () => {
    const fixture = await createIntegrationFixture("lifecycle-schedule-lock");
    const result = await holdLifecycleLockWhileChangingAuthority(
      fixture.household.id,
      () => requestHouseholdDeletion(fixture.users.owner.id, fixture.household.id, fixture.household.name),
      async (transaction) => {
        await transaction.update(memberships).set({ role: "member" }).where(and(
          eq(memberships.householdId, fixture.household.id),
          eq(memberships.userId, fixture.users.owner.id),
        ));
      },
    );
    await expect(result).rejects.toMatchObject({ code: "household_not_found" });
    expect(await getDb().select({ id: households.id, deletionRequestedAt: households.deletionRequestedAt })
      .from(households).where(eq(households.id, fixture.household.id))).toEqual([
      expect.objectContaining({ id: fixture.household.id, deletionRequestedAt: null }),
    ]);
  });

  it("denies a stale restore after the owner loses authority while it waits on the lifecycle lock", async () => {
    const fixture = await createIntegrationFixture("lifecycle-restore-lock");
    await requestHouseholdDeletion(fixture.users.owner.id, fixture.household.id, fixture.household.name);
    const result = await holdLifecycleLockWhileChangingAuthority(
      fixture.household.id,
      () => restoreHousehold(fixture.users.owner.id, fixture.household.id),
      async (transaction) => {
        await transaction.update(memberships).set({ role: "member" }).where(and(
          eq(memberships.householdId, fixture.household.id),
          eq(memberships.userId, fixture.users.owner.id),
        ));
      },
    );
    await expect(result).rejects.toMatchObject({ code: "household_not_found" });
    expect(await getDb().select({ deletionRequestedAt: households.deletionRequestedAt })
      .from(households).where(eq(households.id, fixture.household.id))).toEqual([
      expect.objectContaining({ deletionRequestedAt: expect.any(Date) }),
    ]);
  });

  it("denies a stale hard-delete after administrator authority changes while it waits on the lifecycle lock", async () => {
    const fixture = await createIntegrationFixture("lifecycle-hard-delete-lock");
    await requestHouseholdDeletion(fixture.users.owner.id, fixture.household.id, fixture.household.name);
    const result = await holdLifecycleLockWhileChangingAuthority(
      fixture.household.id,
      () => hardDeleteHousehold(fixture.users.admin.id, fixture.household.id, fixture.household.name),
      async (transaction) => {
        await transaction.update(users).set({ isInstanceAdmin: false }).where(eq(users.id, fixture.users.admin.id));
      },
    );
    await expect(result).rejects.toMatchObject({ code: "administrator_required" });
    expect(await getDb().select({ id: households.id }).from(households).where(eq(households.id, fixture.household.id))).toHaveLength(1);
  });

  it("hard-deletes with a bounded audit event and preserves no accessible household rows", async () => {
    const fixture = await createIntegrationFixture("lifecycle-hard-delete");
    await requestHouseholdDeletion(fixture.users.owner.id, fixture.household.id, fixture.household.name);
    const admin = await fixture.session("admin");

    await getDb().update(users).set({ disabledAt: new Date() }).where(eq(users.id, fixture.users.admin.id));
    await expect(hardDeleteHousehold(fixture.users.admin.id, fixture.household.id, fixture.household.name))
      .rejects.toMatchObject({ code: "household_not_found" });
    await getDb().update(users).set({ disabledAt: null }).where(eq(users.id, fixture.users.admin.id));

    await expect(hardDeleteHousehold(fixture.users.admin.id, fixture.household.id, ` ${fixture.household.name} `))
      .rejects.toMatchObject({ code: "household_hard_delete_confirmation_failed" });
    await hardDeleteHousehold(fixture.users.admin.id, fixture.household.id, fixture.household.name);

    expect(await getDb().select({ id: households.id }).from(households).where(eq(households.id, fixture.household.id))).toHaveLength(0);
    expect(await getDb().select({ id: memberships.userId }).from(memberships).where(eq(memberships.householdId, fixture.household.id))).toHaveLength(0);
    expect(await getDb().select({ id: sections.id }).from(sections).where(eq(sections.householdId, fixture.household.id))).toHaveLength(0);
    expect(await getDb().select({ id: items.id }).from(items).where(eq(items.householdId, fixture.household.id))).toHaveLength(0);
    expect(await getDb().select({ id: documents.id }).from(documents).where(eq(documents.householdId, fixture.household.id))).toHaveLength(0);
    expect(await getDb().select({ id: portableArchives.id }).from(portableArchives).where(eq(portableArchives.householdId, fixture.household.id))).toHaveLength(0);

    const audits = await getDb().select({ householdId: auditLog.householdId, entityId: auditLog.entityId, action: auditLog.action })
      .from(auditLog).where(and(eq(auditLog.entityId, fixture.household.id), eq(auditLog.action, "household_hard_deleted")));
    expect(audits).toEqual([{ householdId: null, entityId: fixture.household.id, action: "household_hard_deleted" }]);

    const repeated = await lifecycle(requestForSession(admin, "http://127.0.0.1:3000/api/households/lifecycle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "hard_delete", confirmation: fixture.household.name }),
    }), lifecycleContext(fixture.household.id));
    await expectApiError(repeated, 404, "household_not_found");
    expect(await getDb().select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.entityId, fixture.household.id), eq(auditLog.action, "household_hard_deleted")))).toHaveLength(1);
  });

  it("converges concurrent hard-delete requests to one audit event", async () => {
    const fixture = await createIntegrationFixture("lifecycle-hard-delete-race");
    await requestHouseholdDeletion(fixture.users.owner.id, fixture.household.id, fixture.household.name);

    const [first, second] = await Promise.allSettled([
      hardDeleteHousehold(fixture.users.admin.id, fixture.household.id, fixture.household.name),
      hardDeleteHousehold(fixture.users.admin.id, fixture.household.id, fixture.household.name),
    ]);
    const results = [first, second];
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(["household_not_found", "household_not_recoverable"]).toContain(rejected?.reason?.code);
    expect(await getDb().select({ id: households.id }).from(households).where(eq(households.id, fixture.household.id))).toHaveLength(0);
    expect(await getDb().select({ id: auditLog.id }).from(auditLog).where(and(
      eq(auditLog.entityId, fixture.household.id),
      eq(auditLog.action, "household_hard_deleted"),
    ))).toHaveLength(1);
  });

  it("retention-purges expired households once and preserves the existing purge audit contract", async () => {
    const fixture = await createIntegrationFixture("lifecycle-retention");
    await requestHouseholdDeletion(fixture.users.owner.id, fixture.household.id, fixture.household.name);
    await getDb().update(households).set({ deleteAfter: new Date(Date.now() - 1_000) }).where(eq(households.id, fixture.household.id));

    await purgeExpiredHouseholds();
    await purgeExpiredHouseholds();

    expect(await getDb().select({ id: households.id }).from(households).where(eq(households.id, fixture.household.id))).toHaveLength(0);
    const audits = await getDb().select({ householdId: auditLog.householdId, entityId: auditLog.entityId, action: auditLog.action })
      .from(auditLog).where(and(eq(auditLog.entityId, fixture.household.id), eq(auditLog.action, "household_purged")));
    expect(audits).toEqual([{ householdId: null, entityId: fixture.household.id, action: "household_purged" }]);
  });

  it("removes document and archive ciphertext after a failed deletion retry without exposing data", async () => {
    const fixture = await createIntegrationFixture("lifecycle-storage");
    const { session, documentId } = await uploadSyntheticDocument(fixture);
    const [documentRecord] = await getDb().select({ storageKey: documentCrypto.storageKey }).from(documentCrypto)
      .where(eq(documentCrypto.documentId, documentId));
    const [archiveRecord] = await getDb().select({ storageKey: portableArchives.storageKey }).from(portableArchives)
      .where(eq(portableArchives.id, fixture.archive.id));
    const config = getDocumentConfig();
    const documentStorage = new LocalDocumentStorage(config.storageRoot, config.quarantineRoot);
    const archiveStorage = new PortableArchiveStorage(join(config.storageRoot, "portable-archives"));
    await archiveStorage.write(archiveRecord.storageKey, Buffer.from("encrypted archive orphan"));

    const documentDelete = vi.spyOn(LocalDocumentStorage.prototype, "deleteCiphertext").mockRejectedValue(new Error("injected storage outage"));
    const archiveDelete = vi.spyOn(PortableArchiveStorage.prototype, "delete").mockRejectedValue(new Error("injected storage outage"));
    try {
      await requestHouseholdDeletion(fixture.users.owner.id, fixture.household.id, fixture.household.name);
      await hardDeleteHousehold(fixture.users.admin.id, fixture.household.id, fixture.household.name);
    } finally {
      documentDelete.mockRestore();
      archiveDelete.mockRestore();
    }

    expect(await getDb().select({ id: documents.id }).from(documents).where(eq(documents.id, documentId))).toHaveLength(0);
    const download = await (await import("@/app/api/documents/[documentId]/download/route")).GET(
      requestForSession(session, `http://127.0.0.1:3000/api/documents/${documentId}/download`), documentContext(documentId),
    );
    await expectApiError(download, 404, "document_not_found");
    expect(await documentStorage.ciphertextExists(documentRecord.storageKey)).toBe(true);
    expect((await archiveStorage.list()).map((entry) => entry.storageKey)).toContain(archiveRecord.storageKey);

    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
    await utimes(join(config.storageRoot, "objects", documentRecord.storageKey.slice(0, 2), documentRecord.storageKey.slice(2, 4), `${documentRecord.storageKey}.bin`), old, old);
    await utimes(join(config.storageRoot, "portable-archives", `${archiveRecord.storageKey}.archive`), old, old);
    await reconcileDocumentStorage();
    await reconcilePortableArchiveStorage();

    expect(await documentStorage.ciphertextExists(documentRecord.storageKey)).toBe(false);
    expect((await archiveStorage.list()).map((entry) => entry.storageKey)).not.toContain(archiveRecord.storageKey);
  });

  it("rejects a restore that reaches the expiry boundary while purge is concurrent", async () => {
    const fixture = await createIntegrationFixture("lifecycle-expiry-race");
    await requestHouseholdDeletion(fixture.users.owner.id, fixture.household.id, fixture.household.name);
    await getDb().update(households).set({ deleteAfter: new Date(Date.now() - 1_000) }).where(eq(households.id, fixture.household.id));

    const [restore, purge] = await Promise.allSettled([
      restoreHousehold(fixture.users.owner.id, fixture.household.id),
      purgeExpiredHouseholds(),
    ]);
    expect(restore.status).toBe("rejected");
    expect((restore as PromiseRejectedResult).reason).toMatchObject({ code: "household_not_recoverable" });
    expect(purge.status).toBe("fulfilled");
    expect(await getDb().select({ id: households.id }).from(households).where(eq(households.id, fixture.household.id))).toHaveLength(0);
    expect(await getDb().select({ id: auditLog.id }).from(auditLog).where(and(
      eq(auditLog.entityId, fixture.household.id),
      eq(auditLog.action, "household_purged"),
    ))).toHaveLength(1);
  });
});
