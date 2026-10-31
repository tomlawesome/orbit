import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1575: the start-up warm-up. After the server listens, `init()` starts one
 * task that it does not wait for: wait for the port, load every route module,
 * then send the server three requests of its own so the first reader after a
 * restart does not pay for the once-per-process work. Readiness never waits
 * for it.
 *
 * Written from the specification alone (issue note 46704), before
 * web/src/lib/server/warm-up.js exists. Seam assumed:
 *
 *   warmUp({ port, host, loaders, fetch, log })
 *     port     the listening port as a number; absent or not a number skips the
 *              whole task (nothing is called);
 *     host     the address to dial, already chosen by the caller;
 *     loaders  an ARRAY of functions, each returning (a promise of) a module;
 *     fetch    fetch(url, init), url a string or URL, init.headers a plain
 *              object or a Headers;
 *     log      an object with debug/info/warn/error methods; a loader that
 *              throws is reported at debug level.
 *   It returns a promise that never rejects and is not waited on by the caller.
 *
 * Host selection (HOST unset, 0.0.0.0 or :: -> 127.0.0.1, else HOST) and the
 * SOCKET_PATH skip are the CALLER's decisions, since warmUp takes a host and
 * has no socket input; they are tested in tests/unit/hooks-server-warm-up.test.mjs.
 *
 * Fake fetch, fake loaders and fake timers throughout: no socket is opened and
 * no test waits on a clock.
 */
const COLD_IMPORT_TIMEOUT_MS = 30_000;

const HOST = "127.0.0.1";
const PORT = 4321;
const POLL_MS = 50;
const GIVE_UP_MS = 15_000;
const DEADLINE_MS = 20_000;
const WARM_PATHS = ["/__data.json", "/", "/api/auth/session"];

/** @type {typeof import("../../web/src/lib/server/warm-up.js")} */
let warmModule;
beforeAll(async () => {
  warmModule = await import("../../web/src/lib/server/warm-up.js");
}, COLD_IMPORT_TIMEOUT_MS);

function pathOf(url) {
  return new URL(String(url)).pathname;
}

function headersOf(init) {
  return new Headers(init?.headers ?? {});
}

