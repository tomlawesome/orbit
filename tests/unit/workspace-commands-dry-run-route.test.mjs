import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * `POST /api/workspace/commands` with `dryRun: true` (ADR-0034 decision 3 as
 * amended 2026-10-09, #1325): a dry run is a question, so it answers 200 with
 * the verdict in the body -- `{}` when the save would go through, `{ refusal:
 * { code, message } }` when the engine would refuse it, with the same code and
 * words the real call puts in its 4xx `error` envelope. The real save keeps
 * its 4xx. Same pattern as tests/unit/system-status-route.test.mjs: every
 * collaborator the gate wraps is mocked at its module boundary, the route file
 * and the engine's own parse run for real, so this pins the contract rather
 * than the collaborators (tests/integration/command-dry-run.test.ts runs the
 * same contract against a database).
 */
const mocks = vi.hoisted(() => ({
  assertOutsideMaintenance: vi.fn(),
  getAuthConfig: vi.fn(),
  requireSession: vi.fn(),
  assertCsrf: vi.fn(),
  checkWorkspaceCommand: vi.fn(),
  applyWorkspaceCommand: vi.fn(),
}));

vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: mocks.assertOutsideMaintenance }));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/lib/auth/session", () => ({
  requireSession: mocks.requireSession,
  assertCsrf: mocks.assertCsrf,
}));
vi.mock("orbit/server/workspace-repository", () => ({
  checkWorkspaceCommand: mocks.checkWorkspaceCommand,
  applyWorkspaceCommand: mocks.applyWorkspaceCommand,
}));

const session = { id: "s-1", user: { id: "u-1" } };
const householdId = randomUUID();
const itemId = randomUUID();

/** @param {Record<string, unknown>} [item] */
function upsert(item = {}) {
  return {
    type: "item.upsert",
    householdId,
    kind: "inspection",
    item: {
      id: itemId, sectionId: randomUUID(), title: "MOT", currency: "GBP",
      dueDate: "2026-11-02", recurrenceMonths: 12, version: 2, ...item,
    },
    activity: { id: randomUUID(), itemId, occurredAt: "2026-10-09T09:00:00.000Z" },
  };
}

/** @param {Record<string, unknown>} body */
function post(body) {
  return {
    cookies: {},
    request: new Request("http://localhost/api/workspace/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  };
}

async function route() {
  const { POST } = await import("../../web/src/routes/api/workspace/commands/+server.js");
  return POST;
}

const nameMissing = { code: "item_name_missing", message: "not yet — give it a name" };

describe("POST /api/workspace/commands with dryRun (ADR-0034 decision 3, amended)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mocks.assertOutsideMaintenance.mockReset().mockResolvedValue(undefined);
    mocks.getAuthConfig.mockReset().mockReturnValue({});
    mocks.requireSession.mockReset().mockResolvedValue(session);
    mocks.assertCsrf.mockReset();
    mocks.checkWorkspaceCommand.mockReset().mockResolvedValue(undefined);
    mocks.applyWorkspaceCommand.mockReset().mockResolvedValue({ households: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("answers an empty success when the engine would accept, and writes nothing", async () => {
    const POST = await route();
    const response = await POST(post({ ...upsert(), dryRun: true }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({});
    expect(mocks.checkWorkspaceCommand).toHaveBeenCalledTimes(1);
    expect(mocks.checkWorkspaceCommand.mock.calls[0][2]).not.toHaveProperty("dryRun");
    expect(mocks.applyWorkspaceCommand).not.toHaveBeenCalled();
  });

  it("answers a parse refusal as a 200 verdict, in the member's words", async () => {
    const POST = await route();
    const response = await POST(post({ ...upsert({ title: "  " }), dryRun: true }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ refusal: nameMissing });
    expect(mocks.checkWorkspaceCommand).not.toHaveBeenCalled();
    expect(mocks.applyWorkspaceCommand).not.toHaveBeenCalled();
  });

  it("answers the repository's own refusal as a 200 verdict, with the real call's code and words", async () => {
    const { AppError } = await import("orbit/lib/app-error");
    mocks.checkWorkspaceCommand.mockRejectedValue(new AppError("version_conflict", "That item changed under you", 409));
    const POST = await route();
    const response = await POST(post({ ...upsert({ version: 7 }), dryRun: true }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ refusal: { code: "version_conflict", message: "That item changed under you" } });
    expect(mocks.applyWorkspaceCommand).not.toHaveBeenCalled();
  });

  it("still fails a dry run the engine could not answer: a fault is not a verdict", async () => {
    mocks.checkWorkspaceCommand.mockRejectedValue(new Error("connection refused"));
    const POST = await route();
    const response = await POST(post({ ...upsert(), dryRun: true }));

    expect(response.status).toBe(500);
    expect((await response.json()).error).toMatchObject({ code: "internal_error" });
  });

  it("keeps the real save's 422 for the same refusal", async () => {
    const POST = await route();
    const response = await POST(post(upsert({ title: "  " })));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: nameMissing });
    expect(mocks.applyWorkspaceCommand).not.toHaveBeenCalled();
  });

  it("answers the same verdict from the fixture branch, without a session or the engine", async () => {
    vi.stubEnv("ORBIT_FIXTURES", "1");
    const POST = await route();

    const refused = await POST(post({ ...upsert({ title: "  " }), dryRun: true }));
    expect(refused.status).toBe(200);
    expect(await refused.json()).toEqual({ refusal: nameMissing });

    const accepted = await POST(post({ ...upsert(), dryRun: true }));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({});

    expect(mocks.requireSession).not.toHaveBeenCalled();
    expect(mocks.checkWorkspaceCommand).not.toHaveBeenCalled();
    expect(mocks.applyWorkspaceCommand).not.toHaveBeenCalled();
  });
});
