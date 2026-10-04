import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The worker loop's own health fields (#1151 A4-F2), against a fake database
 * that either completes every step as a no-op (an empty system -- nothing
 * to materialize, claim or sweep) or refuses outright.
 *
 * WHAT THIS PINS. A success already cleared `lastErrorCategory`; it must
 * clear `lastErrorAt` in the same breath, or the admin Operations panel goes
 * on showing the moment of the first failure, forever, with no category
 * beside it to explain what it was.
 */

const mocks = vi.hoisted(() => ({
  mode: "success" as "success" | "failure",
}));

function emptySelect() {
  const builder = {
    from() { return builder; },
    innerJoin() { return builder; },
    leftJoin() { return builder; },
    where() { return builder; },
    orderBy() { return builder; },
    limit() { return builder; },
    for() { return builder; },
    then(resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve([]).then(resolve, reject);
    },
  };
  return builder;
}

function emptyInsert() {
  return { values() { return { onConflictDoNothing: () => Promise.resolve() }; } };
}

function emptyDatabase(): unknown {
  const db = {
    select: emptySelect,
    insert: emptyInsert,
    execute: () => Promise.resolve([]),
    transaction: (body: (executor: unknown) => unknown) => Promise.resolve(body(db)),
  };
  return db;
}

vi.mock("@/db", () => ({
  getDb: () => {
    if (mocks.mode === "failure") throw new Error("connection refused");
    return emptyDatabase();
  },
}));

const CONFIG = {
  smtpUrl: "",
  smtpSecurity: "starttls" as const,
  smtpFrom: "Orbit <orbit@localhost>",
  vapidSubject: "",
  vapidPublicKey: "",
  vapidPrivateKey: "",
  pollMilliseconds: 1_000,
  maxAttempts: 5,
};

/** The module keeps its worker state on `globalThis` itself (deliberately,
 *  so it survives a hot module reload in production) -- which means
 *  `vi.resetModules()` alone does NOT give each test a clean slate. */
function resetWorkerGlobals(): void {
  for (const key of [
    "__orbitWorkerStarted",
    "__orbitWorkerRunning",
    "__orbitWorkerLastSuccessAt",
    "__orbitWorkerLastErrorAt",
    "__orbitWorkerLastErrorCategory",
  ]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  resetWorkerGlobals();
  mocks.mode = "success";
});

afterEach(() => {
  vi.useRealTimers();
  resetWorkerGlobals();
});

describe("the worker loop's health fields", () => {
  it("clears a stale error timestamp on the next success, not only the category (#1151 A4-F2)", async () => {
    const { startNotificationWorker, getNotificationWorkerHealth } = await import("./notification-worker");

    mocks.mode = "failure";
    startNotificationWorker(CONFIG);
    await vi.advanceTimersByTimeAsync(0);

    const afterFailure = getNotificationWorkerHealth();
    expect(afterFailure.lastErrorAt).not.toBeNull();
    expect(afterFailure.lastErrorCategory).toBe("unknown");

    mocks.mode = "success";
    await vi.advanceTimersByTimeAsync(CONFIG.pollMilliseconds);

    const afterSuccess = getNotificationWorkerHealth();
    expect(afterSuccess.lastSuccessAt).not.toBeNull();
    // Before the fix, only the category cleared here -- the timestamp from
    // the earlier failure stuck around forever, with nothing to explain it.
    expect(afterSuccess.lastErrorAt).toBeNull();
    expect(afterSuccess.lastErrorCategory).toBeNull();
  });

  it("never reports an error at all when every cycle has succeeded", async () => {
    const { startNotificationWorker, getNotificationWorkerHealth } = await import("./notification-worker");

    startNotificationWorker(CONFIG);
    await vi.advanceTimersByTimeAsync(0);

    const health = getNotificationWorkerHealth();
    expect(health.lastSuccessAt).not.toBeNull();
    expect(health.lastErrorAt).toBeNull();
    expect(health.lastErrorCategory).toBeNull();
  });
});
