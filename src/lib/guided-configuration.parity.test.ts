import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it, vi } from "vitest";

import { readGolden } from "./__fixtures__/golden";
import { PROCESS_TEST_TIMEOUT_MS, processWatchdog } from "../../scripts/process-budget.mjs";
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

// Two independent parity strategies for issue #295 slice 4:
//
// 1. Golden-file parity (missing_*_fields,
//    print_noninteractive_configuration_guidance): what install.sh's own
//    helpers printed for each fixture, captured before #1212 deleted them,
//    compared byte-for-byte against this module's pure functions.
// 2. Machine-prompt grammar parity (#297): the engine's
//    `orbit configure` is spawned with ORBIT_CONFIGURE_PROMPTS=machine and
//    driven through a reference adapter local to this file (not shipped)
//    built only from this module's own parseMachinePromptLine, and each
//    transcript is compared with what the retired configure.sh printed.

// This file spawns the engine CLI under node; a spawn that takes 0.7s quiet
// took 4.3s on a starved core (#698). Budget and reasoning:
// scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
// install.sh half: what its missing_*_fields and
// print_noninteractive_configuration_guidance produced, captured from
// 9757e42f before #1212 deleted them (src/lib/__fixtures__/README.md,
// flow install-guided-configuration). Golden-file characterization: the
// fixtures are bash's, never regenerated from this module. bash printed the
// field list with no trailing newline.

interface MissingFieldsGolden {
  cases: Array<{
    readiness: string;
    bash: Record<"required" | "guided" | "configuration", { stdout: string; stderr: string }>;
  }>;
}

const missingFields = readGolden<MissingFieldsGolden>("install-guided-configuration", "missing fields");

describe("missing_*_fields parity (golden)", () => {
  it("has every captured readiness fixture", () => {
    expect(missingFields.cases.length).toBe(4);
  });

  missingFields.cases.forEach((testCase, index) => {
    it(`agrees on missing_required_fields for fixture ${index}`, () => {
      expect(missingRequiredFields(testCase.readiness).join(" ")).toBe(testCase.bash.required.stdout);
    });

    it(`agrees on missing_guided_fields for fixture ${index}`, () => {
      expect(missingGuidedFields(testCase.readiness).join(" ")).toBe(testCase.bash.guided.stdout);
    });

    it(`agrees on missing_configuration_fields for fixture ${index}`, () => {
      expect(missingConfigurationFields(testCase.readiness).join(" ")).toBe(testCase.bash.configuration.stdout);
    });
  });
});

describe("print_noninteractive_configuration_guidance parity, guarantee #24 (golden)", () => {
  it("agrees byte-for-byte on the exact remediation lines", () => {
    const golden = readGolden<{ missing: string; bash: { stdout: string; stderr: string } }>(
      "install-guided-configuration",
      "noninteractive configuration guidance",
    );
    expect(golden.bash.stdout).toBe("");
    expect(noninteractiveConfigurationGuidance(golden.missing.split(" ")).join("\n") + "\n").toBe(golden.bash.stderr);
  });
});

// --- Real machine-prompt exchange against the engine ---------------------
//
// configure.sh's machine-prompt server is the engine since #1210 (configure.sh
// runs `orbit configure` in a container). These sessions drive this
// checkout's CLI directly, and each transcript is also compared with what
// the retired bash printed for the same answers
// (src/lib/__fixtures__/configure-machine-prompts).

const tsx = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cli = join(repoRoot, "src", "cli", "orbit.ts");

interface CapturedSession {
  status: number;
  stdout: string;
  env: string | null;
  secret: string | null;
}

function expectSameAsBash(name: string, sandbox: string, result: { ok: boolean; stdout: string }): void {
  const bash = readGolden<CapturedSession>("configure-machine-prompts", name);
  expect(result.ok).toBe(bash.status === 0);
  expect(result.stdout).toBe(bash.stdout);
  const envPath = join(sandbox, ".env-orbit");
  expect(existsSync(envPath) ? readFileSync(envPath, "utf8") : null).toBe(bash.env);
  const secretPath = join(sandbox, ".orbit-secrets", "oidc-client-secret");
  expect(existsSync(secretPath) ? readFileSync(secretPath, "utf8") : null).toBe(bash.secret);
}

