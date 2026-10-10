import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1329: Orbit is installable as a standard PWA and nothing more.
 *
 * Owner scope (2026-10-10): a web app manifest naming the app with its icons,
 * start URL `/` and `display: standalone`; a service worker that caches only
 * the app shell (built JS, CSS, fonts, icons -- SvelteKit's `build` and
 * `files`), never `/api/...` responses, documents or household data; a new
 * version installs in the background and takes over on the next launch, with
 * no `skipWaiting()` + `clients.claim()` swap under an open window.
 *
 * The manifest tests read the files off disk. The worker is a plain script
 * that registers listeners on `self` at import time, so the behaviour tests
 * (the shape of tests/unit/service-worker.test.mjs) stub `self`, `caches`,
 * `fetch` and SvelteKit's virtual `$service-worker` module, import the worker
 * fresh, and drive the listeners it registered.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const STATIC = resolve(ROOT, "web/static");
const WORKER_PATH = resolve(ROOT, "web/src/service-worker.js");
const ORIGIN = "https://orbit.example";

/* ------------------------------------------------------------------ manifest */

const manifest = JSON.parse(readFileSync(resolve(STATIC, "manifest.webmanifest"), "utf8"));

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path) {
  const buf = readFileSync(path);
  expect(buf.subarray(1, 4).toString("ascii"), `${path} is a PNG`).toBe("PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("web app manifest", () => {
  it("names the app", () => {
    expect(manifest.name).toBe("Orbit");
    expect(typeof manifest.short_name).toBe("string");
    expect(manifest.short_name.length).toBeGreaterThan(0);
  });

  it("starts at / and opens standalone", () => {
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
  });

  it("lists a 192px and a 512px PNG icon that exist on disk at that size", () => {
    for (const size of [192, 512]) {
      const icon = manifest.icons.find(
        (i) => i.type === "image/png" && i.sizes.split(/\s+/).includes(`${size}x${size}`),
      );
      expect(icon, `a ${size}x${size} PNG icon`).toBeTruthy();
      const path = resolve(STATIC, `.${icon.src}`);
      expect(existsSync(path), `${icon.src} exists in web/static`).toBe(true);
      expect(pngSize(path)).toEqual({ width: size, height: size });
    }
  });

  it("only lists icons that exist on disk", () => {
    for (const icon of manifest.icons) {
      expect(existsSync(resolve(STATIC, `.${icon.src}`)), `${icon.src} exists`).toBe(true);
    }
  });

  it("is linked from app.html", () => {
    const html = readFileSync(resolve(ROOT, "web/src/app.html"), "utf8");
    expect(html).toMatch(/<link\s+rel="manifest"\s+href="\/manifest\.webmanifest"/);
  });
});

/* ------------------------------------------------------------- worker source */

