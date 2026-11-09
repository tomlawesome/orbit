/**
 * #1419: when the virus scanner is down, hold new documents and email the
 * administrators. Real PostgreSQL; the scanner (`scanFileWithClamAv` and
 * `pingClamAv`) and the mail wire (`sendBoundedMail`) are stubbed.
 *
 * Names the build must provide (chosen by these tests from the spec):
 *   - `AdminAlertKind` gains "scanner_unavailable" (src/server/admin-alert.ts).
 *   - `runScannerHealthCheck(deps, { now })` exported from
 *     src/server/document-maintenance/scanner-health.ts, where
 *     `deps = { ping: () => Promise<boolean> }`. It calls `raiseAdminAlert`
 *     with kind "scanner_unavailable" when `ping` answers false or throws, and
 *     does nothing when it answers true.
 *   - One fault key for the scanner, shared by the health check and the upload
 *     path, so the 24 h dedupe covers both.
 *   - The alert needs no household: callers here pass none.
 *   - `runDocumentMaintenanceCycle` and the retry worker treat the scanner as
 *     down when `pingClamAv` answers false / `scanFileWithClamAv` reports
 *     "unavailable", and must not reject a held stage for age while it is down.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, documentJobs, documentStagingObjects, documents, users } from "@/db/schema";
import { log } from "@/lib/logger";
import { runDocumentMaintenanceCycle } from "@/server/document-worker";
import { pingClamAv, scanFileWithClamAv } from "@/server/documents/scanner";
import { accountAddressColumns, cleanupIntegrationEnvironment, createIntegrationFixture, withRequiredScanMode as withRequiredScanModeKeepingConfig } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";
import { syntheticPdf as createSyntheticPdf } from "../support/synthetic-documents";

const mocks = vi.hoisted(() => ({ sendBoundedMail: vi.fn() }));

vi.mock("@/server/invitations/send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/invitations/send")>()),
  sendBoundedMail: mocks.sendBoundedMail,
}));

vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(),
  pingClamAv: vi.fn(),
}));

const { POST: uploadDocument } = await loadRoute("households/[householdId]/items/[itemId]/documents");

/* Loaded when a case runs, so a missing module fails that case with that reason. */
const healthCheck = async (ping: () => Promise<boolean>, now: Date) =>
  (await import("@/server/document-maintenance/scanner-health")).runScannerHealthCheck({ ping }, { now });

const syntheticPdf = createSyntheticPdf("synthetic held document");
const namespace = `scanner-hold-${randomUUID()}`;
const adminAddress = `${namespace}-admin@harlow.example`;
let adminId = "";

function scannerDown(): void {
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "error", reason: "unavailable" });
  vi.mocked(pingClamAv).mockResolvedValue(false);
}
function scannerUp(verdict: { status: "clean" } | { status: "infected"; signature: string } = { status: "clean" }): void {
  vi.mocked(scanFileWithClamAv).mockResolvedValue(verdict);
  vi.mocked(pingClamAv).mockResolvedValue(true);
}

const withRequiredScanMode = <T>(work: () => Promise<T>) => withRequiredScanModeKeepingConfig(work, () => {
  vi.mocked(scanFileWithClamAv).mockReset();
  vi.mocked(pingClamAv).mockReset();
});

/** Mails to this test's administrator that are about the scanner. */
const scannerMails = () => (mocks.sendBoundedMail.mock.calls as Array<[string, { subject: string; text: string }]>)
  .filter(([to]) => to === adminAddress);

async function upload(fixture: Awaited<ReturnType<typeof createIntegrationFixture>>, documentId: string) {
  const session = await fixture.session("member");
  return callRouteForSession(uploadDocument, session, {
    url: `http://127.0.0.1:3000/api/households/${fixture.household.id}/items/${fixture.item.id}/documents`,
    method: "POST",
    headers: {
      "content-length": String(syntheticPdf.length),
      "content-type": "application/pdf",
      "x-orbit-filename": encodeURIComponent("policy.pdf"),
      "x-orbit-document-id": documentId,
    },
    body: syntheticPdf,
    params: { householdId: fixture.household.id, itemId: fixture.item.id },
  });
}

const stateOf = async (documentId: string) => (await getDb().select({ lifecycle: documents.lifecycle, failureCode: documents.failureCode })
  .from(documents).where(eq(documents.id, documentId)))[0];
const makeJobDue = (documentId: string) => getDb().update(documentJobs).set({ nextAttemptAt: new Date(Date.now() - 1_000) })
  .where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "scan")));
