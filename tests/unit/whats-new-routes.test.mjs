import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1618: GET /api/whats-new and POST /api/whats-new/dismiss. Same pattern as
 * portable-archive-routes.test.mjs: collaborators mocked at the module
 * boundary, the route files and the shared read()/write() wrappers run for real.
 */
const mocks = vi.hoisted(() => ({
  assertOutsideMaintenance: vi.fn(),
  assertCsrf: vi.fn(),
  getAuthConfig: vi.fn(),
  requireSession: vi.fn(),
  readWhatsNew: vi.fn(),
  dismissWhatsNew: vi.fn(),
}));

vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: mocks.assertOutsideMaintenance }));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/lib/auth/session", () => ({ requireSession: mocks.requireSession, assertCsrf: mocks.assertCsrf }));
vi.mock("orbit/server/whats-new", () => ({
  readWhatsNew: mocks.readWhatsNew,
  dismissWhatsNew: mocks.dismissWhatsNew,
}));

const ANSWER = { version: "v0.3.7", releases: [{ version: "v0.3.7", forEveryone: [{ lead: "L", text: "T." }] }] };

function event(path, init = {}) {
  return {
    cookies: { get: () => undefined, set: () => {} },
    params: {},
    request: new Request(`http://localhost${path}`, init),
  };
}
const post = (body) => event("/api/whats-new/dismiss", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

async function routes() {
  const [read, dismiss, errors, authErrors] = await Promise.all([
    import("../../web/src/routes/api/whats-new/+server.js"),
    import("../../web/src/routes/api/whats-new/dismiss/+server.js"),
    import("orbit/lib/errors"),
    import("orbit/lib/auth/errors"),
  ]);
  return { GET: read.GET, POST: dismiss.POST, AppError: errors.AppError, AuthError: authErrors.AuthError };
}

beforeEach(() => {
  vi.resetModules();
  delete process.env.ORBIT_FIXTURES;
  process.env.ORBIT_VERSION = "v0.3.7";
  mocks.assertOutsideMaintenance.mockReset().mockResolvedValue(undefined);
  mocks.assertCsrf.mockReset();
  mocks.getAuthConfig.mockReset().mockReturnValue({});
  mocks.requireSession.mockReset().mockResolvedValue({ id: "session-1", user: { id: "user-1", email: "u@example.invalid" } });
  mocks.readWhatsNew.mockReset().mockResolvedValue(ANSWER);
  mocks.dismissWhatsNew.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.ORBIT_FIXTURES;
  delete process.env.ORBIT_VERSION;
});

describe("GET /api/whats-new", () => {
  it("answers the engine's { version, releases }, no-store, for the session's own user and the running version", async () => {
    const { GET } = await routes();
    const response = await GET(event("/api/whats-new"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(ANSWER);
    expect(mocks.readWhatsNew).toHaveBeenCalledTimes(1);
    expect(mocks.readWhatsNew).toHaveBeenCalledWith("user-1", expect.objectContaining({ runningVersion: "v0.3.7" }));
  });

  it("passes an unset ORBIT_VERSION on as missing, not as a made-up value", async () => {
    delete process.env.ORBIT_VERSION;
    const { GET } = await routes();
    await GET(event("/api/whats-new"));
    const options = mocks.readWhatsNew.mock.calls[0][1];
    expect(options.runningVersion ?? null).toBeNull();
  });

  it("needs a session", async () => {
    const { GET, AuthError } = await routes();
    mocks.requireSession.mockRejectedValue(new AuthError("unauthenticated", "Sign in", 401));
    const response = await GET(event("/api/whats-new"));
    expect(response.status).toBe(401);
    expect(mocks.readWhatsNew).not.toHaveBeenCalled();
  });

  it("answers an empty list without calling the engine under fixtures", async () => {
    process.env.ORBIT_FIXTURES = "1";
    const { GET } = await routes();
    const response = await GET(event("/api/whats-new"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: null, releases: [] });
    expect(mocks.readWhatsNew).not.toHaveBeenCalled();
  });
});

describe("POST /api/whats-new/dismiss", () => {
  it("checks CSRF, then dismisses the shown version for the session's own user", async () => {
    const { POST } = await routes();
    const response = await POST(post({ version: "v0.3.5" }));

    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.assertCsrf).toHaveBeenCalledTimes(1);
    expect(mocks.dismissWhatsNew).toHaveBeenCalledWith("user-1", "v0.3.5", expect.objectContaining({ runningVersion: "v0.3.7" }));
  });

  it("does not dismiss when CSRF is refused", async () => {
    const { POST, AppError } = await routes();
    mocks.assertCsrf.mockImplementation(() => { throw new AppError("csrf_invalid", "Bad token", 403); });
    const response = await POST(post({ version: "v0.3.5" }));
    expect(response.status).toBe(403);
    expect(mocks.dismissWhatsNew).not.toHaveBeenCalled();
  });

  it("needs a session", async () => {
    const { POST, AuthError } = await routes();
    mocks.requireSession.mockRejectedValue(new AuthError("unauthenticated", "Sign in", 401));
    const response = await POST(post({ version: "v0.3.5" }));
    expect(response.status).toBe(401);
    expect(mocks.dismissWhatsNew).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing version", {}],
    ["a number", { version: 7 }],
    ["null", { version: null }],
    ["an object", { version: { v: "v0.3.5" } }],
    ["an array", { version: ["v0.3.5"] }],
  ])("refuses %s with 422 and does not call the engine", async (_label, body) => {
    const { POST } = await routes();
    const response = await POST(post(body));
    expect(response.status).toBe(422);
    expect(mocks.dismissWhatsNew).not.toHaveBeenCalled();
  });

  it("answers the engine's 422 for a malformed version string", async () => {
    const { POST, AppError } = await routes();
    mocks.dismissWhatsNew.mockRejectedValue(new AppError("validation_failed", "Not a version", 422));
    const response = await POST(post({ version: "banana" }));
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("validation_failed");
  });

  it("refuses a malformed JSON body (400 invalid_json where the wrapper supports it) without dismissing", async () => {
    const { POST } = await routes();
    const response = await POST(post("{not json"));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mocks.dismissWhatsNew).not.toHaveBeenCalled();
  });
});
