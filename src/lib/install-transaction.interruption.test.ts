import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Process-level interruption characterization for issue #295 slice 1: a
// SIGKILL cannot be trapped by Node any more than by Bash, so this proves
// InstallTransaction leaves the exact same two-part evidence
// scripts/test-install-acceptance.sh's own `kill -9 -- "-$pid"` scenario
// asserts for install.sh (catalogue Part 1 / install.sh #31): the target is
// untouched for anything not yet committed, and any staging directory left
// behind is owner-only (mode 0700). Drives the hidden, undocumented
// `orbit __install-transaction-rehearse` subcommand (src/cli/orbit.ts),
// wired only to make this characterization possible — not a shipped flow.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliEntry = fileURLToPath(new URL("../cli/orbit.ts", import.meta.url));
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

let targetDir: string;
let scenarioDir: string;

beforeEach(() => {
  targetDir = mkdtempSync(join(tmpdir(), "orbit-install-tx-interrupt-"));
  scenarioDir = mkdtempSync(join(tmpdir(), "orbit-install-tx-interrupt-scenario-"));
});

afterEach(() => {
  rmSync(targetDir, { recursive: true, force: true });
  rmSync(scenarioDir, { recursive: true, force: true });
});

function mode(path: string): number {
  return lstatSync(path).mode & 0o777;
}

function stagingLeftovers(): string[] {
  return readdirSync(targetDir).filter((name) => name.startsWith(".orbit-install-staging"));
}

describe("SIGKILL interruption leaves install.sh-equivalent recovery evidence", () => {
  it("leaves the target untouched for an uncommitted managed path, and staging owner-only, after a hard kill mid-transaction", async () => {
    const originalContent = "APP_URL=https://before-interrupt.invalid\n";
    writeFileSync(join(targetDir, ".env-orbit"), originalContent, { mode: 0o600 });

    const resumeSignalPath = join(scenarioDir, "resume");
    const scenario = {
      targetDir,
      managedPaths: [{ path: ".env-orbit", type: "file" }],
      steps: [
        {
          kind: "write",
          path: ".env-orbit",
          contentBase64: Buffer.from("APP_URL=https://after-interrupt.invalid\n", "utf8").toString("base64"),
          mode: 0o600,
        },
        // Deliberately never reaches commitMove/commit: pause here so the
        // test can SIGKILL while only the staged (not yet committed) copy
        // exists, mirroring the harness's kill during install.sh's assets
        // phase — strictly before any real target mutation.
        { kind: "pause", resumeSignalPath },
      ],
    };
    const scenarioPath = join(scenarioDir, "scenario.json");
    writeFileSync(scenarioPath, JSON.stringify(scenario));

    const child = spawn("node", [tsxCli, cliEntry, "__install-transaction-rehearse", scenarioPath], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group, so SIGKILL reaches the whole tree like the harness's `kill -9 -- "-$pid"`
    });

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    await new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`installer rehearsal never reached the pause: ${stdout}`)), 10_000);
      const check = () => {
        if (stdout.includes("phase=paused")) {
          clearTimeout(timer);
          resolvePromise();
        } else {
          setTimeout(check, 25);
        }
      };
      check();
    });

    const exited = new Promise<void>((resolvePromise) => {
      child.once("close", () => resolvePromise());
    });
    process.kill(-child.pid!, "SIGKILL");
    await exited;

    // catalogue Part 1 / install.sh #31 equivalent: a hard interruption
    // before commit leaves the managed path byte-identical.
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toBe(originalContent);

    // Any staging evidence left behind must be owner-only.
    const leftovers = stagingLeftovers();
    expect(leftovers.length).toBe(1);
    expect(mode(join(targetDir, leftovers[0]))).toBe(0o700);

    // Documented recovery step (matches install.sh / repair.sh's
    // staging-evidence-present finding): inspect, then remove before
    // rerunning.
    rmSync(join(targetDir, leftovers[0]), { recursive: true, force: true });
    expect(existsSync(join(targetDir, leftovers[0]))).toBe(false);
  }, 20_000);
});
