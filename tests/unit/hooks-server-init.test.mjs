import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
 */
const mocks = vi.hoisted(() => ({
  registerNode: vi.fn(),
}));

vi.mock("orbit/server/boot", () => ({ registerNode: mocks.registerNode }));

describe("hooks.server init", () => {
  let exitSpy;

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
  });

  it("never exits when startup succeeds", async () => {
    mocks.registerNode.mockResolvedValueOnce(undefined);

    const { init } = await import("../../web/src/hooks.server.js");
    await init();

    expect(exitSpy).not.toHaveBeenCalled();
  });
});
