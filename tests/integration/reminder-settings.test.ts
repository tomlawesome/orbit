import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { dueEvents, notificationDeliveries, userPreferences } from "@/db/schema";
import { getAuthConfig } from "@/lib/env";
import {
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
  type IntegrationSession,
} from "./support/fixtures";
import { callRoute, callRouteForSession, loadRoute } from "./support/request-event";

const { GET: readReminders, PUT: writeReminders } = await loadRoute("settings/reminders");

/**
 * Reminder timing against PostgreSQL (#468). The unit tests pin the route's
 * words; this pins what only a real database can show — that one reader's
 * timing is their own, that the crossed pair the route refuses is refused by
 * the schema too, and that switching email reminders off drains this
 * reader's queue and nobody else's.
 */
const REMINDERS_URL = "http://127.0.0.1:3000/api/settings/reminders";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

type Reminders = {
  emailEnabled: boolean;
  firstWarningDays: number;
  finalWarningDays: number;
  firstWarning: string;
  finalWarning: string;
  outboundMail: string;
};

async function read(session: IntegrationSession): Promise<{ status: number; reminders: Reminders }> {
  const response = await callRouteForSession(readReminders, session, { url: REMINDERS_URL });
  const body = await response.json() as { reminders: Reminders };
  return { status: response.status, reminders: body.reminders };
}

async function write(session: IntegrationSession, body: unknown, headers: Record<string, string> = {}) {
  const response = await callRouteForSession(writeReminders, session, {
    url: REMINDERS_URL,
    method: "PUT",
    body: JSON.stringify(body),
    headers,
  });
  return { status: response.status, body: await response.json() as { reminders?: Reminders; error?: { code: string } } };
}

async function storedRow(userId: string) {
  const [row] = await getDb().select({
    emailNotifications: userPreferences.emailNotifications,
    firstWarningDays: userPreferences.firstWarningDays,
    finalWarningDays: userPreferences.finalWarningDays,
  }).from(userPreferences).where(eq(userPreferences.userId, userId));
  return row;
}

