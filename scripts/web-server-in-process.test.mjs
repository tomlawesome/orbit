import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1657: scripts/web-server.test.mjs runs the shim as a child process, which
 * the parent's v8 coverage cannot see. These tests import the shim in-process
 * against a stand-in adapter (`./index.js`, mocked) and check what it does to
 * the environment, the exported server and the exit code.
 */

/* The shim imports "./index.js" next to itself. That file exists only in the
   built adapter's folder, so here it is a module mock with no file behind it
   (#1794: a real scripts/index.js raced other tests that scan scripts/).
   Vitest resolves the missing import to the root-relative id below. The
   adapter is read through a getter when the shim imports it, so each test's
   stand-in (put on globalThis by `load`) survives vi.resetModules(). */
vi.mock("/scripts/index.js", () => ({
  get server() {
    return globalThis.__orbitTestAdapter?.server;
  },
}));
const ADAPTER = fileURLToPath(new URL("./index.js", import.meta.url));
afterAll(() => {
  delete globalThis.__orbitTestAdapter;
});

const SHIM = "./web-server.mjs";
const ENV_KEYS = ["ORIGIN", "PROTOCOL_HEADER", "HOST_HEADER"];

let saved;
let warn;

function fakeServer() {
  const listeners = [];
  return {
    listeners,
    /* An http.Server's own default; the shim turns it off (#1390). */
    requestTimeout: 300_000,
    prependListener(event, fn) {
      listeners.unshift({ event, fn });
    },
    emit(headers) {
      const request = { headers: { ...headers } };
      const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; } };
      for (const { fn } of listeners) fn(request, response);
      return { request, response };
    },
  };
}

async function load(origin, adapter) {
  if (origin === undefined) delete process.env.ORIGIN;
  else process.env.ORIGIN = origin;
  vi.resetModules();
  globalThis.__orbitTestAdapter = adapter;
  await import(SHIM);
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe("web-server shim, in process", () => {
  it("normalises a plain origin and overwrites both forwarded headers", async () => {
    const server = fakeServer();
    await load("HTTPS://Example.COM:443", { server });
    expect(process.env.PROTOCOL_HEADER).toBe("x-orbit-forwarded-proto");
    expect(process.env.HOST_HEADER).toBe("x-orbit-forwarded-host");
    const { request, response } = server.emit({
      "x-orbit-forwarded-proto": "http",
      "x-orbit-forwarded-host": "evil.test",
    });
    expect(request.headers["x-orbit-forwarded-proto"]).toBe("https");
    expect(request.headers["x-orbit-forwarded-host"]).toBe("example.com");
    expect(response.headers["X-Frame-Options"]).toBe("DENY");
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps a non-default port and drops a leading zero", async () => {
    const server = fakeServer();
    await load("http://localhost:08443/", { server });
    expect(server.emit({}).request.headers["x-orbit-forwarded-host"]).toBe("localhost:8443");
  });

  it.each([
    ["unset", undefined],
    ["not a URL", "not a url"],
    ["a non-http scheme", "ftp://example.com"],
    ["credentials", "https://user:pw@example.com"],
    ["a username only", "https://user@example.com"],
    ["a query", "https://example.com/?a=1"],
    ["an empty query", "https://example.com?"],
    ["a fragment", "https://example.com/#x"],
    ["an empty fragment", "https://example.com#"],
    ["a path", "https://example.com/app"],
    ["port zero", "https://example.com:0"],
  ])("refuses ORIGIN %s: warns, sets no origin headers, still denies framing", async (_name, value) => {
    const server = fakeServer();
    await load(value, { server });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("ORIGIN");
    expect(process.env.PROTOCOL_HEADER).toBeUndefined();
    expect(process.env.HOST_HEADER).toBeUndefined();
    const { request, response } = server.emit({});
    expect(request.headers["x-orbit-forwarded-proto"]).toBeUndefined();
    expect(request.headers["x-orbit-forwarded-host"]).toBeUndefined();
    expect(response.headers["X-Frame-Options"]).toBe("DENY");
  });

  it.each([
    ["no server export", {}],
    ["a server without prependListener", { server: {} }],
  ])("exits 1 when the adapter has %s", async (_name, adapter) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    await expect(load("https://example.com", adapter)).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(error.mock.calls[0][0])).toContain("no `server`");
  });

  it("leaves no scripts/index.js in the repository once the shim has loaded (#1794)", async () => {
    await load("https://example.com", { server: fakeServer() });
    expect(existsSync(ADAPTER)).toBe(false);
  });
});
