import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1575: hooks.server.js's `init` starts the start-up warm-up and does not
 * wait for it. Written from the specification alone (issue note 46704), before
 * web/src/lib/server/warm-up.js and the call in `init` exist.
 *
 * warmUp itself takes a host and a port and has no socket input, so the
 * decisions the note gives to `init` are tested here, against a recording
 * stand-in for warmUp:
 *   - skip entirely when PORT is unset or not a number, or SOCKET_PATH is set;
 *   - host is 127.0.0.1 when HOST is unset, 0.0.0.0 or ::, otherwise HOST;
 *   - init does not wait for it, and a rejection from it goes nowhere.
 * The "starts without awaiting" requirement is also checked in the source
 * text, the one place a missing `void` or a stray `await` shows without
 * running the server.
 *
 * Same shape as tests/unit/hooks-server-init.test.mjs, whose cold-import
 * handling it copies (#868).
 */
const COLD_IMPORT_TIMEOUT_MS = 30_000;
const HOOKS_PATH = "../../web/src/hooks.server.js";

const mocks = vi.hoisted(() => ({
  registerNode: vi.fn(),
  warmUp: vi.fn(),
  order: /** @type {string[]} */ ([]),
}));

vi.mock("orbit/server/boot", () => ({ registerNode: mocks.registerNode }));
vi.mock("../../web/src/lib/server/warm-up.js", () => ({ warmUp: mocks.warmUp }));

/** The text of `init`, from its declaration to the closing brace at column 0. */
function initSource() {
  const text = readFileSync(new URL(HOOKS_PATH, import.meta.url), "utf8");
  const start = text.indexOf("export async function init()");
  expect(start, "hooks.server.js declares `export async function init()`").toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n}\n", start);
  expect(end, "init's closing brace").toBeGreaterThan(start);
  return text.slice(start, end + 2);
}

const ENV_KEYS = ["PORT", "HOST", "SOCKET_PATH"];

