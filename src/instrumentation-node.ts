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
    log.warn({
      event: "document.scanner",
      state: "degraded",
      reason: "configuration_optional",
      action: "repair_configuration",
      impact: "document_upload_blocked",
    });
    return;
  }

  if (config.scanMode !== "required") {
    log.info({ event: "document.scanner", state: "disabled", reason: "scan_mode_disabled", action: "none" });
    return;
  }

  let ready = false;
  try {
    ready = await pingClamAv(config.clamAv);
  } catch {
    // A startup ping failure is expected while the scanner is initialising.
  }

  if (ready) {
    log.info({ event: "document.scanner", state: "ready", action: "none" });
    return;
  }

  log.info({
    event: "document.scanner",
    state: "starting",
    reason: "dependency_unavailable",
    action: "check_scanner",
    impact: "document_upload_blocked",
  });
  retryScannerReadiness(
    pingClamAv,
    config.clamAv,
    () => log.info({ event: "document.scanner", state: "recovered", action: "none" }),
    () => log.error({
      event: "document.scanner",
      state: "exhausted",
      reason: "scanner_unavailable",
      action: "check_scanner",
      impact: "document_upload_blocked",
    }),
  );
}

export async function registerNode(): Promise<void> {
  const [{ validateStartupConfiguration, StartupConfigurationError }, { getDatabaseClient }, { verifyMigrationIntegrity, verifyMigrationJournalComplete, MigrationIntegrityError }, { log }, { getConfigurationProblems }] = await Promise.all([
    import("@/lib/startup-config"),
    import("@/db"),
    import("@/db/migration-integrity"),
    import("@/lib/logger"),
    import("@/lib/configuration-problems"),
  ]);

  log.info({ event: "application.startup", state: "starting", action: "none" });

  try {
    validateStartupConfiguration();
  } catch (error) {
    const issues = error instanceof StartupConfigurationError ? error.issues : [];
    if (issues.length > 0) {
      for (const issue of issues) {
        log.error({
          event: "configuration.problem",
          state: issue.code === "configuration_optional" ? "degraded" : "blocked",
          reason: issue.code === "configuration_version"
            ? "configuration_version"
            : issue.code === "configuration_optional" ? "configuration_optional" : "configuration_invalid",
          action: issue.code === "configuration_optional" ? "repair_configuration" : "check_configuration",
          impact: issue.code === "configuration_optional" ? "application_degraded" : "application_unavailable",
          setting: issue.field,
          problemCode: issue.code,
          fallback: issue.code === "configuration_optional" ? "feature_disabled" : "startup_blocked",
        });
      }
    } else {
      log.error({
        event: "startup.configuration",
        state: "blocked",
        reason: "configuration_invalid",
        action: "check_configuration",
        impact: "application_unavailable",
      });
    }
    throw new Error("configuration_invalid");
  }

  await reportAuthConfigurationReadiness();

  if (process.env.MIGRATE_ON_START === "true") {
    const [{ migrate }, { getDb }] = await Promise.all([
      import("drizzle-orm/postgres-js/migrator"),
      import("@/db"),
    ]);
    try {
      const migrationsFolder = process.env.DRIZZLE_MIGRATIONS_PATH ?? "drizzle";
      log.info({ event: "startup.migration", state: "starting", action: "check_migrations" });
      await verifyMigrationIntegrity(getDatabaseClient(), migrationsFolder);
    } catch (error) {
      const code = error instanceof MigrationIntegrityError ? error.code : "migration_integrity";
      /*
       * Refusing to start against a database this build does not recognise is
       * correct and deliberate. Saying so unreadably is not (#437): the only
       * thing an operator saw was Next's "error occurred while loading
       * instrumentation hook", repeated on every restart, with the container
       * stuck at health: starting and no way to tell it from a slow boot.
       *
       * So the log now names the condition in Orbit's own words, carries the
       * bounded detail of what disagreed, and states the remedy - which is
       * never "restart", because a restart cannot change either side.
       */
      /* Only an actual integrity verdict earns the precise vocabulary. This
         catch also swallows connection failures - a wrong password reaches
         here too - and calling that a database mismatch would send an
         operator hunting the wrong problem. The reason and its remedy are one
         verdict, so they travel as one pair. */
      const verdict = !(error instanceof MigrationIntegrityError)
        ? { reason: "migration_integrity", action: "check_migrations" }
        : code === "database_floor"
          ? { reason: "database_below_floor", action: "upgrade_from_supported_version" }
          : { reason: "database_mismatch", action: "attach_matching_database" };
      log.error({
        event: "startup.migration",
        state: "exhausted",
        ...verdict,
        /* The bounded description of what disagreed - tags and counts only,
           never SQL or credentials (see MigrationIntegrityError.detail). */
        ...(error instanceof MigrationIntegrityError && error.detail
          ? { detail: error.detail }
          : {}),
        impact: "migration_blocked",
      });
      throw new Error(code);
    }
    try {
      await migrate(getDb(), { migrationsFolder: process.env.DRIZZLE_MIGRATIONS_PATH ?? "drizzle" });
    } catch {
      log.error({
        event: "startup.migration",
        state: "exhausted",
        reason: "migration_failed",
        action: "check_migrations",
        impact: "migration_blocked",
      });
      throw new Error("migration_failed");
    }
    try {
      await verifyMigrationJournalComplete(getDatabaseClient(), process.env.DRIZZLE_MIGRATIONS_PATH ?? "drizzle");
    } catch {
      log.error({
        event: "startup.migration",
        state: "exhausted",
        reason: "migration_integrity",
        action: "check_migrations",
        impact: "migration_blocked",
      });
      throw new Error("migration_integrity");
    }
    log.info({ event: "startup.migration", state: "ready", action: "none" });
  }

  if (process.env.WORKER_ENABLED === "true") {
    const [{ startNotificationWorker }, { startDocumentWorker }, { startImapIngestionWorker }, { startImapReceiptWorker }] = await Promise.all([
      import("@/server/notification-worker"),
      import("@/server/document-worker"),
      import("@/server/imap-ingestion"),
      import("@/server/imap-receipt-worker"),
    ]);
    const optionalSettings = new Set(
      getConfigurationProblems()
        .filter((problem) => problem.severity === "warning")
        .map((problem) => problem.setting),
    );
    for (const problem of getConfigurationProblems().filter((problem) => problem.severity === "warning")) {
      log.warn({
        event: "configuration.problem",
        state: "degraded",
        reason: "configuration_optional",
        action: problem.remediation,
        impact: "application_degraded",
        setting: problem.setting,
        problemCode: problem.code,
        fallback: problem.fallback,
      });
    }
    if (!optionalSettings.has("mail")) startNotificationWorker();
    startDocumentWorker();
    if (!optionalSettings.has("imap")) startImapIngestionWorker();
    if (!optionalSettings.has("mail") && !optionalSettings.has("imap")) startImapReceiptWorker();
  }

  // Probed after workers start so a slow or absent scanner never delays them.
  // Failure is reported, never thrown: readiness is the health surface's job.
  void reportScannerReadiness().catch(() => {
    log.error({
      event: "document.scanner",
      state: "degraded",
      reason: "unexpected_failure",
      action: "inspect_admin_diagnostics",
      impact: "document_upload_blocked",
    });
  });

}
