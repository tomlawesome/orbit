import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { APP_READINESS_PROBE, OIDC_DISCOVERY_PARSER, createInstallDockerAdapter } from "./install-docker-adapter";

// PATH-shim coverage for issue #295 slice 5's shipped `docker`/
// `docker compose` adapter — mirroring recovery-bundle.docker-adapter.
// test.ts's/restore-engine.docker-adapter.test.ts's fakeDockerScript
// technique for issue #296: a fake `docker` bash script logs its exact argv
// to a file (via ORBIT_ARGV_LOG) and returns configurable exit codes/stdout
// via environment variables, so every method's argv shape can be asserted
// against install.sh's own cited call sites with no real Docker daemon.

const sandboxes: string[] = [];
afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

function newSandbox(prefix: string): string {
  const sandbox = mkdtempSync(join(tmpdir(), prefix));
  sandboxes.push(sandbox);
  return sandbox;
}

// Argv entries can themselves contain embedded newlines (the multi-line
// Node probe/parser sources), which rules out a naive newline-delimited log
// format. The fake `docker` is a *bash* script (not Node, unlike this port's
// slice 2/3 stub-docker precedents) specifically because install.sh's own
// `docker compose --env-file <path> ...` argv includes the literal token
// `--env-file` — and Node.js (20.6+) special-cases `--env-file` as its own
// CLI flag and intercepts it from anywhere in argv, even after a `#!/usr/bin/
// env node`-shebang script's own path, corrupting a Node-script stand-in for
// `docker`. Each invocation's argv is logged as NUL-separated fields
// terminated by an ASCII Record Separator (0x1e), robust against embedded
// newlines/NULs-in-practice without needing JSON-escaping in bash.
function readArgvLog(logPath: string): string[][] {
  if (!existsSync(logPath)) return [];
  const content = readFileSync(logPath, "utf8");
  return content
    .split("\x1e")
    .filter((record) => record.length > 0)
    .map((record) => record.split("\0").filter((_, index, all) => index < all.length - 1));
}

