/**
 * The encrypted-metadata backfill (ADR-0024 decision 3), in the resumable-job
 * mould of ADR-0010. It covers Tier 1 (#931) and Tier 2 (#963) together, in
 * one pass over each table, because both tiers share one key and one envelope.
 *
 * Migrations 0040 and 0041 cannot do this work: encrypting needs the key-encryption key,
 * which is an application secret and is not available to SQL. What the
 * migration guarantees is that every pre-existing row stays readable — the
 * plaintext column stands until this job replaces it — and what this job does
 * is convert those rows in small transactions after start-up.
 *
 * Every row is, at every instant, in exactly one of two states the running
 * release reads: encrypted with the plaintext cleared, or plaintext with no
 * ciphertext. A crash mid-run therefore loses nothing and the next start-up
 * picks up where this one stopped, because "what is left to do" is a property
 * of the rows themselves rather than a cursor anybody has to store.
 */
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { householdInvitations, imapIngestionMessages, items } from "@/db/schema";
import { log } from "@/lib/logger";
import { MetadataKeyLockedError, resolveMetadataKey } from "@/server/metadata/keys";
import { MetadataCipher, type MetadataExecutor } from "@/server/metadata/fields";

/** Small enough that one transaction is short, large enough to drain quickly. */
export const METADATA_BACKFILL_BATCH = 100;

export interface MetadataBackfillBatch {
  items: number;
  receipts: number;
  invitations: number;
}

/** True when this batch converted nothing, so there is no more work. */
export function backfillComplete(batch: MetadataBackfillBatch): boolean {
  return batch.items === 0 && batch.receipts === 0 && batch.invitations === 0;
}

async function cipherFor(
  ciphers: Map<string, MetadataCipher>,
  householdId: string | null,
  executor: MetadataExecutor,
): Promise<MetadataCipher> {
  const cacheKey = householdId ?? "";
  const cached = ciphers.get(cacheKey);
  if (cached) return cached;
  const scope = householdId ? ("household" as const) : ("instance" as const);
  const cipher = new MetadataCipher(await resolveMetadataKey(scope, householdId, executor));
  ciphers.set(cacheKey, cipher);
  return cipher;
}

/**
 * Converts at most `batchSize` items and `batchSize` receipts in one
 * transaction. Each update is guarded on the ciphertext columns still being
 * null, so a row the application wrote while this batch was in flight keeps
 * the application's value and this job's candidate is discarded.
 */
