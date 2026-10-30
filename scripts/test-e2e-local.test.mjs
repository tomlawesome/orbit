import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  PROCESS_DEADLINE_MS,
  PROCESS_TEST_TIMEOUT_MS,
  failOnProcessDeadline,
  processGuard,
} from "./process-budget.mjs";

// #731: --project is variadic in the pinned Playwright, so `--project NAME
// SPEC` reads SPEC as a second project name instead of a file filter. This
// drives the real script (not a text match on its source) with
// TEST_E2E_LOCAL_DRY_RUN=1, a hook that prints the assembled
// `playwright_args` array and exits before any Docker or network work runs
// -- so the combination is proven without bringing up the acceptance stack.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const script = fileURLToPath(new URL("./test-e2e-local.sh", import.meta.url));

function dryRunArgsRaw(args) {
  return failOnProcessDeadline(
    spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      env: { ...process.env, TEST_E2E_LOCAL_DRY_RUN: "1" },
      ...processGuard(),
    }),
    { label: "dryRunArgs" },
  );
}

function dryRunArgs(args) {
  const result = dryRunArgsRaw(args);
  expect(result.status, `stderr: ${result.stderr}`).toBe(0);
  return result.stdout.split("\n").filter((line) => line.length > 0);
}

// The two --reuse tests that drive the real discovery code, and so need a
// real docker binary, live in test-e2e-local-reuse.test.mjs: `fast` has no
// docker, `fast_docker` does (#950). Only argument handling is tested here,
// which the dry-run hook answers before the script checks its preconditions.
describe("test-e2e-local.sh --reuse", () => {
  it("accepts a value without disturbing Playwright argument assembly", () => {
    expect(dryRunArgs(["--reuse", "some-project"])).toEqual(dryRunArgs([]));
  });

  it("requires a value", () => {
    const result = dryRunArgsRaw(["--reuse"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--reuse requires a Compose project name");
  });
});

describe("test-e2e-local.sh Playwright argument assembly", () => {
  it("keeps the spec out of --project's value when both flags are given", () => {
    const args = dryRunArgs([
      "--spec",
      "tests/e2e/v19-hit-routing.spec.ts",
      "--project",
      "desktop-chromium",
    ]);
    expect(args).toEqual(["--project=desktop-chromium", "tests/e2e/v19-hit-routing.spec.ts"]);
  });

  it("keeps the spec out of --project's value regardless of flag order", () => {
    const args = dryRunArgs([
      "--project",
      "mobile-chromium",
      "--spec",
      "tests/e2e/v19-hit-routing.spec.ts",
    ]);
    expect(args).toEqual(["--project=mobile-chromium", "tests/e2e/v19-hit-routing.spec.ts"]);
  });

  it("passes --project alone", () => {
    const args = dryRunArgs(["--project", "desktop-chromium"]);
    expect(args).toEqual(["--project=desktop-chromium"]);
  });

  // #1561: repeated --project flags used to keep only the last one.
  it("passes every --project when several are given, in order", () => {
    const args = dryRunArgs([
      "--project",
      "desktop-chromium",
      "--project",
      "mobile-chromium",
    ]);
    expect(args).toEqual(["--project=desktop-chromium", "--project=mobile-chromium"]);
  });

  it("passes every --project in the order given, not sorted", () => {
    const args = dryRunArgs([
      "--project",
      "mobile-chromium",
      "--project",
      "desktop-chromium",
    ]);
    expect(args).toEqual(["--project=mobile-chromium", "--project=desktop-chromium"]);
  });

  it("passes every --project and still keeps the spec out of their values", () => {
    const args = dryRunArgs([
      "--project",
      "desktop-chromium",
      "--spec",
      "tests/e2e/v19-hit-routing.spec.ts",
      "--project",
      "mobile-chromium",
    ]);
    expect(args).toEqual([
      "--project=desktop-chromium",
      "--project=mobile-chromium",
      "tests/e2e/v19-hit-routing.spec.ts",
    ]);
  });

  it("passes a single --project exactly once", () => {
    const args = dryRunArgs(["--project", "mobile-chromium"]);
    expect(args.filter((arg) => arg.startsWith("--project"))).toEqual(["--project=mobile-chromium"]);
  });

  it("passes --spec alone", () => {
    const args = dryRunArgs(["--spec", "tests/e2e/v19-hit-routing.spec.ts"]);
    expect(args).toEqual(["tests/e2e/v19-hit-routing.spec.ts"]);
  });

  it("passes neither flag", () => {
    expect(dryRunArgs([])).toEqual([]);
  });
});

/*
 * #916: the second acceptance profile. Its whole point is that one short list
 * of specs runs against a provider-less stack, and that the same list is what
 * the `smoke_local_only` job in .gitlab-ci.yml runs -- so the list is a file
 * both read rather than a phrase each repeats. These drive the real script,
 * the same way as above, so the list is proven to reach Playwright's argument
 * vector rather than merely to exist.
 */
const localOnlySpecs = readFileSync(
  fileURLToPath(new URL("../tests/e2e/local-only-specs.txt", import.meta.url)),
  "utf8",
)
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"));

describe("the local-only profile", () => {
  it("names at least one spec, so the lane cannot silently run nothing", () => {
    expect(localOnlySpecs.length).toBeGreaterThan(0);
  });

  it("runs the shared list when no --spec narrows it", () => {
    expect(dryRunArgs(["--profile", "local-only"])).toEqual(localOnlySpecs);
  });

  it("keeps the list behind an explicit --project, in that order", () => {
    expect(dryRunArgs(["--profile", "local-only", "--project", "desktop-chromium"]))
      .toEqual(["--project=desktop-chromium", ...localOnlySpecs]);
  });

  it("lets an explicit --spec override the list", () => {
    expect(dryRunArgs(["--profile", "local-only", "--spec", "tests/e2e/local-sign-in.spec.ts"]))
      .toEqual(["tests/e2e/local-sign-in.spec.ts"]);
  });

  it("changes nothing for the default profile", () => {
    expect(dryRunArgs(["--profile", "oidc"])).toEqual([]);
  });

  it("refuses a profile it does not have a stack for", () => {
    const result = spawnSync("bash", [script, "--profile", "provider-less"], {
      encoding: "utf8",
      env: { ...process.env, TEST_E2E_LOCAL_DRY_RUN: "1" },
      ...processGuard(),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown profile");
  });
});

/*
 * #920: this harness's claim is that a local run judges the journeys CI
 * judges, and it silently did not -- the document parser was never turned
 * on, so tests/e2e/v19-document-extraction.spec.ts failed locally with the
 * product's "the optional document processor" message while passing in CI.
 * CI turns it on in scripts/ci/create-test-configuration.sh, which appends
 * the profile and the parser's address to .env-orbit. This script must never
 * write to .env-orbit, so it carries the same two values by its own route:
 * the profile through COMPOSE_PROFILES on its compose() wrapper, the address
 * through compose/docker-compose.local-e2e.yml. Read CI's values rather than
 * repeating them, so moving CI's pair cannot leave the local pair behind --
 * the same "one source both lanes read" shape as local-only-specs.txt above.
 */
const ciTestConfiguration = readFileSync(
  fileURLToPath(new URL("./ci/create-test-configuration.sh", import.meta.url)),
  "utf8",
);
const scriptSource = readFileSync(script, "utf8");
const localE2eOverlay = readFileSync(
  fileURLToPath(new URL("../compose/docker-compose.local-e2e.yml", import.meta.url)),
  "utf8",
);

function ciAppendedValue(key) {
  const match = ciTestConfiguration.match(new RegExp(`'${key}=([^']*)'`));
  expect(match, `scripts/ci/create-test-configuration.sh no longer appends ${key}`).not.toBeNull();
  return match[1];
}

describe("the document parser the local stack runs", () => {
  it("selects the same Compose profile CI does", () => {
    expect(scriptSource).toContain(`COMPOSE_PROFILES=${ciAppendedValue("COMPOSE_PROFILES")}`);
  });

  it("points the application at the same parser address CI does", () => {
    expect(localE2eOverlay).toContain(`TIKA_URL: ${ciAppendedValue("TIKA_URL")}`);
  });
});

/*
 * #1150: a --reuse (#947) stack is already claimed, so the one-time
 * "unclaimed" project (tests/e2e/playwright.config.ts, #1039) -- whose one
 * spec asserts the opposite -- fails loudly against it, and "setup" depends
 * on that project, so nothing else runs either. The script tells the config
 * which path a run is on with one flag; this proves the flag's name cannot
 * drift between the two files, and that it is set only when a stack is
 * actually being reused, the same "one source both lanes read" shape as the
 * document-parser check above.
 */
describe("the --reuse path skips the one-time bootstrap project", () => {
  const configSource = readFileSync(
    fileURLToPath(new URL("../tests/e2e/playwright.config.ts", import.meta.url)),
    "utf8",
  );

  it("sets the flag only when a stack is being reused", () => {
    expect(scriptSource).toContain('[[ -z "$reuse_project" ]] || reuse_env=(ORBIT_E2E_REUSE=true)');
  });

  it("names the flag playwright.config.ts actually reads", () => {
    expect(configSource).toContain('process.env.ORBIT_E2E_REUSE === "true"');
  });
});

/*
 * #1241: every stack this script brings up tears itself down completely, on
 * every way out of the script, and a failed run's evidence survives the
 * teardown. These drive the real script end to end against a throwaway
 * repository copy whose tools are stubs: docker (which only logs what it is
 * asked to do), curl, jq, openssl and pnpm on PATH, a fake Playwright CLI, and
 * a fake scripts/configure.sh -- so nothing real is started, built or removed
 * and nothing needs a daemon. Assertions read the docker log, which is the
 * record of what the run would have done to the host.
 *
 * Needing no real docker, jq or openssl, these belong in the `fast` lane,
 * unlike test-e2e-local-reuse.test.mjs.
 */
const STUBS = {
  docker: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_STUB_LOG"
up_marker="$DOCKER_STUB_LOG.up"
case "$1" in
  info)
    # the WebKit-in-image path asks for the compose plugin's path (#1513)
    [[ "$*" != *--format* ]] || echo "\${DOCKER_STUB_COMPOSE_PLUGIN:-}"
    exit 0 ;;
  context) echo "unix://\${DOCKER_STUB_SOCKET:-}"; exit 0 ;; # the WebKit-in-image path wants a socket (#1513)
  rm) touch "$DOCKER_STUB_LOG.removed"; exit 0 ;;
  inspect)
    if [[ -e "$up_marker" ]]; then
      case "$*" in
        *State.Health.Status*) echo healthy; exit 0 ;;
        *HostPort*) echo 4000; exit 0 ;;
        *config_files*) echo "/stub/docker-compose.yml,/stub/compose/docker-compose.local-e2e.yml"; exit 0 ;;
      esac
    fi
    exit 1 ;;
  ps)
    for a in "$@"; do
      case "$a" in
        label=com.docker.compose.service=*)
          [[ -e "$up_marker" ]] && echo "stub-\${a##*=}"
          exit 0 ;;
      esac
    done
    for a in "$@"; do
      case "$a" in
        label=com.docker.compose.project=*)
          if [[ -n "\${DOCKER_STUB_PREEXISTING_CONTAINER:-}" ]]; then
            echo "$DOCKER_STUB_PREEXISTING_CONTAINER"
          fi
          if [[ -n "\${DOCKER_STUB_LEFTOVER:-}" && -e "$up_marker" && ! -e "$DOCKER_STUB_LOG.removed" ]]; then
            echo "$DOCKER_STUB_LEFTOVER"
          fi
          exit 0 ;;
      esac
    done
    exit 0 ;;
  volume)
    if [[ "$2" == ls && "$*" == *label=com.docker.compose.project=* && -n "\${DOCKER_STUB_PREEXISTING_VOLUME:-}" ]]; then
      echo "$DOCKER_STUB_PREEXISTING_VOLUME"
    fi
    exit 0 ;;
  compose)
    case " $* " in
      *" version "*) exit 0 ;;
      *" config "*) echo '{}'; exit 0 ;;
      *" up "*)
        touch "$up_marker"
        [[ -z "\${DOCKER_STUB_UP_FAIL:-}" ]] || exit 1
        exit 0 ;;
      *" logs "*) echo "stub compose logs for project"; exit 0 ;;
    esac
    exit 0 ;;
