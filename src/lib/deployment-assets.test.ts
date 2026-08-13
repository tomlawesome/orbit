import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEPLOYMENT_ASSETS,
  DEPLOYMENT_SCRIPTS,
  ENVIRONMENT_FILE,
  SECRETS_DIRECTORY,
  buildManagedPaths,
  deriveAssetDirectories,
} from "./deployment-assets";

// Byte-for-byte parity between this module's constants and the array
// literals in the real, unmodified scripts/install.sh (issue #295 slice 5,
// guarantee #45) — install.sh declares deployment_assets/deployment_scripts
// as inline array literals inside the main flow rather than inside a named
// function, so this test awk-extracts the literal array bodies (never
// hand-copied) instead of a function, the same "fails loudly if renamed"
// discipline every parity test in this port uses.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const installScriptPath = join(repoRoot, "scripts", "install.sh");

function extractArrayLiteral(name: string): string[] {
  const script = `
    $0 ~ "readonly ${name}=\\\\(" { found = 1; next }
    found { if ($0 == ")") { found = 0; exit } print }
  `;
  const result = spawnSync("awk", [script, installScriptPath], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Could not extract ${name} array literal from install.sh; it may have been renamed.`);
  }
  return result.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const match = /^\s*"([^"]*)"\s*$/.exec(line);
      if (!match) throw new Error(`Unexpected array literal line: ${line}`);
      return match[1];
    });
}

describe("deployment_assets / deployment_scripts parity (install.sh:1313-1330, guarantee #45)", () => {
  it("agrees byte-for-byte on the deployment_assets array", () => {
    expect(DEPLOYMENT_ASSETS).toEqual(extractArrayLiteral("deployment_assets"));
  });

  it("agrees byte-for-byte on the deployment_scripts array", () => {
    expect(DEPLOYMENT_SCRIPTS).toEqual(extractArrayLiteral("deployment_scripts"));
  });

  it("deployment_scripts is a subset of deployment_assets", () => {
    for (const script of DEPLOYMENT_SCRIPTS) {
      expect(DEPLOYMENT_ASSETS).toContain(script);
    }
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
