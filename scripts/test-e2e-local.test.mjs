import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
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
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
      *" down "*)
        if [[ -n "\${DOCKER_STUB_DOWN_FAIL:-}" ]]; then
          echo "stub-compose-down-error: network has active endpoints" >&2
          exit 1
        fi
        exit 0 ;;
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
  // The script asks `ss -H -ltn 'sport = :4443'` whether 127.0.0.1:4443 is held
  // (#1445, #1622): any output means held. The stub answers from SS_STUB_HELD
  // alone, never from the real host, so what else runs here cannot matter.
  ss: `#!/usr/bin/env bash
if [[ -n "\${SS_STUB_HELD:-}" && "$*" == *:4443* ]]; then
  echo 'LISTEN 0 511 127.0.0.1:4443 0.0.0.0:* users:(("held-by-stub",pid=4242,fd=3))'
fi
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
  writeFileSync(
    join(dir, "scripts/dev-dkim-test-key.sh"),
    "for f in dkim-test-key.pem dkim-test-record.txt; do touch .orbit-secrets/$f; done\n",
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
  // Node itself, as the tests already run on it (L-Q2). The child exits without
  // closing the server, so the socket file stays; bound by a relative name from
  // `dir`, so a long temp path cannot overflow the socket-address limit.
  const bound = spawnSync(
    process.execPath,
    ["-e", 'require("net").createServer().listen("docker.sock", () => process.exit(0))'],
    { cwd: dir, encoding: "utf8" },
  );
  expect(bound.status, bound.stderr).toBe(0);
  expect(lstatSync(socket).isSocket(), "the fixture left a real socket file").toBe(true);
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
 * The quarantine run (agent-infra#30) after a passing gate. CI caps it:
 * `timeout -k 30s 8m bash scripts/test-frontend.sh --quarantine` in
 * .gitlab-ci.yml. A local run had no cap, so one hung quarantined test held
 * the whole local run (and its stack) indefinitely. These tests put a stub
 * `timeout` first on PATH, which logs what it was asked to cap and, on request,
 * reports that the command ran out of time (exit 124, as coreutils does),
 * so nothing waits eight real minutes.
 */
describe("the quarantine run has a time cap, as in CI", () => {
  const ciCap = (() => {
    const line = readFileSync(ciConfigPath, "utf8")
      .split("\n")
      .find((l) => /\btimeout\b.*test-frontend\.sh --quarantine/.test(l));
    const m = line?.match(/\btimeout\s+(?:-k\s+\S+\s+)?(\d+)([smh]?)\s/);
    const factor = { "": 1, s: 1, m: 60, h: 3600 }[m?.[2] ?? ""];
    return { token: m ? `${m[1]}${m[2]}` : undefined, amount: Number(m?.[1]), unit: m?.[2], seconds: Number(m?.[1]) * factor };
  })();

  const toSeconds = (token) => {
    const m = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(token ?? "");
    return m ? Number(m[1]) * { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]] : NaN;
  };

  function stubTimeout(fx) {
    const log = join(fx.dir, "timeout-calls.log");
    const stub = join(fx.dir, "stub-bin/timeout");
    writeFileSync(
      stub,
      `#!/usr/bin/env bash
echo "$*" >> "${log}"
while [[ "\${1:-}" == -* ]]; do
  case "$1" in -k | -s | --kill-after | --signal) shift 2 ;; *) shift ;; esac
done
shift # the duration
if [[ -n "\${TIMEOUT_STUB_EXPIRE:-}" ]]; then
  for arg in "$@"; do [[ "$arg" != --pass-with-no-tests ]] || exit 124; done
