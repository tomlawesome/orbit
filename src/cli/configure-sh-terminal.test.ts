import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeEngineDockerShim } from "../../scripts/engine-docker-shim.mjs";
import { PTY_TEST_TIMEOUT_MS, ptyWatchdog } from "../../scripts/pty-deadline.mjs";

// Ported from the retired scripts/configure.test.mjs (#1210 build note D10;
// docs/adr-notes/1210-bash-test-retirement.md): install.sh runs
// `configure.sh --init` with its own stdin taken, so the questions must
// reach the operator's controlling terminal. configure.sh now hands the
// engine's one-off `docker run -t` that terminal (`</dev/tty >/dev/tty`),
// and the engine asks on it. The real configure.sh runs under a pty with
// stdin replaced by /dev/null; scripts/engine-docker-shim.mjs answers its
// `docker run` with this checkout's CLI. stdin of the pty driver stays open
// for the child's whole life (AGENTS.md, "Never drive a pty test by closing
// its own stdin"), and every answer waits for its prompt.

vi.setConfig({ testTimeout: PTY_TEST_TIMEOUT_MS });

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

type Step = [prompt: string, answer: string];

let targetDir: string;
let binDir: string;

beforeEach(() => {
  targetDir = mkdtempSync(join(tmpdir(), "orbit-configure-sh-terminal-"));
  mkdirSync(join(targetDir, "scripts"));
  writeFileSync(join(targetDir, "scripts", "configure.sh"), readFileSync(join(repoRoot, "scripts", "configure.sh")));
  writeFileSync(join(targetDir, ".env-orbit.example"), readFileSync(join(repoRoot, ".env-orbit.example")));
  writeFileSync(join(targetDir, ".env-orbit"), "ORBIT_CONFIG_SCHEMA_VERSION=1\nPOSTGRES_DB=keep-me\n", { mode: 0o600 });
  binDir = mkdtempSync(join(tmpdir(), "orbit-configure-sh-terminal-bin-"));
  writeEngineDockerShim(binDir);
});

afterEach(() => {
  rmSync(targetDir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

function runWithStdinTaken(steps: Step[]): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const command = `exec </dev/null; bash '${join(targetDir, "scripts", "configure.sh")}' --init`;
    const child = spawn("script", ["-qeE", "never", "-c", command, "/dev/null"], {
      cwd: targetDir,
      env: {
        PATH: `${binDir}:${process.env.PATH}`,
        HOME: process.env.HOME ?? tmpdir(),
        TERM: "xterm",
        ORBIT_IMAGE: "orbit-local:abcdef123456",
      },
    });
    let output = "";
    let consumed = 0;
    const pending = [...steps];
    const watchdog = ptyWatchdog({ label: "configure.sh --init with stdin taken", kill: () => child.kill("SIGKILL") });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      watchdog.touch();
      while (pending.length > 0) {
        const at = output.indexOf(pending[0][0], consumed);
        if (at < 0) break;
        consumed = at + pending[0][0].length;
        child.stdin.write(pending.shift()![1]);
      }
    });
    child.stdin.on("error", () => {
      /* the child exited first */
    });
    child.on("error", reject);
    child.on("close", (status) => {
      watchdog.stop();
      if (watchdog.reason) {
        reject(watchdog.error({ stdout: output }));
        return;
      }
      resolve({ status, output });
    });
  });
}

describe("configure.sh --init (ported from scripts/configure.test.mjs)", () => {
  it("uses the controlling terminal when stdin is occupied by the installer script", async () => {
    const validAppUrl = "https://orbit.guided-test.internal";
    const result = await runWithStdinTaken([
      ["[local/oidc] (default: local): ", "oidc\r"],
      ["Public Orbit origin (e.g. https://orbit.your-domain.tld): ", `${validAppUrl}\r`],
      ["OIDC issuer URL (e.g. https://sso.your-domain.tld/application/o/orbit/): ", "https://auth.guided-test.internal/application/o/orbit/\r"],
      ["OIDC client ID: ", "guided-test-client-id\r"],
    ]);

    expect(result.status).toBe(0);
    const updated = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    expect(updated).toContain("POSTGRES_DB=keep-me\n");
    expect(updated).toContain(`OIDC_CALLBACK_URL=${validAppUrl}/api/auth/callback\n`);
  });
});
