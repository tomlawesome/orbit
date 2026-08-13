import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import {
  auditLog,
  dueEvents,
  documents,
  households,
  imapIngestionAttachments,
  imapIngestionMessages,
  items,
  memberships,
  reviewedIntakeOperations,
  reminderRules,
  sections,
  users,
} from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { type HomeItem } from "@/lib/domain";
import { workspaceItemSchema } from "@/lib/workspace";
import { readHeldImapAttachment, purgeHeldImapAttachment } from "@/server/imap-attachment-holding";
import { isDocumentAvailable, uploadItemDocument } from "@/server/document-repository";
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
  z.object({ kind: z.literal("direct_upload"), expectedDocument: z.boolean().default(false) }),
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
type DirectApproval = ReviewedIntakeApproval & {
  source: Extract<ReviewedIntakeApproval["source"], { kind: "direct_upload" }>;
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

function canonicalItem(input: ReviewedIntakeApproval, itemId: string): HomeItem {
  return workspaceItemSchema.parse({
    ...input.item,
    id: itemId,
    sectionId: input.sectionId,
    version: 1,
    status: "active",
    updatedAt: "1970-01-01T00:00:00.000Z",
  });
}

function canonicalItemValues(input: ReviewedIntakeApproval): Record<string, unknown> {
  const item = canonicalItem(input, input.operationId);
  return {
    id: item.id,
    sectionId: item.sectionId,
    title: item.title,
    subtype: item.subtype ?? null,
    provider: item.provider ?? null,
    reference: item.reference ?? null,
    costMinor: item.costMinor ?? null,
    currency: item.currency,
    dueDate: item.dueDate ?? null,
    scheduleKind: item.scheduleKind ?? null,
    recurrenceMonths: item.recurrenceMonths ?? null,
    reminderDays: [...(item.reminderDays ?? [])].sort((left, right) => left - right),
    snoozedUntil: item.snoozedUntil ?? null,
    notes: item.notes ?? null,
    status: item.status,
  };
}

export function canonicalReviewedIntakeHash(input: ReviewedIntakeApproval): string {
  const canonical = {
    operationId: input.operationId,
    source: input.source.kind === "direct_upload"
      ? { kind: input.source.kind, expectedDocument: input.source.expectedDocument }
      : { kind: input.source.kind, receiptId: input.source.receiptId, draftVersion: input.source.draftVersion },
    householdId: input.householdId,
    sectionId: input.sectionId,
    action: input.action,
    targetItemId: input.targetItemId ?? null,
    item: canonicalItemValues(input),
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

async function requirePrivateMailboxRecipient(userId: string): Promise<void> {
  const [user] = await getDb().select({ id: users.id, isInstanceAdmin: users.isInstanceAdmin }).from(users)
    .where(and(eq(users.id, userId), isNull(users.disabledAt))).limit(1);
  if (!user || user.isInstanceAdmin) throw notFound();
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
  return { ...canonicalItem(input, itemId), updatedAt: new Date().toISOString() };
}

async function reviewedItemMatches(input: ReviewedIntakeApproval, itemId: string): Promise<boolean | undefined> {
  const [existing] = await getDb().select().from(items).where(eq(items.id, itemId)).limit(1);
  if (!existing) return undefined;
  const expected = reviewedItem(input, itemId);
    const [event] = await getDb().select({ kind: dueEvents.kind, dueDate: dueEvents.dueDate }).from(dueEvents)
      .where(and(eq(dueEvents.itemId, itemId), isNull(dueEvents.completedAt))).limit(1);
    const reminders = await getDb().select({ daysBefore: reminderRules.daysBefore }).from(reminderRules)
      .where(eq(reminderRules.itemId, itemId));
    const persisted = {
      id: existing.id,
      sectionId: existing.sectionId,
      title: existing.title,
      subtype: existing.subtype ?? undefined,
      provider: existing.provider ?? undefined,
      reference: existing.reference ?? undefined,
      costMinor: existing.costMinor ?? undefined,
      currency: existing.currency,
      dueDate: event?.dueDate ?? existing.serviceDate ?? existing.renewalDate ?? undefined,
      scheduleKind: event?.kind ?? (existing.serviceDate ? "service" : existing.renewalDate ? "renewal" : undefined),
      recurrenceMonths: existing.recurrenceMonths ?? undefined,
      reminderDays: reminders.map((row) => row.daysBefore).sort((left, right) => left - right),
      snoozedUntil: existing.snoozedUntil ?? undefined,
      notes: existing.notes ?? undefined,
      status: existing.status,
    };
    const comparableExpected = {
      id: expected.id,
      sectionId: expected.sectionId,
      title: expected.title,
      subtype: expected.subtype,
      provider: expected.provider,
      reference: expected.reference,
      costMinor: expected.costMinor,
      currency: expected.currency,
      dueDate: expected.dueDate,
      scheduleKind: expected.scheduleKind,
      recurrenceMonths: expected.recurrenceMonths,
      reminderDays: [...(expected.reminderDays ?? [])].sort((left, right) => left - right),
      snoozedUntil: expected.snoozedUntil,
      notes: expected.notes,
      status: expected.status,
    };
    const same = existing.householdId === input.householdId && JSON.stringify(persisted) === JSON.stringify(comparableExpected);
  return same;
}

async function createReviewedItem(userId: string, input: ReviewedIntakeApproval, itemId: string): Promise<string> {
  const existingMatch = await reviewedItemMatches(input, itemId);
  if (existingMatch !== undefined) {
    if (!existingMatch) throw new AppError("reviewed_intake_conflict", "That approval identity is already in use", 409);
    return itemId;
  }
  const item = reviewedItem(input, itemId);
  try {
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
  } catch (error) {
    // The command is authoritative and owns its transaction. If another
    // caller won the item PK race, accept only the exact canonical persisted
    // value; unrelated collisions and other failures remain conflicts.
    const reloadedMatch = await reviewedItemMatches(input, itemId);
    if (reloadedMatch === true) return itemId;
    if (reloadedMatch === false) throw new AppError("reviewed_intake_conflict", "That approval identity is already in use", 409);
    throw error;
  }
  return itemId;
}

type ApprovalOutcome = {
  outcome: "approved" | "partial_success";
  itemId: string;
  approvalResultId: string;
  attachmentState: "not_requested" | "pending" | "attached";
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
  const attachments = await getDb().select({ id: imapIngestionAttachments.id, storageKey: imapIngestionAttachments.storageKey, status: imapIngestionAttachments.status })
    .from(imapIngestionAttachments).where(and(
      eq(imapIngestionAttachments.messageId, receiptId),
      inArray(imapIngestionAttachments.status, ["stored", "assigned"]),
    ));
  let failed = false;
  for (const attachment of attachments) {
    try {
      await purgeHeldImapAttachment(attachment.storageKey);
      await getDb().update(imapIngestionAttachments).set({ purgePending: false, purgeFailureCode: null, updatedAt: new Date() })
        .where(and(eq(imapIngestionAttachments.id, attachment.id), eq(imapIngestionAttachments.status, attachment.status)));
    } catch {
      failed = true;
      await getDb().update(imapIngestionAttachments).set({ purgePending: true, purgeAttempts: sql`${imapIngestionAttachments.purgeAttempts} + 1`, purgeFailureCode: "staging_purge_failed", updatedAt: new Date() })
        .where(eq(imapIngestionAttachments.id, attachment.id));
    }
  }
  if (failed) throw new AppError("staging_purge_failed", "The private staged file could not be purged; retry later", 503);
}

async function transferAttachments(userId: string, householdId: string, itemId: string, receiptId: string, selectedIds: string[]): Promise<{ attached: string[]; pending: string[]; failureCode?: string }> {
  const attachments = await receiptAttachments(receiptId, selectedIds);
  const attached: string[] = [];
  const pending: string[] = [];
  let failureCode: string | undefined;
  attachmentLoop: for (const candidate of attachments) {
    const [attachment] = await getDb().select().from(imapIngestionAttachments).where(eq(imapIngestionAttachments.id, candidate.id)).limit(1);
    if (!attachment) {
      pending.push(candidate.id);
      failureCode ??= "attachment_state_invalid";
      continue;
    }
    if (attachment.status === "assigned" && attachment.assignedDocumentId && !attachment.purgePending) {
      attached.push(attachment.id);
      continue;
    }
    if (attachment.status === "assigned" && attachment.assignedDocumentId && attachment.purgePending) {
      // The document assigned on a previous attempt may still be in scanner
      // recovery (or have since been rejected); only the fully durable
      // `available` document makes the held mail copy redundant. Purging
      // here regardless of that state is #383 finding 4 in its retry form:
      // it would destroy the only remaining copy while recovery is still in
      // flight. Leave the attachment `assigned`/`purgePending` untouched so
      // a later retry, once the document is available, purges safely.
      if (!await isDocumentAvailable(attachment.assignedDocumentId)) {
        pending.push(attachment.id);
        failureCode ??= "scanner_unavailable";
        continue;
      }
      try {
        await purgeHeldImapAttachment(attachment.storageKey);
        const [cleared] = await getDb().update(imapIngestionAttachments).set({ purgePending: false, purgeFailureCode: null, updatedAt: new Date() })
          .where(and(eq(imapIngestionAttachments.id, attachment.id), eq(imapIngestionAttachments.status, "assigned"), eq(imapIngestionAttachments.assignedDocumentId, attachment.assignedDocumentId))).returning({ id: imapIngestionAttachments.id });
        if (!cleared) throw new AppError("attachment_state_changed", "That staged attachment changed; retry later", 503);
        attached.push(attachment.id);
      } catch {
        pending.push(attachment.id);
        failureCode ??= "staging_purge_failed";
        await getDb().update(imapIngestionAttachments).set({ purgePending: true, purgeAttempts: sql`${imapIngestionAttachments.purgeAttempts} + 1`, purgeFailureCode: "staging_purge_failed", updatedAt: new Date() })
          .where(and(eq(imapIngestionAttachments.id, attachment.id), eq(imapIngestionAttachments.status, "assigned"), eq(imapIngestionAttachments.assignedDocumentId, attachment.assignedDocumentId)));
      }
      continue;
    }
    if (attachment.status !== "stored") {
      pending.push(attachment.id);
      failureCode ??= "attachment_state_invalid";
      continue;
    }
    const claim = async () => {
      const token = randomUUID();
      const [row] = await getDb().update(imapIngestionAttachments).set({
        transferClaimToken: token,
        transferClaimedAt: new Date(),
        transferLeaseExpiresAt: new Date(Date.now() + 5 * 60_000),
        updatedAt: new Date(),
      }).where(and(
        eq(imapIngestionAttachments.id, attachment.id),
        eq(imapIngestionAttachments.status, "stored"),
        or(isNull(imapIngestionAttachments.transferClaimToken), lt(imapIngestionAttachments.transferLeaseExpiresAt, new Date())),
      )).returning({ id: imapIngestionAttachments.id, token: imapIngestionAttachments.transferClaimToken });
      return row ? { row, token } : undefined;
    };
    let claimed = await claim();
    for (let attempt = 0; !claimed && attempt < 40; attempt += 1) {
      const [latest] = await getDb().select().from(imapIngestionAttachments).where(eq(imapIngestionAttachments.id, attachment.id)).limit(1);
      if (!latest) break;
      if (latest.status === "assigned" && latest.assignedDocumentId && !latest.purgePending) {
        attached.push(latest.id);
        continue attachmentLoop;
      }
      if (latest.status === "assigned" && latest.assignedDocumentId && latest.purgePending) {
        // Same recovery-in-flight guard as above (#383 finding 4): a
        // concurrent claimant may have assigned this attachment to a
        // document that is not yet available.
        if (!await isDocumentAvailable(latest.assignedDocumentId)) {
          pending.push(latest.id);
          failureCode ??= "scanner_unavailable";
          continue attachmentLoop;
        }
        try {
          await purgeHeldImapAttachment(latest.storageKey);
          const [cleared] = await getDb().update(imapIngestionAttachments).set({ purgePending: false, purgeFailureCode: null, updatedAt: new Date() })
            .where(and(eq(imapIngestionAttachments.id, latest.id), eq(imapIngestionAttachments.status, "assigned"), eq(imapIngestionAttachments.assignedDocumentId, latest.assignedDocumentId))).returning({ id: imapIngestionAttachments.id });
          if (!cleared) throw new AppError("attachment_state_changed", "That staged attachment changed; retry later", 503);
          attached.push(latest.id);
        } catch {
          pending.push(latest.id);
          failureCode ??= "staging_purge_failed";
        }
        continue attachmentLoop;
      }
      if (latest.status !== "stored") break;
      if (latest.transferClaimToken && latest.transferLeaseExpiresAt && latest.transferLeaseExpiresAt > new Date()) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      } else {
        claimed = await claim();
      }
    }
    if (!claimed) {
      pending.push(attachment.id);
      failureCode ??= "attachment_transfer_in_progress";
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
      }, { recipientUserId: userId, receiptId });
      const document = await uploadItemDocument({
        userId,
        householdId,
        itemId,
        filename: attachment.displayName,
        body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
        declaredBytes: attachment.sizeBytes,
        documentId: attachment.id,
      });
      const [assignedRow] = await getDb().update(imapIngestionAttachments).set({
        status: "assigned",
        assignedDocumentId: document.id,
        transferClaimToken: null,
        transferClaimedAt: null,
        transferLeaseExpiresAt: null,
        purgePending: true,
        purgeFailureCode: null,
        updatedAt: new Date(),
      }).where(and(eq(imapIngestionAttachments.id, attachment.id), eq(imapIngestionAttachments.status, "stored"), eq(imapIngestionAttachments.transferClaimToken, claimed.token))).returning({ id: imapIngestionAttachments.id });
      if (!assignedRow) {
        pending.push(attachment.id);
        failureCode ??= "attachment_state_changed";
        continue;
      }
      if (document.recoverable) {
        // The scanner is unavailable and `uploadItemDocument` staged this
        // upload for outage recovery rather than completing it (#383
        // finding 4): the attachment is left `assigned`/`purgePending` so a
        // later retry can purge once the document reaches `available`, but
        // the held mail-side copy is the only durable copy right now and
        // must not be destroyed, and the approval must not be reported as
        // attached.
        pending.push(attachment.id);
        failureCode ??= "scanner_unavailable";
        continue;
      }
      try {
        await purgeHeldImapAttachment(attachment.storageKey);
        const [purged] = await getDb().update(imapIngestionAttachments).set({ purgePending: false, purgeFailureCode: null, updatedAt: new Date() })
          .where(and(eq(imapIngestionAttachments.id, attachment.id), eq(imapIngestionAttachments.status, "assigned"), eq(imapIngestionAttachments.assignedDocumentId, document.id), eq(imapIngestionAttachments.purgePending, true))).returning({ id: imapIngestionAttachments.id });
        if (!purged) {
          pending.push(attachment.id);
          failureCode ??= "attachment_state_changed";
          continue;
        }
      } catch {
        attached.push(attachment.id);
        pending.push(attachment.id);
        failureCode ??= "staging_purge_failed";
        await getDb().update(imapIngestionAttachments).set({ purgePending: true, purgeAttempts: sql`${imapIngestionAttachments.purgeAttempts} + 1`, purgeFailureCode: "staging_purge_failed", updatedAt: new Date() })
          .where(and(eq(imapIngestionAttachments.id, attachment.id), eq(imapIngestionAttachments.status, "assigned"), eq(imapIngestionAttachments.assignedDocumentId, document.id)));
        continue;
      }
      attached.push(attachment.id);
    } catch {
      await getDb().update(imapIngestionAttachments).set({ transferClaimToken: null, transferClaimedAt: null, transferLeaseExpiresAt: null, updatedAt: new Date() })
        .where(and(eq(imapIngestionAttachments.id, attachment.id), eq(imapIngestionAttachments.status, "stored"), eq(imapIngestionAttachments.transferClaimToken, claimed.token)));
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
          attachmentState: "attached" as const,
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
    if (receipt.status !== "pending_review") throw new AppError("reviewed_intake_not_approvable", "That reviewed intake is no longer available", 409);
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
  const itemId = input.action === "create_separate" ? await createReviewedItem(userId, input, input.operationId) : input.targetItemId!;
  await getDb().update(imapIngestionMessages).set({ approvedItemId: itemId, updatedAt: new Date() })
    .where(and(eq(imapIngestionMessages.id, input.source.receiptId), eq(imapIngestionMessages.approvalOperationId, input.operationId)));

  const transferred = await transferAttachments(userId, input.householdId, itemId, input.source.receiptId, input.attachmentIds);
  const approvalResultId = result.receipt.approvalResultId!;
  const partial = Boolean(transferred.failureCode || transferred.pending.length);
  let effectivePartial = partial;
  await getDb().transaction(async (transaction) => {
    const [changed] = await transaction.update(imapIngestionMessages).set({
      status: partial ? "recoverable" : "completed",
      failureCode: partial ? transferred.failureCode ?? "attachment_transfer_failed" : null,
      approvedItemId: itemId,
      approvedAt: partial ? null : new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(imapIngestionMessages.id, input.source.receiptId),
      eq(imapIngestionMessages.approvalOperationId, input.operationId),
      or(eq(imapIngestionMessages.status, "approving"), eq(imapIngestionMessages.status, "recoverable")),
    )).returning({ status: imapIngestionMessages.status });
    if (!changed) {
      const [current] = await transaction.select({ status: imapIngestionMessages.status }).from(imapIngestionMessages)
        .where(and(eq(imapIngestionMessages.id, input.source.receiptId), eq(imapIngestionMessages.approvalOperationId, input.operationId))).limit(1);
      effectivePartial = current?.status !== "completed";
    }
    await transaction.insert(auditLog).values({
      id: approvalResultId,
      householdId: input.householdId,
      actorUserId: userId,
      entityType: "reviewed_intake",
      entityId: approvalResultId,
      action: effectivePartial ? "reviewed_intake_partial" : "reviewed_intake_approved",
      changes: {
        source: "mailbox_draft",
        action: input.action,
        itemId,
        result: effectivePartial ? "retryable" : "completed",
      },
    }).onConflictDoUpdate({ target: auditLog.id, set: {
      action: effectivePartial ? "reviewed_intake_partial" : "reviewed_intake_approved",
      changes: {
        source: "mailbox_draft",
        action: input.action,
        itemId,
        result: effectivePartial ? "retryable" : "completed",
      },
    } });
  });
  return {
    outcome: effectivePartial ? "partial_success" : "approved",
    itemId,
    approvalResultId,
    attachmentState: effectivePartial ? "pending" : "attached",
    attachedAttachmentIds: transferred.attached,
    pendingAttachmentIds: transferred.pending,
  };
}

async function readOrCreateDirectOperation(userId: string, input: DirectApproval, requestHash: string) {
  return getDb().transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`orbit:reviewed-intake:${input.operationId}`}, 0))`);
    const [existing] = await transaction.select().from(reviewedIntakeOperations)
      .where(eq(reviewedIntakeOperations.id, input.operationId)).for("update").limit(1);
    if (existing) {
      if (existing.actorUserId !== userId
        || existing.source !== "direct_upload"
        || existing.householdId !== input.householdId
        || existing.sectionId !== input.sectionId
        || existing.action !== input.action
        || existing.targetItemId !== (input.targetItemId ?? null)
        || existing.requestSha256 !== requestHash
        || existing.expectedDocument !== input.source.expectedDocument) {
        throw new AppError("reviewed_intake_conflict", "That approval identity was already used", 409);
      }
      return existing;
    }
    if (input.action === "create_separate") {
      const [collision] = await transaction.select({ id: items.id }).from(items).where(eq(items.id, input.operationId)).limit(1);
      if (collision) throw new AppError("reviewed_intake_conflict", "That approval identity is already in use", 409);
    }
    const [created] = await transaction.insert(reviewedIntakeOperations).values({
      id: input.operationId,
      actorUserId: userId,
      source: "direct_upload",
      householdId: input.householdId,
      sectionId: input.sectionId,
      action: input.action,
      targetItemId: input.targetItemId ?? null,
      itemId: input.action === "create_separate" ? input.operationId : input.targetItemId!,
      requestSha256: requestHash,
      resultId: randomUUID(),
      expectedDocument: input.source.expectedDocument,
      attachmentState: input.source.expectedDocument ? "pending" : "not_requested",
      status: input.source.expectedDocument ? "pending_attachment" : "processing",
    }).returning();
    return created;
  });
}

async function finishDirectApproval(userId: string, input: DirectApproval, requestHash: string): Promise<ApprovalOutcome> {
  const operation = await readOrCreateDirectOperation(userId, input, requestHash);
  if (operation.status === "completed") {
    return {
      outcome: "approved",
      itemId: operation.itemId,
      approvalResultId: operation.resultId,
      attachmentState: operation.attachmentState,
      attachedAttachmentIds: [],
      pendingAttachmentIds: [],
    };
  }
  const itemId = input.action === "create_separate" ? await createReviewedItem(userId, input, operation.itemId) : operation.itemId;
  const completed = !operation.expectedDocument;
  const [updated] = await getDb().update(reviewedIntakeOperations).set({
    status: completed ? "completed" : "pending_attachment",
    attachmentState: completed ? "not_requested" : "pending",
    completedAt: completed ? new Date() : null,
    updatedAt: new Date(),
  }).where(and(eq(reviewedIntakeOperations.id, operation.id), eq(reviewedIntakeOperations.itemId, itemId))).returning();
  if (!updated) throw new AppError("reviewed_intake_conflict", "That approval identity changed; retry later", 409);
  await getDb().insert(auditLog).values({
    id: operation.resultId,
    householdId: input.householdId,
    actorUserId: userId,
    entityType: "reviewed_intake",
    entityId: operation.resultId,
    action: completed ? "reviewed_intake_approved" : "reviewed_intake_pending_document",
    changes: { source: "direct_upload", action: input.action, itemId, result: completed ? "completed" : "pending_document" },
  }).onConflictDoNothing();
  return {
    outcome: completed ? "approved" : "partial_success",
    itemId,
    approvalResultId: operation.resultId,
    attachmentState: completed ? "not_requested" : "pending",
    attachedAttachmentIds: [],
    pendingAttachmentIds: [],
  };
}

/** Completes a direct document-assisted operation only after the secure route has made the document durable. */
export async function completeDirectReviewedUpload(userId: string, operationId: string, householdId: string, itemId: string, documentId: string): Promise<void> {
  const changed = await getDb().transaction(async (transaction) => {
    const [operation] = await transaction.select().from(reviewedIntakeOperations)
      .where(eq(reviewedIntakeOperations.id, operationId)).for("update").limit(1);
    if (!operation || operation.actorUserId !== userId || operation.source !== "direct_upload" || operation.householdId !== householdId || operation.itemId !== itemId || !operation.expectedDocument) {
      throw new AppError("reviewed_intake_not_found", "That reviewed intake is not available", 404);
    }
    if (operation.status === "completed") {
      if (operation.documentId !== documentId) throw new AppError("reviewed_intake_conflict", "That approval identity was already used", 409);
      return true;
    }
    const [document] = await transaction.select({ id: documents.id }).from(documents).where(and(
      eq(documents.id, documentId),
      eq(documents.householdId, householdId),
      eq(documents.itemId, itemId),
      eq(documents.lifecycle, "available"),
    )).limit(1);
    if (!document) throw new AppError("reviewed_intake_recoverable", "That reviewed document is not available yet", 503);
    const [updated] = await transaction.update(reviewedIntakeOperations).set({
      status: "completed",
      attachmentState: "attached",
      documentId,
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(reviewedIntakeOperations.id, operationId), or(
      eq(reviewedIntakeOperations.status, "pending_attachment"),
      eq(reviewedIntakeOperations.status, "recoverable"),
    ))).returning({ id: reviewedIntakeOperations.id });
    if (!updated) throw new AppError("reviewed_intake_conflict", "That approval identity changed; retry later", 409);
    await transaction.insert(auditLog).values({
      id: operation.resultId,
      householdId,
      actorUserId: userId,
      entityType: "reviewed_intake",
      entityId: operation.resultId,
      action: "reviewed_intake_approved",
      changes: { source: "direct_upload", result: "completed", itemId, documentId },
    }).onConflictDoUpdate({ target: auditLog.id, set: {
      action: "reviewed_intake_approved",
      changes: { source: "direct_upload", result: "completed", itemId, documentId },
    } });
    return true;
  });
  if (changed) return;
}

/** Links an outage-recoverable direct upload without pretending it is attached. */
export async function recordDirectReviewedUploadPending(
  userId: string,
  operationId: string,
  householdId: string,
  itemId: string,
  documentId: string,
  failureCode: string | null,
): Promise<void> {
  await getDb().transaction(async (transaction) => {
    const [operation] = await transaction.select().from(reviewedIntakeOperations)
      .where(eq(reviewedIntakeOperations.id, operationId)).for("update").limit(1);
    if (!operation || operation.actorUserId !== userId || operation.source !== "direct_upload"
      || operation.householdId !== householdId || operation.itemId !== itemId || !operation.expectedDocument) {
      throw new AppError("reviewed_intake_not_found", "That reviewed intake is not available", 404);
    }
    if (operation.status === "completed") {
      if (operation.documentId !== documentId) throw new AppError("reviewed_intake_conflict", "That approval identity was already used", 409);
      return;
    }
    const [document] = await transaction.select({ id: documents.id, lifecycle: documents.lifecycle })
      .from(documents).where(and(eq(documents.id, documentId), eq(documents.householdId, householdId), eq(documents.itemId, itemId))).limit(1);
    if (!document || document.lifecycle !== "scanning") {
      throw new AppError("reviewed_intake_recoverable", "That reviewed document is not available yet", 503);
    }
    await transaction.update(reviewedIntakeOperations).set({
      status: "recoverable",
      attachmentState: "pending",
      documentId,
      failureCode: failureCode ?? "scanner_unavailable",
      updatedAt: new Date(),
    }).where(and(eq(reviewedIntakeOperations.id, operationId), or(
      eq(reviewedIntakeOperations.status, "pending_attachment"),
      eq(reviewedIntakeOperations.status, "recoverable"),
    )));
    await transaction.insert(auditLog).values({
      id: operation.resultId,
      householdId,
      actorUserId: userId,
      entityType: "reviewed_intake",
      entityId: operation.resultId,
      action: "reviewed_intake_pending_document",
      changes: { source: "direct_upload", result: "scanner_recovery", itemId },
    }).onConflictDoUpdate({ target: auditLog.id, set: {
      action: "reviewed_intake_pending_document",
      changes: { source: "direct_upload", result: "scanner_recovery", itemId },
    } });
  });
}

export async function authorizeDirectReviewedUpload(userId: string, operationId: string, householdId: string, itemId: string): Promise<{ documentId?: string }> {
  const [operation] = await getDb().select().from(reviewedIntakeOperations)
    .where(eq(reviewedIntakeOperations.id, operationId)).limit(1);
  if (!operation || operation.actorUserId !== userId || operation.source !== "direct_upload" || operation.householdId !== householdId || operation.itemId !== itemId || !operation.expectedDocument) {
    throw new AppError("reviewed_intake_not_found", "That reviewed intake is not available", 404);
  }
  if (operation.status === "completed") {
    if (!operation.documentId) throw new AppError("reviewed_intake_recoverable", "That reviewed document is not available yet", 503);
    return { documentId: operation.documentId };
  }
  if (operation.documentId && ["pending_attachment", "recoverable"].includes(operation.status)) {
    return { documentId: operation.documentId };
  }
  if (!["pending_attachment", "recoverable"].includes(operation.status)) {
    throw new AppError("reviewed_intake_not_ready", "That reviewed document is not ready for upload", 409);
  }
  return {};
}

export async function markDirectReviewedUploadRecoverable(userId: string, operationId: string, failureCode: string): Promise<void> {
  await getDb().update(reviewedIntakeOperations).set({ status: "recoverable", failureCode, updatedAt: new Date() })
    .where(and(eq(reviewedIntakeOperations.id, operationId), eq(reviewedIntakeOperations.actorUserId, userId), eq(reviewedIntakeOperations.expectedDocument, true), eq(reviewedIntakeOperations.status, "pending_attachment")));
}

/** One authorization, idempotency, and reviewed-value boundary for both sources. */
export async function approveReviewedIntake(userId: string, rawInput: unknown): Promise<ApprovalOutcome> {
  const input = reviewedIntakeApprovalSchema.parse(rawInput);
  await requireActiveUser(userId);
  if (input.source.kind === "mailbox_draft") await requirePrivateMailboxRecipient(userId);
  await requireDestination(userId, input.householdId, input.sectionId, input.targetItemId);
  const requestHash = canonicalReviewedIntakeHash(input);
  if (input.source.kind === "mailbox_draft") return finishMailboxApproval(userId, input as MailboxApproval, requestHash);
  return finishDirectApproval(userId, input as DirectApproval, requestHash);
}

export async function listStagedAttachmentIds(receiptId: string): Promise<string[]> {
  const rows = await getDb().select({ id: imapIngestionAttachments.id }).from(imapIngestionAttachments)
    .where(and(eq(imapIngestionAttachments.messageId, receiptId), inArray(imapIngestionAttachments.status, ["stored", "assigned"])));
  return rows.map((row) => row.id);
}
