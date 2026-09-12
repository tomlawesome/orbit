import { sql } from "drizzle-orm";

import { getDb } from "@/db";

/**
 * Whether a recovery bundle covering the *currently active* document KEK has
 * been recorded, and when (#968, slice 1 of #966's encrypt-all decision) —
 * for the administration screen's persistent "no recovery bundle exported"
 * card. Modeled directly on `getKekRotationStatus`
 * (`src/server/documents/rotation-status.ts`, #956): a durable fact read
 * straight from `audit_log`, no new table, because "this happened, and when"
 * is exactly what that ledger already exists to hold — and this module never
 * sees the bundle itself or the passphrase, only the fact that an export
 * completed.
 *
 * "Exported" is temporal, mirroring `openRotationStartWith`'s own started-vs-
 * completed comparison: the latest `recovery_bundle_exported` row must be
 * newer than the latest `document_kek_rotation_completed` row, because a
 * bundle recorded before a completed rotation wraps a key that is no longer
 * the live one. That is the owner's "re-arms after a KEK rotation" ruling on
 * #968 — deliberately anchored on the rotation's *completion*, not its
 * start, since the previously-exported bundle still recovers the correct key
 * for as long as the rotation is only mid-flight.
 */

export interface RecoveryBundleStatus {
  /** True once a bundle has been recorded for the currently active key. */
  exported: boolean;
  /** ISO timestamp of the most recent qualifying export, or null when none does. */
  exportedAt: string | null;
}

interface StatusRow {
  exportedAt: Date | string | null;
}

/** The same raw-`execute` shape `rewrap-worker.ts`'s `AuditExecutor` uses, so a fake for tests needs only this. */
type StatusExecutor = Pick<ReturnType<typeof getDb>, "execute">;

/**
 * The query half, separated from `getRecoveryBundleStatus` below purely for
 * testability: a fake executor can exercise the SQL's own comparison without
 * a real Postgres connection, the same split `openRotationStartWith` uses.
 */
export async function computeRecoveryBundleStatus(executor: StatusExecutor): Promise<RecoveryBundleStatus> {
  const rows = await executor.execute(sql<StatusRow>`
    select max(created_at) as "exportedAt"
    from audit_log
    where entity_type = 'recovery_bundle'
      and action = 'recovery_bundle_exported'
      and created_at > coalesce((
        select max(created_at) from audit_log
        where entity_type = 'document_kek'
          and action = 'document_kek_rotation_completed'
      ), '-infinity')
  `);
  const row = (rows as unknown as StatusRow[])[0];
  const exportedAt = row?.exportedAt ?? null;
  if (!exportedAt) return { exported: false, exportedAt: null };
  const date = exportedAt instanceof Date ? exportedAt : new Date(exportedAt);
  return { exported: true, exportedAt: date.toISOString() };
}

/**
 * Never throws: like `getKekRotationStatus`, a status that cannot be
 * answered defaults toward not alarming rather than sinking the
 * administration screen over it. An `audit_log` outage is an infrastructure
 * fault with its own reporting path, not evidence the operator skipped the
 * export.
 */
export async function getRecoveryBundleStatus(): Promise<RecoveryBundleStatus> {
  try {
    return await computeRecoveryBundleStatus(getDb());
  } catch {
    return { exported: true, exportedAt: null };
  }
}
