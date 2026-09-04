import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

// Every spawnSync call here runs configure.sh (or a coreutil) under bash; a
// spawn that takes tens of milliseconds quiet takes seconds on a starved
// core (#698). Budget and reasoning: scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

// scripts/engine-check.sh is the first delegation point for issue #295's
// engine-delivery architecture; this suite proves scripts/configure.sh's own
// delegation onto the SAME pattern for its write flows (issue #294):
// ORBIT_CONFIGURE_ENGINE=container (engine-check.sh's own
// ORBIT_ENGINE_CHECK=container sibling) opts a bare/--init/--set-oidc-secret/
// --set-deployment-profile invocation into composing a
// `docker compose run --rm --no-deps` one-off against the bundled orbit CLI,
// falling back to the original bash logic whenever any precondition isn't
// met. Unset (the default) is scripts/configure.test.mjs's own 73-test
// contract, proven unmodified there; this file only exercises the new,
// additive, opt-in behavior with a fake `docker` on PATH — no test here
// reaches a real daemon, container, volume, or image.

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoDir = join(scriptsDir, "..");
const configureScriptSource = readFileSync(join(scriptsDir, "configure.sh"), "utf8");
const installerUiSource = readFileSync(join(scriptsDir, "installer-ui.sh"), "utf8");
const environmentExampleSource = readFileSync(join(repoDir, ".env-orbit.example"), "utf8");

const SPAWN_OPTS = { encoding: "utf8", ...processGuard() };

const scratchDirs = [];

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop(), { recursive: true, force: true });
  }
});

function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

const VALID_ORBIT_IMAGE = "orbit-local:abcdef123456";

function makeFixture({ withEnvFile = true, composeProjectName = "delegationtest" } = {}) {
  const targetDir = scratchDir("orbit-configure-delegation-");
  mkdirSync(join(targetDir, "scripts"));
  writeFileSync(join(targetDir, "scripts", "configure.sh"), configureScriptSource);
  chmodSync(join(targetDir, "scripts", "configure.sh"), 0o755);
  writeFileSync(join(targetDir, "scripts", "installer-ui.sh"), installerUiSource);
  chmodSync(join(targetDir, "scripts", "installer-ui.sh"), 0o755);
  writeFileSync(join(targetDir, ".env-orbit.example"), environmentExampleSource);
  if (withEnvFile) {
    const envLines = [
      "ORBIT_CONFIG_SCHEMA_VERSION=1",
      "APP_URL=https://orbit.delegation-test.internal",
      `ORBIT_IMAGE=${VALID_ORBIT_IMAGE}`,
      "OIDC_ISSUER=https://auth.delegation-test.internal/application/o/orbit/",
      "OIDC_CLIENT_ID=delegation-test-client",
      "OIDC_CLIENT_SECRET=delegation-test-secret",
      "OIDC_CALLBACK_URL=https://orbit.delegation-test.internal/api/auth/callback",
      ...(composeProjectName ? [`COMPOSE_PROJECT_NAME=${composeProjectName}`] : []),
      "",
    ].join("\n");
    writeFileSync(join(targetDir, ".env-orbit"), envLines);
    chmodSync(join(targetDir, ".env-orbit"), 0o600);
  }
  return targetDir;
}

// A fake `docker` that: (1) answers `image inspect <ref>` with a
// configurable exit code (simulating whether the image is present locally —
// engine_delegation_ready's own gate), and (2) for `compose ... run ...`,
// logs its exact argv (one argument per line) to argvLogPath and exits with
// runExitCode. Bash, not Node — `docker compose --env-file <path>` collides
// with Node 20.6+'s own `--env-file` CLI-flag interception, the same reason
// engine-check.test.mjs's own fake docker is a bash script.
function makeFakeDockerBin({ imageInspectExitCode = 0, runExitCode = 0, argvLogPath }) {
  const binDir = scratchDir("orbit-configure-delegation-fakebin-");
  const script = [
    "#!/usr/bin/env bash",
    'if [[ "${1:-}" == image ]]; then',
    `  exit ${imageInspectExitCode}`,
    "fi",
    'if [[ "${1:-}" == compose ]]; then',
    `  printf '%s\\n' "$@" > '${argvLogPath}'`,
    `  exit ${runExitCode}`,
    "fi",
    "exit 1",
    "",
  ].join("\n");
  writeFileSync(join(binDir, "docker"), script);
  chmodSync(join(binDir, "docker"), 0o755);
  return binDir;
}