fi
exec "$@"
`,
    );
    chmodSync(stub, 0o755);
    return log;
  }

  /** The duration a logged `timeout ...` call was given: the first non-option word. */
  function durationOf(call) {
    const words = call.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      if (/^(-k|-s|--kill-after|--signal)$/.test(words[i])) i++;
      else if (!words[i].startsWith("-")) return words[i];
    }
    return undefined;
  }

  const quarantineCalls = (log) =>
    (existsSync(log) ? readFileSync(log, "utf8") : "")
      .split("\n")
      .filter((l) => l.includes("--pass-with-no-tests"));

  it("reads CI's cap from .gitlab-ci.yml (control)", () => {
    expect(ciCap.token, "no capped quarantine line in .gitlab-ci.yml").toBeDefined();
    expect(ciCap.seconds).toBeGreaterThan(0);
  });

  it("runs the quarantined tests under a timeout equal to CI's", async () => {
    const fx = makeFixture();
    const log = stubTimeout(fx);
    const result = await runToEnd(fx, chromium);
    expect(result.status, result.stderr).toBe(0);
    const calls = quarantineCalls(log);
    expect(calls, "the quarantine run was not run under `timeout`").toHaveLength(1);
    expect(toSeconds(durationOf(calls[0])), calls[0]).toBe(ciCap.seconds);
  });

  it("stops a quarantine run past the cap, names the cap, and still does not fail the run", async () => {
    const fx = makeFixture();
    stubTimeout(fx);
    const result = await runToEnd(fx, chromium, { TIMEOUT_STUB_EXPIRE: "1" });
    expect(result.status, result.stderr).toBe(0);
    const unit = { "": "s|secs?|seconds?", s: "s|secs?|seconds?", m: "m|mins?|minutes?", h: "h|hours?" }[ciCap.unit];
    const named = new RegExp(`\\b${ciCap.amount} ?(${unit})\\b`);
    expect(result.stderr + result.stdout).toMatch(named);
  });
});

/*
 * test-frontend.sh gives the quarantine run its own HTML report folder
 * (PLAYWRIGHT_HTML_OUTPUT_DIR). The local script set none, so every local run
 * wrote the report to Playwright's default folder, which another run in the
 * same checkout, or the quarantine run after the gate, then cleared.
 */
describe("each run has its own Playwright HTML report folder", () => {
  function recordReportFolders(fx) {
    const log = join(fx.dir, "report-folders.jsonl");
    writeFileSync(
      join(fx.dir, "node_modules/@playwright/test/cli.js"),
      `require("fs").appendFileSync(process.env.PW_ENV_LOG, JSON.stringify({ mode: process.env.ORBIT_E2E_QUARANTINE, dir: process.env.PLAYWRIGHT_HTML_OUTPUT_DIR }) + "\\n");\n`,
    );
    return log;
  }

  const foldersOf = (fx, log) =>
    Object.fromEntries(
      readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l))
        .map(({ mode, dir }) => [mode, dir === undefined || dir === "" ? dir : resolve(fx.dir, dir)]),
    );

  it("sets PLAYWRIGHT_HTML_OUTPUT_DIR for the gate and the quarantine run, away from the default folder", async () => {
    const fx = makeFixture();
    const log = recordReportFolders(fx);
    const result = await runToEnd(fx, chromium, { PW_ENV_LOG: log });
    expect(result.status, result.stderr).toBe(0);
    const folders = foldersOf(fx, log);
    expect(Object.keys(folders).sort()).toEqual(["exclude", "only"]);
    for (const [mode, dir] of Object.entries(folders)) {
      expect(dir, `${mode} run: PLAYWRIGHT_HTML_OUTPUT_DIR is unset`).toBeTruthy();
      expect(dir, `${mode} run: the report would land in Playwright's default folder`).not.toBe(
        join(fx.dir, "playwright-report"),
      );
    }
  });

  it("uses a different folder for each run", async () => {
    const fx = makeFixture();
    const log = recordReportFolders(fx);
    const first = await runToEnd(fx, chromium, { PW_ENV_LOG: log });
    expect(first.status, first.stderr).toBe(0);
    const firstFolders = foldersOf(fx, log);
    rmSync(log);
    const second = await runToEnd(fx, chromium, {
      PW_ENV_LOG: log,
      COMPOSE_PROJECT_NAME: `${fx.project}-again`,
    });
    expect(second.status, second.stderr).toBe(0);
    const secondFolders = foldersOf(fx, log);
    expect(firstFolders.exclude, "the first run set no report folder").toBeTruthy();
    expect(secondFolders.exclude, "the second run set no report folder").toBeTruthy();
    expect(secondFolders.exclude).not.toBe(firstFolders.exclude);
  });

  it("keeps the quarantine run's report out of the gate's folder", async () => {
    const fx = makeFixture();
    const log = recordReportFolders(fx);
    const result = await runToEnd(fx, chromium, { PW_ENV_LOG: log });
    expect(result.status, result.stderr).toBe(0);
    const folders = foldersOf(fx, log);
    expect(folders.exclude, "the gate run set no report folder").toBeTruthy();
    expect(folders.only, "the quarantine run set no report folder").toBeTruthy();
    expect(folders.only).not.toBe(folders.exclude);
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

  /*
   * test-backend.sh and test-e2e-local.sh each decide whether the checkout can
   * use pnpm or must go around it, from how node_modules and web/node_modules
   * are laid out (a real directory or a symlink into the main checkout), and
   * they decided differently when the root one is a real directory and web's
   * is a symlink: test-backend went direct, test-e2e-local ran pnpm install.
   * The same layout must get the same decision from both. The decision is
   * whether the script ran pnpm (test-backend: any pnpm call; test-e2e-local:
   * pnpm install), observed through a stub pnpm that logs its calls.
   */
  describe("test-backend.sh and test-e2e-local.sh decide alike about node_modules layouts", () => {
    const layouts = [
      { name: "root real, web symlinked", rootLink: false, webLink: true },
      { name: "root symlinked, web real", rootLink: true, webLink: false },
      { name: "both real", rootLink: false, webLink: false },
      { name: "both symlinked", rootLink: true, webLink: true },
    ];
    const backendScript = fileURLToPath(new URL("./test-backend.sh", import.meta.url));
    const LOGGING_PNPM = '#!/bin/sh\necho "$*" >> "$PNPM_LOG"\nexit 0\n';

    /** test-backend.sh in a throwaway repository laid out as asked: did it call pnpm at all? */
    function backendUsesPnpm({ rootLink, webLink }) {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "backend-layout-")));
      fixtures.push(root);
      const repo = join(root, "repo");
      const stubs = join(root, "stubs");
      const log = join(root, "pnpm.log");
      mkdirSync(join(repo, "scripts"), { recursive: true });
      mkdirSync(join(repo, "web"), { recursive: true });
      mkdirSync(stubs);
      copyFileSync(backendScript, join(repo, "scripts/test-backend.sh"));
      writeFileSync(join(repo, "pnpm-lock.yaml"), "");
      for (const args of [
        ["init", "--quiet"],
        ["add", "pnpm-lock.yaml"],
        ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--quiet", "--no-verify", "-m", "init"],
      ]) {
        const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
        expect(r.status, r.stderr).toBe(0);
      }
      writeFileSync(join(stubs, "node"), "#!/bin/sh\nexit 0\n");
      writeFileSync(join(stubs, "pnpm"), LOGGING_PNPM);
      chmodSync(join(stubs, "node"), 0o755);
      chmodSync(join(stubs, "pnpm"), 0o755);
      for (const [rel, link] of [["node_modules", rootLink], ["web/node_modules", webLink]]) {
        const target = link ? join(root, "shared", rel) : join(repo, rel);
        mkdirSync(target, { recursive: true });
        if (link) symlinkSync(target, join(repo, rel));
      }
      const r = failOnProcessDeadline(
        spawnSync("bash", [join(repo, "scripts/test-backend.sh")], {
          cwd: repo,
          encoding: "utf8",
          env: { PATH: stubs + ":/usr/bin:/bin", HOME: process.env.HOME, PNPM_LOG: log },
          ...processGuard(),
        }),
        { label: "test-backend.sh layout" },
      );
      expect(r.status, r.stderr).toBe(0);
      return existsSync(log);
    }

    /** test-e2e-local.sh in a worktree fixture laid out as asked: did it run pnpm install? */
    async function e2eUsesPnpm({ rootLink, webLink }) {
      const fx = makeWorktreeFixture({ shared: false });
      const pnpmStub = join(fx.mainDir, "stub-bin/pnpm");
      writeFileSync(pnpmStub, LOGGING_PNPM);
      chmodSync(pnpmStub, 0o755);
      const log = join(fx.dir, "pnpm.log");
      const node = join(fx.dir, "node_modules");
      const web = join(fx.dir, "web/node_modules");
      if (rootLink) {
        rmSync(node, { recursive: true, force: true });
        symlinkSync(join(fx.mainDir, "node_modules"), node);
      }
      mkdirSync(join(fx.dir, "web"), { recursive: true });
      rmSync(web, { recursive: true, force: true });
      if (webLink) symlinkSync(join(fx.mainDir, "web/node_modules"), web);
      else mkdirSync(web);
      expect(lstatSync(node).isSymbolicLink()).toBe(rootLink);
      expect(lstatSync(web).isSymbolicLink()).toBe(webLink);
      writeFileSync(fx.dockerLog + ".up", ""); // the stub's stack is already up
      const result = await runToEnd(fx, ["--reuse", fx.project, "--spec", "tests/e2e/x.spec.ts", ...chromium], {
        PNPM_LOG: log,
      });
      // Going direct on a root node_modules that is a real directory ends in
      // the dependency step's own refusal (no shared install to run against);
      // that still counts as "did not run pnpm install". Anything else
      // failing is a broken fixture, not a decision.
      if (result.status !== 0) expect(result.stderr).toContain("refusing: this worktree has no usable dependencies");
      return existsSync(log) && readFileSync(log, "utf8").split("\n").some((l) => /^install\b/.test(l));
    }

    for (const layout of layouts) {
      it(layout.name + ": both scripts make the same decision", async () => {
        const backend = backendUsesPnpm(layout);
        const e2e = await e2eUsesPnpm(layout);
        expect(
          e2e,
          "test-backend.sh " + (backend ? "uses pnpm" : "goes direct") + ", test-e2e-local.sh " + (e2e ? "runs pnpm install" : "goes direct"),
        ).toBe(backend);
      });
    }
  });
});

