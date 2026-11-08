/**
 * The encryption-key alert and the "working again" notice wear the ratified
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

const mocks = vi.hoisted(() => ({ sendBoundedMail: vi.fn() }));

vi.mock("@/server/invitations/send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/invitations/send")>()),
  sendBoundedMail: mocks.sendBoundedMail,
}));

const ALERT = "encryption_key_alert_sent";
const RESTORED = "encryption_key_restored";
const NOW = new Date("2026-11-07T16:20:00.000Z");
type Sent = { subject: string; text: string; html?: string };

function visibleText(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/giu, " ").replace(/<[^>]*>/gu, " ")
    .replace(/&amp;/gu, "&").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, '"').replace(/&#39;/gu, "'");
}

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
  await getDb().delete(auditLog).where(inArray(auditLog.action, [ALERT, RESTORED]));
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

function lastMail(): Sent {
  return (mocks.sendBoundedMail.mock.calls.at(-1) as [string, Sent])[1];
}

describe("key locked (#1648 mail 9)", () => {
  it("sends the ratified card: headline, no button, no link", async () => {
    const { sendKeyAlert } = await import("@/server/key-alert");
    await sendKeyAlert({ verdict: "unusable", reason: "missing" });

    const mail = lastMail();
    expect(mail.subject).toBe("Orbit is locked: its encryption key needs attention");
    const html = mail.html ?? "";
    expect(html).toContain("1px solid #4f4118");
    expect(html).not.toMatch(/<img|<svg|<link/iu);
    const seen = visibleText(html);
    expect(seen).toContain("Orbit is locked");
    expect(seen).toContain("Nothing is lost.");
    expect(seen).toContain("administrator-operations.md");
    expect(html).not.toMatch(/<a\s|href=/iu);
  });

  it("keeps the text part as it is today, byte for byte", async () => {
    const { sendKeyAlert } = await import("@/server/key-alert");
    await sendKeyAlert({ verdict: "unusable", reason: "missing" });

    expect(lastMail().text).toBe([
      "Orbit at https://orbit.harlow.example cannot open anyone's records or sign anyone in, because its encryption key is missing.",
      "",
      "Nothing is lost. Everything stays encrypted and intact; Orbit has closed itself to everyone, administrators included, until the key is fixed on the host and the container restarted.",
      "",
      "What to do: docs/administrator-operations.md, \"Restoring the document key-encryption key\".",
      "",
      "Orbit will send this again in 24 hours if it is still locked, and once when the key is back. Sent 2026-11-07 16:20 UTC.",
      "",
    ].join("\n"));
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
    expect(seen).toContain("Nothing was lost.");
    expect(html).not.toMatch(/<a\s|href=/iu);
  });

  it("keeps the text part as it is today, byte for byte", async () => {
    expect((await restore()).text).toBe([
      "Orbit at https://orbit.harlow.example has started with its encryption key and is open again: records can be read and people can sign in.",
      "",
      "Nothing was lost. This is the one message that follows the earlier alert.",
      "",
      "Sent 2026-11-07 16:20 UTC.",
      "",
    ].join("\n"));
  });
});
