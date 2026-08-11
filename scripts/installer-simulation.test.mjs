import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const simulationScript = fileURLToPath(new URL("./installer-simulation.sh", import.meta.url));
const uiScript = fileURLToPath(new URL("./installer-ui.sh", import.meta.url));

const scratchDirs = [];

function scratchDir() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-installer-simulation-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop(), { recursive: true, force: true });
  }
});

function fakeBinDir() {
  // Fails loudly if the simulation ever invokes docker, curl or timeout: the
  // simulation must never reach an external tool.
  const binDir = scratchDir();
  for (const name of ["docker", "curl", "timeout"]) {
    const path = join(binDir, name);
    writeFileSync(path, `#!/usr/bin/env bash\nprintf 'unexpected %s invocation\\n' "${name}" >&2\nexit 99\n`);
    chmodSync(path, 0o755);
  }
  return binDir;
}

function runPlain(args, cwd, envOverrides = {}) {
  return spawnSync("bash", [simulationScript, ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: `${fakeBinDir()}:${process.env.PATH}`, TERM: "xterm", ...envOverrides },
  });
}

function runPty(cwd, input, args = []) {
  return spawnSync(
    "script",
    ["-qeE", "never", "-c", `bash '${simulationScript}' ${args.join(" ")}`, "/dev/null"],
    {
      cwd,
      encoding: "utf8",
      input,
      timeout: 10000,
      killSignal: "SIGKILL",
      env: { PATH: `${fakeBinDir()}:${process.env.PATH}`, TERM: "xterm" },
    },
  );
}

describe("scripts/installer-simulation.sh", () => {
  it("rejects unsupported arguments", () => {
    const cwd = scratchDir();
    const result = runPlain(["--unsupported"], cwd);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });

  it("refuses a missing sibling installer-ui.sh", () => {
    const dir = scratchDir();
    const localScript = join(dir, "installer-simulation.sh");
    copyFileSync(simulationScript, localScript);
    chmodSync(localScript, 0o755);

    const result = spawnSync("bash", [localScript, "--plain"], {
      encoding: "utf8",
      env: { PATH: `${fakeBinDir()}:${process.env.PATH}`, TERM: "xterm" },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing or unsafe");
  });

  it("refuses a symlinked sibling installer-ui.sh", () => {
    const dir = scratchDir();
    const localScript = join(dir, "installer-simulation.sh");
    copyFileSync(simulationScript, localScript);
    chmodSync(localScript, 0o755);
    symlinkSync(uiScript, join(dir, "installer-ui.sh"));

    const result = spawnSync("bash", [localScript, "--plain"], {
      encoding: "utf8",
      env: { PATH: `${fakeBinDir()}:${process.env.PATH}`, TERM: "xterm" },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing or unsafe");
  });

  it("refuses a non-regular sibling installer-ui.sh", () => {
    const dir = scratchDir();
    const localScript = join(dir, "installer-simulation.sh");
    copyFileSync(simulationScript, localScript);
    chmodSync(localScript, 0o755);
    mkdirSync(join(dir, "installer-ui.sh"));

    const result = spawnSync("bash", [localScript, "--plain"], {
      encoding: "utf8",
      env: { PATH: `${fakeBinDir()}:${process.env.PATH}`, TERM: "xterm" },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing or unsafe");
  });

  it("runs a deterministic, ANSI-free plain success scenario with no side effects", () => {
    const cwd = scratchDir();
    const before = readdirSync(cwd);

    const result = runPlain(["--plain"], cwd);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("simulation=true");
    expect(result.stdout).toContain("state=healthy");
    expect(result.stdout).toContain("state=completed");
    expect(result.stdout).toContain("No deployment occurred.");
    expect(result.stdout).not.toMatch(/\x1b\[/u);
    expect(result.stdout).not.toMatch(/sha256:[0-9a-f]{64}/u);
    expect(readdirSync(cwd)).toEqual(before);
  });

  it("runs the same deterministic plain scenario when there is no controlling terminal", () => {
    const cwd = scratchDir();

    const result = runPlain([], cwd);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No deployment occurred.");
  });

  it("cancels with a lone Escape at the top-level menu and restores the terminal", () => {
    const cwd = scratchDir();
    const before = readdirSync(cwd);

    const result = runPty(cwd, "\x1b");

    expect(result.status).toBe(130);
    expect(result.stdout).toContain("Simulation: Greetings");
    expect(readdirSync(cwd)).toEqual(before);
  });

  it("exits cleanly from the top-level Exit choice", () => {
    const cwd = scratchDir();

    const result = runPty(cwd, "\x1b[B\x1b[B\x1b[B\r");

    expect(result.status).toBe(130);
  });

  it("keeps Repair presentation-only", () => {
    const cwd = scratchDir();
    const before = readdirSync(cwd);

    const result = runPty(cwd, "\x1b[B\x1b[B\r");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("repair_unavailable");
    expect(result.stdout).toContain("No deployment occurred.");
    expect(readdirSync(cwd)).toEqual(before);
  });

  it("never echoes or persists the synthetic hidden-input exercise", () => {
    const cwd = scratchDir();
    const secret = "discard-me-please";
    const before = readdirSync(cwd);

    const result = runPty(cwd, `\r\rnote-value\r${secret}\r\r\r`);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("note-value");
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).toContain("discarded");
    expect(readdirSync(cwd)).toEqual(before);
  });

  it("rejects a hostile bracketed-paste payload during the text exercise without any side effect", () => {
    const cwd = scratchDir();
    const before = readdirSync(cwd);

    const result = runPty(cwd, "\r\r\x1b[200~first\r\nsecond\x1b[201~\r");

    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain("first");
    expect(readdirSync(cwd)).toEqual(before);
  });

  it("presents every fixed representative failure scenario without a real error", () => {
    const cwd = scratchDir();
    const scenarios = [
      ["\r\rnote\rsecret\r\r\x1b[B\r", "database-auth-migration"],
      ["\r\rnote\rsecret\r\r\x1b[B\x1b[B\r", "health-timeout"],
      ["\r\rnote\rsecret\r\r\x1b[B\x1b[B\x1b[B\r", "optional-unavailable"],
    ];

    for (const [input, expectedReason] of scenarios) {
      const result = runPty(cwd, input);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(expectedReason);
      expect(result.stdout).toContain("No deployment occurred.");
    }
  });
});