function runConfigure(targetDir, args, { pathPrefix, env = {}, input } = {}) {
  const pathValue = pathPrefix ? `${pathPrefix}:${process.env.PATH}` : process.env.PATH;
  return failOnProcessDeadline(spawnSync("bash", [join(targetDir, "scripts", "configure.sh"), ...args], {
    cwd: targetDir,
    ...SPAWN_OPTS,
    input,
    env: { PATH: pathValue, HOME: process.env.HOME ?? tmpdir(), ...env },
  }), { label: "runConfigure" });
}

function readArgv(argvLogPath) {
  return readFileSync(argvLogPath, "utf8").split("\n").filter((line) => line.length > 0);
}

describe("default mode (ORBIT_CONFIGURE_ENGINE unset): never touches docker", () => {
  it("the bare flow's own delegation gate never fires with no docker on PATH at all", () => {
    const targetDir = makeFixture();
    // No fake docker at all — a real docker binary might still exist
    // elsewhere on the outer PATH, so this uses a docker-less PATH the same
    // way engine-check.test.mjs's makeDockerlessBinDir does, proving the
    // default path's own `command -v docker` gate is never reached in a way
    // that would fail if it were.
    const dockerlessBinDir = scratchDir("orbit-configure-delegation-nodocker-");
    for (const systemDir of ["/usr/bin", "/bin"]) {
      let entries = [];
      try {
        entries = failOnProcessDeadline(spawnSync("ls", [systemDir], SPAWN_OPTS), { label: "ls systemDir" }).stdout.split("\n").filter(Boolean);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (name === "docker") continue;
        const target = join(systemDir, name);
        const linkPath = join(dockerlessBinDir, name);
        try {
          symlinkSync(target, linkPath);
        } catch {
          /* duplicate name across /usr/bin and /bin — keep the first */
        }
      }
    }
    const result = runConfigure(targetDir, [], { env: { PATH: dockerlessBinDir, ORBIT_IMAGE: VALID_ORBIT_IMAGE } });
    // Reaches ensure_vapid_keys, which itself requires docker — fails
    // closed there (a pre-existing, unrelated contract), never at the
    // engine-delegation gate this suite is about.
    expect(result.stderr).toContain("Docker is required to generate VAPID keys.");
  });
});

