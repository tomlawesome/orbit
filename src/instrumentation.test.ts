import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  config: {
    scanMode: "required",
    clamAv: { host: "private-scanner.internal", port: 3310, timeoutMs: 30_000 },
  },
  getAuthConfig: vi.fn(),
  pingClamAv: vi.fn(),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  getConfigurationProblems: vi.fn(() => [] as Array<{
    code: "configuration_optional";
    severity: "warning";
    setting: "mail";
    fallback: "feature_disabled";
    remediation: "repair_configuration";
  }>),
  registerNode: vi.fn(),
  validateStartupConfiguration: vi.fn(),
  getDatabaseClient: vi.fn(() => ({ unsafe: vi.fn() })),
  getDb: vi.fn(),
  verifyMigrationIntegrity: vi.fn(),
  verifyMigrationJournalComplete: vi.fn(),
  migrate: vi.fn(),
  workerCalls: [] as string[],
  MigrationIntegrityError: class MigrationIntegrityError extends Error {
    code: "migration_integrity";

    constructor(_message: string) {
      super(_message);
      this.code = "migration_integrity";
    }
  },
}));

vi.mock("@/server/documents/config", () => ({
  getDocumentConfig: () => mocks.config,
}));

vi.mock("@/server/documents/scanner", () => ({
  pingClamAv: mocks.pingClamAv,
}));

vi.mock("@/lib/env", () => ({
  getAuthConfig: mocks.getAuthConfig,
}));

vi.mock("@/lib/logger", () => ({
  log: mocks.log,
}));
vi.mock("@/lib/configuration-problems", () => ({
  getConfigurationProblems: mocks.getConfigurationProblems,
}));
vi.mock("@/lib/startup-config", () => ({
  validateStartupConfiguration: mocks.validateStartupConfiguration,
  StartupConfigurationError: class StartupConfigurationError extends Error {},
}));
vi.mock("@/db", () => ({
  getDatabaseClient: mocks.getDatabaseClient,
  getDb: mocks.getDb,
}));
vi.mock("@/db/migration-integrity", () => ({
  verifyMigrationIntegrity: mocks.verifyMigrationIntegrity,
  verifyMigrationJournalComplete: mocks.verifyMigrationJournalComplete,
  MigrationIntegrityError: mocks.MigrationIntegrityError,
}));
vi.mock("drizzle-orm/postgres-js/migrator", () => ({ migrate: mocks.migrate }));
vi.mock("@/server/notification-worker", () => ({ startNotificationWorker: () => mocks.workerCalls.push("notification") }));
vi.mock("@/server/document-worker", () => ({ startDocumentWorker: () => mocks.workerCalls.push("document") }));
vi.mock("@/server/imap-ingestion", () => ({ startImapIngestionWorker: () => mocks.workerCalls.push("imap") }));
vi.mock("@/server/imap-receipt-worker", () => ({ startImapReceiptWorker: () => mocks.workerCalls.push("receipt") }));

import { resetAuthObservabilityForTests } from "@/lib/auth/observability";

