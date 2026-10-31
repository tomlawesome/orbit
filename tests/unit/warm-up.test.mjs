import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1575: the start-up warm-up, from issue note 46704. Seam assumed:
 *   warmUp({ port, host, loaders, fetch, log }) -> promise that never rejects.
 *   loaders is an array of functions; a loader that throws is logged at debug.
 * Host choice and the SOCKET_PATH skip are init()'s, tested in
 * hooks-server-warm-up.test.mjs. Fake fetch, loaders and timers throughout.
 */
const COLD_IMPORT_TIMEOUT_MS = 30_000;
const PATHS = ["/__data.json", "/", "/api/auth/session"];

/** @type {typeof import("../../web/src/lib/server/warm-up.js")} */
let warmModule;
beforeAll(async () => {
  warmModule = await import("../../web/src/lib/server/warm-up.js");
}, COLD_IMPORT_TIMEOUT_MS);

const advance = (ms) => vi.advanceTimersByTimeAsync(ms);
const ok = () => new Response("ok");
const refuse = () => Promise.reject(new TypeError("fetch failed"));

function deferred() {
  let resolve = () => {};
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** `behave(path, probeCount)` answers each request; every call is recorded with the fake clock's time. */
function fakeFetch(behave = ok) {
  const calls = [];
  const fn = vi.fn((url, init) => {
    const u = new URL(String(url));
    calls.push({ url: u, path: u.pathname, init, at: Date.now() });
    return behave(u.pathname, calls.filter((c) => c.path === "/api/health").length);
  });
  return Object.assign(fn, {
    calls,
    health: () => calls.filter((c) => c.path === "/api/health"),
    warm: () => calls.filter((c) => PATHS.includes(c.path)).map((c) => c.path),
  });
}

/** Starts the task; `run.state.done` and `.rejected` say how it ended. */
function start({ fetch = fakeFetch(), loaders = [], ...rest } = {}) {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const state = { done: false, rejected: false };
  warmModule
    .warmUp({ port: 4321, host: "127.0.0.1", loaders, fetch, log, ...rest })
    .then(
      () => (state.done = true),
      () => ((state.done = true), (state.rejected = true)),
    );
  return { state, fetch, log };
}

describe("warmUp (#1575)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("skips without a port: nothing is fetched or loaded", async () => {
    const loader = vi.fn(async () => ({}));
    const run = start({ port: undefined, loaders: [loader] });

    await advance(21_000);

    expect(run.state).toEqual({ done: true, rejected: false });
    expect(run.fetch).not.toHaveBeenCalled();
    expect(loader).not.toHaveBeenCalled();
  });

  it("polls /api/health every 50 ms, with an abort signal, until any answer, a 503 included", async () => {
    const loader = vi.fn(async () => ({}));
    const fetch = fakeFetch((path, probes) => (probes <= 3 ? refuse() : new Response("x", { status: 503 })));
    start({ fetch, loaders: [loader] });

    await advance(120);
    expect(loader).not.toHaveBeenCalled();
    await advance(2_000);

    const probes = fetch.health();
    expect(probes).toHaveLength(4);
    expect(probes[0].url.origin).toBe("http://127.0.0.1:4321");
    expect(probes[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(probes.slice(1).map((c, i) => c.at - probes[i].at)).toEqual([50, 50, 50]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("gives up silently after 15 s: no loader, no warm request, no more probes", async () => {
    const loader = vi.fn(async () => ({}));
    const run = start({ fetch: fakeFetch(refuse), loaders: [loader] });

    await advance(14_000);
    expect(run.state.done).toBe(false);
    await advance(1_200);
    expect(run.state).toEqual({ done: true, rejected: false });

    const probes = run.fetch.health().length;
    await advance(10_000);
    expect(run.fetch.health()).toHaveLength(probes);
    expect(loader).not.toHaveBeenCalled();
    expect(run.fetch.warm()).toEqual([]);
    expect(run.log.warn).not.toHaveBeenCalled();
    expect(run.log.error).not.toHaveBeenCalled();
  });

  it("calls every loader, in order, one at a time, before the first warm request", async () => {
    const gates = [deferred(), deferred(), deferred()];
    const called = [];
    const loaders = gates.map((gate, i) => () => (called.push(i), gate.promise));
    const run = start({ loaders });

    for (const [i, gate] of gates.entries()) {
      await advance(100);
      expect(called).toEqual([0, 1, 2].slice(0, i + 1));
      expect(run.fetch.warm()).toEqual([]);
      gate.resolve({});
    }
    await advance(100);
    expect(run.fetch.warm()).toEqual(PATHS);
  });

  it("then requests /__data.json, / and /api/auth/session in turn, as orbit-warm-up with no cookie", async () => {
    const gates = Object.fromEntries(PATHS.map((p) => [p, deferred()]));
    const fetch = fakeFetch((path) => gates[path]?.promise ?? ok());
    start({ fetch });

    for (const [i, path] of PATHS.entries()) {
      await advance(100);
      expect(fetch.warm()).toEqual(PATHS.slice(0, i + 1));
      gates[path].resolve(new Response("{}", { status: i === 2 ? 401 : 200 }));
    }
    await advance(100);

    expect(fetch.calls.filter((c) => PATHS.includes(c.path))).toHaveLength(3);
    for (const call of fetch.calls.filter((c) => PATHS.includes(c.path))) {
      const headers = new Headers(call.init.headers);
      expect(call.url.origin).toBe("http://127.0.0.1:4321");
      expect(call.init.method ?? "GET").toBe("GET");
      expect(headers.get("user-agent")).toBe("orbit-warm-up");
      expect(headers.has("cookie")).toBe(false);
    }
  });

  it("a loader that rejects or throws stops nothing, is logged at debug, and does not reject", async () => {
    const after = vi.fn(async () => ({}));
    const loaders = [
      async () => Promise.reject(new Error("chunk")),
      () => {
        throw new Error("sync");
      },
      after,
    ];
    const run = start({ loaders });

    await advance(500);

    expect(after).toHaveBeenCalledTimes(1);
    expect(run.log.debug).toHaveBeenCalled();
    expect(run.fetch.warm()).toEqual(PATHS);
    expect(run.state).toEqual({ done: true, rejected: false });
  });

  it("a fetch that rejects or throws stops nothing and does not reject", async () => {
    let n = 0;
    const fetch = fakeFetch((path) => {
      if (path === "/__data.json") return refuse();
      if (path === "/" && ++n) throw new Error("sync");
      return ok();
    });
    const run = start({ fetch });

    await advance(500);

    expect(fetch.warm()).toEqual(PATHS);
    expect(run.state).toEqual({ done: true, rejected: false });
  });

  it("stops at 20 s: a request that never answers ends the task and nothing follows it", async () => {
    const fetch = fakeFetch((path) => (path === "/" ? new Promise(() => {}) : ok()));
    const run = start({ fetch });

    await advance(19_000);
    expect(run.state.done).toBe(false);
    await advance(1_200);

    expect(run.state).toEqual({ done: true, rejected: false });
    expect(fetch.warm()).toEqual(["/__data.json", "/"]);
  });

  it("stops at 20 s counted from the start, and a loader that answers late sends nothing", async () => {
    const gate = deferred();
    const run = start({ fetch: fakeFetch((path, probes) => (probes <= 200 ? refuse() : ok())), loaders: [() => gate.promise] });

    await advance(19_000);
    expect(run.state.done).toBe(false);
    await advance(1_200);
    expect(run.state.done).toBe(true);

    gate.resolve({});
    await advance(1_000);
    expect(run.fetch.warm()).toEqual([]);
  });
});
