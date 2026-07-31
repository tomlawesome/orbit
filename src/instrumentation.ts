/**
 * Reports whether a required malware scanner is actually reachable.
 *
 * Scanning is fail-closed, so a required-but-absent scanner blocks every upload.
 * Surfacing that at startup turns a silent per-upload failure into one
 * actionable condition. It deliberately does not stop the process: document
 * operations fail closed while the rest of the application stays available.
 */
async function reportScannerReadiness(): Promise<void> {
  const [{ getDocumentConfig }, { pingClamAv }, { log }] = await Promise.all([
    import("@/server/documents/config"),
    import("@/server/documents/scanner"),
    import("@/lib/logger"),
  ]);

  let config: ReturnType<typeof getDocumentConfig>;
  try {
    config = getDocumentConfig();
  } catch {
    // Document configuration is reported by its own failure path on first use.
    return;
  }

  if (config.scanMode !== "required") {
    log.info("document.scanner", { state: "disabled", reason: "scan_mode_disabled" });
    return;
  }

  const ready = await pingClamAv(config.clamAv);
  if (ready) {
    log.info("document.scanner", { state: "ready", host: config.clamAv.host, port: config.clamAv.port });
    return;
  }
  log.error("document.scanner", {
    state: "unreachable",
    host: config.clamAv.host,
    port: config.clamAv.port,
    impact: "document_upload_blocked",
  });
}

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
    const [{ startNotificationWorker }, { startDocumentWorker }, { startImapIngestionWorker }, { startImapReceiptWorker }] = await Promise.all([
      import("@/server/notification-worker"),
      import("@/server/document-worker"),
      import("@/server/imap-ingestion"),
      import("@/server/imap-receipt-worker"),
    ]);
    startNotificationWorker();
    startDocumentWorker();
    startImapIngestionWorker();
    startImapReceiptWorker();
  }

  // Probed after workers start so a slow or absent scanner never delays them.
  // Failure is reported, never thrown: readiness is the health surface's job.
  void reportScannerReadiness().catch(() => undefined);
}
