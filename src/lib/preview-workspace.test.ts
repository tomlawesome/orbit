import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canApplyCanonicalState,
  fetchPublicReadiness,
  fetchSession,
  fetchWorkspace,
  getWorkspaceFailureMessage,
  STARTUP_RETRY_DELAYS_MS,
  waitForStartupReadiness,
  type WorkspaceFailureCategory,
} from "./preview-workspace";

const hostileDetail = "postgres://user:secret@db.example.test/private?token=raw-token";

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("workspace startup boundary", () => {
  it.each([
    [200, { status: "ready" }, "ready"],
    [200, { status: "maintenance" }, "maintenance"],
    [503, { status: "degraded" }, "degraded"],
  ] as const)("accepts only the public health contract (%s)", async (status, body, expected) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(status, body)));

    await expect(fetchPublicReadiness()).resolves.toBe(expected);
  });

  it.each([
    [200, { status: "degraded" }],
    [503, { status: "ready" }],
    [503, { status: "maintenance" }],
    [503, { error: hostileDetail }],
    [500, { status: "degraded" }],
  ] as const)("does not treat an unknown health response as startup", async (status, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(status, body)));

    await expect(fetchPublicReadiness()).rejects.toMatchObject({ category: "schema" });
  });

  it("proceeds through maintenance like ready: the guarded APIs decide, not the boot gate", async () => {
    let checks = 0;
    await expect(waitForStartupReadiness(
      async () => {
        checks += 1;
        return "maintenance";
      },
      async () => {},
    )).resolves.toBeUndefined();
    expect(checks).toBe(1);
  });

  it("recovers after confirmed degraded readiness without overlapping checks", async () => {
    const readiness: ("degraded" | "ready")[] = ["degraded", "degraded", "ready"];
    const delays: number[] = [];
    let inFlight = 0;
    let maximumInFlight = 0;

    await expect(waitForStartupReadiness(
      async () => {
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return readiness.shift() ?? "ready";
      },
      async (delay) => {
        delays.push(delay);
      },
    )).resolves.toBeUndefined();

    expect(delays).toEqual([...STARTUP_RETRY_DELAYS_MS].slice(0, 2));
    expect(maximumInFlight).toBe(1);
  });

  it("fails with unavailable wording after the bounded startup retry schedule", async () => {
    const check = vi.fn(async () => "degraded" as const);
    const wait = vi.fn(async () => undefined);

    await expect(waitForStartupReadiness(check, wait)).rejects.toMatchObject({
      category: "startup_unavailable",
    });
    expect(check).toHaveBeenCalledTimes(STARTUP_RETRY_DELAYS_MS.length + 1);
    expect(wait).toHaveBeenCalledTimes(STARTUP_RETRY_DELAYS_MS.length);
  });

  it("keeps HTTP 401 on the ordinary signed-out path", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(401, { error: hostileDetail })));

    await expect(fetchSession()).resolves.toBeNull();
  });

  it("classifies rejected requests as network failures without exposing the error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error(hostileDetail)));

    const failure = await fetchSession().catch((error: unknown) => error);
    expect(failure).toMatchObject({ category: "network" });
    expect((failure as Error).message).not.toContain(hostileDetail);
  });

  it("classifies auth_not_configured without exposing response detail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(503, {
      error: { code: "auth_not_configured", message: hostileDetail },
    })));

    const failure = await fetchSession().catch((error: unknown) => error);
    expect(failure).toMatchObject({ category: "auth_not_configured" });
    expect((failure as Error).message).not.toContain(hostileDetail);
    expect((failure as Error).message).not.toMatch(/provider|database|environment|postgres|token/i);
  });

  it("classifies malformed workspace payloads without exposing schema detail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(200, { workspace: hostileDetail })));

    const failure = await fetchWorkspace().catch((error: unknown) => error);
    expect(failure).toMatchObject({ category: "schema" });
    expect((failure as Error).message).not.toContain(hostileDetail);
  });

  it.each([
    "legacy_storage_cleanup",
    "auth_not_configured",
    "session",
    "workspace",
    "network",
    "schema",
    "startup_unavailable",
  ] as WorkspaceFailureCategory[])("uses a fixed safe message for %s", (category) => {
    const message = getWorkspaceFailureMessage(category);

    expect(message).not.toContain(hostileDetail);
    expect(message).not.toMatch(/provider|database|environment|postgres|token/i);
  });
});

describe("canonical state application (#388)", () => {
  const current = {
    generation: 3, latestGeneration: 3,
    sequence: 7, latestSequence: 7,
    sessionMatches: true,
  };

  it("applies a response that is still the newest command", () => {
    expect(canApplyCanonicalState(current)).toBe(true);
  });

  it("refuses a response overtaken by a newer command", () => {
    // The reader kept typing, which sent another command. This older response
    // carries a workspace without those keystrokes; applying it would undo
    // them, and the newer command's own response will carry the truth.
    expect(canApplyCanonicalState({ ...current, latestSequence: 8 })).toBe(false);
  });

  it("refuses a response from a previous session or initialisation", () => {
    expect(canApplyCanonicalState({ ...current, latestGeneration: 4 })).toBe(false);
    expect(canApplyCanonicalState({ ...current, sessionMatches: false })).toBe(false);
  });
});
