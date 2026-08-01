import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, documentDrafts, documents, households, items, memberships, sections, users } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import {
  proposalFromText,
  safeDocumentEvidence,
  safeDocumentPlainText,
  safeStoredDocumentProposal,
} from "@/server/documents/suggestions";
import { extractTextWithTika } from "@/server/documents/tika";
import { detectDocumentMediaType, validateSupportedDocumentStructure } from "@/server/documents/validation";
import { isDocumentContentReady, readDocumentDownload } from "@/server/document-repository";
import { getDocumentConfig } from "@/server/documents/config";
import { acquireActiveHouseholdLock } from "@/server/workspace-access";

export { proposalFromText } from "@/server/documents/suggestions";

export interface DuplicateCandidate { itemId: string; title: string; reason: "document_hash" | "reference" | "provider_title" | "date_overlap" }

interface ReviewedDraftFields {
  title: string;
  provider: string | null;
  reference: string | null;
}

function safeDraftEvidence(value: unknown) {
  const candidate = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const excerpt = safeDocumentEvidence(candidate.excerpt);
  return {
    excerpt,
    characters: excerpt.length,
    extracted: candidate.extracted === true && excerpt.length > 0,
  };
}

function reviewedField(value: string, maximum: number): string {
  const canonical = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const safe = safeDocumentPlainText(value, maximum);
  if (!safe || safe !== canonical) {
    throw new AppError("draft_review_invalid", "Review the document fields using plain text", 422);
  }
  return safe;
}

function optionalReviewedField(value: string | null, maximum: number): string | null {
  return value === null ? null : reviewedField(value, maximum);
}

async function findDuplicates(householdId: string, documentId: string, proposal: { title: string; provider?: string; reference?: string; dates?: string[] }): Promise<DuplicateCandidate[]> {
  const [document] = await getDb().select({ hash: documents.contentSha256 }).from(documents).where(eq(documents.id, documentId)).limit(1);
  const householdItems = await getDb().select().from(items).where(eq(items.householdId, householdId));
  const seen = new Map<string, DuplicateCandidate>();
  const sameHash = await getDb().select({ itemId: documents.itemId }).from(documents).where(and(eq(documents.householdId, householdId), eq(documents.contentSha256, document?.hash ?? "")));
  for (const match of sameHash) if (match.itemId) seen.set(match.itemId, { itemId: match.itemId, title: householdItems.find((item) => item.id === match.itemId)?.title ?? "Existing item", reason: "document_hash" });
  for (const item of householdItems) {
    if (proposal.reference && item.reference?.toLowerCase() === proposal.reference.toLowerCase()) seen.set(item.id, { itemId: item.id, title: item.title, reason: "reference" });
    else if (proposal.provider && item.provider?.toLowerCase() === proposal.provider.toLowerCase() && item.title.toLowerCase() === proposal.title.toLowerCase()) seen.set(item.id, { itemId: item.id, title: item.title, reason: "provider_title" });
    else if (proposal.dates?.some((date) => [item.startDate, item.expiryDate, item.renewalDate, item.serviceDate].includes(date))) seen.set(item.id, { itemId: item.id, title: item.title, reason: "date_overlap" });
  }
  return [...seen.values()].slice(0, 10);
}

async function requireDocumentMember(userId: string, documentId: string) {
  const [record] = await getDb().select({ id: documents.id, householdId: documents.householdId, displayName: documents.displayName, mediaType: documents.mediaType, lifecycle: documents.lifecycle, scanStatus: documents.scanStatus, administrator: users.isInstanceAdmin, member: memberships.userId })
    .from(documents)
    .innerJoin(households, eq(households.id, documents.householdId))
    .innerJoin(users, eq(users.id, userId))
    .leftJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.householdId, documents.householdId)))
    .where(and(eq(documents.id, documentId), isNull(households.deletionRequestedAt)))
    .limit(1);
  if (!record || (!record.administrator && !record.member)) throw new AppError("document_not_found", "That document is not available", 404);
  if (!isDocumentContentReady(record, getDocumentConfig().scanMode, "draft")) {
    throw new AppError("document_not_found", "That document is not available", 404);
  }
  return record;
}