describe("hooks.server init: start-up warm-up (#1575)", () => {
  /** @type {Record<string, string | undefined>} */
  let savedEnv;
  let exitSpy;

  beforeAll(async () => {
    await import("../../web/src/hooks.server.js");
  }, COLD_IMPORT_TIMEOUT_MS);

  beforeEach(() => {
    vi.resetModules();
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    mocks.order.length = 0;
    mocks.registerNode.mockReset();
    mocks.registerNode.mockImplementation(async () => {
      mocks.order.push("registerNode");
    });
    mocks.warmUp.mockReset();
    mocks.warmUp.mockImplementation(async () => {
      mocks.order.push("warmUp");
    });
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  async function runInit() {
    const { init } = await import("../../web/src/hooks.server.js");
    await init();
    // Let anything init started in the background run its first steps.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** A call counts as a live warm-up only if it carries a real port. */
  const livePort = (port) => Number.isInteger(Number(port)) && Number(port) > 0;
  const liveCalls = () => mocks.warmUp.mock.calls.filter(([options]) => livePort(options?.port));

  describe("what it starts", () => {
    it("starts warmUp with the PORT, once", async () => {
      process.env.PORT = "3456";

      await runInit();

      expect(mocks.warmUp).toHaveBeenCalledTimes(1);
      expect(Number(mocks.warmUp.mock.calls[0][0].port)).toBe(3456);
    });

    it("starts it after registerNode has finished, not before", async () => {
      process.env.PORT = "3456";

      await runInit();

      expect(mocks.order).toEqual(["registerNode", "warmUp"]);
    });

    it("passes the loaders, a fetch and a log for warmUp to use", async () => {
      process.env.PORT = "3456";

      await runInit();

      const options = mocks.warmUp.mock.calls[0][0];
      expect(options.loaders === undefined || Array.isArray(options.loaders)).toBe(true);
      // `fetch` and `log` may be left to warmUp's own defaults; if given, they must be callable.
      if (options.fetch !== undefined) expect(typeof options.fetch).toBe("function");
      if (options.log !== undefined) expect(typeof options.log.debug).toBe("function");
    });
  });

  describe("when it is skipped entirely", () => {
    it("does not start it when PORT is unset", async () => {
      await runInit();

      expect(liveCalls()).toEqual([]);
    });

    for (const bad of ["abc", "", "3000x", "NaN"]) {
      it(`does not start it when PORT is ${JSON.stringify(bad)} (not a number)`, async () => {
        process.env.PORT = bad;

        await runInit();

        expect(liveCalls()).toEqual([]);
      });
    }

    it("does not start it when SOCKET_PATH is set, PORT or not", async () => {
      process.env.PORT = "3456";
      process.env.SOCKET_PATH = "/run/orbit.sock";

      await runInit();

      expect(mocks.warmUp).not.toHaveBeenCalled();
    });

    it("does not start it when SOCKET_PATH is set and PORT is unset", async () => {
      process.env.SOCKET_PATH = "/run/orbit.sock";

      await runInit();

      expect(liveCalls()).toEqual([]);
    });
  });

  describe("which host it dials", () => {
    const cases = [
      ["unset", undefined, "127.0.0.1"],
      ["0.0.0.0", "0.0.0.0", "127.0.0.1"],
      ["::", "::", "127.0.0.1"],
      ["a named address", "192.0.2.7", "192.0.2.7"],
      ["a host name", "orbit.internal.test", "orbit.internal.test"],
    ];
    for (const [label, host, expected] of cases) {
      it(`HOST ${label} -> ${expected}`, async () => {
        process.env.PORT = "3456";
        if (host !== undefined) process.env.HOST = host;

        await runInit();

        expect(mocks.warmUp).toHaveBeenCalledTimes(1);
        expect(mocks.warmUp.mock.calls[0][0].host).toBe(expected);
      });
    }
  });

  describe("start-up does not wait for it", () => {
    it("returns from init while warmUp is still pending", async () => {
      process.env.PORT = "3456";
      mocks.warmUp.mockImplementation(() => new Promise(() => {}));

      const { init } = await import("../../web/src/hooks.server.js");
      const outcome = await Promise.race([
        init().then(() => "returned"),
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 2_000)),
      ]);

      expect(outcome).toBe("returned");
      expect(mocks.warmUp).toHaveBeenCalledTimes(1);
    });

    it("does not reject, and leaves nothing unhandled, when warmUp rejects", async () => {
      process.env.PORT = "3456";
      mocks.warmUp.mockImplementation(() => Promise.reject(new Error("warm-up blew up")));
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        const { init } = await import("../../web/src/hooks.server.js");
        await expect(init()).resolves.toBeUndefined();
        await new Promise((resolve) => setTimeout(resolve, 20));
      } finally {
        process.off("unhandledRejection", unhandled);
      }

      expect(unhandled).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });
});

describe("hooks.server.js init, source text: warmUp is started, not awaited (#1575)", () => {
  it("mentions warm-up.js and calls warmUp inside init", () => {
    const text = readFileSync(new URL(HOOKS_PATH, import.meta.url), "utf8");
    expect(text).toMatch(/lib\/server\/warm-up\.js/);
    expect(initSource()).toMatch(/\bwarmUp\s*\(/);
  });

  it("starts it with `void`, and ends the chain in a catch so nothing is unhandled", () => {
    const init = initSource();
    const call = init.match(/\bvoid\b[^;]*\bwarmUp\s*\([\s\S]*?;/);
    expect(call, "`void ... warmUp(...)` in init").not.toBeNull();
    expect(call[0]).toMatch(/\.catch\s*\(/);
  });

  it("never awaits it, nor returns it", () => {
    const init = initSource();
    expect(init).not.toMatch(/\bawait\s+warmUp\b/);
    expect(init).not.toMatch(/\bawait\s+[^;\n]*\bwarmUp\s*\(/);
    expect(init).not.toMatch(/\breturn\s+[^;\n]*\bwarmUp\s*\(/);
    expect(init).not.toMatch(/\bawait\s+import\s*\(\s*["'][^"']*warm-up[^"']*["']\s*\)\s*\)?\s*\.warmUp\s*\(/);
    expect(init).not.toMatch(/\bawait\s+Promise\.(all|race|allSettled)\s*\([^)]*warmUp/);
  });

  it("starts it after registerNode and keeps the `building` guard ahead of it", () => {
    const init = initSource();
    const guard = init.indexOf("if (building) return;");
    const boot = init.indexOf("await registerNode()");
    const warm = init.search(/\bwarmUp\s*\(/);
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(boot).toBeGreaterThan(guard);
    expect(warm).toBeGreaterThan(boot);
  });

  it("hands warmUp the route modules by import.meta.glob of the four route file kinds", () => {
    const text = readFileSync(new URL(HOOKS_PATH, import.meta.url), "utf8");
    expect(text).toMatch(/import\.meta\.glob\s*\(/);
    for (const pattern of [
      "/src/routes/**/+page.server.js",
      "/src/routes/**/+layout.server.js",
      "/src/routes/**/+page.svelte",
      "/src/routes/**/+layout.svelte",
    ]) {
      expect(text, pattern).toContain(pattern);
    }
  });
});
