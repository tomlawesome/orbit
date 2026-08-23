import { createServer } from "node:net";
import { afterAll, describe, expect, it, vi } from "vitest";
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
  items,
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
    /** `null` leaves the item with no reminder rule of its own (#479). */
    daysBefore?: number | null;
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
  const daysBefore = options.daysBefore === undefined ? 0 : options.daysBefore;
  if (daysBefore !== null) {
    await db.insert(reminderRules).values({
      itemId: fixture.item.id,
      daysBefore,
      emailEnabled: options.emailEnabled ?? true,
      pushEnabled: options.pushEnabled ?? true,
    });
  }
  return event.id;
}

async function deliveryForEvent(eventId: string) {
  const [delivery] = await getDb().select().from(notificationDeliveries).where(eq(notificationDeliveries.eventId, eventId));
  return delivery;
}

/**
 * Every delivery an event produced, oldest warning first — a recipient's pair
 * raises two of them, so #479's cases cannot use the singular reader above.
 */
async function deliveriesForEvent(eventId: string) {
  return getDb().select().from(notificationDeliveries)
    .where(eq(notificationDeliveries.eventId, eventId))
    .orderBy(notificationDeliveries.scheduledFor, notificationDeliveries.channel);
}

/**
 * Sets one user's own reminder timing. Push is switched off by default so
 * these cases assert on the email schedule alone: the fallback pair opens both
 * channels, and a fixture user has no push subscription to send to.
 */
