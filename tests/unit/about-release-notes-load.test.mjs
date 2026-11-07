import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1713: the About page's own server load hands the page its "Release notes"
 * as `data.releaseNotes`, the same { version, releases } shape GET
 * /api/whats-new answers. No new route: the page already has a server load
 * and the session is on locals. The engine (readReleaseNotes, beside
 * readWhatsNew in src/server/whats-new.ts) is mocked at its module boundary;
 * tests/integration/about-release-notes.test.ts covers it against PostgreSQL.
 */
const mocks = vi.hoisted(() => ({
  readReleaseNotes: vi.fn(),
  readWhatsNew: vi.fn(),
  dismissWhatsNew: vi.fn(),
  recordNewAccountSeenVersion: vi.fn(),
  prebuiltLibraries: vi.fn(),
}));

vi.mock("orbit/server/whats-new", () => ({
  readReleaseNotes: mocks.readReleaseNotes,
  readWhatsNew: mocks.readWhatsNew,
  dismissWhatsNew: mocks.dismissWhatsNew,
  recordNewAccountSeenVersion: mocks.recordNewAccountSeenVersion,
}));
vi.mock("../../web/src/lib/server/about-libraries.js", () => ({ prebuiltLibraries: mocks.prebuiltLibraries }));

const LIBRARIES = [{ name: "zod", version: "4.0.0", licence: "MIT", author: "", source: "https://zod.dev/" }];
const ANSWER = {
  version: "v0.3.7",
  releases: [{ version: "v0.3.7", forEveryone: [{ lead: "L", text: "T." }] }],
};

/** A SvelteKit server-load event; `session` is what hooks.server put on locals. */
function event(session = { id: "session-1", user: { id: "user-1", isInstanceAdmin: false } }) {
  return {
    locals: session ? { session } : {},
    url: new URL("http://localhost/about"),
    params: {},
    route: { id: "/about" },
    cookies: { get: () => undefined, set: () => {} },
    request: new Request("http://localhost/about"),
    fetch: vi.fn(async () => new Response("{}", { status: 404 })),
    depends: () => {},
    setHeaders: () => {},
    parent: async () => ({}),
    isDataRequest: false,
  };
}

async function load(e = event()) {
  const { load: run } = await import("../../web/src/routes/about/+page.server.js");
  return /** @type {any} */ (await run(/** @type {any} */ (e)));
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("ORBIT_FIXTURES", "");
  vi.stubEnv("ORBIT_VERSION", "v0.3.7");
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.readReleaseNotes.mockResolvedValue(ANSWER);
  mocks.prebuiltLibraries.mockResolvedValue(LIBRARIES);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the About page load carries the release notes (#1713)", () => {
  it("hands the page the engine's answer for the session's own user and the running version", async () => {
    const data = await load();
    expect(data.releaseNotes).toEqual(ANSWER);
    expect(mocks.readReleaseNotes).toHaveBeenCalledTimes(1);
    expect(mocks.readReleaseNotes).toHaveBeenCalledWith("user-1", expect.objectContaining({ runningVersion: "v0.3.7" }));
  });

  it("asks for the session's user and nobody else, even an administrator's", async () => {
    await load(event({ id: "s-2", user: { id: "admin-9", isInstanceAdmin: true } }));
    expect(mocks.readReleaseNotes.mock.calls[0][0]).toBe("admin-9");
  });

  it("leaves the role to the engine: it passes no isAdmin of its own, as GET /api/whats-new does not", async () => {
    await load(event({ id: "s-2", user: { id: "user-1", isInstanceAdmin: true } }));
    const options = mocks.readReleaseNotes.mock.calls[0][1] ?? {};
    expect("isAdmin" in options).toBe(false);
  });

  it("passes an unset ORBIT_VERSION on as missing, not as a made-up value", async () => {
    vi.stubEnv("ORBIT_VERSION", undefined);
    delete process.env.ORBIT_VERSION;
    await load();
    const options = mocks.readReleaseNotes.mock.calls[0][1] ?? {};
    expect(options.runningVersion ?? null).toBeNull();
  });

  it("still carries the libraries as before", async () => {
    const data = await load();
    expect(data.libraries).toEqual(LIBRARIES);
  });

  it("records nothing: it calls no what's-new write, only the read", async () => {
    await load();
    expect(mocks.dismissWhatsNew).not.toHaveBeenCalled();
    expect(mocks.recordNewAccountSeenVersion).not.toHaveBeenCalled();
    /* readWhatsNew records a new account's seen version, so the page must not use it. */
    expect(mocks.readWhatsNew).not.toHaveBeenCalled();
  });

  it("answers the same as GET /api/whats-new under fixtures -- an empty list -- without the engine or a session", async () => {
    vi.stubEnv("ORBIT_FIXTURES", "1");
    const data = await load(event(null));
    expect(data.releaseNotes).toEqual({ version: null, releases: [] });
    expect(mocks.readReleaseNotes).not.toHaveBeenCalled();
  });

  it("reads nothing for a visitor with no session, and answers an empty list", async () => {
    const data = await load(event(null));
    expect(mocks.readReleaseNotes).not.toHaveBeenCalled();
    expect(data.releaseNotes?.releases ?? []).toEqual([]);
  });
});
