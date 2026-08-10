import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDatabase, getDb } from "@/db";
import { log } from "@/lib/logger";

async function main() {
  try {
    log.info({ event: "database.migration", state: "starting", action: "check_migrations" });
    await migrate(getDb(), { migrationsFolder: "drizzle" });
    log.info({ event: "database.migration", state: "ready", action: "none" });
  } catch {
    log.error({
      event: "database.migration",
      state: "exhausted",
      reason: "migration_failed",
      action: "check_migrations",
      impact: "migration_blocked",
    });
    throw new Error("migration_failed");
  } finally {
    await closeDatabase();
  }
}

void main();
