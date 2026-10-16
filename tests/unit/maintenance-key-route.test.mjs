import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1405: /maintenance is one route with two kinds of closure. `kind: "window"`
 * is the operator's scheduled window as before. `kind: "key"` is Orbit holding
 * no usable encryption key: no entries, no expected return (nothing says when
 * the key will be back), and the instance's public contact address, if one is
 * set, because it is the one address Orbit can still read and the only one a
 * member can be pointed at while nobody can sign in. The key kind is decided
 * first and never redirects home, because the operator's window being closed
 * says nothing about the key.
 */
const mocks = vi.hoisted(() => ({
  getKeyState: vi.fn(),
  readPublicContactAddress: vi.fn(),
  readMaintenanceState: vi.fn(),
}));

vi.mock("orbit/server/key-state", () => ({ getKeyState: mocks.getKeyState }));
vi.mock("orbit/server/instance-contact", () => ({ readPublicContactAddress: mocks.readPublicContactAddress }));
vi.mock("orbit/server/maintenance", () => ({ readMaintenanceState: mocks.readMaintenanceState }));

const UNUSABLE = { verdict: "unusable", reason: "mismatch", heldKeyId: "a".repeat(24), storedKeyId: "b".repeat(24) };

const closedWindow = {
  effectivelyActive: false, active: false, expectedEndAt: null, openWindow: null, scheduledWindows: [],
};
const openWindow = {
  ...closedWindow,
  effectivelyActive: true,
  active: true,
  expectedEndAt: new Date("2026-09-04T22:00:00.000Z"),
  openWindow: {
    expectedEndAt: new Date("2026-09-04T22:00:00.000Z"),
    updates: [{ id: "u1", kind: "started", body: "Moving storage.", publishedAt: new Date("2026-09-04T21:00:00.000Z") }],
  },
};

function load(url = "http://orbit.invalid/maintenance") {
  const setHeaders = vi.fn();
  return import("../../web/src/routes/maintenance/+page.server.js")
    .then(({ load }) => load({ url: new URL(url), setHeaders }))
    .then((data) => ({ data, setHeaders }));
}

beforeEach(() => {
  vi.resetModules();
  delete process.env.ORBIT_FIXTURES;
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getKeyState.mockReturnValue({ verdict: "usable", heldKeyId: "a".repeat(24) });
  mocks.readPublicContactAddress.mockResolvedValue(null);
  mocks.readMaintenanceState.mockResolvedValue(closedWindow);
});

afterEach(() => {
  delete process.env.ORBIT_FIXTURES;
});

describe("/maintenance when Orbit has no usable encryption key (#1405)", () => {
  it("hands the screen the key kind: no entries, no return time", async () => {
    mocks.getKeyState.mockReturnValue(UNUSABLE);

    const { data } = await load();

    expect(data.maintenance).toEqual({ kind: "key", entries: [], expectedEndAt: null, contactAddress: null });
  });

  it("carries the public contact address when one is set", async () => {
    mocks.getKeyState.mockReturnValue(UNUSABLE);
    mocks.readPublicContactAddress.mockResolvedValue("help@example.invalid");

    const { data } = await load();

    expect(data.maintenance).toMatchObject({ kind: "key", contactAddress: "help@example.invalid" });
  });

  it("shows no address, and still shows the screen, when the contact address cannot be read", async () => {
    mocks.getKeyState.mockReturnValue(UNUSABLE);
    mocks.readPublicContactAddress.mockRejectedValue(new Error("database away"));

    const { data } = await load();

    expect(data.maintenance).toEqual({ kind: "key", entries: [], expectedEndAt: null, contactAddress: null });
  });

  it("treats a verdict not yet taken as the key kind", async () => {
    mocks.getKeyState.mockReturnValue({ verdict: "unknown" });

    const { data } = await load();

    expect(data.maintenance).toMatchObject({ kind: "key" });
  });

  it("does not go home because the operator's window is closed: the key is the reason, not the window", async () => {
    mocks.getKeyState.mockReturnValue(UNUSABLE);
    mocks.readMaintenanceState.mockResolvedValue(closedWindow);

    await expect(load()).resolves.toBeDefined();
    expect(mocks.readMaintenanceState).not.toHaveBeenCalled();
  });

  it("is never stored, and carries no key id or reason in what the page is handed", async () => {
    mocks.getKeyState.mockReturnValue(UNUSABLE);

    const { data, setHeaders } = await load();

    expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "no-store" });
    const handed = JSON.stringify(data);
    expect(handed).not.toContain("a".repeat(24));
    expect(handed).not.toContain("b".repeat(24));
    expect(handed).not.toContain("mismatch");
  });
});

describe("/maintenance when the key is usable (#1405 changes nothing here)", () => {
  it("sends a reader home when no operator window is open, as before", async () => {
    mocks.readMaintenanceState.mockResolvedValue(closedWindow);

    await expect(load()).rejects.toMatchObject({ status: 303, location: "/" });
  });

  it("hands the screen the window kind with the window's own entries", async () => {
    mocks.readMaintenanceState.mockResolvedValue(openWindow);

    const { data } = await load();

    expect(data.maintenance.kind).toBe("window");
    expect(data.maintenance.entries).toHaveLength(1);
    expect(data.maintenance.expectedEndAt).toBe("2026-09-04T22:00:00.000Z");
  });
});

describe("/maintenance under the fixture harness (#1405)", () => {
  beforeEach(() => {
    process.env.ORBIT_FIXTURES = "1";
  });

  it("renders the key kind for ?kind=key, without an address", async () => {
    const { data } = await load("http://orbit.invalid/maintenance?kind=key");

    expect(data.maintenance).toEqual({ kind: "key", entries: [], expectedEndAt: null, contactAddress: null });
    expect(mocks.getKeyState).not.toHaveBeenCalled();
  });

  it("renders the key kind with a contact address for ?kind=key&contact=1", async () => {
    const { data } = await load("http://orbit.invalid/maintenance?kind=key&contact=1");

    expect(data.maintenance).toMatchObject({ kind: "key", entries: [], expectedEndAt: null });
    expect(data.maintenance.contactAddress).toEqual(expect.stringMatching(/^[^@\s]+@[^@\s]+\.[^@\s]+$/u));
  });

  it("still renders the window by default", async () => {
    const { data } = await load("http://orbit.invalid/maintenance");

    expect(data.maintenance.kind).toBe("window");
    expect(data.maintenance.entries.length).toBeGreaterThan(1);
  });
});
