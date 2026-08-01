/**
 * Reports whether a required malware scanner is actually reachable.
 *
 * Scanning is fail-closed, so a required-but-absent scanner blocks every upload.
 * Surfacing that at startup turns a silent per-upload failure into one
 * actionable condition. It deliberately does not stop the process: document
 * operations fail closed while the rest of the application stays available.
 */
const SCANNER_STARTUP_WINDOW_MS = 180_000;
const SCANNER_READINESS_RETRY_INTERVAL_MS = 5_000;

/**
 * Validates authentication configuration in the Node runtime without making
 * startup or public health depend on private runtime configuration.
 */
export async function reportAuthConfigurationReadiness(): Promise<void> {
  const [{ getAuthConfig }, { reportAuthConfiguration }] = await Promise.all([
    import("@/lib/env"),
    import("@/lib/auth/observability"),
  ]);

  try {
    getAuthConfig();
    reportAuthConfiguration("ready");
  } catch {
    reportAuthConfiguration("invalid");
  }
}

type ClamAvOptions = { host: string; port: number; timeoutMs: number };

function retryScannerReadiness(
  pingClamAv: (options: ClamAvOptions) => Promise<boolean>,
  clamAv: ClamAvOptions,
  onReady: () => void,
  onUnreachable: () => void,
): void {
  const deadline = Date.now() + SCANNER_STARTUP_WINDOW_MS;

  const retry = async (): Promise<void> => {
    let ready = false;
    try {
      ready = await pingClamAv(clamAv);
    } catch {
      // A startup ping failure is expected while the scanner is initialising.
    }

    if (ready) {
      onReady();
      return;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      onUnreachable();
      return;
    }

    setTimeout(retry, Math.min(SCANNER_READINESS_RETRY_INTERVAL_MS, remainingMs)).unref();
  };

  setTimeout(retry, SCANNER_READINESS_RETRY_INTERVAL_MS).unref();
}

export async function reportScannerReadiness(): Promise<void> {
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

  let ready = false;
  try {
    ready = await pingClamAv(config.clamAv);
  } catch {
    // A startup ping failure is expected while the scanner is initialising.
  }

  if (ready) {
    log.info("document.scanner", { state: "ready" });
    return;
  }

  log.info("document.scanner", {
    state: "starting",
    impact: "document_upload_blocked",
  });
  retryScannerReadiness(
    pingClamAv,
    config.clamAv,
    () => log.info("document.scanner", { state: "ready" }),
    () => log.error("document.scanner", {
      state: "unreachable",
      impact: "document_upload_blocked",
    }),
  );
}

export async function registerNode(): Promise<void> {
  void reportAuthConfigurationReadiness().catch(() => undefined);

  if (process.env.MIGRATE_ON_START === "true") {
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
