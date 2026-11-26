import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { SLOW_GATES, runReadiness } from "./release-readiness.mjs";

/*
 * #1933 (103a): fast_coverage is a slow gate; both fast shards count.
 * Written from the ruling alone. Run: pnpm exec vitest run scripts/release-readiness-fast-coverage-1933.test.mjs
 */
const root = mkdtempSync(join(tmpdir(), "rr-fast-coverage-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const GUIDE = ["acceptance", "roadmap", "notes-review", "owner-approval", "promote-stable", "countersign"];
function repoDir() {
  const dir = join(root, "repo");
  mkdirSync(join(dir, "src", "release-notes"), { recursive: true });
  writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\n## [0.3.9] - 2026-11-16\n\n### Added\n\n- A thing (#1).\n\n## [0.3.8] - 2026-11-10\n\n- Older.\n");
  writeFileSync(
    join(dir, "src", "release-notes", "index.ts"),
    'import { notes as v0_3_8 } from "./v0.3.8";\nimport { notes as v0_3_9 } from "./v0.3.9";\nexport const releaseNotes: ReleaseNotes[] = [v0_3_8, v0_3_9];\n',
  );
  writeFileSync(join(dir, "src", "release-notes", "v0.3.9.ts"), 'export const notes = { version: "v0.3.9" };\n');
  return dir;
}
const lookups = (jobs) => ({
  version: async () => "v0.3.9",
  tagExists: async () => false,
  containsTarget: async () => true,
  baseImageCurrent: async () => true,
  sidecarPinsCurrent: async () => true,
  upgradeMatrix: async () => ({ matrix: "true", launcher: "true", updateFrom: ["v0.3.8", "v0.3.7", "v0.3.6"], newestStable: ["v0.3.8", "v0.3.7", "v0.3.6"] }),
  variableSet: async () => true,
  slowGates: async () => jobs,
  releaseRecord: async () => ({ exists: true, signed: true, guideCommit: "abc123", steps: [...GUIDE] }),
  guideCommit: async () => "abc123",
  guideSteps: async () => [...GUIDE],
  mainTreeEqualsPreview: async () => true,
  ghcrImage: async () => ({ shaTag: true, previewTag: true, handoff: true }),
  evidenceAgeDays: async () => 2,
});
const ok = (job) => ({ job, status: "success" });
const GREEN = [ok("screens_chromium"), ok("smoke"), ok("fast 1/2"), ok("fast 2/2"), ok("fast_coverage")];
async function gate(jobs) {
  const report = await runReadiness({ target: "preview", repoDir: repoDir(), lookups: lookups(jobs) });
  return report.results.find((r) => r.id === "slow-gates-green");
}

describe("release-readiness slow gates with sharded fast (#1933)", () => {
  it("lists fast_coverage in SLOW_GATES", () => {
    expect(SLOW_GATES).toContain("fast_coverage");
    expect(SLOW_GATES).toContain("fast");
  });

  it("passes when both fast shards and fast_coverage are green", async () => {
    expect(SLOW_GATES).toContain("fast_coverage");
    expect((await gate(GREEN)).ok).toBe(true);
  });

  it("fails when fast 1/2 is green but fast 2/2 failed", async () => {
    const r = await gate([ok("screens_chromium"), ok("smoke"), ok("fast 1/2"), { job: "fast 2/2", status: "failed" }, ok("fast_coverage")]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("fast is failed");
    expect(SLOW_GATES).toContain("fast_coverage");
  });

  it("fails when fast_coverage did not run", async () => {
    const r = await gate(GREEN.filter((j) => j.job !== "fast_coverage"));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("fast_coverage did not run");
  });

  it("fails when fast_coverage failed", async () => {
    const r = await gate(GREEN.map((j) => (j.job === "fast_coverage" ? { ...j, status: "failed" } : j)));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("fast_coverage is failed");
  });

  it("names fast_coverage in its success and no-pipeline messages", async () => {
    expect((await gate(GREEN)).message).toContain("fast_coverage");
    expect((await gate(null)).message).toContain("fast_coverage");
  });
});
