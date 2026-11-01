import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1583: the app was killed after Docker's 10 s grace period on every stop.
 * adapter-node catches SIGTERM, closes the listener, drains, and emits
 * `sveltekit:shutdown` on `process` -- but never exits, and nothing closed
 * the Postgres pool, whose open sockets kept the event loop alive. The
 * standard graceful shutdown is: stop accepting, drain, close the pool, exit.
 * adapter-node does the first two; `init` (web/src/hooks.server.js) is where
 * the listener for the rest is expected to be registered, once per process.
 *
 * Same setup as hooks-server-init.test.mjs, including the one cold transform
 * in `beforeAll` (#868). The process-level signal itself is not sent: that
 * needs a built server and a real PostgreSQL, which belong to the compose
 * acceptance runs, not a unit file. The event adapter-node emits is.
 */
const COLD_IMPORT_TIMEOUT_MS = 30_000;
const SHUTDOWN_EVENT = "sveltekit:shutdown";

const mocks = vi.hoisted(() => ({
  registerNode: vi.fn(),
  closeDatabase: vi.fn(),
  shutDownDatabase: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("orbit/server/boot", () => ({ registerNode: mocks.registerNode }));
vi.mock("orbit/server/about", () => ({ warmAboutFacts: vi.fn() }));
vi.mock("orbit/db", () => ({
  closeDatabase: mocks.closeDatabase,
  shutDownDatabase: mocks.shutDownDatabase,
}));
vi.mock("orbit/lib/logger", () => ({ log: mocks.log }));

/** Every record any log level received, in call order. */
function loggedRecords() {
  return Object.values(mocks.log).flatMap((fn) => fn.mock.calls.map(([record]) => record));
}

describe("hooks.server shutdown", () => {
  let exitSpy;
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);

  beforeAll(async () => {
    await import("../../web/src/hooks.server.js");
  }, COLD_IMPORT_TIMEOUT_MS);

  beforeEach(async () => {
    vi.resetModules();
    process.removeAllListeners(SHUTDOWN_EVENT);
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
    mocks.registerNode.mockReset().mockResolvedValue(undefined);
    mocks.closeDatabase.mockReset().mockResolvedValue(undefined);
    mocks.shutDownDatabase.mockReset().mockResolvedValue(undefined);
    for (const fn of Object.values(mocks.log)) fn.mockReset();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined);

    const { init } = await import("../../web/src/hooks.server.js");
    await init();
  }, COLD_IMPORT_TIMEOUT_MS);

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    process.removeAllListeners(SHUTDOWN_EVENT);
    exitSpy.mockRestore();
  });

  it("closes the database pool, once, when adapter-node emits sveltekit:shutdown", async () => {
    process.emit(SHUTDOWN_EVENT);

    await vi.waitFor(() => expect(mocks.shutDownDatabase).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.shutDownDatabase).toHaveBeenCalledTimes(1);
  });

  it("triggers the terminal close, not the reopenable one, on sveltekit:shutdown", async () => {
    process.emit(SHUTDOWN_EVENT);

    await vi.waitFor(() => expect(mocks.shutDownDatabase).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.shutDownDatabase).toHaveBeenCalledTimes(1);
    expect(mocks.closeDatabase).not.toHaveBeenCalled();
  });

  it("does not close the pool before the shutdown event", () => {
    expect(mocks.shutDownDatabase).not.toHaveBeenCalled();
  });

  it("logs a shutdown line in the operational protocol", async () => {
    process.emit(SHUTDOWN_EVENT);

    await vi.waitFor(() => expect(mocks.shutDownDatabase).toHaveBeenCalled());
    expect(loggedRecords()).toContainEqual(
      expect.objectContaining({ event: "shutdown.signal", state: "stopping" }),
    );
  });

  it("logs a failure to close the pool and does not throw out of the listener", async () => {
    mocks.shutDownDatabase.mockRejectedValueOnce(new Error("secret-host-detail refused"));

    expect(() => process.emit(SHUTDOWN_EVENT)).not.toThrow();

    await vi.waitFor(() =>
      expect(
        [...mocks.log.warn.mock.calls, ...mocks.log.error.mock.calls].map(([record]) => record),
      ).toContainEqual(expect.objectContaining({ event: "database.connection" })),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
    // The record names the failure by code; the error's own text stays out.
    expect(JSON.stringify(loggedRecords())).not.toContain("secret-host-detail");
  });

  it("registers the listener once even if init runs twice", async () => {
    expect(process.listenerCount(SHUTDOWN_EVENT)).toBe(1);

    const { init } = await import("../../web/src/hooks.server.js");
    await init();
    expect(process.listenerCount(SHUTDOWN_EVENT)).toBe(1);

    process.emit(SHUTDOWN_EVENT);
    await vi.waitFor(() => expect(mocks.shutDownDatabase).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.shutDownDatabase).toHaveBeenCalledTimes(1);
  });

  it("registers no listener when startup fails and the process is exiting", async () => {
    process.removeAllListeners(SHUTDOWN_EVENT);
    vi.resetModules();
    mocks.registerNode.mockRejectedValueOnce(new Error("configuration_invalid"));

    const { init } = await import("../../web/src/hooks.server.js");
    await init();

    expect(exitSpy).toHaveBeenCalledWith(1);
    process.emit(SHUTDOWN_EVENT);
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.shutDownDatabase).not.toHaveBeenCalled();
  });
});
