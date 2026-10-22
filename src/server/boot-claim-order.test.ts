import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1450: the claim link is printed after the normal start-up lines, so it is
 * the log's last line on a real install and the operator can find it by
 * reading the logs (owner, answer 11a).
 *
 * The seam is `registerNode()` in ./boot, the whole start-up sequence, driven
 * the way boot.test.ts drives it: the collaborators are stand-ins and every
 * log line, and the claim notice, is appended to one list in the order it was
 * written. No interface is invented: the claim notice is `printClaimNotice`
 * from "@/lib/auth/bootstrap" (replaced here by a recorder), and "the usual
 * start-up lines" are the three reports that run without being awaited today:
 * the scanner readiness line, the document-reading line and the PDF sandbox
 * self-check line. Each stand-in takes a real (short) while, as a scanner
 * ping does, so a start-up that does not wait for them prints the claim first.
 */

const mocks = vi.hoisted(() => ({
  /** Everything an operator would see, in order: each log line as the real logger renders it, the claim notice as "CLAIM". */
  order: [] as string[],
  scanMode: "required" as "required" | "disabled",
  pingDelayMs: 25,
  pingResult: true,
  sandboxDelayMs: 25,
  sandboxProblem: "proc_unreadable" as string | undefined,
  tikaReports: true,
  claimPrints: 0,
}));

const later = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

vi.mock("@/server/documents/config", () => ({
  getDocumentConfig: () => ({
    scanMode: mocks.scanMode,
    clamAv: { host: "scanner.example.invalid", port: 3310, timeoutMs: 30_000 },
    keyId: "key-1",
    nextKeyId: null,
    keyEncryptionKey: Buffer.alloc(32, 0xab),
  }),
  documentKeyProblem: () => null,
  keyEncryptionKeyFor: (config: { keyId: string; keyEncryptionKey: Buffer }, keyId: string) =>
    keyId === config.keyId ? config.keyEncryptionKey : undefined,
}));
vi.mock("@/server/documents/scanner", () => ({
  pingClamAv: async () => later(mocks.pingDelayMs, mocks.pingResult),
}));
vi.mock("@/server/documents/tika", () => ({
  reportDocumentReadingStatus: () => {
    if (mocks.tikaReports) mocks.order.push("document.parse state=disabled (stand-in)");
  },
}));
vi.mock("@/server/documents/pdf-structure-sandbox", () => ({
  pdfSandboxSelfCheck: async () => later(mocks.sandboxDelayMs, mocks.sandboxProblem),
}));
vi.mock("@/server/documents/rewrap-worker", () => ({ recordRotationStarted: vi.fn() }));
vi.mock("@/lib/auth/bootstrap", () => ({
  printClaimNotice: async () => {
    mocks.claimPrints += 1;
    mocks.order.push("CLAIM");
  },
}));
vi.mock("@/server/key-alert", () => ({
  sendKeyAlert: async () => undefined,
  sendKeyRestoredNotice: async () => undefined,
}));
vi.mock("@/server/maintenance-worker", () => ({ startMaintenanceWorker: () => undefined }));
vi.mock("@/server/notification-worker", () => ({ startNotificationWorker: () => undefined }));
vi.mock("@/server/document-worker", () => ({ startDocumentWorker: () => undefined }));
vi.mock("@/server/mail-in/imap-ingestion", () => ({ startImapIngestionWorker: () => undefined }));
vi.mock("@/server/mail-in/imap-receipt-worker", () => ({ startImapReceiptWorker: () => undefined }));
vi.mock("@/server/portable-archive-repository", () => ({ rollBackUnfinishedPortableImports: async () => undefined }));
vi.mock("@/lib/env", () => ({ getAuthConfig: () => ({}) }));
vi.mock("@/lib/configuration-problems", () => ({ getConfigurationProblems: () => [] }));
vi.mock("@/lib/startup-config", () => ({
  validateStartupConfiguration: () => undefined,
  StartupConfigurationError: class StartupConfigurationError extends Error {},
}));
vi.mock("@/db", () => ({
  getDatabaseClient: () => ({ unsafe: vi.fn() }),
  getDb: () => {
    const chain: unknown = new Proxy(function chainable() { /* callable target */ }, {
      get(_target, property) {
        if (property === "then") return (resolve: (value: unknown) => unknown) => Promise.resolve([]).then(resolve);
        return () => chain;
      },
      apply: () => chain,
    });
    return { select: () => chain, execute: () => chain, transaction: (callback: (executor: unknown) => unknown) => callback({ select: () => chain, execute: () => chain }) };
  },
}));
vi.mock("@/db/migration-integrity", () => ({
  verifyMigrationIntegrity: async () => undefined,
  verifyMigrationJournalComplete: async () => undefined,
  readAppliedMigrationHashes: async () => [],
  readExpectedMigrationHashes: async () => [],
  MigrationIntegrityError: class MigrationIntegrityError extends Error {},
}));
vi.mock("drizzle-orm/postgres-js/migrator", () => ({ migrate: async () => undefined }));
vi.mock("@/db/migration-outcome", () => ({
  ensureMigrationRunsTable: async () => undefined,
  recordMigrationOutcome: async () => undefined,
}));
/** The lines the scanner, document-reading and PDF sandbox reports write, as the logger renders them. */
const STARTUP_REPORT_LINES = ["document.scanner state=ready", "document.parse state=disabled", "document.inspection state=degraded"];

