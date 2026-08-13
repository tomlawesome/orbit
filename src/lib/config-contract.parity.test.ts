import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
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
import { afterAll, describe, expect, it } from "vitest";

import {
  CANONICAL_OIDC_SECRET_FILE_PATH,
  evaluateReadiness,
  type EnvOrbitRecord,
  type OidcSecretFileFacts,
} from "./config-contract";

// Cross-implementation parity: for identical fixtures, the TypeScript
// contract's readiness report must equal the real `configure.sh --check`
// output line for line. This is the drift alarm for the Phase 2 engine port
// (ADR-0011): a semantic change on either side fails here first.

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

function runCheck(fixture: Fixture): { lines: string[]; status: number } {
  const sandbox = mkdtempSync(join(tmpdir(), "orbit-contract-parity."));
  sandboxes.push(sandbox);
  mkdirSync(join(sandbox, "scripts"));
  for (const script of ["configure.sh", "configuration.sh", "installer-ui.sh"]) {
    cpSync(join(repoRoot, "scripts", script), join(sandbox, "scripts", script));
  }
  cpSync(join(repoRoot, ".env-orbit.example"), join(sandbox, ".env-orbit.example"));
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

  const result = spawnSync("bash", ["scripts/configure.sh", "--check"], {
    cwd: sandbox,
    encoding: "utf8",
  });
  return {
    lines: result.stdout.split("\n").filter(Boolean),
    status: result.status ?? -1,
  };
}

function factsFor(_fixture: Fixture): OidcSecretFileFacts {
  const sandbox = sandboxes[sandboxes.length - 1];
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
  OIDC_ISSUER: "https://oidc.parity.invalid/application/o/orbit/",
  OIDC_CLIENT_ID: "orbit-parity",
  OIDC_CLIENT_SECRET_FILE: CANONICAL_OIDC_SECRET_FILE_PATH,
  OIDC_CALLBACK_URL: "https://orbit.parity.invalid/api/auth/callback",
  ORBIT_IMAGE:
    "registry.parity.invalid/acceptance/orbit@sha256:" + "a".repeat(64),
};

const fixtures: Record<string, Fixture> = {
  "complete core, no optional groups": { record: completeCore },
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
  "IMAP enabled without the boundary reports missing imap": {
    record: { ...completeCore, IMAP_ENABLED: "true" },
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

function runCli(): { lines: string[]; status: number } {
  const sandbox = sandboxes[sandboxes.length - 1];
  const cli = fileURLToPath(new URL("../cli/orbit.ts", import.meta.url));
  const tsx = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const result = spawnSync("node", [tsx, cli, "check", "--dir", sandbox], {
    encoding: "utf8",
  });
  return {
    lines: result.stdout.split("\n").filter(Boolean),
    status: result.status ?? -1,
  };
}

describe("config contract parity with configure.sh --check", () => {
  for (const [name, fixture] of Object.entries(fixtures)) {
    it(name, () => {
      const script = runCheck(fixture);
      const contract = evaluateReadiness(fixture.record, factsFor(fixture));
      expect(contract.lines).toEqual(script.lines);
      expect(contract.ok).toBe(script.status === 0);
      // Three-way: the orbit CLI's check must match the script byte for byte.
      const cli = runCli();
      expect(cli.lines).toEqual(script.lines);
      expect(cli.status).toBe(script.status);
    });
  }
});
