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

const fakeDockerScript = [
  "#!/usr/bin/env bash",
  'if [[ -n "${ORBIT_ARGV_LOG:-}" ]]; then',
  "  {",
  '    for arg in "$@"; do printf \'%s\\0\' "$arg"; done',
  "    printf '\\x1e'",
  '  } >> "$ORBIT_ARGV_LOG"',
  "fi",
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
