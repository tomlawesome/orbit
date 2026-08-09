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
import { GET as getOperations } from "@/app/api/admin/operations/route";
import { GET as getDocumentHealth } from "@/app/api/admin/documents/health/route";
import { POST as retryDelivery } from "@/app/api/admin/operations/deliveries/[deliveryId]/route";
import { POST as retryDocumentJob } from "@/app/api/admin/operations/document-jobs/[jobId]/route";
import { POST as verifySmtp } from "@/app/api/admin/operations/smtp-test/route";
import { POST as verifyImap } from "@/app/api/admin/operations/imap-test/route";
import { POST as retryMailboxNotifications } from "@/app/api/admin/operations/mailbox-notifications/route";
import {
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
  requestForSession,
  requestWithoutSession,
} from "./support/fixtures";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

function deliveryContext(deliveryId: string) {
  return { params: Promise.resolve({ deliveryId }) };
}

function documentJobContext(jobId: string) {
  return { params: Promise.resolve({ jobId }) };
}

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

    await expectError(await getOperations(requestWithoutSession("http://127.0.0.1:3000/api/admin/operations")), 401, "session_required");
    await expectError(await getDocumentHealth(requestWithoutSession("http://127.0.0.1:3000/api/admin/documents/health")), 401, "session_required");
    await expectError(await getOperations(requestForSession(owner, "http://127.0.0.1:3000/api/admin/operations")), 403, "administrator_required");
    await expectError(await getDocumentHealth(requestForSession(owner, "http://127.0.0.1:3000/api/admin/documents/health")), 403, "administrator_required");

    const operations = await getOperations(requestForSession(admin, "http://127.0.0.1:3000/api/admin/operations"));
    const health = await getDocumentHealth(requestForSession(admin, "http://127.0.0.1:3000/api/admin/documents/health"));
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
      invoke: (request: ReturnType<typeof requestForSession>) => Promise<Response>;
      invokeWithoutSession: () => Promise<Response>;
    }> = [
      {
        name: "delivery",
        body: JSON.stringify({ action: "retry", expectedStatus: "failed" }),
        invoke: (request) => retryDelivery(request, deliveryContext(deliveryId)),
        invokeWithoutSession: () => retryDelivery(requestWithoutSession("http://127.0.0.1:3000/api/admin/operations/deliveries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "retry", expectedStatus: "failed" }) }), deliveryContext(deliveryId)),
      },
      {
        name: "document-job",
        body: JSON.stringify({ action: "retry", expectedStatus: "failed" }),
        invoke: (request) => retryDocumentJob(request, documentJobContext(documentJobId)),
        invokeWithoutSession: () => retryDocumentJob(requestWithoutSession("http://127.0.0.1:3000/api/admin/operations/document-jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "retry", expectedStatus: "failed" }) }), documentJobContext(documentJobId)),
      },
      {
        name: "smtp",
        invoke: (request) => verifySmtp(request),
        invokeWithoutSession: () => verifySmtp(requestWithoutSession("http://127.0.0.1:3000/api/admin/operations/smtp-test", { method: "POST" })),
      },
      {
        name: "imap",
        invoke: (request) => verifyImap(request),
        invokeWithoutSession: () => verifyImap(requestWithoutSession("http://127.0.0.1:3000/api/admin/operations/imap-test", { method: "POST" })),
      },
      {
        name: "mailbox-notification",
        body: JSON.stringify({ action: "retry_exhausted" }),
        invoke: (request) => retryMailboxNotifications(request),
        invokeWithoutSession: () => retryMailboxNotifications(requestWithoutSession("http://127.0.0.1:3000/api/admin/operations/mailbox-notifications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "retry_exhausted" }) })),
      },
    ];
    const auditBeforeDeniedMutations = (await getDb().select({ id: auditLog.id }).from(auditLog)).length;
    for (const mutation of mutationCases) {
      await expectError(await mutation.invokeWithoutSession(), 401, "session_required");
      const ordinaryRequest = requestForSession(owner, `http://127.0.0.1:3000/api/admin/operations/${mutation.name}`, { method: "POST", headers: mutation.body ? { "content-type": "application/json" } : undefined, body: mutation.body });
      await expectError(await mutation.invoke(ordinaryRequest), 403, "administrator_required");
      for (const csrfValue of ["", "wrong-token"]) {
        const csrfRequest = requestForSession(admin, `http://127.0.0.1:3000/api/admin/operations/${mutation.name}`, { method: "POST", headers: { ...(mutation.body ? { "content-type": "application/json" } : {}), "x-csrf-token": csrfValue }, body: mutation.body });
        await expectError(await mutation.invoke(csrfRequest), 403, "csrf_failed");
      }
    }
    expect((await getDb().select({ id: auditLog.id }).from(auditLog)).length).toBe(auditBeforeDeniedMutations);
  });

  it("writes one audit event only for accepted exact-state corrective transitions", async () => {
    const fixture = await createIntegrationFixture("admin-evidence-corrections");
    const admin = await fixture.session("admin");
    const db = getDb();
    const beforeEmptyMailboxRetry = (await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.action, "imap_notification_delivery_retried"))).length;
    const emptyMailboxRetry = await retryMailboxNotifications(requestForSession(admin, "http://127.0.0.1:3000/api/admin/operations/mailbox-notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "retry_exhausted" }),
    }));
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
    await expectError(await retryDelivery(requestForSession(admin, "http://127.0.0.1:3000/api/admin/operations/deliveries/invalid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "retry", expectedStatus: "failed" }),
    }), deliveryContext("invalid")), 409, "operation_conflict");
    expect((await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.entityId, delivery.id))).length).toBe(beforeDeliveryAudit);

    const acceptedDelivery = await retryDelivery(requestForSession(admin, "http://127.0.0.1:3000/api/admin/operations/deliveries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "retry", expectedStatus: "failed" }),
    }), deliveryContext(delivery.id));
    expect(acceptedDelivery.status).toBe(200);
    expect(acceptedDelivery.headers.get("cache-control")).toBe("no-store");
    const replayedDelivery = await retryDelivery(requestForSession(admin, "http://127.0.0.1:3000/api/admin/operations/deliveries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "retry", expectedStatus: "failed" }),
    }), deliveryContext(delivery.id));
    await expectError(replayedDelivery, 409, "operation_conflict");
    expect((await db.select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.entityId, delivery.id), eq(auditLog.action, "notification_delivery_retried")))).length).toBe(1);

    const wrongDocumentState = await retryDocumentJob(requestForSession(admin, "http://127.0.0.1:3000/api/admin/operations/document-jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "retry", expectedStatus: "retry" }),
    }), documentJobContext(job.id));
    await expectError(wrongDocumentState, 409, "operation_conflict");
    const acceptedJob = await retryDocumentJob(requestForSession(admin, "http://127.0.0.1:3000/api/admin/operations/document-jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "retry", expectedStatus: "failed" }),
    }), documentJobContext(job.id));
    expect(acceptedJob.status).toBe(200);
    const replayedJob = await retryDocumentJob(requestForSession(admin, "http://127.0.0.1:3000/api/admin/operations/document-jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "retry", expectedStatus: "failed" }),
    }), documentJobContext(job.id));
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

    const firstPage = await getOperations(requestForSession(admin, "http://127.0.0.1:3000/api/admin/operations"));
    expect(firstPage.status).toBe(200);
    const firstPayload = await json(firstPage) as { operations: { audit: Array<{ id: string }>; nextCursor: string | null } };
    expect(firstPayload.operations.audit).toHaveLength(25);
    expect(firstPayload.operations.nextCursor).toEqual(expect.any(String));
    const secondPage = await getOperations(requestForSession(admin, `http://127.0.0.1:3000/api/admin/operations?auditCursor=${encodeURIComponent(firstPayload.operations.nextCursor!)}`));
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
    const retained = await getOperations(requestForSession(admin, "http://127.0.0.1:3000/api/admin/operations"));
    const retainedText = JSON.stringify(await json(retained));
    expect(retainedText).not.toContain(privateName);
    expect(retainedText).not.toContain("synthetic-raw-change");
    expect(retainedText).toContain("Household ownership transferred");
    expect(retainedText).toContain("Instance");
  });
});