describe("instrumentation runtime boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    resetAuthObservabilityForTests();
    mocks.workerCalls.length = 0;
    mocks.validateStartupConfiguration.mockReset();
    mocks.verifyMigrationIntegrity.mockReset();
    mocks.verifyMigrationJournalComplete.mockReset();
    mocks.migrate.mockReset();
    mocks.getConfigurationProblems.mockReset();
    mocks.getConfigurationProblems.mockReturnValue([]);
    mocks.getDatabaseClient.mockClear();
    mocks.getDb.mockClear();
  });

  afterEach(() => {
    vi.doUnmock("./instrumentation-node");
    vi.resetModules();
    resetAuthObservabilityForTests();
    vi.unstubAllEnvs();
  });

  it("returns immediately without loading Node implementation when not in Node runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");

    vi.doMock("./instrumentation-node", () => ({
      registerNode: mocks.registerNode,
    }));

    const { register } = await import("./instrumentation");

    await register();

    expect(mocks.registerNode).not.toHaveBeenCalled();
  });

  it("loads and executes Node implementation when in Node runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");

    vi.doMock("./instrumentation-node", () => ({
      registerNode: mocks.registerNode,
    }));

    const { register } = await import("./instrumentation");

    await register();

    expect(mocks.registerNode).toHaveBeenCalledTimes(1);
  });

  it("keeps the Edge entry free of static imports", () => {
    const source = readFileSync(new URL("./instrumentation.ts", import.meta.url), "utf8");
    const staticImports = source.match(/^\s*import\s+(?!\()[^;]+;\s*$/gmu) ?? [];

    expect(staticImports).toEqual([]);
    expect(source).not.toContain("@/");
  });

  it("does not intercept termination signals", () => {
    const source = readFileSync(new URL("./instrumentation-node.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/process\.(once|on)\(\s*["']SIG(?:TERM|INT)/u);
  });
});

describe("strict startup ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    resetAuthObservabilityForTests();
    mocks.workerCalls.length = 0;
    mocks.getDatabaseClient.mockClear();
    mocks.getDb.mockClear();
    mocks.validateStartupConfiguration.mockReset();
    mocks.verifyMigrationIntegrity.mockReset();
    mocks.verifyMigrationJournalComplete.mockReset();
    mocks.migrate.mockReset();
    vi.stubEnv("MIGRATE_ON_START", "true");
    vi.stubEnv("WORKER_ENABLED", "true");
    mocks.validateStartupConfiguration.mockImplementation(() => mocks.workerCalls.push("configuration"));
    mocks.getAuthConfig.mockImplementation(() => {
      mocks.workerCalls.push("auth");
      return {};
    });
    mocks.verifyMigrationIntegrity.mockImplementation(() => mocks.workerCalls.push("precheck"));
    mocks.migrate.mockImplementation(() => mocks.workerCalls.push("migrate"));
    mocks.verifyMigrationJournalComplete.mockImplementation(() => mocks.workerCalls.push("postcheck"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("validates, reports auth, checks and migrates before workers", async () => {
    const { registerNode } = await import("./instrumentation-node");
    await registerNode();
    expect(mocks.workerCalls).toEqual(["configuration", "auth", "precheck", "migrate", "postcheck", "notification", "document", "imap", "receipt"]);
    expect(mocks.log.info).toHaveBeenCalledWith({ event: "startup.migration", state: "starting", action: "check_migrations" });
    expect(mocks.log.info).not.toHaveBeenCalledWith({ event: "application.startup", state: "ready", action: "none" });
  });

  it("keeps workers bootable while skipping workers for an optional disabled feature", async () => {
    mocks.getConfigurationProblems.mockReturnValue([{
      code: "configuration_optional",
      severity: "warning",
      setting: "mail",
      fallback: "feature_disabled",
      remediation: "repair_configuration",
    }]);
    vi.stubEnv("MIGRATE_ON_START", "false");

    const { registerNode } = await import("./instrumentation-node");
    await registerNode();

    expect(mocks.workerCalls).toEqual(["configuration", "auth", "document", "imap"]);
    expect(mocks.log.warn).toHaveBeenCalledWith({
      event: "configuration.problem",
      state: "degraded",
      reason: "configuration_optional",
      action: "repair_configuration",
      impact: "application_degraded",
      setting: "mail",
      problemCode: "configuration_optional",
      fallback: "feature_disabled",
    });
  });

  it("fails closed before database access and workers for invalid configuration", async () => {
    mocks.validateStartupConfiguration.mockImplementation(() => { throw new Error("private configuration value"); });
    const { registerNode } = await import("./instrumentation-node");
    await expect(registerNode()).rejects.toThrow("configuration_invalid");
    expect(mocks.getDatabaseClient).not.toHaveBeenCalled();
    expect(mocks.workerCalls).toEqual([]);
    expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain("private configuration value");
  });

  it("does not start workers when the migration precheck, migrate, or postcheck fails", async () => {
    const { registerNode } = await import("./instrumentation-node");
    mocks.verifyMigrationIntegrity.mockRejectedValueOnce(new mocks.MigrationIntegrityError("private drift"));
    await expect(registerNode()).rejects.toThrow("migration_integrity");
    expect(mocks.workerCalls).toEqual(["configuration", "auth"]);

    mocks.workerCalls.length = 0;
    mocks.verifyMigrationIntegrity.mockResolvedValue(undefined);
    mocks.migrate.mockRejectedValueOnce(new Error("private SQL"));
    await expect(registerNode()).rejects.toThrow("migration_failed");
    expect(mocks.workerCalls).toEqual(["configuration", "auth"]);

    mocks.workerCalls.length = 0;
    mocks.migrate.mockResolvedValue(undefined);
    mocks.verifyMigrationJournalComplete.mockRejectedValueOnce(new Error("private postcheck"));
    await expect(registerNode()).rejects.toThrow("migration_integrity");
    expect(mocks.workerCalls).toEqual(["configuration", "auth"]);
  });

  it("maps a database authentication failure to the bounded migration code", async () => {
    const { registerNode } = await import("./instrumentation-node");
    mocks.verifyMigrationIntegrity.mockRejectedValueOnce(new Error("password authentication failed for user orbit"));

    await expect(registerNode()).rejects.toThrow("migration_integrity");
    expect(mocks.workerCalls).toEqual(["configuration", "auth"]);
    expect(mocks.log.error).toHaveBeenCalledWith({
      event: "startup.migration",
      state: "exhausted",
      reason: "migration_integrity",
      action: "check_migrations",
      impact: "migration_blocked",
    });
    expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain("password authentication");
  });
});

describe("scanner readiness diagnostics", () => {
  let reportAuthConfigurationReadinessNode: () => Promise<void>;
  let reportScannerReadinessNode: () => Promise<void>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.config.scanMode = "required";
    resetAuthObservabilityForTests();
    vi.doUnmock("./instrumentation-node");
    vi.resetModules();

    const nodeModule = await import("./instrumentation-node");
    reportAuthConfigurationReadinessNode = nodeModule.reportAuthConfigurationReadiness;
    reportScannerReadinessNode = nodeModule.reportScannerReadiness;
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAuthObservabilityForTests();
  });

  it("reports ready authentication configuration without delaying startup", async () => {
    mocks.getAuthConfig.mockReturnValue({});

    await expect(reportAuthConfigurationReadinessNode()).resolves.toBeUndefined();

    expect(mocks.log.info).toHaveBeenCalledWith({ event: "auth.configuration", state: "ready" });
    expect(mocks.log.info).toHaveBeenCalledTimes(1);
    expect(mocks.log.error).not.toHaveBeenCalled();
  });

  it("reports invalid authentication configuration without throwing or exposing validation details", async () => {
    const secret = "startup-client-secret-sentinel";
    mocks.getAuthConfig.mockImplementation(() => {
      throw new Error(`OIDC_CLIENT_SECRET ${secret} failed validation`);
    });

    await expect(reportAuthConfigurationReadinessNode()).resolves.toBeUndefined();

    expect(mocks.log.error).toHaveBeenCalledWith({
      event: "auth.configuration",
      state: "invalid",
      reason: "configuration_invalid",
      action: "check_configuration",
      impact: "sign_in_blocked",
    });
    expect(mocks.log.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain(secret);
  });

  it("reports readiness without disclosing scanner connection details", async () => {
    mocks.pingClamAv.mockResolvedValue(true);

    await reportScannerReadinessNode();

    expect(mocks.log.info).toHaveBeenCalledWith({ event: "document.scanner", state: "ready", action: "none" });
    expect(JSON.stringify(mocks.log.info.mock.calls)).not.toContain(mocks.config.clamAv.host);
    expect(JSON.stringify(mocks.log.info.mock.calls)).not.toContain(String(mocks.config.clamAv.port));
  });

  it("reports a failed first ping as starting and temporarily blocks uploads", async () => {
    mocks.pingClamAv.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await reportScannerReadinessNode();

    expect(mocks.log.info).toHaveBeenCalledWith({
      event: "document.scanner",
      state: "starting",
      reason: "dependency_unavailable",
      action: "check_scanner",
      impact: "document_upload_blocked",
    });
    expect(mocks.log.error).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(mocks.pingClamAv).toHaveBeenCalledTimes(2);
    expect(mocks.log.info).toHaveBeenCalledWith({ event: "document.scanner", state: "recovered", action: "none" });
    expect(JSON.stringify(mocks.log.info.mock.calls)).not.toContain(mocks.config.clamAv.host);
    expect(JSON.stringify(mocks.log.info.mock.calls)).not.toContain(String(mocks.config.clamAv.port));
  });

  it("reports unreachable only after the bounded startup window is exhausted", async () => {
    mocks.pingClamAv.mockResolvedValue(false);

    await reportScannerReadinessNode();

    expect(mocks.log.info).toHaveBeenCalledWith({
      event: "document.scanner",
      state: "starting",
      reason: "dependency_unavailable",
      action: "check_scanner",
      impact: "document_upload_blocked",
    });

    await vi.advanceTimersByTimeAsync(180_000);

    expect(mocks.log.error).toHaveBeenCalledWith({
      event: "document.scanner",
      state: "exhausted",
      reason: "scanner_unavailable",
      action: "check_scanner",
      impact: "document_upload_blocked",
    });
    expect(mocks.log.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain(mocks.config.clamAv.host);
    expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain(String(mocks.config.clamAv.port));
  });

  it("treats a thrown ping as a temporary startup failure", async () => {
    mocks.pingClamAv.mockRejectedValueOnce(new Error("private scanner details")).mockResolvedValueOnce(true);

    await reportScannerReadinessNode();

    expect(mocks.log.info).toHaveBeenCalledWith({
      event: "document.scanner",
      state: "starting",
      reason: "dependency_unavailable",
      action: "check_scanner",
      impact: "document_upload_blocked",
    });
    expect(mocks.log.error).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(mocks.log.info).toHaveBeenCalledWith({ event: "document.scanner", state: "recovered", action: "none" });
  });

  it("does not probe a scanner when scanning is disabled", async () => {
    mocks.config.scanMode = "disabled";

    await reportScannerReadinessNode();

    expect(mocks.pingClamAv).not.toHaveBeenCalled();
    expect(mocks.log.info).toHaveBeenCalledWith({
      event: "document.scanner",
      state: "disabled",
      reason: "scan_mode_disabled",
      action: "none",
    });
  });
});