// Real Docker's refusals, so this fake cannot be more permissive than the tool
// the adapter really drives. Verified against docker 29.7.2 on 2026-09-08 and
// re-asserted against the real binary by scripts/tool-parity.test.mjs:
// an unknown flag on a `docker` subcommand exits 125 ("unknown flag: --x", or
// "unknown shorthand flag: 'T' in -T"); a flag given no value exits 125; an
// unknown subcommand exits 1; and `docker compose`, being a plugin rather than
// the CLI, uses exit 1 for both, never 125. `-T` is a real `compose exec` flag
// and has never been a plain `docker exec` one — which is exactly how #607
// shipped `docker exec -T` past 66 green tests against the bash shim.
const fakeDockerScript = [
  "#!/usr/bin/env bash",
  'if [[ -n "${ORBIT_ARGV_LOG:-}" ]]; then',
  "  {",
  '    for arg in "$@"; do printf \'%s\\0\' "$arg"; done',
  "    printf '\\x1e'",
  '  } >> "$ORBIT_ARGV_LOG"',
  "fi",
  "refuse_flag() {",
  '  printf "unknown flag: %s\\n" "$1" >&2',
  '  exit "${2:-125}"',
  "}",
  "refuse_shorthand() {",
  "  printf \"unknown shorthand flag: '%s' in -%s\\n\" \"$1\" \"$1\" >&2",
  '  exit "${2:-125}"',
  "}",
  "# parse_flags VALUE_FLAGS BOOL_FLAGS STOP_AT_POSITIONAL STATUS -- \"$@\"",
  "# STOP_AT_POSITIONAL=1 mirrors run/create/exec, which stop parsing at the",
  "# image or container name and pass the rest to the container untouched.",
  "parse_flags() {",
  '  local value_flags=" $1 " bool_flags=" $2 " stop_early="$3" status="$4" flag',
  "  shift 4",
  "  positionals=()",
  "  while (( $# > 0 )); do",
  '    case "$1" in',
  '      --) shift; positionals+=("$@"); return 0 ;;',
  "      -*)",
  '        flag="${1%%=*}"',
  '        if [[ "$value_flags" == *" $flag "* ]]; then',
  '          if [[ "$1" == *=* ]]; then',
  "            shift",
  "          elif (( $# >= 2 )); then",
  "            shift 2",
  "          else",
  '            printf "flag needs an argument: %s\\n" "$flag" >&2',
  '            exit "$status"',
  "          fi",
  '        elif [[ "$bool_flags" == *" $flag "* ]]; then',
  "          shift",
  '        elif [[ "$flag" == --* ]]; then',
  '          refuse_flag "$flag" "$status"',
  "        else",
  '          refuse_shorthand "${flag:1:1}" "$status"',
  "        fi",
  "        ;;",
  "      *)",
  '        positionals+=("$1")',
  "        shift",
  '        if [[ "$stop_early" == "1" ]]; then positionals+=("$@"); return 0; fi',
  "        ;;",
  "    esac",
  "  done",
  "}",
  'case "${1:-}" in',
  '  pull) parse_flags "--platform" "-a --all-tags --disable-content-trust -q --quiet" 1 125 "${@:2}" ;;',
  '  ps) parse_flags "-f --filter --format -n --last" "-a --all -l --latest --no-trunc -q --quiet -s --size" 0 125 "${@:2}" ;;',
  '  inspect) parse_flags "-f --format --type" "-s --size" 0 125 "${@:2}" ;;',
  '  cp) parse_flags "" "-a --archive -L --follow-link -q --quiet" 0 125 "${@:2}" ;;',
  '  rm) parse_flags "" "-f --force -l --link -v --volumes" 0 125 "${@:2}" ;;',
  '  create) parse_flags "--entrypoint --network --name -e --env --env-file -v --volume -w --workdir -u --user --platform -l --label --pull" "--rm -i --interactive -t --tty --read-only --init --privileged" 1 125 "${@:2}" ;;',
  '  run) parse_flags "--entrypoint --network --cap-drop --security-opt -u --user --pids-limit -m --memory --cpus --name -e --env --env-file -v --volume -w --workdir --platform -l --label --pull" "--rm -i --interactive -t --tty --read-only --init --privileged --no-healthcheck" 1 125 "${@:2}" ;;',
  "  volume)",
  '    case "${2:-}" in',
  '      ls) parse_flags "-f --filter --format" "-q --quiet" 0 125 "${@:3}" ;;',
  '      inspect) parse_flags "-f --format" "" 0 125 "${@:3}" ;;',
  '      *) printf \'docker: unknown command: docker volume %s\\n\' "${2:-}" >&2; exit 1 ;;',
  "    esac",
  "    ;;",
  "  image)",
  '    case "${2:-}" in',
  '      inspect) parse_flags "-f --format" "" 0 125 "${@:3}" ;;',
  '      *) printf \'docker: unknown command: docker image %s\\n\' "${2:-}" >&2; exit 1 ;;',
  "    esac",
  "    ;;",
  "  compose)",
  '    parse_flags "-p --project-name --env-file -f --file --project-directory --profile --progress --ansi --parallel" "--dry-run --compatibility --all-resources" 1 1 "${@:2}"',
  '    compose_subcommand="${positionals[0]:-}"',
  '    compose_rest=("${positionals[@]:1}")',
  '    case "$compose_subcommand" in',
  '      version) parse_flags "-f --format" "--short" 0 1 "${compose_rest[@]}" ;;',
  '      config) parse_flags "--hash -o --output --format" "-q --quiet --no-interpolate --resolve-image-digests --services --volumes --images --profiles --no-normalize --no-path-resolution --variables --environment --no-consistency" 0 1 "${compose_rest[@]}" ;;',
  '      up) parse_flags "-t --timeout --scale --pull --exit-code-from --attach --no-attach --wait-timeout" "-d --detach --no-build --build --remove-orphans --force-recreate --no-recreate --no-deps --no-start --wait --abort-on-container-exit --quiet-pull -y --yes --menu" 0 1 "${compose_rest[@]}" ;;',
  '      down) parse_flags "-t --timeout --rmi" "--remove-orphans -v --volumes" 0 1 "${compose_rest[@]}" ;;',
  '      pull) parse_flags "--policy" "--ignore-pull-failures --include-deps --ignore-buildable -q --quiet" 1 1 "${compose_rest[@]}" ;;',
  '      ps) parse_flags "--filter --format --status" "-a --all -q --quiet --services --no-trunc --orphans" 0 1 "${compose_rest[@]}" ;;',
  '      logs) parse_flags "--tail --since --until --index" "-f --follow --no-color --no-log-prefix -t --timestamps" 1 1 "${compose_rest[@]}" ;;',
  '      exec) parse_flags "-e --env -u --user -w --workdir --index" "-d --detach --privileged -T --no-TTY -i --interactive -t --tty" 1 1 "${compose_rest[@]}" ;;',
  '      run) parse_flags "-e --env -l --label -u --user -w --workdir -v --volume -p --publish --name --entrypoint --scale" "--rm --no-deps -T --no-TTY -d --detach -i --interactive -t --tty --build --quiet-pull --use-aliases --remove-orphans --service-ports" 1 1 "${compose_rest[@]}" ;;',
  '      *) printf \'unknown docker command: "compose %s"\\n\' "$compose_subcommand" >&2; exit 1 ;;',
  "    esac",
  "    ;;",
  "  *)",
  '    printf \'docker: unknown command: docker %s\\n\' "${1:-}" >&2',
  "    exit 1",
  "    ;;",
  "esac",
  'if [[ -n "${ORBIT_STDOUT:-}" ]]; then printf \'%s\\n\' "$ORBIT_STDOUT"; fi',
  'exit "${ORBIT_EXIT:-0}"',
  "",
].join("\n");

