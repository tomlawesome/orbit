import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// This suite runs repair.sh from copied fixtures in temporary directories:
// like configure.sh, repair.sh forces its own cwd to its containing
// checkout (`dirname "$0"/..`), so it must never be pointed at the real
// repository. A fake `docker` executable is placed ahead of the real one on
// PATH (this sandbox has a real Docker CLI installed) for every invocation,
// so no test ever reaches a real daemon, container, volume, or image.

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoDir = join(scriptsDir, "..");
const repairScriptSource = readFileSync(join(scriptsDir, "repair.sh"), "utf8");
const configureScriptSource = readFileSync(join(scriptsDir, "configure.sh"), "utf8");
const installerUiSource = readFileSync(join(scriptsDir, "installer-ui.sh"), "utf8");
const environmentExampleSource = readFileSync(join(repoDir, ".env-orbit.example"), "utf8");

const scratchDirs = [];

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop(), { recursive: true, force: true });
  }
});

function scratchDir() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-repair-"));
  scratchDirs.push(dir);
  return dir;
}

// A `docker` shim covering every read-only subcommand repair.sh issues:
//   - `docker ps -a` (bare)                          -> connectivity probe
//   - `docker ps -a --filter ... --format ...`        -> container ownership
//   - `docker compose --project-name X ... config --quiet` -> interpolation
//   - `docker volume ls --filter ... --format ...`     -> volume retention
// `unavailable: true` makes every subcommand fail, simulating a missing or
// unreachable Docker without needing to hide the real `docker` binary from
// PATH (which shares a directory with bash/coreutils in this sandbox).
function dockerShimScript({
  unavailable = false,
  volumes = [],
  containers = [],
  composeFails = false,
} = {}) {
  if (unavailable) {
    return "#!/usr/bin/env bash\nexit 1\n";
  }
  const volumeLines = volumes.map((name) => `    printf '%s\\n' '${name}'`).join("\n");
  const containerLines = containers
    .map(({ id, service }) => `      printf '%s\\n' '${id}|${service}'`)
    .join("\n");
  return [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    'case "${1:-}" in',
    "  ps)",
    "    has_filter=0",
    '    for a in "$@"; do [[ "$a" == "--filter" ]] && has_filter=1; done',
    "    if [[ \"$has_filter\" == 1 ]]; then",
    containerLines || "      true",
    "    fi",
    "    exit 0",
    "    ;;",
    "  compose)",
    composeFails ? "    exit 1" : "    exit 0",
    "    ;;",
    "  volume)",
    '    if [[ "${2:-}" == "ls" ]]; then',
    volumeLines || "      true",
    "      exit 0",
    "    fi",
    "    exit 1",
    "    ;;",
    "esac",
    "exit 1",
    "",
  ].join("\n");
}

function makeFakeBin(dockerOptions) {
  const binDir = mkdtempSync(join(tmpdir(), "orbit-repair-fakebin-"));
  scratchDirs.push(binDir);
  writeFileSync(join(binDir, "docker"), dockerShimScript(dockerOptions));
  chmodSync(join(binDir, "docker"), 0o755);
  return binDir;
}

