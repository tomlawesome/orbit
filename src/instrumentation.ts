import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getDb } from "@/db";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  if (process.env.MIGRATE_ON_START === "true") {
    await migrate(getDb(), { migrationsFolder: process.env.DRIZZLE_MIGRATIONS_PATH ?? "drizzle" });
  }

  if (process.env.WORKER_ENABLED === "true") {
    const { startNotificationWorker } = await import("@/server/notification-worker");
    startNotificationWorker();
  }
}