describe("ORBIT_CONFIGURE_ENGINE=container: composes the documented one-off invocation", () => {
  it("bare flow (re-run, .env-orbit already present): delegates with the documented argv and a :rw mount", () => {
    const targetDir = makeFixture({ composeProjectName: "delegationtest" });
    const argvLogPath = join(targetDir, "docker-argv.log");
    const binDir = makeFakeDockerBin({ argvLogPath });

    const result = runConfigure(targetDir, [], {
      pathPrefix: binDir,
      env: { ORBIT_CONFIGURE_ENGINE: "container", ORBIT_IMAGE: VALID_ORBIT_IMAGE },
    });

    // ensure_vapid_keys still runs (bash-only, always) after the delegated
    // call; with only a fake docker (not a fake openssl too) it fails
    // closed there — this test's own concern is the composed argv up to
    // that point, asserted directly below regardless of the script's final
    // exit code.
    void result;
    const argv = readArgv(argvLogPath);
    expect(argv).toEqual([
      "compose",
      "--project-name",
      "delegationtest",
      "--env-file",
      ".env-orbit",
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "--entrypoint",
      "node",
      "-e",
      `ORBIT_IMAGE=${VALID_ORBIT_IMAGE}`,
      "--volume",
      `${targetDir}:/orbit-deploy:rw`,
      "orbit-app",
      "/opt/orbit/cli/orbit.js",
      "configure",
      "--dir",
      "/orbit-deploy",
    ]);
  });

  it("bare flow (first run, .env-orbit absent): never delegates — docker is never invoked", () => {
    const targetDir = makeFixture({ withEnvFile: false });
    const argvLogPath = join(targetDir, "docker-argv.log");
    const binDir = makeFakeDockerBin({ argvLogPath });

    runConfigure(targetDir, [], {
      pathPrefix: binDir,
      env: { ORBIT_CONFIGURE_ENGINE: "container", ORBIT_IMAGE: VALID_ORBIT_IMAGE },
    });

    expect(() => readFileSync(argvLogPath, "utf8")).toThrow();
  });

  it("falls back to bash when the image is not present locally (docker image inspect fails)", () => {
    const targetDir = makeFixture();
    const argvLogPath = join(targetDir, "docker-argv.log");
    const binDir = makeFakeDockerBin({ imageInspectExitCode: 1, argvLogPath });

    runConfigure(targetDir, [], {
      pathPrefix: binDir,
      env: { ORBIT_CONFIGURE_ENGINE: "container", ORBIT_IMAGE: VALID_ORBIT_IMAGE },
    });

    expect(() => readFileSync(argvLogPath, "utf8")).toThrow();
  });

  it("the bare flow collapses any nonzero one-off exit code to 1 via fail(), matching every other bare-flow failure's own exit-1 convention", () => {
    const targetDir = makeFixture();
    const argvLogPath = join(targetDir, "docker-argv.log");
    const binDir = makeFakeDockerBin({ runExitCode: 3, argvLogPath });

    const result = runConfigure(targetDir, [], {
      pathPrefix: binDir,
      env: { ORBIT_CONFIGURE_ENGINE: "container", ORBIT_IMAGE: VALID_ORBIT_IMAGE },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Orbit configuration:");
  });

  it("--set-deployment-profile propagates the composed one-off's exit code unchanged (its own usage-exit-2 convention included)", () => {
    const targetDir = makeFixture();
    const argvLogPath = join(targetDir, "docker-argv.log");
    const binDir = makeFakeDockerBin({ runExitCode: 3, argvLogPath });

    const result = runConfigure(targetDir, ["--set-deployment-profile", "ai", "llama3:8b"], {
      pathPrefix: binDir,
      env: { ORBIT_CONFIGURE_ENGINE: "container", ORBIT_IMAGE: VALID_ORBIT_IMAGE },
    });

    expect(result.status).toBe(3);
  });

  it("--init: the fully-scripted ORBIT_CONFIGURE_* env triad delegates, forwarding the three values via -e", () => {
    const targetDir = makeFixture();
    const argvLogPath = join(targetDir, "docker-argv.log");
    const binDir = makeFakeDockerBin({ argvLogPath });

    runConfigure(targetDir, ["--init"], {
      pathPrefix: binDir,
      env: {
        ORBIT_CONFIGURE_ENGINE: "container",
        ORBIT_IMAGE: VALID_ORBIT_IMAGE,
        ORBIT_CONFIGURE_APP_URL: "https://orbit.delegation-init.invalid",
        ORBIT_CONFIGURE_OIDC_ISSUER: "https://auth.delegation-init.invalid/",
        ORBIT_CONFIGURE_OIDC_CLIENT_ID: "delegation-init-client",
      },
    });

    const argv = readArgv(argvLogPath);
    expect(argv).toContain("ORBIT_CONFIGURE_APP_URL=https://orbit.delegation-init.invalid");
    expect(argv).toContain("ORBIT_CONFIGURE_OIDC_ISSUER=https://auth.delegation-init.invalid/");
    expect(argv).toContain("ORBIT_CONFIGURE_OIDC_CLIENT_ID=delegation-init-client");
    // run_engine's own tail is always: configure "$@" --dir /orbit-deploy.
    expect(argv.slice(-4)).toEqual(["configure", "--init", "--dir", "/orbit-deploy"]);
  });

  it("--init: ORBIT_CONFIGURE_PROMPTS=machine delegates, forwarding the machine-mode flag, with stdin/stdout left untouched for the container to speak the grammar", () => {
    const targetDir = makeFixture();
    const argvLogPath = join(targetDir, "docker-argv.log");
    const binDir = makeFakeDockerBin({ argvLogPath });

    runConfigure(targetDir, ["--init"], {
      pathPrefix: binDir,
      env: { ORBIT_CONFIGURE_ENGINE: "container", ORBIT_IMAGE: VALID_ORBIT_IMAGE, ORBIT_CONFIGURE_PROMPTS: "machine" },
      input: "",
    });

    const argv = readArgv(argvLogPath);
    expect(argv).toContain("ORBIT_CONFIGURE_PROMPTS=machine");
    expect(argv).toContain("--init");
  });

  it("--init: a real controlling-terminal session (no env triad, no machine mode) never delegates", () => {
    const targetDir = makeFixture();
    const argvLogPath = join(targetDir, "docker-argv.log");
    const binDir = makeFakeDockerBin({ argvLogPath });

    // No /dev/tty available in this harness either way, so bash's own TTY
    // path fails closed on its own — the assertion here is only that
    // docker is never reached first.
    runConfigure(targetDir, ["--init"], {
      pathPrefix: binDir,
      env: { ORBIT_CONFIGURE_ENGINE: "container", ORBIT_IMAGE: VALID_ORBIT_IMAGE },
    });

    expect(() => readFileSync(argvLogPath, "utf8")).toThrow();
  });

  it("--set-oidc-secret: a plain piped (non-TTY) secret delegates, and the secret value never appears in the composed argv", () => {
    const targetDir = makeFixture();
    const argvLogPath = join(targetDir, "docker-argv.log");
    const binDir = makeFakeDockerBin({ argvLogPath });

    runConfigure(targetDir, ["--set-oidc-secret"], {
      pathPrefix: binDir,
      env: { ORBIT_CONFIGURE_ENGINE: "container", ORBIT_IMAGE: VALID_ORBIT_IMAGE },
      input: "piped-delegation-secret\n",
    });

    const argv = readArgv(argvLogPath);
    expect(argv).toContain("--set-oidc-secret");
    expect(readFileSync(argvLogPath, "utf8")).not.toContain("piped-delegation-secret");
  });

  it("--set-oidc-secret: ORBIT_CONFIGURE_TTY_INPUT=1 never delegates (stays bash-only)", () => {
    const targetDir = makeFixture();
    const argvLogPath = join(targetDir, "docker-argv.log");
    const binDir = makeFakeDockerBin({ argvLogPath });

    runConfigure(targetDir, ["--set-oidc-secret"], {
      pathPrefix: binDir,
      env: { ORBIT_CONFIGURE_ENGINE: "container", ORBIT_IMAGE: VALID_ORBIT_IMAGE, ORBIT_CONFIGURE_TTY_INPUT: "1" },
      input: "would-be-terminal-secret\n",
    });

    expect(() => readFileSync(argvLogPath, "utf8")).toThrow();
  });

  it("--set-deployment-profile: always delegates (no interactivity involved), forwarding preset and model", () => {
    const targetDir = makeFixture();
    const argvLogPath = join(targetDir, "docker-argv.log");
    const binDir = makeFakeDockerBin({ argvLogPath });

    runConfigure(targetDir, ["--set-deployment-profile", "ai", "llama3:8b"], {
      pathPrefix: binDir,
      env: { ORBIT_CONFIGURE_ENGINE: "container", ORBIT_IMAGE: VALID_ORBIT_IMAGE },
    });

    const argv = readArgv(argvLogPath);
    expect(argv).toContain("--set-deployment-profile");
    expect(argv).toContain("ai");
    expect(argv).toContain("llama3:8b");
  });
});
