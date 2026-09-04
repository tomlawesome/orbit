import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import {
  auditLog,
  documentJobs,
  dueEvents,
  households,
  notificationDeliveries,
} from "@/db/schema";
import {
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
  type IntegrationSession,
} from "./support/fixtures";
import { callRoute, callRouteForSession, loadRoute } from "./support/request-event";

const { GET: getOperations } = await loadRoute("admin/operations");
const { GET: getDocumentHealth } = await loadRoute("admin/documents/health");
const { POST: retryDelivery } = await loadRoute("admin/operations/deliveries/[deliveryId]");
const { POST: retryDocumentJob } = await loadRoute("admin/operations/document-jobs/[jobId]");
const { POST: verifySmtp } = await loadRoute("admin/operations/smtp-test");
const { POST: verifyImap } = await loadRoute("admin/operations/imap-test");
const { POST: retryMailboxNotifications } = await loadRoute("admin/operations/mailbox-notifications");

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await json(response)).error).toEqual(expect.objectContaining({ code }));
}

describe("administrator operations evidence", () => {
  it("enforces signed-out, ordinary-user, administrator, no-store and CSRF boundaries", async () => {
    const fixture = await createIntegrationFixture("admin-evidence-matrix");
    const admin = await fixture.session("admin");
    const owner = await fixture.session("owner");

    await expectError(await callRoute(getOperations, { url: "http://127.0.0.1:3000/api/admin/operations" }), 401, "session_required");
    await expectError(await callRoute(getDocumentHealth, { url: "http://127.0.0.1:3000/api/admin/documents/health" }), 401, "session_required");
    await expectError(await callRouteForSession(getOperations, owner, { url: "http://127.0.0.1:3000/api/admin/operations" }), 403, "administrator_required");
    await expectError(await callRouteForSession(getDocumentHealth, owner, { url: "http://127.0.0.1:3000/api/admin/documents/health" }), 403, "administrator_required");

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

    const deliveryId = randomUUID();
    const documentJobId = randomUUID();
    const mutationCases: Array<{
      name: string;
      body?: string;
      invoke: (session: IntegrationSession, headers?: Record<string, string>) => Promise<Response>;
      invokeWithoutSession: () => Promise<Response>;
    }> = [
      {
        name: "delivery",
        body: JSON.stringify({ action: "retry", expectedStatus: "failed" }),
        invoke: (session, headers) => callRouteForSession(retryDelivery, session, {
          url: "http://127.0.0.1:3000/api/admin/operations/delivery",
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ action: "retry", expectedStatus: "failed" }),
          params: { deliveryId },
        }),
        invokeWithoutSession: () => callRoute(retryDelivery, { url: "http://127.0.0.1:3000/api/admin/operations/deliveries", method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "retry", expectedStatus: "failed" }), params: { deliveryId } }),
      },
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
      {
        name: "mailbox-notification",
        body: JSON.stringify({ action: "retry_exhausted" }),
        invoke: (session, headers) => callRouteForSession(retryMailboxNotifications, session, {
          url: "http://127.0.0.1:3000/api/admin/operations/mailbox-notification",
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ action: "retry_exhausted" }),
        }),
        invokeWithoutSession: () => callRoute(retryMailboxNotifications, { url: "http://127.0.0.1:3000/api/admin/operations/mailbox-notifications", method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "retry_exhausted" }) }),
      },
    ];
    const auditBeforeDeniedMutations = (await getDb().select({ id: auditLog.id }).from(auditLog)).length;
    for (const mutation of mutationCases) {
      await expectError(await mutation.invokeWithoutSession(), 401, "session_required");
      await expectError(await mutation.invoke(owner), 403, "administrator_required");
      for (const csrfValue of ["", "wrong-token"]) {
        await expectError(await mutation.invoke(admin, { "x-csrf-token": csrfValue }), 403, "csrf_failed");
      }
    }
    expect((await getDb().select({ id: auditLog.id }).from(auditLog)).length).toBe(auditBeforeDeniedMutations);
  });

  it("writes one audit event only for accepted exact-state corrective transitions", async () => {
    const fixture = await createIntegrationFixture("admin-evidence-corrections");
    const admin = await fixture.session("admin");
    const db = getDb();
    const beforeEmptyMailboxRetry = (await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.action, "imap_notification_delivery_retried"))).length;
    const emptyMailboxRetry = await callRouteForSession(retryMailboxNotifications, admin, {
      url: "http://127.0.0.1:3000/api/admin/operations/mailbox-notifications",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "retry_exhausted" }),
    });
    expect(emptyMailboxRetry.status).toBe(200);
    expect(emptyMailboxRetry.headers.get("cache-control")).toBe("no-store");
    expect(await json(emptyMailboxRetry)).toEqual({ queued: 0 });
    expect((await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.action, "imap_notification_delivery_retried"))).length).toBe(beforeEmptyMailboxRetry);

    const [event] = await db.insert(dueEvents).values({
      householdId: fixture.household.id,
      itemId: fixture.item.id,
      kind: "renewal",
      dueDate: "2030-01-01",
    }).returning({ id: dueEvents.id });
    const [delivery] = await db.insert(notificationDeliveries).values({
      householdId: fixture.household.id,
      eventId: event.id,
      userId: fixture.users.admin.id,
      channel: "email",
      scheduledFor: new Date(),
      status: "failed",
      attempts: 5,
      lastError: "smtp_unavailable",
    }).returning({ id: notificationDeliveries.id });
    const [job] = await db.insert(documentJobs).values({
      documentId: fixture.document.id,
      kind: "purge",
      status: "failed",
      attempts: 5,
      lastError: "purge_failed",
    }).returning({ id: documentJobs.id });

    const beforeDeliveryAudit = (await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.entityId, delivery.id))).length;
    await expectError(await callRouteForSession(retryDelivery, admin, {
      url: "http://127.0.0.1:3000/api/admin/operations/deliveries/invalid",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "retry", expectedStatus: "failed" }),
      params: { deliveryId: "invalid" },
    }), 409, "operation_conflict");
    expect((await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.entityId, delivery.id))).length).toBe(beforeDeliveryAudit);

    const acceptedDelivery = await callRouteForSession(retryDelivery, admin, {
      url: "http://127.0.0.1:3000/api/admin/operations/deliveries",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "retry", expectedStatus: "failed" }),
      params: { deliveryId: delivery.id },
    });
    expect(acceptedDelivery.status).toBe(200);
    expect(acceptedDelivery.headers.get("cache-control")).toBe("no-store");
    const replayedDelivery = await callRouteForSession(retryDelivery, admin, {
      url: "http://127.0.0.1:3000/api/admin/operations/deliveries",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "retry", expectedStatus: "failed" }),
      params: { deliveryId: delivery.id },
    });
    await expectError(replayedDelivery, 409, "operation_conflict");
    expect((await db.select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.entityId, delivery.id), eq(auditLog.action, "notification_delivery_retried")))).length).toBe(1);

    const wrongDocumentState = await callRouteForSession(retryDocumentJob, admin, {
      url: "http://127.0.0.1:3000/api/admin/operations/document-jobs",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "retry", expectedStatus: "retry" }),
      params: { jobId: job.id },
    });
    await expectError(wrongDocumentState, 409, "operation_conflict");
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
    await expectError(replayedJob, 409, "operation_conflict");
    expect((await db.select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.entityId, job.id), eq(auditLog.action, "document_job_retried")))).length).toBe(1);
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