export async function runMetadataBackfillBatch(
  batchSize = METADATA_BACKFILL_BATCH,
  database: ReturnType<typeof getDb> = getDb(),
): Promise<MetadataBackfillBatch> {
  return database.transaction(async (transaction) => {
    const ciphers = new Map<string, MetadataCipher>();
    let convertedItems = 0;
    let convertedReceipts = 0;
    let convertedInvitations = 0;

    // One pass converts both tiers of a row. Selecting on "any plaintext still
    // present with its ciphertext missing" is what makes the job resumable
    // without a cursor: what is left to do is a property of the rows.
    const itemRows = await transaction.select({
      id: items.id,
      householdId: items.householdId,
      reference: items.reference,
      notes: items.notes,
      title: items.title,
      provider: items.provider,
      costMinor: items.costMinor,
    }).from(items).where(or(
      and(isNotNull(items.reference), isNull(items.referenceEnc)),
      and(isNotNull(items.notes), isNull(items.notesEnc)),
      and(isNotNull(items.title), isNull(items.titleEnc)),
      and(isNotNull(items.provider), isNull(items.providerEnc)),
      and(isNotNull(items.costMinor), isNull(items.costMinorEnc)),
    )).limit(batchSize);

    for (const row of itemRows) {
      const cipher = await cipherFor(ciphers, row.householdId, transaction);
      const updated = await transaction.update(items).set({
        reference: null,
        referenceEnc: cipher.encryptText("items.reference", row.id, row.reference),
        referenceIndex: cipher.referenceIndex(row.reference),
        notes: null,
        notesEnc: cipher.encryptText("items.notes", row.id, row.notes),
        title: null,
        titleEnc: cipher.encryptText("items.title", row.id, row.title),
        provider: null,
        providerEnc: cipher.encryptText("items.provider", row.id, row.provider),
        costMinor: null,
        costMinorEnc: cipher.encryptNumber("items.cost_minor", row.id, row.costMinor),
      }).where(and(
        eq(items.id, row.id),
        isNull(items.referenceEnc),
        isNull(items.notesEnc),
        isNull(items.titleEnc),
        isNull(items.providerEnc),
        isNull(items.costMinorEnc),
      )).returning({ id: items.id });
      convertedItems += updated.length;
    }

    // An empty `{}` proposal is left alone: there is nothing in it to protect,
    // and skipping those rows keeps the job proportional to real content
    // rather than to the whole receipt table.
    const receiptRows = await transaction.select({
      id: imapIngestionMessages.id,
      householdId: imapIngestionMessages.householdId,
      proposal: imapIngestionMessages.proposal,
      fieldEvidence: imapIngestionMessages.fieldEvidence,
    }).from(imapIngestionMessages).where(or(
      and(isNull(imapIngestionMessages.proposalEnc), sql`${imapIngestionMessages.proposal} <> '{}'::jsonb`),
      and(isNull(imapIngestionMessages.fieldEvidenceEnc), sql`${imapIngestionMessages.fieldEvidence} <> '{}'::jsonb`),
    )).limit(batchSize);

    for (const row of receiptRows) {
      const cipher = await cipherFor(ciphers, row.householdId, transaction);
      const updated = await transaction.update(imapIngestionMessages).set({
        proposal: {},
        proposalEnc: cipher.encryptJson("imap_ingestion_messages.proposal", row.id, row.proposal),
        fieldEvidence: {},
        fieldEvidenceEnc: cipher.encryptJson("imap_ingestion_messages.field_evidence", row.id, row.fieldEvidence),
      }).where(and(
        eq(imapIngestionMessages.id, row.id),
        isNull(imapIngestionMessages.proposalEnc),
        isNull(imapIngestionMessages.fieldEvidenceEnc),
      )).returning({ id: imapIngestionMessages.id });
      convertedReceipts += updated.length;
    }

    // Invitations (#963). Only open ones are converted: a redeemed or
    // withdrawn row is spent, nothing reads its address again, and rewriting
    // it would risk the partial unique index for no gain. The contract release
    // clears the rest when it drops the column.
    const invitationRows = await transaction.select({
      id: householdInvitations.id,
      householdId: householdInvitations.householdId,
      email: householdInvitations.email,
    }).from(householdInvitations).where(and(
      isNotNull(householdInvitations.email),
      isNull(householdInvitations.emailEnc),
      isNull(householdInvitations.redeemedAt),
      isNull(householdInvitations.revokedAt),
    )).limit(batchSize);

    for (const row of invitationRows) {
      const cipher = await cipherFor(ciphers, row.householdId, transaction);
      const updated = await transaction.update(householdInvitations).set({
        email: null,
        emailEnc: cipher.encryptText("household_invitations.email", row.id, row.email),
        emailIndex: cipher.blindIndex("household_invitations.email", row.email),
      }).where(and(
        eq(householdInvitations.id, row.id),
        isNull(householdInvitations.emailEnc),
      )).returning({ id: householdInvitations.id });
      convertedInvitations += updated.length;
    }

    return { items: convertedItems, receipts: convertedReceipts, invitations: convertedInvitations };
  });
}

const workerState = globalThis as typeof globalThis & {
  __orbitMetadataBackfillStarted?: boolean;
};

/**
 * Drains the backlog, then stops for good: unlike the polling workers this is
 * a one-off conversion, not a recurring tick. A locked instance (no KEK) stops
 * without converting anything and without failing start-up, exactly as
 * document operations lock rather than block the application.
 */
export function startMetadataBackfill(batchSize = METADATA_BACKFILL_BATCH): void {
  if (workerState.__orbitMetadataBackfillStarted) return;
  workerState.__orbitMetadataBackfillStarted = true;

  const drain = async () => {
    try {
      const batch = await runMetadataBackfillBatch(batchSize);
      if (backfillComplete(batch)) {
        log.info({ event: "metadata.backfill", state: "completed", action: "none" });
        return;
      }
      setTimeout(() => void drain(), 0).unref();
    } catch (error) {
      if (error instanceof MetadataKeyLockedError) {
        log.warn({
          event: "metadata.backfill",
          state: "blocked",
          reason: "key_unavailable",
          action: "check_configuration",
          impact: "metadata_field_unreadable",
        });
        return;
      }
      log.error({
        event: "metadata.backfill",
        state: "retrying",
        reason: "worker_cycle_failed",
        action: "inspect_admin_diagnostics",
        impact: "worker_degraded",
      });
    }
  };
  void drain();
}