function makeFakeDockerBin(): string {
  const binDir = mkdtempSync(join(tmpdir(), "orbit-install-docker-adapter-fakebin-"));
  writeFileSync(join(binDir, "docker"), fakeDockerScript);
  chmodSync(join(binDir, "docker"), 0o755);
  return binDir;
}

function shimEnv(binDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ...extra };
}

function adapterFor(binDir: string, extra: Record<string, string> = {}) {
  return createInstallDockerAdapter({
    envFile: ".env-orbit",
    composeProjectName: "orbit",
    env: shimEnv(binDir, extra),
  });
}

describe("createInstallDockerAdapter — image identity (install.sh:1264-1310)", () => {
  it("pull spawns docker pull --quiet <repo>:<channel>", () => {
    const sandbox = newSandbox("orbit-docker-adapter-pull-");
    const logPath = join(sandbox, "argv.log");
    const binDir = makeFakeDockerBin();
    const adapter = adapterFor(binDir, { ORBIT_ARGV_LOG: logPath });

    expect(adapter.pull("ghcr.io/tomlawesome/orbit", "latest")).toBe(true);
    expect(readArgvLog(logPath)).toEqual([["pull", "--quiet", "ghcr.io/tomlawesome/orbit:latest"]]);
  });

  it("inspectRepoDigests uses the exact RepoDigests format string", () => {
    const sandbox = newSandbox("orbit-docker-adapter-repodigests-");
    const logPath = join(sandbox, "argv.log");
    const binDir = makeFakeDockerBin();
    const adapter = adapterFor(binDir, { ORBIT_ARGV_LOG: logPath, ORBIT_STDOUT: "sha256digestline" });

    expect(adapter.inspectRepoDigests("ghcr.io/tomlawesome/orbit", "latest")).toBe("sha256digestline");
    expect(readArgvLog(logPath)).toEqual([
      ["image", "inspect", "--format", "{{range .RepoDigests}}{{println .}}{{end}}", "ghcr.io/tomlawesome/orbit:latest"],
    ]);
  });

  it("inspectRevisionLabel / inspectVersionLabel use the exact OCI label format strings", () => {
    const sandbox = newSandbox("orbit-docker-adapter-labels-");
    const logPath = join(sandbox, "argv.log");
    const binDir = makeFakeDockerBin();
    const ref = "ghcr.io/tomlawesome/orbit@sha256:" + "a".repeat(64);
    const adapter = adapterFor(binDir, { ORBIT_ARGV_LOG: logPath, ORBIT_STDOUT: "value" });

    adapter.inspectRevisionLabel(ref);
    adapter.inspectVersionLabel(ref);

    expect(readArgvLog(logPath)).toEqual([
      ["image", "inspect", "--format", '{{index .Config.Labels "org.opencontainers.image.revision"}}', ref],
      ["image", "inspect", "--format", '{{index .Config.Labels "org.opencontainers.image.version"}}', ref],
    ]);
  });

  it("runBanner spawns the exact banner-verification argv", () => {
    const sandbox = newSandbox("orbit-docker-adapter-banner-");
    const logPath = join(sandbox, "argv.log");
    const binDir = makeFakeDockerBin();
    const ref = "ghcr.io/tomlawesome/orbit@sha256:" + "a".repeat(64);
    const adapter = adapterFor(binDir, { ORBIT_ARGV_LOG: logPath });

    expect(adapter.runBanner(ref)).toBe(true);
    expect(readArgvLog(logPath)).toEqual([
      ["run", "--rm", "--entrypoint", "/opt/orbit/scripts/container-entrypoint.sh", ref, "--banner"],
    ]);
  });

  it("returns null (not empty string) on a failed inspect, matching bash's `2>/dev/null || return 2`", () => {
    const binDir = makeFakeDockerBin();
    const adapter = adapterFor(binDir, { ORBIT_EXIT: "1" });
    expect(adapter.inspectRepoDigests("ghcr.io/tomlawesome/orbit", "latest")).toBeNull();
  });
});

