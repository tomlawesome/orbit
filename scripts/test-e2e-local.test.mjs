import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

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
  info) exit 0 ;;
  rm) touch "$DOCKER_STUB_LOG.removed"; exit 0 ;;
  inspect)
    if [[ -e "$up_marker" ]]; then
      case "$*" in
        *State.Health.Status*) echo healthy; exit 0 ;;
        *HostPort*) echo 4000; exit 0 ;;
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
          if [[ -n "\${DOCKER_STUB_LEFTOVER:-}" && ! -e "$DOCKER_STUB_LOG.removed" ]]; then
            echo "$DOCKER_STUB_LEFTOVER"
          fi
          exit 0 ;;
      esac
    done
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

const fixtures = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
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
  writeFileSync(join(dir, "scripts/calculate-version.mjs"), 'console.log("0.0.0-test");\n');
  writeFileSync(join(dir, "scripts/install-test-browser.sh"), "exit 0\n");
  writeFileSync(join(dir, ".env-orbit.example"), "");
  writeFileSync(join(dir, "docker-compose.yml"), "services: {}\n");
  writeFileSync(join(dir, "tests/e2e/local-only-specs.txt"), "tests/e2e/a.spec.ts\n");
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
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  for (const args of [
    ["init", "--quiet"],
    ["add", "."],
    ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--quiet", "--no-verify", "-m", "x"],
  ]) {
    const r = spawnSync("git", args, { cwd: dir, env: gitEnv, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  }
  const project = `e2e-unit-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const dockerLog = join(dir, "docker.log");
  writeFileSync(dockerLog, "");
  const artifactRoot = join(dir, "artifacts");
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: process.env.HOME,
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
