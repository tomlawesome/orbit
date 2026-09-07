import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * hooks.server.js's `init` is the boundary SvelteKit calls once per server
 * process before the first request (web/src/hooks.server.js). Its own tests
 * live here rather than under web/ because it is a plain ESM module once
 * `orbit/...` and `$app/environment` are aliased (vitest.config.ts) --
 * web/**'s own suites are Playwright and cannot unit-test a single function
 * in isolation.
 *
 * #717: a `registerNode` rejection used to leave the process running,
 * serving `/` at 200 while every dynamic route answered 500 -- indistinguish
 * -able from a slow boot without `docker compose up --wait`. `init` now
 * exits the process instead, so the container actually stops.
 *
 * #868: the FIRST `import("../../web/src/hooks.server.js")` here pays to
 * transform the whole server hooks graph cold, and Vitest's 5 s default was
 * the only deadline on it. The runner host runs every job of every pipeline
 * at once (#808), so on a busy box that transform lost the race and this
 * file failed for the machine's reasons rather than the code's -- pipeline
 * 531, 2,874 of 2,877 passing, on a change touching neither
 * `hooks.server.js` nor its init path. It passes locally in ~100 ms.
 *
 * Both halves of the fix are below. The graph is transformed once in
 * `beforeAll`, outside any test, so the assertions time `init` and not the
 * compiler: `vi.resetModules()` drops evaluated modules but not Vite's
 * transform cache, so each test still gets the fresh module instance it
 * needs while the expensive work is already done. What remains states its
 * own budget rather than inheriting a default, the same way the pty drivers
 * declare PTY_TEST_TIMEOUT_MS instead of letting Vitest's 5 s speak first.
 */
const COLD_IMPORT_TIMEOUT_MS = 30_000;

const mocks = vi.hoisted(() => ({
  registerNode: vi.fn(),
}));

vi.mock("orbit/server/boot", () => ({ registerNode: mocks.registerNode }));

describe("hooks.server init", () => {
  let exitSpy;

  // Pay the cold transform once, where no assertion is being timed. The
  // module is imported for its compilation only; `init` is never called
  // here, and the registerNode mock has no behaviour until a test gives it
  // one.
  beforeAll(async () => {
    await import("../../web/src/hooks.server.js");
  }, COLD_IMPORT_TIMEOUT_MS);

  beforeEach(() => {
    vi.resetModules();
    mocks.registerNode.mockReset();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("exits the process non-zero when startup configuration is invalid (#717)", async () => {
    mocks.registerNode.mockRejectedValueOnce(new Error("configuration_invalid"));

    const { init } = await import("../../web/src/hooks.server.js");
    await init();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  }, COLD_IMPORT_TIMEOUT_MS);

  it("never exits when startup succeeds", async () => {
    mocks.registerNode.mockResolvedValueOnce(undefined);

    const { init } = await import("../../web/src/hooks.server.js");
    await init();

    expect(exitSpy).not.toHaveBeenCalled();
  }, COLD_IMPORT_TIMEOUT_MS);
});
