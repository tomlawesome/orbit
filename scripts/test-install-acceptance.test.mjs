import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

// #894: the Compose project name and registry container name used to be the
// fixed literal "orbit-acceptance", so two runs on one host shared one
// Compose project label and one registry container name -- the second run's
// own cleanup sweep deleted the first run's still-live containers, volumes
// and networks outright, and its `docker run --name` for the registry tore
// the first run's registry down to reuse the name. The script now derives a
// per-run name the same way scripts/test-e2e-local.sh derives its own
// Compose project name (#875), and exits under
// TEST_INSTALL_ACCEPTANCE_DRY_RUN before any Docker or network call is made
// -- the same dry-run hook scripts/test-e2e-local.test.mjs already drives
// for that script -- so the derivation is provable without a Docker daemon.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const script = fileURLToPath(new URL("./test-install-acceptance.sh", import.meta.url));
const scriptSource = readFileSync(script, "utf8");

function dryRun() {
  const result = failOnProcessDeadline(
    spawnSync("bash", [script], {
      encoding: "utf8",
      env: { ...process.env, TEST_INSTALL_ACCEPTANCE_DRY_RUN: "1" },
      ...processGuard(),
    }),
    { label: "dryRun" },
  );
  expect(result.status, `stderr: ${result.stderr}`).toBe(0);
  const names = Object.fromEntries(
    result.stdout
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
  return names;
}

describe("test-install-acceptance.sh per-run Compose project name", () => {
  it("derives a run_name and registry_name of the documented shape", () => {
    const { run_name: runName, registry_name: registryName, target } = dryRun();
    expect(runName).toMatch(/^orbit-acceptance-[0-9a-f]{8}-\d+$/);
    // Must also be a valid Compose project name (configure.sh's own check,
    // engine_configure_project_name): lowercase alphanumeric, dash or
    // underscore, not starting with a dash or underscore.
    expect(runName).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
    expect(registryName).toBe(`${runName}-registry`);
    // The target directory's basename is what configure.sh's basename-of-pwd
    // fallback turns into the Compose project name (docs comment above
    // run_name in the script), so it has to be run_name, not a fixed
    // "orbit-acceptance" subdirectory.
    expect(target.endsWith(`/${runName}`)).toBe(true);
  });

  it("derives a different run_name and registry_name on a second invocation", () => {
    const first = dryRun();
    const second = dryRun();
    expect(second.run_name).not.toBe(first.run_name);
    expect(second.registry_name).not.toBe(first.registry_name);
    expect(second.target).not.toBe(first.target);
  });

  it("filters every cleanup sweep on the derived run_name, not a fixed literal", () => {
    const sweepDebris = scriptSource.match(/sweep_debris\(\) \{[\s\S]*?\n\}/);
    expect(sweepDebris, "sweep_debris() body not found").not.toBeNull();
    const body = sweepDebris[0];
    // Every filter must reference the run_name variable ...
    const filters = [...body.matchAll(/--filter label=com\.docker\.compose\.project=(\S+)/g)];
    expect(filters.length).toBeGreaterThan(0);
    for (const [, value] of filters) {
      expect(value).toBe('"$run_name"');
    }
    // ... and the registry container removed by name must be this run's own.
    expect(body).toMatch(/docker rm -f "\$registry_name"/);
    // Neither the old fixed literal nor a bare unquoted/unqualified project
    // string should reappear here.
    expect(body).not.toMatch(/orbit-acceptance-registry/);
    expect(body).not.toMatch(/project=orbit-acceptance"/);
  });
});
