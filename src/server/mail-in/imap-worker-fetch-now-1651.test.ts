import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1651 review: "fetch now" goes through the ingestion worker's own check
 * path, tested here against the REAL worker (startImapIngestionWorker,
 * runImapIngestionCycle, verifyImapIngestionProviders and the timer arm),
 * with only the edges faked: config, SMTP settings, the metadata reader, the
 * database and the IMAP client. Fake timers drive the real timer.
 *
 * Names are the tests' choice. `runImapIngestionNow()` in imap-ingestion.ts
 * answers `{ status: "checked", result }` | `{ status: "already_running" }` |
 * `{ status: "provider_unavailable" }` | `{ status: "credential_locked" }`.
 * It shares ONE in-flight guard with the timer tick, runs the provider
 * preflight like a tick, updates worker health like a tick, and afterwards
 * leaves exactly one timer armed, a full poll interval away (also when the
 * worker was never started, and when the cycle threw). The cycle's result
 * gains `notChecked: "key_unavailable" | "dkim_dns_malformed" | null`.
 *
 * A cycle is counted by the call to the metadata reader that opens it; the
 * faked database then makes the cycle fail, which the worker must absorb.
 */
const POLL_MS = 120_000;
const mocks = vi.hoisted(() => ({
  cycles: 0,
  hold: Promise.resolve() as Promise<void>,
  locked: false,
  connect: vi.fn(async () => undefined),
  credentialLocked: false,
}));

vi.mock("@/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/db")>(),
  getDb: () => { throw new Error("no database in a unit test"); },
}));
vi.mock("@/server/metadata/fields", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/metadata/fields")>(),
  openInstanceMetadataReader: async () => {
    mocks.cycles += 1;
    await mocks.hold;
    return { locked: mocks.locked };
  },
}));
vi.mock("./mailbox-config", async (importOriginal) => {
  const original = await importOriginal<typeof import("./mailbox-config")>();
  const { testImapConfig } = await import("../../../tests/support/imap-config");
  return {
    ...original,
    getImapIngestionConfig: async () => {
      if (mocks.credentialLocked) throw new original.MailInCredentialLockedError("test-key");
      return testImapConfig({ pollMilliseconds: POLL_MS });
    },
  };
});
vi.mock("./sending-settings", async (importOriginal) => ({
  ...await importOriginal<typeof import("./sending-settings")>(),
  outgoingMailConfig: async () => ({
    smtpUrl: "smtp://smtp.example.test:587", smtpSecurity: "starttls", smtpFrom: "orbit@example.test",
    vapidSubject: "", vapidPublicKey: "", vapidPrivateKey: "", pollMilliseconds: 30_000, maxAttempts: 5,
  }),
}));
vi.mock("@/server/notification-worker", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/notification-worker")>(),
  verifySmtpProviderConnection: async () => "ready",
}));

type Ingestion = typeof import("./imap-ingestion");
let ingestion: Ingestion;

function release(): () => void {
  let open: () => void = () => undefined;
  mocks.hold = new Promise<void>((resolve) => { open = resolve; });
  return open;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const key of ["__orbitImapWorkerStarted", "__orbitImapWorkerRunning", "__orbitImapWorkerResetTimer",
    "__orbitImapWorkerLastSuccessAt", "__orbitImapWorkerLastErrorAt", "__orbitImapWorkerLastErrorCode",
    "__orbitImapProviderPreflight"]) delete (globalThis as Record<string, unknown>)[key];
  mocks.cycles = 0;
  mocks.hold = Promise.resolve();
  mocks.locked = false;
  mocks.credentialLocked = false;
  mocks.connect.mockReset();
  mocks.connect.mockResolvedValue(undefined);
  ingestion = await import("./imap-ingestion");
  ingestion.setImapClientFactoryForTests(() => ({
    connect: mocks.connect,
    logout: async () => undefined,
  }) as never);
});

afterEach(() => {
  ingestion.setImapClientFactoryForTests(undefined);
  vi.clearAllTimers();
  vi.useRealTimers();
});

const runNow = () => (ingestion as unknown as { runImapIngestionNow: () => Promise<{ status: string; result?: Record<string, unknown> }> }).runImapIngestionNow();
const settle = () => vi.advanceTimersByTimeAsync(10);

async function startedWorker() {
  ingestion.startImapIngestionWorker();
  await settle();
  expect(mocks.cycles).toBe(1);
}