esac
exit 0
`,
  curl: `#!/usr/bin/env bash
echo '{"status":"ready","service":"orbit"}'
`,
  jq: `#!/usr/bin/env bash
cat > /dev/null # drain stdin, or the writer dies of SIGPIPE under pipefail
for a in "$@"; do [[ "$a" != --exit-status ]] || exit 0; done
case "$*" in
  *TIKA_URL*) echo http://orbit-tika:9998 ;;
  *APP_URL*) echo "http://127.0.0.1:\${ORBIT_PORT}" ;;
esac
`,
  openssl: `#!/usr/bin/env bash
[[ "$1" != rand ]] || echo 00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff
`,
  pnpm: `#!/usr/bin/env bash
exit 0
`,
};

const ciConfigPath = fileURLToPath(new URL("../.gitlab-ci.yml", import.meta.url));
const checkQuarantine = fileURLToPath(new URL("./check-quarantine.mjs", import.meta.url));
const fixtures = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The script only needs a HEAD to name (`git rev-parse HEAD`), so the one commit
// is empty (Minimal Fixture) and the host's commit gates run on it as they do
// everywhere else: no empty git config, no --no-verify (#1526, the #1523
// pattern). The gates take about ten seconds a commit on a busy host, so the
// repository is made once per file and each fixture gets a copy of its .git.
let gatedGitTemplate;
beforeAll(() => {
  const repo = mkdtempSync(join(tmpdir(), "e2e-local-head-"));
  gatedGitTemplate = join(repo, ".git");
  for (const args of [
    ["init", "--quiet"],
    ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "x"],
  ]) {
    const r = spawnSync("git", args, { cwd: repo, env: process.env, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  }
}, 120_000);
afterAll(() => {
  if (gatedGitTemplate !== undefined) rmSync(dirname(gatedGitTemplate), { recursive: true, force: true });
});

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "e2e-local-teardown-"));
  fixtures.push(dir);
  const bin = join(dir, "stub-bin");
  mkdirSync(bin);
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  for (const sub of ["scripts", "tests/e2e", "node_modules/@playwright/test"]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  copyFileSync(script, join(dir, "scripts/test-e2e-local.sh"));
  writeFileSync(join(dir, "scripts/configure.sh"), "touch .env-orbit\nmkdir -p .orbit-secrets\n");
  writeFileSync(
    join(dir, "scripts/dev-greenmail-cert.sh"),
    "for f in greenmail.p12 greenmail-ca.pem greenmail-key.pem; do touch .orbit-secrets/$f; done\n",
  );
  copyFileSync(checkQuarantine, join(dir, "scripts/check-quarantine.mjs"));
  writeFileSync(join(dir, "tests/quarantine.txt"), "# no quarantined tests\n");
  writeFileSync(join(dir, "scripts/calculate-version.mjs"), 'console.log("0.0.0-test");\n');
  writeFileSync(join(dir, "scripts/install-test-browser.sh"), "exit 0\n");
  writeFileSync(join(dir, ".env-orbit.example"), "");
  writeFileSync(join(dir, "docker-compose.yml"), "services: {}\n");
  writeFileSync(join(dir, "tests/e2e/local-only-specs.txt"), "tests/e2e/a.spec.ts\n");
  copyFileSync(ciConfigPath, join(dir, ".gitlab-ci.yml")); // where the script reads PLAYWRIGHT_IMAGE (#1513)
  writeFileSync(
    join(dir, "node_modules/@playwright/test/cli.js"),
    `const fs = require("fs");
fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/trace.zip", "trace");
if (process.env.FAKE_SUITE_HANG) {
  fs.writeFileSync(process.env.FAKE_SUITE_HANG, "running");
  setInterval(() => {}, 1000);
} else {
  process.exit(Number(process.env.FAKE_SUITE_EXIT || 0));
}
`,
  );
  cpSync(gatedGitTemplate, join(dir, ".git"), { recursive: true });
  const project = `e2e-unit-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const dockerLog = join(dir, "docker.log");
  writeFileSync(dockerLog, "");
  const artifactRoot = join(dir, "artifacts");
  const composePlugin = join(bin, "docker-compose");
  writeFileSync(composePlugin, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(composePlugin, 0o755);
  const socket = join(dir, "docker.sock"); // binding leaves a real socket file behind
  const bound = spawnSync(
    "python3",
    ["-c", "import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])", socket],
    { encoding: "utf8" },
  );
  expect(bound.status, bound.stderr).toBe(0);
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: process.env.HOME,
    DOCKER_STUB_COMPOSE_PLUGIN: composePlugin,
    DOCKER_STUB_SOCKET: socket,
    COMPOSE_PROJECT_NAME: project,
    ORBIT_E2E_ARTIFACT_ROOT: artifactRoot,
    DOCKER_STUB_LOG: dockerLog,
  };
  return { dir, env, project, dockerLog, artifactRoot };
}

const runScript = (fx, args, extraEnv = {}) =>
  spawn("bash", [join(fx.dir, "scripts/test-e2e-local.sh"), ...args], {
    cwd: fx.dir,
    env: { ...fx.env, ...extraEnv },
    detached: true, // its own process group, so a test can signal it the way a terminal does
    stdio: ["ignore", "pipe", "pipe"],
  });

