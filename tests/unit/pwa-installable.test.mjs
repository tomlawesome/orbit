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
 *
 * Offline fallback page (standard pattern): a navigation goes to the network
 * first and its response is returned untouched; only when the network fetch
 * rejects does the worker answer with the precached static `offline.html`.
 * A navigation is never answered from cache while the network works, and no
 * navigation response is ever stored.
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

/* ------------------------------------------------------------- offline page */

describe("offline fallback page", () => {
  const path = resolve(STATIC, "offline.html");
  const html = () => readFileSync(path, "utf8");

  it("is a static file in web/static, so $service-worker lists it in `files`", () => {
    expect(existsSync(path)).toBe(true);
  });

  it("names Orbit and says it needs a connection and will carry on when it is back", () => {
    const text = html();
    expect(text).toMatch(/Orbit/);
    expect(text).toMatch(/connection/i);
    expect(text).toMatch(/household/i);
  });

  it("has a try again control that reloads", () => {
    const text = html();
    expect(text).toMatch(/try again/i);
    expect(text).toMatch(/<button\b|<a\b/i);
    expect(text).toMatch(/location\s*\.\s*reload\s*\(|location\s*\.\s*href\s*=|<a\b[^>]*href=["']\/?["']/i);
  });

  it("uses Orbit's star-chart ground colour and shows Orbit's icon", () => {
    const text = html();
    expect(text.toLowerCase()).toContain("#060b1c");
    const icon = text.match(/(?:src|href)=["'](\/icon[^"']*\.(?:png|svg))["']/i);
    expect(icon, "a reference to one of Orbit's icons").toBeTruthy();
    expect(existsSync(resolve(STATIC, `.${icon[1]}`)), `${icon[1]} exists in web/static`).toBe(true);
  });

  it("carries no household data and makes no /api/ request", () => {
    const text = html();
    expect(text).not.toMatch(/\/api\//);
    expect(text).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|EventSource|WebSocket/);
  });

  it("works with no other request: no external script, stylesheet, font or URL", () => {
    const text = html();
    expect(text).not.toMatch(/<script\b[^>]*\bsrc=/i);
    expect(text).not.toMatch(/<link\b[^>]*rel=["']?stylesheet/i);
    expect(text).not.toMatch(/@import/i);
    expect(text).not.toMatch(/https?:\/\//i);
    expect(text).not.toMatch(/(?:src|href)=["']\/\//i);
    expect(text).toMatch(/<style\b/i); // styles are inline
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
const OFFLINE_PAGE = "/offline.html";
const FILES = ["/icon-192.png", "/icon-512.png", "/fonts/body.woff2", OFFLINE_PAGE];
const PRERENDERED = ["/about"];

const abs = (path) => new URL(path, ORIGIN).href;

/** A Request whose `mode` is "navigate", which the Request constructor will not allow. */
function navigation(path, init) {
  const request = new Request(new URL(path, ORIGIN).href, init);
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

  /** Dispatches a fetch event and resolves to the raw Response, or null when declined. */
  async function respond(request) {
    let answer = null;
    const event = {
      request,
      respondWith: (p) => {
        answer = Promise.resolve(p);
      },
      waitUntil: () => {},
    };
    for (const handler of listeners.fetch || []) handler(event);
    return answer ? await answer : null;
  }

  return {
    respond,
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

/** Makes the install-time copy of the offline page recognisable. */
const OFFLINE_BODY = "<!doctype html><title>Orbit offline page</title>";
function networkWithOfflinePage(w) {
  w.network.mockImplementation(async (req) => {
    const url = typeof req === "string" ? new URL(req, ORIGIN).href : req.url;
    return new Response(url === abs(OFFLINE_PAGE) ? OFFLINE_BODY : `network:${url}`);
  });
}
const goOffline = (w) =>
  w.network.mockImplementation(async () => {
    throw new TypeError("Failed to fetch");
  });

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

describe("service worker fetch: offline fallback page for navigations", () => {
  async function ready() {
    const w = await loadWorker();
    networkWithOfflinePage(w);
    await w.install();
    await w.activate();
    return w;
  }

  it("precaches the offline page at install", async () => {
    const w = await ready();

    expect(cachedUrls(w.puts).has(abs(OFFLINE_PAGE))).toBe(true);
  });

  for (const path of ["/", "/home", "/tasks?member=2"]) {
    it(`answers a navigation to ${path} with the cached offline page when the network fetch rejects`, async () => {
      const w = await ready();
      goOffline(w);

      const { handled, body } = await w.dispatchFetch(navigation(path));

      expect(handled).toBe(true);
      expect(body).toBe(OFFLINE_BODY);
    });
  }

  it("tries the network first for a navigation and returns its response untouched", async () => {
    const w = await ready();
    const request = navigation("/home");
    w.network.mockClear();
    w.network.mockImplementation(async () => new Response("live page", { status: 503, statusText: "Busy" }));

    const response = await w.respond(request);

    expect(response).not.toBeNull();
    expect(w.network).toHaveBeenCalled();
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("live page");
  });

  it("answers a navigation from the network, never the offline page, while the network works", async () => {
    const w = await ready();
    const request = navigation("/home");

    const { handled, body } = await w.dispatchFetch(request);

    expect(handled).toBe(true);
    expect(body).toBe(`network:${request.url}`);
  });

  it("never answers a navigation from cache while the network works, even if a copy exists", async () => {
    const w = await ready();
    for (const name of w.store.keys()) {
      w.store.get(name).set(abs("/home"), { body: "STALE", status: 200 });
      w.store.get(name).set(abs("/"), { body: "STALE", status: 200 });
    }

    for (const path of ["/home", "/"]) {
      const request = navigation(path);
      const { handled, body } = await w.dispatchFetch(request);
      expect(handled, path).toBe(true);
      expect(body, path).toBe(`network:${request.url}`);
    }
  });

  it("stores no navigation response, with the network up or down", async () => {
    const w = await ready();
    const before = w.puts.length;

    await w.dispatchFetch(navigation("/home"));
    goOffline(w);
    await w.dispatchFetch(navigation("/home"));
    await w.dispatchFetch(navigation("/"));

    expect(w.puts.slice(before)).toEqual([]);
  });

  it("does not answer a non-navigation request with the offline page when the network fails", async () => {
    const w = await ready();
    goOffline(w);

    for (const path of ["/api/households/1/tasks", "/api/session", "/documents/passport.pdf"]) {
      let result = null;
      try {
        result = await w.dispatchFetch(new Request(abs(path)));
      } catch {
        // a rejected response is the browser's own network error: fine
      }
      if (result?.body != null) expect(result.body, path).not.toBe(OFFLINE_BODY);
    }
  });

  it("still serves a precached shell asset cache-first with no network", async () => {
    const w = await ready();
    goOffline(w);

    const { handled, body } = await w.dispatchFetch(new Request(abs(BUILD[0])));

    expect(handled).toBe(true);
    expect(body).toBe(`network:${abs(BUILD[0])}`);
  });

  it("still does not skipWaiting or claim clients", async () => {
    const w = await ready();
    goOffline(w);
    await w.dispatchFetch(navigation("/home"));

    expect(w.skipWaiting).not.toHaveBeenCalled();
    expect(w.claim).not.toHaveBeenCalled();
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

      // a navigation is answered by the network (or, if that fails, the offline
      // page), never from a cache: what the network returns is what the page gets
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

/*
 * What the worker must never intercept (#1329, after pipeline 2382). A
 * request the worker answers -- even with `fetch(request)` passed straight
 * through -- is no longer the browser's own: a redirect comes back as an
 * opaque one the page cannot see, and the browser's network events see the
 * worker's answer instead of the server's (three e2e specs went red that way:
 * the hand-over to /api/auth/login, the 303 at /, the archive challenge).
 * The standard app-shell rules (web.dev "Create an offline fallback page";
 * Workbox's NavigationRoute denylist): leave every non-GET request, every
 * cross-origin request and everything under /api/ -- sign-in, sign-out, the
 * provider's callback, downloads -- to the browser, network up or down. Only
 * page navigations get the offline fallback.
 */
describe("service worker fetch: what it never intercepts", () => {
  async function ready() {
    const w = await loadWorker();
    networkWithOfflinePage(w);
    await w.install();
    await w.activate();
    w.network.mockClear();
    return w;
  }

  const NEVER = [
    ["the hand-over to the identity provider", () => navigation("/api/auth/login?returnTo=%2Fhome")],
    ["the provider's callback", () => navigation("/api/auth/callback?code=abc&state=def")],
    ["the step-up return", () => navigation("/api/auth/step-up/callback?code=abc&state=def")],
    ["sign-out", () => navigation("/api/auth/logout")],
    ["a document download opened as a page", () => navigation("/api/households/1/documents/2/download")],
    ["an API read", () => new Request(abs("/api/auth/session"))],
    ["a form posted as a navigation", () => navigation("/login", { method: "POST", body: "a=1" })],
    ["an API write", () => new Request(abs("/api/households/1/portable-archives"), { method: "POST", body: "{}" })],
    ["a navigation to another origin", () => navigation("https://idp.example/authorize?client_id=orbit")],
    ["a cross-origin GET", () => new Request("https://cdn.elsewhere.example/lib.js")],
  ];

  for (const [label, make] of NEVER) {
    it(`leaves ${label} to the browser`, async () => {
      const w = await ready();

      const { handled } = await w.dispatchFetch(make());

      expect(handled).toBe(false);
      expect(w.network).not.toHaveBeenCalled();
    });

    it(`leaves ${label} to the browser with no network either`, async () => {
      const w = await ready();
      goOffline(w);

      const { handled } = await w.dispatchFetch(make());

      expect(handled).toBe(false);
    });
  }

  it("hands a page navigation's redirect back as the very response the network gave", async () => {
    const w = await ready();
    const redirect = new Response(null, { status: 303, headers: { location: "/home", "cache-control": "no-store" } });
    w.network.mockImplementation(async () => redirect);

    const response = await w.respond(navigation("/"));

    expect(response).toBe(redirect);
  });
});
