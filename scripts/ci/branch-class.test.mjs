import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// #1362: scripts/ci/branch-class.sh <branch> prints one word naming its class.
const script = fileURLToPath(new URL("./branch-class.sh", import.meta.url));

function run(...args) {
  return spawnSync("bash", ["-euo", "pipefail", script, ...args], { encoding: "utf8" });
}

describe("branch-class.sh", () => {
  it.each([
    ["dev", "dev"],
    ["preview", "preview"],
    ["main", "main"],
    ["hotfix/urgent", "hotfix"],
    ["hotfix/a/b", "hotfix"],
    ["feature/x", "other"],
    ["ci/v037-three-1362", "other"],
    ["", "other"],
    ["hotfix", "other"],
    ["devx", "other"],
    ["preview-1", "other"],
  ])("classifies %j as %s", (branch, word) => {
    const result = run(branch);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${word}\n`);
  });

  it.each([[[]], [["dev", "main"]]])("exits 2 with usage on stderr for args %j", (args) => {
    const result = run(...args);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/usage/i);
  });
});
