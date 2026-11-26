/**
 * #1774, owner answer 102: when an export job finishes as written, Orbit
 * sends ONE email to the member who started it. Written from the
 * specification alone, before it exists: fails today.
 *
 * What is asserted: one message, to the requester's own address, through the
 * existing outbound path (the real `sendBoundedMail` and the real sending
 * row; only nodemailer's `createTransport` is replaced, as in
 * key-alert-sending-1629.test.ts); it says the export is ready and carries
 * the household's archive card link under APP_URL
 * (`<APP_URL>/household/<householdId>`, built with `absoluteAppLink`); it
 * carries no link that downloads without signing in (no `/api/` address, no
 * archive id, no token), not the passphrase, and nothing about the contents
 * (household name, document name). No address on file: no email. A failed
 * send does not fail the job. Not asserted either way: any push
 * notification or "Sent to you lately" entry.
 *
 * Seam (nothing new): the job's completion step, after the completing
 * transaction has committed (so a mail failure can never undo or fail the
 * job), calls `sendBoundedMail(address, { subject, text, html?, what })`
 * from @/server/invitations/send with no mailer argument (the sending row).
 * The email may be sent by `runExportWorkerOnce` before it resolves; the
 * tests read what reached the transport after the pass.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { portableArchives } from "@/db/schema";
import { log } from "@/lib/logger";
import { runExportWorkerOnce } from "@/server/document-maintenance/export-jobs";
import { ORIGIN } from "./support/auth";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";
import { anotherAccount, clearMailState, fakeTransporter, sending } from "./support/mail-sending-1629";
import { proofCookie } from "./support/portable-archive-routes";
import { callRouteForSession, loadRoute } from "./support/request-event";

const mocks = vi.hoisted(() => ({ createTransport: vi.fn() }));
vi.mock("nodemailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nodemailer")>();
  const replaced = { ...actual, createTransport: mocks.createTransport };
  return { ...replaced, default: { ...actual.default, createTransport: mocks.createTransport } };
});

const { POST: startExport } = await loadRoute("households/[householdId]/portable-archives");

const APP = "https://orbit.harlow.example";
const PASSPHRASE = "correct-horse-battery-staple";

let fixture: IntegrationFixture;
let sent: Array<Record<string, unknown>>;
let failSend = false;

beforeEach(async () => {
  fixture = await createIntegrationFixture("export-job-mail");
  sent = [];
  failSend = false;
  mocks.createTransport.mockReset();
  mocks.createTransport.mockImplementation(() => {
    const base = fakeTransporter();
    return {
      ...base,
      sendMail: vi.fn(async (message: Record<string, unknown>) => {
        if (failSend) throw Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" });
        sent.push(message);
        return base.sendMail(message);
      }),
    };
  });
  vi.stubEnv("APP_URL", APP);
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  vi.spyOn(log, "error").mockImplementation(() => undefined);
  const { setSendingSettings } = await sending();
  await setSendingSettings(fixture.users.admin.id, null, anotherAccount);
  sent = [];
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await getDb().execute(sql`delete from portable_archive_exports`);
  await clearMailState();
  await fixture.cleanup();
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

async function startAsOwner(): Promise<string> {
  const owner = await fixture.session("owner");
  const response = await callRouteForSession(startExport, owner, {
    url: `${ORIGIN}/api/households/${fixture.household.id}/portable-archives`,
    method: "POST",
    headers: { "content-type": "application/json", cookie: await proofCookie(owner, "archive_export") },
    body: JSON.stringify({ passphrase: PASSPHRASE, includeDocuments: false }),
    params: { householdId: fixture.household.id },
  });
  expect(response.status).toBe(202);
  return ((await response.json()) as { export: { id: string } }).export.id;
}

const statusOf = async (id: string) =>
  (await getDb().execute(sql`select status, archive_id from portable_archive_exports where id = ${id}`))[0] as { status: string; archive_id: string | null };

describe("the 'your export is ready' email (#1774, owner answer 102)", () => {
  it("sends one email to the member who started it, saying it is ready and pointing at the household's archive card", async () => {
    const id = await startAsOwner();
    expect(sent, "nothing is mailed when the job is merely started").toEqual([]);

    await runExportWorkerOnce();

    expect((await statusOf(id)).status).toBe("completed");
    expect(sent).toHaveLength(1);
    const message = sent[0];
    expect(message.to).toBe(fixture.users.owner.email);
    const body = `${String(message.subject)}\n${String(message.text)}\n${String(message.html ?? "")}`;
    expect(String(message.subject).toLowerCase()).toMatch(/ready/);
    expect(body.toLowerCase()).toMatch(/export|archive/);
    expect(body).toContain(`${APP}/household/${fixture.household.id}`);
  }, 120_000);

  it("holds no link that downloads without signing in, not the passphrase, and nothing about the contents", async () => {
    const id = await startAsOwner();
    await runExportWorkerOnce();
    const archiveId = (await statusOf(id)).archive_id!;
    expect(sent).toHaveLength(1);
    const body = `${String(sent[0].subject)}\n${String(sent[0].text)}\n${String(sent[0].html ?? "")}`;

    expect(body).not.toContain(PASSPHRASE);
    expect(body, "no archive-file address").not.toMatch(/\/api\//);
    expect(body).not.toMatch(/portable-archives?\//);
    expect(body).not.toContain(archiveId);
    expect(body).not.toContain(id);
    const [archive] = await getDb().select({ storageKey: portableArchives.storageKey }).from(portableArchives).where(eq(portableArchives.id, archiveId));
    expect(body).not.toContain(archive.storageKey);
    // Every link in it is the household page and carries no token or query.
    for (const link of body.match(/https?:\/\/[^\s"'<>)]+/g) ?? []) {
      expect(link).toBe(`${APP}/household/${fixture.household.id}`);
    }
    expect(body, "nothing about the contents").not.toContain(fixture.household.name);
    expect(body).not.toContain(fixture.document.displayName);
  }, 120_000);

  it("sends no email when the member has no address on file, and the job still completes", async () => {
    await getDb().execute(sql`update users set email_enc = null, email_index = null where id = ${fixture.users.owner.id}`);
    const id = await startAsOwner();

    await runExportWorkerOnce();

    expect((await statusOf(id)).status).toBe("completed");
    expect(sent).toEqual([]);
  }, 120_000);

  it("does not fail the job when the send fails, and does not retry the job for it", async () => {
    const id = await startAsOwner();
    failSend = true;

    await runExportWorkerOnce();

    const row = await statusOf(id);
    expect(row.status).toBe("completed");
    expect(row.archive_id).not.toBeNull();
    expect(sent).toEqual([]);
    expect(await runExportWorkerOnce(), "nothing is left to run").toBe(0);
  }, 120_000);

  it("sends nothing for a job that failed", async () => {
    await getDb().execute(sql`update items set title_enc = 'not-an-envelope-at-all-not-an-envelope-at-all-xx' where id = ${fixture.item.id}`);
    const id = await startAsOwner();

    await runExportWorkerOnce();

    expect((await statusOf(id)).status).toBe("failed");
    expect(sent).toEqual([]);
  }, 120_000);
});
