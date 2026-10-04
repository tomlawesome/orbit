import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

// #1151 O1-F2: test-install-bootstrap.sh's own documented default
// (`--channel preview`, see its header) used to always fail before ever
// reaching the registry-digest comparison it exists to prove: install.sh's
// self-fetch refuses ORBIT_CHANNEL=preview outright (ADR-0031 #7 -- preview
// has no release-assets location a self-fetch could verify against), and
// nothing in the harness ever supplied the ORBIT_RELEASE_MANIFEST a real
// preview install needs instead.
//
// The harness itself needs Docker, a controlling network and the real
// registry to run end to end, so this suite never spawns it directly.
// Instead it extracts the real make_preview_release_manifest function and
// the install_env construction lines verbatim from the live script (never a
// hand-typed duplicate) and drives them in a bash sandbox with fake
// workdir/channel/digest values, proving: a preview run now builds a
// manifest naming the real digest and hands it to install.sh via
// ORBIT_RELEASE_MANIFEST, while a self-fetchable channel (latest, a version
// pin) is left alone exactly as before.

const scriptsDir = join(import.meta.dirname);
const source = readFileSync(join(scriptsDir, "test-install-bootstrap.sh"), "utf8");

function extractLine(pattern) {
  const match = source.match(pattern);
  if (!match) throw new Error(`Could not find ${pattern} in test-install-bootstrap.sh`);
  return match[0];
}

// Not the generic "up to the first \n}" extraction used elsewhere: this
// function's body contains a heredoc whose own JSON payload has a "}" line
// of its own (the manifest's closing brace) before the real end of the
// function, which a naive non-greedy match would stop at instead.
const makeManifestSource = extractLine(/^make_preview_release_manifest\(\) \{[\s\S]*?\nJSON\n\}/mu);
const decideManifestSource = extractLine(/^release_manifest_path=""\n\[\[ "\$channel" != preview \]\] \|\| make_preview_release_manifest$/mu);
const buildInstallEnvSource = extractLine(/^install_env=\([^)]*\)\n\[\[ -z "\$release_manifest_path" \]\] \|\| install_env\+=\(ORBIT_RELEASE_MANIFEST="\$release_manifest_path"\)$/mu);

const scratchDirs = [];
afterEach(() => {
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop(), { recursive: true, force: true });
});

function run(channel) {
  const workdir = mkdtempSync(join(tmpdir(), "orbit-bootstrap-manifest-"));
  scratchDirs.push(workdir);
  const harness = [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    `workdir=${JSON.stringify(workdir)}`,
    `channel=${JSON.stringify(channel)}`,
    'repository="tomlawesome/orbit"',
    `real_digest="sha256:${"a".repeat(64)}"`,
    'target="/dev/null/unused"',
    'project_name="orbit-bootstrap-test"',
    makeManifestSource,
    decideManifestSource,
    'PATH="/fake/shim:$PATH"',
    buildInstallEnvSource,
    'printf "release_manifest_path=%s\\n" "$release_manifest_path"',
    'for entry in "${install_env[@]}"; do printf "install_env:%s\\n" "$entry"; done',
  ].join("\n");
  return failOnProcessDeadline(spawnSync("bash", ["-c", harness], { encoding: "utf8", ...processGuard() }), { label: "run" });
}

describe("test-install-bootstrap.sh hands install.sh a manifest for a preview run (#1151 O1-F2)", () => {
  it("builds a release manifest naming the real digest and passes it via ORBIT_RELEASE_MANIFEST for channel=preview", () => {
    const result = run("preview");
    expect(result.status).toBe(0);

    const manifestMatch = result.stdout.match(/^release_manifest_path=(.*)$/mu);
    expect(manifestMatch).not.toBeNull();
    const manifestPath = manifestMatch[1];
    expect(manifestPath).not.toBe("");

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.channel).toBe("preview");
    expect(manifest.image.repository).toBe("tomlawesome/orbit");
    expect(manifest.image.digest).toBe(`sha256:${"a".repeat(64)}`);

    expect(result.stdout).toContain(`install_env:ORBIT_RELEASE_MANIFEST=${manifestPath}`);
  });

  it("never builds or passes a manifest for a self-fetchable channel like latest", () => {
    const result = run("latest");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("release_manifest_path=\n");
    expect(result.stdout).not.toContain("install_env:ORBIT_RELEASE_MANIFEST=");
  });
});
