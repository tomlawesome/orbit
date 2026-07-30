import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, documentDrafts, documents, households, items, memberships, sections, users } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { extractTextWithTika } from "@/server/documents/tika";
import { readDocumentDownload } from "@/server/document-repository";

export function proposalFromText(text: string, filename: string) {
  const reference = text.match(/(?:policy|account|reference)\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Z0-9-]{5,})/i)?.[1];
  const provider = text.match(/(?:provider|insurer|supplier)\s*[:\-]\s*([^\n]{2,80})/i)?.[1]?.trim();
  const dates = [...text.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map((match) => match[1]).slice(0, 12);
  return { title: filename.replace(/\.[^.]+$/, "").slice(0, 100), provider: provider?.slice(0, 100), reference, dates };
}

export interface DuplicateCandidate { itemId: string; title: string; reason: "document_hash" | "reference" | "provider_title" | "date_overlap" }

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
  const [record] = await getDb().select({ id: documents.id, householdId: documents.householdId, displayName: documents.displayName, mediaType: documents.mediaType, lifecycle: documents.lifecycle, administrator: users.isInstanceAdmin, member: memberships.userId })
    .from(documents).innerJoin(users, eq(users.id, userId)).leftJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.householdId, documents.householdId)))
    .where(eq(documents.id, documentId)).limit(1);
  if (!record || (record.lifecycle !== "available") || (!record.administrator && !record.member)) throw new AppError("document_not_found", "That document is not available", 404);
  return record;
}

export async function createDocumentDraft(userId: string, documentId: string) {
  const record = await requireDocumentMember(userId, documentId);
  const existing = await getDb().select().from(documentDrafts).where(eq(documentDrafts.documentId, documentId)).limit(1);
  if (existing[0]) return { ...existing[0], duplicates: await findDuplicates(record.householdId, documentId, existing[0].proposal as { title: string; provider?: string; reference?: string; dates?: string[] }) };
  const download = await readDocumentDownload(userId, documentId);
  let text: string;
  try { text = await extractTextWithTika(download.bytes, record.mediaType); } finally { download.bytes.fill(0); }
  const evidence = { excerpt: text.slice(0, 2_000), characters: text.length };
  const proposal = proposalFromText(text, record.displayName);
  const [draft] = await getDb().transaction(async (transaction) => {
    const [created] = await transaction.insert(documentDrafts).values({ documentId, householdId: record.householdId, requestedByUserId: userId, extractedTextSha256: createHash("sha256").update(text).digest("hex"), evidence, proposal }).returning();
    await transaction.insert(auditLog).values({ householdId: record.householdId, actorUserId: userId, entityType: "document_draft", entityId: created.id, action: "document_draft_created", changes: { documentId } });
    return [created];
  });
  return { ...draft, duplicates: await findDuplicates(record.householdId, documentId, proposal) };
}

export async function approveDocumentDraft(userId: string, draftId: string, sectionId: string, title: string, mode: "create" | "merge" | "attach", targetItemId?: string) {
  const [draft] = await getDb().select().from(documentDrafts).where(eq(documentDrafts.id, draftId)).limit(1);
  if (!draft || draft.status !== "pending_review") throw new AppError("draft_not_found", "That draft is not available", 404);
  const record = await requireDocumentMember(userId, draft.documentId);
  const [section] = await getDb().select({ id: sections.id }).from(sections).where(and(eq(sections.id, sectionId), eq(sections.householdId, record.householdId))).limit(1);
  if (!section) throw new AppError("section_not_found", "Choose a section from this household", 422);
  const [household] = await getDb().select({ currency: households.defaultCurrency }).from(households).where(eq(households.id, record.householdId)).limit(1);
  if (!household) throw new AppError("household_not_found", "That household is not available", 404);
  const proposal = draft.proposal as { provider?: string; reference?: string };
  let itemId: string = randomUUID();
  if (mode !== "create") {
    if (!targetItemId) throw new AppError("duplicate_target_required", "Choose an existing item", 422);
    const [target] = await getDb().select({ id: items.id }).from(items).where(and(eq(items.id, targetItemId), eq(items.householdId, record.householdId))).limit(1);
    if (!target) throw new AppError("item_not_found", "That item is not available", 404);
    itemId = target.id;
  }
  await getDb().transaction(async (transaction) => {
    if (mode === "create") await transaction.insert(items).values({ id: itemId, householdId: record.householdId, sectionId, title: title.trim().slice(0, 100), currency: household.currency });
    if (mode === "merge") await transaction.update(items).set({ provider: proposal.provider ?? undefined, reference: proposal.reference ?? undefined, updatedAt: new Date() }).where(eq(items.id, itemId));
    await transaction.update(documents).set({ itemId, updatedAt: new Date() }).where(eq(documents.id, draft.documentId));
    await transaction.update(documentDrafts).set({ status: "approved", approvedItemId: itemId, updatedAt: new Date() }).where(eq(documentDrafts.id, draftId));
    await transaction.insert(auditLog).values({ householdId: record.householdId, actorUserId: userId, entityType: "document_draft", entityId: draftId, action: `document_draft_${mode}`, changes: { itemId, documentId: draft.documentId } });
  });
  return { itemId };
}
