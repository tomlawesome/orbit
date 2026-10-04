import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The manual `pnpm db:migrate` entry point (#1151 A4-S1, A4-Q2), against
 * mocked dependencies.
 *
 * This file calls `main()` itself, at import time (`void main()`), exactly
 * as the real CLI does -- there is nothing exported to call instead. A
 * failure therefore surfaces as an unhandled rejection on the module's own
 * promise, which this suite catches with a one-shot listener rather than
 * letting it crash the test process, the same shape the real `node`/`tsx`
 * process failing on an unhandled rejection has.
 */

const mocks = vi.hoisted(() => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  getDb: vi.fn(() => "the-db" as unknown),
  getDatabaseClient: vi.fn(() => ({ unsafe: vi.fn() })),
  closeDatabase: vi.fn(async () => {}),
  migrate: vi.fn(async () => {}),
  resolveMigrationsFolder: vi.fn(() => "drizzle"),
  describeMigrationFailureDetail: vi.fn(async () => "migration failed, sqlstate unknown"),
}));

vi.mock("@/lib/logger", () => ({ log: mocks.log }));
vi.mock("@/db", () => ({
  getDb: mocks.getDb,
  getDatabaseClient: mocks.getDatabaseClient,
  closeDatabase: mocks.closeDatabase,
}));
vi.mock("drizzle-orm/postgres-js/migrator", () => ({ migrate: mocks.migrate }));
vi.mock("@/server/boot", () => ({
  resolveMigrationsFolder: mocks.resolveMigrationsFolder,
  describeMigrationFailureDetail: mocks.describeMigrationFailureDetail,
}));

/** Waits out the microtask queue so `void main()`'s own promise settles,
 *  then a macrotask turn -- Node only raises `unhandledRejection` after a
 *  rejection has gone unhandled across a full turn of the event loop, not
 *  merely across the microtask queue. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.getDb.mockReturnValue("the-db" as unknown as never);
  mocks.resolveMigrationsFolder.mockReturnValue("drizzle");
});

describe("the manual migration command", () => {
  it("migrates with the shared resolver's folder and closes the database on success", async () => {
    await import("@/db/migrate");
    await flush();

    expect(mocks.resolveMigrationsFolder).toHaveBeenCalledTimes(1);
    expect(mocks.migrate).toHaveBeenCalledWith("the-db", { migrationsFolder: "drizzle" });
    expect(mocks.log.info).toHaveBeenCalledWith({ event: "database.migration", state: "ready", action: "none" });
    expect(mocks.closeDatabase).toHaveBeenCalledTimes(1);
    expect(mocks.describeMigrationFailureDetail).not.toHaveBeenCalled();
  });

  it("names the failure through boot's own shared detail helper, closes the database, and still rejects (#1151 A4-S1)", async () => {
    const failure = new Error("private connection string detail");
    mocks.migrate.mockRejectedValueOnce(failure);

    let caught: unknown;
    const onRejection = (reason: unknown) => { caught = reason; };
    process.once("unhandledRejection", onRejection);
    try {
      await import("@/db/migrate");
      await flush();
    } finally {
      process.removeListener("unhandledRejection", onRejection);
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("migration_failed");
    // The helper is handed the real error to work from -- and it, not this
    // file, is what is responsible for never putting the raw message in the
    // log (boot.test.ts pins that half).
    expect(mocks.describeMigrationFailureDetail).toHaveBeenCalledWith(
      mocks.getDatabaseClient.mock.results[0]?.value,
      "drizzle",
      failure,
    );
    expect(mocks.log.error).toHaveBeenCalledWith({
      event: "database.migration",
      state: "exhausted",
      reason: "migration_failed",
      action: "check_migrations",
      impact: "migration_blocked",
      detail: "migration failed, sqlstate unknown",
    });
    expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain("private connection string detail");
    expect(mocks.closeDatabase).toHaveBeenCalledTimes(1);
  });
});
