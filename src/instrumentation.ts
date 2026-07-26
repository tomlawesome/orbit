export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  if (process.env.MIGRATE_ON_START === "true") {
    // Keep database and filesystem dependencies out of the Edge instrumentation bundle.
    const [{ migrate }, { getDb }] = await Promise.all([
      import("drizzle-orm/postgres-js/migrator"),
      import("@/db"),
    ]);

    await migrate(getDb(), { migrationsFolder: process.env.DRIZZLE_MIGRATIONS_PATH ?? "drizzle" });
  }

  if (process.env.WORKER_ENABLED === "true") {
    const [{ startNotificationWorker }, { startDocumentWorker }, { startImapIngestionWorker }] = await Promise.all([
      import("@/server/notification-worker"),
      import("@/server/document-worker"),
      import("@/server/imap-ingestion"),
    ]);
    startNotificationWorker();
    startDocumentWorker();
    startImapIngestionWorker();
  }
}
