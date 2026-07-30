import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import {
  auditLog,
  documentJobs,
  documents,
  households,
  imapNotificationDeliveries,
  notificationDeliveries,
  users,
} from "@/db/schema";
import { AppError } from "@/lib/app-error";
import {
  getNotificationWorkerConfig,
  getNotificationWorkerHealth,
  notificationFailureCategories,
  verifySmtpProviderConnection,
} from "@/server/notification-worker";
import {
  getImapIngestionConfig,
  getImapIngestionWorkerHealth,
  getImapProviderPreflightState,
  verifyImapIngestionProviders,
} from "@/server/imap-ingestion";
import { requireInstanceAdministrator } from "@/server/authorization";

const uuidSchema = z.uuid();
const auditCursorSchema = z.object({
  createdAt: z.iso.datetime(),
  id: z.uuid(),
});
const documentFailureCodes = new Set([
  "key_unavailable",
  "purge_failed",
  "processing_interrupted",
  "storage_object_missing",
]);

const actionLabels: Record<string, string> = {
  notification_delivery_retried: "Notification delivery retried",
  notification_delivery_discarded: "Notification delivery discarded",
  document_job_retried: "Document maintenance job retried",
  document_job_discarded: "Document maintenance job discarded",
  imap_notification_delivery_retried: "Mailbox notification delivery retried",
  document_purged: "Document retention completed",
  document_storage_missing: "Missing document storage detected",
};

const providerVerificationState = globalThis as typeof globalThis & {
  __orbitAdminSmtpVerification?: { inFlight?: Promise<string>; lastStartedAt?: number };
  __orbitAdminImapVerification?: { inFlight?: Promise<string>; lastStartedAt?: number };
};

export interface AdminImapVerificationDependencies {
  now?: () => number;
  verify?: () => Promise<string>;
}

let adminImapVerificationDependenciesForTests: AdminImapVerificationDependencies | undefined;

/** Resets the process-local IMAP admin verification seam without persisting provider state. */
export function setImapProviderVerificationDependenciesForTests(dependencies: AdminImapVerificationDependencies | undefined): void {
  adminImapVerificationDependenciesForTests = dependencies;
  providerVerificationState.__orbitAdminImapVerification = undefined;
}

function boundedCounts(rows: Array<{ status: string; count: number }>): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

function safeNotificationFailure(value: string | null): string | null {
  if (!value) return null;
  return (notificationFailureCategories as readonly string[]).includes(value) ? value : "unknown";
}

function safeDocumentFailure(value: string | null): string | null {
  if (!value) return null;
  return documentFailureCodes.has(value) ? value : "unknown";
}

function decodeAuditCursor(value: string | undefined): { createdAt: Date; id: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed = auditCursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return { createdAt: new Date(parsed.createdAt), id: parsed.id };
  } catch {
    throw new AppError("invalid_cursor", "The audit cursor is invalid", 422);
  }
}

function encodeAuditCursor(entry: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ createdAt: entry.createdAt.toISOString(), id: entry.id })).toString("base64url");
}

