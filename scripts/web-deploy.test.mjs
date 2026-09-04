import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

// Tests here run scripts/web-deploy.sh under sh; a spawn that takes tens of
// milliseconds quiet takes seconds on a starved core (#698). Budget and
// reasoning: scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

/**
 * #735: `pnpm deploy` produces the image's pruned production node_modules, and
 * as a side effect rewrites the WORKSPACE's own
 * `node_modules/.pnpm-workspace-state-v1.json` to say the last install here was
 * `--prod --filter`. It was not — the install went to the target directory —
 * but every later pnpm command believes it, decides node_modules must be
 * rebuilt as a production install, and refuses without a TTY. The failure lands
 * on some unrelated command minutes later as
 * ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY and points at nothing.
 *
 * `scripts/web-deploy.sh` puts the file back. These tests drive it with a stub
 * `pnpm` rather than a real deploy: the behaviour under test is the restore,
 * and a real deploy would put a slow network- and store-dependent step in the
 * fast suite to prove something pnpm is responsible for.
 */
const repoRoot = resolve(import.meta.dirname, "..");
const workspaceState = join(repoRoot, "node_modules", ".pnpm-workspace-state-v1.json");

/** A `pnpm` that corrupts the workspace state the way the real one does. */
function stubPnpm(directory, { exitCode = 0 } = {}) {
  const path = join(directory, "pnpm");
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '{"corrupted-by-the-stub":true}\\n' > ${JSON.stringify(workspaceState)}\nexit ${exitCode}\n`,
  );
  chmodSync(path, 0o755);
  return directory;
}

describe("scripts/web-deploy.sh", () => {
  let stubDir;
  let ownBackup;

  beforeEach(() => {
    stubDir = mkdtempSync(join(tmpdir(), "orbit-web-deploy-"));
    // Held independently of the script, so a regression cannot leave this
    // checkout's pnpm state broken for whoever runs the suite next.
    ownBackup = join(stubDir, "workspace-state.json");
    copyFileSync(workspaceState, ownBackup);
  });

  afterEach(() => {
    copyFileSync(ownBackup, workspaceState);
    rmSync(stubDir, { recursive: true, force: true });
  });

  function runDeploy({ exitCode = 0 } = {}) {
    stubPnpm(stubDir, { exitCode });
    return failOnProcessDeadline(spawnSync("sh", [join(repoRoot, "scripts", "web-deploy.sh"), join(stubDir, "target")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` },
      ...processGuard(),
    }), { label: "runDeploy" });
  }

  it("leaves the workspace's pnpm state exactly as it found it", () => {
    const before = readFileSync(workspaceState, "utf8");
    const result = runDeploy();
    expect(result.status).toBe(0);
    expect(readFileSync(workspaceState, "utf8")).toBe(before);
  });

  it("restores it even when the deploy fails", () => {
    const before = readFileSync(workspaceState, "utf8");
    const result = runDeploy({ exitCode: 1 });
    expect(result.status).not.toBe(0);
    expect(readFileSync(workspaceState, "utf8")).toBe(before);
  });

  it("refuses without a target directory rather than guessing one", () => {
    const result = failOnProcessDeadline(
      spawnSync("sh", [join(repoRoot, "scripts", "web-deploy.sh")], { encoding: "utf8", ...processGuard() }),
      { label: "web-deploy.sh without a target" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage:");
  });
});
