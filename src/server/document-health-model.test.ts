import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The `modelExtraction` entry of ADR-0025 section 5: what an administrator
 * sees when the optional `ai` profile is absent, present and answering,
 * present and stopped, or present and failing too often to be useful.
 */

const mocks = vi.hoisted(() => ({
  storageRoot: "",
  configFails: false,
  worker: {
    started: true,
    running: false,
    lastSuccessAt: null as string | null,
    lastErrorAt: null as string | null,
    lastErrorCode: null as string | null,
    lastReconciliationAt: null as string | null,
  },
}));

vi.mock("@/db", () => {
  function builder(): Record<string, unknown> {
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => chain,
      then: (resolve: (rows: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve([{ bytes: 0, count: 0, expiresAt: null }]).then(resolve, reject),
    };
    return chain;
  }
  return { getDb: () => ({ select: () => builder() }) };
});

vi.mock("@/server/document-worker", () => ({
  getDocumentWorkerHealth: () => mocks.worker,
}));

vi.mock("@/server/documents/config", () => ({
  getDocumentConfig: () => {
    if (mocks.configFails) throw new Error("configuration unavailable");
    return {
      storageRoot: mocks.storageRoot,
      scanMode: "disabled" as const,
      clamAv: { host: "127.0.0.1", port: 3310, timeoutMs: 1_000 },
      instanceQuotaBytes: 1_024,
    };
  },
}));

const { getDocumentHealth, modelExtractionState, toPublicDocumentHealth } = await import("./document-health");
const {
  MODEL_FAILURE_RATE_MIN_SAMPLES,
  modelExtractionWindow,
  recordModelExtractionSample,
  resetModelExtractionWindow,
} = await import("./documents/model-extraction");

const MODEL = "a-local-model:latest";

function answering(): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{\"models\":[]}", {
    status: 200,
    headers: { "content-type": "application/json" },
  })));
}

function stopped(): void {
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("connection refused");
  }));
}

function record(samples: string[]): void {
  for (const sample of samples) recordModelExtractionSample(sample as "ready" | "timed_out" | "failed");
}

beforeEach(async () => {
  mocks.storageRoot = await mkdtemp(join(tmpdir(), "orbit-model-health-"));
  mocks.configFails = false;
  resetModelExtractionWindow();
  delete process.env.OLLAMA_MODEL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OLLAMA_MODEL;
});

describe("model extraction in document health", () => {
  it("reports not_configured and stays green when no ai profile is running", async () => {
    const probe = vi.fn();
    vi.stubGlobal("fetch", probe);

    const health = await getDocumentHealth();

    expect(health.modelExtraction).toEqual({
      status: "not_configured",
      reason: "no_profile",
      recent: { samples: 0, failures: 0, timeouts: 0 },
    });
    expect(health.overall).toBe("healthy");
    // A design state is not a dependency: an absent profile is never probed.
    expect(probe).not.toHaveBeenCalled();
  });

  it("stays green with no ai profile even when the window holds old failures", async () => {
    record(["failed", "failed", "failed", "failed", "failed", "failed"]);

    const health = await getDocumentHealth();

    expect(health.modelExtraction.status).toBe("not_configured");
    expect(health.overall).toBe("healthy");
  });

  it("reports unavailable and degrades overall health when the configured model is stopped", async () => {
    process.env.OLLAMA_MODEL = MODEL;
    stopped();

    const health = await getDocumentHealth();

    expect(health.modelExtraction.status).toBe("unavailable");
    expect(health.modelExtraction.reason).toBe("unreachable");
    expect(health.overall).toBe("degraded");
  });

  it("reports ready when the configured model answers", async () => {
    process.env.OLLAMA_MODEL = MODEL;
    answering();
    record(["ready", "ready", "ready"]);

    const health = await getDocumentHealth();

    expect(health.modelExtraction).toEqual({
      status: "ready",
      reason: "answering",
      recent: { samples: 3, failures: 0, timeouts: 0 },
    });
    expect(health.overall).toBe("healthy");
  });

  it("crosses the failure-rate threshold in both directions", async () => {
    process.env.OLLAMA_MODEL = MODEL;
    answering();

    // Two failures in five attempts: below the threshold, so still green.
    record(["ready", "timed_out", "ready", "timed_out", "ready"]);
    const belowRising = await getDocumentHealth();
    expect(belowRising.modelExtraction.status).toBe("ready");
    expect(belowRising.overall).toBe("healthy");

    // Three more failures takes the window above it: degraded, and the reason
    // separates a failing model from an unreachable one.
    record(["failed", "failed", "timed_out"]);
    const above = await getDocumentHealth();
    expect(above.modelExtraction.status).toBe("unavailable");
    expect(above.modelExtraction.reason).toBe("failing");
    expect(above.overall).toBe("degraded");

    // Successes bring it back down again without a restart or a toggle.
    record(["ready", "ready", "ready", "ready", "ready"]);
    const belowFalling = await getDocumentHealth();
    expect(belowFalling.modelExtraction.status).toBe("ready");
    expect(belowFalling.modelExtraction.reason).toBe("answering");
    expect(belowFalling.overall).toBe("healthy");
  });

  it("keeps occasionally slow distinguishable from down", async () => {
    process.env.OLLAMA_MODEL = MODEL;
    answering();
    record(["ready", "ready", "ready", "timed_out", "ready", "ready"]);

    const slow = await getDocumentHealth();
    expect(slow.modelExtraction.status).toBe("ready");
    expect(slow.modelExtraction.recent).toEqual({ samples: 6, failures: 1, timeouts: 1 });
    expect(slow.overall).toBe("healthy");

    stopped();
    const down = await getDocumentHealth();
    expect(down.modelExtraction.status).toBe("unavailable");
    expect(down.modelExtraction.reason).toBe("unreachable");
  });

  it("never names a document or its content in the administrator entry", async () => {
    process.env.OLLAMA_MODEL = MODEL;
    stopped();

    const entry = toPublicDocumentHealth(await getDocumentHealth()).modelExtraction;

    expect(Object.keys(entry).sort()).toEqual(["reason", "recent", "status"]);
    expect(Object.keys(entry.recent).sort()).toEqual(["failures", "samples", "timeouts"]);
    // The one configured value is the model name, and it is not in the entry.
    expect(JSON.stringify(entry)).not.toContain(MODEL);
  });

  it("says unknown rather than guessing when configuration itself fails", async () => {
    process.env.OLLAMA_MODEL = MODEL;
    mocks.configFails = true;

    const health = await getDocumentHealth();

    expect(health.modelExtraction.status).toBe("unavailable");
    expect(health.modelExtraction.reason).toBe("unknown");
    expect(health.overall).toBe("degraded");
  });

  it("reports no profile rather than a fault when configuration fails and none is set", async () => {
    mocks.configFails = true;

    const health = await getDocumentHealth();

    expect(health.modelExtraction.status).toBe("not_configured");
    expect(health.modelExtraction.reason).toBe("no_profile");
  });

  it("holds a small sample below the minimum green, whatever the rate", () => {
    record(Array.from({ length: MODEL_FAILURE_RATE_MIN_SAMPLES - 1 }, () => "failed"));

    expect(modelExtractionState({ configured: true, reachable: true, window: modelExtractionWindow() }).status).toBe("ready");
  });
});
