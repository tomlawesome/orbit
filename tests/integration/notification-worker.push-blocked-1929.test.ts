import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { getDb } from "@/db";
import { log } from "@/lib/logger";
import {
  BlockedPushEndpointError,
  getNotificationWorkerConfig,
  runNotificationCycle,
  type NotificationProviders,
  type PushNotification,
} from "@/server/notification-worker";
import { dueEvents, memberships, notificationDeliveries, pushSubscriptions, reminderRules } from "@/db/schema";

/**
 * #1929 part 2 (ruling, note 67125) items 6, 7 and 10 for the worker's
 * dispatch loop. This needs the PostgreSQL the other worker contract tests
 * use (the loop has no unit-level database stand-in).
 */

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

const cycleTime = new Date("2026-03-29T08:00:00.000Z");
const BLOCKED_HOST = "blocked-host.push.example.test";
const BLOCKED_ADDRESS = "127.0.0.1";

function workerConfig() {
  return {
    ...getNotificationWorkerConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv),
    smtpUrl: "smtp://smtp.invalid.example:587",
    smtpSecurity: "starttls" as const,
    smtpFrom: "Orbit <orbit@example.invalid>",
    vapidSubject: "mailto:orbit@example.invalid",
    vapidPublicKey: "test-vapid-public-key",
    vapidPrivateKey: "fake-vapid-key",
    pollMilliseconds: 60_000,
    maxAttempts: 3,
  };
}

function providersFor(onPush: (notification: PushNotification) => Promise<void> | void): NotificationProviders {
  return { async sendEmail() {}, async sendPush(notification) { await onPush(notification); } };
}

async function pushFixture(label: string) {
  const fixture = await createIntegrationFixture(label);
  await getDb().delete(memberships).where(and(
    eq(memberships.householdId, fixture.household.id),
    eq(memberships.userId, fixture.users.member.id),
  ));
  const [event] = await getDb().insert(dueEvents).values({
    householdId: fixture.household.id, itemId: fixture.item.id, kind: "renewal", dueDate: "2026-03-29",
  }).returning({ id: dueEvents.id });
  await getDb().insert(reminderRules).values({ itemId: fixture.item.id, daysBefore: 0, emailEnabled: false, pushEnabled: true });
  return { fixture, eventId: event.id };
}

async function subscribe(userId: string, endpoint: string) {
  await getDb().insert(pushSubscriptions).values({ userId, endpoint, p256dh: "p256dh", auth: "auth" });
}

const revokedAt = async (endpoint: string) =>
  (await getDb().select({ revokedAt: pushSubscriptions.revokedAt }).from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, endpoint)))[0]?.revokedAt;

let logged: unknown[][];
beforeEach(() => {
  logged = [];
  for (const level of ["error", "warn", "info", "debug"] as const) {
    vi.spyOn(log, level).mockImplementation(((...args: unknown[]) => { logged.push([level, ...args]); }) as never);
  }
});

/*
 * #1943 A-R4 (ruling note 68569) reverses #1929 part 2 item 6: a blocked
 * resolver answer reflects the network, not the push service (RFC 8030
 * section 7.3), so it is a transient failure under the existing bounded
 * retry, never a revocation. The connection is still never made, and the one
 * warn line stays. Only the push service's 404/410 (or 401/403) revokes.
 */
describe("#1929 part 2: a blocked push address in the worker's dispatch loop", () => {
  it("items 6 and 7 (flipped by #1943 A-R4): keeps the blocked subscription, delivers the next, marks sent, and logs one line without host or address", async () => {
    const { fixture, eventId } = await pushFixture("push-blocked-1929");
    const userId = fixture.users.owner.id;
    const endpointA = `https://${BLOCKED_HOST}/${userId}`;
    const endpointB = `https://push.invalid.example/${userId}`;
    await subscribe(userId, endpointA);
    await subscribe(userId, endpointB);
    const seen: string[] = [];
    await runNotificationCycle(workerConfig(), {
      now: () => cycleTime,
      providers: providersFor((notification) => {
        seen.push(notification.target.endpoint);
        if (notification.target.endpoint === endpointA) throw new BlockedPushEndpointError();
      }),
    });

    expect(seen.sort()).toEqual([endpointA, endpointB].sort());
    expect(await revokedAt(endpointA)).toBeNull();
    expect(await revokedAt(endpointB)).toBeNull();
    const [delivery] = await getDb().select().from(notificationDeliveries).where(eq(notificationDeliveries.eventId, eventId));
    expect(delivery).toMatchObject({ status: "sent" });
    expect(delivery!.lastError).not.toBe("push_unsubscribed");
    expect(delivery!.attempts).toBeLessThanOrEqual(1);

    const warns = (log.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter((call) => JSON.stringify(call).includes("push_endpoint_blocked"));
    expect(warns).toHaveLength(1);
    expect(warns[0]![0]).toMatchObject({ reason: "push_endpoint_blocked" });
    const columns = JSON.stringify([logged, delivery]);
    expect(columns).not.toContain(BLOCKED_HOST);
    expect(columns).not.toContain("blocked-host");
    expect(columns).not.toContain(BLOCKED_ADDRESS);
    expect(JSON.stringify(logged)).toContain(await subscriptionId(endpointA));
  });

  it("#1943 A-R4: a blocked lookup on the only subscription leaves revokedAt null and makes the delivery a retry with attempts + 1, not push_unsubscribed", async () => {
    const { fixture, eventId } = await pushFixture("push-blocked-retry-1943");
    const userId = fixture.users.owner.id;
    const endpoint = `https://${BLOCKED_HOST}/${userId}`;
    await subscribe(userId, endpoint);
    const attemptsBefore = (await getDb().select({ attempts: notificationDeliveries.attempts })
      .from(notificationDeliveries).where(eq(notificationDeliveries.eventId, eventId)))[0]?.attempts ?? 0;

    await runNotificationCycle(workerConfig(), {
      now: () => cycleTime,
      providers: providersFor(() => { throw new BlockedPushEndpointError(); }),
    });

    expect(await revokedAt(endpoint)).toBeNull();
    const [delivery] = await getDb().select().from(notificationDeliveries).where(eq(notificationDeliveries.eventId, eventId));
    expect(delivery).toMatchObject({ status: "retry", attempts: attemptsBefore + 1 });
    expect(delivery!.lastError).not.toBe("push_unsubscribed");
    expect(delivery!.lastError).toBe("push_unavailable");
  });

  it("#1943 A-R4: the push service's 410 still revokes the subscription", async () => {
    const { fixture } = await pushFixture("push-gone-1943");
    const userId = fixture.users.owner.id;
    const endpoint = `https://push.invalid.example/gone/${userId}`;
    await subscribe(userId, endpoint);

    await runNotificationCycle(workerConfig(), {
      now: () => cycleTime,
      providers: providersFor(() => { throw Object.assign(new Error("push subscription gone"), { statusCode: 410 }); }),
    });

    expect(await revokedAt(endpoint)).not.toBeNull();
  });

  it("item 10: an IP-literal endpoint never reaches providers.sendPush", async () => {
    const { fixture } = await pushFixture("push-literal-1929");
    const userId = fixture.users.owner.id;
    const literal = `https://[::1]/${userId}`;
    await subscribe(userId, literal);
    const seen: string[] = [];
    await runNotificationCycle(workerConfig(), {
      now: () => cycleTime,
      providers: providersFor((notification) => { seen.push(notification.target.endpoint); }),
    });
    expect(seen).not.toContain(literal);
  });
});

async function subscriptionId(endpoint: string): Promise<string> {
  const [row] = await getDb().select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
  return String(row!.id);
}
