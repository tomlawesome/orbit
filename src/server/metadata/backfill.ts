/**
 * The encrypted-metadata backfill (ADR-0024 decision 3), in the resumable-job
 * mould of ADR-0010. It covers Tier 1 (#931) and Tier 2 (#963, extended by
 * #969) together, in one pass over each table, because every tier shares one
 * key hierarchy and one envelope.
 *
 * Migrations 0040, 0041 and 0044 cannot do this work: encrypting needs the key-encryption key,
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
import { householdInvitations, imapIngestionMessages, items, mailInSenderAddresses, users } from "@/db/schema";
import { log } from "@/lib/logger";
import { MetadataKeyLockedError, resolveMetadataKey } from "@/server/metadata/keys";
import { MetadataCipher, type MetadataExecutor } from "@/server/metadata/fields";

/** Small enough that one transaction is short, large enough to drain quickly. */
export const METADATA_BACKFILL_BATCH = 100;

export interface MetadataBackfillBatch {
  items: number;
  receipts: number;
  invitations: number;
  users: number;
  senderAddresses: number;
}

/** True when this batch converted nothing, so there is no more work. */
export function backfillComplete(batch: MetadataBackfillBatch): boolean {
  return batch.items === 0 && batch.receipts === 0 && batch.invitations === 0
    && batch.users === 0 && batch.senderAddresses === 0;
}

/** Whether a JSONB draft column holds anything worth protecting. */
function hasJsonContent(value: unknown): boolean {
  return value !== null && typeof value === "object" && Object.keys(value as Record<string, unknown>).length > 0;
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
    let convertedUsers = 0;
    let convertedSenderAddresses = 0;

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
      /* Each column pair converts independently (#1151 A3-F1): the old single
         update required ALL FIVE *_enc columns to still be null, so an item
         with even one pair already converted on its own -- the draft-approval
         path encrypts `reference` by itself -- matched the select above
         forever and never matched this update's guard, so it was "selected"
         every batch and converted on none of them. `backfillComplete` only
         counts conversions, so the job would log "completed" with that row
         still carrying plaintext. */
      let convertedThisRow = false;

      if (row.reference !== null) {
        const changed = await transaction.update(items).set({
          reference: null,
          referenceEnc: cipher.encryptText("items.reference", row.id, row.reference),
          referenceIndex: cipher.referenceIndex(row.reference),
        }).where(and(eq(items.id, row.id), isNull(items.referenceEnc))).returning({ id: items.id });
        convertedThisRow ||= changed.length > 0;
      }
      if (row.notes !== null) {
        const changed = await transaction.update(items).set({
          notes: null,
          notesEnc: cipher.encryptText("items.notes", row.id, row.notes),
        }).where(and(eq(items.id, row.id), isNull(items.notesEnc))).returning({ id: items.id });
        convertedThisRow ||= changed.length > 0;
      }
      if (row.title !== null) {
        const changed = await transaction.update(items).set({
          title: null,
          titleEnc: cipher.encryptText("items.title", row.id, row.title),
        }).where(and(eq(items.id, row.id), isNull(items.titleEnc))).returning({ id: items.id });
        convertedThisRow ||= changed.length > 0;
      }
      if (row.provider !== null) {
        const changed = await transaction.update(items).set({
          provider: null,
          providerEnc: cipher.encryptText("items.provider", row.id, row.provider),
        }).where(and(eq(items.id, row.id), isNull(items.providerEnc))).returning({ id: items.id });
        convertedThisRow ||= changed.length > 0;
      }
      if (row.costMinor !== null) {
        const changed = await transaction.update(items).set({
          costMinor: null,
          costMinorEnc: cipher.encryptNumber("items.cost_minor", row.id, row.costMinor),
        }).where(and(eq(items.id, row.id), isNull(items.costMinorEnc))).returning({ id: items.id });
        convertedThisRow ||= changed.length > 0;
      }

      if (convertedThisRow) convertedItems += 1;
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
      /* Same independent-pairs fix as items, above (#1151 A3-F1): the old
         update required BOTH *_enc columns null, so a row with one already
         converted on its own matched the select forever and this guard
         never. */
      let convertedThisRow = false;

      if (hasJsonContent(row.proposal)) {
        const changed = await transaction.update(imapIngestionMessages).set({
          proposal: {},
          proposalEnc: cipher.encryptJson("imap_ingestion_messages.proposal", row.id, row.proposal),
        }).where(and(
          eq(imapIngestionMessages.id, row.id),
          isNull(imapIngestionMessages.proposalEnc),
        )).returning({ id: imapIngestionMessages.id });
        convertedThisRow ||= changed.length > 0;
      }
      if (hasJsonContent(row.fieldEvidence)) {
        const changed = await transaction.update(imapIngestionMessages).set({
          fieldEvidence: {},
          fieldEvidenceEnc: cipher.encryptJson("imap_ingestion_messages.field_evidence", row.id, row.fieldEvidence),
        }).where(and(
          eq(imapIngestionMessages.id, row.id),
          isNull(imapIngestionMessages.fieldEvidenceEnc),
        )).returning({ id: imapIngestionMessages.id });
        convertedThisRow ||= changed.length > 0;
      }

      if (convertedThisRow) convertedReceipts += 1;
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

    // Account addresses (#969), both under the instance key. Unlike the rows
    // above, these are the ones sign-in and attribution look up, so the blind
    // index is written in the same statement that clears the plaintext: a row
    // is never findable by neither.
    const userRows = await transaction.select({
      id: users.id,
      email: users.email,
    }).from(users).where(and(
      isNotNull(users.email),
      isNull(users.emailEnc),
    )).limit(batchSize);

    for (const row of userRows) {
      const cipher = await cipherFor(ciphers, null, transaction);
      const updated = await transaction.update(users).set({
        email: null,
        emailEnc: cipher.encryptText("users.email", row.id, row.email),
        emailIndex: cipher.emailIndex(row.email),
      }).where(and(
        eq(users.id, row.id),
        isNull(users.emailEnc),
      )).returning({ id: users.id });
      convertedUsers += updated.length;
    }

    const senderRows = await transaction.select({
      id: mailInSenderAddresses.id,
      address: mailInSenderAddresses.address,
    }).from(mailInSenderAddresses).where(and(
      isNotNull(mailInSenderAddresses.address),
      isNull(mailInSenderAddresses.addressEnc),
    )).limit(batchSize);

    for (const row of senderRows) {
      const cipher = await cipherFor(ciphers, null, transaction);
      const updated = await transaction.update(mailInSenderAddresses).set({
        address: null,
        addressEnc: cipher.encryptText("mail_in_sender_addresses.address", row.id, row.address),
        addressIndex: cipher.senderAddressIndex(row.address),
      }).where(and(
        eq(mailInSenderAddresses.id, row.id),
        isNull(mailInSenderAddresses.addressEnc),
      )).returning({ id: mailInSenderAddresses.id });
      convertedSenderAddresses += updated.length;
    }

    return {
      items: convertedItems,
      receipts: convertedReceipts,
      invitations: convertedInvitations,
      users: convertedUsers,
      senderAddresses: convertedSenderAddresses,
    };
  });
}