describe("one check at a time across fetch now and the timer (#1651 review 1)", () => {
  it("answers already_running, and runs no second cycle, when fetch now is pressed during a worker tick", async () => {
    const open = release();
    ingestion.startImapIngestionWorker();
    await settle();
    expect(mocks.cycles).toBe(1);

    expect(await runNow()).toMatchObject({ status: "already_running" });
    expect(mocks.cycles).toBe(1);
    open();
    await settle();
  });

  it("runs the cycle once, not twice, when the timer fires while fetch now is running", async () => {
    await startedWorker();
    const open = release();
    const pressed = runNow();
    await settle();
    expect(mocks.cycles).toBe(2);

    await vi.advanceTimersByTimeAsync(POLL_MS + 1_000);
    expect(mocks.cycles).toBe(2);

    open();
    expect(await pressed).toMatchObject({ status: "checked" });
    expect(mocks.cycles).toBe(2);
  });

  it("answers already_running to a second press while the first is running", async () => {
    const open = release();
    const first = runNow();
    await settle();
    expect(await runNow()).toMatchObject({ status: "already_running" });
    open();
    await first;
    expect(mocks.cycles).toBe(1);
  });

  it("shows a running check in isImapIngestionCycleRunning while fetch now runs", async () => {
    const open = release();
    const pressed = runNow();
    await settle();
    expect(ingestion.isImapIngestionCycleRunning()).toBe(true);
    open();
    await pressed;
    expect(ingestion.isImapIngestionCycleRunning()).toBe(false);
  });

  it("runs the provider preflight like a tick, and checks nothing when the provider is unavailable", async () => {
    mocks.connect.mockRejectedValue(new Error("connection refused at imap.example.test"));
    const result = await runNow();
    expect(mocks.connect).toHaveBeenCalled();
    expect(result.status).toBe("provider_unavailable");
    expect(mocks.cycles).toBe(0);
    expect(ingestion.getImapIngestionWorkerHealth().lastErrorCode).toBe("provider_unavailable");
  });

  it("answers credential_locked, like a tick, when the stored credential cannot be opened", async () => {
    mocks.credentialLocked = true;
    expect((await runNow()).status).toBe("credential_locked");
    expect(mocks.cycles).toBe(0);
    expect(ingestion.getImapIngestionWorkerHealth().lastErrorCode).toBe("credential_locked");
  });

  it("updates the worker's health the way a tick does: a failed cycle sets lastErrorAt and provider_unavailable", async () => {
    const result = await runNow();
    expect(result.status).toBe("provider_unavailable");
    const health = ingestion.getImapIngestionWorkerHealth();
    expect(health.lastErrorCode).toBe("provider_unavailable");
    expect(health.lastErrorAt).not.toBeNull();
  });
});

describe("the real timer reset (#1651 review 2)", () => {
  it("arms exactly one timer, a full interval away, after a started worker's fetch now", async () => {
    await startedWorker();
    await vi.advanceTimersByTimeAsync(POLL_MS - 20_000);
    await runNow();
    expect(vi.getTimerCount()).toBe(1);
    const before = mocks.cycles;

    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(mocks.cycles).toBe(before);
    await vi.advanceTimersByTimeAsync(2);
    expect(mocks.cycles).toBe(before + 1);
  });

  it("arms exactly one timer, a full interval away, when the worker was never started", async () => {
    await runNow();
    expect(vi.getTimerCount()).toBe(1);
    const before = mocks.cycles;
    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(mocks.cycles).toBe(before);
    await vi.advanceTimersByTimeAsync(2);
    expect(mocks.cycles).toBe(before + 1);
  });

  it("still arms exactly one timer when the cycle throws", async () => {
    await startedWorker();
    const result = await runNow();
    expect(result.status).toBe("provider_unavailable");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does not stack a second timer on repeated presses", async () => {
    await startedWorker();
    await runNow();
    await runNow();
    await runNow();
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe("a cycle that skipped its work says so (#1651 review 3)", () => {
  it("reports notChecked key_unavailable when the key is locked, with zero counts", async () => {
    mocks.locked = true;
    const result = await ingestion.runImapIngestionCycle((await import("../../../tests/support/imap-config")).testImapConfig());
    expect(result).toMatchObject({ messagesRead: 0, receiptsRecorded: 0, notChecked: "key_unavailable" });
  });

  it("reports notChecked dkim_dns_malformed when MAIL_IN_DKIM_DNS_SERVERS is malformed", async () => {
    vi.stubEnv("MAIL_IN_DKIM_DNS_SERVERS", "bad host");
    const result = await ingestion.runImapIngestionCycle((await import("../../../tests/support/imap-config")).testImapConfig());
    expect(result).toMatchObject({ messagesRead: 0, receiptsRecorded: 0, notChecked: "dkim_dns_malformed" });
  });

  it("carries notChecked through fetch now's run-now answer", async () => {
    mocks.locked = true;
    const answer = await runNow();
    expect(answer.status).toBe("checked");
    expect(answer.result).toMatchObject({ notChecked: "key_unavailable" });
  });
});