/** The worker source with comments removed, so prose cannot satisfy or trip a check. */
function workerCode() {
  return readFileSync(WORKER_PATH, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("service worker source", () => {
  it("lives at SvelteKit's service worker path", () => {
    expect(existsSync(WORKER_PATH)).toBe(true);
  });

  it("imports build, files and version from $service-worker", () => {
    const code = workerCode();
    const match = code.match(/import\s*\{([^}]*)\}\s*from\s*["']\$service-worker["']/);
    expect(match, "an import from $service-worker").toBeTruthy();
    const names = match[1].split(",").map((n) => n.trim().split(/\s+as\s+/)[0]);
    expect(names).toEqual(expect.arrayContaining(["build", "files", "version"]));
  });

  it("does not combine skipWaiting() with clients.claim()", () => {
    const code = workerCode();
    expect(/skipWaiting\s*\(/.test(code) && /clients\s*\.\s*claim\s*\(/.test(code)).toBe(false);
  });

  it("leaves SvelteKit's automatic worker registration on", () => {
    const config = readFileSync(resolve(ROOT, "web/svelte.config.js"), "utf8");
    expect(config).not.toMatch(/serviceWorker\s*:\s*\{[^}]*register\s*:\s*false/);
  });
});

/* ---------------------------------------------------------- worker behaviour */

const BUILD = ["/_app/immutable/entry/start.abc123.js", "/_app/immutable/assets/0.def456.css"];
const FILES = ["/icon-192.png", "/icon-512.png", "/fonts/body.woff2"];
const PRERENDERED = ["/about"];

const abs = (path) => new URL(path, ORIGIN).href;

/** A Request whose `mode` is "navigate", which the Request constructor will not allow. */
function navigation(path) {
  const request = new Request(abs(path));
  Object.defineProperty(request, "mode", { value: "navigate" });
  return request;
}

/**
 * An in-memory CacheStorage that records every write. Responses are
 * buffered on `put`, as a real Cache does, so they can be matched repeatedly.
 */
function makeCaches(store = new Map(), puts = []) {
  const keyOf = (req) => (typeof req === "string" ? new URL(req, ORIGIN).href : req.url);
  const makeCache = (name) => {
    const entries = store.get(name);
    const cache = {
      async put(req, res) {
        puts.push({ cache: name, url: keyOf(req) });
        entries.set(keyOf(req), { body: await res.clone().text(), status: res.status });
      },
      async add(req) {
        const res = await fetch(req);
        if (!res.ok) throw new TypeError("bad response");
        await cache.put(req, res);
      },
      async addAll(reqs) {
        for (const req of reqs) await cache.add(req);
      },
      async match(req) {
        const hit = entries.get(keyOf(req));
        return hit ? new Response(hit.body, { status: hit.status }) : undefined;
      },
      async keys() {
        return [...entries.keys()].map((url) => new Request(url));
      },
      async delete(req) {
        return entries.delete(keyOf(req));
      },
    };
    return cache;
  };
  const storage = {
    async open(name) {
      if (!store.has(name)) store.set(name, new Map());
      return makeCache(name);
    },
    async has(name) {
      return store.has(name);
    },
    async keys() {
      return [...store.keys()];
    },
    async delete(name) {
      return store.delete(name);
    },
    async match(req) {
      for (const name of store.keys()) {
        const hit = await makeCache(name).match(req);
        if (hit) return hit;
      }
      return undefined;
    },
  };
  return { storage, store, puts };
}

/**
 * Imports the worker fresh against stubs. `store` is shared between calls so
 * a later "version" of the worker sees what an earlier one left behind.
 */
async function loadWorker({ version = "v-test-1", store = new Map(), puts = [] } = {}) {
  const listeners = {};
  const skipWaiting = vi.fn(async () => {});
  const claim = vi.fn(async () => {});
  vi.stubGlobal("self", {
    location: { origin: ORIGIN },
    addEventListener: (type, handler) => {
      (listeners[type] ||= []).push(handler);
    },
    skipWaiting,
    clients: { claim, matchAll: vi.fn(async () => []), openWindow: vi.fn() },
    registration: { showNotification: vi.fn() },
  });
  const { storage } = makeCaches(store, puts);
  vi.stubGlobal("caches", storage);
  const network = vi.fn(async (req) => new Response(`network:${typeof req === "string" ? new URL(req, ORIGIN).href : req.url}`));
  vi.stubGlobal("fetch", network);
  vi.resetModules();
  vi.doMock("$service-worker", () => ({
    build: BUILD,
    files: FILES,
    prerendered: PRERENDERED,
    base: "",
    version,
  }));
  await import("../../web/src/service-worker.js");

  /** Dispatches a lifecycle event to every listener and waits for its waitUntil work. */
  async function lifecycle(type) {
    const work = [];
    const event = { waitUntil: (p) => work.push(Promise.resolve(p)) };
    for (const handler of listeners[type] || []) handler(event);
    await Promise.all(work);
  }

  /**
   * Dispatches a fetch event. Resolves to the body the page would receive when
   * the worker answered, or `null` when it declined (the browser then goes
   * to the network itself).
   */
  async function dispatchFetch(request) {
    let answer = null;
    const work = [];
    const event = {
      request,
      respondWith: (p) => {
        answer = Promise.resolve(p);
      },
      waitUntil: (p) => work.push(Promise.resolve(p)),
    };
    for (const handler of listeners.fetch || []) handler(event);
    const response = answer ? await answer : null;
    const body = response ? await response.text() : null;
    await Promise.all(work);
    return { handled: answer !== null, body };
  }

  return {
    install: () => lifecycle("install"),
    activate: () => lifecycle("activate"),
    dispatchFetch,
    listeners,
    skipWaiting,
    claim,
    network,
    store,
    puts,
  };
}

/** Every URL written to any cache so far. */
const cachedUrls = (puts) => new Set(puts.map((p) => p.url));

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("$service-worker");
  vi.unstubAllGlobals();
});

describe("service worker install", () => {
  it("precaches every build and static file, and nothing else", async () => {
    const w = await loadWorker();
    await w.install();

    expect(cachedUrls(w.puts)).toEqual(new Set([...BUILD, ...FILES].map(abs)));
  });

  it("keys the cache by the build version", async () => {
    const w = await loadWorker({ version: "v-test-77" });
    await w.install();

    const names = [...w.store.keys()];
    expect(names.length).toBeGreaterThan(0);
    expect(names.some((n) => n.includes("v-test-77"))).toBe(true);
  });

  it("does not cache documents or prerendered pages", async () => {
    const w = await loadWorker();
    await w.install();
    await w.activate();

    const urls = cachedUrls(w.puts);
    for (const path of ["/", ...PRERENDERED]) expect(urls.has(abs(path)), path).toBe(false);
  });

  it("does not take over mid-session: no skipWaiting, no clients.claim", async () => {
    const w = await loadWorker();
    await w.install();
    await w.activate();

    expect(w.skipWaiting).not.toHaveBeenCalled();
    expect(w.claim).not.toHaveBeenCalled();
  });
});

describe("service worker activate", () => {
  it("deletes caches left by an older version and keeps the current one", async () => {
    const store = new Map();
    const old = await loadWorker({ version: "v-old", store });
    await old.install();
    await old.activate();
    const oldNames = [...store.keys()];
    expect(oldNames.length).toBeGreaterThan(0);

    const next = await loadWorker({ version: "v-new", store });
    await next.install();
    await next.activate();

    const names = [...store.keys()];
    for (const name of oldNames) expect(names, `${name} removed`).not.toContain(name);
    expect(names.some((n) => n.includes("v-new"))).toBe(true);
    // the new version's shell is still there after cleanup
    const hit = await (await makeCaches(store).storage.match(abs(BUILD[0])));
    expect(hit).toBeTruthy();
  });
});

describe("service worker fetch: the app shell", () => {
  it("serves a precached shell asset with no network", async () => {
    const w = await loadWorker();
    await w.install();
    await w.activate();
    w.network.mockImplementation(async () => {
      throw new TypeError("offline");
    });

    for (const path of [...BUILD, ...FILES]) {
      const { handled, body } = await w.dispatchFetch(new Request(abs(path)));
      expect(handled, path).toBe(true);
      expect(body, path).toBe(`network:${abs(path)}`); // the copy stored at install time
    }
  });
});

describe("service worker fetch: nothing private is cached or served from cache", () => {
  /** Plants a private-looking entry for `url` in every cache the worker made. */
  async function poison(w, url) {
    for (const name of w.store.keys()) w.store.get(name).set(abs(url), { body: "PRIVATE", status: 200 });
  }

  const PRIVATE_GETS = [
    ["an API read", () => new Request(abs("/api/households/1/tasks"))],
    ["the session API", () => new Request(abs("/api/session"))],
    ["an API read with a query", () => new Request(abs("/api/documents?member=2"))],
    ["the document at /", () => navigation("/")],
    ["a page document", () => navigation("/home")],
    ["an uploaded document", () => new Request(abs("/documents/passport.pdf"))],
  ];

  for (const [label, make] of PRIVATE_GETS) {
    it(`never serves ${label} from cache`, async () => {
      const w = await loadWorker();
      await w.install();
      await w.activate();
      const request = make();
      await poison(w, new URL(request.url).pathname + new URL(request.url).search);
      await poison(w, new URL(request.url).pathname);

      const { handled, body } = await w.dispatchFetch(request);

      if (handled) expect(body).toBe(`network:${request.url}`);
      expect(body === null || !body.includes("PRIVATE")).toBe(true);
    });

    it(`never stores ${label}`, async () => {
      const w = await loadWorker();
      await w.install();
      await w.activate();
      const before = w.puts.length;

      await w.dispatchFetch(make());

      expect(w.puts.slice(before)).toEqual([]);
    });
  }

  it("ignores non-GET requests, shell URLs included", async () => {
    const w = await loadWorker();
    await w.install();
    await w.activate();
    const before = w.puts.length;

    for (const path of ["/api/households/1/tasks", BUILD[0]]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const request = new Request(abs(path), { method, body: "{}" });
        const { handled, body } = await w.dispatchFetch(request);
        if (handled) expect(body, `${method} ${path}`).toBe(`network:${request.url}`);
      }
    }
    expect(w.puts.length).toBe(before);
  });

  it("does not cache a cross-origin GET", async () => {
    const w = await loadWorker();
    await w.install();
    await w.activate();
    const before = w.puts.length;

    await w.dispatchFetch(new Request("https://cdn.elsewhere.example/lib.js"));

    expect(w.puts.slice(before)).toEqual([]);
  });
});
