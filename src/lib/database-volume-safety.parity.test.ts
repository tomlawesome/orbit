import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  DatabaseVolumeSafetyRefusal,
  type DatabaseVolumeSafetyAdapter,
  type DatabaseVolumeSafetyState,
  type PostgresPasswordFacts,
  evaluateVolumeOwnership,
  verifyDatabaseVolumeSafety,
} from "./database-volume-safety";

// Decision parity between scripts/install.sh's volume_belongs_to_deployment
// / verify_database_volume_safety and this module (issue #295 slice 2).
//
// Unlike install-transaction.parity.test.ts and target-identity.parity.
// test.ts (both pure filesystem logic, diffable directly), these two bash
// functions decide by parsing sequential `docker` command output. Rather
// than precomputing "facts" and asserting the *bash* side matches them (bash
// has no notion of an injected fact — it always shells out for real), this
// test puts a single stub `docker` executable (a tiny Node script reading a
// JSON scenario file, src/lib/database-volume-safety.parity.test.ts's own
// buildStubDocker()) first on PATH, and drives *both* implementations
// against it:
//   - the real function bodies, extracted (via awk, by function name, never
//     hand-copied) from the unmodified scripts/install.sh, run as bash and
//     shell out to the stub for real;
//   - this module's production decision logic runs against a reference
//     adapter (also in this file, not shipped — the plan defers a shipped
//     docker adapter to the slice-5 orchestration work) whose methods issue
//     the exact same docker argv install.sh uses, captured via
//     child_process against the identical stub.
// Both implementations therefore observe the identical "docker world" and
// must reach the identical decision. If a cited function is ever renamed in
// install.sh, extraction returns empty and this test fails loudly rather
// than silently comparing against stale text — see
// docs/adr-notes/295-install-port-plan.md's Flags section.

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

const harnessDir = mkdtempSync(join(tmpdir(), "orbit-database-volume-safety-parity-"));
const stubBinDir = join(harnessDir, "bin");
mkdirSync(stubBinDir);
const stubDockerPath = join(stubBinDir, "docker");
const scenarioPath = join(harnessDir, "scenario.json");

// A minimal stub `docker`: reads the scenario JSON pointed to by
// STUB_DOCKER_SCENARIO and answers exactly the handful of invocation shapes
// volume_belongs_to_deployment / verify_database_volume_safety make,
// discriminated the same way a real operator reading install.sh's source
// would — by subcommand and --format/--filter shape, not by a fixed call
// order the stub would otherwise have to guess. A key absent from the
// scenario, or explicitly null, means "this docker call fails" (matching
// bash's `2>/dev/null || return N`); "" is a distinct, valid "succeeded
// with empty output" case.
const stubDockerSource = `#!/usr/bin/env node
const fs = require("node:fs");
const scenario = JSON.parse(fs.readFileSync(process.env.STUB_DOCKER_SCENARIO, "utf8"));
const args = process.argv.slice(2);

function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function emit(value) {
  if (value === null || value === undefined) process.exit(1);
  if (value !== "") process.stdout.write(value + "\\n");
  process.exit(0);
}

if (args[0] === "volume" && args[1] === "inspect") {
  const format = flag("--format") || "";
  const volumeName = args[args.length - 1];
  if (format.includes('compose.volume')) {
    emit((scenario.volumeLabels || {})[volumeName] ?? null);
  } else {
    emit((scenario.volumeProjectLabel || {})[volumeName] ?? null);
  }
} else if (args[0] === "volume" && args[1] === "ls") {
  const filterValue = (flag("--filter") || "").replace(/^name=/, "");
  if (filterValue.startsWith("^") && filterValue.endsWith("$")) {
    const name = filterValue.slice(1, -1);
    emit((scenario.volumeLsExact || {})[name] ?? null);
  } else {
    emit((scenario.volumeLsSubstring || {})[filterValue] ?? null);
  }
} else if (args[0] === "ps") {
  const filterValue = flag("--filter") || "";
  if (filterValue.startsWith("volume=")) {
    const volumeName = filterValue.slice("volume=".length);
    emit((scenario.containersByVolume || {})[volumeName] ?? null);
  } else if (filterValue.startsWith("label=com.docker.compose.project=")) {
    const project = filterValue.slice("label=com.docker.compose.project=".length);
    emit((scenario.containersByProject || {})[project] ?? null);
  } else {
    process.exit(1);
  }
} else if (args[0] === "inspect") {
  const containerId = args[args.length - 1];
  emit((scenario.containerImage || {})[containerId] ?? null);
} else {
  process.exit(1);
}
`;
writeFileSync(stubDockerPath, stubDockerSource, { mode: 0o755 });