const expireWindow = (documentId: string) => getDb().update(documentStagingObjects).set({ recoveryExpiresAt: new Date(Date.now() - 60 * 60_000) })
  .where(eq(documentStagingObjects.documentId, documentId));
const stagesOf = async (documentId: string) => getDb().select({ status: documentStagingObjects.status })
  .from(documentStagingObjects).where(eq(documentStagingObjects.documentId, documentId));

beforeEach(async () => {
  mocks.sendBoundedMail.mockReset();
  mocks.sendBoundedMail.mockResolvedValue({ sentAt: new Date(), sendError: null });
  vi.stubEnv("APP_URL", "https://orbit.harlow.example");
  vi.stubEnv("SMTP_URL", "smtp://smtp.harlow.example:587");
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  vi.spyOn(log, "error").mockImplementation(() => undefined);
  adminId = randomUUID();
  await getDb().insert(users).values({
    id: adminId,
    ...(await accountAddressColumns(adminId, adminAddress)),
    emailVerified: true,
    displayName: "Harlow scanner admin",
    isInstanceAdmin: true,
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(scanFileWithClamAv).mockReset();
  vi.mocked(pingClamAv).mockReset();
  await getDb().delete(auditLog).where(and(eq(auditLog.action, "admin_alert_sent"), eq(auditLog.entityType, "instance_authority")));
  await getDb().delete(users).where(inArray(users.id, [adminId]));
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

describe("a held document does not expire while the scanner is down", () => {
  it("stays scanning past the recovery window, then is scanned and becomes available when the scanner returns", async () => {
    const fixture = await createIntegrationFixture("scanner-hold-window");
    const documentId = randomUUID();
    scannerDown();
    await withRequiredScanMode(async () => {
      expect((await upload(fixture, documentId)).status).toBe(202);

      await expireWindow(documentId);
      await runDocumentMaintenanceCycle();
      expect(await stateOf(documentId)).toMatchObject({ lifecycle: "scanning" });
      expect(await stagesOf(documentId)).toEqual([{ status: "pending" }]);

      // The retry runs while the scanner is still down: still held, not rejected.
      await makeJobDue(documentId);
      await runDocumentMaintenanceCycle();
      expect(await stateOf(documentId)).toMatchObject({ lifecycle: "scanning" });
      expect(await stagesOf(documentId)).toEqual([{ status: "pending" }]);

      scannerUp();
      await makeJobDue(documentId);
      await runDocumentMaintenanceCycle();
      expect(await stateOf(documentId)).toEqual({ lifecycle: "available", failureCode: null });
      expect(await stagesOf(documentId)).toHaveLength(0);
    });
  });

  it("still rejects on a malware verdict once the scanner is back, even past the window", async () => {
    const fixture = await createIntegrationFixture("scanner-hold-malware");
    const documentId = randomUUID();
    scannerDown();
    await withRequiredScanMode(async () => {
      expect((await upload(fixture, documentId)).status).toBe(202);
      await expireWindow(documentId);
      await runDocumentMaintenanceCycle();
      expect(await stateOf(documentId)).toMatchObject({ lifecycle: "scanning" });

      scannerUp({ status: "infected", signature: "synthetic-signature" });
      await makeJobDue(documentId);
      await runDocumentMaintenanceCycle();
      expect(await stateOf(documentId)).toEqual({ lifecycle: "rejected", failureCode: "malware_detected" });
      expect(await stagesOf(documentId)).toHaveLength(0);
    });
  });
});

describe("a held document is never given up on while the scanner is down", () => {
  it("survives more than five unavailable retries, then is scanned and becomes available with no administrator action", async () => {
    const fixture = await createIntegrationFixture("scanner-hold-many-retries");
    const documentId = randomUUID();
    scannerDown();
    await withRequiredScanMode(async () => {
      expect((await upload(fixture, documentId)).status).toBe(202);
      for (let retry = 0; retry < 7; retry += 1) {
        await makeJobDue(documentId);
        await runDocumentMaintenanceCycle();
        expect(await stateOf(documentId)).toMatchObject({ lifecycle: "scanning" });
        const [job] = await getDb().select({ status: documentJobs.status }).from(documentJobs)
          .where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "scan")));
        expect(job!.status).not.toBe("failed");
      }
      expect(await stagesOf(documentId)).toEqual([{ status: "pending" }]);

      scannerUp();
      await makeJobDue(documentId);
      await runDocumentMaintenanceCycle();
      expect(await stateOf(documentId)).toEqual({ lifecycle: "available", failureCode: null });
      expect(await stagesOf(documentId)).toHaveLength(0);
    });
  });
});

describe("the scanner health check and the administrator alert", () => {
  const NOW = new Date();

  it("raises one scanner_unavailable alert, mailed once to the administrator, when the check fails", async () => {
    await healthCheck(async () => false, NOW);

    const mails = scannerMails();
    expect(mails).toHaveLength(1);
    const rows = await getDb().select().from(auditLog).where(eq(auditLog.action, "admin_alert_sent"));
    expect(rows.filter((row) => (row.changes as { userId?: string }).userId === adminId)
      .map((row) => (row.changes as { kind?: string }).kind)).toEqual(["scanner_unavailable"]);
  });

  it("counts a ping that throws as a failure", async () => {
    await healthCheck(async () => { throw new Error("connect ECONNREFUSED"); }, NOW);
    expect(scannerMails()).toHaveLength(1);
  });

  it("sends nothing when the scanner answers", async () => {
    await healthCheck(async () => true, NOW);
    expect(scannerMails()).toHaveLength(0);
  });

  it("sends nothing for a second failure within 24 hours, and mails again after 24 hours", async () => {
    await healthCheck(async () => false, NOW);
    await healthCheck(async () => false, new Date(NOW.getTime() + 5 * 60_000));
    await healthCheck(async () => false, new Date(NOW.getTime() + 23 * 3_600_000));
    expect(scannerMails()).toHaveLength(1);

    const rows = await getDb().select().from(auditLog).where(eq(auditLog.action, "admin_alert_sent"));
    for (const row of rows.filter((candidate) => (candidate.changes as { userId?: string }).userId === adminId)) {
      await getDb().update(auditLog).set({ createdAt: new Date(row.createdAt.getTime() - 25 * 3_600_000) }).where(eq(auditLog.id, row.id));
    }
    await healthCheck(async () => false, new Date(NOW.getTime() + 25 * 3_600_000));
    expect(scannerMails()).toHaveLength(2);
  });

  it("raises the alert for an upload held because the scanner is down, and the health check then adds no second mail", async () => {
    const fixture = await createIntegrationFixture("scanner-hold-upload-alert");
    scannerDown();
    await withRequiredScanMode(async () => {
      expect((await upload(fixture, randomUUID())).status).toBe(202);
      // The upload never waits on the mail (#1421): poll for it after the answer.
      await vi.waitFor(() => expect(scannerMails()).toHaveLength(1), { timeout: 5_000, interval: 50 });

      await healthCheck(async () => false, new Date());
      expect(scannerMails()).toHaveLength(1);
    });
  });

  it("an upload after a failed health check adds no second mail, and a second held upload adds none either", async () => {
    const fixture = await createIntegrationFixture("scanner-hold-upload-dedupe");
    await healthCheck(async () => false, new Date());
    expect(scannerMails()).toHaveLength(1);
    scannerDown();
    await withRequiredScanMode(async () => {
      expect((await upload(fixture, randomUUID())).status).toBe(202);
      expect((await upload(fixture, randomUUID())).status).toBe(202);
      // Let any (wrongly) late mail land before counting.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(scannerMails()).toHaveLength(1);
    });
  });
});

/* Review fixes (#1419). */
const jobOf = async (documentId: string) => (await getDb().select({ status: documentJobs.status, attempts: documentJobs.attempts, nextAttemptAt: documentJobs.nextAttemptAt })
  .from(documentJobs).where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "scan"))))[0]!;