/*
 * #1423: the EXIT trap used to send `compose down`'s output, errors included,
 * to /dev/null, so a teardown that failed said only that it "needed more
 * than compose down". Its error text must reach the person running the script.
 */
describe("a failed `compose down` in the exit trap is visible (#1423)", () => {
  it("shows the error text `compose down` printed", async () => {
    const fx = makeFixture();
    const result = await runToEnd(fx, chromium, { DOCKER_STUB_DOWN_FAIL: "1" });
    expect(downCalls(fx)).toHaveLength(1);
    expect(result.stderr + result.stdout).toContain("stub-compose-down-error: network has active endpoints");
  });

  it("shows nothing of the kind when `compose down` succeeds", async () => {
    const fx = makeFixture();
    const result = await runToEnd(fx, chromium);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr + result.stdout).not.toContain("stub-compose-down-error");
  });
});

/*
 * #1445: the WebKit run forwards 127.0.0.1:4443 to the sign-in provider's
 * random host port (CI's issuer URL is fixed at https://orbit-oidc:4443/). If
 * something already holds 4443 (the test bed used to), the forward's claim
 * failed late and obscurely. The script now checks first, and stops with a
 * message naming the port.
 *
 * #1622: the tests never look at the real host's port. The fixture puts a stub
 * `ss` on PATH (see STUBS) that reports 4443 as held only when the test sets
 * SS_STUB_HELD, so a real WebKit run holding 4443 on this host changes nothing.
 */
