import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PTY_TEST_TIMEOUT_MS, ptyWatchdog } from "../../scripts/pty-deadline.mjs";

// #1210 D3: `orbit configure --init` and `--set-oidc-secret` prompt on the
// operator's terminal themselves (configure.sh passes one through with
// `docker run -t`). Driven under a real pty with `script`; stdin stays open
// for the child's whole life (AGENTS.md, "Never drive a pty test by closing
// its own stdin"), and every answer waits for its prompt.

vi.setConfig({ testTimeout: PTY_TEST_TIMEOUT_MS });

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const tsx = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cli = join(repoRoot, "src", "cli", "orbit.ts");

type Step = [prompt: string, answer: string];

function runOnPty(args: string[], deployDir: string, steps: Step[], env: NodeJS.ProcessEnv = {}): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const command = ["node", tsx, cli, "configure", ...args, "--dir", deployDir].map((part) => `'${part}'`).join(" ");
    const child = spawn("script", ["-qeE", "never", "-c", command, "/dev/null"], {
      env: { ...process.env, TERM: "xterm", ...env },
    });
    let output = "";
    let consumed = 0;
    const pending = [...steps];
    const watchdog = ptyWatchdog({ label: "orbit configure on a pty", kill: () => child.kill("SIGKILL") });
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

let deployDir: string;
beforeEach(() => {
  deployDir = mkdtempSync(join(tmpdir(), "orbit-configure-tty-"));
  writeFileSync(join(deployDir, ".env-orbit.example"), readFileSync(join(repoRoot, ".env-orbit.example")));
});
afterEach(() => {
  rmSync(deployDir, { recursive: true, force: true });
});

const envFile = (): string => readFileSync(join(deployDir, ".env-orbit"), "utf8");

describe("orbit configure --init on a terminal", () => {
  it("asks the sign-in mode, then the OIDC fields, rejecting and re-asking an invalid answer", async () => {
    const result = await runOnPty(["--init"], deployDir, [
      ["[local/oidc] (default: local): ", "oidc\r"],
      ["Public Orbit origin (e.g. https://orbit.your-domain.tld): ", "http://not-https.tty.invalid\r"],
      ["Public Orbit origin (e.g. https://orbit.your-domain.tld): ", "https://orbit.tty.invalid\r"],
      ["OIDC issuer URL (e.g. https://sso.your-domain.tld/application/o/orbit/): ", "https://sso.tty.invalid/application/o/orbit/\r"],
      ["OIDC client ID: ", "tty-client\r"],
    ]);
    expect(result.status).toBe(0);
    expect(result.output).toContain("Enter a complete https:// public origin");
    expect(result.output).toContain("Orbit guided configuration saved APP_URL, ORBIT_AUTH_OIDC=true");
    expect(envFile()).toContain("APP_URL=https://orbit.tty.invalid\n");
    expect(envFile()).toContain("OIDC_CLIENT_ID=tty-client\n");
    expect(envFile()).toContain("OIDC_CALLBACK_URL=https://orbit.tty.invalid/api/auth/callback\n");
  });

  it("defaults to local accounts and asks for APP_URL alone", async () => {
    const result = await runOnPty(["--init"], deployDir, [
      ["[local/oidc] (default: local): ", "\r"],
      ["Public Orbit origin (e.g. https://orbit.your-domain.tld): ", "https://orbit.tty.invalid\r"],
    ]);
    expect(result.status).toBe(0);
    expect(result.output).not.toContain("OIDC issuer URL");
    expect(envFile()).toContain("ORBIT_AUTH_OIDC=false\n");
  });

  it("is cancelled by end of input and writes nothing", async () => {
    const result = await runOnPty(["--init"], deployDir, [["[local/oidc] (default: local): ", "\x04"]]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("Guided configuration was cancelled.");
    expect(existsSync(join(deployDir, ".env-orbit"))).toBe(false);
  });
});

describe("orbit configure --set-oidc-secret on a terminal", () => {
  it("reads the secret without echoing it", async () => {
    const secret = "tty-secret-value-never-echoed";
    const result = await runOnPty(["--set-oidc-secret"], deployDir, [["OIDC client secret (input hidden): ", `${secret}\r`]]);
    expect(result.status).toBe(0);
    expect(result.output).not.toContain(secret);
    expect(result.output).toContain("Orbit saved the OIDC client secret to .orbit-secrets/oidc-client-secret.");
    expect(readFileSync(join(deployDir, ".orbit-secrets", "oidc-client-secret"), "utf8")).toBe(secret);
  });

  it("refuses an empty secret", async () => {
    const result = await runOnPty(["--set-oidc-secret"], deployDir, [["OIDC client secret (input hidden): ", "\r"]]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("Could not read a non-empty OIDC client secret");
    expect(existsSync(join(deployDir, ".orbit-secrets", "oidc-client-secret"))).toBe(false);
  });

  it("is cancelled by end of input", async () => {
    const result = await runOnPty(["--set-oidc-secret"], deployDir, [["OIDC client secret (input hidden): ", "\x04"]]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("Could not read a complete OIDC client secret from the controlling terminal.");
  });
});