/** Returns a bounded operations snapshot with no recipients, secrets, or raw provider errors. */
export async function getAdministratorOperations(actorUserId: string, auditCursor?: string) {
  await requireInstanceAdministrator(actorUserId);
  let config: ReturnType<typeof getNotificationWorkerConfig> | undefined;
  let notificationConfigError = false;
  try { config = getNotificationWorkerConfig(); } catch { notificationConfigError = true; }
  let imapConfig: ReturnType<typeof getImapIngestionConfig> | undefined;
  let imapConfigError = false;
  try { imapConfig = getImapIngestionConfig(); } catch { imapConfigError = true; }
  const decodedCursor = decodeAuditCursor(auditCursor);
  const auditQuery = getDb().select({
    id: auditLog.id,
    actorName: users.displayName,
    householdName: households.name,
    action: auditLog.action,
    createdAt: auditLog.createdAt,
  }).from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .leftJoin(households, eq(households.id, auditLog.householdId));
  const historyQuery = decodedCursor
    ? auditQuery.where(or(
      lt(auditLog.createdAt, decodedCursor.createdAt),
      and(eq(auditLog.createdAt, decodedCursor.createdAt), lt(auditLog.id, decodedCursor.id)),
    ))
    : auditQuery;
  const [
    deliveryCountRows,
    documentJobCountRows,
    deliveries,
    jobs,
    historyRows,
    mailboxNotificationCountRows,
  ] = await Promise.all([
    getDb().select({
      status: notificationDeliveries.status,
      count: sql<number>`count(*)::int`,
    }).from(notificationDeliveries).groupBy(notificationDeliveries.status),
    getDb().select({
      status: documentJobs.status,
      count: sql<number>`count(*)::int`,
    }).from(documentJobs).groupBy(documentJobs.status),
    getDb().select({
      id: notificationDeliveries.id,
      channel: notificationDeliveries.channel,
      status: notificationDeliveries.status,
      attempts: notificationDeliveries.attempts,
      scheduledFor: notificationDeliveries.scheduledFor,
      lastError: notificationDeliveries.lastError,
      updatedAt: notificationDeliveries.updatedAt,
    }).from(notificationDeliveries)
      .orderBy(desc(notificationDeliveries.updatedAt))
      .limit(25),
    getDb().select({
      id: documentJobs.id,
      kind: documentJobs.kind,
      status: documentJobs.status,
      attempts: documentJobs.attempts,
      lastError: documentJobs.lastError,
      createdAt: documentJobs.createdAt,
      updatedAt: documentJobs.updatedAt,
    }).from(documentJobs)
      .orderBy(desc(documentJobs.updatedAt))
      .limit(25),
    historyQuery
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(26),
    getDb().select({
      status: imapNotificationDeliveries.status,
      count: sql<number>`count(*)::int`,
    }).from(imapNotificationDeliveries).groupBy(imapNotificationDeliveries.status),
  ]);
  const history = historyRows.slice(0, 25);
  const mailboxCounts = boundedCounts(mailboxNotificationCountRows);
  const mailboxNotificationStatus = (mailboxCounts.failed ?? 0) > 0 ? "exhausted" as const
    : (mailboxCounts.retry ?? 0) > 0 ? "retrying" as const
      : "available" as const;

  const worker = getNotificationWorkerHealth();
  const imapWorker = getImapIngestionWorkerHealth();
  const preflight = getImapProviderPreflightState(imapConfig, config);
  return {
    notificationWorker: {
      started: worker.started,
      running: worker.running,
      lastSuccessAt: worker.lastSuccessAt,
      lastErrorAt: worker.lastErrorAt,
      lastErrorCode: worker.lastErrorCategory,
    },
    providers: {
      smtp: config?.smtpUrl ? "configured" as const : "unconfigured" as const,
      push: config?.vapidSubject && config.vapidPublicKey && config.vapidPrivateKey
        ? "configured" as const
        : "unconfigured" as const,
    },
    mailboxIngestion: {
      enabled: imapConfig?.enabled ?? false,
      configured: imapConfig?.configured ?? false,
      status: imapConfigError ? "unsafe_input" as const
        : notificationConfigError ? "unsafe_input" as const
        : imapConfig?.configured ? preflight.status : "not_configured" as const,
      smtp: notificationConfigError ? "unsafe_input" as const : preflight.smtp,
      imap: imapConfigError ? "unsafe_input" as const : preflight.imap,
      worker: {
        started: imapWorker.started,
        running: imapWorker.running,
        lastSuccessAt: imapWorker.lastSuccessAt,
        lastErrorAt: imapWorker.lastErrorAt,
        lastErrorCode: imapWorker.lastErrorCode,
      },
    },
    deliveryCounts: boundedCounts(deliveryCountRows),
    documentJobCounts: boundedCounts(documentJobCountRows),
    mailboxNotifications: { status: mailboxNotificationStatus },
    deliveries: deliveries.map(({ lastError, ...delivery }) => ({
      ...delivery,
      lastErrorCode: safeNotificationFailure(lastError),
    })),
    documentJobs: jobs.map(({ lastError, ...job }) => ({
      ...job,
      lastErrorCode: safeDocumentFailure(lastError),
    })),
    audit: history.map((entry) => ({
      id: entry.id,
      actorName: entry.actorName ?? "Orbit system",
      householdName: entry.householdName ?? "Instance",
      actionLabel: actionLabels[entry.action] ?? "Orbit administration activity",
      createdAt: entry.createdAt,
    })),
    nextCursor: historyRows.length > history.length && history.length
      ? encodeAuditCursor(history.at(-1)!)
      : null,
  };
}

