import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDatabase, getDatabaseClient, getDb } from "@/db";
import { log } from "@/lib/logger";
import { describeMigrationFailureDetail, resolveMigrationsFolder } from "@/server/boot";

async function main() {
  // The same resolver `registerNode`'s own migrate-on-boot uses (#1151
  // A4-Q2): this manual command used to hard-code "drizzle" regardless of
  // DRIZZLE_MIGRATIONS_PATH, so it could apply a different set of migrations
  // from the one boot had already validated.
  const migrationsFolder = resolveMigrationsFolder();
  try {
    log.info({ event: "database.migration", state: "starting", action: "check_migrations" });
    await migrate(getDb(), { migrationsFolder });
    log.info({ event: "database.migration", state: "ready", action: "none" });
  } catch (error) {
    // #1151 A4-S1: this used to be a bare `catch {}`, rethrowing a plain
    // "migration_failed" with nothing an operator running this by hand could
    // act on. `describeMigrationFailureDetail` is boot's own helper for the
    // identical failure, so the manual command and a failed boot now say the
    // same thing about the same migration.
    const detail = await describeMigrationFailureDetail(getDatabaseClient(), migrationsFolder, error);
    log.error({
      event: "database.migration",
      state: "exhausted",
      reason: "migration_failed",
      action: "check_migrations",
      impact: "migration_blocked",
      detail,
    });
    throw new Error("migration_failed");
  } finally {
    await closeDatabase();
  }
}

void main();
