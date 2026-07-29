import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import {
  auditLog,
  households,
  imapIngestionAttachments,
  imapIngestionMessages,
  items,
  memberships,
  sections,
  users,
} from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { type HomeItem } from "@/lib/domain";
import { workspaceItemSchema } from "@/lib/workspace";
import { readHeldImapAttachment, purgeHeldImapAttachment } from "@/server/imap-attachment-holding";
import { uploadItemDocument } from "@/server/document-repository";
import { applyWorkspaceCommand } from "@/server/workspace-repository";

const proposalFields = [
  "title",
  "subtype",
  "provider",
  "reference",
  "costMinor",
  "currency",
  "dueDate",
  "scheduleKind",
  "recurrenceMonths",
] as const;
type ProposalField = typeof proposalFields[number];

const evidenceSource = z.enum(["filename", "document_text", "parser", "attachment"]);
const evidenceConfidence = z.enum(["high", "medium", "low"]);
const proposalTextMaximum: Record<string, number> = {
  title: 100,
  subtype: 80,
  provider: 100,
  reference: 80,
  currency: 3,
  dueDate: 10,
  scheduleKind: 8,
};

const approvalSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("direct_upload") }),
  z.object({
    kind: z.literal("mailbox_draft"),
    receiptId: z.uuid(),
    draftVersion: z.number().int().positive(),
  }),
]);

/** Client input contains final values only; the authoritative item schema is applied by the service. */
export const reviewedIntakeApprovalSchema = z.object({
  operationId: z.uuid(),
  source: approvalSourceSchema,
  householdId: z.uuid(),
  sectionId: z.uuid(),
  action: z.enum(["create_separate", "attach_existing"]),
  targetItemId: z.uuid().optional(),
  item: z.record(z.string(), z.unknown()),
  attachmentIds: z.array(z.uuid()).max(10).refine((ids) => new Set(ids).size === ids.length, "Duplicate attachment identity"),
}).superRefine((value, context) => {
  if (value.action === "attach_existing" && !value.targetItemId) {
    context.addIssue({ code: "custom", path: ["targetItemId"], message: "An existing item is required" });
  }
  if (value.action === "create_separate" && value.targetItemId) {
    context.addIssue({ code: "custom", path: ["targetItemId"], message: "A new item cannot target an existing item" });
  }
});

export type ReviewedIntakeApproval = z.infer<typeof reviewedIntakeApprovalSchema>;
type MailboxApproval = ReviewedIntakeApproval & {
  source: Extract<ReviewedIntakeApproval["source"], { kind: "mailbox_draft" }>;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  return normalized && normalized.length <= maximum && !/[<>]/u.test(normalized) ? normalized : undefined;
}

function boundedProposalField(field: ProposalField, value: unknown): unknown {
  if (["title", "subtype", "provider", "reference", "currency", "dueDate", "scheduleKind"].includes(field)) {
    const text = boundedText(value, proposalTextMaximum[field]);
    if (!text) return undefined;
    if (field === "currency" && !/^[A-Z]{3}$/u.test(text)) return undefined;
    if (field === "dueDate" && !/^\d{4}-\d{2}-\d{2}$/u.test(text)) return undefined;
    if (field === "scheduleKind" && !["renewal", "service"].includes(text)) return undefined;
    return text;
  }
  if (field === "costMinor" && typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000) return value;
  if (field === "recurrenceMonths" && typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 120) return value;
  return undefined;
}

/** Keeps only bounded fields and coarse provenance; raw extraction never enters durable metadata. */
export function sanitizeReviewDraftMetadata(input: unknown): {
  proposal: Record<string, unknown>;
  fieldEvidence: Record<string, { source: string; confidence: string }>;
} {
  const source = record(input);
  const proposalInput = record(source?.proposal);
  const proposal: Record<string, unknown> = {};
  for (const field of proposalFields) {
    const value = boundedProposalField(field, proposalInput?.[field]);
    if (value !== undefined) proposal[field] = value;
  }

  const evidenceInput = record(source?.fieldEvidence);
  const fieldEvidence: Record<string, { source: string; confidence: string }> = {};
  for (const field of proposalFields) {
    const candidate = record(evidenceInput?.[field]);
    const parsed = z.object({ source: evidenceSource, confidence: evidenceConfidence }).safeParse(candidate);
    if (parsed.success) fieldEvidence[field] = parsed.data;
  }
  return { proposal, fieldEvidence };
}