interface DockerScenario {
  volumeLabels?: Record<string, string | null>;
  volumeProjectLabel?: Record<string, string | null>;
  containersByVolume?: Record<string, string | null>;
  containersByProject?: Record<string, string | null>;
  containerImage?: Record<string, string | null>;
  volumeLsExact?: Record<string, string | null>;
  volumeLsSubstring?: Record<string, string | null>;
}

function writeScenario(scenario: DockerScenario): void {
  writeFileSync(scenarioPath, JSON.stringify(scenario));
}

const stubEnv = { ...process.env, PATH: `${stubBinDir}:${process.env.PATH}`, STUB_DOCKER_SCENARIO: scenarioPath };

// Reference adapter: not part of the shipped module (the plan defers a real
// docker adapter to slice 5's orchestration work) — exists only so this
// parity test can drive database-volume-safety.ts's production decision
// logic against the exact same docker argv install.sh itself issues.
function execDocker(args: string[]): string | null {
  try {
    const result = execFileSync("docker", args, { encoding: "utf8", env: stubEnv });
    return result.replace(/\n$/, "");
  } catch {
    return null;
  }
}

const referenceAdapter: DatabaseVolumeSafetyAdapter = {
  inspectVolumeLabels: (candidateVolume) =>
    execDocker([
      "volume",
      "inspect",
      "--format",
      '{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.volume"}}',
      candidateVolume,
    ]),
  listContainersByVolume: (candidateVolume) =>
    execDocker([
      "ps",
      "-a",
      "--filter",
      `volume=${candidateVolume}`,
      "--format",
      '{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}',
    ]),
  listContainersByProject: (project) =>
    execDocker([
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--format",
      '{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}',
    ]),
  inspectContainerImage: (containerId) => execDocker(["inspect", "--format", "{{.Config.Image}}", containerId]),
  listVolumesExactName: (name) => execDocker(["volume", "ls", "--filter", `name=^${name}$`, "--format", "{{.Name}}"]),
  listVolumesByKeySubstring: (key) => execDocker(["volume", "ls", "--filter", `name=${key}`, "--format", "{{.Name}}"]),
  inspectVolumeProjectLabel: (name) =>
    execDocker(["volume", "inspect", "--format", '{{index .Labels "com.docker.compose.project"}}', name]),
};

const driverDir = mkdtempSync(join(tmpdir(), "orbit-database-volume-safety-parity-driver-"));
const driverPath = join(driverDir, "driver.sh");