describe("the WebKit run checks port 4443 before forwarding it (#1445)", () => {
  const webkitSpec = ["--spec", "tests/e2e/x.spec.ts", ...webkit];
  const dockerRuns = (fx) => dockerCalls(fx).filter((l) => /^run /.test(l));
  const held = { SS_STUB_HELD: "1" };

  it("stops with a non-zero exit and a message naming 4443 when the port is taken, and starts no WebKit container", async () => {
    const fx = makeFixture();
    writeFileSync(`${fx.dockerLog}.up`, ""); // the stub's stack is already up
    const result = await runToEnd(fx, ["--reuse", fx.project, ...webkitSpec], held);
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    expect(result.stderr).toContain("4443");
    expect(dockerRuns(fx)).toEqual([]);
  });

  it("stops the same way for a run that starts its own stack, and still tears that stack down", async () => {
    const fx = makeFixture();
    const result = await runToEnd(fx, webkitSpec, held);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("4443");
    expect(dockerRuns(fx)).toEqual([]);
    expect(downCalls(fx)).toHaveLength(1);
  });

  it("runs the WebKit container as before when 4443 is free", async () => {
    const fx = makeFixture();
    writeFileSync(`${fx.dockerLog}.up`, ""); // the stub's stack is already up
    const result = await runToEnd(fx, ["--reuse", fx.project, ...webkitSpec]);
    expect(result.status, result.stderr).toBe(0);
    expect(dockerRuns(fx)).not.toHaveLength(0);
  });

  it("does not mind 4443 being taken for a run with no WebKit forward", async () => {
    const fx = makeFixture();
    const result = await runToEnd(fx, chromium, held);
    expect(result.status, result.stderr).toBe(0);
  });
});

