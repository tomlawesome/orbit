import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../../scripts/process-budget.mjs";
import {
  CANONICAL_OIDC_SECRET_FILE_PATH,
  evaluateReadiness,
  type EnvOrbitRecord,
  type OidcSecretFileFacts,
} from "./config-contract";
import { readGolden } from "./__fixtures__/golden";

// Cross-implementation parity: for identical fixtures, the TypeScript
// contract's readiness report and `orbit check` must equal what the retired
// bash `configure.sh --check` printed, line for line. The bash output was
// captured from b0ee5929 into src/lib/__fixtures__/configure-check
// (#1210 D10); configure.sh --check now runs `orbit check` itself.

// This file spawns the real CLI; a spawn that takes 0.7s quiet took 4.3s on
// a starved core (#698). Budget and reasoning: scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const sandboxes: string[] = [];

afterAll(() => {
  for (const sandbox of sandboxes) rmSync(sandbox, { recursive: true, force: true });
});

interface Fixture {
  record: EnvOrbitRecord;
  provisionSecretFile?: boolean;
  secretsDirectoryMode?: number;
}

interface CheckResult {
  lines: string[];
  status: number;
}

function makeSandbox(fixture: Fixture): string {
  const sandbox = mkdtempSync(join(tmpdir(), "orbit-contract-parity."));
  sandboxes.push(sandbox);
  const secretsDirectory = join(sandbox, ".orbit-secrets");
  mkdirSync(secretsDirectory);
  chmodSync(secretsDirectory, fixture.secretsDirectoryMode ?? 0o700);
  if (fixture.provisionSecretFile ?? true) {
    const secretFile = join(secretsDirectory, "oidc-client-secret");
    writeFileSync(secretFile, "parity-fixture-secret\n");
    chmodSync(secretFile, 0o600);
  }
  const body = Object.entries(fixture.record)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  writeFileSync(join(sandbox, ".env-orbit"), `${body}\n`);
  chmodSync(join(sandbox, ".env-orbit"), 0o600);
  return sandbox;
}

function factsFor(sandbox: string): OidcSecretFileFacts {
  const secretsDirectory = join(sandbox, ".orbit-secrets");
  const secretFile = join(secretsDirectory, "oidc-client-secret");
  const directoryStat = statSync(secretsDirectory, { throwIfNoEntry: false });
  const fileStat = lstatSync(secretFile, { throwIfNoEntry: false });
  return {
    secretsDirectoryExists: directoryStat !== undefined,
    secretsDirectoryIsSymlink: false,
    secretsDirectoryMode: directoryStat ? directoryStat.mode & 0o777 : null,
    secretFileExists: fileStat !== undefined,
    secretFileIsRegular: fileStat?.isFile() ?? false,
    secretFileIsSymlink: fileStat?.isSymbolicLink() ?? false,
    secretFileMode: fileStat ? fileStat.mode & 0o777 : null,
    secretFileSize: fileStat?.size ?? 0,
  };
}

const completeCore: EnvOrbitRecord = {
  APP_URL: "https://orbit.parity.invalid",
  ORBIT_AUTH_OIDC: "true",
  OIDC_ISSUER: "https://oidc.parity.invalid/application/o/orbit/",
  OIDC_CLIENT_ID: "orbit-parity",
  OIDC_CLIENT_SECRET_FILE: CANONICAL_OIDC_SECRET_FILE_PATH,
  OIDC_CALLBACK_URL: "https://orbit.parity.invalid/api/auth/callback",
  ORBIT_IMAGE:
    "registry.parity.invalid/acceptance/orbit@sha256:" + "a".repeat(64),
};

const fixtures: Record<string, Fixture> = {
  "complete core, no optional groups": { record: completeCore },
  // ADR-0023 §1 (M7 slice 1): local sign-in is always available; OIDC is
  // enabled only by this explicit key.
  "local-only: ORBIT_AUTH_OIDC unset, OIDC fields absent": {
    record: {
      APP_URL: completeCore.APP_URL,
      ORBIT_IMAGE: completeCore.ORBIT_IMAGE,
    },
  },
  "ORBIT_AUTH_OIDC=false with a full provider block left in place stays ready, fields not in use": {
    record: { ...completeCore, ORBIT_AUTH_OIDC: "false" },
  },
  "ORBIT_AUTH_OIDC=true with a blank OIDC_ISSUER fails readiness by field name": {
    record: { ...completeCore, OIDC_ISSUER: "" },
  },
  "loopback APP_URL is not deployment-ready": {
    record: {
      ...completeCore,
      APP_URL: "http://127.0.0.1:3000",
      OIDC_CALLBACK_URL: "http://127.0.0.1:3000/api/auth/callback",
    },
  },
  "example.com placeholder refused": {
    record: {
      ...completeCore,
      APP_URL: "https://orbit.example.com",
      OIDC_CALLBACK_URL: "https://orbit.example.com/api/auth/callback",
    },
  },
  "mutable image tag is not ready": {
    record: { ...completeCore, ORBIT_IMAGE: "ghcr.io/tomlawesome/orbit:latest" },
  },
  "non-canonical secret path is not ready": {
    record: {
      ...completeCore,
      OIDC_CLIENT_SECRET_FILE: ".orbit-secrets/oidc-client-secret",
    },
  },
  "missing secret file is not ready": {
    record: completeCore,
    provisionSecretFile: false,
  },
  "loose secrets directory is not ready": {
    record: completeCore,
    secretsDirectoryMode: 0o755,
  },
  "callback must derive exactly from APP_URL": {
    record: {
      ...completeCore,
      OIDC_CALLBACK_URL: "https://other.parity.invalid/api/auth/callback",
    },
  },
  "partial SMTP group reports missing mail": {
    record: { ...completeCore, SMTP_HOST: "smtp.parity.invalid" },
  },
  "complete SMTP group reports ready mail": {
    record: {
      ...completeCore,
      SMTP_HOST: "smtp.parity.invalid",
      SMTP_USER: "orbit@parity.invalid",
      SMTP_PASSWORD_FILE: "/run/orbit-secrets/orbit-smtp-password",
    },
  },
  "tika URL without the profile reports missing processing": {
    record: { ...completeCore, TIKA_URL: "http://orbit-tika:9998" },
  },
  "push subject alone reports missing push": {
    record: { ...completeCore, VAPID_SUBJECT: "mailto:admin@parity.invalid" },
  },
  "complete push group reports ready push": {
    record: {
      ...completeCore,
      VAPID_SUBJECT: "mailto:admin@parity.invalid",
      VAPID_PUBLIC_KEY: "parity-public-key",
      VAPID_PRIVATE_KEY_FILE: ".orbit-secrets/vapid-private-key",
    },
  },
};