const workerState = globalThis as typeof globalThis & {
  __orbitMetadataBackfillStarted?: boolean;
};

/** The first retry waits this long after a batch fails outright. */
export const BACKFILL_RETRY_FLOOR_MS = 1_000;

/** The doubling stops here: five minutes, so a database that is down for a
 *  while is not hammered, but a restart is never the only way to recover. */
export const BACKFILL_RETRY_CEILING_MS = 5 * 60 * 1000;

/** Past this many back-to-back failures, "retrying" stops being the whole
 *  truth and the log says so (#1151 A3-R3): still retrying, but loudly. */
export const BACKFILL_RETRY_SURFACE_THRESHOLD = 5;

/** 1 s, 2 s, 4 s, ... capped at {@link BACKFILL_RETRY_CEILING_MS}. */
export function backfillRetryDelayMs(consecutiveFailures: number): number {
  return Math.min(BACKFILL_RETRY_FLOOR_MS * 2 ** (consecutiveFailures - 1), BACKFILL_RETRY_CEILING_MS);
}

/**
 * Drains the backlog, then stops for good: unlike the polling workers this is
 * a one-off conversion, not a recurring tick. A locked instance (no KEK) stops
 * without converting anything and without failing start-up, exactly as
 * document operations lock rather than block the application.
 *
 * A batch that throws for any other reason -- a database hiccup, most likely
 * -- used to log "retrying" and then never run again: the drain loop simply
 * returned, and everything still plaintext stayed that way until the next
 * restart (#1151 A3-R3). It now actually retries, on a bounded back-off, and
 * once enough attempts in a row have failed the log says so as "exhausted"
 * rather than going on calling it "retrying" forever.
 */
export function startMetadataBackfill(batchSize = METADATA_BACKFILL_BATCH): void {
  if (workerState.__orbitMetadataBackfillStarted) return;
  workerState.__orbitMetadataBackfillStarted = true;

  let consecutiveFailures = 0;

  const drain = async () => {
    try {
      const batch = await runMetadataBackfillBatch(batchSize);
      consecutiveFailures = 0;
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

      consecutiveFailures += 1;
      const exhausted = consecutiveFailures >= BACKFILL_RETRY_SURFACE_THRESHOLD;
      log.error({
        event: "metadata.backfill",
        state: exhausted ? "exhausted" : "retrying",
        reason: "worker_cycle_failed",
        action: exhausted ? "inspect_admin_diagnostics" : "retry",
        impact: "worker_degraded",
      });
      setTimeout(() => void drain(), backfillRetryDelayMs(consecutiveFailures)).unref();
    }
  };
  void drain();
}
