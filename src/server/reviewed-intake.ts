import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { and, eq, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import {
  auditLog,
  dueEvents,
  documentCrypto,
  documents,
  documentStagingObjects,
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
import { isCalendarDate } from "@/lib/calendar-date";
import {
  COST_MINOR_MAX,
  PROVIDER_MAX,
  RECURRENCE_MAX,
  REFERENCE_MAX,
  SUBTYPE_MAX,
  TITLE_MAX,
  type HomeItem,
  type ScheduleKind,
} from "@/lib/domain";
import { itemOfIntent, type ItemIntent } from "@/lib/item-kind";
import { isCurrencyCode } from "@/lib/platform-lists";
import { costMinorOf, itemRefusal, Refusal } from "@/lib/refusals";
import { workspaceItemSchema } from "@/lib/workspace";
import type { AdjudicatedField } from "@/server/documents/adjudication";
import { safeDocumentPlainText, scheduleKinds, type DocumentProposal } from "@/server/documents/suggestions";
import { envelopeOf } from "@/server/documents/crypto";
import { getDocumentConfig } from "@/server/documents/config";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { classifyScan, documentScanCodes } from "@/server/documents/scan-outcome";
import { endApprovalNotices, queueApprovalNotice } from "@/server/mail-in/approval-notice";
import { openDocumentStorage } from "@/server/documents/storage";
import { PDF_STORED_MAX_PAGES } from "@/server/documents/validation";
import { settleStagedMailTransferLocked, stagedTransferOutcomeOf } from "@/server/mail-in/staged-transfer";
import { FLAGGED_ATTACHMENT_CODE, flagStagingPurgeFailed, isFlaggedAttachment, purgeFlaggedCopies, readHeldImapAttachmentToQuarantine, purgeHeldImapAttachment } from "@/server/mail-in/imap-attachment-holding";
import { readDocumentTransferState, uploadItemDocument } from "@/server/document-repository";
import { openMetadataReader, requireReceiptMetadataWriter, type MetadataExecutor } from "@/server/metadata/fields";
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
  title: TITLE_MAX,
  subtype: SUBTYPE_MAX,
  provider: PROVIDER_MAX,
  reference: REFERENCE_MAX,
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
export type MailboxApproval = ReviewedIntakeApproval & {
  source: Extract<ReviewedIntakeApproval["source"], { kind: "mailbox_draft" }>;
};
type DirectApproval = ReviewedIntakeApproval & {
  source: Extract<ReviewedIntakeApproval["source"], { kind: "direct_upload" }>;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function boundedProposalField(field: ProposalField, value: unknown): unknown {
  if (["title", "subtype", "provider", "reference", "currency", "dueDate", "scheduleKind"].includes(field)) {
    // A3-Q2: delegates to suggestions.ts's own sanitiser rather than a
    // local copy, which had drifted and no longer stripped Unicode bidi
    // and zero-width characters.
    const text = safeDocumentPlainText(value, proposalTextMaximum[field]);
    if (!text) return undefined;
    if (field === "currency" && !isCurrencyCode(text)) return undefined;
    if (field === "dueDate" && !isCalendarDate(text)) return undefined;
    // A3-Q1: the shared list (suggestions.ts, from src/lib/domain.ts)
    // includes "expiry"; a local copy missing it let an expiry document
    // reach review with its date but no schedule type.
    if (field === "scheduleKind" && !(scheduleKinds as readonly string[]).includes(text)) return undefined;
    return text;
  }
  if (field === "costMinor" && typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= COST_MINOR_MAX) return value;
  if (field === "recurrenceMonths" && typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= RECURRENCE_MAX) return value;
  return undefined;
}

export interface ReviewDraftFieldEvidence {
  source: string;
  confidence: string;
  /**
   * The validated value adjudication rejected in favour of the proposed one
   * (ADR-0025 section 4, owner ruling 2026-09-10): only for a field that was
   * actually disputed, and only for the life of this pending review — it
   * rides inside this same blob and is discarded with it when the review is
   * approved or abandoned (`clearedReviewDraftMetadata`).
   */
  alternative?: string;
}

/** Keeps only bounded fields and coarse provenance; raw extraction never enters durable metadata. */
export function sanitizeReviewDraftMetadata(input: unknown): {
  proposal: Record<string, unknown>;
  fieldEvidence: Record<string, ReviewDraftFieldEvidence>;
} {
  const source = record(input);
  const proposalInput = record(source?.proposal);
  const proposal: Record<string, unknown> = {};
  for (const field of proposalFields) {
    const value = boundedProposalField(field, proposalInput?.[field]);
    if (value !== undefined) proposal[field] = value;
  }

  const evidenceInput = record(source?.fieldEvidence);
  const fieldEvidence: Record<string, ReviewDraftFieldEvidence> = {};
  for (const field of proposalFields) {
    const candidate = record(evidenceInput?.[field]);
    const parsed = z.object({ source: evidenceSource, confidence: evidenceConfidence }).safeParse(candidate);
    if (!parsed.success) continue;
    const alternative = safeDocumentPlainText(candidate?.alternative, proposalTextMaximum[field] ?? 100);
    fieldEvidence[field] = alternative ? { ...parsed.data, alternative } : parsed.data;
  }
  return { proposal, fieldEvidence };
}

/**
 * The mail-in review flow's side of ADR-0025 section 7: the same slots the
 * Add-item surface offers (`buildDocumentSuggestions`,
 * `src/server/item-document-inspection.ts`), in the shape a mailbox review
 * draft stores. A field the proposal does not carry is offered to nobody,
 * so where the model path is absent the four model-owned slots are simply
 * absent here too.
 *
 * It goes back out through `sanitizeReviewDraftMetadata`, so nothing
 * reaches durable metadata by a route that skips that boundary.
 */
export function reviewDraftMetadataFromProposal(
  proposal: DocumentProposal,
  alternatives: Partial<Record<AdjudicatedField, string>> = {},
): {
  proposal: Record<string, unknown>;
  fieldEvidence: Record<string, ReviewDraftFieldEvidence>;
} {
  const offered: Record<ProposalField, unknown> = {
    title: proposal.title,
    subtype: proposal.subtype,
    provider: proposal.provider,
    reference: proposal.reference,
    costMinor: proposal.costMinor,
    currency: proposal.currency,
    // The scheduled date when the roles named one, otherwise the first date.
    dueDate: proposal.scheduleDate ?? proposal.dates[0],
    scheduleKind: proposal.scheduleKind,
    recurrenceMonths: proposal.recurrenceMonths,
  };
  const fieldEvidence: Record<string, ReviewDraftFieldEvidence> = {};
  for (const field of proposalFields) {
    if (offered[field] === undefined) continue;
    // Title still comes from the file name; every other field is read out of
    // the document text, which is what the reviewer is being asked to check.
    const base: ReviewDraftFieldEvidence = field === "title"
      ? { source: "filename", confidence: "high" }
      : { source: "document_text", confidence: "medium" };
    const alternative = (field === "title" || field === "provider" || field === "reference")
      ? alternatives[field as AdjudicatedField]
      : undefined;
    fieldEvidence[field] = alternative ? { ...base, alternative } : base;
  }
  return sanitizeReviewDraftMetadata({ proposal: offered, fieldEvidence });
}

/**
 * The columns cleared wherever a receipt's pending review ends —
 * approved, discarded or expired. The rejected reading is only ever kept
 * for the life of the pending review (ADR-0025 section 4), and it rides
 * inside this same blob, so nothing extra is needed to make it go with
 * everything else the review held. The approval request the claim stored
 * (#1396) rides with it: it is Tier 1 content and lives only as long as the
 * review it belongs to; the key and hash stay so a replay still answers as
 * the approval did.
 */
export const clearedReviewDraftMetadata = {
  proposalEnc: null,
  fieldEvidenceEnc: null,
  approvalRequestEnc: null,
} as const;

/**
 * The item an approval files (ADR-0044, #1325): what the reviewer typed and
 * chose, judged by the same "not yet" rules as any new item. The relay's own
 * reading of the subtype and schedule is the basis, kept as an edit keeps a
 * stored item's; a proposal with no schedule date files an unscheduled item.
 */
function canonicalItem(input: ReviewedIntakeApproval, itemId: string): HomeItem {
  const { kind: _kind, subtype, scheduleKind, status: _status, cost, ...intent } = input.item;
  const refused = itemRefusal({ ...intent, cost, sectionId: input.sectionId });
  if (refused) throw new Refusal(refused);
  const typedCost = typeof cost === "string" ? { costMinor: costMinorOf(cost) } : {};
  return workspaceItemSchema.parse(itemOfIntent({
    ...intent,
    ...typedCost,
    id: itemId,
    sectionId: input.sectionId,
    version: 1,
    updatedAt: "1970-01-01T00:00:00.000Z",
  } as ItemIntent, {
    subtype: typeof subtype === "string" ? subtype : undefined,
    scheduleKind: (scheduleKinds as readonly unknown[]).includes(scheduleKind) ? scheduleKind as ScheduleKind : undefined,
    status: "active",
  }));
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

/**
 * The accepted request a mailbox approval stores beside its hash (ADR-0005,
 * #1396): the parsed request less its operation id, with the attachment
 * selection sorted and an absent target left out. Sent back verbatim with its
 * operation id it parses to the same input and so hashes to the same
 * fingerprint; the hashed form itself (item values with nulls, a null target)
 * would not pass the request schema.
 */
export function canonicalReviewedIntakeRequest(input: MailboxApproval): Record<string, unknown> {
  return {
    source: { kind: input.source.kind, receiptId: input.source.receiptId, draftVersion: input.source.draftVersion },
    householdId: input.householdId,
    sectionId: input.sectionId,
    action: input.action,
    ...(input.targetItemId ? { targetItemId: input.targetItemId } : {}),
    item: input.item,
    attachmentIds: [...input.attachmentIds].sort(),
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
    // Tier 1 (ADR-0024): the persisted row's own household decides the key.
    // A damaged value reads as null here, so it can never compare equal to an
    // expected value and the approval is treated as a conflict, not a match.
    const metadata = await openMetadataReader(existing.householdId);
    const persistedReference = metadata.text("items.reference", existing.id, { encrypted: existing.referenceEnc });
    const persistedNotes = metadata.text("items.notes", existing.id, { encrypted: existing.notesEnc });
    const persistedTitle = metadata.text("items.title", existing.id, { encrypted: existing.titleEnc });
    const persistedProvider = metadata.text("items.provider", existing.id, { encrypted: existing.providerEnc });
    const persistedCost = metadata.number("items.cost_minor", existing.id, { encrypted: existing.costMinorEnc });
    const persisted = {
      id: existing.id,
      sectionId: existing.sectionId,
      title: persistedTitle.value ?? "",
      subtype: existing.subtype ?? undefined,
      provider: persistedProvider.value ?? undefined,
      reference: persistedReference.value ?? undefined,
      costMinor: persistedCost.value ?? undefined,
      currency: existing.currency,
      dueDate: event?.dueDate ?? existing.serviceDate ?? existing.renewalDate ?? undefined,
      scheduleKind: event?.kind ?? (existing.serviceDate ? "service" : existing.renewalDate ? "renewal" : undefined),
      recurrenceMonths: existing.recurrenceMonths ?? undefined,
      reminderDays: reminders.map((row) => row.daysBefore).sort((left, right) => left - right),
      snoozedUntil: existing.snoozedUntil ?? undefined,
      notes: persistedNotes.value ?? undefined,
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

/**
 * Creates the reviewed item. With `documentIds` (#1398) the staged documents
 * are bound in the same `item.upsert` transaction that saves the item, so the
 * item never exists without them; an item already there gets them bound by
 * `bindStagedDocuments`, which is idempotent.
 */
async function createReviewedItem(userId: string, input: ReviewedIntakeApproval, itemId: string, documentIds: string[] = []): Promise<string> {
  const existingMatch = await reviewedItemMatches(input, itemId);
  if (existingMatch !== undefined) {
    if (!existingMatch) throw new AppError("reviewed_intake_conflict", "That approval identity is already in use", 409);
    if (documentIds.length) await bindStagedDocuments(input.householdId, itemId, documentIds);
    return itemId;
  }
  const { subtype, scheduleKind, status, ...item } = reviewedItem(input, itemId);
  try {
    await applyWorkspaceCommand(userId, "reviewed-intake", {
      type: "item.upsert",
      householdId: input.householdId,
      item,
      basis: { subtype, scheduleKind, status },
      ...(documentIds.length ? { documentIds } : {}),
      activity: {
        id: input.operationId,
        itemId,
        occurredAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    // The command is authoritative and owns its transaction. If another
    // caller won the item PK race, accept only the exact canonical persisted
    // value; unrelated collisions and other failures remain conflicts.
    const reloadedMatch = await reviewedItemMatches(input, itemId);
    if (reloadedMatch === true) {
      if (documentIds.length) await bindStagedDocuments(input.householdId, itemId, documentIds);
      return itemId;
    }
    if (reloadedMatch === false) throw new AppError("reviewed_intake_conflict", "That approval identity is already in use", 409);
    throw error;
  }
  return itemId;
}

/**
 * Binds staged documents to an item that exists, in one transaction, as
 * `item.upsert { documentIds }` does (#1316): every document is locked, must
 * be this household's, sealed under this item, bound to no other item and not
 * refused or on its way out; one that is not refuses the whole bind.
 */
async function bindStagedDocuments(householdId: string, itemId: string, documentIds: string[]): Promise<void> {
  await getDb().transaction(async (transaction) => {
    const [item] = await transaction.select({ id: items.id }).from(items)
      .where(and(eq(items.id, itemId), eq(items.householdId, householdId))).for("update").limit(1);
    if (!item) throw new AppError("item_not_found", "That item is not available", 404);
    const bindable = await transaction.select({ id: documents.id }).from(documents)
      .where(and(
        inArray(documents.id, documentIds),
        eq(documents.householdId, householdId),
        sql`coalesce(${documents.sealedItemId}, ${documents.itemId}) = ${itemId}::uuid`,
        or(isNull(documents.itemId), eq(documents.itemId, itemId)),
        notInArray(documents.lifecycle, ["rejected", "deleted", "pending_deletion"]),
      ))
      .for("update");
    if (bindable.length !== documentIds.length) {
      throw new AppError("document_not_available", "That document is no longer available — pick it again", 422);
    }
    await transaction.update(documents).set({ itemId, deleteAfter: null, updatedAt: new Date() })
      .where(inArray(documents.id, documentIds));
  });
}

type ApprovalOutcome = {
  outcome: "approved" | "partial_success";
  itemId: string;
  approvalResultId: string;
  attachmentState: "not_requested" | "pending" | "attached";
  attachedAttachmentIds: string[];
  pendingAttachmentIds: string[];
};

async function receiptAttachments(receiptId: string, selectedIds: string[], executor: MetadataExecutor = getDb()) {
  const rows = await executor.select().from(imapIngestionAttachments)
    .where(eq(imapIngestionAttachments.messageId, receiptId));
  const selected = selectedIds.length ? new Set(selectedIds) : new Set(rows.map((row) => row.id));
  const selectedRows = rows.filter((row) => selected.has(row.id));
  if (selectedRows.length !== selected.size) throw new AppError("attachment_not_found", "That staged attachment is not available", 404);
  // #1398: a file the scanner flagged is never added, by any path; the card's
  // "Add without it" is the plain approve, so it is left out, not refused.
  const addable = selectedRows.filter((row) => !isFlaggedAttachment(row));
  if (addable.some((row) => row.status === "rejected")) throw new AppError("attachment_not_found", "That staged attachment is not available", 404);
  return addable;
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
      await flagStagingPurgeFailed(getDb(), eq(imapIngestionAttachments.id, attachment.id));
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
    let [attachment] = await getDb().select().from(imapIngestionAttachments).where(eq(imapIngestionAttachments.id, candidate.id)).limit(1);
    if (attachment?.status === "assigned" && attachment.assignedDocumentId && attachment.purgePending) {
      // The document may have ended (#1802): settle the transfer here too, so a
      // row the worker settled a moment ago, or one stuck before the worker
      // settled it, is released or ended before the branches below judge it.
      const transfer = await readDocumentTransferState(attachment.assignedDocumentId);
      if (transfer.state === "rejected") {
        const code = transfer.failureCode ?? "scan_recovery_expired";
        await settleStagedMailTransferLocked(attachment.assignedDocumentId, code);
        [attachment] = await getDb().select().from(imapIngestionAttachments).where(eq(imapIngestionAttachments.id, candidate.id)).limit(1);
        if (attachment?.status === "rejected") {
          pending.push(candidate.id);
          failureCode ??= stagedTransferOutcomeOf(code).receiptFailureCode;
          continue;
        }
      }
    }
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
      if ((await readDocumentTransferState(attachment.assignedDocumentId)).state !== "available") {
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
        // Only a purge still outstanding (#722): see flagStagingPurgeFailed.
        await flagStagingPurgeFailed(getDb(), and(eq(imapIngestionAttachments.id, attachment.id), eq(imapIngestionAttachments.status, "assigned"), eq(imapIngestionAttachments.assignedDocumentId, attachment.assignedDocumentId), eq(imapIngestionAttachments.purgePending, true)));
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
    let endedCode: string | undefined;
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
        const transfer = await readDocumentTransferState(latest.assignedDocumentId);
        if (transfer.state === "rejected") {
          // Ended while this attempt waited (#1802): settle, then the next pass finds `stored` (released) or `rejected`.
          const code = transfer.failureCode ?? "scan_recovery_expired";
          await settleStagedMailTransferLocked(latest.assignedDocumentId, code);
          endedCode = stagedTransferOutcomeOf(code).receiptFailureCode;
          continue;
        }
        if (transfer.state !== "available") {
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
      if (latest.status === "rejected" && endedCode) {
        pending.push(latest.id);
        failureCode ??= endedCode;
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
    let quarantinePath: string | undefined;
    try {
      // Decrypted into a `.recovery` file whose tag has verified; the file is
      // streamed into the upload and discarded below, whatever the outcome (#1571).
      ({ quarantinePath } = await readHeldImapAttachmentToQuarantine({
        id: attachment.id,
        mediaType: attachment.mediaType,
        sizeBytes: attachment.sizeBytes,
        storageKey: attachment.storageKey,
        envelope: envelopeOf(attachment),
      }, { recipientUserId: userId, receiptId }));
      const document = await uploadItemDocument({
        userId,
        householdId,
        itemId,
        filename: attachment.displayName,
        body: Readable.toWeb(createReadStream(quarantinePath)) as ReadableStream<Uint8Array>,
        declaredBytes: attachment.sizeBytes,
        /* #1388: held under the mail limit at ingestion; the upload limit never
           applies to mail. The exact held size is the bound, so a .recovery
           file larger than the record is still refused. */
        maxBytes: attachment.sizeBytes,
        /* #1801 A-F14: the attachment was structure-checked when it was held
           (imap-attachment-holding.ts), under the page cap of that day; the
           transfer carries that acceptance. The stored bound still holds. */
        maxPages: PDF_STORED_MAX_PAGES,
        documentId: attachment.id,
        /* #1437: the review card already said the household holds it, and Add to orbit was the keep. */
        detectDuplicates: false,
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
        // Only a purge still outstanding (#722): see flagStagingPurgeFailed.
        await flagStagingPurgeFailed(getDb(), and(eq(imapIngestionAttachments.id, attachment.id), eq(imapIngestionAttachments.status, "assigned"), eq(imapIngestionAttachments.assignedDocumentId, document.id), eq(imapIngestionAttachments.purgePending, true)));
        continue;
      }
      attached.push(attachment.id);
    } catch {
      await getDb().update(imapIngestionAttachments).set({ transferClaimToken: null, transferClaimedAt: null, transferLeaseExpiresAt: null, updatedAt: new Date() })
        .where(and(eq(imapIngestionAttachments.id, attachment.id), eq(imapIngestionAttachments.status, "stored"), eq(imapIngestionAttachments.transferClaimToken, claimed.token)));
      pending.push(attachment.id);
      failureCode ??= "attachment_transfer_failed";
    } finally {
      if (quarantinePath) await openDocumentStorage().discardQuarantine(quarantinePath).catch(() => undefined);
    }
  }
  return { attached, pending, failureCode };
}

/** Attachment ids this receipt has durably linked to a document. */
async function assignedReceiptAttachmentIds(receiptId: string): Promise<string[]> {
  const rows = await getDb().select({ id: imapIngestionAttachments.id }).from(imapIngestionAttachments)
    .where(and(eq(imapIngestionAttachments.messageId, receiptId), eq(imapIngestionAttachments.status, "assigned")));
  return rows.map((row) => row.id);
}

// A dropped request (crash, timeout, lost connection) between claiming a
// receipt for approval and finishing it leaves `approving` with no further
// progress and no owner left to retry it: every later approve attempt, with
// any operation id, would otherwise see a mismatched `approvalOperationId`
// and refuse permanently as "already used". Past this bound the claim is
// treated as abandoned rather than active (SR1-R3).
const APPROVAL_RECLAIM_TIMEOUT_MS = 10 * 60_000;

/**
 * Reclaims abandoned `approving` receipts (ADR-0005, #1396). One that already
 * created its item keeps its key, hash and stored request (when it has one)
 * and becomes `recoverable` (`approval_interrupted`): with the request the
 * review read hands the pair back and the same pair finishes it; without one
 * the read reports it as not retryable and its owner may discard it. Only a
 * receipt with no item is reset. Run by the approval under its row lock and
 * by the owner's review or inbox read; returns the reclaimed rows.
 */
export async function reclaimAbandonedMailboxApproval(
  executor: MetadataExecutor,
  scope: { receiptId: string } | { userId: string },
) {
  const abandoned = and(
    "receiptId" in scope ? eq(imapIngestionMessages.id, scope.receiptId) : eq(imapIngestionMessages.userId, scope.userId),
    eq(imapIngestionMessages.status, "approving"),
    lt(imapIngestionMessages.approvalStartedAt, new Date(Date.now() - APPROVAL_RECLAIM_TIMEOUT_MS)),
  );
  // A kill between making the item and recording it leaves a key whose item
  // exists: the item's id is the key (ADR-0005), so it is recorded here before
  // the branches below decide, or the reset would forget an item that exists
  // and the next key would make a second.
  await executor.update(imapIngestionMessages).set({
    approvedItemId: sql`${imapIngestionMessages.approvalOperationId}`,
    updatedAt: new Date(),
  }).where(and(abandoned, isNull(imapIngestionMessages.approvedItemId), sql`exists (
    select 1 from ${items}
    where ${items.id} = ${imapIngestionMessages.approvalOperationId}
      and ${items.householdId} = ${imapIngestionMessages.householdId})`));
  const interrupted = await executor.update(imapIngestionMessages).set({
    status: "recoverable",
    failureCode: "approval_interrupted",
    approvalResultId: sql`coalesce(${imapIngestionMessages.approvalResultId}, ${randomUUID()}::uuid)`,
    updatedAt: new Date(),
  }).where(and(abandoned, isNotNull(imapIngestionMessages.approvedItemId))).returning();
  const reset = await executor.update(imapIngestionMessages).set({
    status: "pending_review",
    approvalOperationId: null,
    approvalResultId: null,
    approvalRequestSha256: null,
    approvalRequestEnc: null,
    approvalStartedAt: null,
    updatedAt: new Date(),
  }).where(and(abandoned, isNull(imapIngestionMessages.approvedItemId))).returning();
  return [...interrupted, ...reset];
}

/** #1398: the member's words when the scanner cannot be reached at approval. */
export const APPROVAL_SCANNER_AWAY = "not added — the virus scanner is away; your mail is kept, try again later.";
const APPROVAL_INFECTED = "not added — the virus scanner flagged an attachment; your mail is kept.";

/**
 * A refusal before anything was staged: the claim is released and no notice
 * goes. `flagged` names the attachments the scanner flagged (#1398): they are
 * marked in the release and their held copies deleted after it commits.
 */
class ApprovalRefusal extends Error {
  constructor(readonly refusal: AppError, readonly flagged: string[] = []) {
    super(refusal.message);
  }
}

/**
 * Scans every held attachment again, then stages each as a document with no
 * item, sealed under the item it will be bound to (#1398). Each held file is
 * decrypted once, into a verified quarantine copy that serves both the scan and
 * the upload, and is discarded whatever happens. Only attachments still
 * `stored` are staged; one an earlier approval already assigned is finished by
 * `transferAttachments` as before. Returns the staged document ids.
 */
async function scanAndStageAttachments(userId: string, input: MailboxApproval, itemId: string): Promise<string[]> {
  const selected = (await receiptAttachments(input.source.receiptId, input.attachmentIds)).filter((row) => row.status === "stored");
  if (!selected.length) return [];
  const config = getDocumentConfig();
  const storage = openDocumentStorage();
  const quarantined: Array<{ attachment: typeof selected[number]; path: string }> = [];
  try {
    for (const attachment of selected) {
      const { quarantinePath } = await readHeldImapAttachmentToQuarantine({
        id: attachment.id,
        mediaType: attachment.mediaType,
        sizeBytes: attachment.sizeBytes,
        storageKey: attachment.storageKey,
        envelope: envelopeOf(attachment),
      }, { recipientUserId: userId, receiptId: input.source.receiptId });
      quarantined.push({ attachment, path: quarantinePath });
    }
    // Signatures are newer than the receipt's scan, so every file is scanned
    // again before anything is stored; one verdict that is not clean refuses
    // the whole approval with nothing staged. Every file is scanned, so the
    // refusal names each one the scanner flagged (#1398), not only the first.
    if (config.scanMode === "required") {
      const flagged: string[] = [];
      let away = false;
      for (const { attachment, path } of quarantined) {
        const scan = classifyScan(await scanFileWithClamAv(path, config.clamAv), documentScanCodes);
        if (scan.status === "infected") flagged.push(attachment.id);
        else if (scan.status !== "clean") away = true;
      }
      if (flagged.length) throw new ApprovalRefusal(new AppError("document_malware_detected", APPROVAL_INFECTED, 422), flagged);
      if (away) throw new ApprovalRefusal(new AppError("reviewed_intake_scanner_away", APPROVAL_SCANNER_AWAY, 503));
    }
    // A staged copy left by an earlier attempt under another operation is
    // sealed under that attempt's item and would refuse this one's identity.
    await discardStagedDocuments(input.householdId, selected.map((row) => row.id), { exceptSealedUnder: itemId });
    const staged: string[] = [];
    for (const { attachment, path } of quarantined) {
      const document = await uploadItemDocument({
        userId,
        householdId: input.householdId,
        itemId,
        staged: true,
        filename: attachment.displayName,
        body: Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>,
        declaredBytes: attachment.sizeBytes,
        documentId: attachment.id,
        /* #1437: the review card already said the household holds it, and Add to orbit was the keep. */
        detectDuplicates: false,
      });
      staged.push(document.id);
      // The scanner went away between the check above and this upload: the
      // copy is held for scanner recovery, not available, so it is not bound.
      if (document.recoverable) throw new ApprovalRefusal(new AppError("reviewed_intake_scanner_away", APPROVAL_SCANNER_AWAY, 503));
    }
    return staged;
  } finally {
    for (const { path } of quarantined) await storage.discardQuarantine(path).catch(() => undefined);
  }
}

/**
 * Removes this household's unbound staged copies of these attachments, rows
 * first (their crypto, staging and job rows cascade), then the ciphertext. A
 * file that cannot be removed is an orphan storage reconciliation sweeps up.
 * A document bound to an item is never touched.
 */
async function discardStagedDocuments(householdId: string, documentIds: string[], scope: { sealedUnder: string } | { exceptSealedUnder: string }): Promise<void> {
  if (!documentIds.length) return;
  const storage = openDocumentStorage();
  const removed = await getDb().transaction(async (transaction) => {
    const rows = await transaction.select({ id: documents.id, storageKey: documentCrypto.storageKey, stagingKey: documentStagingObjects.storageKey })
      .from(documents)
      .leftJoin(documentCrypto, eq(documentCrypto.documentId, documents.id))
      .leftJoin(documentStagingObjects, eq(documentStagingObjects.documentId, documents.id))
      .where(and(
        inArray(documents.id, documentIds),
        eq(documents.householdId, householdId),
        isNull(documents.itemId),
        "sealedUnder" in scope
          ? eq(documents.sealedItemId, scope.sealedUnder)
          : and(sql`${documents.sealedItemId} is distinct from ${scope.exceptSealedUnder}::uuid`, inArray(documents.lifecycle, ["available", "rejected"])),
      ));
    if (!rows.length) return [];
    await transaction.delete(documents).where(and(inArray(documents.id, rows.map((row) => row.id)), isNull(documents.itemId)));
    return rows;
  });
  for (const row of removed) {
    if (row.storageKey) await storage.deleteCiphertext(row.storageKey).catch(() => undefined);
    if (row.stagingKey) await storage.deleteStagingCiphertext(row.stagingKey).catch(() => undefined);
  }
}

/**
 * Puts a claimed receipt back in review as it was before the claim (#1398):
 * no operation, no item, attachments stored, held files kept, and, for a
 * failure rather than a refusal, the member's notice queued in the same
 * transaction. Only the claim this operation holds, and only while no item
 * is recorded against it, is released.
 *
 * The exception is a file the scanner flagged: its row is marked flagged
 * (`rejected`, `malware_detected`) in the same transaction, whatever the claim,
 * so no add path takes it. From that commit its held copy is an object no row
 * references: the add, the discard and the expiry each delete it as the mail
 * leaves review, and the storage reconciliation sweep removes any they miss.
 */
async function releaseMailboxClaim(userId: string, input: MailboxApproval, notice?: { reason: string }, flagged: string[] = []): Promise<void> {
  await getDb().transaction(async (transaction) => {
    if (flagged.length) {
      await transaction.update(imapIngestionAttachments).set({
        status: "rejected",
        purgePending: false,
        purgeFailureCode: FLAGGED_ATTACHMENT_CODE,
        transferClaimToken: null,
        transferClaimedAt: null,
        transferLeaseExpiresAt: null,
        updatedAt: new Date(),
      }).where(and(
        eq(imapIngestionAttachments.messageId, input.source.receiptId),
        inArray(imapIngestionAttachments.id, flagged),
        eq(imapIngestionAttachments.status, "stored"),
      ));
    }
    const [released] = await transaction.update(imapIngestionMessages).set({
      status: "pending_review",
      failureCode: null,
      approvalOperationId: null,
      approvalResultId: null,
      approvalRequestSha256: null,
      approvalRequestEnc: null,
      approvalStartedAt: null,
      approvedItemId: null,
      updatedAt: new Date(),
    }).where(and(
      eq(imapIngestionMessages.id, input.source.receiptId),
      eq(imapIngestionMessages.approvalOperationId, input.operationId),
      eq(imapIngestionMessages.status, "approving"),
      isNull(imapIngestionMessages.approvedItemId),
    )).returning({ householdId: imapIngestionMessages.householdId });
    if (!released) return;
    await transaction.update(imapIngestionAttachments).set({ transferClaimToken: null, transferClaimedAt: null, transferLeaseExpiresAt: null, updatedAt: new Date() })
      .where(and(eq(imapIngestionAttachments.messageId, input.source.receiptId), eq(imapIngestionAttachments.status, "stored")));
    if (!notice || !released.householdId) return;
    const cipher = await requireReceiptMetadataWriter(released.householdId, transaction);
    await queueApprovalNotice(transaction, cipher, {
      operationId: input.operationId,
      userId,
      householdId: released.householdId,
      receiptId: input.source.receiptId,
      title: String(canonicalItem(input, input.operationId).title ?? ""),
      reason: notice.reason,
    });
  });
}

/** The bind may have committed but could not be checked (#1398): record the item, keep the claim. */
async function markApprovalUnconfirmed(input: MailboxApproval, itemId: string): Promise<void> {
  await getDb().update(imapIngestionMessages).set({
    status: "recoverable",
    failureCode: "approval_interrupted",
    approvedItemId: itemId,
    updatedAt: new Date(),
  }).where(and(
    eq(imapIngestionMessages.id, input.source.receiptId),
    eq(imapIngestionMessages.approvalOperationId, input.operationId),
    eq(imapIngestionMessages.status, "approving"),
    isNull(imapIngestionMessages.approvedItemId),
  ));
}

/** Whether the bind committed: the item exists and holds every staged document. */
async function stagedBindCommitted(input: MailboxApproval, itemId: string, stagedIds: string[]): Promise<boolean> {
  if (input.action === "create_separate") {
    // Only the item this approval made: one already there with other values is a conflict.
    if (await reviewedItemMatches(input, itemId) !== true) return false;
    if (!stagedIds.length) return true;
  } else if (!stagedIds.length) {
    return false;
  }
  const bound = await getDb().select({ id: documents.id }).from(documents)
    .where(and(inArray(documents.id, stagedIds), eq(documents.itemId, itemId)));
  return bound.length === stagedIds.length;
}

/**
 * A second request for an operation another request has claimed and is still
 * staging (#1398) waits for it rather than staging the same files beside it:
 * once the item is recorded it joins the transfer as before; if the claim was
 * released, the approval failed and this request says so.
 */
async function awaitClaimedApproval(input: MailboxApproval, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  // Polls back off from 50 ms to 1 s, so a long wait costs a few dozen reads, not hundreds.
  for (let delay = 50; ; delay = Math.min(delay * 2, 1_000)) {
    const [current] = await getDb().select({ status: imapIngestionMessages.status, approvalOperationId: imapIngestionMessages.approvalOperationId, approvedItemId: imapIngestionMessages.approvedItemId })
      .from(imapIngestionMessages).where(eq(imapIngestionMessages.id, input.source.receiptId)).limit(1);
    if (!current || current.approvalOperationId !== input.operationId) throw notAdded(input);
    if (current.approvedItemId || current.status !== "approving") return;
    const left = deadline - Date.now();
    if (left <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, left)));
  }
  throw new AppError("reviewed_intake_in_progress", "not added yet — that approval is still under way; try again shortly.", 409);
}

/* The in-app words for a failed add; the mail and push say the notice's own (approval-notice.ts). */
function notAdded(input: MailboxApproval): AppError {
  return new AppError("reviewed_intake_not_added", `Orbit could not add ${String(canonicalItem(input, input.operationId).title ?? "this mail")} — your mail is kept, try again`, 503);
}

/**
 * The all-or-nothing approval of a freshly claimed receipt (#1398), the
 * standard "stage, then bind in one transaction" shape the create forms use:
 * scan again, stage every attachment, then create the item and bind every
 * document in one transaction. On any failure before that commits nothing is
 * left: the staged copies go, the receipt is back in review with its held
 * files, and the member is told once. Returns the item id.
 */
async function stageAndBindMailboxApproval(userId: string, input: MailboxApproval): Promise<string> {
  const itemId = input.action === "create_separate" ? input.operationId : input.targetItemId!;
  let stagedIds: string[] = [];
  try {
    stagedIds = await scanAndStageAttachments(userId, input, itemId);
    if (input.action === "create_separate") await createReviewedItem(userId, input, itemId, stagedIds);
    else if (stagedIds.length) await bindStagedDocuments(input.householdId, itemId, stagedIds);
  } catch (error) {
    // A failure after the bind committed (a read after the command, say) is
    // not a failure of the approval: the item holds its documents.
    if (!(error instanceof ApprovalRefusal)) {
      let committed: boolean | undefined;
      try {
        committed = await stagedBindCommitted(input, itemId, stagedIds);
      } catch {
        // Not known either way: releasing the claim could forget an item that
        // exists, and the next key would make a second. The item is recorded
        // and the receipt left `recoverable`, as the abandoned-approval
        // reclaim does, so this key's retry finishes by the transfer path
        // (which makes the item if the bind never committed) and any other
        // key is refused as a conflict. If even that write fails, the claim
        // stays `approving` and the reclaim settles it the same way.
        await markApprovalUnconfirmed(input, itemId).catch(() => undefined);
        throw error;
      }
      if (committed) return itemId;
    }
    const attempted = (await receiptAttachments(input.source.receiptId, input.attachmentIds).catch(() => [])).map((row) => row.id);
    await discardStagedDocuments(input.householdId, [...new Set([...stagedIds, ...attempted])], { sealedUnder: itemId }).catch(() => undefined);
    if (error instanceof ApprovalRefusal) {
      // A flagged file sends no notice: the review card is where the member decides (#1398).
      await releaseMailboxClaim(userId, input, undefined, error.flagged);
      throw error.refusal;
    }
    await releaseMailboxClaim(userId, input, { reason: error instanceof AppError ? error.code : "approval_failed" });
    // A refusal with its own words (a conflict, a locked key) keeps them.
    if (error instanceof AppError && (error.status < 500 || error.code === "metadata_locked")) throw error;
    throw notAdded(input);
  }
  // Every staged document is bound: its attachment is assigned to it, and the
  // held copy is purged by the transfer step that follows.
  try {
    await getDb().transaction(async (transaction) => {
      for (const documentId of stagedIds) {
        await transaction.update(imapIngestionAttachments).set({
          status: "assigned",
          assignedDocumentId: documentId,
          transferClaimToken: null,
          transferClaimedAt: null,
          transferLeaseExpiresAt: null,
          purgePending: true,
          purgeFailureCode: null,
          updatedAt: new Date(),
        }).where(and(eq(imapIngestionAttachments.id, documentId), eq(imapIngestionAttachments.messageId, input.source.receiptId), eq(imapIngestionAttachments.status, "stored")));
      }
      await transaction.update(imapIngestionMessages).set({ approvedItemId: itemId, updatedAt: new Date() })
        .where(and(eq(imapIngestionMessages.id, input.source.receiptId), eq(imapIngestionMessages.approvalOperationId, input.operationId)));
    });
  } catch {
    /* The transfer step below assigns any attachment still stored. */
  }
  // #1398: the mail leaves review without any flagged file; a copy the refusal's delete missed goes now.
  await purgeFlaggedCopies(getDb(), input.source.receiptId).catch(() => undefined);
  return itemId;
}

async function finishMailboxApproval(
  userId: string,
  input: MailboxApproval,
  requestHash: string,
  options: ReviewedIntakeApprovalOptions = {},
): Promise<ApprovalOutcome> {
  const result = await getDb().transaction(async (transaction) => {
    let [receipt] = await transaction.select().from(imapIngestionMessages)
      .where(and(eq(imapIngestionMessages.id, input.source.receiptId), eq(imapIngestionMessages.userId, userId))).for("update").limit(1);
    if (!receipt) throw notFound();
    if (
      receipt.status === "approving"
      && receipt.approvalStartedAt
      && receipt.approvalStartedAt.getTime() < Date.now() - APPROVAL_RECLAIM_TIMEOUT_MS
    ) {
      const [reclaimed] = await reclaimAbandonedMailboxApproval(transaction, { receiptId: receipt.id });
      if (reclaimed) receipt = reclaimed;
    }
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
        // Lapsing is the review ending (ADR-0025 section 4), the same as the sweep
        // reaching it: the draft and the stored request go with the status, here
        // and in the pre-claim write below. The key and hash stay so a replay still
        // answers "expired". They are cleared here rather than after the purge that
        // follows, because nothing hands the pair back or shows the draft once
        // expires_at has passed, and the row the purge failure reverts to
        // `recoverable` is retried by the sweep, which clears the same set again.
        await transaction.update(imapIngestionMessages).set({ status: "expired", expiredAt: new Date(), updatedAt: new Date(), ...clearedReviewDraftMetadata }).where(eq(imapIngestionMessages.id, receipt.id));
        await endApprovalNotices(transaction, receipt);
        return { receipt, claimed: false, expired: true, result: undefined };
      }
      // A replay after the receipt was discarded, or while a discard is under
      // way, is refused as a fresh claim is (#1568): its attachments are
      // rejected or going, so a transfer would only answer 404 every time.
      // Before any item or transfer; an interrupted or partial approval still
      // retries. `staging_purge_failed` is not refused: a transfer whose purge
      // failed leaves that code too, and its replay must finish; a failed
      // discard leaves `discard_purge_failed` instead.
      if (
        receipt.status === "discarded"
        || receipt.status === "expired"
        || (receipt.status === "recoverable"
          && (receipt.failureCode === "staging_purge_pending" || receipt.failureCode === "discard_purge_failed"))
      ) {
        throw new AppError("reviewed_intake_not_approvable", "That reviewed intake is no longer available", 409);
      }
      return { receipt, claimed: false, result: undefined };
    }
    if (receipt.status !== "pending_review") throw new AppError("reviewed_intake_not_approvable", "That reviewed intake is no longer available", 409);
    /* Held for an unchecked sending address (#1650, owner decision 51): the
       words are the inbox's, "Please verify sending address". */
    if (receipt.heldSenderAddressId !== null) throw new AppError("sender_unchecked", "Please verify sending address", 409);
    if (!receipt.householdId || receipt.householdId !== input.householdId) throw notFound();
    if (receipt.status === "pending_review" && receipt.draftVersion !== input.source.draftVersion) {
      throw new AppError("reviewed_intake_stale", "That reviewed intake changed; refresh and try again", 409);
    }
    if (receipt.expiresAt <= new Date()) {
      // The review ends here as above: the draft goes with the status.
      await transaction.update(imapIngestionMessages).set({ status: "expired", expiredAt: new Date(), updatedAt: new Date(), ...clearedReviewDraftMetadata }).where(eq(imapIngestionMessages.id, receipt.id));
      await endApprovalNotices(transaction, receipt);
      return { receipt, claimed: false, expired: true, result: undefined };
    }
    // Validation precedes the claim (ADR-0005, #1396): a stale or unknown
    // attachment selection is refused with nothing bound and no item made, so
    // the next tap can send afresh with what the review lists now.
    await receiptAttachments(receipt.id, input.attachmentIds, transaction);
    // Tier 1 (ADR-0024): the accepted request is keyed as the draft is, by the
    // receipt's household, which the check above has just matched.
    const requestCipher = await requireReceiptMetadataWriter(receipt.householdId, transaction);
    const approvalResultId = randomUUID();
    // draftVersion is left as-is: the claim is already fenced by approvalOperationId,
    // and a retry reads this version back, so it must match the stored request hash.
    await transaction.update(imapIngestionMessages).set({
      status: "approving",
      approvalOperationId: input.operationId,
      approvalResultId,
      approvalRequestSha256: requestHash,
      approvalRequestEnc: requestCipher.encryptJson("imap_ingestion_messages.approval_request", receipt.id, canonicalReviewedIntakeRequest(input)),
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
    return { ...result.result, attachedAttachmentIds: await assignedReceiptAttachmentIds(input.source.receiptId) };
  }
  // #1398: a fresh claim is all or nothing. A replay of an operation another
  // request is still staging waits for it; one whose item is recorded (an
  // approval interrupted after its bind, or left `recoverable` by the code
  // before #1398) finishes by the transfer path as it always has.
  if (!result.claimed && result.receipt.status === "approving" && !result.receipt.approvedItemId) {
    await awaitClaimedApproval(input, options.inProgressWaitMs ?? DEFAULT_IN_PROGRESS_WAIT_MS);
    return finishMailboxApproval(userId, input, requestHash, options);
  }
  const itemId = result.claimed
    ? await stageAndBindMailboxApproval(userId, input)
    : input.action === "create_separate" ? await createReviewedItem(userId, input, input.operationId) : input.targetItemId!;
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
      // The review is only actually over once this reaches "completed"; a
      // partial success is still retryable and keeps its draft meanwhile.
      ...(partial ? {} : clearedReviewDraftMetadata),
    }).where(and(
      eq(imapIngestionMessages.id, input.source.receiptId),
      eq(imapIngestionMessages.approvalOperationId, input.operationId),
      or(eq(imapIngestionMessages.status, "approving"), eq(imapIngestionMessages.status, "recoverable")),
    )).returning({ status: imapIngestionMessages.status, householdId: imapIngestionMessages.householdId });
    // #1398: the mail is added, so an earlier try's "could not add" notice ends unsent.
    if (changed?.status === "completed") await endApprovalNotices(transaction, { id: input.source.receiptId, householdId: changed.householdId });
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
  if (effectivePartial) {
    return {
      outcome: "partial_success",
      itemId,
      approvalResultId,
      attachmentState: "pending",
      attachedAttachmentIds: transferred.attached,
      pendingAttachmentIds: transferred.pending,
    };
  }
  // An approved outcome describes the receipt, not this caller's own transfer
  // attempt, and the two disagree whenever a concurrent approval of the same
  // operation completed the receipt while this caller was losing the race for
  // the staged attachment: `effectivePartial` is then cleared above from the
  // durable receipt status, leaving this caller's local lists still describing
  // its lost attempt. Reporting them alongside `approved` returned an empty
  // `attachedAttachmentIds` for a linkage that does exist (#656), so an
  // approved result reports what the receipt durably links.
  const considered = [...new Set([...transferred.attached, ...transferred.pending])];
  const assigned = new Set(await assignedReceiptAttachmentIds(input.source.receiptId));
  const attachedAttachmentIds = considered.filter((id) => assigned.has(id));
  const pendingAttachmentIds = considered.filter((id) => !assigned.has(id));
  return {
    outcome: "approved",
    itemId,
    approvalResultId,
    // A completed receipt is only written once every selected attachment is
    // linked, so this is "attached" in practice; deriving it keeps the reported
    // state and the reported ids from ever contradicting each other.
    attachmentState: pendingAttachmentIds.length ? "pending" : "attached",
    attachedAttachmentIds,
    pendingAttachmentIds,
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

/** How long a request for an operation another request is still staging waits for it (#1398). */
const DEFAULT_IN_PROGRESS_WAIT_MS = 30_000;

export interface ReviewedIntakeApprovalOptions {
  /** How long to wait for another request still staging the same operation before answering 409; 30 s by default. */
  inProgressWaitMs?: number;
}

/** One authorization, idempotency, and reviewed-value boundary for both sources. */
export async function approveReviewedIntake(userId: string, rawInput: unknown, options: ReviewedIntakeApprovalOptions = {}): Promise<ApprovalOutcome> {
  const input = reviewedIntakeApprovalSchema.parse(rawInput);
  await requireActiveUser(userId);
  await requireDestination(userId, input.householdId, input.sectionId, input.targetItemId);
  const requestHash = canonicalReviewedIntakeHash(input);
  if (input.source.kind === "mailbox_draft") return finishMailboxApproval(userId, input as MailboxApproval, requestHash, options);
  return finishDirectApproval(userId, input as DirectApproval, requestHash);
}
