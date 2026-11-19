import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { processGuard } from "./process-budget.mjs";

// Group 6 L-S1: the install suites make orbit-install-* folders in the system
// temporary directory; none was ever removed, so every run left more behind.
describe("scripts/install-test-support.mjs temporary folders", () => {
  it("are removed when the process that made them exits", () => {
    const tmp = mkdtempSync(join(tmpdir(), "support-cleanup-"));
    try {
      const code = [
        'const s = await import("./scripts/install-test-support.mjs");',
        "s.makeFakeBin();",
        "s.makeTarget();",
      ].join("\n");
      const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", code], {
        encoding: "utf8",
        cwd: join(import.meta.dirname, ".."),
        env: { ...process.env, TMPDIR: tmp },
        ...processGuard(),
      });
      expect(r.status, r.stderr).toBe(0);
      expect(readdirSync(tmp).filter((name) => name.startsWith("orbit-install-"))).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