type DeliveryAction = "retry" | "discard";
type DeliveryStatus = typeof notificationDeliveries.$inferSelect.status;

export async function updateNotificationDelivery(
  actorUserId: string,
  deliveryId: string,
  action: DeliveryAction,
  expectedStatus: DeliveryStatus,
): Promise<void> {
  if (!uuidSchema.safeParse(deliveryId).success) {
    throw new AppError("operation_conflict", "That operation is no longer available", 409);
  }
  await requireInstanceAdministrator(actorUserId);
  await getDb().transaction(async (transaction) => {
    const [record] = await transaction.select({
      householdId: notificationDeliveries.householdId,
      status: notificationDeliveries.status,
    }).from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, deliveryId))
      .for("update")
      .limit(1);
    const permitted = action === "retry"
      ? record?.status === expectedStatus && ["failed", "cancelled"].includes(expectedStatus)
      : record?.status === expectedStatus && ["pending", "retry", "failed"].includes(expectedStatus);
    if (!record || !permitted) {
      throw new AppError("operation_conflict", "That operation is no longer available", 409);
    }

    await transaction.update(notificationDeliveries).set(action === "retry" ? {
      status: "pending",
      attempts: 0,
      scheduledFor: new Date(),
      lockedAt: null,
      leaseToken: null,
      lastError: null,
      sentAt: null,
      updatedAt: new Date(),
    } : {
      status: "cancelled",
      lockedAt: null,
      leaseToken: null,
      lastError: null,
      updatedAt: new Date(),
    }).where(and(
      eq(notificationDeliveries.id, deliveryId),
      eq(notificationDeliveries.status, expectedStatus),
    ));
    await transaction.insert(auditLog).values({
      householdId: record.householdId,
      actorUserId,
      entityType: "notification_delivery",
      entityId: deliveryId,
      action: action === "retry" ? "notification_delivery_retried" : "notification_delivery_discarded",
      changes: { previousStatus: expectedStatus },
    });
  });
}

type DocumentJobAction = "retry" | "discard";
type DocumentJobStatus = typeof documentJobs.$inferSelect.status;

export async function updateDocumentJob(
  actorUserId: string,
  jobId: string,
  action: DocumentJobAction,
  expectedStatus: DocumentJobStatus,
): Promise<void> {
  if (!uuidSchema.safeParse(jobId).success) {
    throw new AppError("operation_conflict", "That operation is no longer available", 409);
  }
  await requireInstanceAdministrator(actorUserId);
  await getDb().transaction(async (transaction) => {
    const [record] = await transaction.select({
      householdId: documents.householdId,
      status: documentJobs.status,
    }).from(documentJobs)
      .innerJoin(documents, eq(documents.id, documentJobs.documentId))
      .where(eq(documentJobs.id, jobId))
      .for("update")
      .limit(1);
    if (!record || record.status !== expectedStatus || expectedStatus !== "failed") {
      throw new AppError("operation_conflict", "That operation is no longer available", 409);
    }

    await transaction.update(documentJobs).set(action === "retry" ? {
      status: "pending",
      attempts: 0,
      lockedAt: null,
      leaseExpiresAt: null,
      leaseToken: null,
      lastError: null,
      completedAt: null,
      updatedAt: new Date(),
    } : {
      status: "cancelled",
      lockedAt: null,
      leaseExpiresAt: null,
      leaseToken: null,
      lastError: null,
      completedAt: null,
      updatedAt: new Date(),
    }).where(and(eq(documentJobs.id, jobId), eq(documentJobs.status, expectedStatus)));
    await transaction.insert(auditLog).values({
      householdId: record.householdId,
      actorUserId,
      entityType: "document_job",
      entityId: jobId,
      action: action === "retry" ? "document_job_retried" : "document_job_discarded",
      changes: { previousStatus: expectedStatus },
    });
  });
}

