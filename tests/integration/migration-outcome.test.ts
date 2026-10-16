import { drizzle } from "drizzle-orm/postgres-js";
import { afterEach, describe, expect, it } from "vitest";
import { ensureMigrationRunsTable, recordMigrationOutcome } from "../../src/db/migration-outcome";
import { createMigrationTestDatabase } from "./support/migration-fixture";

const databases: Array<Awaited<ReturnType<typeof createMigrationTestDatabase>>> = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.cleanup()));
});

describe("migration outcome bookkeeping on the client the app shares with drizzle", () => {
  /* Boot runs `migrate(getDb())`, and building the drizzle instance swaps the
     shared postgres.js client's timestamp serializers for pass-throughs. A
     Date bound through that client afterwards never reaches the server:
     postgres.js throws ERR_INVALID_ARG_TYPE, boot's bare catch logs
     `startup.migration state=degraded`, and every run went unrecorded. */
  it("records a run after drizzle has wrapped the same client", async () => {
    const database = await createMigrationTestDatabase("migration-outcome-shared-client");
    databases.push(database);
    drizzle(database.client);

    await ensureMigrationRunsTable(database.client);
    const startedAt = new Date("2026-10-07T14:33:40.513Z");
    const finishedAt = new Date("2026-10-07T14:33:41.310Z");
    await recordMigrationOutcome(database.client, { startedAt, finishedAt, outcome: "succeeded", reason: null });

    const rows = await database.client.unsafe(
      'SELECT "started_at" = \'2026-10-07T14:33:40.513Z\'::timestamptz AS "started_matches", '
      + '"finished_at" = \'2026-10-07T14:33:41.310Z\'::timestamptz AS "finished_matches", '
      + '"outcome", "reason" FROM "drizzle"."orbit_migration_runs"',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.started_matches).toBe(true);
    expect(rows[0]?.finished_matches).toBe(true);
    expect(rows[0]?.outcome).toBe("succeeded");
    expect(rows[0]?.reason).toBeNull();
  });
});
