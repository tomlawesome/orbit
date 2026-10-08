export type SqlClient = { unsafe(query: string, params?: unknown[]): Promise<Array<Record<string, unknown>>> };

export type MigrationRunOutcome = "succeeded" | "failed";

/** The only reason token a run can currently record (#528 slice A). */
export type MigrationRunReason = "migration_failed";

export type MigrationRunRecord = {
  startedAt: Date;
  finishedAt: Date;
  outcome: MigrationRunOutcome;
  reason: MigrationRunReason | null;
};

/**
 * Idempotently creates the migrator's own bookkeeping table (#528).
 *
 * Deliberately not a journal migration: a migration that only runs after
 * migrations succeed cannot record the run where migrations first fail on a
 * fresh install, and shipping it as one would also reopen #535. The wrapper
 * creates its own home the same way drizzle creates `__drizzle_migrations`.
 */
export async function ensureMigrationRunsTable(client: SqlClient): Promise<void> {
  await client.unsafe('CREATE SCHEMA IF NOT EXISTS "drizzle"');
  await client.unsafe(
    'CREATE TABLE IF NOT EXISTS "drizzle"."orbit_migration_runs" ('
    + '"id" bigserial PRIMARY KEY, '
    + '"started_at" timestamptz NOT NULL, '
    + '"finished_at" timestamptz, '
    + '"outcome" text NOT NULL, '
    + '"reason" text)',
  );
}

/**
 * Records one migrator run. Callers pass a client outside drizzle's own
 * migration transaction, so this insert commits on its own even when a
 * failed migration rolled back (#528).
 *
 * The timestamps go in as ISO strings, not Dates: boot's client is the one
 * `getDb()` hands to drizzle, and drizzle replaces that client's timestamp
 * serializers with pass-throughs, so a Date bound after `migrate(getDb())`
 * makes postgres.js throw before the insert is sent and the run goes
 * unrecorded.
 */
export async function recordMigrationOutcome(client: SqlClient, run: MigrationRunRecord): Promise<void> {
  await client.unsafe(
    'INSERT INTO "drizzle"."orbit_migration_runs" ("started_at", "finished_at", "outcome", "reason") '
    + "VALUES ($1::timestamptz, $2::timestamptz, $3, $4)",
    [run.startedAt.toISOString(), run.finishedAt.toISOString(), run.outcome, run.reason],
  );
}
