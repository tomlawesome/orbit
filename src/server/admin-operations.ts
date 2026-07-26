import nodemailer from "nodemailer";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import {
  auditLog,
  documentJobs,
  documents,
  households,
  notificationDeliveries,
  users,
} from "@/db/schema";
import { AppError } from "@/lib/app-error";
import {
  categorizeProviderError,
  getNotificationWorkerConfig,
  getNotificationWorkerHealth,
  notificationFailureCategories,
} from "@/server/notification-worker";
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
  document_purged: "Document retention completed",
  document_storage_missing: "Missing document storage detected",
};

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
  const config = getNotificationWorkerConfig();
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
  ]);
  const history = historyRows.slice(0, 25);

  const worker = getNotificationWorkerHealth();
  return {
    notificationWorker: {
      started: worker.started,
      running: worker.running,
      lastSuccessAt: worker.lastSuccessAt,
      lastErrorAt: worker.lastErrorAt,
      lastErrorCode: worker.lastErrorCategory,
    },
    providers: {
      smtp: config.smtpUrl ? "configured" as const : "unconfigured" as const,
      push: config.vapidSubject && config.vapidPublicKey && config.vapidPrivateKey
        ? "configured" as const
        : "unconfigured" as const,
    },
    deliveryCounts: boundedCounts(deliveryCountRows),
    documentJobCounts: boundedCounts(documentJobCountRows),
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
  const config = getNotificationWorkerConfig();
  if (!config.smtpUrl) return { result: "smtp_unconfigured" };
  const transporter = nodemailer.createTransport(config.smtpUrl, {
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 5_000,
  });
  try {
    await transporter.verify();
    return { result: "ready" };
  } catch (error) {
    return { result: categorizeProviderError("email", error) };
  } finally {
    transporter.close();
  }
}
