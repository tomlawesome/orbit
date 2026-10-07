import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../../scripts/process-budget.mjs";

// `orbit configure` end-to-end (issue #294): the write side of
// scripts/configure.sh, ported onto src/lib/configure-engine.ts and wired
// into src/cli/orbit.ts. Spawns the real CLI entry point, mirroring
// src/cli/orbit.test.ts's own spawn convention.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cli = fileURLToPath(new URL("./orbit.ts", import.meta.url));
const tsx = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

// Every test here spawns the real CLI, some three times over, and a spawn
// that takes 0.7s quiet took 4.3s on a starved core (#698). The budget and
// the reasoning live in scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

function runCli(args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}): { status: number; stdout: string; stderr: string } {
  const result = failOnProcessDeadline(spawnSync("node", [tsx, cli, ...args], {
    encoding: "utf8",
    input: options.input,
    env: options.env ?? process.env,
    ...processGuard(),
  }), { label: "runCli" });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "orbit-cli-configure-"));
  writeFileSync(join(sandbox, ".env-orbit.example"), readFileSync(join(repoRoot, ".env-orbit.example")));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("orbit configure (bare, no flags): the whole write side", () => {
  it("creates .env-orbit and .orbit-secrets, generating the three secrets and the VAPID pair", () => {
    const result = runCli(["configure", "--dir", sandbox]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Created .env-orbit from .env-orbit.example.");
    expect(statSync(join(sandbox, ".env-orbit")).mode & 0o777).toBe(0o600);
    expect(statSync(join(sandbox, ".orbit-secrets")).mode & 0o777).toBe(0o700);
    for (const name of ["session-secret", "postgres-password", "document-kek"]) {
      const secretPath = join(sandbox, ".orbit-secrets", name);
      expect(readFileSync(secretPath, "utf8")).toMatch(/^[0-9a-f]{64}\n$/);
      expect(statSync(secretPath).mode & 0o777).toBe(0o600);
    }
    // #1210 D7: the engine generates the VAPID pair itself now.
    expect(existsSync(join(sandbox, ".orbit-secrets", "vapid-private-key"))).toBe(true);
    expect(result.stdout).toContain("Generated VAPID push keys.\n");
  });

  it("guarantee #33: is idempotent — a second run preserves already-generated secrets", () => {
    expect(runCli(["configure", "--dir", sandbox]).status).toBe(0);
    const first = readFileSync(join(sandbox, ".orbit-secrets", "session-secret"), "utf8");
    const second = runCli(["configure", "--dir", sandbox]);
    expect(second.status).toBe(0);
    expect(second.stdout).not.toContain("Generated");
    expect(readFileSync(join(sandbox, ".orbit-secrets", "session-secret"), "utf8")).toBe(first);
  });

  it("persists a valid ORBIT_IMAGE from the environment", () => {
    const digestImage = "ghcr.io/tomlawesome/orbit@sha256:" + "b".repeat(64);
    const result = runCli(["configure", "--dir", sandbox], { env: { ...process.env, ORBIT_IMAGE: digestImage } });
    expect(result.status).toBe(0);
    expect(readFileSync(join(sandbox, ".env-orbit"), "utf8")).toContain(`ORBIT_IMAGE=${digestImage}`);
  });

  it("fails closed (exit 1) rather than silently succeeding when .env-orbit.example is missing", () => {
    rmSync(join(sandbox, ".env-orbit.example"));
    const result = runCli(["configure", "--dir", sandbox]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("orbit:");
    expect(existsSync(join(sandbox, ".env-orbit"))).toBe(false);
  });
});

describe("orbit configure --init", () => {
  it("the fully-scripted ORBIT_CONFIGURE_* environment triad writes APP_URL/OIDC_ISSUER/OIDC_CLIENT_ID/OIDC_CALLBACK_URL", () => {
    const result = runCli(["configure", "--init", "--dir", sandbox], {
      env: {
        ...process.env,
        ORBIT_CONFIGURE_APP_URL: "https://orbit.cli-init-test.invalid",
        ORBIT_CONFIGURE_OIDC_ISSUER: "https://auth.cli-init-test.invalid/application/o/orbit/",
        ORBIT_CONFIGURE_OIDC_CLIENT_ID: "cli-init-client",
      },
    });
    expect(result.status).toBe(0);
    const content = readFileSync(join(sandbox, ".env-orbit"), "utf8");
    expect(content).toContain("APP_URL=https://orbit.cli-init-test.invalid");
    expect(content).toContain("OIDC_ISSUER=https://auth.cli-init-test.invalid/application/o/orbit/");
    expect(content).toContain("OIDC_CLIENT_ID=cli-init-client");
    expect(content).toContain("OIDC_CALLBACK_URL=https://orbit.cli-init-test.invalid/api/auth/callback");
  });

  it("refuses a partial ORBIT_CONFIGURE_* triad rather than blending in a missing field", () => {
    const result = runCli(["configure", "--init", "--dir", sandbox], {
      env: { ...process.env, ORBIT_CONFIGURE_APP_URL: "https://orbit.cli-init-test.invalid" },
    });
    expect(result.status).toBe(1);
    expect(existsSync(join(sandbox, ".env-orbit"))).toBe(false);
  });

  it("ORBIT_CONFIGURE_PROMPTS=machine drives the #297 line grammar over stdin/stdout end-to-end", () => {
    const transcript = ["https://orbit.cli-machine-test.invalid", "https://auth.cli-machine-test.invalid/", "cli-machine-client", ""].join("\n");
    const result = runCli(["configure", "--init", "--dir", sandbox], {
      input: transcript,
      env: { ...process.env, ORBIT_CONFIGURE_PROMPTS: "machine" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("prompt field=APP_URL kind=url required=true attempt=1");
    expect(result.stdout).toContain("prompt-accept field=APP_URL");
    expect(result.stdout).toContain("prompt field=OIDC_ISSUER kind=url required=true attempt=1");
    expect(result.stdout).toContain("prompt field=OIDC_CLIENT_ID kind=text required=true attempt=1");
    const content = readFileSync(join(sandbox, ".env-orbit"), "utf8");
    expect(content).toContain("APP_URL=https://orbit.cli-machine-test.invalid");
    expect(content).toContain("OIDC_CLIENT_ID=cli-machine-client");
  });

  it("ORBIT_CONFIGURE_AUTH_MODE=local, machine-prompt mode: asks for APP_URL only and saves local-only auth (#1151 O1-F1)", () => {
    const transcript = ["https://orbit.cli-local-test.invalid", ""].join("\n");
    const result = runCli(["configure", "--init", "--dir", sandbox], {
      input: transcript,
      env: { ...process.env, ORBIT_CONFIGURE_PROMPTS: "machine", ORBIT_CONFIGURE_AUTH_MODE: "local" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("prompt field=APP_URL kind=url required=true attempt=1");
    expect(result.stdout).not.toContain("field=OIDC_ISSUER");
    expect(result.stdout).not.toContain("field=OIDC_CLIENT_ID");
    const content = readFileSync(join(sandbox, ".env-orbit"), "utf8");
    expect(content).toContain("APP_URL=https://orbit.cli-local-test.invalid");
    expect(content).toContain("ORBIT_AUTH_OIDC=false");
    // Local-only never touches OIDC_*: switching the provider off must not
    // force deleting its configuration (ADR-0023 section 1) — the example
    // template's own placeholder OIDC_ISSUER survives untouched.
    expect(content).toContain("OIDC_ISSUER=https://auth.example.com/application/o/orbit/");
  });

  it("ORBIT_CONFIGURE_PROMPTS=machine rejects, retries, and aborts cleanly on repeated invalid answers, writing nothing", () => {
    const transcript = ["not-https", "still-not-https", "nope-again", ""].join("\n");
    const result = runCli(["configure", "--init", "--dir", sandbox], {
      input: transcript,
      env: { ...process.env, ORBIT_CONFIGURE_PROMPTS: "machine" },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("prompt-reject field=APP_URL reason=not-https");
    expect(result.stdout).toContain("prompt-abort field=APP_URL");
    expect(existsSync(join(sandbox, ".env-orbit"))).toBe(false);
  });

  it("refuses (no crash, no partial write) with no answers, no machine prompts and no terminal", () => {
    const result = runCli(["configure", "--init", "--dir", sandbox]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Guided configuration needs a controlling terminal, or the complete ORBIT_CONFIGURE_APP_URL");
    expect(existsSync(join(sandbox, ".env-orbit"))).toBe(false);
  });
});

describe("orbit configure --set-oidc-secret", () => {
  it("reads a single piped line and writes the canonical secret file plus .env-orbit pointers, never echoing the value", () => {
    const secret = "cli-oidc-secret-value";
    const result = runCli(["configure", "--set-oidc-secret", "--dir", sandbox], { input: `${secret}\n` });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
    const secretPath = join(sandbox, ".orbit-secrets", "oidc-client-secret");
    expect(readFileSync(secretPath, "utf8")).toBe(secret);
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(sandbox, ".env-orbit"), "utf8")).toContain("OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret");
  });

  it("ORBIT_CONFIGURE_PROMPTS=machine collects the secret via the prompt grammar without ever echoing it", () => {
    const secret = "cli-machine-oidc-secret";
    const result = runCli(["configure", "--set-oidc-secret", "--dir", sandbox], {
      input: `${secret}\n`,
      env: { ...process.env, ORBIT_CONFIGURE_PROMPTS: "machine" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("prompt field=OIDC_CLIENT_SECRET kind=secret required=true attempt=1");
    expect(result.stdout).toContain("prompt-accept field=OIDC_CLIENT_SECRET");
    expect(result.stdout).not.toContain(secret);
    expect(readFileSync(join(sandbox, ".orbit-secrets", "oidc-client-secret"), "utf8")).toBe(secret);
  });

  it("refuses on an empty piped answer without creating any secret file", () => {
    const result = runCli(["configure", "--set-oidc-secret", "--dir", sandbox], { input: "" });
    expect(result.status).toBe(1);
    expect(existsSync(join(sandbox, ".orbit-secrets"))).toBe(false);
  });
});

describe("orbit configure --set-deployment-profile", () => {
  beforeEach(() => {
    expect(runCli(["configure", "--dir", sandbox]).status).toBe(0);
  });

  it("standard clears the profile fields", () => {
    const result = runCli(["configure", "--set-deployment-profile", "standard", "--dir", sandbox]);
    expect(result.status).toBe(0);
    expect(readFileSync(join(sandbox, ".env-orbit"), "utf8")).toContain("COMPOSE_PROFILES=\n");
  });

  it("ai sets the profile and model, and requires one", () => {
    const missingModel = runCli(["configure", "--set-deployment-profile", "ai", "--dir", sandbox]);
    expect(missingModel.status).toBe(2);

    const result = runCli(["configure", "--set-deployment-profile", "ai", "llama3:8b", "--dir", sandbox]);
    expect(result.status).toBe(0);
    const content = readFileSync(join(sandbox, ".env-orbit"), "utf8");
    expect(content).toContain("COMPOSE_PROFILES=ai\n");
    expect(content).toContain("OLLAMA_MODEL=llama3:8b\n");
  });

  it("an unknown preset exits 2 (usage error), not 1", () => {
    const result = runCli(["configure", "--set-deployment-profile", "bogus", "--dir", sandbox]);
    expect(result.status).toBe(2);
  });

  it("wrong argument count exits 2 with a usage message", () => {
    const result = runCli(["configure", "--set-deployment-profile", "--dir", sandbox]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage");
  });
});

describe("orbit configure: unknown option", () => {
  it("exits 2 with a usage message for an unrecognised flag", () => {
    const result = runCli(["configure", "--bogus", "--dir", sandbox]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage");
  });
});

describe("in-container fail-closed guard: configure is unaffected, like check", () => {
  it("runs fully in ORBIT_ENGINE_CONTEXT=container mode without ever touching docker", () => {
    const binDir = mkdtempSync(join(tmpdir(), "orbit-configure-guard-fakebin-"));
    const callLogPath = join(sandbox, "docker-calls.log");
    writeFileSync(callLogPath, "");
    const script = ["#!/usr/bin/env bash", `printf 'TRAPPED: docker %s\\n' "$*" >> '${callLogPath}'`, "exit 99", ""].join("\n");
    writeFileSync(join(binDir, "docker"), script, { mode: 0o755 });

    const result = runCli(["configure", "--dir", sandbox], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ORBIT_ENGINE_CONTEXT: "container" },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(callLogPath, "utf8")).toBe("");
    rmSync(binDir, { recursive: true, force: true });
  });
});

// Cases of the retired scripts/configure.test.mjs that no other engine test
// covered, ported onto `orbit configure` before that suite was deleted
// (#1210 build note D10; the mapping is docs/adr-notes/1210-bash-test-
// retirement.md). Same titles, setup and assertions; refusals now read
// "orbit:" where configure.sh printed "Orbit configuration:".
describe("orbit configure (ported from scripts/configure.test.mjs)", () => {
  const validAppUrl = "https://orbit.guided-test.internal";
  const validIssuer = "https://auth.guided-test.internal/application/o/orbit/";
  const validClientId = "guided-test-client-id";
  const bareEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: process.env.HOME, ...extra });
  const envFile = () => join(sandbox, ".env-orbit");
  const leftovers = () => readdirSync(sandbox).filter((name) => name.includes(".updating.") || name.includes(".installing."));

  function seed(content: string): void {
    writeFileSync(envFile(), content, { mode: 0o600 });
  }

  it("rejects missing or hostile local-model identifiers without mutation or disclosure", () => {
    const initial = "COMPOSE_PROFILES=\nTIKA_URL=\nOLLAMA_MODEL=\n";
    seed(initial);

    const missing = runCli(["configure", "--set-deployment-profile", "full", "--dir", sandbox], { env: bareEnv() });
    expect(missing.status).toBe(2);
    expect(readFileSync(envFile(), "utf8")).toBe(initial);

    const hostileValue = "private-model;print-secret";
    const hostile = runCli(["configure", "--set-deployment-profile", "full", hostileValue, "--dir", sandbox], { env: bareEnv() });
    expect(hostile.status).toBe(2);
    expect(`${hostile.stdout}${hostile.stderr}`).not.toContain(hostileValue);
    expect(readFileSync(envFile(), "utf8")).toBe(initial);
  });

  it("--init derives and atomically writes all four values and ORBIT_AUTH_OIDC=true from a complete environment set without printing them", () => {
    seed("UNRELATED_KEY=keep-me\n");

    const result = runCli(["configure", "--init", "--dir", sandbox], {
      env: bareEnv({
        ORBIT_CONFIGURE_APP_URL: validAppUrl,
        ORBIT_CONFIGURE_OIDC_ISSUER: validIssuer,
        ORBIT_CONFIGURE_OIDC_CLIENT_ID: validClientId,
      }),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(validClientId);
    expect(result.stdout).not.toContain("orbit.guided-test.internal");
    const updated = readFileSync(envFile(), "utf8");
    expect(updated).toContain("UNRELATED_KEY=keep-me");
    expect(updated).toContain(`APP_URL=${validAppUrl}`);
    expect(updated).toContain("ORBIT_AUTH_OIDC=true");
    expect(updated).toContain(`OIDC_ISSUER=${validIssuer}`);
    expect(updated).toContain(`OIDC_CLIENT_ID=${validClientId}`);
    expect(updated).toContain(`OIDC_CALLBACK_URL=${validAppUrl}/api/auth/callback`);
    expect(leftovers()).toEqual([]);
  });

  it("--init with ORBIT_CONFIGURE_AUTH_MODE=local writes only APP_URL and ORBIT_AUTH_OIDC=false, never the OIDC trio", () => {
    seed("UNRELATED_KEY=keep-me\n");

    const result = runCli(["configure", "--init", "--dir", sandbox], {
      env: bareEnv({ ORBIT_CONFIGURE_AUTH_MODE: "local", ORBIT_CONFIGURE_APP_URL: validAppUrl }),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ORBIT_AUTH_OIDC=false");
    const updated = readFileSync(envFile(), "utf8");
    expect(updated).toContain("UNRELATED_KEY=keep-me");
    expect(updated).toContain(`APP_URL=${validAppUrl}`);
    expect(updated).toContain("ORBIT_AUTH_OIDC=false");
    expect(updated).not.toContain("OIDC_ISSUER=");
    expect(updated).not.toContain("OIDC_CLIENT_ID=");
    expect(updated).not.toContain("OIDC_CALLBACK_URL=");
  });

  it("--init switching to local-only preserves an existing OIDC configuration instead of deleting it (ADR-0023 section 1)", () => {
    seed(
      [
        "APP_URL=https://old.guided-test.internal",
        "OIDC_ISSUER=https://old-auth.guided-test.internal/o/orbit/",
        "OIDC_CLIENT_ID=old-client-id",
        "OIDC_CALLBACK_URL=https://old.guided-test.internal/api/auth/callback",
        "",
      ].join("\n"),
    );

    const result = runCli(["configure", "--init", "--dir", sandbox], {
      env: bareEnv({ ORBIT_CONFIGURE_AUTH_MODE: "local", ORBIT_CONFIGURE_APP_URL: validAppUrl }),
    });

    expect(result.status).toBe(0);
    const updated = readFileSync(envFile(), "utf8");
    expect(updated).toContain(`APP_URL=${validAppUrl}`);
    expect(updated).toContain("ORBIT_AUTH_OIDC=false");
    expect(updated).toContain("OIDC_ISSUER=https://old-auth.guided-test.internal/o/orbit/");
    expect(updated).toContain("OIDC_CLIENT_ID=old-client-id");
  });

  it("--init rejects ORBIT_CONFIGURE_AUTH_MODE=local combined with a complete OIDC environment set", () => {
    const initial = "UNRELATED_KEY=keep-me\n";
    seed(initial);

    const result = runCli(["configure", "--init", "--dir", sandbox], {
      env: bareEnv({
        ORBIT_CONFIGURE_AUTH_MODE: "local",
        ORBIT_CONFIGURE_APP_URL: validAppUrl,
        ORBIT_CONFIGURE_OIDC_ISSUER: validIssuer,
        ORBIT_CONFIGURE_OIDC_CLIENT_ID: validClientId,
      }),
    });

    expect(result.status).not.toBe(0);
    expect(readFileSync(envFile(), "utf8")).toBe(initial);
    expect(leftovers()).toEqual([]);
  });

  it("--init rejects an invalid ORBIT_CONFIGURE_AUTH_MODE value without mutation", () => {
    const initial = "UNRELATED_KEY=keep-me\n";
    seed(initial);

    const result = runCli(["configure", "--init", "--dir", sandbox], {
      env: bareEnv({ ORBIT_CONFIGURE_AUTH_MODE: "sso", ORBIT_CONFIGURE_APP_URL: validAppUrl }),
    });

    expect(result.status).not.toBe(0);
    expect(readFileSync(envFile(), "utf8")).toBe(initial);
  });

  it("--set-oidc-secret rejects an empty line on standard input without creating an environment file or secret", () => {
    const result = runCli(["configure", "--set-oidc-secret", "--dir", sandbox], { input: "\n", env: bareEnv() });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("non-empty OIDC client secret");
    expect(existsSync(envFile())).toBe(false);
    expect(existsSync(join(sandbox, ".orbit-secrets", "oidc-client-secret"))).toBe(false);
  });
});
