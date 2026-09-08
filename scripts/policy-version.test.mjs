import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

/*
 * scripts/ci/policy-version.sh is what binds "which rules judged this image"
 * into validation evidence (#661, #573 ruling 24). Its whole value is three
 * properties: same tree, same value; any listed policy file changing changes
 * the value; a listed file missing fails loudly. Each run copies the script
 * and the real policy files -- the actual list, not stand-ins, so the list
 * in the script and the files in the repository cannot drift apart silently
 * -- into a throwaway root, because the change-detection case must edit one.
 */
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const repoRoot = new URL("..", import.meta.url).pathname;

const POLICY_FILES = [
  ".github/supply-chain-policy.json",
  "scripts/ci/licence-policy.mjs",
  "scripts/ci/scan-image.sh",
  "scripts/ci/verify-image-identity.sh",
  "scripts/supply-chain-policy.mjs",
];

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), "policy-version-"));
  for (const file of [...POLICY_FILES, "scripts/ci/policy-version.sh"]) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    copyFileSync(join(repoRoot, file), join(root, file));
  }
  return root;
}

function run(root) {
  return failOnProcessDeadline(
    spawnSync("bash", [join(root, "scripts/ci/policy-version.sh")], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
      ...processGuard(),
    }),
    { label: "policy-version" },
  );
}

describe("policy-version.sh", () => {
  it("is deterministic on an unchanged tree and prints a sha256 value", () => {
    const root = makeTree();
    const first = run(root);
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    expect(first.stdout.trim()).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(run(root).stdout).toBe(first.stdout);
  });

  it("changes when any listed policy file changes", () => {
    const baseline = run(makeTree()).stdout;
    for (const file of POLICY_FILES) {
      const root = makeTree();
      appendFileSync(join(root, file), "\n// a policy change\n");
      const changed = run(root);
      expect(changed.status, file).toBe(0);
      expect(changed.stdout, file).not.toBe(baseline);
    }
  });

  it("fails loudly, naming the file, when a listed policy file is missing", () => {
    const root = makeTree();
    rmSync(join(root, "scripts/ci/scan-image.sh"));
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "policy-version: policy file missing from this checkout: scripts/ci/scan-image.sh",
    );
  });

  it("lists exactly the policy files the verifier's binding is documented over", () => {
    // The list in the script is the contract; if it changes, this test names
    // the divergence so the change is deliberate and travels with a policy
    // bump, not by accident.
    const script = spawnSync("cat", [join(repoRoot, "scripts/ci/policy-version.sh")], {
      encoding: "utf8",
    }).stdout;
    for (const file of POLICY_FILES) expect(script).toContain(file);
  });
});