/** Where in the written lines the first one containing `fragment` sits; -1 when none does. */
const at = (written: string[], fragment: string) => written.findIndex((entry) => entry.includes(fragment));

describe("the claim link is printed after the normal start-up lines (#1450)", () => {
  beforeAll(async () => {
    await Promise.all([import("./boot"), import("@/lib/logger")]);
  }, 60_000);

  beforeEach(() => {
    vi.resetModules();
    mocks.order.length = 0;
    mocks.claimPrints = 0;
    mocks.scanMode = "required";
    mocks.pingDelayMs = 25;
    mocks.pingResult = true;
    mocks.sandboxDelayMs = 25;
    mocks.sandboxProblem = "proc_unreadable";
    mocks.tikaReports = true;
    /* The real logger runs, so these are the lines as an operator reads them. */
    for (const method of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((entry: unknown) => { mocks.order.push(String(entry)); });
    }
    vi.stubEnv("DOCUMENT_KEK", "ab".repeat(32));
    vi.stubEnv("MIGRATE_ON_START", "true");
    vi.stubEnv("WORKER_ENABLED", "true");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function start(): Promise<string[]> {
    const { registerNode } = await import("./boot");
    await registerNode();
    /* Give any report that start-up did not wait for time to land, so a
       failure shows where the claim notice really sat, not a half-written list. */
    await later(120, undefined);
    return [...mocks.order];
  }

  it("prints it exactly once", async () => {
    const written = await start();
    expect(written.filter((entry) => entry === "CLAIM")).toHaveLength(1);
  });

  it("prints it last, after the scanner, document-reading and PDF sandbox lines, however slowly those answer", async () => {
    const written = await start();
    for (const expected of STARTUP_REPORT_LINES) expect(at(written, expected), `${expected} is written`).toBeGreaterThan(-1);
    expect(written.at(-1)).toBe("CLAIM");
  });

  it("prints it after a scanner that is still starting up has said so", async () => {
    mocks.pingResult = false;
    const written = await start();
    expect(at(written, "document.scanner state=starting")).toBeGreaterThan(-1);
    expect(written.indexOf("CLAIM")).toBeGreaterThan(at(written, "document.scanner state=starting"));
  });

  it("prints it after the lines of a scanner that is switched off", async () => {
    mocks.scanMode = "disabled";
    const written = await start();
    expect(at(written, "document.scanner state=disabled")).toBeGreaterThan(-1);
    expect(written.indexOf("CLAIM")).toBeGreaterThan(at(written, "document.scanner state=disabled"));
  });

  it("prints it last when the PDF sandbox is the slowest report", async () => {
    mocks.sandboxDelayMs = 60;
    const written = await start();
    expect(at(written, "document.inspection state=degraded")).toBeGreaterThan(-1);
    expect(written.at(-1)).toBe("CLAIM");
  });

  it("prints it last when the scanner is the slowest report", async () => {
    mocks.pingDelayMs = 60;
    const written = await start();
    expect(at(written, "document.scanner state=ready")).toBeGreaterThan(-1);
    expect(written.at(-1)).toBe("CLAIM");
  });

  it("still prints it when the reports have nothing to say", async () => {
    mocks.scanMode = "disabled";
    mocks.tikaReports = false;
    mocks.sandboxProblem = undefined;
    const written = await start();
    expect(written.at(-1)).toBe("CLAIM");
    expect(mocks.claimPrints).toBe(1);
  });
});
