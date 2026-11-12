/**
 * The administrator alert (#1421), against a real PostgreSQL for the two things
 * it keeps there: who the administrators are (with addresses encrypted under
 * the instance key) and the `audit_log` row that says "already sent". Only the
 * mail wire is stood in for (`sendBoundedMail`), so what is asserted is who is
 * written to, what is said, what is recorded and when it is tried again.
 *
 * The names are the build spec's (`raiseAdminAlert` in `@/server/admin-alert`,
 * kind `import_undo_failed`, fault key) plus three choices of the tests: the
 * alert's context fields are `householdName` and `occurredAt`, the audit action
 * is `admin_alert_sent`, and its `changes` are `{ kind, faultHash, userId }`.
 *
 * Same dedup shape as the key alert (tests/integration/key-alert.test.ts).
 */
import { createHash, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, users } from "@/db/schema";
import { log } from "@/lib/logger";
import { accountAddressColumns, cleanupIntegrationEnvironment, damageEnvelope } from "./support/fixtures";

const mocks = vi.hoisted(() => ({ sendBoundedMail: vi.fn() }));

vi.mock("@/server/invitations/send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/invitations/send")>()),
  sendBoundedMail: mocks.sendBoundedMail,
}));

/* Loaded when a case runs, so a missing module fails that case with that
   reason instead of keeping the whole file from loading. */
type AdminAlertModule = typeof import("@/server/admin-alert");
const raiseAdminAlert = async (...args: Parameters<AdminAlertModule["raiseAdminAlert"]>) =>
  (await import("@/server/admin-alert")).raiseAdminAlert(...args);

const ACTION = "admin_alert_sent";
const APP = "https://orbit.harlow.example";
const IMPORT_ID = "6f1c0c3e-2b7a-4d52-9a5e-0d3b8f1a7c11";
const OTHER_IMPORT_ID = "b2e8f4a0-91d3-4c6b-8e07-5a1c9d2f3e44";
const WHEN = new Date("2026-11-07T14:05:00Z");
const KEK = "ab".repeat(32);
const SMTP_HOST = "smtp.harlow.example";
const SMTP_URL = `smtp://${SMTP_HOST}:587`;

const alert = (overrides: Partial<{ faultKey: string }> = {}) => ({
  kind: "import_undo_failed" as const,
  faultKey: IMPORT_ID,
  householdName: "Harlow",
  occurredAt: WHEN,
  ...overrides,
});

const sentOk = { sentAt: new Date(), sendError: null };
const namespace = `admin-alert-${randomUUID()}`;
const addressOf = (role: string) => `${namespace}-${role}@harlow.example`;
const ids: Record<string, string> = {};

async function makeUser(role: string, isInstanceAdmin: boolean, damaged = false, disabled = false): Promise<void> {
  const id = randomUUID();
  const columns = await accountAddressColumns(id, addressOf(role));
  await getDb().insert(users).values({
    id,
    emailEnc: damaged && columns.emailEnc ? damageEnvelope(columns.emailEnc) : columns.emailEnc,
    emailIndex: columns.emailIndex,
    emailVerified: true,
    displayName: `Harlow ${role}`,
    isInstanceAdmin,
    ...(disabled ? { disabledAt: new Date() } : {}),
  });
  ids[role] = id;
}

type SentMail = { to: string; subject: string; text: string; html: string };
const mine = () => (mocks.sendBoundedMail.mock.calls as Array<[string, { subject: string; text: string; html: string }]>)
  .filter(([to]) => to.startsWith(namespace))
  .map(([to, mail]): SentMail => ({ to, ...mail }));
const recipients = () => mine().map((mail) => mail.to).sort();
const bothAdmins = [addressOf("admin-a"), addressOf("admin-b")].sort();

async function recorded() {
  const all = await getDb().select().from(auditLog).where(eq(auditLog.action, ACTION));
  const mineIds = new Set(Object.values(ids));
  return all.filter((row) => mineIds.has((row.changes as { userId?: string } | null)?.userId ?? ""));
}

/* Moves every record of this test back in time, so "after 24 hours" needs no
   waiting and no knowledge of how the record is laid out. */
async function ageRecords(hours: number): Promise<void> {
  const rows = await recorded();
  for (const row of rows) {
    await getDb().update(auditLog).set({ createdAt: new Date(row.createdAt.getTime() - hours * 3_600_000) }).where(eq(auditLog.id, row.id));
  }
}

const logged = () => JSON.stringify([
  ...vi.mocked(log.info).mock.calls,
  ...vi.mocked(log.warn).mock.calls,
  ...vi.mocked(log.error).mock.calls,
]);