describe("createInstallDockerAdapter — deployment-asset extraction (ADR-0019, install.sh:1372,1480-1486)", () => {
  const ref = "ghcr.io/tomlawesome/orbit@sha256:" + "a".repeat(64);

  it("inspectDeploymentAssetsLabel reads the io.orbit.deployment-assets label off the resolved reference", () => {
    const sandbox = newSandbox("orbit-docker-adapter-assets-label-");
    const logPath = join(sandbox, "argv.log");
    const binDir = makeFakeDockerBin();
    const adapter = adapterFor(binDir, { ORBIT_ARGV_LOG: logPath, ORBIT_STDOUT: "/opt/orbit/deploy" });

    expect(adapter.inspectDeploymentAssetsLabel(ref)).toBe("/opt/orbit/deploy");
    expect(readArgvLog(logPath)).toEqual([
      ["image", "inspect", "--format", '{{index .Config.Labels "io.orbit.deployment-assets"}}', ref],
    ]);
  });

  it("inspectDeploymentAssetsLabel returns the empty string for an image built before ADR-0019, and null when the inspect itself fails", () => {
    const binDir = makeFakeDockerBin();
    // Docker prints an empty line for a label the image does not carry, and
    // still exits 0 — the caller, not this adapter, decides what that means.
    expect(adapterFor(binDir).inspectDeploymentAssetsLabel(ref)).toBe("");
    expect(adapterFor(binDir, { ORBIT_EXIT: "1" }).inspectDeploymentAssetsLabel(ref)).toBeNull();
  });

  it("createAssetContainer spawns docker create and returns the printed container id", () => {
    const sandbox = newSandbox("orbit-docker-adapter-create-");
    const logPath = join(sandbox, "argv.log");
    const binDir = makeFakeDockerBin();
    const containerId = "c".repeat(64);
    const adapter = adapterFor(binDir, { ORBIT_ARGV_LOG: logPath, ORBIT_STDOUT: containerId });

    expect(adapter.createAssetContainer(ref)).toBe(containerId);
    expect(readArgvLog(logPath)).toEqual([["create", ref]]);
  });

  it("createAssetContainer returns null when docker create fails", () => {
    const binDir = makeFakeDockerBin();
    expect(adapterFor(binDir, { ORBIT_EXIT: "1" }).createAssetContainer(ref)).toBeNull();
  });

  it("copyFromContainer spawns docker cp <container>:<source> <destination>", () => {
    const sandbox = newSandbox("orbit-docker-adapter-cp-");
    const logPath = join(sandbox, "argv.log");
    const binDir = makeFakeDockerBin();
    const containerId = "c".repeat(64);
    const adapter = adapterFor(binDir, { ORBIT_ARGV_LOG: logPath });

    expect(adapter.copyFromContainer(containerId, "/opt/orbit/deploy/.", `${sandbox}/`)).toBe(true);
    expect(readArgvLog(logPath)).toEqual([["cp", `${containerId}:/opt/orbit/deploy/.`, `${sandbox}/`]]);
  });

  it("copyFromContainer reports failure when docker cp fails", () => {
    const binDir = makeFakeDockerBin();
    expect(adapterFor(binDir, { ORBIT_EXIT: "1" }).copyFromContainer("c".repeat(64), "/opt/orbit/deploy/.", "/tmp")).toBe(false);
  });

  it("removeAssetContainer spawns docker rm -f and never reports failure (install.sh's own `|| true`)", () => {
    const sandbox = newSandbox("orbit-docker-adapter-rm-");
    const logPath = join(sandbox, "argv.log");
    const binDir = makeFakeDockerBin();
    const containerId = "c".repeat(64);
    const adapter = adapterFor(binDir, { ORBIT_ARGV_LOG: logPath, ORBIT_EXIT: "1" });

    expect(() => adapter.removeAssetContainer(containerId)).not.toThrow();
    expect(readArgvLog(logPath)).toEqual([["rm", "-f", containerId]]);
  });
});

