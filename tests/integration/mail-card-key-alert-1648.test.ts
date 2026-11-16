/**
 * The "working again" notice wears the ratified
 * card (#1648): an html part with the ratified headline and no button, no link
 * at all. The text part is pinned byte for byte from today's output. Same stand-
 * ins as `key-alert.test.ts`: a real database for the "already sent" record,
 * the mail wire replaced by `sendBoundedMail`.
 */
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog } from "@/db/schema";
import { log } from "@/lib/logger";
import { cleanupIntegrationEnvironment } from "./support/fixtures";
import { visibleText } from "../support/mail-card";

const mocks = vi.hoisted(() => ({ sendBoundedMail: vi.fn() }));

vi.mock("@/server/invitations/send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/invitations/send")>()),
  sendBoundedMail: mocks.sendBoundedMail,
}));

const ALERT = "encryption_key_alert_held";
const RESTORED = "encryption_key_restored";
const NOW = new Date("2026-11-07T16:20:00.000Z");
type Sent = { subject: string; text: string; html?: string };

beforeEach(() => {
  mocks.sendBoundedMail.mockReset();
  mocks.sendBoundedMail.mockResolvedValue({ sentAt: NOW, sendError: null });
  vi.stubEnv("OPERATOR_ALERT_ADDRESS", "operator@example.invalid");
  vi.stubEnv("DOCUMENT_KEK", "ab".repeat(32));
  vi.stubEnv("APP_URL", "https://orbit.harlow.example");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  vi.spyOn(log, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await getDb().delete(auditLog).where(inArray(auditLog.action, [ALERT, RESTORED, "encryption_key_alert_sent"]));
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

function lastMail(): Sent {
  return (mocks.sendBoundedMail.mock.calls.at(-1) as [string, Sent])[1];
}

describe("key locked (#1629)", () => {
  it("sends no mail: the sending password is encrypted under the missing key", async () => {
    const { sendKeyAlert } = await import("@/server/key-alert");
    await sendKeyAlert({ verdict: "unusable", reason: "missing" });
    expect(mocks.sendBoundedMail).not.toHaveBeenCalled();
  });
});

describe("key restored (#1648 mail 10)", () => {
  async function restore(): Promise<Sent> {
    await getDb().insert(auditLog).values({
      householdId: null,
      actorUserId: null,
      entityType: "instance_authority",
      entityId: randomUUID(),
      action: ALERT,
      changes: { reason: "missing", addressHash: "fixture" },
      createdAt: new Date(NOW.getTime() - 3_600_000),
    });
    const { sendKeyRestoredNotice } = await import("@/server/key-alert");
    await sendKeyRestoredNotice();
    expect(mocks.sendBoundedMail).toHaveBeenCalledTimes(1);
    return lastMail();
  }

  it("sends the ratified card: headline, no button, no link", async () => {
    const mail = await restore();
    expect(mail.subject).toBe("Orbit's encryption key is working again");
    const html = mail.html ?? "";
    expect(html).toContain("1px solid #4f4118");
    expect(html).not.toMatch(/<img|<svg|<link/iu);
    const seen = visibleText(html);
    expect(seen).toContain("Orbit is open again");
    expect(seen).toContain("While it was locked its encryption key was missing, and Orbit could not mail you about it");
    expect(seen).toContain("Nothing was lost. Everything stayed encrypted and intact while it was closed.");
    expect(html).not.toMatch(/<a\s|href=/iu);
  });

  it("keeps the text part as it is today, byte for byte", async () => {
    expect((await restore()).text).toBe([
      "Orbit at https://orbit.harlow.example has started with its encryption key and is open again: records can be read and people can sign in.",
      "",
      "While it was locked its encryption key was missing, and Orbit could not mail you about it: the password it sends mail with is encrypted under that same key.",
      "",
      "Nothing was lost. Everything stayed encrypted and intact while it was closed.",
      "",
      "Sent 2026-11-07 16:20 UTC.",
      "",
    ].join("\n"));
  });
});
