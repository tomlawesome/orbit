import { type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import type { ImageIdentityAdapter } from "./image-resolution";
import type { DatabaseVolumeSafetyAdapter } from "./database-volume-safety";

// The real `docker`/`docker compose` adapter (issue #295 slice 5) — the
// shipped production implementation the plan deferred from slice 2
// (VolumeOwnershipAdapter/DatabaseVolumeSafetyAdapter), slice 3
// (OidcDiscoverySandboxAdapter's sandboxed-container half), and this slice's
// own image-identity resolution (ImageIdentityAdapter) and service
// pull/start/health-probe/compose-validate calls
// (install.sh:1079-1310,1539-1541,1543,1546). Every method below spawns a
// fixed `docker`/`docker compose` argv array via `spawnSync` — never a shell
// string — exactly mirroring restore-engine.ts's/recovery-bundle.ts's own
// createDockerCompose*Adapter shape for issue #296. No method here decides
// anything; every decision (ownership, digest/revision/version validity,
// sequencing) lives in the pure modules this adapter is injected into
// (database-volume-safety.ts, image-resolution.ts, install-orchestrator.ts).
//
// Bounded health probes (`bounded_compose_probe`, install.sh:1079-1082,
// guarantee #33: `timeout --signal=TERM --kill-after=1s 5s docker compose
// ...`) are ported here via `spawnSync`'s own `timeout`/`killSignal` options
// rather than shelling out to the GNU `timeout` binary install.sh requires —
// a deliberate adapter-level implementation difference, not a guarantee
// weakening (the probe is still force-killed within a bounded window; see
// docs/adr-notes/295-install-port-plan.md's Flags section for why the
// two-stage TERM-then-KILL grace period isn't independently reproduced, and
// why this removes the GNU `timeout` binary from this adapter's own tool
// preflight).

export interface InstallDockerAdapterOptions {
  /** The `--env-file` path passed to every `docker compose` invocation. */
  envFile: string;
  /** The `--project-name` passed to every `docker compose` invocation (install.sh's `compose()` helper, install.sh:258-260). */
  composeProjectName: string;
  cwd?: string;
  /** Overrides the `docker` executable name/path. Defaults to `"docker"`. */
  dockerBinary?: string;
  /**
   * Environment for the `docker` subprocess (defaults to `process.env`) —
   * the PATH-shim test seam, mirroring recovery-bundle.ts's
   * DockerComposeAdapterOptions.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * app_readiness_probe (install.sh:48-53, guarantee #34): the exact embedded
 * Node source `probe_application_health` runs inside the `orbit-app`
 * container via `docker compose exec -T orbit-app node -e`. Transcribed
 * verbatim; byte-compared against the live script in
 * install-docker-adapter.parity.test.ts.
 */
export const APP_READINESS_PROBE = `fetch("http://127.0.0.1:3000/api/health", { cache: "no-store", signal: AbortSignal.timeout(3000) })
  .then(async (response) => {
    let body;
    try { body = await response.json(); } catch { process.exit(1); }
    process.exit(response.status === 200 && body !== null && typeof body === "object" &&
      body.status === "ready" && body.service === "orbit" ? 0 : 1);
  })
  .catch(() => process.exit(1));`;

/** tika_readiness_probe (install.sh:54-56), transcribed verbatim. */
export const TIKA_READINESS_PROBE = `fetch("http://orbit-tika:9998/version", { cache: "no-store", signal: AbortSignal.timeout(3000) })
  .then((response) => process.exit(response.status === 200 ? 0 : 1))
  .catch(() => process.exit(1));`;

/**
 * oidc_discovery_parser (install.sh:23-47, guarantee #27): the exact
 * embedded Node source run *inside the resolved Orbit image's own container*
 * (never the installer's host process) to validate the untrusted OIDC
 * discovery document. Transcribed verbatim; byte-compared against the live
 * script in install-docker-adapter.parity.test.ts. src/lib/oidc-discovery.ts's
 * `validateDiscoveryDocument` is a faithful TypeScript port of this same
 * source, used only to prove semantic parity — it is never what actually
 * runs inside the sandbox; this string is.
 */
export const OIDC_DISCOVERY_PARSER = `const fs = require("node:fs");
const maximumInputBytes = 1048576 + 8192;
const input = fs.readFileSync(0, "utf8");
if (Buffer.byteLength(input, "utf8") > maximumInputBytes) process.exit(1);
const separator = input.indexOf("\\n");
if (separator <= 0) process.exit(1);
const issuer = input.slice(0, separator);
let document;
try {
  document = JSON.parse(input.slice(separator + 1));
} catch {
  process.exit(1);
}
if (document === null || typeof document !== "object" || Array.isArray(document)) process.exit(1);
if (document.issuer !== issuer) process.exit(1);
for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
  if (typeof document[field] !== "string") process.exit(1);
  let endpoint;
  try {
    endpoint = new URL(document[field]);
  } catch {
    process.exit(1);
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) process.exit(1);
}`;

export interface InstallDockerAdapter extends DatabaseVolumeSafetyAdapter, ImageIdentityAdapter {
  /** docker run --rm --entrypoint /opt/orbit/scripts/container-entrypoint.sh <resolvedReference> --banner (install.sh:1306-1310, guarantee #44). */
  runBanner(resolvedReference: string): boolean;
  /**
   * docker run --rm --interactive --entrypoint node --network none --read-only
   *   --cap-drop ALL --security-opt no-new-privileges --user 1001:1001
   *   --pids-limit 64 --memory 64m --cpus 0.5 <resolvedReference>
   *   --input-type=commonjs -e <OIDC_DISCOVERY_PARSER>, fed `${issuer}\n`
   *   followed by `documentPath`'s own bytes on stdin (install.sh:927-944,
   *   guarantee #27). `documentPath` is read fresh via a second, separate
   *   open (never the same descriptor oidc-discovery.ts's own file-safety
   *   check used), matching install.sh's own two-open sequence exactly.
   */
  validateOidcDiscoverySandbox(resolvedReference: string, issuer: string, documentPath: string): boolean;
  /** command -v docker && docker compose version (install.sh:1260-1261, guarantee #40's docker/compose half). */
  checkDockerAvailable(): boolean;
  /** docker compose --project-name ... --env-file ... pull <service> (install.sh:1129-1162's per-service pulls). */
  composePull(service: string): boolean;
  /** docker compose --project-name ... --env-file ... up -d --no-build --remove-orphans (install.sh:1168). */
  composeUp(): boolean;
  /** docker compose --project-name ... --env-file ... down --remove-orphans (install.sh:1171, only ever called on a failed fresh install). */
  composeDown(): void;
  /** docker compose --project-name ... --env-file ... config --quiet (install.sh:1539-1541, guarantee #55). */
  composeConfigValidate(): boolean;
  /** bounded (5s/1s-kill-after) `compose exec -T orbit-db sh -ec 'exec pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'` (install.sh:1084-1089, guarantee #33). */
  probeDatabaseHealth(): boolean;
  /** bounded `compose exec -T orbit-app node -e <APP_READINESS_PROBE>` (install.sh:1091-1093, guarantees #33-34). */
  probeApplicationHealth(): boolean;
  /** bounded `compose exec -T orbit-clamav clamdscan --ping 1` (install.sh:1095-1097). */
  probeClamavHealth(): boolean;
  /** bounded `compose exec -T orbit-app node -e <TIKA_READINESS_PROBE>` (install.sh:1099-1101). */
  probeTikaHealth(): boolean;
  /** bounded `compose exec -T orbit-ollama ollama list` (install.sh:1103-1105). */
  probeOllamaHealth(): boolean;
  /** bounded `compose exec -T orbit-app true` — the liveness check that distinguishes "not yet ready" from "process exited" (install.sh:1180-1185, guarantee #38). */
  probeApplicationLiveness(): boolean;
  /** `compose exec -T orbit-ollama ollama pull <model>` (install.sh:1213-1214, only after Ollama is already verified healthy, guarantee #39) — not bounded by the 5s probe timeout, matching install.sh's own call shape. */
  pullOllamaModel(model: string): boolean;
  /**
   * Updates the `--project-name` every subsequent `composePull`/`composeUp`/
   * `composeDown`/`composeConfigValidate`/probe call uses. install.sh's own
   * `compose()` helper (install.sh:258-260) reads the bash global
   * `$compose_project_name` fresh on every call, so a later reassignment
   * (`verify_database_volume_safety`'s own `compose_project_name=
   * $discovered_project`, install.sh:573, when an existing volume's proven
   * owner differs from the name this adapter was first constructed with)
   * takes effect for every `compose` invocation from that point on. This
   * adapter is constructed once, before that resolution has necessarily
   * happened, so it needs the same live-reassignment behaviour rather than
   * a value fixed forever at construction time — the caller (install-
   * orchestrator.ts) calls this once, immediately after
   * `verifyDatabaseVolumeSafety`'s first call resolves the final project
   * name, and before any `compose`-wrapped method is ever invoked.
   */
  setComposeProjectName(name: string): void;
}

const BOUNDED_PROBE_TIMEOUT_MS = 5000;

function statusOk(result: SpawnSyncReturns<string>): boolean {
  return result.status === 0;
}

export function createInstallDockerAdapter(options: InstallDockerAdapterOptions): InstallDockerAdapter {
  const dockerBinary = options.dockerBinary ?? "docker";
  const cwd = options.cwd;
  const env = options.env ?? process.env;
  // Mutable, not captured once: see InstallDockerAdapter.setComposeProjectName's
  // own doc for why this must behave like install.sh's own live-read
  // `$compose_project_name` global rather than a value frozen at
  // construction time.
  let composeProjectName = options.composeProjectName;

  function run(args: string[], extra: Partial<SpawnSyncOptionsWithStringEncoding> = {}): SpawnSyncReturns<string> {
    return spawnSync(dockerBinary, args, { cwd, env, encoding: "utf8", ...extra });
  }

  function runCaptured(args: string[]): string | null {
    const result = run(args);
    if (result.status !== 0 || result.error) return null;
    return result.stdout.replace(/\n$/, "");
  }

  const composeArgs = (...args: string[]): string[] => [
    "compose",
    "--project-name",
    composeProjectName,
    "--env-file",
    options.envFile,
    ...args,
  ];

  function boundedComposeExec(args: string[], stdin?: string): boolean {
    const result = run(composeArgs(...args), {
      timeout: BOUNDED_PROBE_TIMEOUT_MS,
      killSignal: "SIGTERM",
      input: stdin,
      stdio: stdin === undefined ? ["ignore", "ignore", "ignore"] : undefined,
    });
    return statusOk(result);
  }

  return {
    // --- VolumeOwnershipAdapter / DatabaseVolumeSafetyAdapter (slice 2 deferral) ---
    inspectVolumeLabels: (candidateVolume) =>
      runCaptured([
        "volume",
        "inspect",
        "--format",
        '{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.volume"}}',
        candidateVolume,
      ]),
    listContainersByVolume: (candidateVolume) =>
      runCaptured([
        "ps",
        "-a",
        "--filter",
        `volume=${candidateVolume}`,
        "--format",
        '{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}',
      ]),
    listContainersByProject: (project) =>
      runCaptured([
        "ps",
        "-a",
        "--filter",
        `label=com.docker.compose.project=${project}`,
        "--format",
        '{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}',
      ]),
    inspectContainerImage: (containerId) => runCaptured(["inspect", "--format", "{{.Config.Image}}", containerId]),
    listVolumesExactName: (name) => runCaptured(["volume", "ls", "--filter", `name=^${name}$`, "--format", "{{.Name}}"]),
    listVolumesByKeySubstring: (key) => runCaptured(["volume", "ls", "--filter", `name=${key}`, "--format", "{{.Name}}"]),
    inspectVolumeProjectLabel: (name) =>
      runCaptured(["volume", "inspect", "--format", '{{index .Labels "com.docker.compose.project"}}', name]),

    // --- ImageIdentityAdapter (slice 5) ---
    pull: (imageRepository, channel) => statusOk(run(["pull", "--quiet", `${imageRepository}:${channel}`])),
    inspectRepoDigests: (imageRepository, channel) =>
      runCaptured(["image", "inspect", "--format", "{{range .RepoDigests}}{{println .}}{{end}}", `${imageRepository}:${channel}`]),
    inspectRevisionLabel: (resolvedReference) =>
      runCaptured(["image", "inspect", "--format", '{{index .Config.Labels "org.opencontainers.image.revision"}}', resolvedReference]),
    inspectVersionLabel: (resolvedReference) =>
      runCaptured(["image", "inspect", "--format", '{{index .Config.Labels "org.opencontainers.image.version"}}', resolvedReference]),
    runBanner: (resolvedReference) =>
      statusOk(run(["run", "--rm", "--entrypoint", "/opt/orbit/scripts/container-entrypoint.sh", resolvedReference, "--banner"])),

    // --- OidcDiscoverySandboxAdapter's sandboxed-container half (slice 3 deferral) ---
    validateOidcDiscoverySandbox(resolvedReference, issuer, documentPath) {
      const stdin = `${issuer}\n${readFileSync(documentPath, "utf8")}`;
      const result = run(
        [
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
          resolvedReference,
          "--input-type=commonjs",
          "-e",
          OIDC_DISCOVERY_PARSER,
        ],
        { input: stdin },
      );
      return statusOk(result);
    },

    checkDockerAvailable: () => statusOk(run(["compose", "version"], { stdio: ["ignore", "ignore", "ignore"] })),

    composePull: (service) => statusOk(run(composeArgs("pull", service), { stdio: ["ignore", "ignore", "ignore"] })),
    composeUp: () => statusOk(run(composeArgs("up", "-d", "--no-build", "--remove-orphans"), { stdio: ["ignore", "ignore", "ignore"] })),
    composeDown: () => {
      run(composeArgs("down", "--remove-orphans"), { stdio: ["ignore", "ignore", "ignore"] });
    },
    composeConfigValidate: () => statusOk(run(composeArgs("config", "--quiet"), { stdio: ["ignore", "ignore", "ignore"] })),

    probeDatabaseHealth: () =>
      boundedComposeExec(["exec", "-T", "orbit-db", "sh", "-ec", 'exec pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"']),
    probeApplicationHealth: () => boundedComposeExec(["exec", "-T", "orbit-app", "node", "-e", APP_READINESS_PROBE]),
    probeClamavHealth: () => boundedComposeExec(["exec", "-T", "orbit-clamav", "clamdscan", "--ping", "1"]),
    probeTikaHealth: () => boundedComposeExec(["exec", "-T", "orbit-app", "node", "-e", TIKA_READINESS_PROBE]),
    probeOllamaHealth: () => boundedComposeExec(["exec", "-T", "orbit-ollama", "ollama", "list"]),
    probeApplicationLiveness: () => boundedComposeExec(["exec", "-T", "orbit-app", "true"]),

    pullOllamaModel: (model) =>
      statusOk(run(composeArgs("exec", "-T", "orbit-ollama", "ollama", "pull", model), { stdio: ["ignore", "ignore", "inherit"] })),

    setComposeProjectName(name) {
      composeProjectName = name;
    },
  };
}