describe("createInstallDockerAdapter — OIDC sandbox validate (install.sh:927-944, guarantee #27)", () => {
  it("spawns the exact sandboxed docker run argv and feeds issuer+document on stdin", () => {
    const sandbox = newSandbox("orbit-docker-adapter-oidc-sandbox-");
    const logPath = join(sandbox, "argv.log");
    const binDir = makeFakeDockerBin();
    const ref = "ghcr.io/tomlawesome/orbit@sha256:" + "a".repeat(64);
    const documentPath = join(sandbox, "discovery.json");
    writeFileSync(documentPath, '{"issuer":"https://idp.example"}');
    const adapter = adapterFor(binDir, { ORBIT_ARGV_LOG: logPath });

    expect(adapter.validateOidcDiscoverySandbox(ref, "https://idp.example", documentPath)).toBe(true);
    const [argv] = readArgvLog(logPath);
    expect(argv).toEqual([
      "run",
      "--rm",
      "--interactive",
      "--entrypoint",
      "node",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      "1001:1001",
      "--pids-limit",
      "64",
      "--memory",
      "64m",
      "--cpus",
      "0.5",
      ref,
      "--input-type=commonjs",
      "-e",
      OIDC_DISCOVERY_PARSER,
    ]);
  });

  it("reports false when the sandboxed process exits non-zero", () => {
    const binDir = makeFakeDockerBin();
    const ref = "ghcr.io/tomlawesome/orbit@sha256:" + "a".repeat(64);
    const sandbox = newSandbox("orbit-docker-adapter-oidc-sandbox-reject-");
    const documentPath = join(sandbox, "discovery.json");
    writeFileSync(documentPath, "not json");
    const adapter = adapterFor(binDir, { ORBIT_EXIT: "1" });
    expect(adapter.validateOidcDiscoverySandbox(ref, "https://idp.example", documentPath)).toBe(false);
  });
});

