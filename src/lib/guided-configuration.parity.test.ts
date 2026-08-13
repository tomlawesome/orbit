import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";

import {
  missingConfigurationFields,
  missingGuidedFields,
  missingRequiredFields,
  noninteractiveConfigurationGuidance,
  parseMachinePromptLine,
  type MachinePromptAnswerProvider,
  type MachinePromptLine,
  type MachinePromptRequest,
  type MachinePromptSessionResult,
} from "./guided-configuration";

// Two independent parity strategies for issue #295 slice 4, mirroring the
// two shapes prior slices already established:
//
// 1. Source-extraction parity (missing_*_fields,
//    print_noninteractive_configuration_guidance): install.sh has no
//    standalone entry point for these helpers, so — exactly like
//    install-transaction.parity.test.ts and target-identity.parity.test.ts —
//    this test extracts (via awk, by function name, never hand-copied) the
//    exact current bodies from the real, unmodified scripts/install.sh,
//    wraps them in a minimal driver, and compares byte-for-byte against
//    this module's pure functions.
// 2. Whole-script parity for the #297 machine-prompt grammar itself:
//    scripts/configure.sh already has real, independently-invocable --init
//    and --set-oidc-secret entry points, so — exactly like
//    configuration-migration.parity.test.ts — this test spawns the real,
//    unmodified script directly with ORBIT_CONFIGURE_PROMPTS=machine, and
//    drives it through a reference adapter local to this file (not shipped)
//    built only from this module's own parseMachinePromptLine, proving the
//    exported grammar parser actually drives the live script to a
//    completed guided configuration — not just a stub.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const installScriptPath = join(repoRoot, "scripts", "install.sh");

