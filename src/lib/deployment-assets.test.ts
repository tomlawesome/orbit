import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../../scripts/process-budget.mjs";
import {
  DEPLOYMENT_ASSETS,
  DEPLOYMENT_ASSETS_LABEL,
  DEPLOYMENT_ASSETS_ROOT,
  DEPLOYMENT_SCRIPTS,
  ENVIRONMENT_FILE,
  SECRETS_DIRECTORY,
  buildManagedPaths,
  deriveAssetDirectories,
} from "./deployment-assets";

// The one asset list install uses since #1212 (guarantee #45), held equal
// to the two other places that name the same files: what the Dockerfile
// bundles into the image (ADR-0019) and repair.sh's restore-transaction
// allowlist. Every bundled script must also pass `bash -n`.

// This file spawns bash -n per script; budget and reasoning:
// scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const installScriptPath = join(repoRoot, "scripts", "install.sh");

/** The files the Dockerfile copies into /opt/orbit/deploy, as deployment-relative paths. */
function dockerfileBundle(): string[] {
  const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8").replace(/\\\n/g, " ");
  const bundle: string[] = [];
  for (const line of dockerfile.split("\n")) {
    const match = /^COPY --chown=root:root (.+) \.\/deploy\/(\S*)$/.exec(line.trim());
    if (!match) continue;
    for (const source of match[1].trim().split(/\s+/)) {
      const name = source.split("/").pop() as string;
      bundle.push(match[2] === "" ? name : `${match[2]}${name}`);
    }
  }
  return bundle;
}

/** repair.sh's restore_transaction_paths, which add .env-orbit and .orbit-secrets to the assets. */
function repairAllowlist(): string[] {
  const repair = readFileSync(join(repoRoot, "scripts", "repair.sh"), "utf8");
  const match = /^readonly -a restore_transaction_paths=\(\n([\s\S]*?)\n\)$/m.exec(repair);
  if (!match) throw new Error("Could not find restore_transaction_paths in repair.sh; it may have been renamed.");
  return match[1].split("\n").map((line) => line.trim()).filter(Boolean);
}

describe("the deployment asset list (guarantee #45)", () => {
  it("is exactly what the Dockerfile bundles into the image", () => {
    expect([...dockerfileBundle()].sort()).toEqual([...DEPLOYMENT_ASSETS].sort());
  });

  it("is repair.sh's restore-transaction allowlist, less the environment file and secrets directory", () => {
    expect(repairAllowlist()).toEqual([...DEPLOYMENT_ASSETS, ENVIRONMENT_FILE, SECRETS_DIRECTORY]);
  });

  // The successful-rollback journey stages a backup of each managed path by
  // hand, and repair's restore removes any managed path with no staged backup
  // as one the transaction created. A path missing here is deleted from the
  // live deployment by a correct rollback, and the journey then fails its
  // manifest check for a reason in the fixture (#1212's recovery-bundle
  // scripts, pipeline 2234).
  it("is what the repair-journeys successful-rollback fixture stages, path for path", () => {
    const harness = readFileSync(join(repoRoot, "scripts", "test-repair-journeys.sh"), "utf8");
    const match = /^ {2}for managed in ([\s\S]*?); do$/m.exec(harness);
    if (!match) throw new Error("Could not find the successful-rollback staging loop in test-repair-journeys.sh.");
    const staged = match[1].split(/[\s\\]+/).filter(Boolean);
    expect(staged).toEqual(repairAllowlist());
  });

  it("names every bundled shell script as a deployment script, and each passes bash -n", () => {
    expect(DEPLOYMENT_SCRIPTS).toEqual(DEPLOYMENT_ASSETS.filter((asset) => asset.startsWith("scripts/")));
    for (const script of DEPLOYMENT_SCRIPTS) {
      const result = failOnProcessDeadline(spawnSync("bash", ["-n", join(repoRoot, script)], { encoding: "utf8", ...processGuard() }), {
        label: `bash -n ${script}`,
      });
      expect(result.status, script).toBe(0);
    }
  });
});

describe("bundled-asset location parity (ADR-0019, install.sh:1371-1372, guarantee #42)", () => {
  const installScript = readFileSync(installScriptPath, "utf8");

  it("agrees with install.sh's own deployment_assets_root", () => {
    const match = /^readonly deployment_assets_root="([^"]+)"$/m.exec(installScript);
    if (!match) throw new Error("Could not find deployment_assets_root in install.sh; it may have been renamed.");
    expect(DEPLOYMENT_ASSETS_ROOT).toBe(match[1]);
  });

  it("agrees with the label install.sh reads that root from, and with the label the Dockerfile stamps on", () => {
    expect(installScript).toContain(`{{index .Config.Labels "${DEPLOYMENT_ASSETS_LABEL}"}}`);
    const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
    expect(dockerfile).toContain(`LABEL ${DEPLOYMENT_ASSETS_LABEL}="${DEPLOYMENT_ASSETS_ROOT}"`);
  });
});

describe("deriveAssetDirectories (install.sh:1333-1341)", () => {
  it("derives the distinct non-'.' parent directories in first-appearance order", () => {
    expect(deriveAssetDirectories(DEPLOYMENT_ASSETS)).toEqual(["config", "scripts"]);
  });

  it("returns an empty array when every asset is at the top level", () => {
    expect(deriveAssetDirectories(["a", "b"])).toEqual([]);
  });

  it("dedupes repeated directories, keeping first-appearance order", () => {
    expect(deriveAssetDirectories(["scripts/a", "config/b", "scripts/c"])).toEqual(["scripts", "config"]);
  });
});

describe("buildManagedPaths (install.sh:1342)", () => {
  it("appends the environment file (file) and secrets directory (directory) after every asset", () => {
    const managed = buildManagedPaths(["a", "b"]);
    expect(managed).toEqual([
      { path: "a", type: "file" },
      { path: "b", type: "file" },
      { path: ENVIRONMENT_FILE, type: "file" },
      { path: SECRETS_DIRECTORY, type: "directory" },
    ]);
  });
});