/*
 * #1622: with a real process holding 127.0.0.1:4443, the WebKit-path cases
 * that have nothing to do with ports (#1513: image name, arguments after `--`)
 * run exactly as they do with the port free. This holds the port itself when it
 * can; if another process already holds it (a real WebKit run on this shared
 * host), that is the very condition under test and the block carries on. It
 * only ever closes a listener it opened itself.
 */
describe("WebKit-path cases pass while a real process holds 127.0.0.1:4443 (#1622)", () => {
  let ours;
  beforeAll(async () => {
    ours = await new Promise((resolveHold) => {
      const server = createServer((socket) => socket.destroy());
      server.once("error", () => resolveHold(undefined)); // held by someone else: carry on
      server.listen(4443, "127.0.0.1", () => resolveHold(server));
    });
  });
  afterAll(async () => {
    if (ours) await new Promise((resolveClose) => ours.close(resolveClose));
  });

  const webkitRun = async (extraArgs, extraEnv) => {
    const fx = makeFixture();
    writeFileSync(`${fx.dockerLog}.up`, ""); // the stub's stack is already up
    const result = await runToEnd(
      fx,
      ["--reuse", fx.project, "--spec", "tests/e2e/x.spec.ts", ...webkit, ...extraArgs],
      extraEnv,
    );
    return { result, runs: dockerCalls(fx).filter((l) => /^run /.test(l)), calls: dockerCalls(fx) };
  };

  it("hands docker the public Playwright image when the cache variable is unset", async () => {
    const { result, runs, calls } = await webkitRun([], {});
    expect(result.status, result.stderr).toBe(0);
    expect(runs).not.toHaveLength(0);
    const images = calls.flatMap((l) => l.split(/\s+/)).filter((t) => t.includes("playwright:"));
    expect(images).not.toHaveLength(0);
    for (const image of images) expect(image).toBe(expandImage("mcr.microsoft.com"));
  });

  it("hands docker the cache host's Playwright image when the variable is set", async () => {
    const host = "cache.example.invalid/mcr";
    const { result, calls } = await webkitRun([], { CI_IMAGE_CACHE_MCR: host });
    expect(result.status, result.stderr).toBe(0);
    const images = calls.flatMap((l) => l.split(/\s+/)).filter((t) => t.includes("playwright:"));
    expect(images).not.toHaveLength(0);
    for (const image of images) expect(image).toBe(expandImage(host));
  });

  it("appends arguments after -- to the command inside the image", async () => {
    const { result, runs } = await webkitRun(["--", "--repeat-each=10", "--workers=1"], {});
    expect(result.status, result.stderr).toBe(0);
    expect(runs).not.toHaveLength(0);
    for (const line of runs) expect(line).toMatch(/--repeat-each=10 --workers=1['"]?$/);
  });

  it("adds nothing to the command inside the image when there is no --", async () => {
    const { result, runs } = await webkitRun([], {});
    expect(result.status, result.stderr).toBe(0);
    expect(runs).not.toHaveLength(0);
    for (const line of runs) expect(line).not.toContain("--repeat-each");
  });
});

/*
 * #1670 G-L5, G-L6, L-F2: report-folder housekeeping, the quarantine run's
 * leftover containers, and the report pointer after a failed gate.
 */
describe("report folders and quarantine leftovers (#1670)", () => {
  /** A fake Playwright that writes a report into the folder it was given, then exits FAKE_SUITE_EXIT. */
  function reportingCli(fx) {
    writeFileSync(
      join(fx.dir, "node_modules/@playwright/test/cli.js"),
      `const fs = require("fs");
if (process.env.PLAYWRIGHT_HTML_OUTPUT_DIR) fs.mkdirSync(process.env.PLAYWRIGHT_HTML_OUTPUT_DIR, { recursive: true });
process.exit(Number(process.env.FAKE_SUITE_EXIT || 0));
`,
    );
  }

  it("keeps only the newest 10 e2e-local-* report folders (G-L5)", async () => {
    const fx = makeFixture();
    reportingCli(fx);
    const root = join(fx.dir, "playwright-report");
    const old = [];
    for (let i = 1; i <= 14; i++) {
      const dir = join(root, `e2e-local-20200101T0000${String(i).padStart(2, "0")}-${i}`);
      mkdirSync(dir, { recursive: true });
      const when = new Date(Date.UTC(2020, 0, 1, 0, 0, i));
      utimesSync(dir, when, when);
      old.push(dir);
    }
    const result = await runToEnd(fx, chromium);
    expect(result.status, result.stderr).toBe(0);
    // The prune runs before the new run's folder exists, so of the 14 earlier
    // folders exactly the newest 10 stay (old[4]..old[13]) and old[0]..old[3] go.
    expect(old.filter((dir) => existsSync(dir))).toEqual(old.slice(4));
  });

  it("carries on when playwright-report/ exists but holds no e2e-local-* folder (G-L5)", async () => {
    for (const entries of [[], ["index.html", "trace-old", "other-report"]]) {
      const fx = makeFixture();
      reportingCli(fx);
      const root = join(fx.dir, "playwright-report");
      mkdirSync(root, { recursive: true });
      for (const name of entries) mkdirSync(join(root, name), { recursive: true });
      const result = await runToEnd(fx, chromium);
      expect(result.status, `entries ${JSON.stringify(entries)}: ${result.stderr}`).toBe(0);
      for (const name of entries) expect(existsSync(join(root, name)), name).toBe(true);
    }
  });

  it("removes the containers labelled for the run when the quarantine run times out, even under --keep (G-L6)", async () => {
    const fx = makeFixture();
    // a `timeout` that reports the quarantine run ran out of time
    writeFileSync(
      join(fx.dir, "stub-bin/timeout"),
      `#!/usr/bin/env bash
while [[ "\${1:-}" == -* ]]; do
  case "$1" in -k | -s | --kill-after | --signal) shift 2 ;; *) shift ;; esac
done
shift
for arg in "$@"; do [[ "$arg" != --pass-with-no-tests ]] || exit 124; done
exec "$@"
`,
    );
    chmodSync(join(fx.dir, "stub-bin/timeout"), 0o755);
    // a docker that shows one labelled container until it is removed
    const real = join(fx.dir, "stub-bin/docker");
    const wrapped = join(fx.dir, "stub-bin/docker-real");
    cpSync(real, wrapped);
    writeFileSync(
      real,
      `#!/usr/bin/env bash
if [[ "$1" == ps && "$*" == *label=orbit-e2e-run=* ]]; then
  printf '%s\\n' "$*" >> "$DOCKER_STUB_LOG"
  [[ -e "$DOCKER_STUB_LOG.run-removed" ]] || echo run-straggler
  exit 0
fi
if [[ "$1" == rm && "$*" == *run-straggler* ]]; then touch "$DOCKER_STUB_LOG.run-removed"; fi
exec "${wrapped}" "$@"
`,
    );
    chmodSync(real, 0o755);
    chmodSync(wrapped, 0o755);
    const result = await runToEnd(fx, [...chromium, "--keep"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr + result.stdout, "the quarantine run did not time out").toContain("ran past");
    expect(dockerCalls(fx).some((l) => /^rm .*--force.* run-straggler/.test(l)), dockerCalls(fx).join("\n")).toBe(true);
  });

  it("prints the Playwright reports pointer after a failed gate too (L-F2)", async () => {
    const fx = makeFixture();
    reportingCli(fx);
    const result = await runToEnd(fx, chromium, { FAKE_SUITE_EXIT: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/Playwright reports:/u);
  });
});
