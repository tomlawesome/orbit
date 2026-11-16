import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../../scripts/process-budget.mjs";
import {
  DEPLOYMENT_ASSETS,
  DEPLOYMENT_ASSETS_LABEL,
  DEPLOYMENT_ASSETS_ROOT,
  DEPLOYMENT_FILE_LIST,
  DEPLOYMENT_SCRIPTS,
  ENVIRONMENT_FILE,
  SECRETS_DIRECTORY,
  buildManagedPaths,
  deploymentAssetSource,
  deriveAssetDirectories,
  renderDeploymentFileList,
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

  it("is repair.sh's restore-transaction allowlist, less the environment file, secrets directory and file list", () => {
    // #1496: the generated manifest is restored with the rest, so it is on the allowlist too.
    expect(repairAllowlist()).toEqual([...DEPLOYMENT_ASSETS, ENVIRONMENT_FILE, SECRETS_DIRECTORY, DEPLOYMENT_FILE_LIST]);
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

  // docs/administrator-operations.md gives scripts/end-maintenance.sh as the
  // host-side emergency command; a deployment that lacks it has nothing to
  // run when the app cannot lift maintenance itself (#1316).
  it("includes scripts/end-maintenance.sh, the host-side emergency command the administrator docs give", () => {
    expect(DEPLOYMENT_ASSETS).toContain("scripts/end-maintenance.sh");
  });

  // The document-key rotation overlay is run from the deployment directory,
  // so a deployment that lacks it cannot finish or abort a rotation (#1316).
  it("includes docker-compose.kek-rotation.yml, the document-key rotation overlay", () => {
    expect(DEPLOYMENT_ASSETS).toContain("docker-compose.kek-rotation.yml");
  });

  it("names every bundled shell script as a deployment script, and each passes bash -n", () => {
    expect(DEPLOYMENT_SCRIPTS).toEqual(DEPLOYMENT_ASSETS.filter((asset) => deploymentAssetSource(asset).startsWith("scripts/")));
    for (const script of DEPLOYMENT_SCRIPTS) {
      const result = failOnProcessDeadline(spawnSync("bash", ["-n", join(repoRoot, deploymentAssetSource(script))], { encoding: "utf8", ...processGuard() }), {
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
      { path: DEPLOYMENT_FILE_LIST, type: "file" },
    ]);
  });

  it("includes .orbit-files as a file, so the transaction preflights, backs up, rolls back and journals it (#1496)", () => {
    expect(buildManagedPaths(DEPLOYMENT_ASSETS)).toContainEqual({ path: ".orbit-files", type: "file" });
  });

  it("does not add .orbit-files to DEPLOYMENT_ASSETS: it is generated, not copied from the image (#1496)", () => {
    expect(DEPLOYMENT_ASSETS).not.toContain(".orbit-files");
  });
});

// #1496: the manifest of the files Orbit installed, which the launcher's Remove reads.
describe("renderDeploymentFileList (#1496)", () => {
  /** install.sh's journal path_pattern (scripts/install.sh read_engine_journal). */
  const journalPath = /^[A-Za-z0-9._-]{1,255}(\/[A-Za-z0-9._-]{1,255})*\/?$/u;
  const rendered = () => renderDeploymentFileList(DEPLOYMENT_ASSETS);
  const lines = () => rendered().slice(0, -1).split("\n");

  it("is named .orbit-files", () => {
    expect(DEPLOYMENT_FILE_LIST).toBe(".orbit-files");
  });

  it("renders the header, every asset in order, .env-orbit, .orbit-secrets/ and its own name, byte for byte", () => {
    expect(rendered()).toBe(
      [
        "# Files Orbit installed in this folder. orbit-launcher's Remove reads this list; do not edit.",
        "docker-compose.yml",
        "docker-compose.mail.yml",
        "docker-compose.kek-rotation.yml",
        "docker-compose.no-document-key.yml",
        "docker-compose.scanner-off.yml",
        ".env-orbit.example",
        "config/tika-config.json",
        "scripts/configure.sh",
        "scripts/installer-ui.sh",
        "scripts/backup.sh",
        "scripts/restore.sh",
        "scripts/repair.sh",
        "scripts/export-recovery-bundle.sh",
        "scripts/import-recovery-bundle.sh",
        "scripts/end-maintenance.sh",
        "update.sh",
        ".env-orbit",
        ".orbit-secrets/",
        ".orbit-files",
        "",
      ].join("\n"),
    );
  });

  it("lists each asset exactly once", () => {
    for (const asset of DEPLOYMENT_ASSETS) expect(lines().filter((line) => line === asset), asset).toHaveLength(1);
    expect(new Set(lines()).size).toBe(lines().length);
  });

  it("ends the directory entry with a slash and never names the runtime paths", () => {
    expect(lines()).toContain(".orbit-secrets/");
    expect(lines()).not.toContain(".orbit-secrets");
    for (const runtime of ["backups/", "backups", "orbit-install-backups/", "orbit-install-backups"]) expect(lines()).not.toContain(runtime);
  });

  it("has only comments and lines that match install.sh's journal path_pattern, within 8 KiB", () => {
    const installScript = readFileSync(installScriptPath, "utf8");
    expect(installScript).toContain("local path_pattern='^[A-Za-z0-9._-]{1,255}(/[A-Za-z0-9._-]{1,255})*/?$'");
    for (const line of lines().filter((entry) => !entry.startsWith("#"))) expect(line).toMatch(journalPath);
    expect(Buffer.byteLength(rendered())).toBeLessThanOrEqual(8192);
  });

  it("renders whatever assets it is given, between the header and the fixed tail", () => {
    expect(renderDeploymentFileList(["a", "d/b"]).split("\n").slice(1)).toEqual(["a", "d/b", ".env-orbit", ".orbit-secrets/", ".orbit-files", ""]);
  });
});

describe("update.sh (#1770)", () => {
  it("is shipped as an operator asset at the top of the Orbit directory", () => {
    expect(DEPLOYMENT_ASSETS).toContain("update.sh");
  });

  it("is bundled into the image and is a bash-clean script", () => {
    expect(dockerfileBundle()).toContain("update.sh");
    expect(DEPLOYMENT_SCRIPTS).toContain("update.sh");
  });

  it("is executable in the source tree, so the installed copy can be run as ./update.sh", () => {
    const mode = statSync(join(repoRoot, "scripts", "update.sh")).mode;
    expect(mode & 0o111).toBe(0o111);
  });
});

// #1170: ClamAV is optional, on by default. The overlay is a deployment asset
// like the other Compose overlays, so every install and update carries it.
describe("docker-compose.scanner-off.yml (#1170)", () => {
  it("ships as a deployment asset", () => {
    expect(DEPLOYMENT_ASSETS).toContain("docker-compose.scanner-off.yml");
  });

  it("moves orbit-clamav under a profile nothing activates, and defines nothing else", () => {
    const text = readFileSync(join(repoRoot, "docker-compose.scanner-off.yml"), "utf8");
    expect(text).toMatch(/^services:\s*\n\s+orbit-clamav:\s*\n\s+profiles:\s*\[\s*"scanner-off"\s*\]/mu);
    expect(text.match(/^ {2}[a-z][\w-]*:/gmu)).toEqual(["  orbit-clamav:"]);
  });

  it("leaves the base file starting orbit-clamav with no profile (on by default)", () => {
    const base = readFileSync(join(repoRoot, "docker-compose.yml"), "utf8");
    const block = /^ {2}orbit-clamav:\n((?: {4}.*\n|\n)*)/mu.exec(base);
    expect(block).not.toBeNull();
    expect(block?.[1]).not.toMatch(/^ {4}profiles:/mu);
  });
});
