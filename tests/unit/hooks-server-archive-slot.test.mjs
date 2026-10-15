import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1316 (DATA3): hooks.server.js's `handle` and the one-archive-at-a-time
 * slot. A signed-in caller who POSTs to an archive route while another archive
 * request is in progress is refused at once with a 429, and the route never
 * runs (so their upload is never read). The slot is freed however the first
 * request ends. Callers who are not signed in neither claim nor meet the slot:
 * they reach the route, which refuses them with its usual 401. Other routes
 * are unaffected.
 *
 * Same shape as tests/unit/hooks-server-key-gate.test.mjs, whose mocks, cold
 * import handling and request double this copies.
 */
const COLD_IMPORT_TIMEOUT_MS = 30_000;
const MIB = 1_048_576;

const mocks = vi.hoisted(() => ({
  readSession: vi.fn(),
  getAuthConfig: vi.fn(),
  hasOnwardHousehold: vi.fn(),
  readEffectiveMaintenance: vi.fn(),
  getKeyState: vi.fn(),
}));

vi.mock("orbit/lib/auth/session", () => ({ readSession: mocks.readSession }));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/server/workspace-repository", () => ({ hasOnwardHousehold: mocks.hasOnwardHousehold }));
vi.mock("orbit/server/maintenance", () => ({ readEffectiveMaintenance: mocks.readEffectiveMaintenance }));
vi.mock("orbit/server/key-state", () => ({ getKeyState: mocks.getKeyState }));
vi.mock("orbit/server/upload-limit", () => ({ readEffectiveUploadLimit: async () => 50 * MIB }));
vi.mock("orbit/lib/logger", () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const PREVIEW = "/api/portable-archives/preview";
const IMPORT = "/api/portable-archives/import";
const EXPORT = "/api/households/[householdId]/portable-archives";
const SLOT_ROUTES = [PREVIEW, IMPORT, EXPORT];

const administrator = { user: { id: "admin-1", isInstanceAdmin: true }, activeHouseholdId: "household-1" };

/** @type {typeof import("../../web/src/lib/server/archive-slot.js")} */
let slot;
/** @type {import("@sveltejs/kit").Handle} */
let handle;

/** @type {Array<() => void>} */
let gates = [];
/** @type {Array<Promise<unknown>>} */
let started = [];

/**
 * An archive-style request: a POST with a JSON body, as the cookie-carrying
 * browser would send it.
 * @param {string} id
 * @param {{ body?: BodyInit | null, headers?: Record<string, string> }} [options]
 */
function eventFor(id, { body = JSON.stringify({ passphrase: "p" }), headers = {} } = {}) {
  const path = id.replace("[householdId]", "household-1");
  const cookies = { "orbit-session": "token" };
  return {
    route: { id },
    url: new URL(`http://orbit.invalid${path}`),
    request: new Request(`http://orbit.invalid${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
      duplex: "half",
    }),
    isDataRequest: false,
    locals: {},
    fetch: vi.fn(async () => new Response("<h1>screen</h1>", { status: 200, headers: { "content-type": "text/html" } })),
    cookies: {
      get: vi.fn((name) => cookies[name]),
      set: vi.fn(),
      delete: vi.fn(),
    },
  };
}

/** A request whose body stream errors the moment it is read, as a client that drops does. */
function erroringBody() {
  return new ReadableStream({ start(controller) { controller.error(new Error("aborted")); } });
}

/** A resolve that reads the body and answers only when its gate is opened. */
function gatedResolver(status = 200) {
  let open = () => {};
  const gate = new Promise((resolve) => { open = () => resolve(undefined); });
  gates.push(open);
  const resolve = vi.fn(async (event) => {
    await event.request.json();
    await gate;
    return new Response("done", { status });
  });
  return { resolve, open };
}

/** A resolve that reads the body and answers at once. */
function readingResolver(status = 200) {
  return vi.fn(async (event) => {
    await event.request.json();
    return new Response("done", { status });
  });
}

/** Starts a handle and tracks it so a failing test cannot leave it hanging. */
function begin(event, resolve) {
  const promise = handle({ event, resolve });
  started.push(promise.catch(() => {}));
  return promise;
}

/** Waits until a gated resolve has been entered, i.e. the slot has been claimed. */
const entered = (resolve) => vi.waitFor(() => expect(resolve).toHaveBeenCalled());

/** The slot is free: an archive request now runs its route and is not refused. */
async function expectSlotFree(route = PREVIEW) {
  const resolve = readingResolver();
  const response = await handle({ event: eventFor(route), resolve });
  expect(response.status).toBe(200);
  expect(resolve).toHaveBeenCalledTimes(1);
}

/** @param {Response} response */
async function expectBusy(response) {
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("60");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("connection")).toBeNull();
  const { error } = await response.json();
  expect(error.code).toBe("archive_busy");
  expect(error.message).toEqual(expect.stringMatching(/\S/));
}

describe("hooks.server handle and the one-archive-at-a-time slot (#1316)", () => {
  beforeAll(async () => {
    ({ handle } = await import("../../web/src/hooks.server.js"));
    slot = await import("../../web/src/lib/server/archive-slot.js");
  }, COLD_IMPORT_TIMEOUT_MS);

  beforeEach(() => {
    delete process.env.ORBIT_FIXTURES;
    gates = [];
    started = [];
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getKeyState.mockReturnValue({ verdict: "usable", heldKeyId: "a".repeat(24) });
    mocks.readEffectiveMaintenance.mockResolvedValue({ effectivelyActive: false, expectedEndAt: null });
    mocks.getAuthConfig.mockReturnValue({ secureCookies: false });
    mocks.readSession.mockResolvedValue(administrator);
  });

  afterEach(async () => {
    for (const open of gates) open();
    await Promise.allSettled(started);
  });

  describe("a signed-in caller", () => {
    it("is refused at once with a 429 while another archive request is in progress, and the route never runs", async () => {
      const first = gatedResolver();
      const running = begin(eventFor(PREVIEW), first.resolve);
      await entered(first.resolve);
      expect(slot.archiveSlotHeld()).toBe(true);

      for (const route of SLOT_ROUTES) {
        const second = readingResolver();
        const refused = await handle({ event: eventFor(route), resolve: second });
        await expectBusy(refused);
        expect(second).not.toHaveBeenCalled();
      }

      first.open();
      expect((await running).status).toBe(200);
    });

    it("never buffers the refused caller's upload: it is answered, then read to its end and thrown away", async () => {
      const first = gatedResolver();
      begin(eventFor(IMPORT), first.resolve);
      await entered(first.resolve);

      const chunks = 4;
      let pulled = 0;
      let closed = false;
      const body = new ReadableStream({
        pull(controller) {
          if (pulled < chunks) {
            pulled += 1;
            controller.enqueue(new Uint8Array(1024));
          } else {
            closed = true;
            controller.close();
          }
        },
      }, { highWaterMark: 0 });
      const event = eventFor(PREVIEW, { body });
      const second = readingResolver();
      const refused = await handle({ event, resolve: second });

      await expectBusy(refused);
      expect(second).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(pulled).toBe(chunks);
      expect(closed).toBe(true);
    });

    it("gets in again once the first request has settled", async () => {
      const first = gatedResolver();
      const running = begin(eventFor(EXPORT), first.resolve);
      await entered(first.resolve);
      first.open();
      await running;

      await expectSlotFree(IMPORT);
      expect(slot.archiveSlotHeld()).toBe(false);
    });
  });

  describe("the slot is freed however the request ends", () => {
    it("when the route answers 500", async () => {
      const resolve = readingResolver(500);
      const response = await handle({ event: eventFor(IMPORT), resolve });
      expect(response.status).toBe(500);
      expect(slot.archiveSlotHeld()).toBe(false);
      await expectSlotFree();
    });

    it("when the route throws", async () => {
      const resolve = vi.fn(async (event) => {
        await event.request.json();
        throw new Error("the route fell over");
      });
      await handle({ event: eventFor(PREVIEW), resolve }).then(() => null, (error) => error);
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(slot.archiveSlotHeld()).toBe(false);
      await expectSlotFree();
    });

    it("when reading the body fails because the client dropped", async () => {
      const resolve = vi.fn(async (event) => {
        await event.request.json();
        return new Response("done");
      });
      await handle({ event: eventFor(IMPORT, { body: erroringBody() }), resolve }).then(() => null, (error) => error);
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(slot.archiveSlotHeld()).toBe(false);
      await expectSlotFree();
    });

    it.each(SLOT_ROUTES)("when the body-limit step refuses a declared 1 GiB body to %s with a 413", async (route) => {
      const resolve = readingResolver();
      const event = eventFor(route, { headers: { "content-length": String(1024 * MIB) } });
      const response = await handle({ event, resolve });
      expect(response.status).toBe(413);
      expect(resolve).not.toHaveBeenCalled();
      expect(slot.archiveSlotHeld()).toBe(false);
      await expectSlotFree(route);
    });
  });

  describe("every other route", () => {
    it.each(["/api/admin/contact", "/home"])("%s is unaffected while the slot is held", async (route) => {
      const first = gatedResolver();
      begin(eventFor(PREVIEW), first.resolve);
      await entered(first.resolve);

      const other = vi.fn(async () => new Response("fine", { status: 200 }));
      const response = await handle({ event: eventFor(route), resolve: other });

      expect(response.status).toBe(200);
      expect(other).toHaveBeenCalledTimes(1);
      first.open();
    });
  });

  describe("a caller who is not signed in", () => {
    it("is not given the 429 while a signed-in request holds the slot: the route is reached, where it answers 401", async () => {
      const first = gatedResolver();
      begin(eventFor(PREVIEW), first.resolve);
      await entered(first.resolve);

      mocks.readSession.mockResolvedValue(null);
      const route = vi.fn(async () => new Response("unauthorised", { status: 401 }));
      const response = await handle({ event: eventFor(IMPORT), resolve: route });

      expect(route).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(401);
      expect(response.status).not.toBe(429);
      first.open();
    });

    it("never claims the slot: while it is in flight a signed-in caller is not refused", async () => {
      mocks.readSession.mockResolvedValue(null);
      const signedOut = gatedResolver();
      const running = begin(eventFor(PREVIEW), signedOut.resolve);
      await entered(signedOut.resolve);
      expect(slot.archiveSlotHeld()).toBe(false);

      mocks.readSession.mockResolvedValue(administrator);
      const signedIn = readingResolver();
      const response = await handle({ event: eventFor(PREVIEW), resolve: signedIn });

      expect(response.status).toBe(200);
      expect(signedIn).toHaveBeenCalledTimes(1);
      signedOut.open();
      await running;
    });
  });
});