// Builds a target directory that repair.sh --check reports as fully
// healthy: recognized managed files, a valid .orbit-secrets with all four
// managed secrets, and (when `withConfigure` is true) a configure.sh that
// reports the deployment as ready.
function makeFixture({ withConfigure = true, withComposeAndEnv = true, withSecrets = true } = {}) {
  const targetDir = scratchDir();
  mkdirSync(join(targetDir, "scripts"));
  writeFileSync(join(targetDir, "scripts", "repair.sh"), repairScriptSource);
  chmodSync(join(targetDir, "scripts", "repair.sh"), 0o755);
  if (withConfigure) {
    writeFileSync(join(targetDir, "scripts", "configure.sh"), configureScriptSource);
    chmodSync(join(targetDir, "scripts", "configure.sh"), 0o755);
    writeFileSync(join(targetDir, "scripts", "installer-ui.sh"), installerUiSource);
    chmodSync(join(targetDir, "scripts", "installer-ui.sh"), 0o755);
    writeFileSync(join(targetDir, ".env-orbit.example"), environmentExampleSource);
  }
  if (withComposeAndEnv) {
    writeFileSync(join(targetDir, "docker-compose.yml"), "services:\n  orbit-app:\n    image: busybox\n");
    const envLines = [
      "APP_URL=https://orbit.repair-test.internal",
      "ORBIT_IMAGE=orbit-local:abcdef123456",
      "OIDC_ISSUER=https://auth.repair-test.internal/application/o/orbit/",
      "OIDC_CLIENT_ID=repair-test-client",
      "OIDC_CLIENT_SECRET=repair-test-secret",
      "OIDC_CALLBACK_URL=https://orbit.repair-test.internal/api/auth/callback",
      "COMPOSE_PROJECT_NAME=repairtest",
      "",
    ].join("\n");
    writeFileSync(join(targetDir, ".env-orbit"), envLines);
    chmodSync(join(targetDir, ".env-orbit"), 0o600);
  }
  if (withSecrets) {
    mkdirSync(join(targetDir, ".orbit-secrets"), { mode: 0o700 });
    for (const name of ["session-secret", "postgres-password", "document-kek", "oidc-client-secret"]) {
      writeFileSync(join(targetDir, ".orbit-secrets", name), "a".repeat(64) + "\n");
      chmodSync(join(targetDir, ".orbit-secrets", name), 0o600);
    }
  }
  return targetDir;
}

function runRepair(targetDir, args, dockerOptions = {}) {
  const binDir = makeFakeBin(dockerOptions);
  return spawnSync("bash", [join(targetDir, "scripts", "repair.sh"), ...args], {
    cwd: targetDir,
    encoding: "utf8",
    env: { PATH: `${binDir}:${process.env.PATH}`, HOME: process.env.HOME ?? tmpdir() },
  });
}

function lines(stdout) {
  return stdout.split("\n").filter(Boolean);
}