function finish(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const deadline = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      reject(new Error(`killed on a deadline of ${PROCESS_DEADLINE_MS}ms\nstderr: ${stderr}`));
    }, PROCESS_DEADLINE_MS);
    child.on("close", (status, signal) => {
      clearTimeout(deadline);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

const runToEnd = (fx, args, extraEnv) => finish(runScript(fx, args, extraEnv));

async function waitForFile(path) {
  const stop = Date.now() + PROCESS_DEADLINE_MS - 5_000;
  while (!existsSync(path)) {
    if (Date.now() > stop) throw new Error(`${path} never appeared`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const dockerCalls = (fx) =>
  readFileSync(fx.dockerLog, "utf8").split("\n").filter((l) => l.length > 0);
const downCalls = (fx) => dockerCalls(fx).filter((l) => /^compose .* down( |$)/.test(l));
const DOWN_TAIL = "--profile * down --volumes --remove-orphans --rmi local";
const chromium = ["--project", "desktop-chromium"];

/* configure.sh's is_valid_orbit_image, local half (#1275) */
const LOCAL_TAG_CALL = /^image rm orbit-local:[0-9a-f]{12}$/;

describe("teardown removes everything the run created (#1241)", () => {
  it("takes down profile services, volumes, networks and the images it built, on success", async () => {
    const fx = makeFixture();
    const result = await runToEnd(fx, chromium);
    expect(result.status, result.stderr).toBe(0);
    // `--profile '*'` is every profile: orbit-tika (processing) is part of the
    // project whatever COMPOSE_PROFILES says. --volumes and --remove-orphans
    // take the volumes and the stragglers; --rmi local the sidecar images
    // Compose built; networks are project-scoped and go with `down`.
    const downs = downCalls(fx);
    expect(downs).toHaveLength(1);
    expect(downs[0]).toContain(`-p ${fx.project} `);
    expect(downs[0]).toContain(DOWN_TAIL);
    // The application image is this run's own per-run tag, removed by name.
    expect(dockerCalls(fx)).toContainEqual(expect.stringMatching(/^image rm orbit-local:[0-9a-f]{12}$/));
    // Every compose call, teardown included, stays inside this run's project.
    for (const call of dockerCalls(fx).filter((l) => l.startsWith("compose ") && !l.startsWith("compose version"))) {
      expect(call).toContain(`-p ${fx.project} `);
    }
    // A clean run leaves no evidence directory behind.
    expect(existsSync(fx.artifactRoot)).toBe(false);
  });

  it("gives two runs at the same commit different tags (#1241, #1275)", async () => {
    const tags = [];
    for (const _ of [1, 2]) {
      const fx = makeFixture();
      const result = await runToEnd(fx, chromium);
      expect(result.status, result.stderr).toBe(0);
      tags.push(dockerCalls(fx).find((l) => LOCAL_TAG_CALL.test(l)));
    }
    expect(tags[0]).toBeDefined();
    expect(tags[0]).not.toBe(tags[1]);
  });

  it("sweeps up a container of the project that `down` did not remove", async () => {
    const fx = makeFixture();
    const result = await runToEnd(fx, chromium, { DOCKER_STUB_LEFTOVER: "straggler42" });
    expect(result.status, result.stderr).toBe(0);
    expect(dockerCalls(fx)).toContain("rm --force --volumes straggler42");
    expect(result.stderr).toContain("needed more than");
  });

  it("tears down when the suite fails, and keeps the failure's exit status", async () => {
    const fx = makeFixture();
    const result = await runToEnd(fx, chromium, { FAKE_SUITE_EXIT: "3" });
    expect(result.status).toBe(3);
    expect(downCalls(fx)).toHaveLength(1);
  });

  it("tears down when the stack never comes up", async () => {
    const fx = makeFixture();
    const result = await runToEnd(fx, chromium, { DOCKER_STUB_UP_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(downCalls(fx)).toHaveLength(1);
    expect(downCalls(fx)[0]).toContain(DOWN_TAIL);
  });

  it("does not try to tear down a run that stopped before creating anything", async () => {
    const fx = makeFixture();
    const result = await runToEnd(fx, ["--profile", "no-such-profile"]);
    expect(result.status).toBe(2);
    expect(downCalls(fx)).toHaveLength(0);
  });

  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    it(`tears down exactly once when ${signal} interrupts the suite`, async () => {
      const fx = makeFixture();
      const marker = join(fx.dir, "suite-running");
      const child = runScript(fx, chromium, { FAKE_SUITE_HANG: marker });
      const done = finish(child);
      await waitForFile(marker);
      // The whole process group, as Ctrl-C in a terminal does: the suite dies
      // and the script's trap is what is left to run.
      process.kill(-child.pid, signal);
      const result = await done;
      expect(result.status, result.stderr).toBe(code);
      const downs = downCalls(fx);
      expect(downs).toHaveLength(1);
      expect(downs[0]).toContain(DOWN_TAIL);
      expect(dockerCalls(fx)).toContainEqual(expect.stringMatching(/^image rm orbit-local:/));
      // An interrupted run is a failed run: its evidence is kept.
      expect(readdirSync(fx.artifactRoot)).toHaveLength(1);
    });
  }
});

/*
 * A run given an explicit COMPOSE_PROJECT_NAME must not adopt resources it did
 * not create: if any container or volume already carries that project's
 * Compose label (a real install, say), the run refuses before bringing
 * anything up and, having created nothing, tears nothing down.
 */
describe("an explicit COMPOSE_PROJECT_NAME that names existing resources is refused", () => {
  const upCalls = (fx) => dockerCalls(fx).filter((l) => /^compose .* up( |$)/.test(l));

  for (const [label, env] of [
    ["container", { DOCKER_STUB_PREEXISTING_CONTAINER: "realinstall1" }],
    ["volume", { DOCKER_STUB_PREEXISTING_VOLUME: "realinstall_data" }],
  ]) {
    it(`fails before compose up when a ${label} already carries the project label`, async () => {
      const fx = makeFixture();
      const result = await runToEnd(fx, chromium, env);
      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain(fx.project);
      expect(upCalls(fx)).toHaveLength(0);
      expect(downCalls(fx)).toHaveLength(0);
      expect(dockerCalls(fx).filter((l) => l.startsWith("rm ") || l.startsWith("image rm"))).toHaveLength(0);
    });
  }

  it("looks for both containers and volumes by the project label before compose up", async () => {
    const fx = makeFixture();
    const result = await runToEnd(fx, chromium);
    expect(result.status, result.stderr).toBe(0);
    const label = `label=com.docker.compose.project=${fx.project}`;
    const calls = dockerCalls(fx);
    const psAt = calls.findIndex((l) => l.startsWith("ps ") && l.includes("-aq") && l.includes(label));
    const volAt = calls.findIndex((l) => l.startsWith("volume ls") && l.includes("-q") && l.includes(label));
    const upAt = calls.findIndex((l) => /^compose .* up( |$)/.test(l));
    expect(psAt).toBeGreaterThanOrEqual(0);
    expect(volAt).toBeGreaterThanOrEqual(0);
    expect(upAt).toBeGreaterThan(Math.max(psAt, volAt));
  });

  it("does not refuse a --reuse of the same project", async () => {
    const fx = makeFixture();
    writeFileSync(`${fx.dockerLog}.up`, ""); // the stub's stack is already up
    const result = await runToEnd(fx, ["--reuse", fx.project, ...chromium], {
      DOCKER_STUB_PREEXISTING_CONTAINER: "realinstall1",
      DOCKER_STUB_PREEXISTING_VOLUME: "realinstall_data",
    });
    expect(result.status, result.stderr).toBe(0);
  });
});

describe("a failed run keeps its logs and traces (#1241)", () => {
  it("saves compose logs and Playwright's test-results/ before it removes the containers", async () => {
    const fx = makeFixture();
    const result = await runToEnd(fx, chromium, { FAKE_SUITE_EXIT: "1" });
    expect(result.status).toBe(1);
    const saved = readdirSync(fx.artifactRoot);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatch(new RegExp(`^e2e-${fx.project}-\\d{8}-\\d{6}$`));
    const dir = join(fx.artifactRoot, saved[0]);
    expect(readFileSync(join(dir, "compose-logs.txt"), "utf8")).toContain("stub compose logs");
    expect(readFileSync(join(dir, "test-results/trace.zip"), "utf8")).toBe("trace");
    expect(result.stderr).toContain(dir);
    const calls = dockerCalls(fx);
    const logsAt = calls.findIndex((l) => l.includes("--profile * logs --no-color"));
    const downAt = calls.findIndex((l) => l.includes("--profile * down"));
    expect(logsAt).toBeGreaterThanOrEqual(0);
    expect(logsAt).toBeLessThan(downAt);
  });
});

describe("--keep is the only way to leave a stack up (#1241)", () => {
  it("skips teardown and prints the exact command that completes it", async () => {
    const fx = makeFixture();
    const result = await runToEnd(fx, [...chromium, "--keep"]);
    expect(result.status, result.stderr).toBe(0);
    expect(downCalls(fx)).toHaveLength(0);
    expect(result.stderr).toContain("Tear it down completely with:");
    const command = result.stderr.split("\n").find((l) => l.startsWith("  cd "));
    expect(command, result.stderr).toBeDefined();
    expect(command).toContain(`-p ${fx.project}`);
    // Run as printed, it is the teardown: wildcard profile, volumes, orphans,
    // images, then the application image by its per-run tag.
    const printed = spawnSync("bash", ["-c", command], { env: fx.env, encoding: "utf8" });
    expect(printed.status, printed.stderr).toBe(0);
    expect(downCalls(fx)).toHaveLength(1);
    expect(downCalls(fx)[0]).toContain(DOWN_TAIL);
    expect(dockerCalls(fx)).toContainEqual(expect.stringMatching(/^image rm orbit-local:/));
  });
});

describe("--reuse never tears down a stack it did not start (#1241)", () => {
  for (const [label, suiteExit] of [
    ["passes", "0"],
    ["fails", "4"],
  ]) {
    it(`leaves the reused stack alone when the suite ${label}`, async () => {
      const fx = makeFixture();
      writeFileSync(`${fx.dockerLog}.up`, ""); // the stub's stack is already up
      const result = await runToEnd(fx, ["--reuse", fx.project, ...chromium], {
        FAKE_SUITE_EXIT: suiteExit,
      });
      expect(result.status, result.stderr).toBe(Number(suiteExit));
      expect(result.stderr).toContain("not tearing down project");
      const calls = dockerCalls(fx);
      expect(calls.filter((l) => l.includes(" down"))).toHaveLength(0);
      expect(calls.filter((l) => l.startsWith("image rm") || l.startsWith("rm "))).toHaveLength(0);
      // Nothing was started, so there is nothing of this run's to save either.
      expect(existsSync(fx.artifactRoot)).toBe(false);
    });
  }
});

/*
 * ORBIT_E2E_REUSE must not vouch for a database (#1077). It used to be passed
 * to the quarantine run, and it also switched off the guard in
 * tests/e2e/support/database.ts, so a local quarantine run with
 * COMPOSE_PROJECT_NAME=orbit (a real install) would reset that real database.
 * The suite is told which project it owns with ORBIT_E2E_OWNED_PROJECT
 * instead. Driven through the same stubbed fixture as above, with a fake
 * Playwright CLI that records the environment each invocation was given.
 */
describe("the environment the script hands to Playwright (#1077)", () => {
  function recordEnvironment(fx) {
    const log = join(fx.dir, "playwright-env.jsonl");
    writeFileSync(
      join(fx.dir, "node_modules/@playwright/test/cli.js"),
      `require("fs").appendFileSync(process.env.PW_ENV_LOG, JSON.stringify(process.env) + "\\n");\n`,
    );
    return log;
  }

  const runsOf = (log) =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));

  it("never passes ORBIT_E2E_REUSE to the quarantine run of a fresh stack", async () => {
    const fx = makeFixture();
    const log = recordEnvironment(fx);
    const result = await runToEnd(fx, chromium, { PW_ENV_LOG: log });
    expect(result.status, result.stderr).toBe(0);
    const runs = runsOf(log);
    const quarantine = runs.find((env) => env.ORBIT_E2E_QUARANTINE === "only");
    const gate = runs.find((env) => env.ORBIT_E2E_QUARANTINE === "exclude");
    expect(gate, "the gate run did not happen").toBeDefined();
    expect(quarantine, "the quarantine run did not happen").toBeDefined();
    expect(Object.keys(quarantine)).not.toContain("ORBIT_E2E_REUSE");
    expect(Object.keys(gate)).not.toContain("ORBIT_E2E_REUSE");
    // The project is still vouched for, the legitimate way.
    expect(quarantine.ORBIT_E2E_OWNED_PROJECT).toBe(fx.project);
    expect(quarantine.COMPOSE_PROJECT_NAME).toBe(fx.project);
  });

  it("gives every run of a --reuse stack ORBIT_E2E_OWNED_PROJECT=PROJECT", async () => {
    const fx = makeFixture();
    const log = recordEnvironment(fx);
    writeFileSync(`${fx.dockerLog}.up`, ""); // the stub's stack is already up
    const result = await runToEnd(fx, ["--reuse", fx.project, ...chromium], { PW_ENV_LOG: log });
    expect(result.status, result.stderr).toBe(0);
    const runs = runsOf(log);
    expect(runs.map((env) => env.ORBIT_E2E_QUARANTINE).sort()).toEqual(["exclude", "only"]);
    for (const env of runs) {
      expect(env.ORBIT_E2E_OWNED_PROJECT).toBe(fx.project);
      expect(env.COMPOSE_PROJECT_NAME).toBe(fx.project);
    }
  });
});

/*
 * The quarantine list guard: the script runs `node scripts/check-quarantine.mjs`
 * before its gate run, so an unlisted @quarantine tag (which would drop a test
 * from every merge gate) stops a local run too. When the check fails the script
 * exits non-zero and Playwright is never started. Same stubbed fixture; the
 * fixture holds the real check and an empty tests/quarantine.txt, and the fake
 * Playwright CLI records every call.
 */
describe("the quarantine list guard before the gate run", () => {
  function recordCalls(fx) {
    const log = join(fx.dir, "playwright-calls.log");
    writeFileSync(
      join(fx.dir, "node_modules/@playwright/test/cli.js"),
      `require("fs").appendFileSync(process.env.PW_CALL_LOG, "called\\n");\n`,
    );
    return log;
  }

  it("runs Playwright when the list is clean (control)", async () => {
    const fx = makeFixture();
    const log = recordCalls(fx);
    const result = await runToEnd(fx, chromium, { PW_CALL_LOG: log });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(log)).toBe(true);
  });

  it("exits non-zero and never runs Playwright when a tag is not on the list", async () => {
    const fx = makeFixture();
    const log = recordCalls(fx);
    writeFileSync(join(fx.dir, "tests/e2e/x.spec.ts"), 'test("x", { tag: "@quarantine" }, () => {});\n');
    const result = await runToEnd(fx, chromium, { PW_CALL_LOG: log });
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("tests/e2e/x.spec.ts");
    expect(existsSync(log), "Playwright ran despite the failed check").toBe(false);
  });

  it("exits non-zero and never runs Playwright when tests/quarantine.txt is missing", async () => {
    const fx = makeFixture();
    const log = recordCalls(fx);
    rmSync(join(fx.dir, "tests/quarantine.txt"));
    const result = await runToEnd(fx, chromium, { PW_CALL_LOG: log });
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("tests/quarantine.txt");
    expect(existsSync(log), "Playwright ran despite the failed check").toBe(false);
  });
});

/*
 * #1513: WebKit runs inside CI's Playwright image, whose reference the script
 * reads from the PLAYWRIGHT_IMAGE line of .gitlab-ci.yml. That line is
 * `$CI_IMAGE_CACHE_MCR/playwright:<tag>@sha256:<digest>`, and the variable is
 * set only on CI runners, so a local run has to expand it itself: to the
 * variable's value when set, else to the public registry. The expected images
 * are derived from the real line (the fixture carries a copy), so a digest
 * bump does not break these. Cache hosts are made-up `.invalid` names.
 */
const ciImageTemplate = readFileSync(ciConfigPath, "utf8").match(/^\s*PLAYWRIGHT_IMAGE:\s*(\S+)\s*$/m)?.[1];
const expandImage = (host) => ciImageTemplate.replace("$CI_IMAGE_CACHE_MCR", host);
const webkit = ["--project", "desktop-webkit"];

describe("the Playwright image docker run receives (#1513)", () => {
  async function imagesDockerSaw(extraEnv) {
    const fx = makeFixture();
    writeFileSync(`${fx.dockerLog}.up`, ""); // the stub's stack is already up
    const result = await runToEnd(
      fx,
      ["--reuse", fx.project, "--spec", "tests/e2e/x.spec.ts", ...webkit],
      extraEnv,
    );
    expect(result.status, result.stderr).toBe(0);
    const runs = dockerCalls(fx).filter((l) => /^run /.test(l));
    expect(runs, "WebKit did not run through docker run").not.toHaveLength(0);
    const images = dockerCalls(fx)
      .flatMap((l) => l.split(/\s+/))
      .filter((token) => token.includes("playwright:"));
    return { runs, images };
  }

  it("has the shape the specification assumes (control)", () => {
    expect(ciImageTemplate, "no PLAYWRIGHT_IMAGE line in .gitlab-ci.yml").toBeDefined();
    expect(ciImageTemplate).toMatch(/^\$CI_IMAGE_CACHE_MCR\/playwright:\S+@sha256:[0-9a-f]{64}$/);
  });

  it("expands $CI_IMAGE_CACHE_MCR to its value when the variable is set", async () => {
    const host = "cache.example.invalid/mcr";
    const { images } = await imagesDockerSaw({ CI_IMAGE_CACHE_MCR: host });
    expect(images).not.toHaveLength(0);
    for (const image of images) expect(image).toBe(expandImage(host));
    // The tag and digest come from the pipeline's line, never spelled here
    // (#1536 L-Q1, T-Q33): only their shape and the host prefix are asserted.
    const pin = ciImageTemplate.slice(ciImageTemplate.indexOf("/playwright:") + 1);
    expect(pin).toMatch(/^playwright:v\d+\.\d+\.\d+-\S+@sha256:[0-9a-f]{64}$/);
  });

  for (const [label, env] of [
    ["unset", {}],
    ["empty", { CI_IMAGE_CACHE_MCR: "" }],
  ]) {
    it(`uses the public image, same digest, when the variable is ${label}`, async () => {
      const { images } = await imagesDockerSaw(env);
      expect(images).not.toHaveLength(0);
      for (const image of images) expect(image).toBe(expandImage("mcr.microsoft.com"));
    });
  }

  for (const [label, env] of [
    ["set", { CI_IMAGE_CACHE_MCR: "cache.example.invalid/mcr" }],
    ["unset", {}],
  ]) {
    it(`never hands docker a literal $ in the image, variable ${label}`, async () => {
      const { images } = await imagesDockerSaw(env);
      expect(images).not.toHaveLength(0);
      for (const image of images) expect(image).not.toContain("$");
    });
  }
});

/*
 * #1513: everything after `--` goes to the Playwright command line unchanged,
 * after the script's own Playwright arguments, for WebKit (inside the image,
 * so seen as the end of the logged `docker run`) and for other projects (on
 * the host, so seen in the fake CLI's argv) alike.
 */
describe("arguments after -- reach Playwright (#1513)", () => {
  const passThrough = ["--repeat-each=10", "--workers=1"];
  const tail = passThrough.join(" ");

  function recordArgv(fx) {
    const log = join(fx.dir, "playwright-argv.jsonl");
    writeFileSync(
      join(fx.dir, "node_modules/@playwright/test/cli.js"),
      `require("fs").appendFileSync(process.env.PW_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
    );
    return log;
  }
  const argvRuns = (log) =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));

  async function hostRun(extraArgs) {
    const fx = makeFixture();
    const log = recordArgv(fx);
    writeFileSync(`${fx.dockerLog}.up`, "");
    const args = ["--reuse", fx.project, "--spec", "tests/e2e/x.spec.ts", ...chromium, ...extraArgs];
    const result = await runToEnd(fx, args, { PW_ARGV_LOG: log });
    expect(result.status, result.stderr).toBe(0);
    return argvRuns(log);
  }

  async function webkitDockerRun(extraArgs) {
    const fx = makeFixture();
    writeFileSync(`${fx.dockerLog}.up`, "");
    const args = ["--reuse", fx.project, "--spec", "tests/e2e/x.spec.ts", ...webkit, ...extraArgs];
    const result = await runToEnd(fx, args);
    expect(result.status, result.stderr).toBe(0);
    return dockerCalls(fx).filter((l) => /^run /.test(l));
  }

  it("appends them to a WebKit run's command inside the image", async () => {
    const runs = await webkitDockerRun(["--", ...passThrough]);
    expect(runs).not.toHaveLength(0);
    for (const line of runs) {
      // tolerate the command being wrapped in a closing quote
      expect(line).toMatch(new RegExp(`${tail}['"]?$`));
      // after the script's own Playwright arguments, not before them
      expect(line.indexOf("--project=desktop-webkit")).toBeGreaterThanOrEqual(0);
      expect(line.indexOf("--project=desktop-webkit")).toBeLessThan(line.indexOf("--repeat-each=10"));
      expect(line.indexOf("tests/e2e/x.spec.ts")).toBeLessThan(line.indexOf("--repeat-each=10"));
    }
  });

  it("adds nothing to a WebKit run when there is no --", async () => {
    const runs = await webkitDockerRun([]);
    expect(runs).not.toHaveLength(0);
    for (const line of runs) expect(line).not.toContain("--repeat-each");
  });

  it("appends them to the host Playwright command of a non-WebKit run", async () => {
    const baseline = await hostRun([]);
    const withExtras = await hostRun(["--", ...passThrough]);
    expect(baseline.length).toBeGreaterThan(0);
    expect(withExtras).toHaveLength(baseline.length);
    withExtras.forEach((argv, i) => {
      expect(argv.slice(-passThrough.length)).toEqual(passThrough);
      // the script's own arguments are untouched and come first
      expect(argv.slice(0, -passThrough.length)).toEqual(baseline[i]);
    });
  });

  it("adds nothing to a non-WebKit run when there is no --", async () => {
    for (const argv of await hostRun([])) {
      expect(argv.join(" ")).not.toContain("--repeat-each");
    }
  });

  it("passes the arguments after -- unchanged, whatever they look like", async () => {
    const odd = ["--grep", "a b", "--reporter=line", "-x"];
    const baseline = await hostRun([]);
    const withExtras = await hostRun(["--", ...odd]);
    withExtras.forEach((argv, i) => {
      expect(argv).toEqual([...baseline[i], ...odd]);
    });
  });

  it("still refuses an unknown option before the --", () => {
    const result = dryRunArgsRaw(["--no-such-option", "--", ...passThrough]);
    expect(result.status).toBe(2);
  });
});

/*
 * #1555: a git worktree's node_modules is a symlink to the main checkout's
 * (#784/#876). WebKit runs inside the Playwright image, which mounts only the
 * checkout it was started from, so inside the container that symlink points at
 * a path that does not exist and Playwright's cli.js cannot be found. When the
 * worktree uses the shared install, the WebKit `docker run` must also mount
 * the main checkout's node_modules and web/node_modules, read-only, at their
 * own absolute paths. A main-checkout run, and a worktree that owns a real
 * node_modules, have nothing dangling and mount nothing extra.
 *
 * The fixture is a real `git worktree` of the throwaway repository copy, so the
 * script's own worktree detection runs unmodified. Nothing here starts a real
 * container: docker is the logging stub.
 */
describe("the WebKit docker run in a worktree with the shared node_modules (#1555)", () => {
  const PROJECT_LOCK = "lockfileVersion: '9.0'\n";

  /** A main-checkout fixture, plus (optionally) a worktree of it laid out the supported way. */
  function makeWorktreeFixture({ shared = true } = {}) {
    const fx = makeFixture();
    const mainDir = realpathSync(fx.dir);
    // The dependency check compares the branch's lockfile to pnpm's record in the main install.
    writeFileSync(join(mainDir, "pnpm-lock.yaml"), PROJECT_LOCK);
    mkdirSync(join(mainDir, "node_modules/.pnpm"), { recursive: true });
    writeFileSync(join(mainDir, "node_modules/.pnpm/lock.yaml"), PROJECT_LOCK);
    mkdirSync(join(mainDir, "web/node_modules"), { recursive: true });
    const git = (args, cwd) => {
      const r = spawnSync("git", args, {
        cwd,
        env: process.env,
        encoding: "utf8",
      });
      expect(r.status, r.stderr).toBe(0);
    };
    // The whole fixture, not just the lockfile: since #1526 makeFixture
    // starts from an empty gated commit, so the worktree only holds what
    // this commit adds. Committed through the host's gates, as #1526 asks.
    git(["add", "-A"], mainDir);
    git(
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "lock",
      ],
      mainDir,
    );
    const parent = mkdtempSync(join(tmpdir(), "e2e-local-worktree-"));
    fixtures.push(parent);
    const worktree = join(realpathSync(parent), "wt");
    git(["worktree", "add", "--quiet", "-b", "wt-branch", worktree], mainDir);
    if (shared) {
      rmSync(join(worktree, "node_modules"), { recursive: true, force: true });
      symlinkSync(
        join(mainDir, "node_modules"),
        join(worktree, "node_modules"),
      );
      mkdirSync(join(worktree, "web"), { recursive: true });
      symlinkSync(
        join(mainDir, "web/node_modules"),
        join(worktree, "web/node_modules"),
      );
    }
    return { ...fx, dir: worktree, mainDir };
  }

  /** Every bind mount a logged `docker run` asked for, as { src, dst, ro }. */
  function mountsOf(line) {
    const tokens = line.split(/\s+/);
    const mounts = [];
    tokens.forEach((token, i) => {
      const next = tokens[i + 1] ?? "";
      if (token === "-v" || token === "--volume") {
        const [src, dst, mode = ""] = next.split(":");
        mounts.push({ src, dst, ro: mode.split(",").includes("ro") });
      } else if (token === "--mount") {
        const parts = Object.fromEntries(
          next.split(",").map((kv) => kv.split("=")),
        );
        mounts.push({
          src: parts.source ?? parts.src,
          dst: parts.target ?? parts.destination ?? parts.dst,
          ro: "readonly" in parts || "ro" in parts,
        });
      }
    });
    return mounts;
  }

  async function webkitRuns(fx) {
    writeFileSync(`${fx.dockerLog}.up`, ""); // the stub's stack is already up
    const result = await runToEnd(fx, [
      "--reuse",
      fx.project,
      "--spec",
      "tests/e2e/x.spec.ts",
      ...webkit,
    ]);
    expect(result.status, result.stderr).toBe(0);
    const runs = dockerCalls(fx).filter((l) => /^run /.test(l));
    expect(runs, "WebKit did not run through docker run").not.toHaveLength(0);
    return runs;
  }

  it("is set up the way the script's worktree detection expects (control)", () => {
    const fx = makeWorktreeFixture();
    expect(readlinkSync(join(fx.dir, "node_modules"))).toBe(
      join(fx.mainDir, "node_modules"),
    );
    expect(readlinkSync(join(fx.dir, "web/node_modules"))).toBe(
      join(fx.mainDir, "web/node_modules"),
    );
    expect(fx.dir).not.toBe(fx.mainDir);
  });

  it("still mounts the worktree itself at its own path (control)", async () => {
    const fx = makeWorktreeFixture();
    for (const run of await webkitRuns(fx)) {
      expect(mountsOf(run)).toContainEqual(
        expect.objectContaining({ src: fx.dir, dst: fx.dir }),
      );
    }
  });

  for (const sub of ["node_modules", "web/node_modules"]) {
    it(`mounts the main checkout's ${sub} read-only at its own absolute path`, async () => {
      const fx = makeWorktreeFixture();
      const path = join(fx.mainDir, sub);
      for (const run of await webkitRuns(fx)) {
        expect(mountsOf(run)).toContainEqual({
          src: path,
          dst: path,
          ro: true,
        });
      }
    });
  }

  it("mounts each of them exactly once", async () => {
    const fx = makeWorktreeFixture();
    for (const run of await webkitRuns(fx)) {
      for (const sub of ["node_modules", "web/node_modules"]) {
        const path = join(fx.mainDir, sub);
        expect(mountsOf(run).filter((m) => m.dst === path)).toHaveLength(1);
      }
    }
  });

  it("adds no mount of a dependency directory in the main checkout's run", async () => {
    const fx = makeFixture();
    for (const run of await webkitRuns(fx)) {
      const mounts = mountsOf(run);
      expect(mounts).toContainEqual(
        expect.objectContaining({ src: fx.dir, dst: fx.dir }),
      );
      for (const m of mounts) {
        expect(m.src, run).not.toContain("node_modules");
        expect(m.dst, run).not.toContain("node_modules");
      }
    }
  });

  it("adds no mount when the worktree has a node_modules of its own", async () => {
    const fx = makeWorktreeFixture({ shared: false });
    expect(lstatSync(join(fx.dir, "node_modules")).isSymbolicLink()).toBe(
      false,
    );
    for (const run of await webkitRuns(fx)) {
      for (const m of mountsOf(run)) {
        expect(m.src, run).not.toContain("node_modules");
        expect(m.dst, run).not.toContain("node_modules");
      }
    }
  });

  it("runs a non-WebKit project from the worktree on the host, with no docker run (control)", async () => {
    const fx = makeWorktreeFixture();
    writeFileSync(`${fx.dockerLog}.up`, "");
    const result = await runToEnd(fx, [
      "--reuse",
      fx.project,
      "--spec",
      "tests/e2e/x.spec.ts",
      ...chromium,
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(dockerCalls(fx).filter((l) => /^run /.test(l))).toHaveLength(0);
  });
});