const configureSandboxes: string[] = [];
function makeConfigureSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "orbit-guided-configuration-configure-parity-"));
  configureSandboxes.push(dir);
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
    const child = spawn("node", [tsx, cli, "configure", ...args, "--dir", cwd], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const events: MachinePromptLine[] = [];
    let stdout = "";
    let stderr = "";
    const watchdog = processWatchdog({ label: "runMachinePromptSession", kill: () => child.kill("SIGKILL") });

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      stdout += `${line}\n`;
      watchdog.touch();
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
      watchdog.touch();
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      watchdog.stop();
      if (watchdog.reason) {
        reject(watchdog.error({ stdout, stderr }));
        return;
      }
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
      ["--init"],
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
    expectSameAsBash("init oidc complete", sandbox, result);
  });

  it("rejects an invalid answer, reports the exact reason class, then accepts the retry (attempt=2)", async () => {
    const sandbox = makeConfigureSandbox();
    const env = { ...process.env, ORBIT_CONFIGURE_PROMPTS: "machine" };
    const result = await runMachinePromptSession(
      ["--init"],
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
    expectSameAsBash("init reject then accept", sandbox, result);
  });

  it("aborts after a third rejected answer without a fourth prompt, and writes nothing (docs/engine-events.md 'attempt is bounded at 3')", async () => {
    const sandbox = makeConfigureSandbox();
    const env = { ...process.env, ORBIT_CONFIGURE_PROMPTS: "machine" };
    const result = await runMachinePromptSession(
      ["--init"],
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
    expectSameAsBash("init abort after three", sandbox, result);
  });

  it("asks for APP_URL alone when ORBIT_CONFIGURE_AUTH_MODE=local (O1-F1)", async () => {
    const sandbox = makeConfigureSandbox();
    const env = { ...process.env, ORBIT_CONFIGURE_PROMPTS: "machine", ORBIT_CONFIGURE_AUTH_MODE: "local" };
    const result = await runMachinePromptSession(["--init"], sandbox, env, fixedAnswers({ APP_URL: "https://guided.parity.test" }));
    expect(result.events).toEqual([
      { type: "prompt", field: "APP_URL", kind: "url", required: "true", attempt: 1 },
      { type: "prompt-accept", field: "APP_URL" },
    ]);
    expectSameAsBash("init local mode", sandbox, result);
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
      ["--set-oidc-secret"],
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
    expectSameAsBash("secret accepted", sandbox, result);
  });

  it("rejects an empty secret with reason=empty", async () => {
    const sandbox = makeConfigureSandbox();
    seedDeployment(sandbox);
    const env = { ...process.env, ORBIT_CONFIGURE_PROMPTS: "machine" };
    const result = await runMachinePromptSession(
      ["--set-oidc-secret"],
      sandbox,
      env,
      fixedAnswers({ OIDC_CLIENT_SECRET: "" }),
    );

    expect(result.events[0]).toEqual({ type: "prompt", field: "OIDC_CLIENT_SECRET", kind: "secret", required: "true", attempt: 1 });
    expect(result.events[1]).toEqual({ type: "prompt-reject", field: "OIDC_CLIENT_SECRET", reason: "empty" });
    expectSameAsBash("secret empty", sandbox, result);
  });

  it("rejects an oversized secret with reason=too-large", async () => {
    const sandbox = makeConfigureSandbox();
    seedDeployment(sandbox);
    const env = { ...process.env, ORBIT_CONFIGURE_PROMPTS: "machine" };
    const oversized = "a".repeat(65537);
    const result = await runMachinePromptSession(
      ["--set-oidc-secret"],
      sandbox,
      env,
      fixedAnswers({ OIDC_CLIENT_SECRET: [oversized, "final-value"] }),
    );

    expect(result.events[1]).toEqual({ type: "prompt-reject", field: "OIDC_CLIENT_SECRET", reason: "too-large" });
    expect(result.ok).toBe(true);
    expectSameAsBash("secret too large then accepted", sandbox, result);
  });
});