describe("scripts/repair.sh --check", () => {
  it("rejects an invocation without --check", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, []);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
    expect(result.stdout).toBe("");
  });

  it("rejects an unrecognised argument", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--bogus"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });

  it("tolerates --plain in either order around --check", () => {
    const targetDir = makeFixture();
    const first = runRepair(targetDir, ["--check", "--plain"]);
    const second = runRepair(targetDir, ["--plain", "--check"]);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(first.stdout).toBe(second.stdout);
  });

  it("reports a fully healthy sandbox with exit 0 and no findings", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(0);
    expect(lines(result.stdout)).toEqual(["diagnosis result=healthy checked=13 skipped=0"]);
  });

  it("never emits ANSI or cursor-control bytes", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--check"]);
    expect(result.stdout).not.toMatch(/\x1b/u);
    expect(result.stderr).not.toMatch(/\x1b/u);
  });

  it("produces byte-identical output across repeated runs", () => {
    const targetDir = makeFixture();
    const first = runRepair(targetDir, ["--check"]);
    const second = runRepair(targetDir, ["--check"]);
    expect(first.stdout).toBe(second.stdout);
    expect(first.status).toBe(second.status);
  });

  it("never mutates the sandbox tree (identical path/mode/mtime snapshot before and after)", () => {
    const targetDir = makeFixture();
    const before = spawnSync("find", [targetDir, "-printf", "%p %m %T@\n"], { encoding: "utf8" });
    const result = runRepair(targetDir, ["--check"]);
    const after = spawnSync("find", [targetDir, "-printf", "%p %m %T@\n"], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(after.stdout).toBe(before.stdout);
  });

  it("reports not-orbit-directory and exits 5 for a directory with no Orbit fingerprint", () => {
    const targetDir = scratchDir();
    mkdirSync(join(targetDir, "scripts"));
    writeFileSync(join(targetDir, "scripts", "repair.sh"), repairScriptSource);
    chmodSync(join(targetDir, "scripts", "repair.sh"), 0o755);

    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(5);
    expect(lines(result.stdout)).toEqual([
      "finding class=not-orbit-directory target=directory severity=fail",
      "diagnosis result=failed checked=1 skipped=12",
    ]);
  });

  it("reports managed-file-missing for an absent .env-orbit", () => {
    const targetDir = makeFixture({ withConfigure: false });
    rmSync(join(targetDir, ".env-orbit"));

    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=managed-file-missing target=environment-file severity=fail");
    expect(result.stdout).toContain("diagnosis result=failed");
  });

  it("reports managed-file-symlink for a symlinked .env-orbit", () => {
    const targetDir = makeFixture({ withConfigure: false });
    const realFile = join(targetDir, "real-env-orbit");
    writeFileSync(realFile, "APP_URL=https://orbit.repair-test.internal\n");
    chmodSync(realFile, 0o600);
    rmSync(join(targetDir, ".env-orbit"));
    symlinkSync(realFile, join(targetDir, ".env-orbit"));

    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=managed-file-symlink target=environment-file severity=fail");
  });

  it("reports managed-file-permissions for a loosely-permissioned .env-orbit", () => {
    const targetDir = makeFixture({ withConfigure: false });
    chmodSync(join(targetDir, ".env-orbit"), 0o644);

    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=managed-file-permissions target=environment-file severity=fail");
  });

  it("reports secrets-directory-invalid for a wrong-permission .orbit-secrets", () => {
    const targetDir = makeFixture({ withConfigure: false });
    chmodSync(join(targetDir, ".orbit-secrets"), 0o755);

    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=secrets-directory-invalid target=secrets-directory severity=fail");
  });

  it("reports secrets-directory-invalid for a symlinked .orbit-secrets", () => {
    const targetDir = makeFixture({ withConfigure: false });
    const realDir = join(targetDir, "real-secrets");
    mkdirSync(realDir, { mode: 0o700 });
    rmSync(join(targetDir, ".orbit-secrets"), { recursive: true, force: true });
    symlinkSync(realDir, join(targetDir, ".orbit-secrets"));

    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=secrets-directory-invalid target=secrets-directory severity=fail");
  });

  it("reports secret-missing (warn) for an absent managed secret file", () => {
    const targetDir = makeFixture({ withConfigure: false });
    rmSync(join(targetDir, ".orbit-secrets", "document-kek"));

    const result = runRepair(targetDir, ["--check"]);

    expect(result.stdout).toContain("finding class=secret-missing target=document-kek severity=warn");
  });

  it("reports secret-missing (warn) for an empty managed secret file", () => {
    const targetDir = makeFixture({ withConfigure: false });
    writeFileSync(join(targetDir, ".orbit-secrets", "session-secret"), "");

    const result = runRepair(targetDir, ["--check"]);

    expect(result.stdout).toContain("finding class=secret-missing target=session-secret severity=warn");
  });

  it("reports secret-permissions (fail) for a loosely-permissioned secret file", () => {
    const targetDir = makeFixture({ withConfigure: false });
    chmodSync(join(targetDir, ".orbit-secrets", "postgres-password"), 0o644);

    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=secret-permissions target=postgres-password severity=fail");
  });

  it("reports secret-permissions (fail) for a symlinked secret file", () => {
    const targetDir = makeFixture({ withConfigure: false });
    const realFile = join(targetDir, "real-document-kek");
    writeFileSync(realFile, "b".repeat(64));
    chmodSync(realFile, 0o600);
    rmSync(join(targetDir, ".orbit-secrets", "document-kek"));
    symlinkSync(realFile, join(targetDir, ".orbit-secrets", "document-kek"));

    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=secret-permissions target=document-kek severity=fail");
  });

  it("reports staging-evidence-present (warn) for a leftover installer staging directory", () => {
    const targetDir = makeFixture();
    mkdirSync(join(targetDir, ".orbit-install-staging.abcdef"), { mode: 0o700 });

    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(3);
    expect(lines(result.stdout)).toEqual([
      "finding class=staging-evidence-present target=staging severity=warn",
      "diagnosis result=attention checked=13 skipped=0",
    ]);
  });

  it("reports configuration-incomplete when configure.sh --check fails without stderr output", () => {
    const targetDir = makeFixture();
    writeFileSync(
      join(targetDir, ".env-orbit"),
      "APP_URL=https://orbit.repair-test.internal\n",
    );
    chmodSync(join(targetDir, ".env-orbit"), 0o600);

    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=configuration-incomplete target=configuration severity=fail");
  });

  it("reports configuration-invalid when configure.sh --check fails with stderr output", () => {
    const targetDir = makeFixture();
    chmodSync(join(targetDir, ".env-orbit"), 0o644);

    const result = runRepair(targetDir, ["--check"]);

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=configuration-invalid target=configuration severity=fail");
  });

  it("reports compose-interpolation-failed when docker compose config fails", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--check"], { composeFails: true });

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=compose-interpolation-failed target=compose severity=fail");
  });

  it("reports volume-retained-without-credentials for the #261 fixed-project collision", () => {
    const targetDir = makeFixture();
    rmSync(join(targetDir, ".orbit-secrets", "postgres-password"));

    const result = runRepair(targetDir, ["--check"], { volumes: ["repairtest_orbit-db-data"] });

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=secret-missing target=postgres-password severity=warn");
    expect(result.stdout).toContain(
      "finding class=volume-retained-without-credentials target=database-volume severity=fail",
    );
  });

  it("does not report volume-retained-without-credentials when the credential is present", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], { volumes: ["repairtest_orbit-db-data"] });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("volume-retained-without-credentials");
  });

  it("reports unrelated-resource-present for a volume belonging to a different Compose project", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], { volumes: ["someother_orbit-db-data"] });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("finding class=unrelated-resource-present target=database-volume severity=info");
  });

  it("reports container-foreign-owner for a container in-project without a known Orbit service label", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], {
      containers: [{ id: "0123456789ab", service: "not-an-orbit-service" }],
    });

    expect(result.status).toBe(4);
    expect(result.stdout).toContain("finding class=container-foreign-owner target=container severity=fail");
  });

  it("does not report container-foreign-owner for a recognized Orbit service", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], {
      containers: [{ id: "0123456789ab", service: "orbit-db" }],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("container-foreign-owner");
  });

  it("reports docker-unavailable for every docker-backed check when docker cannot be used", () => {
    const targetDir = makeFixture();

    const result = runRepair(targetDir, ["--check"], { unavailable: true });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("finding class=docker-unavailable target=compose severity=info");
    expect(result.stdout).toContain("finding class=docker-unavailable target=database-volume severity=info");
    expect(result.stdout).toContain("finding class=docker-unavailable target=container severity=info");
    expect(lines(result.stdout).at(-1)).toBe("diagnosis result=healthy checked=10 skipped=3");
  });

  it("groups findings by the fixed class order regardless of discovery order", () => {
    const targetDir = makeFixture();
    // Triggers, in filesystem-discovery order: secret-missing (step 3) before
    // staging-evidence-present (step 4) before compose-interpolation-failed
    // (step 8) — but the fixed class order prints managed-file-* classes
    // ahead of secret-missing, and staging-evidence-present ahead of
    // compose-interpolation-failed, regardless of check execution order.
    rmSync(join(targetDir, ".orbit-secrets", "session-secret"));
    mkdirSync(join(targetDir, ".orbit-install-staging.xyz"), { mode: 0o700 });

    const result = runRepair(targetDir, ["--check"], { composeFails: true });
    const findingClasses = lines(result.stdout)
      .filter((line) => line.startsWith("finding "))
      .map((line) => line.match(/class=([a-z-]+)/u)[1]);

    expect(findingClasses).toEqual([
      "secret-missing",
      "staging-evidence-present",
      "compose-interpolation-failed",
    ]);
  });

  it("never discloses a path, configured value, or secret on stdout", () => {
    const targetDir = makeFixture();
    rmSync(join(targetDir, ".env-orbit"));

    const result = runRepair(targetDir, ["--check"]);

    expect(result.stdout).not.toContain(targetDir);
    expect(result.stdout).not.toContain("repair-test-secret");
    expect(result.stdout).not.toContain(".env-orbit");
  });
});
