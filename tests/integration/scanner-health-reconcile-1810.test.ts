/**
 * #1810 A-F1 and A-R1 (one fix): a healthy scanner ping ends an open outage in
 * the database, level-triggered, whatever this process remembers.
 *
 *  - A-F1: after a restart (this file's process has never seen the scanner
 *    down) a reachable ping still ends an outage that is open in the database,
 *    so a later outage is a new one mailed with its own start time.
 *  - A-R1: when the write that ends the outage fails, the next healthy ping
 *    retries it, instead of the fault staying open for good.
 *
 * What an administrator sees is judged: the later outage is mailed again, and
 * the stored fault starts at the later time. The first case must stay first:
 * it relies on this process not having seen an outage.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, users } from "@/db/schema";
import { log } from "@/lib/logger";
import { raiseAdminAlert } from "@/server/admin-alert";
import { SCANNER_UNAVAILABLE_FAULT_KEY, alertScannerUnavailable, runScannerHealthCheck } from "@/server/document-maintenance/scanner-health";
import { accountAddressColumns, cleanupIntegrationEnvironment } from "./support/fixtures";

const mocks = vi.hoisted(() => ({ sendBoundedMail: vi.fn() }));
vi.mock("@/server/invitations/send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/invitations/send")>()),
  sendBoundedMail: mocks.sendBoundedMail,
}));

const namespace = `scanner-reconcile-${randomUUID()}`;
const adminAddress = `${namespace}-admin@harlow.example`;
let adminId = "";

const ping = (answer: boolean) => async () => answer;
const mails = () => (mocks.sendBoundedMail.mock.calls as Array<[string]>).filter(([to]) => to === adminAddress);
const ownRows = async () => (await getDb().select().from(auditLog).where(eq(auditLog.action, "admin_alert_sent")))
  .filter((row) => (row.changes as { userId?: string }).userId === adminId);
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

/** An outage mailed two hours ago, under the scanner's fault key, noticed by "another process". */
async function outageFromBeforeTheRestart() {
  await raiseAdminAlert({
    kind: "scanner_unavailable", faultKey: SCANNER_UNAVAILABLE_FAULT_KEY, occurredAt: hoursAgo(2),
  });
  for (const row of await ownRows()) {
    await getDb().update(auditLog).set({ createdAt: hoursAgo(2) }).where(eq(auditLog.id, row.id));
  }
  expect(mails()).toHaveLength(1);
}

/** The newest stored scanner alert's fault start. */
const newestSince = async () => {
  const rows = (await ownRows()).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return (rows[0]!.changes as { since?: string }).since;
};

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
    displayName: "Harlow reconcile admin",
    isInstanceAdmin: true,
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await getDb().delete(auditLog).where(eq(auditLog.action, "admin_alert_sent"));
  await getDb().delete(users).where(eq(users.id, adminId));
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

describe("A-F1: a restart does not forget an open outage", () => {
  it("a healthy ping in a fresh process ends the open outage, so a later outage is mailed as a new one", async () => {
    await outageFromBeforeTheRestart();

    expect(await runScannerHealthCheck({ ping: ping(true) }, { now: new Date() })).toBe(true);
    const later = new Date();
    await runScannerHealthCheck({ ping: ping(false) }, { now: later });

    expect(mails(), "the later outage is mailed").toHaveLength(2);
    expect(await newestSince()).toBe(later.toISOString());
  });
});

describe("A-R1: a failed end-of-outage write is retried by the next healthy ping", () => {
  it("the fault is ended once a later healthy ping can write, so the next outage is new", async () => {
    await runScannerHealthCheck({ ping: ping(false) }, { now: hoursAgo(2) });
    for (const row of await ownRows()) {
      await getDb().update(auditLog).set({ createdAt: hoursAgo(2) }).where(eq(auditLog.id, row.id));
    }
    expect(mails()).toHaveLength(1);

    const db = getDb();
    const failing = vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("database unavailable"));
    await runScannerHealthCheck({ ping: ping(true) }, { now: new Date() });
    expect(failing).toHaveBeenCalled();
    failing.mockRestore();

    await runScannerHealthCheck({ ping: ping(true) }, { now: new Date() });
    const later = new Date();
    await runScannerHealthCheck({ ping: ping(false) }, { now: later });

    expect(mails(), "the later outage is mailed").toHaveLength(2);
    expect(await newestSince()).toBe(later.toISOString());
  });
});

describe("A-F1 review: an upload's alert landing while a healthy ping ends the outage", () => {
  it("the new outage is not forgotten: the next healthy ping ends it", async () => {
    await runScannerHealthCheck({ ping: ping(false) }, { now: hoursAgo(2) });
    for (const row of await ownRows()) {
      await getDb().update(auditLog).set({ createdAt: hoursAgo(2) }).where(eq(auditLog.id, row.id));
    }

    /* The ping's end write commits, then an upload raises a new outage before
       the ping's own code resumes. */
    const db = getDb();
    const original = db.transaction.bind(db);
    const interleaved = vi.spyOn(db, "transaction").mockImplementationOnce((async (...args: Parameters<typeof db.transaction>) => {
      const ended = await original(...args);
      await alertScannerUnavailable(new Date());
      return ended;
    }) as typeof db.transaction);
    await runScannerHealthCheck({ ping: ping(true) }, { now: new Date() });
    interleaved.mockRestore();

    const open = async () => (await ownRows()).filter((row) => !(row.changes as { endedAt?: string }).endedAt);
    expect(await open(), "the upload's outage was recorded after the end write").toHaveLength(1);

    await runScannerHealthCheck({ ping: ping(true) }, { now: new Date() });
    expect(await open(), "the next healthy ping ends it").toHaveLength(0);
  });
});
