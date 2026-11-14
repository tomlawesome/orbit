import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

// #1635: key rotation step 3 runs inside the app container as
// `node /opt/orbit/cli/orbit.js rewrap-kek --next-key-file <path>`. Written
// from the issue's specification: the BUNDLED CLI (the artifact the
// Dockerfile ships) must know `rewrap-kek`, and the Dockerfile must copy it
// to that path.

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const repoDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = join(repoDir, "dist", "cli", "orbit.js");
const SPAWN_OPTS = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...processGuard() };
const scratch = mkdtempSync(join(tmpdir(), "orbit-rewrap-bundle-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function runBundle(args, extraEnv = {}) {
  const env = { ...process.env, ORBIT_ENGINE_CONTEXT: "container", DOCUMENT_KEK: "c0".repeat(32), ...extraEnv };
  delete env.DOCUMENT_KEK_FILE;
  return failOnProcessDeadline(spawnSync("node", [bundlePath, ...args], { ...SPAWN_OPTS, cwd: scratch, env }), {
    label: `bundle ${args.join(" ")}`,
  });
}

describe("the bundled CLI and rewrap-kek (#1635)", () => {
  beforeAll(() => {
    const built = failOnProcessDeadline(
      spawnSync("node", [join(repoDir, "scripts", "bundle-orbit-cli.mjs")], { cwd: repoDir, ...SPAWN_OPTS }),
      { label: "bundle build" },
    );
    expect(built.status, built.stderr).toBe(0);
  }, PROCESS_TEST_TIMEOUT_MS * 3);

  it("rewrap-kek with no --next-key-file prints the usage error and exits 1, not the unknown-command path", () => {
    const result = runBundle(["rewrap-kek"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--next-key-file");
    expect(result.stderr).not.toContain("supported commands");
  });

  it("rewrap-kek with a next key file that does not exist exits 1 with 'could not read the next key file'", () => {
    const result = runBundle(["rewrap-kek", "--next-key-file", join(scratch, "missing")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not read the next key file");
  });

  /* review of #1635: past the refusals, the real bundle reaches the database. One it cannot reach must end the run
     with exit 1 and close the pool, not leave the operator's terminal waiting on a process that never exits. */
  it("rewrap-kek against a database it cannot reach exits 1 rather than hanging", () => {
    const nextKey = join(scratch, "next");
    writeFileSync(nextKey, `${"d1".repeat(32)}\n`, { mode: 0o600 });
    const result = runBundle(["rewrap-kek", "--next-key-file", nextKey], {
      DATABASE_URL: "postgres://orbit:not-a-password@127.0.0.1:1/orbit",
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("orbit rewrap-kek:");
  });

  it("the Dockerfile copies the bundle to /opt/orbit/cli/orbit.js, the path step 3 runs", () => {
    const dockerfile = readFileSync(join(repoDir, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/COPY --from=cli-builder [^\n]*\/opt\/orbit\/dist\/cli\/orbit\.js \.\/cli\/orbit\.js/);
    expect(dockerfile).toMatch(/WORKDIR \/opt\/orbit\b/);
  });
});