function fakeLog() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A promise a test settles by hand. */
function deferred() {
  /** @type {(value?: unknown) => void} */
  let resolve = () => {};
  /** @type {(reason?: unknown) => void} */
  let reject = () => {};
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A fake fetch that records every call, in order, with the fake clock's time.
 * `behave(path, calls)` answers one request; the default answers 200 for
 * everything. Throwing or rejecting there is "nothing is listening" or a failed
 * request, as the test needs.
 */
function fakeFetch(behave = () => new Response("ok", { status: 200 })) {
  /** @type {Array<{ url: string, path: string, init: any, at: number }>} */
  const calls = [];
  const fn = vi.fn((url, init) => {
    const call = { url: String(url), path: pathOf(url), init, at: Date.now() };
    calls.push(call);
    return behave(call.path, calls, call);
  });
  return Object.assign(fn, { calls });
}

const healthOf = (fetch) => fetch.calls.filter((c) => c.path === "/api/health");
const warmOf = (fetch) => fetch.calls.filter((c) => WARM_PATHS.includes(c.path));

/**
 * Starts the task and tracks how it ends. Advance the fake clock with
 * `advance`; `state` says whether it has settled and how.
 */
function start(options = {}) {
  const log = options.log ?? fakeLog();
  const fetch = options.fetch ?? fakeFetch();
  const loaders = options.loaders ?? [];
  const state = { settled: false, rejected: false, error: undefined };
  const promise = warmModule.warmUp({
    port: PORT,
    host: HOST,
    ...options,
    loaders,
    fetch,
    log,
  });
  promise.then(
    () => {
      state.settled = true;
    },
    (error) => {
      state.settled = true;
      state.rejected = true;
      state.error = error;
    },
  );
  return { state, fetch, log, loaders, promise };
}

const advance = (ms) => vi.advanceTimersByTimeAsync(ms);

/** Lets every already-settled promise run its continuation, without moving the clock far. */
async function tick() {
  await advance(0);
  for (let i = 0; i < 25; i++) await Promise.resolve();
}

/** Answers refused until `n` health probes have been made, then `answer`. */
function refusedThen(n, answer = () => new Response("ok", { status: 200 })) {
  return (path, calls) => {
    if (path === "/api/health") {
      const probes = calls.filter((c) => c.path === "/api/health").length;
      if (probes <= n) return Promise.reject(new TypeError("fetch failed: ECONNREFUSED"));
    }
    return answer(path);
  };
}

describe("warmUp: start-up warm-up (#1575)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("skips without a port", () => {
    for (const [label, port] of [
      ["undefined", undefined],
      ["null", null],
      ["NaN (PORT was not a number)", Number.NaN],
    ]) {
      it(`does nothing when the port is ${label}`, async () => {
        const loader = vi.fn(async () => ({}));
        const run = start({ port, loaders: [loader] });

        await advance(DEADLINE_MS + 1_000);

        expect(run.state.settled).toBe(true);
        expect(run.state.rejected).toBe(false);
        expect(run.fetch).not.toHaveBeenCalled();
        expect(loader).not.toHaveBeenCalled();
      });
    }
  });

  describe("waits for the port", () => {
    it("probes GET /api/health on the given host and port", async () => {
      const run = start();
      await tick();

      const [first] = healthOf(run.fetch);
      expect(first).toBeDefined();
      expect(new URL(first.url).hostname).toBe(HOST);
      expect(new URL(first.url).port).toBe(String(PORT));
      expect(new URL(first.url).protocol).toBe("http:");
      expect(first.init?.method ?? "GET").toBe("GET");
    });

    it("gives each probe a 1 s abort signal", async () => {
      const run = start();
      await tick();

      const [first] = healthOf(run.fetch);
      expect(first.init?.signal).toBeInstanceOf(AbortSignal);
    });

    it("probes every 50 ms while nothing answers", async () => {
      const run = start({ fetch: fakeFetch(refusedThen(Infinity)) });

      await advance(1_000);

      const probes = healthOf(run.fetch);
      // One at 0 and then every 50 ms, or the first after 50 ms: 20 or 21 in a second.
      expect(probes.length).toBeGreaterThanOrEqual(20);
      expect(probes.length).toBeLessThanOrEqual(21);
      for (let i = 1; i < probes.length; i++) {
        expect(probes[i].at - probes[i - 1].at).toBe(POLL_MS);
      }
      expect(run.state.settled).toBe(false);
    });

    it("treats a probe that throws synchronously, or is aborted, as not listening yet", async () => {
      let n = 0;
      const fetch = fakeFetch((path) => {
        if (path === "/api/health") {
          n += 1;
          if (n === 1) throw new TypeError("sync failure");
          if (n === 2) return Promise.reject(new DOMException("timed out", "TimeoutError"));
        }
        return new Response("ok");
      });
      const loader = vi.fn(async () => ({}));
      const run = start({ fetch, loaders: [loader] });

      await advance(500);

      expect(run.state.rejected).toBe(false);
      expect(healthOf(fetch).length).toBe(3);
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it("loads and requests nothing while the port is still refusing", async () => {
      const loader = vi.fn(async () => ({}));
      const run = start({ fetch: fakeFetch(refusedThen(Infinity)), loaders: [loader] });

      await advance(2_000);

      expect(loader).not.toHaveBeenCalled();
      expect(warmOf(run.fetch)).toEqual([]);
    });

    it("stops probing at the first answer, and carries on to the loaders", async () => {
      const loader = vi.fn(async () => ({}));
      const run = start({ fetch: fakeFetch(refusedThen(3)), loaders: [loader] });

      await advance(2_000);

      expect(healthOf(run.fetch).length).toBe(4);
      expect(loader).toHaveBeenCalledTimes(1);
      expect(run.state.settled).toBe(true);
    });

    for (const status of [200, 404, 500, 503]) {
      it(`counts a ${status} as the server listening`, async () => {
        const loader = vi.fn(async () => ({}));
        const fetch = fakeFetch((path) =>
          path === "/api/health" ? new Response("x", { status }) : new Response("ok"),
        );
        const run = start({ fetch, loaders: [loader] });

        await advance(500);

        expect(healthOf(fetch).length).toBe(1);
        expect(loader).toHaveBeenCalledTimes(1);
        expect(warmOf(fetch).map((c) => c.path)).toEqual(WARM_PATHS);
        expect(run.state.rejected).toBe(false);
      });
    }

    it("gives up silently after 15 s: no loader, no warm request, no rejection", async () => {
      const loader = vi.fn(async () => ({}));
      const run = start({ fetch: fakeFetch(refusedThen(Infinity)), loaders: [loader] });

      await advance(GIVE_UP_MS - 1_000);
      expect(run.state.settled).toBe(false);
      expect(healthOf(run.fetch).length).toBeGreaterThan(200);

      await advance(1_000 + POLL_MS * 2);
      expect(run.state.settled).toBe(true);
      expect(run.state.rejected).toBe(false);

      const probesAtGiveUp = healthOf(run.fetch).length;
      await advance(10_000);
      expect(healthOf(run.fetch).length).toBe(probesAtGiveUp);
      expect(loader).not.toHaveBeenCalled();
      expect(warmOf(run.fetch)).toEqual([]);
      expect(run.log.warn).not.toHaveBeenCalled();
      expect(run.log.error).not.toHaveBeenCalled();
    });
  });

  describe("loaders", () => {
    it("calls every loader, in order, one after the other", async () => {
      const gates = [deferred(), deferred(), deferred()];
      const called = [];
      const loaders = gates.map((gate, i) =>
        vi.fn(() => {
          called.push(i);
          return gate.promise;
        }),
      );
      const run = start({ loaders });

      await tick();
      expect(called).toEqual([0]);

      gates[0].resolve({});
      await tick();
      expect(called).toEqual([0, 1]);

      gates[1].resolve({});
      await tick();
      expect(called).toEqual([0, 1, 2]);

      expect(warmOf(run.fetch)).toEqual([]);
      gates[2].resolve({});
      await tick();
      expect(warmOf(run.fetch).length).toBeGreaterThan(0);
    });

    it("calls each loader exactly once, with no required arguments", async () => {
      const loaders = [vi.fn(async () => ({})), vi.fn(async () => ({})), vi.fn(async () => ({}))];
      start({ loaders });

      await advance(500);

      for (const loader of loaders) expect(loader).toHaveBeenCalledTimes(1);
    });

    it("finishes with no loaders at all", async () => {
      const run = start({ loaders: [] });

      await advance(500);

      expect(run.state.settled).toBe(true);
      expect(warmOf(run.fetch).map((c) => c.path)).toEqual(WARM_PATHS);
    });

    it("goes on after a loader that rejects, logging it at debug level", async () => {
      const after = vi.fn(async () => ({}));
      const loaders = [
        vi.fn(async () => {
          throw new Error("chunk failed to load");
        }),
        after,
      ];
      const run = start({ loaders });

      await advance(500);

      expect(after).toHaveBeenCalledTimes(1);
      expect(run.state.rejected).toBe(false);
      expect(run.log.debug).toHaveBeenCalled();
      expect(run.log.warn).not.toHaveBeenCalled();
      expect(run.log.error).not.toHaveBeenCalled();
      expect(warmOf(run.fetch).map((c) => c.path)).toEqual(WARM_PATHS);
    });

    it("goes on after a loader that throws synchronously", async () => {
      const after = vi.fn(async () => ({}));
      const loaders = [
        vi.fn(() => {
          throw new Error("sync boom");
        }),
        after,
      ];
      const run = start({ loaders });

      await advance(500);

      expect(after).toHaveBeenCalledTimes(1);
      expect(run.state.rejected).toBe(false);
      expect(run.log.debug).toHaveBeenCalled();
      expect(warmOf(run.fetch).map((c) => c.path)).toEqual(WARM_PATHS);
    });

    it("survives every loader failing", async () => {
      const loaders = [
        vi.fn(async () => Promise.reject(new Error("a"))),
        vi.fn(() => {
          throw new Error("b");
        }),
        vi.fn(async () => Promise.reject("not even an Error")),
      ];
      const run = start({ loaders });

      await advance(500);

      for (const loader of loaders) expect(loader).toHaveBeenCalledTimes(1);
      expect(run.state.settled).toBe(true);
      expect(run.state.rejected).toBe(false);
      expect(warmOf(run.fetch).map((c) => c.path)).toEqual(WARM_PATHS);
    });
  });

  describe("the three requests", () => {
    it("asks for /__data.json, /, then /api/auth/session, after every loader", async () => {
      const events = [];
      const loaders = [0, 1].map((i) =>
        vi.fn(async () => {
          events.push(`loader:${i}`);
          return {};
        }),
      );
      const fetch = fakeFetch((path) => {
        events.push(path);
        return new Response("ok");
      });
      const run = start({ fetch, loaders });

      await advance(500);

      expect(events).toEqual([
        "/api/health",
        "loader:0",
        "loader:1",
        "/__data.json",
        "/",
        "/api/auth/session",
      ]);
      expect(run.state.settled).toBe(true);
    });

    it("sends each to the given host and port with GET", async () => {
      const run = start();

      await advance(500);

      for (const call of warmOf(run.fetch)) {
        const url = new URL(call.url);
        expect(url.protocol).toBe("http:");
        expect(url.hostname).toBe(HOST);
        expect(url.port).toBe(String(PORT));
        expect(call.init?.method ?? "GET").toBe("GET");
      }
    });

    it("sends the path exactly, with no query string", async () => {
      const run = start();

      await advance(500);

      expect(warmOf(run.fetch).map((c) => new URL(c.url).search)).toEqual(["", "", ""]);
      expect(warmOf(run.fetch).map((c) => c.path)).toEqual(WARM_PATHS);
    });

    it("sends user-agent: orbit-warm-up and no cookie on every one", async () => {
      const run = start();

      await advance(500);

      const warm = warmOf(run.fetch);
      expect(warm.length).toBe(3);
      for (const call of warm) {
        const headers = headersOf(call.init);
        expect(headers.get("user-agent")).toBe("orbit-warm-up");
        expect(headers.has("cookie")).toBe(false);
        expect(headers.has("authorization")).toBe(false);
        expect(call.init?.credentials ?? "omit").not.toBe("include");
      }
    });

    it("sends the second only after the first has answered, and the third after the second", async () => {
      const gates = { "/__data.json": deferred(), "/": deferred(), "/api/auth/session": deferred() };
      const fetch = fakeFetch((path) => (path in gates ? gates[path].promise : new Response("ok")));
      const run = start({ fetch });

      await tick();
      expect(warmOf(fetch).map((c) => c.path)).toEqual(["/__data.json"]);

      gates["/__data.json"].resolve(new Response("{}"));
      await tick();
      expect(warmOf(fetch).map((c) => c.path)).toEqual(["/__data.json", "/"]);

      gates["/"].resolve(new Response("<html></html>"));
      await tick();
      expect(warmOf(fetch).map((c) => c.path)).toEqual(WARM_PATHS);

      expect(run.state.settled).toBe(false);
      gates["/api/auth/session"].resolve(new Response("{}", { status: 401 }));
      await tick();
      expect(run.state.settled).toBe(true);
    });

    for (const status of [302, 303, 401, 500, 503]) {
      it(`goes on to the next after a ${status} answer`, async () => {
        const fetch = fakeFetch((path) =>
          path === "/__data.json" ? new Response(null, { status }) : new Response("ok"),
        );
        const run = start({ fetch });

        await advance(500);

        expect(warmOf(fetch).map((c) => c.path)).toEqual(WARM_PATHS);
        expect(run.state.rejected).toBe(false);
      });
    }

    it("makes each of the three requests exactly once", async () => {
      const run = start();

      await advance(5_000);

      expect(warmOf(run.fetch).map((c) => c.path)).toEqual(WARM_PATHS);
      expect(run.state.settled).toBe(true);
    });
  });

  describe("nothing in the task stops the rest or rejects", () => {
    for (const failing of WARM_PATHS) {
      it(`goes on after a fetch of ${failing} that rejects`, async () => {
        const fetch = fakeFetch((path) =>
          path === failing ? Promise.reject(new TypeError("fetch failed")) : new Response("ok"),
        );
        const run = start({ fetch });

        await advance(500);

        expect(warmOf(fetch).map((c) => c.path)).toEqual(WARM_PATHS);
        expect(run.state.settled).toBe(true);
        expect(run.state.rejected).toBe(false);
      });

      it(`goes on after a fetch of ${failing} that throws synchronously`, async () => {
        const fetch = fakeFetch((path) => {
          if (path === failing) throw new Error("sync fetch failure");
          return new Response("ok");
        });
        const run = start({ fetch });

        await advance(500);

        expect(warmOf(fetch).map((c) => c.path)).toEqual(WARM_PATHS);
        expect(run.state.rejected).toBe(false);
      });
    }

    it("survives every warm request failing", async () => {
      const fetch = fakeFetch((path) =>
        path === "/api/health" ? new Response("ok") : Promise.reject(new Error("down")),
      );
      const run = start({ fetch });

      await advance(500);

      expect(warmOf(fetch).map((c) => c.path)).toEqual(WARM_PATHS);
      expect(run.state.settled).toBe(true);
      expect(run.state.rejected).toBe(false);
    });

    it("survives a failing loader and a failing fetch together", async () => {
      const loaders = [
        vi.fn(() => {
          throw new Error("loader");
        }),
      ];
      const fetch = fakeFetch((path) =>
        path === "/" ? Promise.reject(new Error("fetch")) : new Response("ok"),
      );
      const run = start({ fetch, loaders });

      await advance(500);

      expect(warmOf(fetch).map((c) => c.path)).toEqual(WARM_PATHS);
      expect(run.state.rejected).toBe(false);
    });
  });

  describe("the whole task stops at 20 s", () => {
    it("settles at 20 s when a warm request never answers, and sends nothing after it", async () => {
      const fetch = fakeFetch((path) => (path === "/" ? new Promise(() => {}) : new Response("ok")));
      const run = start({ fetch });

      await advance(DEADLINE_MS - 1_000);
      expect(run.state.settled).toBe(false);
      expect(warmOf(fetch).map((c) => c.path)).toEqual(["/__data.json", "/"]);

      await advance(1_000 + POLL_MS * 2);
      expect(run.state.settled).toBe(true);
      expect(run.state.rejected).toBe(false);
      expect(warmOf(fetch).map((c) => c.path)).toEqual(["/__data.json", "/"]);
    });

    it("settles at 20 s when a loader never answers, and requests nothing", async () => {
      const loaders = [vi.fn(() => new Promise(() => {})), vi.fn(async () => ({}))];
      const run = start({ loaders });

      await advance(DEADLINE_MS - 1_000);
      expect(run.state.settled).toBe(false);

      await advance(1_000 + POLL_MS * 2);
      expect(run.state.settled).toBe(true);
      expect(run.state.rejected).toBe(false);
      expect(loaders[1]).not.toHaveBeenCalled();
      expect(warmOf(run.fetch)).toEqual([]);
    });

    it("counts the 20 s from the start, not from the port answering", async () => {
      // Port answers after 10 s of refusals; a loader then hangs. The task
      // must still end at 20 s in all, not at 10 s + 20 s.
      const fetch = fakeFetch(refusedThen(200));
      const loaders = [vi.fn(() => new Promise(() => {}))];
      const run = start({ fetch, loaders });

      await advance(DEADLINE_MS - 1_000);
      expect(run.state.settled).toBe(false);

      await advance(1_000 + POLL_MS * 2);
      expect(run.state.settled).toBe(true);
      expect(run.state.rejected).toBe(false);
    });

    it("sends nothing late if a loader that outlived the deadline finally answers", async () => {
      const gate = deferred();
      const loaders = [vi.fn(() => gate.promise)];
      const run = start({ loaders });

      await advance(DEADLINE_MS + 1_000);
      expect(run.state.settled).toBe(true);

      gate.resolve({});
      await advance(1_000);

      expect(warmOf(run.fetch)).toEqual([]);
    });
  });
});
