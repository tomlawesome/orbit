import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


/*
 * `POST /api/admin/systems`'s own contract (#1052).
 *
 * The Systems card's "new system" button was drawn from the v19 mockup and
 * never wired; this is the route behind it, and what it must refuse matters
 * as much as what it does. Same pattern as tests/unit/availability-route
 * and tests/unit/system-status-route: every collaborator is mocked at its own
 * module boundary and the route file itself runs for real, so this proves the
 * wiring and the order of the gate rather than the collaborators.
 */
const mocks = vi.hoisted(() => ({
  assertOutsideMaintenance: vi.fn(),
  assertCsrf: vi.fn(),
  getAuthConfig: vi.fn(),
  requireSession: vi.fn(),
  requireInstanceAdministrator: vi.fn(),
  requireRecentAuthentication: vi.fn(),
  createHouseholdForOwner: vi.fn(),
}));

vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: mocks.assertOutsideMaintenance }));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/lib/auth/session", () => ({
  requireSession: mocks.requireSession,
  assertCsrf: mocks.assertCsrf,
}));
vi.mock("orbit/server/authorization", () => ({
  requireInstanceAdministrator: mocks.requireInstanceAdministrator,
}));
vi.mock("orbit/lib/auth/recent-auth", () => ({
  requireRecentAuthentication: mocks.requireRecentAuthentication,
}));
vi.mock("orbit/server/admin-repository", () => ({
  createHouseholdForOwner: mocks.createHouseholdForOwner,
  HOUSEHOLD_NAME_LIMIT: 60,
}));

const OWNER = "11111111-1111-4111-8111-111111111111";

/** One request, as SvelteKit hands it to the handler. */
function post(body) {
  return {
    cookies: { get: () => undefined, set: () => {} },
    request: new Request("http://localhost/api/admin/systems", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  };
}

/*
 * The route AND the error classes, from one module-registry generation.
 * `appErrorResponse` decides the status with `instanceof`, and `resetModules`
 * above gives the route a fresh copy of `@/lib/errors` — so an AppError built
 * from a copy imported at the top of this file is a *different* class and
 * every refusal below would arrive as a 500.
 */
async function route() {
  const [server, errors, authErrors] = await Promise.all([
    import("../../web/src/routes/api/admin/systems/+server.js"),
    import("orbit/lib/errors"),
    import("orbit/lib/auth/errors"),
  ]);
  return { POST: server.POST, AppError: errors.AppError, AuthError: authErrors.AuthError };
}

describe("POST /api/admin/systems (#1052)", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.assertOutsideMaintenance.mockReset().mockResolvedValue(undefined);
    mocks.assertCsrf.mockReset();
    mocks.getAuthConfig.mockReset().mockReturnValue({});
    mocks.requireSession.mockReset().mockResolvedValue({
      user: { id: "admin-1", email: "admin@example.com" },
    });
    mocks.requireInstanceAdministrator.mockReset().mockResolvedValue(undefined);
    mocks.requireRecentAuthentication.mockReset().mockResolvedValue({
      userId: "admin-1", intent: "system_create", method: "password",
    });
    mocks.createHouseholdForOwner.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates the household with the named owner and answers 201 (happy path)", async () => {
    mocks.createHouseholdForOwner.mockResolvedValue({
      id: "hh-new", name: "Ridge Farm", ownerId: OWNER,
    });

    const { POST } = await route();
    const response = await POST(post({ name: "Ridge Farm", ownerId: OWNER, currentPassword: "s3cret" }));

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      household: { id: "hh-new", name: "Ridge Farm", ownerId: OWNER },
    });
    expect(mocks.createHouseholdForOwner).toHaveBeenCalledWith("admin-1", {
      name: "Ridge Farm", ownerId: OWNER,
    });
  });

  it("re-challenges the acting administrator for the system_create intent (ADR-0023 §5)", async () => {
    mocks.createHouseholdForOwner.mockResolvedValue({ id: "hh-new", name: "Ridge Farm", ownerId: OWNER });

    const { POST } = await route();
    await POST(post({ name: "Ridge Farm", ownerId: OWNER, currentPassword: "s3cret" }));

    expect(mocks.requireRecentAuthentication).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ user: expect.objectContaining({ id: "admin-1" }) }),
      expect.objectContaining({ currentPassword: "s3cret" }),
      "system_create",
    );
  });

  it("refuses a non-administrator before anything is created", async () => {
    const { POST, AppError } = await route();
    mocks.requireInstanceAdministrator.mockRejectedValue(
      new AppError("administrator_required", "Orbit administrator access is required", 403),
    );

    const response = await POST(post({ name: "Ridge Farm", ownerId: OWNER }));

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("administrator_required");
    expect(mocks.createHouseholdForOwner).not.toHaveBeenCalled();
  });

  it("refuses an empty name", async () => {
    const { POST } = await route();
    const response = await POST(post({ name: "   ", ownerId: OWNER }));

    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("validation_failed");
    expect(mocks.createHouseholdForOwner).not.toHaveBeenCalled();
  });

  it("refuses a name over the 60-character limit", async () => {
    const { POST } = await route();
    const response = await POST(post({ name: "x".repeat(61), ownerId: OWNER }));

    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("validation_failed");
    expect(mocks.createHouseholdForOwner).not.toHaveBeenCalled();
  });

  it("refuses an owner that is not a user identifier at all", async () => {
    const { POST } = await route();
    const response = await POST(post({ name: "Ridge Farm", ownerId: "nobody" }));

    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("validation_failed");
    expect(mocks.createHouseholdForOwner).not.toHaveBeenCalled();
  });

  it("carries the engine's refusal for an owner who is not a registered user", async () => {
    const { POST, AppError } = await route();
    mocks.createHouseholdForOwner.mockRejectedValue(
      new AppError("user_not_found", "That registered Orbit user is no longer available", 404),
    );

    const response = await POST(post({ name: "Ridge Farm", ownerId: OWNER }));

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("user_not_found");
  });

  it("carries the refusal when the administrator cannot prove it is them", async () => {
    const { POST, AuthError } = await route();
    mocks.requireRecentAuthentication.mockRejectedValue(
      new AuthError("recent_authentication_required", "Confirm it is you before making this change", 403),
    );

    const response = await POST(post({ name: "Ridge Farm", ownerId: OWNER }));

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("recent_authentication_required");
    expect(mocks.createHouseholdForOwner).not.toHaveBeenCalled();
  });
});
