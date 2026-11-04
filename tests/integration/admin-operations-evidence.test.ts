import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import {
  auditLog,
  documentJobs,
  households,
} from "@/db/schema";
import { expectApiError } from "./support/auth";
import {
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
  type IntegrationSession,
} from "./support/fixtures";
import { callRoute, callRouteForSession, loadRoute } from "./support/request-event";

const { GET: getOperations } = await loadRoute("admin/operations");
const { GET: getDocumentHealth } = await loadRoute("admin/documents/health");
const { GET: getDocumentRotation } = await loadRoute("admin/documents/rotation");
const { POST: retryDocumentJob } = await loadRoute("admin/operations/document-jobs/[jobId]");
const { POST: verifySmtp } = await loadRoute("admin/operations/smtp-test");
const { POST: verifyImap } = await loadRoute("admin/operations/imap-test");

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe("administrator operations evidence", () => {
  it("enforces signed-out, ordinary-user, administrator, no-store and CSRF boundaries", async () => {
    const fixture = await createIntegrationFixture("admin-evidence-matrix");
    const admin = await fixture.session("admin");
    const owner = await fixture.session("owner");

    await expectApiError(await callRoute(getOperations, { url: "http://127.0.0.1:3000/api/admin/operations" }), 401, "session_required");
    await expectApiError(await callRoute(getDocumentHealth, { url: "http://127.0.0.1:3000/api/admin/documents/health" }), 401, "session_required");
    await expectApiError(await callRoute(getDocumentRotation, { url: "http://127.0.0.1:3000/api/admin/documents/rotation" }), 401, "session_required");
    await expectApiError(await callRouteForSession(getOperations, owner, { url: "http://127.0.0.1:3000/api/admin/operations" }), 403, "administrator_required");
    await expectApiError(await callRouteForSession(getDocumentHealth, owner, { url: "http://127.0.0.1:3000/api/admin/documents/health" }), 403, "administrator_required");
    await expectApiError(await callRouteForSession(getDocumentRotation, owner, { url: "http://127.0.0.1:3000/api/admin/documents/rotation" }), 403, "administrator_required");

    const operations = await callRouteForSession(getOperations, admin, { url: "http://127.0.0.1:3000/api/admin/operations" });
    const health = await callRouteForSession(getDocumentHealth, admin, { url: "http://127.0.0.1:3000/api/admin/documents/health" });
    expect(operations.status).toBe(200);
    expect(health.status).toBe(200);
    expect(operations.headers.get("cache-control")).toBe("no-store");
    expect(health.headers.get("cache-control")).toBe("no-store");
    const operationsPayload = await json(operations);
    expect(operationsPayload.operations).toEqual(expect.objectContaining({
      configurationProblems: expect.any(Array),
    }));
    const healthText = JSON.stringify(await json(health));
    expect(healthText).not.toContain("keyId");
    expect(healthText).not.toContain("synthetic-key-id");

    // The rotation surface (#956): same administrator gate, same no-store,
    // same key-id boundary as documents/health above.
    const rotation = await callRouteForSession(getDocumentRotation, admin, { url: "http://127.0.0.1:3000/api/admin/documents/rotation" });
    expect(rotation.status).toBe(200);
    expect(rotation.headers.get("cache-control")).toBe("no-store");
    const rotationPayload = await json(rotation);
    expect(rotationPayload.rotation).toEqual(expect.objectContaining({
      inProgress: expect.any(Boolean),
      secondKeyLoaded: expect.any(Boolean),
    }));
    expect(JSON.stringify(rotationPayload)).not.toContain("keyId");

    const documentJobId = randomUUID();
    const mutationCases: Array<{
      name: string;
      body?: string;
      invoke: (session: IntegrationSession, headers?: Record<string, string>) => Promise<Response>;
      invokeWithoutSession: () => Promise<Response>;
    }> = [
      {
        name: "document-job",
        body: JSON.stringify({ action: "retry", expectedStatus: "failed" }),
        invoke: (session, headers) => callRouteForSession(retryDocumentJob, session, {
          url: "http://127.0.0.1:3000/api/admin/operations/document-job",
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ action: "retry", expectedStatus: "failed" }),
          params: { jobId: documentJobId },
        }),
        invokeWithoutSession: () => callRoute(retryDocumentJob, { url: "http://127.0.0.1:3000/api/admin/operations/document-jobs", method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "retry", expectedStatus: "failed" }), params: { jobId: documentJobId } }),
      },
      {
        name: "smtp",
        invoke: (session, headers) => callRouteForSession(verifySmtp, session, { url: "http://127.0.0.1:3000/api/admin/operations/smtp", method: "POST", headers }),
        invokeWithoutSession: () => callRoute(verifySmtp, { url: "http://127.0.0.1:3000/api/admin/operations/smtp-test", method: "POST" }),
      },
      {
        name: "imap",
        invoke: (session, headers) => callRouteForSession(verifyImap, session, { url: "http://127.0.0.1:3000/api/admin/operations/imap", method: "POST", headers }),
        invokeWithoutSession: () => callRoute(verifyImap, { url: "http://127.0.0.1:3000/api/admin/operations/imap-test", method: "POST" }),
      },
    ];
    const auditBeforeDeniedMutations = (await getDb().select({ id: auditLog.id }).from(auditLog)).length;
    for (const mutation of mutationCases) {
      await expectApiError(await mutation.invokeWithoutSession(), 401, "session_required");
      await expectApiError(await mutation.invoke(owner), 403, "administrator_required");
      for (const csrfValue of ["", "wrong-token"]) {
        await expectApiError(await mutation.invoke(admin, { "x-csrf-token": csrfValue }), 403, "csrf_failed");
      }
    }
    expect((await getDb().select({ id: auditLog.id }).from(auditLog)).length).toBe(auditBeforeDeniedMutations);
  });

  it("keeps the relay test's last answer (result and time) on the server across reads, so a reload can show it again (#1071)", async () => {
    // Moved from tests/e2e/v19-administration.spec.ts (#1612): the browser half was
    // only "reload and read it again"; the memory is the server's own. This asserts
    // the stored `result` and `at`; the pill word and reason drawn from them are
    // tests/unit/administration-mail-test-words.test.mjs.
    const fixture = await createIntegrationFixture("admin-evidence-relay-memory");
    const admin = await fixture.session("admin");
    const operationsUrl = "http://127.0.0.1:3000/api/admin/operations";
    type Probes = { mailProbes: { relay: { result: string; at: string } | null; mailbox: { result: string; at: string } | null } };
    const readProbes = async () =>
      (await json(await callRouteForSession(getOperations, admin, { url: operationsUrl }))).operations as Probes;

    const ran = await callRouteForSession(verifySmtp, admin, {
      url: "http://127.0.0.1:3000/api/admin/operations/smtp-test",
      method: "POST",
    });
    expect(ran.status).toBe(200);
    const { result } = await json(ran) as { result: string };
    // No relay is configured for the integration run, so the live answer is a bounded word,
    // and not one of the answers that mean "nothing was checked".
    expect(result).toBe("smtp_unconfigured");

    for (const _reload of [1, 2]) {
      const { mailProbes } = await readProbes();
      expect(mailProbes.relay?.result).toBe(result);
      expect(Number.isNaN(Date.parse(mailProbes.relay?.at ?? ""))).toBe(false);
    }
  });

  it("writes one audit event only for accepted exact-state corrective transitions", async () => {
    const fixture = await createIntegrationFixture("admin-evidence-corrections");
    const admin = await fixture.session("admin");
    const db = getDb();
    const [job] = await db.insert(documentJobs).values({
      documentId: fixture.document.id,
      kind: "purge",
      status: "failed",
      attempts: 5,
      lastError: "purge_failed",
    }).returning({ id: documentJobs.id });

    const wrongDocumentState = await callRouteForSession(retryDocumentJob, admin, {
      url: "http://127.0.0.1:3000/api/admin/operations/document-jobs",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "retry", expectedStatus: "retry" }),
      params: { jobId: job.id },
    });
    await expectApiError(wrongDocumentState, 409, "operation_conflict");
    const acceptedJob = await callRouteForSession(retryDocumentJob, admin, {
      url: "http://127.0.0.1:3000/api/admin/operations/document-jobs",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "retry", expectedStatus: "failed" }),
      params: { jobId: job.id },
    });
    expect(acceptedJob.status).toBe(200);
    const replayedJob = await callRouteForSession(retryDocumentJob, admin, {
      url: "http://127.0.0.1:3000/api/admin/operations/document-jobs",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "retry", expectedStatus: "failed" }),
      params: { jobId: job.id },
    });
    await expectApiError(replayedJob, 409, "operation_conflict");
    expect((await db.select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.entityId, job.id), eq(auditLog.action, "document_job_retried")))).length).toBe(1);
  });

  it("shows a scan job waiting on a structure check that reached no verdict by that code, not 'unknown' (D-S1)", async () => {
    const fixture = await createIntegrationFixture("admin-evidence-structure-check");
    const admin = await fixture.session("admin");
    const [job] = await getDb().insert(documentJobs).values({
      documentId: fixture.document.id,
      kind: "scan",
      status: "retry",
      attempts: 1,
      lastError: "structure_check_unavailable",
      nextAttemptAt: new Date(Date.now() + 60_000),
    }).returning({ id: documentJobs.id });

    const response = await callRouteForSession(getOperations, admin, { url: "http://127.0.0.1:3000/api/admin/operations" });
    expect(response.status).toBe(200);
    const payload = await json(response) as { operations: { documentJobs: Array<{ id: string; lastErrorCode: string | null }> } };
    expect(payload.operations.documentJobs.find((candidate) => candidate.id === job.id)?.lastErrorCode).toBe("structure_check_unavailable");
  });

  it("paginates equal timestamps without duplication and retains only safe post-purge labels", async () => {
    const fixture = await createIntegrationFixture("admin-evidence-pagination");
    const admin = await fixture.session("admin");
    const db = getDb();
    const createdAt = new Date("2030-01-01T00:00:00.000Z");
    const seededAuditRows = await db.insert(auditLog).values(Array.from({ length: 27 }, () => ({
      householdId: fixture.household.id,
      actorUserId: fixture.users.admin.id,
      entityType: "household",
      entityId: randomUUID(),
      action: "ownership_transferred",
      changes: { privateSecret: "synthetic-raw-change" },
      createdAt,
    }))).returning({ id: auditLog.id });
    const seededAuditIds = seededAuditRows.map(({ id }) => id);

    const firstPage = await callRouteForSession(getOperations, admin, { url: "http://127.0.0.1:3000/api/admin/operations" });
    expect(firstPage.status).toBe(200);
    const firstPayload = await json(firstPage) as { operations: { audit: Array<{ id: string }>; nextCursor: string | null } };
    expect(firstPayload.operations.audit).toHaveLength(25);
    expect(firstPayload.operations.nextCursor).toEqual(expect.any(String));
    const secondPage = await callRouteForSession(getOperations, admin, { url: `http://127.0.0.1:3000/api/admin/operations?auditCursor=${encodeURIComponent(firstPayload.operations.nextCursor!)}` });
    const secondPayload = await json(secondPage) as { operations: { audit: Array<{ id: string }>; nextCursor: string | null } };
    const firstPageIds = firstPayload.operations.audit.map(({ id }) => id);
    const secondPageIds = secondPayload.operations.audit.map(({ id }) => id);
    expect(new Set(firstPageIds).size).toBe(firstPageIds.length);
    expect(new Set(secondPageIds).size).toBe(secondPageIds.length);
    expect(new Set([...firstPageIds, ...secondPageIds]).size).toBe(firstPageIds.length + secondPageIds.length);
    const traversedSeededIds = [...firstPageIds, ...secondPageIds].filter((id) => seededAuditIds.includes(id));
    expect(traversedSeededIds).toHaveLength(seededAuditIds.length);
    expect([...new Set(traversedSeededIds)].sort()).toEqual([...seededAuditIds].sort());

    const privateName = fixture.household.name;
    await db.insert(auditLog).values({
      householdId: fixture.household.id,
      actorUserId: fixture.users.admin.id,
      entityType: "household",
      entityId: randomUUID(),
      action: "ownership_transferred",
      changes: { privateSecret: "synthetic-raw-change" },
      createdAt: new Date("2030-01-02T00:00:00.000Z"),
    });
    await db.delete(households).where(eq(households.id, fixture.household.id));
    const retained = await callRouteForSession(getOperations, admin, { url: "http://127.0.0.1:3000/api/admin/operations" });
    const retainedText = JSON.stringify(await json(retained));
    expect(retainedText).not.toContain(privateName);
    expect(retainedText).not.toContain("synthetic-raw-change");
    expect(retainedText).toContain("Household ownership transferred");
    expect(retainedText).toContain("Instance");
  });
});