function runCli(sandbox: string, extra: string[] = []): CheckResult & { stdout: string; stderr: string } {
  const cli = fileURLToPath(new URL("../cli/orbit.ts", import.meta.url));
  const tsx = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const result = failOnProcessDeadline(spawnSync("node", [tsx, cli, "check", ...extra, "--dir", sandbox], {
    encoding: "utf8",
    ...processGuard(),
  }), { label: "runCli" });
  return {
    lines: result.stdout.split("\n").filter(Boolean),
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function bashCheck(name: string): CheckResult {
  return readGolden<{ bash: CheckResult }>("configure-check", name).bash;
}

describe("config contract parity with configure.sh --check (golden)", () => {
  for (const [name, fixture] of Object.entries(fixtures)) {
    it(name, () => {
      const script = bashCheck(name);
      const sandbox = makeSandbox(fixture);
      const contract = evaluateReadiness(fixture.record, factsFor(sandbox));
      expect(contract.lines).toEqual(script.lines);
      expect(contract.ok).toBe(script.status === 0);
      // Three-way: the orbit CLI's check must match the script byte for byte.
      const cli = runCli(sandbox);
      expect(cli.lines).toEqual(script.lines);
      expect(cli.status).toBe(script.status);
    });
  }
});

interface EdgeGolden {
  bash: { status: number; stdout: string; stderr: string };
  rollback?: string;
}

describe("orbit check edge cases against configure.sh --check / --check-rollback (golden)", () => {
  function bareSandbox(): string {
    const sandbox = mkdtempSync(join(tmpdir(), "orbit-contract-parity-edge."));
    sandboxes.push(sandbox);
    return sandbox;
  }

  it("no .env-orbit reports every field missing, as bash did", () => {
    const bash = readGolden<EdgeGolden>("configure-check-edge", "no env file").bash;
    const cli = runCli(bareSandbox());
    expect({ status: cli.status, stdout: cli.stdout }).toEqual({ status: bash.status, stdout: bash.stdout });
  });

  it("--rollback with no rollback copy reports every field missing, as --check-rollback did", () => {
    const bash = readGolden<EdgeGolden>("configure-check-edge", "rollback absent").bash;
    const cli = runCli(bareSandbox(), ["--rollback"]);
    expect({ status: cli.status, stdout: cli.stdout }).toEqual({ status: bash.status, stdout: bash.stdout });
  });

  it("--rollback reads the rollback copy, not the live file", () => {
    const golden = readGolden<EdgeGolden>("configure-check-edge", "rollback present");
    const sandbox = bareSandbox();
    writeFileSync(join(sandbox, ".env-orbit"), "APP_URL=\n", { mode: 0o600 });
    writeFileSync(join(sandbox, ".env-orbit.orbit-config.rollback"), golden.rollback ?? "", { mode: 0o600 });
    const cli = runCli(sandbox, ["--rollback"]);
    expect({ status: cli.status, stdout: cli.stdout }).toEqual({ status: golden.bash.status, stdout: golden.bash.stdout });
  });

  // Deliberate divergences, both fail-closed and both exit 1 as bash did:
  // bash read an unknown key or a loose file loosely; the engine names the
  // configuration_* code instead (the preflight refuses both files anyway).
  it("an unknown key fails with configuration_unknown_key (bash printed a report, also exit 1)", () => {
    const golden = readGolden<EdgeGolden & { env: string }>("configure-check-edge", "unknown key");
    const sandbox = bareSandbox();
    writeFileSync(join(sandbox, ".env-orbit"), golden.env, { mode: 0o600 });
    const cli = runCli(sandbox);
    expect(golden.bash.status).toBe(1);
    expect({ status: cli.status, stdout: cli.stdout, stderr: cli.stderr }).toEqual({ status: 1, stdout: "", stderr: "configuration_unknown_key\n" });
  });

  it("a loose-mode file fails with configuration_syntax (bash named the permissions, also exit 1)", () => {
    const golden = readGolden<EdgeGolden>("configure-check-edge", "loose mode");
    const sandbox = bareSandbox();
    writeFileSync(join(sandbox, ".env-orbit"), "APP_URL=https://orbit.parity.invalid\n");
    chmodSync(join(sandbox, ".env-orbit"), 0o644);
    const cli = runCli(sandbox);
    expect(golden.bash.status).toBe(1);
    expect({ status: cli.status, stderr: cli.stderr }).toEqual({ status: 1, stderr: "configuration_syntax\n" });
  });

  it("an unknown option is a usage error (exit 2), as bash's was", () => {
    const golden = readGolden<EdgeGolden>("configure-check-edge", "extra argument");
    const cli = runCli(bareSandbox(), ["--bogus"]);
    expect(cli.status).toBe(golden.bash.status);
  });
});