describe("createInstallDockerAdapter — compose lifecycle and health probes", () => {
  it("composePull/composeUp/composeDown/composeConfigValidate use --project-name and --env-file consistently", () => {
    const sandbox = newSandbox("orbit-docker-adapter-compose-");
    const logPath = join(sandbox, "argv.log");
    const binDir = makeFakeDockerBin();
    const adapter = adapterFor(binDir, { ORBIT_ARGV_LOG: logPath });

    adapter.composePull("orbit-db");
    adapter.composeUp();
    adapter.composeDown();
    adapter.composeConfigValidate();

    expect(readArgvLog(logPath)).toEqual([
      ["compose", "--project-name", "orbit", "--env-file", ".env-orbit", "pull", "orbit-db"],
      ["compose", "--project-name", "orbit", "--env-file", ".env-orbit", "up", "-d", "--no-build", "--remove-orphans"],
      ["compose", "--project-name", "orbit", "--env-file", ".env-orbit", "down", "--remove-orphans"],
      ["compose", "--project-name", "orbit", "--env-file", ".env-orbit", "config", "--quiet"],
    ]);
  });

  it("each health probe uses the exact bounded compose exec argv (install.sh:1084-1105)", () => {
    const sandbox = newSandbox("orbit-docker-adapter-probes-");
    const logPath = join(sandbox, "argv.log");
    const binDir = makeFakeDockerBin();
    const adapter = adapterFor(binDir, { ORBIT_ARGV_LOG: logPath });

    adapter.probeDatabaseHealth();
    adapter.probeApplicationHealth();
    adapter.probeClamavHealth();
    adapter.probeTikaHealth();
    adapter.probeOllamaHealth();
    adapter.probeApplicationLiveness();

    const calls = readArgvLog(logPath);
    expect(calls[0]).toEqual([
      "compose",
      "--project-name",
      "orbit",
      "--env-file",
      ".env-orbit",
      "exec",
      "-T",
      "orbit-db",
      "sh",
      "-ec",
      'exec pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
    ]);
    expect(calls[1]).toEqual([
      "compose",
      "--project-name",
      "orbit",
      "--env-file",
      ".env-orbit",
      "exec",
      "-T",
      "orbit-app",
      "node",
      "-e",
      APP_READINESS_PROBE,
    ]);
    expect(calls[2]).toEqual([
      "compose",
      "--project-name",
      "orbit",
      "--env-file",
      ".env-orbit",
      "exec",
      "-T",
      "orbit-clamav",
      "clamdscan",
      "--ping",
      "1",
    ]);
    expect(calls[4]).toEqual([
      "compose",
      "--project-name",
      "orbit",
      "--env-file",
      ".env-orbit",
      "exec",
      "-T",
      "orbit-ollama",
      "ollama",
      "list",
    ]);
    expect(calls[5]).toEqual(["compose", "--project-name", "orbit", "--env-file", ".env-orbit", "exec", "-T", "orbit-app", "true"]);
  });

  it("pullOllamaModel spawns the exact model-pull argv (install.sh:1213-1214)", () => {
    const sandbox = newSandbox("orbit-docker-adapter-ollama-pull-");
    const logPath = join(sandbox, "argv.log");
    const binDir = makeFakeDockerBin();
    const adapter = adapterFor(binDir, { ORBIT_ARGV_LOG: logPath });

    expect(adapter.pullOllamaModel("llama3")).toBe(true);
    expect(readArgvLog(logPath)).toEqual([
      ["compose", "--project-name", "orbit", "--env-file", ".env-orbit", "exec", "-T", "orbit-ollama", "ollama", "pull", "llama3"],
    ]);
  });

  it("setComposeProjectName changes the --project-name used by every subsequent compose call (install.sh's own live-read $compose_project_name global)", () => {
    const sandbox = newSandbox("orbit-docker-adapter-reproject-");
    const logPath = join(sandbox, "argv.log");
    const binDir = makeFakeDockerBin();
    const adapter = adapterFor(binDir, { ORBIT_ARGV_LOG: logPath });

    adapter.composePull("orbit-db");
    adapter.setComposeProjectName("discovered-project");
    adapter.composeUp();

    expect(readArgvLog(logPath)).toEqual([
      ["compose", "--project-name", "orbit", "--env-file", ".env-orbit", "pull", "orbit-db"],
      ["compose", "--project-name", "discovered-project", "--env-file", ".env-orbit", "up", "-d", "--no-build", "--remove-orphans"],
    ]);
  });

  it("checkDockerAvailable returns true only when `docker compose version` succeeds", () => {
    const binDirOk = makeFakeDockerBin();
    expect(adapterFor(binDirOk).checkDockerAvailable()).toBe(true);
    const binDirFail = makeFakeDockerBin();
    expect(adapterFor(binDirFail, { ORBIT_EXIT: "1" }).checkDockerAvailable()).toBe(false);
  });
});

describe("createInstallDockerAdapter — VolumeOwnershipAdapter/DatabaseVolumeSafetyAdapter argv (issue #295 slice 2 deferral)", () => {
  it("uses the exact argv slice 2's own parity test already proved database-volume-safety.ts expects", () => {
    const sandbox = newSandbox("orbit-docker-adapter-volume-");
    const logPath = join(sandbox, "argv.log");
    const binDir = makeFakeDockerBin();
    const adapter = adapterFor(binDir, { ORBIT_ARGV_LOG: logPath, ORBIT_STDOUT: "orbit|orbit-db-data" });

    adapter.inspectVolumeLabels("orbit_orbit-db-data");
    adapter.listContainersByVolume("orbit_orbit-db-data");
    adapter.listContainersByProject("orbit");
    adapter.inspectContainerImage("abc123");
    adapter.listVolumesExactName("orbit_orbit-db-data");
    adapter.listVolumesByKeySubstring("orbit-db-data");
    adapter.inspectVolumeProjectLabel("orbit_orbit-db-data");

    expect(readArgvLog(logPath)).toEqual([
      ["volume", "inspect", "--format", '{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.volume"}}', "orbit_orbit-db-data"],
      ["ps", "-a", "--filter", "volume=orbit_orbit-db-data", "--format", '{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}'],
      ["ps", "-a", "--filter", "label=com.docker.compose.project=orbit", "--format", '{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}'],
      ["inspect", "--format", "{{.Config.Image}}", "abc123"],
      ["volume", "ls", "--filter", "name=^orbit_orbit-db-data$", "--format", "{{.Name}}"],
      ["volume", "ls", "--filter", "name=orbit-db-data", "--format", "{{.Name}}"],
      ["volume", "inspect", "--format", '{{index .Labels "com.docker.compose.project"}}', "orbit_orbit-db-data"],
    ]);
  });
});
