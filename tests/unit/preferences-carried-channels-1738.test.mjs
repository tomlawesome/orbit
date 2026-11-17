import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1738 review: the preferences route writes the notification channels only
 * when the body carries them (its `carried()` guard). A theme or text-size
 * pick, whose body has no channels, must not revert a channel flipped in
 * between -- the schema's default would otherwise write true over a stored
 * false -- nor cancel pending deliveries. A body that does carry a channel is
 * still written, and a false one cancels that channel's pending deliveries.
 */
const mocks = vi.hoisted(() => ({
  getAuthConfig: vi.fn(),
  requireSession: vi.fn(),
  assertOutsideMaintenance: vi.fn(),
  assertKeyUsable: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/lib/auth/session", async (importOriginal) => ({ ...(await importOriginal()), requireSession: mocks.requireSession }));
vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: mocks.assertOutsideMaintenance }));
vi.mock("orbit/server/key-state", () => ({ assertKeyUsable: mocks.assertKeyUsable, noteRefusedSignIn: vi.fn() }));
vi.mock("orbit/db", () => ({ getDb: mocks.getDb }));

const { PUT } = await import("../../web/src/routes/api/preferences/+server.js");
const { csrfTokenForSession } = await import("orbit/lib/auth/session");

const config = { appUrl: new URL("https://orbit.example"), sessionSecret: "s".repeat(48) };
const session = { id: "s-1", token: "tok-1", user: { id: "user-1" } };

/** A stand-in database holding an existing row whose channels are both off; a conflict applies only `set`. */
function stubDatabase() {
  let stored = { themeId: "afterdark", textSize: "comfortable", emailNotifications: false, pushNotifications: false, labelDays: 30, skyDriver: "due", planetSize: "cost", importanceOfferDismissed: false };
  const cancelled = vi.fn();
  const db = {
    transaction: async (/** @type {(tx: any) => Promise<void>} */ run) => run(db),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: async (/** @type {{ set: Record<string, any> }} */ { set }) => {
          stored = { ...stored, ...set };
        },
      }),
    }),
    update: () => ({ set: (/** @type {unknown} */ values) => ({ where: async () => { cancelled(values); } }) }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [stored] }) }) }),
  };
  mocks.getDb.mockReturnValue(db);
  return { cancelled, current: () => stored };
}

function put(/** @type {unknown} */ body) {
  return PUT({
    cookies: {},
    route: { id: "/api/preferences" },
    request: new Request("https://orbit.example/api/preferences", {
      method: "PUT",
      headers: { origin: "https://orbit.example", "content-type": "application/json", "x-csrf-token": csrfTokenForSession(session, config) },
      body: JSON.stringify(body),
    }),
  });
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getAuthConfig.mockReturnValue(config);
  mocks.requireSession.mockResolvedValue(session);
});

describe("PUT /api/preferences leaves channels the body does not carry", () => {
  it("a theme-only body keeps both stored channels off and cancels nothing", async () => {
    const { cancelled, current } = stubDatabase();
    const response = await put({ theme: "dawn", textSize: "comfortable" });
    expect(response.status).toBe(200);
    expect(current().themeId).toBe("dawn");
    expect(current().emailNotifications).toBe(false);
    expect(current().pushNotifications).toBe(false);
    expect((await response.json()).preference).toMatchObject({ emailNotifications: false, pushNotifications: false });
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("a body that carries a channel writes it", async () => {
    const { current } = stubDatabase();
    await put({ theme: "dawn", textSize: "comfortable", emailNotifications: true });
    expect(current().emailNotifications).toBe(true);
    expect(current().pushNotifications).toBe(false);
  });

  it("a body that carries a channel as false cancels that channel's pending deliveries", async () => {
    const { cancelled } = stubDatabase();
    await put({ theme: "dawn", textSize: "comfortable", pushNotifications: false });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
});
