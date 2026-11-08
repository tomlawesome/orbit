/**
 * Reminder and expiry-reminder mail wear the ratified card (#1648 mails 4, 5).
 *
 * Driven through `runNotificationCycle` with a capturing email provider, as
 * `notification-worker.test.ts` does. The headline is the subject (the
 * ratified mock-ups use one line for both). The text part is pinned from
 * today's output. The button is "open Orbit" and goes to the instance (APP_URL).
 */
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { dueEvents, memberships, reminderRules } from "@/db/schema";
import { getNotificationWorkerConfig, runNotificationCycle, type SmtpNotification } from "@/server/notification-worker";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";

const cycleTime = new Date("2026-03-29T08:00:00.000Z");
const APP = "https://orbit.harlow.example";

function visibleText(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/giu, " ").replace(/<[^>]*>/gu, " ")
    .replace(/&amp;/gu, "&").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, '"').replace(/&#39;/gu, "'");
}

beforeEach(() => { vi.stubEnv("APP_URL", APP); });
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => { await cleanupIntegrationEnvironment(); });

/** One email reminder for a one-person household, captured at the provider. */
async function remind(kind: "renewal" | "expiry", dueDate: string): Promise<SmtpNotification> {
  const fixture: IntegrationFixture = await createIntegrationFixture(`mail-card-reminder-${kind}`);
  const db = getDb();
  await db.delete(memberships).where(and(
    eq(memberships.householdId, fixture.household.id),
    eq(memberships.userId, fixture.users.member.id),
  ));
  await db.insert(dueEvents).values({ householdId: fixture.household.id, itemId: fixture.item.id, kind, dueDate });
  await db.insert(reminderRules).values({ itemId: fixture.item.id, daysBefore: 0, emailEnabled: true, pushEnabled: false });
  const sent: SmtpNotification[] = [];
  await runNotificationCycle({
    ...getNotificationWorkerConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv),
    smtpUrl: "smtp://smtp.invalid.example:587",
    smtpSecurity: "starttls",
    smtpFrom: "Orbit <orbit@example.invalid>",
    vapidSubject: "mailto:orbit@example.invalid",
    vapidPublicKey: "test-vapid-public-key",
    vapidPrivateKey: "fake-vapid-key",
    pollMilliseconds: 60_000,
    maxAttempts: 3,
  }, {
    now: () => cycleTime,
    providers: { async sendEmail(notification) { sent.push(notification); }, async sendPush() {} },
    nextLeaseToken: () => "00000000-0000-4000-8000-000000001648",
  });
  await fixture.cleanup();
  expect(sent.filter((mail) => mail.to === sent[0]?.to)).toHaveLength(1);
  return sent[0];
}

describe.each([
  { kind: "renewal" as const, ending: "is coming up", verb: "is due on" },
  { kind: "expiry" as const, ending: "is running out", verb: "ends on" },
])("$kind reminder (#1648)", ({ kind, ending, verb }) => {
  it("carries the ratified card: headline, open-Orbit button to the instance, due and kind facts", async () => {
    const mail = await remind(kind, "2026-03-29");
    expect(mail.subject.endsWith(` ${ending}`)).toBe(true);
    const html = mail.html ?? "";
    expect(html).toContain("1px solid #4f4118");
    expect(html).not.toMatch(/<img|<svg|<link/iu);
    const seen = visibleText(html);
    expect(seen).toContain(mail.subject); // the headline is the subject
    expect(seen).toContain("open Orbit");
    expect(html).toMatch(new RegExp(`<a [^>]*href="${APP}/?"`, "u"));
    expect(html.match(/<a\s/giu)).toHaveLength(1);
    expect(seen).toContain("due");
    expect(seen).toContain("kind");
    expect(seen).toContain(kind);
    expect(seen).toContain("You set this reminder in Orbit; change it there.");
  });

  it("keeps the text part as it is today, byte for byte", async () => {
    const mail = await remind(kind, "2026-03-29");
    const title = mail.subject.slice(0, -` ${ending}`.length);
    expect(mail.text).toBe(`Reminder: ${title} ${verb} 2026-03-29.\nOpen Orbit to review it.`);
  });
});
