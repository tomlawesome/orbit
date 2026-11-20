// Pins the per-project test limits in vitest.config.ts (#1933, decision 81a).
// `default`: testTimeout 15 s in CI (GitLab sets CI=true), 5 s otherwise;
// hookTimeout 10 s either way. `integration`: 15 s and 15 s, unchanged.
// The config is imported fresh with CI set or unset, then the env is restored.
import { afterEach, describe, expect, it, vi } from "vitest";

async function loadProjects(ci) {
  vi.resetModules();
  if (ci) vi.stubEnv("CI", "true");
  else vi.stubEnv("CI", "");
  if (!ci) delete process.env.CI;
  const mod = await import("../vitest.config.ts");
  const config = typeof mod.default === "function" ? await mod.default({}) : mod.default;
  const byName = new Map(config.test.projects.map((p) => [p.test.name, p.test]));
  return byName;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("vitest.config.ts timeouts (#1933)", () => {
  it("default project: testTimeout is 15000 when CI=true", async () => {
    expect((await loadProjects(true)).get("default").testTimeout).toBe(15_000);
  });
  it("default project: testTimeout stays 5000 when CI is unset", async () => {
    expect((await loadProjects(false)).get("default").testTimeout).toBe(5_000);
  });
  it.each([true, false])("default project: hookTimeout is 10000 (CI=%s)", async (ci) => {
    expect((await loadProjects(ci)).get("default").hookTimeout).toBe(10_000);
  });
  it.each([true, false])("integration project: 15000 / 15000 (CI=%s)", async (ci) => {
    const p = (await loadProjects(ci)).get("integration");
    expect(p.testTimeout).toBe(15_000);
    expect(p.hookTimeout).toBe(15_000);
  });
});