beforeEach(async () => {
  mocks.sendBoundedMail.mockReset();
  mocks.sendBoundedMail.mockResolvedValue(sentOk);
  vi.stubEnv("APP_URL", APP);
  vi.stubEnv("DOCUMENT_KEK", KEK);
  vi.stubEnv("SMTP_URL", SMTP_URL);
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  vi.spyOn(log, "error").mockImplementation(() => undefined);
  await makeUser("admin-a", true);
  await makeUser("admin-b", true);
  await makeUser("member", false);
  await makeUser("admin-unreadable", true, true);
  await makeUser("admin-disabled", true, false, true);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await getDb().delete(auditLog).where(eq(auditLog.action, ACTION));
  await getDb().delete(users).where(inArray(users.id, Object.values(ids)));
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

describe("who is written to", () => {
  it("sends one mail to each administrator with a readable address, and none to anyone else", async () => {
    await raiseAdminAlert(alert());

    expect(recipients()).toEqual(bothAdmins);
    expect(mine().map((mail) => mail.to)).not.toContain(addressOf("member"));
    expect(mine().map((mail) => mail.to)).not.toContain(addressOf("admin-unreadable"));
  });

  it("sends nothing and records nothing for a disabled administrator; the enabled ones still get it", async () => {
    await raiseAdminAlert(alert());

    expect(recipients()).toEqual(bothAdmins);
    expect(mine().map((mail) => mail.to)).not.toContain(addressOf("admin-disabled"));
    const recordedFor = (await recorded()).map((row) => (row.changes as { userId: string }).userId);
    expect(recordedFor).not.toContain(ids["admin-disabled"]);
    expect(recordedFor.sort()).toEqual([ids["admin-a"], ids["admin-b"]].sort());
  });
});

describe("what the mail says (mail 12, round 4)", () => {
  it("carries the ratified card in the html", async () => {
    await raiseAdminAlert(alert());

    const { subject, html } = mine()[0];
    expect(subject).toBe("Orbit needs you: an import could not be undone");
    expect(html).toContain("Orbit needs an administrator");
    expect(html).toContain("Importing an archive into the Harlow household failed at 7 Nov 2026 at 14:05 UTC, and undoing it failed too.");
    expect(html).toContain("Importing an archive into the Harlow household failed at 7 Nov 2026 at 14:05 UTC, and undoing it failed too. Orbit tries the undo again every fifteen minutes; until it succeeds, meanwhile the household is still closed to other members.");
    expect(html).not.toContain("The household’s owner has been told an administrator has been notified.");
    expect(html).not.toMatch(/restart/iu);
    expect(html).not.toContain("has been told an administrator");
    expect(html).toContain(`href="${APP}/admin"`);
    expect(html).toContain("open Administration");
    expect(html).toContain("what · ");
    expect(html).toContain("import undo failed");
    expect(html).toContain("household · ");
    expect(html).toContain("Harlow");
    expect(html).toContain("when · ");
    expect(html).toContain("7 Nov 2026 at 14:05 UTC");
    expect(html).toContain("Orbit did · ");
    expect(html).toContain("kept the household closed to other members until the undo finishes");
    expect(html).toContain("Sent to every administrator. Orbit won’t repeat this for the same fault within 24 hours.");
    expect(html).toContain("run by a household, not a company.");
    expect(html).toContain("orbit.harlow.example");
  });

  it("carries the same facts and the link in a plain text part", async () => {
    await raiseAdminAlert(alert());

    const { text } = mine()[0];
    expect(text).toContain("Harlow");
    expect(text).toContain("import undo failed");
    expect(text).toContain("7 Nov 2026 at 14:05 UTC");
    expect(text).toContain("Orbit did: kept the household closed to other members until the undo finishes");
    expect(text).toContain("Importing an archive into the Harlow household failed at 7 Nov 2026 at 14:05 UTC, and undoing it failed too. Orbit tries the undo again every fifteen minutes; until it succeeds, meanwhile the household is still closed to other members.");
    expect(text).not.toContain("The household’s owner has been told an administrator has been notified.");
    expect(text).not.toMatch(/restart/iu);
    expect(text).not.toContain("has been told an administrator");
    expect(text).toContain(`${APP}/admin`);
    expect(text).toContain("24 hours");
    expect(text).not.toContain("<");
  });

  it("never carries a secret, the key, or the sending account", async () => {
    await raiseAdminAlert(alert());

    for (const mail of mine()) {
      for (const part of [mail.subject, mail.text, mail.html]) {
        expect(part).not.toContain(KEK);
        expect(part).not.toContain("sending-account-marker");
        expect(part).not.toContain(SMTP_HOST);
        expect(part).not.toContain(IMPORT_ID);
        expect(part).not.toMatch(/\b(?:10|192\.168)\.\d+\.\d+(?:\.\d+)?\b/u);
      }
    }
  });
});

describe("the repeat limit", () => {
  it("does not mail the same fault again to the same administrator inside 24 hours", async () => {
    await raiseAdminAlert(alert());
    await ageRecords(23);
    mocks.sendBoundedMail.mockClear();

    await raiseAdminAlert(alert());

    expect(mine()).toHaveLength(0);
    expect(await recorded()).toHaveLength(2);
  });

  it("mails again once 24 hours have passed", async () => {
    await raiseAdminAlert(alert());
    await ageRecords(25);
    mocks.sendBoundedMail.mockClear();

    await raiseAdminAlert(alert());

    expect(recipients()).toEqual(bothAdmins);
    expect(await recorded()).toHaveLength(4);
  });

  it("mails at once for a different fault key: another import", async () => {
    await raiseAdminAlert(alert());
    mocks.sendBoundedMail.mockClear();

    await raiseAdminAlert(alert({ faultKey: OTHER_IMPORT_ID }));

    expect(recipients()).toEqual(bothAdmins);
  });

  it("records nothing for an administrator whose send failed, so the next occurrence mails them; the others stay recorded", async () => {
    mocks.sendBoundedMail.mockImplementation(async (to: string) =>
      to === addressOf("admin-b") ? { sentAt: null, sendError: "smtp_unavailable" } : sentOk);

    await raiseAdminAlert(alert());

    const first = await recorded();
    expect(first.map((row) => (row.changes as { userId: string }).userId)).toEqual([ids["admin-a"]]);

    mocks.sendBoundedMail.mockReset();
    mocks.sendBoundedMail.mockResolvedValue(sentOk);

    await raiseAdminAlert(alert());

    expect(recipients()).toEqual([addressOf("admin-b")]);
    expect(await recorded()).toHaveLength(2);
  });
});

describe("what is recorded", () => {
  it("holds the kind, a hash of the fault key and the user id, and no address, household name or import id in clear", async () => {
    await raiseAdminAlert(alert());

    const rows = await recorded();
    expect(rows).toHaveLength(2);
    const faultHash = createHash("sha256").update(IMPORT_ID).digest("hex");
    for (const row of rows) {
      const changes = row.changes as { kind: string; faultHash: string; userId: string };
      expect(changes.kind).toBe("import_undo_failed");
      expect(changes.userId).toBeTruthy();
      expect(changes.faultHash).toMatch(/^[0-9a-f]{8,64}$/u);
      expect(changes.faultHash).not.toBe(IMPORT_ID);
      expect(faultHash.startsWith(changes.faultHash)).toBe(true);
      const everything = JSON.stringify(row);
      expect(everything).not.toContain("harlow.example");
      expect(everything).not.toContain("Harlow");
      expect(everything).not.toContain(IMPORT_ID);
      expect(everything).not.toContain(KEK);
    }
    expect(rows.map((row) => (row.changes as { userId: string }).userId).sort()).toEqual([ids["admin-a"], ids["admin-b"]].sort());
  });
});

describe("it never throws into its caller", () => {
  it("resolves, logs, and records nothing when the mail transport throws", async () => {
    mocks.sendBoundedMail.mockRejectedValue(new Error(`connect ECONNREFUSED ${SMTP_URL} marker=sending-account-marker`));

    await expect(raiseAdminAlert(alert())).resolves.toBeUndefined();

    expect(await recorded()).toHaveLength(0);
    expect(vi.mocked(log.warn).mock.calls.length + vi.mocked(log.error).mock.calls.length).toBeGreaterThan(0);
    expect(logged()).not.toContain("sending-account-marker");
  });

  it("resolves, records nothing and leaves the fault in the log when outbound mail is not set up", async () => {
    mocks.sendBoundedMail.mockResolvedValue({ sentAt: null, sendError: "smtp_unconfigured" });

    await expect(raiseAdminAlert(alert())).resolves.toBeUndefined();

    expect(await recorded()).toHaveLength(0);
    expect(vi.mocked(log.info).mock.calls.length + vi.mocked(log.warn).mock.calls.length + vi.mocked(log.error).mock.calls.length).toBeGreaterThan(0);
  });
});
