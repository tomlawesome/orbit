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
 * The two words `GET /api/auth/availability` exposes as `phase` (#869): a
 * strict, terminating fact the process itself holds, so the sign-in door can
 * stop inferring boot from a content-free `degraded` readiness answer.
 * `"starting"` for every process from the moment it is created; `"running"`
 * exactly once, when {@link registerNode}'s own sequence — configuration,
 * readiness reports, migrate-on-boot, workers — has finished. A
 * `registerNode` rejection never flips it: `web/src/hooks.server.js` exits
 * the process instead, so a process still answering "starting" is never
 * wrong to have said so — it is dying, not stuck.
 */
export type BootPhase = "starting" | "running";

let bootPhase: BootPhase = "starting";

export function getBootPhase(): BootPhase {
  return bootPhase;
}

/**
 * Test-only: set the phase directly, so a route or door-state test can
 * exercise the "running" branch without paying for the full mocked
 * `registerNode` sequence below.
 */
export function setBootPhaseForTests(phase: BootPhase | undefined): void {
  bootPhase = phase ?? "starting";
}

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

/**
 * Says, on every startup that finds `DOCUMENT_KEK_NEXT` loaded, that a
 * document-KEK rotation is in progress (#956) — and makes sure the rotation
 * has its one instance-level `document_kek_rotation_started` audit row, so
 * "how long has this been open?" is answerable from the instance.
 *
 * A rotation in progress is not a configuration problem — the operator put
 * the second key there on purpose, mid-procedure — so this is its own
 * `document.kek_rotation` event on the same boot-time surface as
 * `configuration.problem`, never filed as one. And it never blocks startup:
 * a hard cut-off would turn a slow rotation into an outage, which is worse
 * than the two-key window it would be guarding (#956, owner 2026-09-10).
 */
export async function reportKekRotationInProgress(): Promise<void> {
  const [{ getDocumentConfig }, { log, operationalDetail }] = await Promise.all([
    import("@/server/documents/config"),
    import("@/lib/logger"),
  ]);

  let config: ReturnType<typeof getDocumentConfig>;
  try {
    config = getDocumentConfig();
  } catch {
    // Broken document configuration is reported by its own path.
    return;
  }
  if (!config.nextKeyId) return;

  let startedAt: Date | null = null;
  try {
    const { recordRotationStarted } = await import("@/server/documents/rewrap-worker");
    startedAt = (await recordRotationStarted({
      previousKeyId: config.keyId,
      nextKeyId: config.nextKeyId,
    })).startedAt;
  } catch {
    // The reminder below still goes out; only the durable row and the
    // duration are missing, and refusing to start over bookkeeping is
    // exactly what this path must never do.
    log.warn({
      event: "document.kek_rotation",
      state: "degraded",
      reason: "unexpected_failure",
      action: "inspect_admin_diagnostics",
      impact: "none",
    });
  }

  log.warn({
    event: "document.kek_rotation",
    state: "starting",
    action: "inspect_admin_diagnostics",
    impact: "none",
    detail: operationalDetail`rotation in progress from key ${config.keyId} to ${config.nextKeyId} - deliberate and safe, but meant to be short: finish the rewrap and remove DOCUMENT_KEK_NEXT`,
    ...(startedAt ? { durationMs: Date.now() - startedAt.getTime() } : {}),
  });
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
          /* The specific rule that failed and its remedy (#717), added
             alongside the coded fields above rather than replacing them —
             `reason`/`setting`/`problemCode` keep the exact shape anything
             already greps for (repair.sh's own trap, #447). */
          ...(issue.detail ? { detail: issue.detail } : {}),
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
    const [{ migrate }, { getDb }, { ensureMigrationRunsTable, recordMigrationOutcome }] = await Promise.all([
      import("drizzle-orm/postgres-js/migrator"),
      import("@/db"),
      import("@/db/migration-outcome"),
    ]);
    /* The outcome table is bookkeeping, not a startup gate (#528): a
       problem creating or writing it must never mask or alter the
       migration's own success or failure, so failures here only degrade.
       Reuses existing sentinel vocabulary (no new reason/impact tokens) -
       the migration's own outcome is already logged in full above/below;
       this only flags that its bookkeeping row may be missing. */
    const logMigrationOutcomeUnavailable = () => log.warn({
      event: "startup.migration",
      state: "degraded",
      reason: "unexpected_failure",
      action: "inspect_admin_diagnostics",
      impact: "none",
    });
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
        ? ({ reason: "migration_integrity", action: "check_migrations" } as const)
        : code === "database_floor"
          ? ({ reason: "database_below_floor", action: "upgrade_from_supported_version" } as const)
          : ({ reason: "database_mismatch", action: "attach_matching_database" } as const);
      log.error({
        event: "startup.migration",
        state: "exhausted",
        ...verdict,
        /* The bounded description of what disagreed - tags and counts only,
           never SQL or credentials (see MigrationIntegrityError.detail). It
           is an OperationalDetail, so it is carried into the rendered text
           and JSON lines rather than dropped between here and stderr (#718). */
        ...(error instanceof MigrationIntegrityError && error.detail
          ? { detail: error.detail }
          : {}),
        impact: "migration_blocked",
      });
      throw new Error(code);
    }
    try {
      await ensureMigrationRunsTable(getDatabaseClient());
    } catch {
      logMigrationOutcomeUnavailable();
    }
    const migrationStartedAt = new Date();
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
      try {
        await recordMigrationOutcome(getDatabaseClient(), {
          startedAt: migrationStartedAt,
          finishedAt: new Date(),
          outcome: "failed",
          reason: "migration_failed",
        });
      } catch {
        logMigrationOutcomeUnavailable();
      }
      throw new Error("migration_failed");
    }
    try {
      await recordMigrationOutcome(getDatabaseClient(), {
        startedAt: migrationStartedAt,
        finishedAt: new Date(),
        outcome: "succeeded",
        reason: null,
      });
    } catch {
      logMigrationOutcomeUnavailable();
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
    const [{ startNotificationWorker }, { startDocumentWorker }, { startImapIngestionWorker }, { startImapReceiptWorker }, { startMaintenanceWorker }] = await Promise.all([
      import("@/server/notification-worker"),
      import("@/server/document-worker"),
      import("@/server/imap-ingestion"),
      import("@/server/imap-receipt-worker"),
      import("@/server/maintenance-worker"),
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
    // Unconditional: scheduled maintenance depends on no optional setting.
    startMaintenanceWorker();

    /* The Tier 1 metadata backfill (ADR-0024 decision 3). It runs once, drains
       the rows migration 0040 could not encrypt, and stops; an instance with
       no key-encryption key logs and stops without converting anything, rather
       than holding up start-up. */
    const { startMetadataBackfill } = await import("@/server/metadata/backfill");
    startMetadataBackfill();
  }

  // The strict sequence (#869) is done: configuration, readiness reports,
  // migrate-on-boot, workers. Everything past this point is best-effort
  // post-boot reporting, not a boot step, so it flips before the scanner
  // probe kicks off rather than after.
  bootPhase = "running";

  // Best-effort: the reminder that a KEK rotation is open must appear in
  // every boot's log, but a failed audit write may not stop the boot (#956)
  // — every failure inside is caught, and this catch is the last net.
  // Awaited, unlike the scanner probe below, so the reminder lands in the
  // startup log deterministically rather than racing the claim notice; it
  // is one config read on the common no-rotation path.
  await reportKekRotationInProgress().catch(() => {
    log.warn({
      event: "document.kek_rotation",
      state: "degraded",
      reason: "unexpected_failure",
      action: "inspect_admin_diagnostics",
      impact: "none",
    });
  });

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

  /* The last act of start-up (ADR-0022 §1). On an unclaimed instance this
     prints the claim notice, so it is the last line of `docker logs
     orbit-app` until the first request arrives and the operator can open it
     straight from there. On a claimed instance it generates nothing and
     prints nothing. It throws only when no code can be produced at all, which
     is a start-up fault like any other: an instance that is up and unclaimed
     always has a live code (ADR-0022 §3). */
  const { printClaimNotice } = await import("@/lib/auth/bootstrap");
  await printClaimNotice();
}