function extractFunction(name: string): string {
  const script = `
    $0 ~ "^${name}\\\\(\\\\) \\\\{" { found = 1 }
    found { print; if ($0 == "}") { found = 0; exit } }
  `;
  const result = spawnSync("awk", [script, installScriptPath], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Could not extract ${name}() from install.sh; it may have been renamed.`);
  }
  return result.stdout;
}

const driverDir = mkdtempSync(join(tmpdir(), "orbit-guided-configuration-parity-driver-"));
const driverPath = join(driverDir, "driver.sh");

function buildDriverScript(): string {
  const functions = [
    "missing_required_fields",
    "missing_guided_fields",
    "missing_configuration_fields",
    "print_noninteractive_configuration_guidance",
  ]
    .map(extractFunction)
    .join("\n");

  return [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    "",
    functions,
    "",
    'mode="$1"; shift',
    'case "$mode" in',
    "  required) missing_required_fields \"$(cat)\" ;;",
    "  guided) missing_guided_fields \"$(cat)\" ;;",
    "  configuration) missing_configuration_fields \"$(cat)\" ;;",
    '  guidance) print_noninteractive_configuration_guidance "$1" ;;',
    "esac",
    "",
  ].join("\n");
}

writeFileSync(driverPath, buildDriverScript(), { mode: 0o755 });

afterAll(() => {
  rmSync(driverDir, { recursive: true, force: true });
});

function runDriver(mode: "required" | "guided" | "configuration", readiness: string): { stdout: string; stderr: string };
function runDriver(mode: "guidance", missing: string): { stdout: string; stderr: string };
function runDriver(mode: string, input: string): { stdout: string; stderr: string } {
  const args = mode === "guidance" ? [driverPath, mode, input] : [driverPath, mode];
  const result = spawnSync("bash", args, {
    encoding: "utf8",
    input: mode === "guidance" ? undefined : input,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

const READINESS_FIXTURES = [
  "ready APP_URL\nready ORBIT_IMAGE\nready OIDC_ISSUER\nready OIDC_CLIENT_ID\nready OIDC_CLIENT_SECRET\nready OIDC_CALLBACK_URL\noptional processing\noptional ai\noptional mail\noptional imap\noptional push\n",
  "missing APP_URL\nmissing ORBIT_IMAGE\nmissing OIDC_ISSUER\nmissing OIDC_CLIENT_ID\nmissing OIDC_CLIENT_SECRET\nmissing OIDC_CALLBACK_URL\noptional processing\noptional ai\noptional mail\noptional imap\noptional push\n",
  "ready APP_URL\nready ORBIT_IMAGE\nmissing OIDC_ISSUER\nready OIDC_CLIENT_ID\nmissing OIDC_CLIENT_SECRET\nready OIDC_CALLBACK_URL\nmissing processing\nmissing ai\noptional mail\noptional imap\noptional push\n",
  "",
];

describe("missing_*_fields parity (install.sh:843-877)", () => {
  it.each(READINESS_FIXTURES)("agrees on missing_required_fields for fixture %#", (readiness) => {
    const bash = runDriver("required", readiness);
    expect(bash.stdout).toBe(missingRequiredFields(readiness).join(" "));
  });

  it.each(READINESS_FIXTURES)("agrees on missing_guided_fields for fixture %#", (readiness) => {
    const bash = runDriver("guided", readiness);
    expect(bash.stdout).toBe(missingGuidedFields(readiness).join(" "));
  });

  it.each(READINESS_FIXTURES)("agrees on missing_configuration_fields for fixture %#", (readiness) => {
    const bash = runDriver("configuration", readiness);
    expect(bash.stdout).toBe(missingConfigurationFields(readiness).join(" "));
  });
});

describe("print_noninteractive_configuration_guidance parity (install.sh:879-885, guarantee #24)", () => {
  it("agrees byte-for-byte on the exact remediation lines", () => {
    const missing = "APP_URL OIDC_CLIENT_SECRET";
    const bash = runDriver("guidance", missing);
    expect(bash.stderr).toBe(noninteractiveConfigurationGuidance(missing.split(" ")).join("\n") + "\n");
  });
});

// --- Real machine-prompt exchange against the unmodified configure.sh ---

const configureSandboxes: string[] = [];
function makeConfigureSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "orbit-guided-configuration-configure-parity-"));
  configureSandboxes.push(dir);
  mkdirSync(join(dir, "scripts"));
  cpSync(join(repoRoot, "scripts", "configure.sh"), join(dir, "scripts", "configure.sh"));
  cpSync(join(repoRoot, ".env-orbit.example"), join(dir, ".env-orbit.example"));
  return dir;
}

afterAll(() => {
  for (const sandbox of configureSandboxes) rmSync(sandbox, { recursive: true, force: true });
});

/**
 * Reference adapter, local to this test file (not shipped — see
 * guided-configuration.ts's module comment for why): spawns the real,
 * unmodified configure.sh with ORBIT_CONFIGURE_PROMPTS=machine and drives
 * it to completion using only this module's own parseMachinePromptLine and
 * a caller-supplied MachinePromptAnswerProvider — the same generic,
 * schema-blind driving loop scripts/engine-prompt-renderer.fixture.mjs
 * demonstrates, reimplemented here against this module's own types so the
 * exported parser is proven against the live script, not a stub.
 */
function runMachinePromptSession(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  answers: MachinePromptAnswerProvider,
): Promise<MachinePromptSessionResult & { stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const events: MachinePromptLine[] = [];
    let stdout = "";
    let stderr = "";

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      stdout += `${line}\n`;
      const parsed = parseMachinePromptLine(line);
      if (!parsed) return;
      events.push(parsed);
      if (parsed.type === "prompt") {
        const request: MachinePromptRequest = { field: parsed.field, kind: parsed.kind, attempt: parsed.attempt };
        Promise.resolve(answers.answer(request)).then((answer) => {
          child.stdin.write(`${answer}\n`);
        });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ ok: exitCode === 0, events, stdout, stderr });
    });
  });
}

function fixedAnswers(values: Record<string, string | string[]>): MachinePromptAnswerProvider {
  return {
    answer(request) {
      const queue = values[request.field];
      if (Array.isArray(queue)) {
        return queue.length > 1 ? queue.shift()! : queue[0];
      }
      return queue ?? "";
    },
  };
}

describe("real ORBIT_CONFIGURE_PROMPTS=machine --init parity", () => {
  it("completes a guided init end-to-end, writing the expected .env-orbit content", async () => {
    const sandbox = makeConfigureSandbox();
    const env = { ...process.env, ORBIT_CONFIGURE_PROMPTS: "machine" };
    const result = await runMachinePromptSession(
      [join(sandbox, "scripts", "configure.sh"), "--init"],
      sandbox,
      env,
      fixedAnswers({
        APP_URL: "https://guided.parity.test",
        OIDC_ISSUER: "https://issuer.parity.test",
        OIDC_CLIENT_ID: "parity-client",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.events).toEqual([
      { type: "prompt", field: "APP_URL", kind: "url", required: "true", attempt: 1 },
      { type: "prompt-accept", field: "APP_URL" },
      { type: "prompt", field: "OIDC_ISSUER", kind: "url", required: "true", attempt: 1 },
      { type: "prompt-accept", field: "OIDC_ISSUER" },
      { type: "prompt", field: "OIDC_CLIENT_ID", kind: "text", required: "true", attempt: 1 },
      { type: "prompt-accept", field: "OIDC_CLIENT_ID" },
    ]);
    // No prompt line ever carries a value (docs/engine-events.md §Security).
    expect(result.stdout).not.toContain("guided.parity.test");
    expect(result.stdout).not.toContain("parity-client");

    const envOrbit = readFileSync(join(sandbox, ".env-orbit"), "utf8");
    expect(envOrbit).toContain("APP_URL=https://guided.parity.test");
    expect(envOrbit).toContain("OIDC_ISSUER=https://issuer.parity.test");
    expect(envOrbit).toContain("OIDC_CLIENT_ID=parity-client");
    expect(envOrbit).toContain("OIDC_CALLBACK_URL=https://guided.parity.test/api/auth/callback");
  });

  it("rejects an invalid answer, reports the exact reason class, then accepts the retry (attempt=2)", async () => {
    const sandbox = makeConfigureSandbox();
    const env = { ...process.env, ORBIT_CONFIGURE_PROMPTS: "machine" };
    const result = await runMachinePromptSession(
      [join(sandbox, "scripts", "configure.sh"), "--init"],
      sandbox,
      env,
      fixedAnswers({
        APP_URL: ["http://not-https.parity.test", "https://guided.parity.test"],
        OIDC_ISSUER: "https://issuer.parity.test",
        OIDC_CLIENT_ID: "parity-client",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.events.slice(0, 3)).toEqual([
      { type: "prompt", field: "APP_URL", kind: "url", required: "true", attempt: 1 },
      { type: "prompt-reject", field: "APP_URL", reason: "not-https" },
      { type: "prompt", field: "APP_URL", kind: "url", required: "true", attempt: 2 },
    ]);
  });

  it("aborts after a third rejected answer without a fourth prompt, and writes nothing (docs/engine-events.md 'attempt is bounded at 3')", async () => {
    const sandbox = makeConfigureSandbox();
    const env = { ...process.env, ORBIT_CONFIGURE_PROMPTS: "machine" };
    const result = await runMachinePromptSession(
      [join(sandbox, "scripts", "configure.sh"), "--init"],
      sandbox,
      env,
      fixedAnswers({ APP_URL: "" }),
    );

    expect(result.ok).toBe(false);
    expect(result.events).toEqual([
      { type: "prompt", field: "APP_URL", kind: "url", required: "true", attempt: 1 },
      { type: "prompt-reject", field: "APP_URL", reason: "empty" },
      { type: "prompt", field: "APP_URL", kind: "url", required: "true", attempt: 2 },
      { type: "prompt-reject", field: "APP_URL", reason: "empty" },
      { type: "prompt", field: "APP_URL", kind: "url", required: "true", attempt: 3 },
      { type: "prompt-reject", field: "APP_URL", reason: "empty" },
      { type: "prompt-abort", field: "APP_URL" },
    ]);
    // guarantee (configure.sh:529-549): nothing is written until every
    // field validates — an aborted guided init leaves no .env-orbit behind.
    expect(() => readFileSync(join(sandbox, ".env-orbit"), "utf8")).toThrow();
  });
});

describe("real ORBIT_CONFIGURE_PROMPTS=machine --set-oidc-secret parity", () => {
  function seedDeployment(sandbox: string): void {
    writeFileSync(
      join(sandbox, ".env-orbit"),
      ["APP_URL=https://guided.parity.test", "OIDC_ISSUER=https://issuer.parity.test", ""].join("\n"),
      { mode: 0o600 },
    );
  }

  it("collects a valid secret without ever echoing it in any prompt line", async () => {
    const sandbox = makeConfigureSandbox();
    seedDeployment(sandbox);
    const env = { ...process.env, ORBIT_CONFIGURE_PROMPTS: "machine" };
    const secretValue = "s3cr3t-parity-value";
    const result = await runMachinePromptSession(
      [join(sandbox, "scripts", "configure.sh"), "--set-oidc-secret"],
      sandbox,
      env,
      fixedAnswers({ OIDC_CLIENT_SECRET: secretValue }),
    );

    expect(result.ok).toBe(true);
    expect(result.events).toEqual([
      { type: "prompt", field: "OIDC_CLIENT_SECRET", kind: "secret", required: "true", attempt: 1 },
      { type: "prompt-accept", field: "OIDC_CLIENT_SECRET" },
    ]);
    expect(result.stdout).not.toContain(secretValue);
    expect(result.stderr).not.toContain(secretValue);

    const secretFile = readFileSync(join(sandbox, ".orbit-secrets", "oidc-client-secret"), "utf8");
    expect(secretFile).toBe(secretValue);
  });

  it("rejects an empty secret with reason=empty", async () => {
    const sandbox = makeConfigureSandbox();
    seedDeployment(sandbox);
    const env = { ...process.env, ORBIT_CONFIGURE_PROMPTS: "machine" };
    const result = await runMachinePromptSession(
      [join(sandbox, "scripts", "configure.sh"), "--set-oidc-secret"],
      sandbox,
      env,
      fixedAnswers({ OIDC_CLIENT_SECRET: "" }),
    );

    expect(result.events[0]).toEqual({ type: "prompt", field: "OIDC_CLIENT_SECRET", kind: "secret", required: "true", attempt: 1 });
    expect(result.events[1]).toEqual({ type: "prompt-reject", field: "OIDC_CLIENT_SECRET", reason: "empty" });
  });

  it("rejects an oversized secret with reason=too-large", async () => {
    const sandbox = makeConfigureSandbox();
    seedDeployment(sandbox);
    const env = { ...process.env, ORBIT_CONFIGURE_PROMPTS: "machine" };
    const oversized = "a".repeat(65537);
    const result = await runMachinePromptSession(
      [join(sandbox, "scripts", "configure.sh"), "--set-oidc-secret"],
      sandbox,
      env,
      fixedAnswers({ OIDC_CLIENT_SECRET: [oversized, "final-value"] }),
    );

    expect(result.events[1]).toEqual({ type: "prompt-reject", field: "OIDC_CLIENT_SECRET", reason: "too-large" });
    expect(result.ok).toBe(true);
  });
});