function buildDriverScript(): string {
  const functions = [
    "is_regular_non_symlink_file",
    "has_mode",
    "read_environment_value",
    "derive_compose_project_name",
    "volume_belongs_to_deployment",
    "verify_database_volume_safety",
  ]
    .map(extractFunction)
    .join("\n");

  return [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    "fail() { printf '%s\\n' \"$1\" >&2; exit 1; }",
    "",
    'readonly environment_file=".env-orbit"',
    'readonly secrets_directory=".orbit-secrets"',
    'readonly database_volume_key="orbit-db-data"',
    "",
    functions,
    "",
    'mode="$1"; shift',
    "",
    'case "$mode" in',
    "  ownership)",
    '    candidate="$1"; expected_image="$2"',
    "    status=0",
    '    volume_belongs_to_deployment "$candidate" "$expected_image" || status=$?',
    "    printf 'status=%s\\n' \"$status\"",
    '    exit "$status"',
    "    ;;",
    "  verify)",
    '    target_dir="$1"; target_was_empty="$2"; requested="${3:-}"',
    '    cd -- "$target_dir"',
    "    database_volume_checked=0",
    "    database_volume_seen=0",
    '    database_volume_name=""',
    '    compose_project_name=""',
    "    compose_project_name_explicit=0",
    '    [[ -n "$requested" ]] && export COMPOSE_PROJECT_NAME="$requested"',
    "    verify_database_volume_safety",
    "    printf 'database_volume_checked=%s\\n' \"$database_volume_checked\"",
    "    printf 'database_volume_seen=%s\\n' \"$database_volume_seen\"",
    "    printf 'database_volume_name=%s\\n' \"$database_volume_name\"",
    "    printf 'compose_project_name=%s\\n' \"$compose_project_name\"",
    "    printf 'compose_project_name_explicit=%s\\n' \"$compose_project_name_explicit\"",
    "    ;;",
    "  verify-recheck)",
    '    target_dir="$1"; database_volume_name="$2"; database_volume_seen="$3"',
    '    cd -- "$target_dir"',
    "    database_volume_checked=1",
    '    compose_project_name=""',
    "    compose_project_name_explicit=0",
    "    verify_database_volume_safety",
    "    printf 'database_volume_checked=%s\\n' \"$database_volume_checked\"",
    "    printf 'database_volume_seen=%s\\n' \"$database_volume_seen\"",
    "    printf 'database_volume_name=%s\\n' \"$database_volume_name\"",
    "    ;;",
    "esac",
    "",
  ].join("\n");
}

writeFileSync(driverPath, buildDriverScript(), { mode: 0o755 });

function runDriver(...args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("bash", [driverPath, ...args], { encoding: "utf8", env: stubEnv });
  return { status: result.status ?? -1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

const sandboxes: string[] = [];
function makeSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "orbit-database-volume-safety-parity-sandbox-"));
  sandboxes.push(dir);
  return dir;
}

afterAll(() => {
  for (const sandbox of sandboxes) rmSync(sandbox, { recursive: true, force: true });
  rmSync(driverDir, { recursive: true, force: true });
  rmSync(harnessDir, { recursive: true, force: true });
});

const EXPECTED_IMAGE = "ghcr.io/tomlawesome/orbit@sha256:" + "a".repeat(64);
const CANDIDATE_VOLUME = "orbit_orbit-db-data";
const PROJECT = "orbit";
const DB_ID = "a".repeat(12);
const APP_ID = "b".repeat(12);

function provenScenario(): DockerScenario {
  return {
    volumeLabels: { [CANDIDATE_VOLUME]: `${PROJECT}|orbit-db-data` },
    volumeProjectLabel: { [CANDIDATE_VOLUME]: PROJECT },
    containersByVolume: { [CANDIDATE_VOLUME]: `${DB_ID}|${PROJECT}|orbit-db` },
    containersByProject: { [PROJECT]: `${APP_ID}|${PROJECT}|orbit-app` },
    containerImage: { [APP_ID]: EXPECTED_IMAGE },
  };
}

