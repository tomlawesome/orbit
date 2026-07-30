import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, sql } from "drizzle-orm";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import {
  getNotificationWorkerConfig,
  runNotificationCycle,
  type NotificationProviders,
  type NotificationWorkerConfig,
  type PushNotification,
  type SmtpNotification,
} from "@/server/notification-worker";
import {
  dueEvents,
  households,
  memberships,
  notificationDeliveries,
  pushSubscriptions,
  reminderRules,
  userPreferences,
  users,
} from "@/db/schema";
import { requestHouseholdDeletion, restoreHousehold } from "@/server/household-lifecycle";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

const cycleTime = new Date("2026-03-29T08:00:00.000Z");

function workerConfig(overrides: Partial<NotificationWorkerConfig> = {}): NotificationWorkerConfig {
  return {
    ...getNotificationWorkerConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv),
    smtpUrl: "smtp://smtp.invalid.example:587",
    smtpSecurity: "starttls",
    smtpFrom: "Orbit <orbit@example.invalid>",
    vapidSubject: "mailto:orbit@example.invalid",
    vapidPublicKey: "test-vapid-public-key",
    vapidPrivateKey: "fake-vapid-key",
    pollMilliseconds: 60_000,
    maxAttempts: 3,
    ...overrides,
  };
}

function fakeProviders(
  onEmail: (notification: SmtpNotification) => Promise<void> | void = async () => {},
  onPush: (notification: PushNotification) => Promise<void> | void = async () => {},
): NotificationProviders {
  return {
    async sendEmail(notification) {
      await onEmail(notification);
    },
    async sendPush(notification) {
      await onPush(notification);
    },
  };
}

async function ownerOnlyFixture(label: string): Promise<IntegrationFixture> {
  const fixture = await createIntegrationFixture(label);
  await getDb().delete(memberships).where(and(
    eq(memberships.householdId, fixture.household.id),
    eq(memberships.userId, fixture.users.member.id),
  ));
  return fixture;
}

async function seedEvent(
  fixture: IntegrationFixture,
  options: {
    dueDate?: string;
    completedAt?: Date | null;
    emailEnabled?: boolean;
    pushEnabled?: boolean;
    daysBefore?: number;
  } = {},
) {
  const db = getDb();
  const [event] = await db.insert(dueEvents).values({
    householdId: fixture.household.id,
    itemId: fixture.item.id,
    kind: "renewal",
    dueDate: options.dueDate ?? "2026-03-29",
    completedAt: options.completedAt,
  }).returning({ id: dueEvents.id });
  await db.insert(reminderRules).values({
    itemId: fixture.item.id,
    daysBefore: options.daysBefore ?? 0,
    emailEnabled: options.emailEnabled ?? true,
    pushEnabled: options.pushEnabled ?? true,
  });
  return event.id;
}

async function deliveryForEvent(eventId: string) {
  const [delivery] = await getDb().select().from(notificationDeliveries).where(eq(notificationDeliveries.eventId, eventId));
  return delivery;
}

