import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../../scripts/process-budget.mjs";
import { currentDeploymentProfile, isValidLocalModel } from "./deployment-profile";

// Source-extraction parity (issue #295 slice 5), the same awk-by-function-
// name pattern install-transaction.parity.test.ts and target-identity.
// parity.test.ts established: install.sh has no standalone entry point for
// is_valid_local_model / current_deployment_profile, so this test extracts
// (via awk, never hand-copied) the exact current bodies from the real,
// unmodified scripts/install.sh and compares byte-for-byte against this
// module's pure functions. Extraction failing loudly (empty match) if either
// function is renamed is deliberate — see
// docs/adr-notes/295-install-port-plan.md's Flags section.

// This file spawns real awk and bash (a generated driver script); a spawn
// that takes 0.7s quiet took 4.3s on a starved core (#698). Budget and
// reasoning: scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const installScriptPath = join(repoRoot, "scripts", "install.sh");

function extractFunction(name: string): string {
  const script = `
    $0 ~ "^${name}\\\\(\\\\) \\\\{" { found = 1 }
    found { print; if ($0 == "}") { found = 0; exit } }
  `;
  const result = failOnProcessDeadline(spawnSync("awk", [script, installScriptPath], { encoding: "utf8", ...processGuard() }), { label: "extractFunction" });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Could not extract ${name}() from install.sh; it may have been renamed.`);
  }
  return result.stdout;
}

const driverDir = mkdtempSync(join(tmpdir(), "orbit-deployment-profile-parity-driver-"));
const driverPath = join(driverDir, "driver.sh");

function buildDriverScript(): string {
  const functions = ["read_environment_value", "is_valid_local_model", "current_deployment_profile"]
    .map(extractFunction)
    .join("\n");

  return [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    "",
    functions,
    "",
    'mode="$1"; shift',
    'case "$mode" in',
    "  model)",
    "    status=0",
    '    is_valid_local_model "$1" || status=$?',
    '    exit "$status"',
    "    ;;",
    "  profile)",
    '    environment_file="$1"',
    "    status=0",
    "    profile=\"$(current_deployment_profile)\" || status=$?",
    '    printf "status=%s profile=%s\\n" "$status" "$profile"',
    "    ;;",
    "esac",
    "",
  ].join("\n");
}

writeFileSync(driverPath, buildDriverScript(), { mode: 0o755 });

afterAll(() => {
  rmSync(driverDir, { recursive: true, force: true });
});

function runDriver(...args: string[]): { status: number; stdout: string } {
  const result = failOnProcessDeadline(spawnSync("bash", [driverPath, ...args], { encoding: "utf8", ...processGuard() }), { label: "runDriver" });
  return { status: result.status ?? -1, stdout: result.stdout.trim() };
}

describe("is_valid_local_model parity (install.sh:617-621)", () => {
  const cases = [
    "llama3",
    "llama3:8b",
    "family/model-name.v2:tag_1",
    "",
    "-leading-hyphen",
    "a".repeat(129),
    "has spaces",
    "bad$char",
  ];

  for (const candidate of cases) {
    it(`agrees for ${JSON.stringify(candidate)}`, () => {
      const bash = runDriver("model", candidate);
      expect(isValidLocalModel(candidate)).toBe(bash.status === 0);
    });
  }
});

describe("current_deployment_profile parity (install.sh:632-661, guarantee #23)", () => {
  const sandboxes: string[] = [];
  afterAll(() => {
    for (const sandbox of sandboxes) rmSync(sandbox, { recursive: true, force: true });
  });

  function makeSandbox(envOrbitContent: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), "orbit-deployment-profile-parity-sandbox-"));
    sandboxes.push(dir);
    if (envOrbitContent !== null) {
      writeFileSync(join(dir, ".env-orbit"), envOrbitContent, { mode: 0o600 });
    }
    return dir;
  }

  const fixtures: Array<{ name: string; content: string | null }> = [
    { name: "no .env-orbit at all", content: null },
    { name: "empty triple (standard)", content: "" },
    { name: "processing triple", content: "COMPOSE_PROFILES=processing\nTIKA_URL=http://orbit-tika:9998\n" },
    { name: "ai triple", content: "COMPOSE_PROFILES=ai\nOLLAMA_MODEL=llama3\n" },
    {
      name: "full triple",
      content: "COMPOSE_PROFILES=processing,ai\nTIKA_URL=http://orbit-tika:9998\nOLLAMA_MODEL=llama3\n",
    },
    { name: "ai triple with invalid model", content: "COMPOSE_PROFILES=ai\nOLLAMA_MODEL=bad space\n" },
    { name: "processing triple with unexpected TIKA_URL", content: "COMPOSE_PROFILES=processing\nTIKA_URL=http://other:9998\n" },
    { name: "unrecognised COMPOSE_PROFILES value", content: "COMPOSE_PROFILES=bogus\n" },
    { name: "empty COMPOSE_PROFILES but stray TIKA_URL", content: "TIKA_URL=http://orbit-tika:9998\n" },
  ];

  for (const fixture of fixtures) {
    it(`agrees: ${fixture.name}`, () => {
      const dir = makeSandbox(fixture.content);
      const environmentFile = join(dir, ".env-orbit");
      const bash = runDriver("profile", environmentFile);
      const result = currentDeploymentProfile(dir, fixture.content !== null);

      if (result.ok) {
        expect(bash.stdout).toBe(`status=0 profile=${result.profile}`);
      } else {
        expect(bash.stdout).toMatch(/^status=[1-9]/);
      }
    });
  }
});