describe("volume_belongs_to_deployment parity", () => {
  it("agrees: proven ownership returns status 0", () => {
    writeScenario(provenScenario());
    const bash = runDriver("ownership", CANDIDATE_VOLUME, EXPECTED_IMAGE);
    expect(bash.status).toBe(0);
    expect(bash.stdout).toBe("status=0");
    expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, referenceAdapter)).toEqual({
      status: "proven",
      project: PROJECT,
    });
  });

  it("agrees: a non-orbit-db container attached to the volume is not proven (status 1)", () => {
    const scenario = provenScenario();
    scenario.containersByVolume = { [CANDIDATE_VOLUME]: `${DB_ID}|${PROJECT}|some-other-service` };
    writeScenario(scenario);
    const bash = runDriver("ownership", CANDIDATE_VOLUME, EXPECTED_IMAGE);
    expect(bash.status).toBe(1);
    expect(bash.stdout).toBe("status=1");
    expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, referenceAdapter)).toEqual({
      status: "not-proven",
    });
  });

  it("agrees: malformed volume labels (docker output failing bounds checks) is a verify-error (status 2)", () => {
    const scenario = provenScenario();
    scenario.volumeLabels = { [CANDIDATE_VOLUME]: `${PROJECT}|some-other-key` };
    writeScenario(scenario);
    const bash = runDriver("ownership", CANDIDATE_VOLUME, EXPECTED_IMAGE);
    expect(bash.status).toBe(2);
    expect(bash.stdout).toBe("status=2");
    expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, referenceAdapter)).toEqual({
      status: "verify-error",
    });
  });

  it("agrees: a failed docker volume inspect call is a verify-error (status 2)", () => {
    writeScenario({});
    const bash = runDriver("ownership", CANDIDATE_VOLUME, EXPECTED_IMAGE);
    expect(bash.status).toBe(2);
    expect(evaluateVolumeOwnership(CANDIDATE_VOLUME, EXPECTED_IMAGE, referenceAdapter)).toEqual({
      status: "verify-error",
    });
  });
});

function seedTargetWithImage(dir: string): void {
  writeFileSync(join(dir, ".env-orbit"), `ORBIT_IMAGE=${EXPECTED_IMAGE}\n`, { mode: 0o600 });
}

function seedReadyPassword(dir: string): PostgresPasswordFacts {
  mkdirSync(join(dir, ".orbit-secrets"), { mode: 0o700 });
  const passwordPath = join(dir, ".orbit-secrets", "postgres-password");
  writeFileSync(passwordPath, "hunter2", { mode: 0o600 });
  return { isRegularNonSymlinkFile: true, mode: lstatSync(passwordPath).mode & 0o777 };
}

function freshState(overrides: Partial<DatabaseVolumeSafetyState> = {}): DatabaseVolumeSafetyState {
  return {
    databaseVolumeChecked: false,
    databaseVolumeSeen: false,
    databaseVolumeName: "",
    targetWasEmpty: false,
    composeProjectNameExplicit: false,
    composeProjectName: "",
    ...overrides,
  };
}