describe("an unavailable retry keeps its attempt only while the ping also fails", () => {
  it("uses an attempt each time when the ping succeeds, and fails the job after five", async () => {
    const fixture = await createIntegrationFixture("scanner-hold-ping-ok");
    const documentId = randomUUID();
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "error", reason: "unavailable" });
    vi.mocked(pingClamAv).mockResolvedValue(true);
    await withRequiredScanMode(async () => {
      expect((await upload(fixture, documentId)).status).toBe(202);
      for (let retry = 0; retry < 7; retry += 1) {
        await makeJobDue(documentId);
        await runDocumentMaintenanceCycle();
      }
      expect((await jobOf(documentId)).status).toBe("failed");
    });
  });
});

describe("the retry delay grows while the scanner is unreachable", () => {
  it("never shortens, and reaches the 15-minute cap after a long outage", async () => {
    const fixture = await createIntegrationFixture("scanner-hold-delay");
    const documentId = randomUUID();
    scannerDown();
    await withRequiredScanMode(async () => {
      expect((await upload(fixture, documentId)).status).toBe(202);
      let previous = 0;
      let last = 0;
      for (let retry = 0; retry < 8; retry += 1) {
        await makeJobDue(documentId);
        await runDocumentMaintenanceCycle();
        last = (await jobOf(documentId)).nextAttemptAt.getTime() - Date.now();
        expect(last).toBeGreaterThanOrEqual(previous - 5_000);
        previous = last;
      }
      expect(last).toBeGreaterThan(14 * 60_000);
      expect(last).toBeLessThanOrEqual(15 * 60_000);
    });
  });
});