/** Verifies SMTP connectivity/authentication without sending a message. */
export async function verifySmtpProvider(actorUserId: string): Promise<{ result: string }> {
  await requireInstanceAdministrator(actorUserId);
  const now = Date.now();
  if (providerVerificationState.__orbitAdminSmtpVerification?.inFlight) return { result: "verification_pending" };
  if (providerVerificationState.__orbitAdminSmtpVerification?.lastStartedAt && now - providerVerificationState.__orbitAdminSmtpVerification.lastStartedAt < 1_000) return { result: "retrying" };
  const inFlight = (async () => {
    try {
      return await verifySmtpProviderConnection(getNotificationWorkerConfig());
    } catch {
      return "unsafe_input";
    }
  })();
  providerVerificationState.__orbitAdminSmtpVerification = { inFlight, lastStartedAt: now };
  try {
    return { result: await inFlight };
  } finally {
    const state = providerVerificationState.__orbitAdminSmtpVerification;
    if (state?.inFlight === inFlight) providerVerificationState.__orbitAdminSmtpVerification = { lastStartedAt: now };
  }
}

/** Retries only terminal content-free mailbox notifications, in a bounded batch. */
export async function retryExhaustedImapNotifications(actorUserId: string): Promise<{ queued: number }> {
  await requireInstanceAdministrator(actorUserId);
  return getDb().transaction(async (transaction) => {
    const candidates = await transaction.select({ id: imapNotificationDeliveries.id }).from(imapNotificationDeliveries)
      .where(eq(imapNotificationDeliveries.status, "failed"))
      .orderBy(imapNotificationDeliveries.updatedAt)
      .limit(25)
      .for("update", { skipLocked: true });
    const rows = candidates.length ? await transaction.update(imapNotificationDeliveries).set({
      status: "retry",
      attempts: 0,
      nextAttemptAt: new Date(),
      lockedAt: null,
      leaseToken: null,
      failureCode: null,
      updatedAt: new Date(),
    }).where(and(eq(imapNotificationDeliveries.status, "failed"), inArray(imapNotificationDeliveries.id, candidates.map((row) => row.id)))).returning({ id: imapNotificationDeliveries.id }) : [];
    await transaction.insert(auditLog).values({
      householdId: null,
      actorUserId,
      entityType: "imap_notification_delivery",
      entityId: randomUUID(),
      action: "imap_notification_delivery_retried",
      changes: { previousStatus: "failed", count: rows.length },
    });
    return { queued: rows.length };
  });
}

/** Administrator-only bounded preflight for the independent IMAP provider. */
export async function verifyImapIngestionProvider(actorUserId: string): Promise<{ result: string }> {
  await requireInstanceAdministrator(actorUserId);
  const now = adminImapVerificationDependenciesForTests?.now?.() ?? Date.now();
  const current = providerVerificationState.__orbitAdminImapVerification;
  if (current?.inFlight) return { result: "verification_pending" };
  if (current?.lastStartedAt !== undefined && now - current.lastStartedAt < 1_000) return { result: "retrying" };
  const inFlight = (async () => {
    try {
      if (adminImapVerificationDependenciesForTests?.verify) return await adminImapVerificationDependenciesForTests.verify();
      const state = await verifyImapIngestionProviders(getImapIngestionConfig(), getNotificationWorkerConfig());
      return state.status;
    } catch {
      return "unsafe_input";
    }
  })();
  providerVerificationState.__orbitAdminImapVerification = { inFlight, lastStartedAt: now };
  try {
    return { result: await inFlight };
  } catch {
    return { result: "unsafe_input" };
  } finally {
    const state = providerVerificationState.__orbitAdminImapVerification;
    if (state?.inFlight === inFlight) providerVerificationState.__orbitAdminImapVerification = { lastStartedAt: now };
  }
}
