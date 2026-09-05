import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PTY_DEADLINE_MS, failOnPtyDeadline } from "./pty-deadline.mjs";

/*
 * #836: the launcher hands install.sh a terminal on stdin. Every health probe
 * runs under `timeout`, which moves the command into its own process group --
 * a background group as far as the terminal is concerned. `docker compose
 * exec` keeps stdin attached even with -T, so the first read of the terminal
 * stops the process (SIGTTIN); the bound's TERM cannot wake a stopped
 * process, and only the KILL a second later lands. Every probe then fails at
 * the bound, and a healthy database is reported as a startup failure.
 *
 * The suite in install.test.mjs never saw it because its pty driver closes
 * stdin (`exec </dev/null`) before starting the installer. This test keeps
 * the terminal on stdin, as the launcher does, with a fake docker that reads
 * one byte from it, and asserts the probe returns at once.
 */
const installScript = fileURLToPath(new URL("./install.sh", import.meta.url));

function shellFunction(name) {
  const source = readFileSync(installScript, "utf8");
  const match = source.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, "mu"));
  expect(match, `${name}() is missing from install.sh`).not.toBeNull();
  return match[0];
}

describe("health probes with a terminal on stdin (#836)", () => {
  it("a probe whose command reads stdin returns at once instead of stopping at the bound", () => {
    const dir = mkdtempSync(join(tmpdir(), "orbit-probe-tty-"));
    const fakeDocker = join(dir, "docker");
    // Reads stdin like `docker compose exec` does, then succeeds.
    writeFileSync(fakeDocker, "#!/usr/bin/env bash\nhead -c1 >/dev/null\nexit 0\n");
    chmodSync(fakeDocker, 0o755);
    const harness = join(dir, "harness.sh");
    writeFileSync(harness, [
      "set -u",
      'compose_project_name=probe environment_file=/dev/null',
      shellFunction("bounded_compose_probe"),
      shellFunction("probe_database_health"),
      "probe_database_health",
      'printf "probe-status=%s\\n" "$?"',
    ].join("\n"));

    const started = Date.now();
    const result = spawnSync("script", ["-qeE", "never", "-c", `bash ${harness}`, "/dev/null"], {
      encoding: "utf8",
      timeout: PTY_DEADLINE_MS,
      killSignal: "SIGKILL",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    failOnPtyDeadline(result, { label: "probe under a pty", deadlineMs: PTY_DEADLINE_MS });
    const elapsedMs = Date.now() - started;

    expect(result.stdout).toContain("probe-status=0");
    // Well under the 5 s bound: a stopped probe takes 6 s (bound + kill-after).
    expect(elapsedMs).toBeLessThan(4_000);
  });
});