async function setWarningDays(
  userId: string,
  firstWarningDays: number,
  finalWarningDays: number,
  pushNotifications = false,
) {
  await getDb().update(userPreferences).set({
    firstWarningDays,
    finalWarningDays,
    pushNotifications,
    updatedAt: cycleTime,
  }).where(eq(userPreferences.userId, userId));
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
    let staleProviderCalls = 0;
    await runNotificationCycle(workerConfig(), {
      now: () => staleNow,
      providers: fakeProviders(() => { staleProviderCalls += 1; }),
      beforeProviderDispatch: async () => {
        await getDb().update(notificationDeliveries).set({
          status: "processing",
          lockedAt: staleNow,
          leaseToken: newerLease,
          attempts: 2,
        }).where(eq(notificationDeliveries.id, staleDelivery.id));
      },
      nextLeaseToken: () => deterministicLeaseToken(16),
    });
    const staleCompletion = await deliveryForEvent(staleEventId);
    expect(staleCompletion?.status).toBe("processing");
    expect(staleCompletion?.leaseToken).toBe(newerLease);
    expect(staleCompletion?.sentAt).toBeNull();
    expect(staleProviderCalls).toBe(0);

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
    let staleFailureProviderCalls = 0;
    await runNotificationCycle(workerConfig(), {
      now: () => staleNow,
      providers: fakeProviders(() => {
        staleFailureProviderCalls += 1;
        throw { code: "ETIMEDOUT", message: "private provider detail" };
      }),
      beforeProviderDispatch: async () => {
        await getDb().update(notificationDeliveries).set({
          status: "processing",
          lockedAt: staleNow,
          leaseToken: newerFailureLease,
          attempts: 2,
        }).where(eq(notificationDeliveries.id, staleFailureDelivery.id));
      },
      nextLeaseToken: () => deterministicLeaseToken(19),
    });
    const staleFailure = await deliveryForEvent(staleFailureEventId);
    expect(staleFailure?.status).toBe("processing");
    expect(staleFailure?.leaseToken).toBe(newerFailureLease);
    expect(staleFailure?.lastError).toBeNull();
    expect(staleFailureProviderCalls).toBe(0);
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

  it("#383 finding 1: bounds the real SMTP transporter's timeouts so a blackholed provider cannot hold the household lifecycle lock for minutes", async () => {
    const fixture = await ownerOnlyFixture("worker-smtp-blackhole");
    const eventId = await seedEvent(fixture, { pushEnabled: false });
    // Accepts the TCP connection but never sends the SMTP greeting banner,
    // modelling an egress firewall blackholing port 587. Nodemailer's
    // unbounded defaults are a 30s greeting timeout (and up to 2 min
    // connect / 10 min socket for other blackhole shapes); the fix for
    // #383 finding 1 gives the default send transporter the same 5s
    // connection/greeting/socket timeouts as the verification path, so the
    // household advisory lock this dispatch holds cannot be pinned open by
    // an unresponsive provider.
    const server = createServer((socket) => {
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Blackhole test server did not bind a port");
    try {
      // No `providers` override: this exercises the real default SMTP
      // provider construction, not the test fake used by every other case
      // in this file. Push is unused here (pushEnabled: false above), so
      // VAPID credentials are cleared rather than left as the fixture's
      // placeholder strings, which are not valid VAPID key material.
      const config = workerConfig({
        smtpUrl: `smtp://127.0.0.1:${address.port}`,
        vapidSubject: "",
        vapidPublicKey: "",
        vapidPrivateKey: "",
      });
      const startedAt = Date.now();
      await runNotificationCycle(config, {
        now: () => cycleTime,
        nextLeaseToken: () => deterministicLeaseToken(50),
      });
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeLessThan(15_000);
      const delivery = await deliveryForEvent(eventId);
      expect(delivery?.status).toBe("retry");
      expect(delivery?.lastError).toBe("smtp_unavailable");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

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

  it("#383 finding 1: does not pay the per-row Intl.DateTimeFormat cost for due events far outside the reminder catch-up window", async () => {
    const fixture = await ownerOnlyFixture("worker-date-window");
    const eventId = await seedEvent(fixture, { pushEnabled: false });

    // Due events far outside any plausible catch-up window for `cycleTime`
    // (2026-03-29): without the SQL date predicate from #383 finding 1,
    // every one of these would join into the candidate set and pay a fresh
    // Intl.DateTimeFormat construction in materializeDueDeliveries. Bulk
    // inserted (rather than one item/event/rule per round trip) to keep the
    // test fast at a row count large enough to make an unbounded scan obvious.
    const farRowCount = 60;
    const farItems = await getDb().insert(items).values(
      Array.from({ length: farRowCount }, (_, index) => ({
        householdId: fixture.household.id,
        sectionId: fixture.section.id,
        title: `Far future item ${index}`,
        currency: "GBP",
      })),
    ).returning({ id: items.id });
    await getDb().insert(dueEvents).values(
      farItems.map((item) => ({
        householdId: fixture.household.id,
        itemId: item.id,
        kind: "renewal" as const,
        dueDate: "2031-06-15",
      })),
    );
    await getDb().insert(reminderRules).values(
      farItems.map((item) => ({ itemId: item.id, daysBefore: 0 })),
    );

    // Spying on the prototype method (rather than replacing the
    // Intl.DateTimeFormat constructor itself) keeps every constructed
    // formatter a genuine native instance, so this cannot corrupt
    // Intl.DateTimeFormat for the rest of the test run.
    const formatSpy = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    await runNotificationCycle(workerConfig(), {
      now: () => cycleTime,
      providers: fakeProviders(),
      nextLeaseToken: () => deterministicLeaseToken(44),
    });
    const formatCalls = formatSpy.mock.calls.length;
    formatSpy.mockRestore();

    expect((await deliveryForEvent(eventId))?.status).toBe("sent");
    // Without the predicate this would be at least farRowCount (one call
    // per far-future candidate); the shared test database can carry a
    // handful of unrelated leftover rows from earlier tests in this file
    // that also land near `cycleTime`, so the bound is well below
    // farRowCount rather than an exact count.
    expect(formatCalls).toBeLessThan(farRowCount / 2);
  });

  it("#383 finding 2: never calls the push provider for a subscription endpoint outside the https/public-address boundary", async () => {
    const fixture = await ownerOnlyFixture("worker-push-unsafe-endpoint");
    const eventId = await seedEvent(fixture, { emailEnabled: false });
    // Same shape as the review's concrete probe: a plausible-looking
    // internal hostname on a non-default port (the database container).
    const unsafeEndpoint = "https://orbit-db.invalid:5432/probe";
    await getDb().insert(pushSubscriptions).values({
      userId: fixture.users.owner.id,
      endpoint: unsafeEndpoint,
      p256dh: "p256dh",
      auth: "auth",
    });
    let pushCalls = 0;
    await runNotificationCycle(workerConfig(), {
      now: () => cycleTime,
      providers: fakeProviders(async () => {}, () => { pushCalls += 1; }),
      nextLeaseToken: () => deterministicLeaseToken(40),
    });
    expect(pushCalls).toBe(0);
    expect((await deliveryForEvent(eventId))?.status).toBe("sent");
    const [revoked] = await getDb().select({ revokedAt: pushSubscriptions.revokedAt })
      .from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, unsafeEndpoint));
    expect(revoked?.revokedAt).not.toBeNull();
  });

  it("#383 finding 3: does not resend to a subscription that already received the reminder when a sibling subscription fails transiently", async () => {
    const fixture = await ownerOnlyFixture("worker-push-partial-failure");
    const eventId = await seedEvent(fixture, { emailEnabled: false });
    const phone = `https://push.invalid.example/phone-${fixture.users.owner.id}`;
    const laptop = `https://push.invalid.example/laptop-${fixture.users.owner.id}`;
    await getDb().insert(pushSubscriptions).values([
      { userId: fixture.users.owner.id, endpoint: phone, p256dh: "p256dh", auth: "auth" },
      { userId: fixture.users.owner.id, endpoint: laptop, p256dh: "p256dh", auth: "auth" },
    ]);
    const callsByEndpoint: Record<string, number> = { [phone]: 0, [laptop]: 0 };
    await runNotificationCycle(workerConfig(), {
      now: () => cycleTime,
      providers: fakeProviders(async () => {}, (notification) => {
        callsByEndpoint[notification.target.endpoint] = (callsByEndpoint[notification.target.endpoint] ?? 0) + 1;
        if (notification.target.endpoint === laptop) throw { statusCode: 503, message: "private push detail" };
      }),
      nextLeaseToken: () => deterministicLeaseToken(41),
    });
    expect(callsByEndpoint[phone]).toBe(1);
    expect(callsByEndpoint[laptop]).toBe(1);
    const delivered = await deliveryForEvent(eventId);
    // At least one device (phone) genuinely received the reminder, so the
    // delivery completes rather than retrying — retrying would necessarily
    // resend to every still-active subscription, including the phone.
    expect(delivered?.status).toBe("sent");
    expect(delivered?.lastError).toBe("push_unavailable");

    // A second cycle must not be able to reach this delivery again: it is
    // terminal, so the phone cannot receive a duplicate.
    await runNotificationCycle(workerConfig(), {
      now: () => cycleTime,
      providers: fakeProviders(async () => {}, (notification) => {
        callsByEndpoint[notification.target.endpoint] = (callsByEndpoint[notification.target.endpoint] ?? 0) + 1;
      }),
      nextLeaseToken: () => deterministicLeaseToken(42),
    });
    expect(callsByEndpoint[phone]).toBe(1);
  });

  it("#383 finding 4: cancels an already-queued delivery for a member who was removed from the household before it was claimed", async () => {
    const fixture = await createIntegrationFixture("worker-member-removed");
    const eventId = await seedEvent(fixture, { pushEnabled: false });
    await getDb().insert(notificationDeliveries).values({
      householdId: fixture.household.id,
      eventId,
      userId: fixture.users.member.id,
      channel: "email",
      scheduledFor: cycleTime,
    });
    await getDb().delete(memberships).where(and(
      eq(memberships.householdId, fixture.household.id),
      eq(memberships.userId, fixture.users.member.id),
    ));
    const recipients: string[] = [];
    await runNotificationCycle(workerConfig(), {
      now: () => cycleTime,
      providers: fakeProviders((notification) => { recipients.push(notification.to); }),
      nextLeaseToken: () => deterministicLeaseToken(43),
    });
    expect(recipients).not.toContain(fixture.users.member.email);
    const [memberDelivery] = await getDb().select().from(notificationDeliveries).where(and(
      eq(notificationDeliveries.eventId, eventId),
      eq(notificationDeliveries.userId, fixture.users.member.id),
    ));
    expect(memberDelivery).toMatchObject({
      status: "cancelled",
      lastError: "membership_removed",
    });
  });

  // #479. `cycleTime` is 09:00 Europe/London on 2026-03-29, so a warning of N
  // days fires during that cycle exactly when the date is N days later:
  // 2026-04-12 is the 14-day default first warning, 2026-04-09 the 3-day
  // default final one, 2026-04-02 a 10-day warning.
  const pairDueDate = "2026-04-12";
  const defaultFinalWarningTime = new Date("2026-04-09T08:00:00.000Z");

  it("#479: raises the recipient's own first and final warnings for an item that set no rules of its own", async () => {
    const fixture = await ownerOnlyFixture("worker-pair-fallback");
    const eventId = await seedEvent(fixture, { dueDate: pairDueDate, daysBefore: null });
    await setWarningDays(fixture.users.owner.id, 14, 3);
    const recipients: string[] = [];

    // Before #479 this cycle produced nothing at all: an item without a
    // reminder rule fell straight out of the worker's inner join.
    await runNotificationCycle(workerConfig(), {
      now: () => cycleTime,
      providers: fakeProviders((notification) => { recipients.push(notification.to); }),
      nextLeaseToken: () => deterministicLeaseToken(60),
    });
    const afterFirst = await deliveriesForEvent(eventId);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]).toMatchObject({ channel: "email", status: "sent", userId: fixture.users.owner.id });
    expect(afterFirst[0].scheduledFor.toISOString()).toBe(cycleTime.toISOString());
    expect(recipients).toEqual([fixture.users.owner.email]);

    // The final warning is a second, separately scheduled delivery, not a
    // resend of the first: the once-only index keys on the instant too.
    await runNotificationCycle(workerConfig(), {
      now: () => defaultFinalWarningTime,
      providers: fakeProviders((notification) => { recipients.push(notification.to); }),
      nextLeaseToken: () => deterministicLeaseToken(61),
    });
    const afterFinal = await deliveriesForEvent(eventId);
    expect(afterFinal).toHaveLength(2);
    expect(afterFinal.map((delivery) => delivery.scheduledFor.toISOString())).toEqual([
      cycleTime.toISOString(),
      defaultFinalWarningTime.toISOString(),
    ]);
    expect(afterFinal.every((delivery) => delivery.status === "sent")).toBe(true);
    expect(recipients).toHaveLength(2);
  });

  it("#479: uses the documented defaults for a recipient who has no stored preferences at all", async () => {
    const fixture = await ownerOnlyFixture("worker-pair-unset");
    const eventId = await seedEvent(fixture, { dueDate: pairDueDate, daysBefore: null });
    await getDb().delete(userPreferences).where(eq(userPreferences.userId, fixture.users.owner.id));

    await runNotificationCycle(workerConfig(), {
      now: () => cycleTime,
      providers: fakeProviders(),
      nextLeaseToken: () => deterministicLeaseToken(62),
    });

    const deliveries = await deliveriesForEvent(eventId);
    // 14 days is the default first warning even with no row to read it from,
    // and with no row the push toggle also defaults on — the subscription-less
    // push delivery is cancelled on its own terms, which is the pre-existing
    // behaviour for any reminder, not something the pair introduces.
    const email = deliveries.filter((delivery) => delivery.channel === "email");
    expect(email).toHaveLength(1);
    expect(email[0].scheduledFor.toISOString()).toBe(cycleTime.toISOString());
    expect(email[0].status).toBe("sent");
    expect(deliveries.filter((delivery) => delivery.channel === "web_push")).toMatchObject([
      { status: "cancelled", lastError: "push_unsubscribed" },
    ]);
  });

  it("#479: keeps an item's own reminder rules ahead of the recipient's pair", async () => {
    const fixture = await ownerOnlyFixture("worker-pair-item-rule-wins");
    // The item asks for a single warning five days out. The owner's pair
    // would have fired today; the item's own choice is not overruled by it,
    // nor added to.
    const eventId = await seedEvent(fixture, { dueDate: pairDueDate, daysBefore: 5, pushEnabled: false });
    await setWarningDays(fixture.users.owner.id, 14, 3);
    let providerCalls = 0;

    await runNotificationCycle(workerConfig(), {
      now: () => cycleTime,
      providers: fakeProviders(() => { providerCalls += 1; }),
      nextLeaseToken: () => deterministicLeaseToken(63),
    });
    expect(await deliveriesForEvent(eventId)).toHaveLength(0);
    expect(providerCalls).toBe(0);

    // Five days before the date, and only then, the item's own rule fires.
    await runNotificationCycle(workerConfig(), {
      now: () => new Date("2026-04-07T08:00:00.000Z"),
      providers: fakeProviders(() => { providerCalls += 1; }),
      nextLeaseToken: () => deterministicLeaseToken(64),
    });
    const deliveries = await deliveriesForEvent(eventId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].scheduledFor.toISOString()).toBe("2026-04-07T08:00:00.000Z");
    expect(providerCalls).toBe(1);
  });

  it("#479: gives each member of a household their own timing for the same item", async () => {
    const fixture = await createIntegrationFixture("worker-pair-per-member");
    const eventId = await seedEvent(fixture, { dueDate: pairDueDate, daysBefore: null });
    await setWarningDays(fixture.users.owner.id, 14, 3);
    await setWarningDays(fixture.users.member.id, 10, 3);
    const recipients: string[] = [];

    // One item, one date, two members: the owner's fortnight has arrived and
    // the member's ten days have not, so only one of them hears about it.
    await runNotificationCycle(workerConfig(), {
      now: () => cycleTime,
      providers: fakeProviders((notification) => { recipients.push(notification.to); }),
      nextLeaseToken: () => deterministicLeaseToken(65),
    });
    expect(recipients).toEqual([fixture.users.owner.email]);
    expect(await deliveriesForEvent(eventId)).toMatchObject([
      { userId: fixture.users.owner.id, channel: "email", status: "sent" },
    ]);

    const memberWarningTime = new Date("2026-04-02T08:00:00.000Z");
    await runNotificationCycle(workerConfig(), {
      now: () => memberWarningTime,
      providers: fakeProviders((notification) => { recipients.push(notification.to); }),
      nextLeaseToken: () => deterministicLeaseToken(66),
    });
    expect(recipients).toEqual([fixture.users.owner.email, fixture.users.member.email]);
    const deliveries = await deliveriesForEvent(eventId);
    expect(deliveries).toHaveLength(2);
    expect(deliveries[1]).toMatchObject({ userId: fixture.users.member.id, channel: "email", status: "sent" });
    expect(deliveries[1].scheduledFor.toISOString()).toBe(memberWarningTime.toISOString());
  });

  it("#479: cancels a queued delivery the recipient's retimed pair no longer asks for", async () => {
    const fixture = await ownerOnlyFixture("worker-pair-retimed");
    const eventId = await seedEvent(fixture, { dueDate: pairDueDate, daysBefore: null });
    await setWarningDays(fixture.users.owner.id, 14, 3);
    await getDb().insert(notificationDeliveries).values({
      householdId: fixture.household.id,
      eventId,
      userId: fixture.users.owner.id,
      channel: "email",
      scheduledFor: cycleTime,
    });
    // The reader moves their first warning out to three weeks. The fortnight
    // mark is no longer a warning they ask for, so the delivery already
    // sitting in the queue for it must not go out on the old schedule.
    await setWarningDays(fixture.users.owner.id, 21, 3);
    let providerCalls = 0;

    await runNotificationCycle(workerConfig(), {
      now: () => cycleTime,
      providers: fakeProviders(() => { providerCalls += 1; }),
      nextLeaseToken: () => deterministicLeaseToken(67),
    });

    expect(providerCalls).toBe(0);
    expect(await deliveriesForEvent(eventId)).toMatchObject([{ status: "cancelled" }]);
  });

  it("#479: does not fire a warning longer than the reach of the open due event, and still lands the final one", async () => {
    const fixture = await ownerOnlyFixture("worker-pair-overlong-warning");
    // An item due in nine days against a first warning of ninety: that
    // warning's moment passed long before the item existed, so it is not
    // back-fired. The final warning is still ahead and still lands.
    const eventId = await seedEvent(fixture, { dueDate: "2026-04-07", daysBefore: null });
    await setWarningDays(fixture.users.owner.id, 90, 3);

    await runNotificationCycle(workerConfig(), {
      now: () => cycleTime,
      providers: fakeProviders(),
      nextLeaseToken: () => deterministicLeaseToken(68),
    });
    expect(await deliveriesForEvent(eventId)).toHaveLength(0);

    const finalWarningTime = new Date("2026-04-04T08:00:00.000Z");
    await runNotificationCycle(workerConfig(), {
      now: () => finalWarningTime,
      providers: fakeProviders(),
      nextLeaseToken: () => deterministicLeaseToken(69),
    });
    const deliveries = await deliveriesForEvent(eventId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].scheduledFor.toISOString()).toBe(finalWarningTime.toISOString());
    expect(deliveries[0].status).toBe("sent");
  });
});