export async function createDocumentDraft(userId: string, documentId: string) {
  const record = await requireDocumentMember(userId, documentId);
  const existing = await getDb().select().from(documentDrafts).where(eq(documentDrafts.documentId, documentId)).limit(1);
  if (existing[0]) {
    const proposal = safeStoredDocumentProposal(existing[0].proposal, record.displayName);
    return {
      ...existing[0],
      evidence: safeDraftEvidence(existing[0].evidence),
      proposal,
      duplicates: await findDuplicates(record.householdId, documentId, proposal),
    };
  }
  const download = await readDocumentDownload(userId, documentId);
  let text = "";
  let extracted = false;
  try {
    const detected = detectDocumentMediaType(download.bytes);
    if (record.scanStatus === "clean"
      && detected === record.mediaType
      && validateSupportedDocumentStructure(download.bytes, detected)) {
      try {
        text = await extractTextWithTika(download.bytes, detected);
        extracted = true;
      } catch {
        text = "";
      }
    }
  } catch {
    text = "";
  } finally {
    download.bytes.fill(0);
  }
  const excerpt = safeDocumentEvidence(text);
  const evidence = { excerpt, characters: excerpt.length, extracted: extracted && excerpt.length > 0 };
  const proposal = proposalFromText(text, record.displayName);
  const extractedTextSha256 = createHash("sha256").update(excerpt).digest("hex");
  text = "";
  const [draft] = await getDb().transaction(async (transaction) => {
    const [created] = await transaction.insert(documentDrafts).values({
      documentId,
      householdId: record.householdId,
      requestedByUserId: userId,
      extractedTextSha256,
      evidence,
      proposal,
    }).returning();
    await transaction.insert(auditLog).values({ householdId: record.householdId, actorUserId: userId, entityType: "document_draft", entityId: created.id, action: "document_draft_created", changes: { documentId } });
    return [created];
  });
  return { ...draft, duplicates: await findDuplicates(record.householdId, documentId, proposal) };
}

export async function approveDocumentDraft(
  userId: string,
  draftId: string,
  sectionId: string,
  reviewedFields: ReviewedDraftFields,
  mode: "create" | "merge" | "attach",
  targetItemId?: string,
) {
  const [draft] = await getDb().select().from(documentDrafts).where(eq(documentDrafts.id, draftId)).limit(1);
  if (!draft || draft.status !== "pending_review") throw new AppError("draft_not_found", "That draft is not available", 404);
  const record = await requireDocumentMember(userId, draft.documentId);
  const [section] = await getDb().select({ id: sections.id }).from(sections).where(and(eq(sections.id, sectionId), eq(sections.householdId, record.householdId))).limit(1);
  if (!section) throw new AppError("section_not_found", "Choose a section from this household", 422);
  const [household] = await getDb().select({ currency: households.defaultCurrency }).from(households).where(eq(households.id, record.householdId)).limit(1);
  if (!household) throw new AppError("household_not_found", "That household is not available", 404);
  const reviewed = {
    title: reviewedField(reviewedFields.title, 100),
    provider: optionalReviewedField(reviewedFields.provider, 100),
    reference: optionalReviewedField(reviewedFields.reference, 80),
  };
  let itemId: string = randomUUID();
  if (mode !== "create") {
    if (!targetItemId) throw new AppError("duplicate_target_required", "Choose an existing item", 422);
    const [target] = await getDb().select({ id: items.id }).from(items).where(and(eq(items.id, targetItemId), eq(items.householdId, record.householdId))).limit(1);
    if (!target) throw new AppError("item_not_found", "That item is not available", 404);
    itemId = target.id;
  }
  await getDb().transaction(async (transaction) => {
    await acquireActiveHouseholdLock(transaction, record.householdId);
    const [activeDraft] = await transaction.select({ id: documentDrafts.id })
      .from(documentDrafts)
      .where(and(
        eq(documentDrafts.id, draftId),
        eq(documentDrafts.householdId, record.householdId),
        eq(documentDrafts.status, "pending_review"),
      ))
      .limit(1);
    if (!activeDraft) throw new AppError("draft_not_found", "That draft is not available", 404);
    if (mode === "create") {
      await transaction.insert(items).values({
        id: itemId,
        householdId: record.householdId,
        sectionId,
        title: reviewed.title,
        provider: reviewed.provider,
        reference: reviewed.reference,
        currency: household.currency,
      });
    }
    if (mode === "merge") {
      await transaction.update(items).set({
        provider: reviewed.provider,
        reference: reviewed.reference,
        updatedAt: new Date(),
      }).where(eq(items.id, itemId));
    }
    await transaction.update(documents).set({ itemId, updatedAt: new Date() }).where(eq(documents.id, draft.documentId));
    const [approved] = await transaction.update(documentDrafts)
      .set({ status: "approved", approvedItemId: itemId, updatedAt: new Date() })
      .where(and(eq(documentDrafts.id, draftId), eq(documentDrafts.status, "pending_review")))
      .returning({ id: documentDrafts.id });
    if (!approved) throw new AppError("draft_not_found", "That draft is not available", 404);
    await transaction.insert(auditLog).values({ householdId: record.householdId, actorUserId: userId, entityType: "document_draft", entityId: draftId, action: `document_draft_${mode}`, changes: { itemId, documentId: draft.documentId } });
  });
  return { itemId };
}