function approvalHash(input: ReviewedIntakeApproval): string {
  const canonical = {
    operationId: input.operationId,
    source: input.source,
    householdId: input.householdId,
    sectionId: input.sectionId,
    action: input.action,
    targetItemId: input.targetItemId ?? null,
    item: input.item,
    attachmentIds: [...input.attachmentIds].sort(),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function notFound(): AppError {
  return new AppError("reviewed_intake_not_found", "That reviewed intake is not available", 404);
}

async function requireActiveUser(userId: string): Promise<void> {
  const [user] = await getDb().select({ id: users.id }).from(users)
    .where(and(eq(users.id, userId), isNull(users.disabledAt))).limit(1);
  if (!user) throw new AppError("account_disabled", "This Orbit account cannot approve reviewed intake", 403);
}

async function requireDestination(userId: string, householdId: string, sectionId: string, targetItemId: string | undefined): Promise<void> {
  const [destination] = await getDb().select({ householdId: memberships.householdId })
    .from(memberships).innerJoin(households, eq(households.id, memberships.householdId))
    .where(and(
      eq(memberships.userId, userId),
      eq(memberships.householdId, householdId),
      isNull(households.deletionRequestedAt),
    )).limit(1);
  if (!destination) throw new AppError("household_not_found", "That household is not available", 404);

  const [section] = await getDb().select({ id: sections.id }).from(sections)
    .where(and(eq(sections.id, sectionId), eq(sections.householdId, householdId), eq(sections.visible, true), isNull(sections.archivedAt))).limit(1);
  if (!section) throw new AppError("section_not_found", "That section is not available", 404);

  if (targetItemId) {
    const [target] = await getDb().select({ id: items.id }).from(items)
      .where(and(eq(items.id, targetItemId), eq(items.householdId, householdId))).limit(1);
    if (!target) throw new AppError("item_not_found", "That item is not available", 404);
  }
}

function reviewedItem(input: ReviewedIntakeApproval, itemId: string): HomeItem {
  return workspaceItemSchema.parse({
    ...input.item,
    id: itemId,
    sectionId: input.sectionId,
    version: 1,
    status: "active",
    updatedAt: new Date().toISOString(),
  });
}

async function createReviewedItem(userId: string, input: ReviewedIntakeApproval): Promise<string> {
  const itemId = input.operationId;
  const [existing] = await getDb().select({ id: items.id, householdId: items.householdId }).from(items).where(eq(items.id, itemId)).limit(1);
  if (existing) {
    if (existing.householdId !== input.householdId) throw new AppError("reviewed_intake_conflict", "That approval identity is already in use", 409);
    return existing.id;
  }
  const item = reviewedItem(input, itemId);
  await applyWorkspaceCommand(userId, "reviewed-intake", {
    type: "item.upsert",
    householdId: input.householdId,
    item,
    activity: {
      id: input.operationId,
      itemId,
      kind: "created",
      occurredAt: new Date().toISOString(),
    },
  });
  return itemId;
}

type ApprovalOutcome = {
  outcome: "approved" | "partial_success";
  itemId: string;
  approvalResultId: string;
  attachedAttachmentIds: string[];
  pendingAttachmentIds: string[];
};

async function receiptAttachments(receiptId: string, selectedIds: string[]) {
  const rows = await getDb().select().from(imapIngestionAttachments)
    .where(eq(imapIngestionAttachments.messageId, receiptId));
  const selected = selectedIds.length ? new Set(selectedIds) : new Set(rows.map((row) => row.id));
  const selectedRows = rows.filter((row) => selected.has(row.id));
  if (selectedRows.length !== selected.size) throw new AppError("attachment_not_found", "That staged attachment is not available", 404);
  if (selectedRows.some((row) => row.status === "rejected")) throw new AppError("attachment_not_found", "That staged attachment is not available", 404);
  return selectedRows;
}

async function purgeReceiptStaging(receiptId: string): Promise<void> {
  const attachments = await getDb().select({ id: imapIngestionAttachments.id, storageKey: imapIngestionAttachments.storageKey })
    .from(imapIngestionAttachments).where(and(
      eq(imapIngestionAttachments.messageId, receiptId),
      inArray(imapIngestionAttachments.status, ["stored", "assigned"]),
    ));
  for (const attachment of attachments) await purgeHeldImapAttachment(attachment.storageKey);
}

async function transferAttachments(userId: string, householdId: string, itemId: string, receiptId: string, selectedIds: string[]): Promise<{ attached: string[]; pending: string[]; failureCode?: string }> {
  const attachments = await receiptAttachments(receiptId, selectedIds);
  const attached: string[] = [];
  const pending: string[] = [];
  let failureCode: string | undefined;
  for (const attachment of attachments) {
    if (attachment.status === "assigned" && attachment.assignedDocumentId) {
      attached.push(attachment.id);
      continue;
    }
    if (attachment.status !== "stored") {
      pending.push(attachment.id);
      failureCode ??= "attachment_state_invalid";
      continue;
    }
    let bytes: Buffer | undefined;
    try {
      bytes = await readHeldImapAttachment({
        id: attachment.id,
        mediaType: attachment.mediaType,
        sizeBytes: attachment.sizeBytes,
        storageKey: attachment.storageKey,
        envelope: {
          envelopeVersion: attachment.envelopeVersion as 1,
          algorithm: "aes-256-gcm",
          contentIv: attachment.contentIv,
          contentAuthTag: attachment.contentAuthTag,
          wrappedDek: attachment.wrappedDek,
          wrapIv: attachment.wrapIv,
          wrapAuthTag: attachment.wrapAuthTag,
          keyId: attachment.keyId,
        },
      });
      const document = await uploadItemDocument({
        userId,
        householdId,
        itemId,
        filename: attachment.displayName,
        body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
        declaredBytes: attachment.sizeBytes,
      });
      await getDb().update(imapIngestionAttachments).set({
        status: "assigned",
        assignedDocumentId: document.id,
        updatedAt: new Date(),
      }).where(and(eq(imapIngestionAttachments.id, attachment.id), eq(imapIngestionAttachments.status, "stored")));
      try {
        await purgeHeldImapAttachment(attachment.storageKey);
      } catch {
        attached.push(attachment.id);
        failureCode ??= "staging_purge_failed";
        continue;
      }
      attached.push(attachment.id);
    } catch {
      pending.push(attachment.id);
      failureCode ??= "attachment_transfer_failed";
    } finally {
      bytes?.fill(0);
    }
  }
  return { attached, pending, failureCode };
}

async function finishMailboxApproval(
  userId: string,
  input: MailboxApproval,
  requestHash: string,
): Promise<ApprovalOutcome> {
  const result = await getDb().transaction(async (transaction) => {
    const [receipt] = await transaction.select().from(imapIngestionMessages)
      .where(and(eq(imapIngestionMessages.id, input.source.receiptId), eq(imapIngestionMessages.userId, userId))).for("update").limit(1);
    if (!receipt) throw notFound();
    if (receipt.approvalOperationId) {
      if (receipt.approvalOperationId !== input.operationId || receipt.approvalRequestSha256 !== requestHash) {
        throw new AppError("reviewed_intake_conflict", "That approval identity was already used", 409);
      }
      if (receipt.status === "completed" && receipt.approvedItemId && receipt.approvalResultId) {
        return { receipt, claimed: false, result: {
          outcome: "approved" as const,
          itemId: receipt.approvedItemId,
          approvalResultId: receipt.approvalResultId,
          attachedAttachmentIds: [],
          pendingAttachmentIds: [],
        } };
      }
      if (receipt.expiresAt <= new Date()) {
        await transaction.update(imapIngestionMessages).set({ status: "expired", expiredAt: new Date(), updatedAt: new Date() }).where(eq(imapIngestionMessages.id, receipt.id));
        return { receipt, claimed: false, expired: true, result: undefined };
      }
      return { receipt, claimed: false, result: undefined };
    }
    if (!["pending_review", "recoverable", "approving"].includes(receipt.status)) throw new AppError("reviewed_intake_not_approvable", "That reviewed intake is no longer available", 409);
    if (!receipt.householdId || receipt.householdId !== input.householdId) throw notFound();
    if (receipt.status === "pending_review" && receipt.draftVersion !== input.source.draftVersion) {
      throw new AppError("reviewed_intake_stale", "That reviewed intake changed; refresh and try again", 409);
    }
    if (receipt.expiresAt <= new Date()) {
      await transaction.update(imapIngestionMessages).set({ status: "expired", expiredAt: new Date(), updatedAt: new Date() }).where(eq(imapIngestionMessages.id, receipt.id));
      return { receipt, claimed: false, expired: true, result: undefined };
    }
    const approvalResultId = randomUUID();
    await transaction.update(imapIngestionMessages).set({
      status: "approving",
      draftVersion: receipt.draftVersion + 1,
      approvalOperationId: input.operationId,
      approvalResultId,
      approvalRequestSha256: requestHash,
      approvalStartedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(imapIngestionMessages.id, receipt.id), isNull(imapIngestionMessages.approvalOperationId)));
    return { receipt: { ...receipt, approvalResultId }, claimed: true, result: undefined };
  });

  if (result.expired) {
    try {
      await purgeReceiptStaging(input.source.receiptId);
    } catch {
      await getDb().update(imapIngestionMessages).set({ status: "recoverable", failureCode: "staging_purge_failed", updatedAt: new Date() }).where(eq(imapIngestionMessages.id, input.source.receiptId));
      throw new AppError("staging_purge_failed", "The expired private staging could not be purged; retry later", 503);
    }
    throw new AppError("reviewed_intake_expired", "That reviewed intake has expired", 409);
  }
  if (result.result) {
    const assigned = await getDb().select({ id: imapIngestionAttachments.id }).from(imapIngestionAttachments)
      .where(and(eq(imapIngestionAttachments.messageId, input.source.receiptId), eq(imapIngestionAttachments.status, "assigned")));
    return { ...result.result, attachedAttachmentIds: assigned.map((row) => row.id) };
  }
  const itemId = input.action === "create_separate" ? await createReviewedItem(userId, input) : input.targetItemId!;
  await getDb().update(imapIngestionMessages).set({ approvedItemId: itemId, updatedAt: new Date() })
    .where(and(eq(imapIngestionMessages.id, input.source.receiptId), eq(imapIngestionMessages.approvalOperationId, input.operationId)));

  const transferred = await transferAttachments(userId, input.householdId, itemId, input.source.receiptId, input.attachmentIds);
  const approvalResultId = result.receipt.approvalResultId!;
  const partial = Boolean(transferred.failureCode || transferred.pending.length);
  await getDb().transaction(async (transaction) => {
    await transaction.update(imapIngestionMessages).set({
      status: partial ? "recoverable" : "completed",
      failureCode: partial ? transferred.failureCode ?? "attachment_transfer_failed" : null,
      approvedItemId: itemId,
      approvedAt: partial ? null : new Date(),
      updatedAt: new Date(),
    }).where(and(eq(imapIngestionMessages.id, input.source.receiptId), eq(imapIngestionMessages.approvalOperationId, input.operationId)));
    await transaction.insert(auditLog).values({
      householdId: input.householdId,
      actorUserId: userId,
      entityType: "reviewed_intake",
      entityId: approvalResultId,
      action: partial ? "reviewed_intake_partial" : "reviewed_intake_approved",
      changes: {
        source: "mailbox_draft",
        action: input.action,
        itemId,
        result: partial ? "retryable" : "completed",
      },
    }).onConflictDoNothing();
  });
  return {
    outcome: partial ? "partial_success" : "approved",
    itemId,
    approvalResultId,
    attachedAttachmentIds: transferred.attached,
    pendingAttachmentIds: transferred.pending,
  };
}

async function finishDirectApproval(userId: string, input: ReviewedIntakeApproval, requestHash: string): Promise<ApprovalOutcome> {
  const [existing] = await getDb().select({ actorUserId: auditLog.actorUserId, changes: auditLog.changes }).from(auditLog).where(and(
    eq(auditLog.entityType, "reviewed_intake"),
    eq(auditLog.entityId, input.operationId),
  )).orderBy(desc(auditLog.createdAt)).limit(1);
  if (existing) {
    if (existing.actorUserId !== userId) throw new AppError("reviewed_intake_conflict", "That approval identity was already used", 409);
    const changes = existing.changes as { requestHash?: string; itemId?: string; result?: string };
    if (changes.requestHash !== requestHash) throw new AppError("reviewed_intake_conflict", "That approval identity was already used", 409);
    return {
      outcome: changes.result === "retryable" ? "partial_success" : "approved",
      itemId: changes.itemId!,
      approvalResultId: input.operationId,
      attachedAttachmentIds: [],
      pendingAttachmentIds: [],
    };
  }
  const itemId = input.action === "create_separate" ? await createReviewedItem(userId, input) : input.targetItemId!;
  await getDb().insert(auditLog).values({
    householdId: input.householdId,
    actorUserId: userId,
    entityType: "reviewed_intake",
    entityId: input.operationId,
    action: "reviewed_intake_approved",
    changes: { source: "direct_upload", action: input.action, itemId, result: "completed", requestHash },
  }).onConflictDoNothing();
  return { outcome: "approved", itemId, approvalResultId: input.operationId, attachedAttachmentIds: [], pendingAttachmentIds: [] };
}

/** One authorization, idempotency, and reviewed-value boundary for both sources. */
export async function approveReviewedIntake(userId: string, rawInput: unknown): Promise<ApprovalOutcome> {
  const input = reviewedIntakeApprovalSchema.parse(rawInput);
  await requireActiveUser(userId);
  await requireDestination(userId, input.householdId, input.sectionId, input.targetItemId);
  const requestHash = approvalHash(input);
  if (input.source.kind === "mailbox_draft") return finishMailboxApproval(userId, input as MailboxApproval, requestHash);
  return finishDirectApproval(userId, input, requestHash);
}

export async function listStagedAttachmentIds(receiptId: string): Promise<string[]> {
  const rows = await getDb().select({ id: imapIngestionAttachments.id }).from(imapIngestionAttachments)
    .where(and(eq(imapIngestionAttachments.messageId, receiptId), inArray(imapIngestionAttachments.status, ["stored", "assigned"])));
  return rows.map((row) => row.id);
}
