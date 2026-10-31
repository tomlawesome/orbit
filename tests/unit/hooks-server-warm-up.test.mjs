import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1575: hooks.server.js's init() starts the warm-up and does not wait for it.
 * warmUp takes a host and a port and has no socket input, so the note's
 * decisions that belong to init() are tested here against a recording
 * stand-in: the PORT and SOCKET_PATH skips, and the host. Same cold-import
 * handling as hooks-server-init.test.mjs (#868).
 */
const COLD_IMPORT_TIMEOUT_MS = 30_000;
const HOOKS = "../../web/src/hooks.server.js";

const mocks = vi.hoisted(() => ({ registerNode: vi.fn(), warmUp: vi.fn(), order: /** @type {string[]} */ ([]) }));
vi.mock("orbit/server/boot", () => ({ registerNode: mocks.registerNode }));
vi.mock("../../web/src/lib/server/warm-up.js", () => ({ warmUp: mocks.warmUp }));

const hooksText = () => readFileSync(new URL(HOOKS, import.meta.url), "utf8");
const KEYS = ["PORT", "HOST", "SOCKET_PATH"];

describe("hooks.server init: warm-up (#1575)", () => {
  let saved;
  let exitSpy;

  beforeAll(async () => {
    await import("../../web/src/hooks.server.js");
  }, COLD_IMPORT_TIMEOUT_MS);

  beforeEach(() => {
    vi.resetModules();
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    mocks.order.length = 0;
    mocks.registerNode.mockReset().mockImplementation(async () => void mocks.order.push("registerNode"));
    mocks.warmUp.mockReset().mockImplementation(async () => void mocks.order.push("warmUp"));
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  });

  async function runInit(env = {}) {
    Object.assign(process.env, env);
    const { init } = await import("../../web/src/hooks.server.js");
    await init();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const options = () => mocks.warmUp.mock.calls[0]?.[0];

  it("starts warmUp once, after registerNode, with the port and the route loaders", async () => {
    await runInit({ PORT: "3456" });

    expect(mocks.order).toEqual(["registerNode", "warmUp"]);
    expect(mocks.warmUp).toHaveBeenCalledTimes(1);
    expect(Number(options().port)).toBe(3456);
    expect(options().loaders === undefined || Array.isArray(options().loaders)).toBe(true);
  });

  it.each([
    [undefined, "127.0.0.1"],
    ["0.0.0.0", "127.0.0.1"],
    ["::", "127.0.0.1"],
    ["192.0.2.7", "192.0.2.7"],
  ])("HOST %s is dialled as %s", async (host, expected) => {
    await runInit({ PORT: "3456", ...(host && { HOST: host }) });

    expect(options().host).toBe(expected);
  });

  it.each([
    ["PORT unset", {}],
    ["PORT not a number", { PORT: "abc" }],
    ["SOCKET_PATH set", { PORT: "3456", SOCKET_PATH: "/run/orbit.sock" }],
  ])("skips it entirely: %s", async (_label, env) => {
    await runInit(env);

    const live = mocks.warmUp.mock.calls.filter(([o]) => Number(o?.port) > 0);
    expect(live).toEqual([]);
  });

  it("does not wait for it: init returns while warmUp is pending, and a rejection goes nowhere", async () => {
    mocks.warmUp.mockImplementation(() => new Promise(() => {}));
    const { init } = await import("../../web/src/hooks.server.js");
    process.env.PORT = "3456";
    const outcome = await Promise.race([init().then(() => "returned"), new Promise((r) => setTimeout(() => r("waiting"), 2_000))]);
    expect(outcome).toBe("returned");

    mocks.warmUp.mockImplementation(() => Promise.reject(new Error("boom")));
    await expect(init()).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  describe("source text", () => {
    const initSource = () => {
      const text = hooksText();
      const start = text.indexOf("export async function init()");
      return text.slice(start, text.indexOf("\n}\n", start) + 2);
    };

    it("starts warmUp with void and a catch, never awaits or returns it, after the building guard and registerNode", () => {
      const init = initSource();
      const call = init.match(/\bvoid\b[^;]*\bwarmUp\s*\([\s\S]*?;/);
      expect(call?.[0]).toMatch(/\.catch\s*\(/);
      expect(init).not.toMatch(/\b(await|return)\s+[^;\n]*\bwarmUp\b/);
      expect(init.indexOf("if (building) return;")).toBeLessThan(init.indexOf("await registerNode()"));
      expect(init.indexOf("await registerNode()")).toBeLessThan(init.search(/\bwarmUp\s*\(/));
    });

    it("gives it the route modules by import.meta.glob of the four route file kinds", () => {
      expect(hooksText()).toMatch(/import\.meta\.glob\s*\(/);
      for (const kind of ["+page.server.js", "+layout.server.js", "+page.svelte", "+layout.svelte"]) {
        expect(hooksText()).toContain(`/src/routes/**/${kind}`);
      }
    });
  });
});