describe("PostgreSQL reminder-timing contracts", () => {
  it("stores one reader's timing without touching another's", async () => {
    const fixture = await createIntegrationFixture("reminders-per-user");
    const member = await fixture.session("member");
    const owner = await fixture.session("owner");

    const saved = await write(member, { emailEnabled: true, firstWarningDays: 30, finalWarningDays: 7 });
    expect(saved.status).toBe(200);
    expect(saved.body.reminders).toMatchObject({
      emailEnabled: true,
      firstWarningDays: 30,
      finalWarningDays: 7,
      firstWarning: "30 days before closest approach",
      finalWarning: "7 days before",
    });
    // The instance's outbound state is reported in bounded words only.
    expect(["configured", "not configured"]).toContain(saved.body.reminders?.outboundMail);

    const mine = await read(member);
    expect(mine.reminders).toMatchObject({ firstWarningDays: 30, finalWarningDays: 7 });

    const theirs = await read(owner);
    expect(theirs.reminders).toMatchObject({ emailEnabled: true, firstWarningDays: 14, finalWarningDays: 3 });
    expect(await storedRow(owner.userId)).toMatchObject({ firstWarningDays: 14, finalWarningDays: 3 });
  });

  it("refuses a crossed pair at the route and again at the schema", async () => {
    const fixture = await createIntegrationFixture("reminders-crossed-pair");
    const member = await fixture.session("member");

    const refused = await write(member, { emailEnabled: true, firstWarningDays: 3, finalWarningDays: 14 });
    expect(refused.status).toBe(422);
    expect(refused.body.error?.code).toBe("validation_failed");
    expect(await storedRow(member.userId)).toMatchObject({ firstWarningDays: 14, finalWarningDays: 3 });

    // The same pair written behind the route's back is refused by the
    // database, so the rule does not depend on the route being the only door.
    await expect(getDb().update(userPreferences)
      .set({ finalWarningDays: 30 })
      .where(eq(userPreferences.userId, member.userId))).rejects.toThrow();
    await expect(getDb().update(userPreferences)
      .set({ firstWarningDays: 400 })
      .where(eq(userPreferences.userId, member.userId))).rejects.toThrow();
    expect(await storedRow(member.userId)).toMatchObject({ firstWarningDays: 14, finalWarningDays: 3 });
  });

  it("drains only the caller's queued email when reminders are switched off", async () => {
    const fixture = await createIntegrationFixture("reminders-queue-drain");
    const member = await fixture.session("member");
    const owner = await fixture.session("owner");
    const db = getDb();

    const [event] = await db.insert(dueEvents).values({
      householdId: fixture.household.id,
      itemId: fixture.item.id,
      kind: "renewal",
      dueDate: "2026-09-01",
    }).returning({ id: dueEvents.id });

    async function queue(userId: string, channel: "email" | "web_push", status: "pending" | "sent") {
      const [row] = await db.insert(notificationDeliveries).values({
        householdId: fixture.household.id,
        eventId: event.id,
        userId,
        channel,
        scheduledFor: new Date(),
        status,
      }).returning({ id: notificationDeliveries.id });
      return row.id;
    }

    const mineQueued = await queue(member.userId, "email", "pending");
    const minePush = await queue(member.userId, "web_push", "pending");
    const mineSent = await queue(member.userId, "email", "sent");
    const theirsQueued = await queue(owner.userId, "email", "pending");

    const off = await write(member, { emailEnabled: false, firstWarningDays: 14, finalWarningDays: 3 });
    expect(off.status).toBe(200);
    expect(off.body.reminders?.emailEnabled).toBe(false);

    async function statusOf(id: string) {
      const [row] = await db.select({ status: notificationDeliveries.status })
        .from(notificationDeliveries).where(eq(notificationDeliveries.id, id));
      return row.status;
    }

    expect(await statusOf(mineQueued)).toBe("cancelled");
    // A different channel, an already-sent message, and another reader's
    // queue are all none of this preference's business.
    expect(await statusOf(minePush)).toBe("pending");
    expect(await statusOf(mineSent)).toBe("sent");
    expect(await statusOf(theirsQueued)).toBe("pending");
    expect(await db.select({ id: notificationDeliveries.id }).from(notificationDeliveries)
      .where(and(
        eq(notificationDeliveries.userId, owner.userId),
        eq(notificationDeliveries.status, "cancelled"),
      ))).toEqual([]);
  });

  it("answers nothing and writes nothing without a session or a CSRF token", async () => {
    const fixture = await createIntegrationFixture("reminders-refused");
    const member = await fixture.session("member");
    const config = getAuthConfig();

    const anonymousRead = await callRoute(readReminders, { url: REMINDERS_URL });
    expect(anonymousRead.status).toBe(401);
    expect(anonymousRead.headers.get("cache-control")).toBe("no-store");

    const anonymousWrite = await callRoute(writeReminders, {
      url: REMINDERS_URL,
      method: "PUT",
      body: JSON.stringify({ emailEnabled: false, firstWarningDays: 30, finalWarningDays: 7 }),
      headers: { origin: config.appUrl.origin, "sec-fetch-site": "same-origin" },
    });
    expect(anonymousWrite.status).toBe(401);

    const noCsrf = await write(member, { emailEnabled: false, firstWarningDays: 30, finalWarningDays: 7 }, {
      "x-csrf-token": "invalid-csrf",
    });
    expect(noCsrf.status).toBe(403);

    const crossSite = await write(member, { emailEnabled: false, firstWarningDays: 30, finalWarningDays: 7 }, {
      origin: "https://attacker.invalid",
    });
    expect(crossSite.status).toBe(403);

    expect(await storedRow(member.userId)).toMatchObject({
      emailNotifications: true,
      firstWarningDays: 14,
      finalWarningDays: 3,
    });
  });
});