function deterministicLeaseToken(sequence: number): string {
  return `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

async function waitForAdvisoryLockWaiter(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await getDb().execute(sql<{ waiting: number }>`
      select count(*)::int as waiting
      from pg_locks
      where locktype = 'advisory' and granted = false
    `);
    if (Number(rows[0]?.waiting) > 0) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Household deletion did not wait for the notification lifecycle lock");
}

function openIndependentDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for notification worker integration tests");
  const client = postgres(url, { max: 1, prepare: false });
  return { client, db: drizzle(client, { schema }) };
}

describe("notification worker PostgreSQL contracts", () => {
  it("does not materialize or dispatch reminders for a household scheduled for deletion", async () => {
    const hiddenFixture = await ownerOnlyFixture("worker-hidden-household");
    const hiddenEventId = await seedEvent(hiddenFixture, { pushEnabled: false });
    await requestHouseholdDeletion(
      hiddenFixture.users.owner.id,
      hiddenFixture.household.id,
      hiddenFixture.household.name,
    );
    let providerCalls = 0;
    await runNotificationCycle(workerConfig(), {
      now: () => cycleTime,
      providers: fakeProviders(() => { providerCalls += 1; }),
      nextLeaseToken: () => deterministicLeaseToken(1),
    });
    expect(await getDb().select().from(notificationDeliveries).where(eq(notificationDeliveries.eventId, hiddenEventId)))
      .toHaveLength(0);
    expect(providerCalls).toBe(0);

    const queuedFixture = await ownerOnlyFixture("worker-queued-hidden-household");
    const queuedEventId = await seedEvent(queuedFixture, { pushEnabled: false });
    await getDb().insert(notificationDeliveries).values({
      householdId: queuedFixture.household.id,
      eventId: queuedEventId,
      userId: queuedFixture.users.owner.id,
      channel: "email",
      scheduledFor: cycleTime,
    });
    await requestHouseholdDeletion(
      queuedFixture.users.owner.id,
      queuedFixture.household.id,
      queuedFixture.household.name,
    );
    await runNotificationCycle(workerConfig(), {
      now: () => cycleTime,
      providers: fakeProviders(() => { providerCalls += 1; }),
      nextLeaseToken: () => deterministicLeaseToken(2),
    });
    expect(await deliveryForEvent(queuedEventId)).toMatchObject({
      status: "cancelled",
      leaseToken: null,
      lastError: "household_pending_deletion",
    });
    expect(providerCalls).toBe(0);

    await restoreHousehold(queuedFixture.users.owner.id, queuedFixture.household.id);
    await runNotificationCycle(workerConfig(), {
      now: () => cycleTime,
      providers: fakeProviders(() => { providerCalls += 1; }),
      nextLeaseToken: () => deterministicLeaseToken(3),
    });
    expect(await deliveryForEvent(queuedEventId)).toMatchObject({
      status: "sent",
      leaseToken: null,
      lastError: null,
    });
    expect(providerCalls).toBe(1);
  });

  it("does not dispatch when household deletion wins the pre-provider lifecycle lock", async () => {
    const fixture = await ownerOnlyFixture("worker-deletion-before-dispatch");
    const eventId = await seedEvent(fixture, { pushEnabled: false });
    let providerCalls = 0;

    await runNotificationCycle(workerConfig(), {
      now: () => cycleTime,
      providers: fakeProviders(() => { providerCalls += 1; }),
      nextLeaseToken: () => deterministicLeaseToken(4),
      beforeProviderDispatch: async () => {
        await requestHouseholdDeletion(
          fixture.users.owner.id,
          fixture.household.id,
          fixture.household.name,
        );
      },
    });

    expect(await deliveryForEvent(eventId)).toMatchObject({
      status: "cancelled",
      leaseToken: null,
      lastError: "household_pending_deletion",
    });
    expect(providerCalls).toBe(0);
  });

  it("holds the lifecycle lock through provider dispatch before deletion can commit", async () => {
    const fixture = await ownerOnlyFixture("worker-dispatch-before-deletion");
    const eventId = await seedEvent(fixture, { pushEnabled: false });
    const providerStarted = deferred<void>();
    const releaseProvider = deferred<void>();
    let providerCalls = 0;
    const cycle = runNotificationCycle(workerConfig(), {
      now: () => cycleTime,
      providers: fakeProviders(async () => {
        providerCalls += 1;
        providerStarted.resolve();
        await releaseProvider.promise;
      }),
      nextLeaseToken: () => deterministicLeaseToken(5),
    });

    await providerStarted.promise;
    const deletion = requestHouseholdDeletion(
      fixture.users.owner.id,
      fixture.household.id,
      fixture.household.name,
    );
    await waitForAdvisoryLockWaiter();
    expect(await getDb().select({ deletionRequestedAt: households.deletionRequestedAt })
      .from(households).where(eq(households.id, fixture.household.id)))
      .toEqual([{ deletionRequestedAt: null }]);

    releaseProvider.resolve();
    await Promise.all([cycle, deletion]);

    expect(await deliveryForEvent(eventId)).toMatchObject({
      status: "sent",
      leaseToken: null,
      lastError: null,
    });
    expect(await getDb().select({ deletionRequestedAt: households.deletionRequestedAt })
      .from(households).where(eq(households.id, fixture.household.id)))
      .toEqual([{ deletionRequestedAt: expect.any(Date) }]);
    expect(providerCalls).toBe(1);
  });

  it("materializes one row per channel and keeps concurrent cycles exclusive", async () => {
    const fixture = await ownerOnlyFixture("worker-concurrency");
    const db = getDb();
    const eventId = await seedEvent(fixture);
    await db.insert(pushSubscriptions).values({
      userId: fixture.users.owner.id,
      endpoint: `https://push.invalid.example/${fixture.users.owner.id}`,
      p256dh: "fixture-p256dh",
      auth: "fixture-auth",
    });
    const first = openIndependentDatabase();
    const second = openIndependentDatabase();
    let emailCalls = 0;
    let pushCalls = 0;
    const providers = fakeProviders(
      () => { emailCalls += 1; },
      () => { pushCalls += 1; },
    );
    let firstLeaseSequence = 0;
    let secondLeaseSequence = 0;
    try {
      await Promise.all([
        runNotificationCycle(workerConfig(), {
          db: first.db,
          now: () => cycleTime,
          providers,
          nextLeaseToken: () => deterministicLeaseToken(100 + firstLeaseSequence++),
        }),
        runNotificationCycle(workerConfig(), {
          db: second.db,
          now: () => cycleTime,
          providers,
          nextLeaseToken: () => deterministicLeaseToken(200 + secondLeaseSequence++),
        }),
      ]);
      const rows = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.eventId, eventId));
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.channel).sort()).toEqual(["email", "web_push"]);
      expect(rows.every((row) => row.scheduledFor.toISOString() === cycleTime.toISOString())).toBe(true);
      expect(rows.every((row) => row.status === "sent" && row.attempts === 1)).toBe(true);
      expect(emailCalls).toBe(1);
      expect(pushCalls).toBe(1);

      await runNotificationCycle(workerConfig(), {
        db: first.db,
        now: () => cycleTime,
        providers,
        nextLeaseToken: () => deterministicLeaseToken(3),
      });
      expect(await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.eventId, eventId))).toHaveLength(2);
      expect(emailCalls).toBe(1);
      expect(pushCalls).toBe(1);
    } finally {
      await first.client.end();
      await second.client.end();
    }
  });

  it("reclaims expired leases, leaves live leases alone, and protects stale completion and failure", async () => {
    const expiredFixture = await ownerOnlyFixture("worker-expired-lease");
    const expiredEventId = await seedEvent(expiredFixture, { pushEnabled: false });
    const expiredNow = new Date("2026-03-29T08:05:00.000Z");
    const expiredLease = deterministicLeaseToken(10);
    const [expiredDelivery] = await getDb().insert(notificationDeliveries).values({
      householdId: expiredFixture.household.id,
      eventId: expiredEventId,
      userId: expiredFixture.users.owner.id,
      channel: "email",
      scheduledFor: cycleTime,
      status: "processing",
      attempts: 1,
      lockedAt: new Date(expiredNow.getTime() - 11 * 60_000),
      leaseToken: expiredLease,
    }).returning({ id: notificationDeliveries.id });
    await runNotificationCycle(workerConfig(), {
      now: () => expiredNow,
      providers: fakeProviders(),
      nextLeaseToken: () => deterministicLeaseToken(11),
    });
    const reclaimed = await deliveryForEvent(expiredEventId);
    expect(reclaimed?.id).toBe(expiredDelivery.id);
    expect(reclaimed?.status).toBe("sent");
    expect(reclaimed?.attempts).toBe(2);

    const liveFixture = await ownerOnlyFixture("worker-live-lease");
    const liveEventId = await seedEvent(liveFixture, { pushEnabled: false });
    const liveNow = new Date("2026-03-29T08:05:00.000Z");
    await getDb().insert(notificationDeliveries).values({
      householdId: liveFixture.household.id,
      eventId: liveEventId,
      userId: liveFixture.users.owner.id,
      channel: "email",
      scheduledFor: cycleTime,
      status: "processing",
      attempts: 1,
      lockedAt: new Date(liveNow.getTime() - 5 * 60_000),
      leaseToken: deterministicLeaseToken(12),
    });
    let liveProviderCalls = 0;
    await runNotificationCycle(workerConfig(), {
      now: () => liveNow,
      providers: fakeProviders(() => { liveProviderCalls += 1; }),
      nextLeaseToken: () => deterministicLeaseToken(13),
    });
    const live = await deliveryForEvent(liveEventId);
    expect(live?.status).toBe("processing");
    expect(live?.leaseToken).toBe(deterministicLeaseToken(12));
    expect(liveProviderCalls).toBe(0);

    const staleFixture = await ownerOnlyFixture("worker-stale-lease");
    const staleEventId = await seedEvent(staleFixture, { pushEnabled: false });
    const staleNow = new Date("2026-03-29T08:05:00.000Z");
    const [staleDelivery] = await getDb().insert(notificationDeliveries).values({
      householdId: staleFixture.household.id,
      eventId: staleEventId,
      userId: staleFixture.users.owner.id,
      channel: "email",
      scheduledFor: cycleTime,
      status: "processing",
      attempts: 1,
      lockedAt: new Date(staleNow.getTime() - 11 * 60_000),
      leaseToken: deterministicLeaseToken(14),
    }).returning({ id: notificationDeliveries.id });
    const newerLease = deterministicLeaseToken(15);
    await runNotificationCycle(workerConfig(), {
      now: () => staleNow,
      providers: fakeProviders(async () => {
        await getDb().update(notificationDeliveries).set({
          status: "processing",
          lockedAt: staleNow,
          leaseToken: newerLease,
          attempts: 2,
        }).where(eq(notificationDeliveries.id, staleDelivery.id));
      }),
      nextLeaseToken: () => deterministicLeaseToken(16),
    });
    const staleCompletion = await deliveryForEvent(staleEventId);
    expect(staleCompletion?.status).toBe("processing");
    expect(staleCompletion?.leaseToken).toBe(newerLease);
    expect(staleCompletion?.sentAt).toBeNull();

    const staleFailureFixture = await ownerOnlyFixture("worker-stale-failure");
    const staleFailureEventId = await seedEvent(staleFailureFixture, { pushEnabled: false });
    const [staleFailureDelivery] = await getDb().insert(notificationDeliveries).values({
      householdId: staleFailureFixture.household.id,
      eventId: staleFailureEventId,
      userId: staleFailureFixture.users.owner.id,
      channel: "email",
      scheduledFor: cycleTime,
      status: "processing",
      attempts: 1,
      lockedAt: new Date(staleNow.getTime() - 11 * 60_000),
      leaseToken: deterministicLeaseToken(17),
    }).returning({ id: notificationDeliveries.id });
    const newerFailureLease = deterministicLeaseToken(18);
    await runNotificationCycle(workerConfig(), {
      now: () => staleNow,
      providers: fakeProviders(async () => {
        await getDb().update(notificationDeliveries).set({
          status: "processing",
          lockedAt: staleNow,
          leaseToken: newerFailureLease,
          attempts: 2,
        }).where(eq(notificationDeliveries.id, staleFailureDelivery.id));
        throw { code: "ETIMEDOUT", message: "private provider detail" };
      }),
      nextLeaseToken: () => deterministicLeaseToken(19),
    });
    const staleFailure = await deliveryForEvent(staleFailureEventId);
    expect(staleFailure?.status).toBe("processing");
    expect(staleFailure?.leaseToken).toBe(newerFailureLease);
    expect(staleFailure?.lastError).toBeNull();
  });

  it("does not dispatch a lease reclaimed after the cycle starts", async () => {
    const fixture = await ownerOnlyFixture("worker-reclaimed-before-dispatch");
    const eventId = await seedEvent(fixture, { pushEnabled: false });
    const [delivery] = await getDb().insert(notificationDeliveries).values({
      householdId: fixture.household.id,
      eventId,
      userId: fixture.users.owner.id,
      channel: "email",
      scheduledFor: cycleTime,
      status: "pending",
    }).returning({ id: notificationDeliveries.id });
    const reclaimer = openIndependentDatabase();
    const oldLease = deterministicLeaseToken(30);
    const newLease = deterministicLeaseToken(31);
    let currentTime = cycleTime;
    let providerCalls = 0;
    try {
      await runNotificationCycle(workerConfig(), {
        now: () => currentTime,
        nextLeaseToken: () => oldLease,
        providers: fakeProviders(() => { providerCalls += 1; }),
        beforeProviderDispatch: async ({ id }) => {
          currentTime = new Date(cycleTime.getTime() + 11 * 60_000);
          await reclaimer.db.update(notificationDeliveries).set({
            status: "processing",
            lockedAt: currentTime,
            leaseToken: newLease,
            attempts: 2,
          }).where(eq(notificationDeliveries.id, id));
        },
      });
      const reclaimed = await deliveryForEvent(eventId);
      expect(reclaimed?.id).toBe(delivery.id);
      expect(reclaimed?.status).toBe("processing");
      expect(reclaimed?.leaseToken).toBe(newLease);
      expect(providerCalls).toBe(0);
    } finally {
      await reclaimer.client.end();
    }
  });

  it("continues a persisted retry after restart and stops at the configured attempt bound", async () => {
    const fixture = await ownerOnlyFixture("worker-restart-retry");
    const eventId = await seedEvent(fixture, { pushEnabled: false });
    let calls = 0;
    await runNotificationCycle(workerConfig({ maxAttempts: 3 }), {
      now: () => cycleTime,
      providers: fakeProviders(() => {
        calls += 1;
        throw { code: "ETIMEDOUT", message: "private smtp detail" };
      }),
      nextLeaseToken: () => deterministicLeaseToken(20),
    });
    const retry = await deliveryForEvent(eventId);
    expect(retry?.status).toBe("retry");
    expect(retry?.attempts).toBe(1);
    expect(retry?.lastError).toBe("smtp_unavailable");
    expect(retry?.lastError).not.toContain("private");

    await runNotificationCycle(workerConfig({ maxAttempts: 2 }), {
      now: () => new Date(cycleTime.getTime() + 60_000),
      providers: fakeProviders(() => {
        calls += 1;
        throw { code: "ETIMEDOUT", message: "another private smtp detail" };
      }),
      nextLeaseToken: () => deterministicLeaseToken(21),
    });
    const failed = await deliveryForEvent(eventId);
    expect(failed?.status).toBe("failed");
    expect(failed?.attempts).toBe(2);
    expect(calls).toBe(2);
  });

  it("keeps SMTP and Web Push outcomes bounded and provider calls explicit", async () => {
    const smtpFixture = await ownerOnlyFixture("worker-smtp-success");
    const smtpEventId = await seedEvent(smtpFixture, { pushEnabled: false });
    const smtpMessages: SmtpNotification[] = [];
    await runNotificationCycle(workerConfig(), {
      now: () => cycleTime,
      providers: fakeProviders((notification) => { smtpMessages.push(notification); }),
      nextLeaseToken: () => deterministicLeaseToken(22),
    });
    expect((await deliveryForEvent(smtpEventId))?.status).toBe("sent");
    expect(smtpMessages).toHaveLength(1);
    expect(smtpMessages[0]).toMatchObject({
      from: "Orbit <orbit@example.invalid>",
      to: smtpFixture.users.owner.email,
      tlsMode: "starttls",
    });
    expect(smtpMessages[0].subject.length).toBeLessThanOrEqual(180);
    expect(smtpMessages[0].text.length).toBeLessThanOrEqual(500);

    const permanentFixture = await ownerOnlyFixture("worker-smtp-permanent");
    const permanentEventId = await seedEvent(permanentFixture, { pushEnabled: false });
    await runNotificationCycle(workerConfig(), {
      now: () => cycleTime,
      providers: fakeProviders(() => { throw { responseCode: 550, message: "private recipient detail" }; }),
      nextLeaseToken: () => deterministicLeaseToken(23),
    });
    const permanent = await deliveryForEvent(permanentEventId);
    expect(permanent?.status).toBe("cancelled");
    expect(permanent?.lastError).toBe("smtp_rejected");

    const unconfiguredFixture = await ownerOnlyFixture("worker-smtp-unconfigured");
    const unconfiguredEventId = await seedEvent(unconfiguredFixture, { pushEnabled: false });
    let unconfiguredCalls = 0;
    await runNotificationCycle(workerConfig({ smtpUrl: "" }), {
      now: () => cycleTime,
      providers: fakeProviders(() => { unconfiguredCalls += 1; }),
      nextLeaseToken: () => deterministicLeaseToken(24),
    });
    const unconfigured = await deliveryForEvent(unconfiguredEventId);
    expect(unconfigured?.status).toBe("cancelled");
    expect(unconfigured?.lastError).toBe("smtp_unconfigured");
    expect(unconfiguredCalls).toBe(0);

    const pushFixture = await ownerOnlyFixture("worker-push-success");
    const pushEventId = await seedEvent(pushFixture, { emailEnabled: false });
    const endpoint = `https://push.invalid.example/${pushFixture.users.owner.id}`;
    await getDb().insert(pushSubscriptions).values({ userId: pushFixture.users.owner.id, endpoint, p256dh: "p256dh", auth: "auth" });
    const pushMessages: PushNotification[] = [];
    await runNotificationCycle(workerConfig(), {
      now: () => cycleTime,
      providers: fakeProviders(async () => {}, (notification) => { pushMessages.push(notification); }),
      nextLeaseToken: () => deterministicLeaseToken(25),
    });
    expect((await deliveryForEvent(pushEventId))?.status).toBe("sent");
    expect(pushMessages).toHaveLength(1);
    expect(pushMessages[0].target.endpoint).toBe(endpoint);
    expect(pushMessages[0].payload.url).toBe("/");
    expect(pushMessages[0].payload.body.length).toBeLessThanOrEqual(320);

    const goneFixture = await ownerOnlyFixture("worker-push-gone");
    const goneEventId = await seedEvent(goneFixture, { emailEnabled: false });
    const goneSubscription = `https://push.invalid.example/${goneFixture.users.owner.id}`;
    await getDb().insert(pushSubscriptions).values({ userId: goneFixture.users.owner.id, endpoint: goneSubscription, p256dh: "p256dh", auth: "auth" });
    await runNotificationCycle(workerConfig(), {
      now: () => cycleTime,
      providers: fakeProviders(async () => {}, () => { throw { statusCode: 410, message: goneSubscription }; }),
      nextLeaseToken: () => deterministicLeaseToken(26),
    });
    expect((await deliveryForEvent(goneEventId))?.status).toBe("sent");
    const [revoked] = await getDb().select({ revokedAt: pushSubscriptions.revokedAt }).from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, goneSubscription));
    expect(revoked?.revokedAt).not.toBeNull();

    const transientFixture = await ownerOnlyFixture("worker-push-transient");
    const transientEventId = await seedEvent(transientFixture, { emailEnabled: false });
    await getDb().insert(pushSubscriptions).values({ userId: transientFixture.users.owner.id, endpoint: `https://push.invalid.example/${transientFixture.users.owner.id}`, p256dh: "p256dh", auth: "auth" });
    await runNotificationCycle(workerConfig(), {
      now: () => cycleTime,
      providers: fakeProviders(async () => {}, () => { throw { statusCode: 503, message: "private push detail" }; }),
      nextLeaseToken: () => deterministicLeaseToken(27),
    });
    const transient = await deliveryForEvent(transientEventId);
    expect(transient?.status).toBe("retry");
    expect(transient?.lastError).toBe("push_unavailable");

    const unsubscribedFixture = await ownerOnlyFixture("worker-push-unsubscribed");
    const unsubscribedEventId = await seedEvent(unsubscribedFixture, { emailEnabled: false });
    await runNotificationCycle(workerConfig(), {
      now: () => cycleTime,
      providers: fakeProviders(),
      nextLeaseToken: () => deterministicLeaseToken(28),
    });
    expect((await deliveryForEvent(unsubscribedEventId))?.status).toBe("cancelled");
    expect((await deliveryForEvent(unsubscribedEventId))?.lastError).toBe("push_unsubscribed");

    const pushUnconfiguredFixture = await ownerOnlyFixture("worker-push-unconfigured");
    const pushUnconfiguredEventId = await seedEvent(pushUnconfiguredFixture, { emailEnabled: false });
    await getDb().insert(pushSubscriptions).values({ userId: pushUnconfiguredFixture.users.owner.id, endpoint: `https://push.invalid.example/${pushUnconfiguredFixture.users.owner.id}`, p256dh: "p256dh", auth: "auth" });
    let pushUnconfiguredCalls = 0;
    await runNotificationCycle(workerConfig({ vapidSubject: "", vapidPublicKey: "", vapidPrivateKey: "" }), {
      now: () => cycleTime,
      providers: fakeProviders(async () => {}, () => { pushUnconfiguredCalls += 1; }),
      nextLeaseToken: () => deterministicLeaseToken(29),
    });
    expect((await deliveryForEvent(pushUnconfiguredEventId))?.status).toBe("cancelled");
    expect((await deliveryForEvent(pushUnconfiguredEventId))?.lastError).toBe("push_unconfigured");
    expect(pushUnconfiguredCalls).toBe(0);
  });

  it("does not materialize deliveries for disabled users, preferences, rules, completed events, or stale events", async () => {
    const disabledUserFixture = await ownerOnlyFixture("worker-disabled-user");
    const disabledUserEventId = await seedEvent(disabledUserFixture, { pushEnabled: false });
    await getDb().update(users).set({ disabledAt: cycleTime, updatedAt: cycleTime }).where(eq(users.id, disabledUserFixture.users.owner.id));
    await runNotificationCycle(workerConfig(), { now: () => cycleTime, providers: fakeProviders() });
    expect(await deliveryForEvent(disabledUserEventId)).toBeUndefined();

    const disabledPreferenceFixture = await ownerOnlyFixture("worker-disabled-preference");
    const disabledPreferenceEventId = await seedEvent(disabledPreferenceFixture, { pushEnabled: false });
    await getDb().update(userPreferences).set({ emailNotifications: false, updatedAt: cycleTime }).where(eq(userPreferences.userId, disabledPreferenceFixture.users.owner.id));
    await runNotificationCycle(workerConfig(), { now: () => cycleTime, providers: fakeProviders() });
    expect(await deliveryForEvent(disabledPreferenceEventId)).toBeUndefined();

    const disabledRuleFixture = await ownerOnlyFixture("worker-disabled-rule");
    const disabledRuleEventId = await seedEvent(disabledRuleFixture, { emailEnabled: false, pushEnabled: false });
    await runNotificationCycle(workerConfig(), { now: () => cycleTime, providers: fakeProviders() });
    expect(await deliveryForEvent(disabledRuleEventId)).toBeUndefined();

    const completedFixture = await ownerOnlyFixture("worker-completed-event");
    const completedEventId = await seedEvent(completedFixture, { completedAt: cycleTime, pushEnabled: false });
    await runNotificationCycle(workerConfig(), { now: () => cycleTime, providers: fakeProviders() });
    expect(await deliveryForEvent(completedEventId)).toBeUndefined();

    const staleFixture = await ownerOnlyFixture("worker-stale-event");
    const staleEventId = await seedEvent(staleFixture, { dueDate: "2026-03-27", pushEnabled: false });
    await runNotificationCycle(workerConfig(), {
      now: () => new Date("2026-03-29T08:00:00.000Z"),
      providers: fakeProviders(),
    });
    expect(await deliveryForEvent(staleEventId)).toBeUndefined();
  });
});