describe("what raises the scanner alert", () => {
  it("does not mail administrators for an upload held on a scanner timeout", async () => {
    const fixture = await createIntegrationFixture("scanner-hold-timeout");
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "error", reason: "timeout" });
    vi.mocked(pingClamAv).mockResolvedValue(true);
    await withRequiredScanMode(async () => {
      await upload(fixture, randomUUID());
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(scannerMails()).toHaveLength(0);
    });
  });

  it("mails each administrator once when five uploads are held at once and a health check runs alongside", async () => {
    const fixture = await createIntegrationFixture("scanner-hold-concurrent");
    scannerDown();
    await withRequiredScanMode(async () => {
      const results = await Promise.all([
        ...Array.from({ length: 5 }, () => upload(fixture, randomUUID())),
        healthCheck(async () => false, new Date()),
      ]);
      expect(results.slice(0, 5).map((response) => (response as Response).status)).toEqual([202, 202, 202, 202, 202]);
      await vi.waitFor(() => expect(scannerMails().length).toBeGreaterThanOrEqual(1), { timeout: 5_000, interval: 50 });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(scannerMails()).toHaveLength(1);
    });
  });
});

describe("the scanner mail wording", () => {
  it("a repeat mail after 25 hours still gives the time the scanner first stopped answering", async () => {
    const first = new Date("2026-11-01T09:40:00Z");
    await healthCheck(async () => false, first);
    for (const row of await getDb().select().from(auditLog).where(eq(auditLog.action, "admin_alert_sent"))) {
      if ((row.changes as { userId?: string }).userId === adminId) await getDb().update(auditLog).set({ createdAt: first }).where(eq(auditLog.id, row.id));
    }
    await healthCheck(async () => false, new Date(first.getTime() + 25 * 3_600_000));

    const mails = scannerMails();
    expect(mails).toHaveLength(2);
    expect(mails[0]![1].text).toContain("1 Nov 2026 at 09:40 UTC");
    expect(mails[1]![1].text).toContain("1 Nov 2026 at 09:40 UTC");
    expect(mails[1]![1].text).not.toContain("2 Nov 2026 at 10:40 UTC");
  });

  it("with no pending stages the mail says exactly the ratified sentence and no variant", async () => {
    await getDb().delete(documentStagingObjects).where(eq(documentStagingObjects.status, "pending"));
    await healthCheck(async () => false, new Date());

    const text = scannerMails()[0]![1].text;
    expect(text).toContain("New documents are being held, not refused, until it is back.");
    expect(text).not.toContain("holds new documents until it is back");
  });

  it("an import-undo mail with no household omits the household line", async () => {
    const { raiseAdminAlert } = await import("@/server/admin-alert");
    await raiseAdminAlert({ kind: "import_undo_failed", faultKey: `import-${randomUUID()}`, occurredAt: new Date("2026-11-07T14:05:00Z") });

    const text = scannerMails()[0]![1].text;
    expect(text).not.toMatch(/^household:/im);
    expect(text).not.toContain("unknown");
  });
});

describe("staging purge while the scanner is down", () => {
  it("still expires an operator-discarded stage on time", async () => {
    const fixture = await createIntegrationFixture("scanner-hold-discard");
    const documentId = randomUUID();
    scannerDown();
    await withRequiredScanMode(async () => {
      expect((await upload(fixture, documentId)).status).toBe(202);
      await getDb().update(documentStagingObjects)
        .set({ purgeFailureCode: "operator_discard_requested", recoveryExpiresAt: new Date(Date.now() - 60 * 60_000) })
        .where(eq(documentStagingObjects.documentId, documentId));
      await runDocumentMaintenanceCycle();
      expect(await stateOf(documentId)).toEqual({ lifecycle: "rejected", failureCode: "scan_recovery_expired" });
    });
  });
});