describe("verify_database_volume_safety parity — fresh check", () => {
  it("agrees: no candidate volumes leaves database_volume_checked=1 and nothing attached", () => {
    const dir = makeSandbox();
    seedTargetWithImage(dir);
    const password = seedReadyPassword(dir);
    writeScenario({ volumeLsSubstring: { "orbit-db-data": "" } });

    const bash = runDriver("verify", dir, "0");
    expect(bash.status).toBe(0);
    expect(bash.stdout).toContain("database_volume_checked=1");
    expect(bash.stdout).toContain("database_volume_seen=0");

    const result = verifyDatabaseVolumeSafety(dir, undefined, "fallback", freshState(), password, referenceAdapter);
    expect(result.databaseVolumeChecked).toBe(true);
    expect(result.databaseVolumeSeen).toBe(false);
  });

  it("agrees: a fully proven volume attaches, recording the discovered project and volume name (#13, #18)", () => {
    const dir = makeSandbox();
    seedTargetWithImage(dir);
    const password = seedReadyPassword(dir);
    const scenario = provenScenario();
    scenario.volumeLsSubstring = { "orbit-db-data": CANDIDATE_VOLUME };
    writeScenario(scenario);

    const bash = runDriver("verify", dir, "0");
    expect(bash.status).toBe(0);
    expect(bash.stdout).toContain("database_volume_checked=1");
    expect(bash.stdout).toContain("database_volume_seen=1");
    expect(bash.stdout).toContain(`database_volume_name=${CANDIDATE_VOLUME}`);
    expect(bash.stdout).toContain(`compose_project_name=${PROJECT}`);
    // No configured .env-orbit project and no requested override means
    // derive_compose_project_name used the fallback-basename branch
    // (explicit=0), and install.sh:573 never flips it to 1 just because a
    // pre-existing volume's project label was discovered — this is the
    // exact discrepancy database-volume-safety.ts's first draft got wrong
    // and this parity test caught (see the comment at
    // database-volume-safety.ts's `nextState = { ...nextState,
    // composeProjectName: discoveredProject }` line).
    expect(bash.stdout).toContain("compose_project_name_explicit=0");

    const result = verifyDatabaseVolumeSafety(dir, undefined, "fallback", freshState(), password, referenceAdapter);
    expect(result).toEqual({
      databaseVolumeChecked: true,
      databaseVolumeSeen: true,
      databaseVolumeName: CANDIDATE_VOLUME,
      targetWasEmpty: false,
      composeProjectNameExplicit: false,
      composeProjectName: PROJECT,
    });
  });

  it("agrees: an existing volume against an otherwise-empty target refuses with install.sh's exact message (#15)", () => {
    const dir = makeSandbox();
    seedTargetWithImage(dir);
    const password = seedReadyPassword(dir);
    const scenario = provenScenario();
    scenario.volumeLsSubstring = { "orbit-db-data": CANDIDATE_VOLUME };
    writeScenario(scenario);

    const bash = runDriver("verify", dir, "1");
    expect(bash.status).toBe(1);

    let message = "";
    try {
      verifyDatabaseVolumeSafety(dir, undefined, "fallback", freshState({ targetWasEmpty: true }), password, referenceAdapter);
    } catch (error) {
      message = (error as DatabaseVolumeSafetyRefusal).message;
    }
    expect(bash.stderr).toBe(message);
  });

  it("agrees: a proven volume with no preserved postgres-password refuses with install.sh's exact message (#18)", () => {
    const dir = makeSandbox();
    seedTargetWithImage(dir);
    // No .orbit-secrets/postgres-password seeded at all.
    const scenario = provenScenario();
    scenario.volumeLsSubstring = { "orbit-db-data": CANDIDATE_VOLUME };
    writeScenario(scenario);

    const bash = runDriver("verify", dir, "0");
    expect(bash.status).toBe(1);

    let message = "";
    try {
      verifyDatabaseVolumeSafety(
        dir,
        undefined,
        "fallback",
        freshState(),
        { isRegularNonSymlinkFile: false, mode: null },
        referenceAdapter,
      );
    } catch (error) {
      message = (error as DatabaseVolumeSafetyRefusal).message;
    }
    expect(bash.stderr).toBe(message);
  });
});

describe("verify_database_volume_safety parity — re-check (guarantee #17, TOCTOU)", () => {
  it("agrees: the same single volume still existing is a silent no-op", () => {
    const dir = makeSandbox();
    writeScenario({ volumeLsExact: { [CANDIDATE_VOLUME]: CANDIDATE_VOLUME } });

    const bash = runDriver("verify-recheck", dir, CANDIDATE_VOLUME, "1");
    expect(bash.status).toBe(0);

    const state = freshState({ databaseVolumeChecked: true, databaseVolumeSeen: true, databaseVolumeName: CANDIDATE_VOLUME });
    const password: PostgresPasswordFacts = { isRegularNonSymlinkFile: true, mode: 0o600 };
    const result = verifyDatabaseVolumeSafety(dir, undefined, "fallback", state, password, referenceAdapter);
    expect(result).toEqual(state);
  });

  it("agrees: the recognized volume disappearing mid-run refuses with install.sh's exact message", () => {
    const dir = makeSandbox();
    writeScenario({ volumeLsExact: { [CANDIDATE_VOLUME]: "" } });

    const bash = runDriver("verify-recheck", dir, CANDIDATE_VOLUME, "1");
    expect(bash.status).toBe(1);

    const state = freshState({ databaseVolumeChecked: true, databaseVolumeSeen: true, databaseVolumeName: CANDIDATE_VOLUME });
    const password: PostgresPasswordFacts = { isRegularNonSymlinkFile: true, mode: 0o600 };
    let message = "";
    try {
      verifyDatabaseVolumeSafety(dir, undefined, "fallback", state, password, referenceAdapter);
    } catch (error) {
      message = (error as DatabaseVolumeSafetyRefusal).message;
    }
    expect(bash.stderr).toBe(message);
  });
});
