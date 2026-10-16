import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const script = fileURLToPath(new URL("./test-e2e-local.sh", import.meta.url));

/*
 * #947: `--reuse PROJECT` skips the image build, the OIDC build and
 * `compose up`, identifying and health-checking an already-running stack by
 * Compose's own project/service labels instead. These drive the real script
 * past the dry-run hook -- discovery uses only read-only `docker ps`/`docker
 * inspect` calls, and a project name that certainly does not exist reaches
 * `fail()` before the script would ever touch pnpm, a build or `compose up`,
 * so this needs no Docker stub and starts nothing.
 *
 * They live in their own file because that is the granularity the docker
 * split works at (#950): the script's preconditions demand a real `docker`
 * binary and a reachable daemon, which the unprivileged `fast` lane has
 * neither of, so ORBIT_TEST_SKIP_DOCKER excludes this file there and
 * `fast_docker` runs it. The rest of test-e2e-local.test.mjs never gets past
 * the dry-run hook and so stays in `fast`, where it is cheaper.
 */
function runReuse(args) {
  const result = failOnProcessDeadline(
    spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      // Deliberately no TEST_E2E_LOCAL_DRY_RUN: this must reach the real
      // --reuse discovery code, not the argument-assembly short-circuit.
      env: process.env,
      ...processGuard(),
    }),
    { label: "runReuse" },
  );
  // The script checks its whole prerequisite list -- docker, node, git, curl,
  // jq, openssl, pnpm -- several steps before the code under test, and the
  // teardown assertion below still passes on the output of a run that stopped
  // there, so the file would report half green having proven nothing. Assert
  // on the list as a whole rather than on `docker` alone: the first cut named
  // only docker and `fast_docker` then went red on jq instead (pipeline 1021),
  // which is the same silent-hole risk one package along (#947).
  expect(
    result.stderr,
    "this suite needs every prerequisite scripts/test-e2e-local.sh checks, not just docker: the lane running it must install them",
  ).not.toMatch(/missing prerequisite/);
  return result;
}

describe("test-e2e-local.sh --reuse", () => {
  it("fails loudly and exits non-zero when no stack exists for the named project", () => {
    const project = `orbit-e2e-local-reuse-test-absent-${process.pid}`;
    const result = runReuse(["--reuse", project]);
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    expect(result.stderr).toContain(project);
    expect(result.stderr).toContain("no running orbit-app container");
  });

  it("never tears down a stack it did not create, even when it fails to identify one", () => {
    const project = `orbit-e2e-local-reuse-test-absent-${process.pid}`;
    const result = runReuse(["--reuse", project]);
    expect(result.stderr).toContain("not tearing down project");
    // The positive form ("tearing down project ...", no "not") is only ever
    // logged right before a real `compose down` call, so its absence here is
    // the proof that call never happened.
    expect(result.stderr).not.toMatch(/(?<!not )tearing down project/);
  });
});

/*
 * A reused project must be an e2e stack, because the suite resets that
 * project's database: naming a real install by mistake would wipe it. The
 * script recognises an e2e stack by the orbit-app container's Compose label
 * `com.docker.compose.project.config_files` -- a comma-separated list of the
 * absolute compose-file paths the stack was started with -- which must include
 * compose/docker-compose.local-e2e.yml (every stack the script starts includes
 * that overlay; a real install never does).
 *
 * Driven through a throwaway repository copy whose tools are stubs (docker,
 * curl, jq, openssl, pnpm, a fake Playwright CLI), so nothing real is started
 * and no daemon is needed. The stub docker reports a running, healthy stack
 * whose config_files label is whatever STUB_CONFIG_FILES holds (absent when
 * unset), and the fake Playwright CLI drops a marker file if it is ever run.
 */
const E2E_OVERLAY_LABEL = "/home/u/orbit/docker-compose.yml,/x/compose/docker-compose.local-e2e.yml";
const STUBS = {
  docker: `#!/usr/bin/env bash
case "$1" in
  info) exit 0 ;;
  inspect)
    case "$*" in
      *com.docker.compose.project.config_files*)
        [[ -z "\${STUB_CONFIG_FILES+x}" ]] || printf '%s\\n' "$STUB_CONFIG_FILES"
        exit 0 ;;
      *State.Health.Status*) echo healthy; exit 0 ;;
      *HostPort*) echo 4000; exit 0 ;;
    esac
    exit 1 ;;
  ps)
    for a in "$@"; do
      case "$a" in
        label=com.docker.compose.service=*) echo "stub-\${a##*=}"; exit 0 ;;
      esac
    done
    exit 0 ;;
  compose)
    case " $* " in
      *" config "*) echo '{}' ;;
      *" logs "*) echo "stub compose logs for project" ;;
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

const reuseFixtures = [];
afterEach(() => {
  for (const dir of reuseFixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeReuseFixture() {
  const dir = mkdtempSync(join(tmpdir(), "e2e-local-reuse-"));
  reuseFixtures.push(dir);
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
  const playwrightRan = join(dir, "playwright-ran");
  writeFileSync(
    join(dir, "node_modules/@playwright/test/cli.js"),
    `require("fs").writeFileSync(${JSON.stringify(playwrightRan)}, "ran");\n`,
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
  return { dir, bin, playwrightRan };
}

function reuseStubbed(configFiles) {
  const fx = makeReuseFixture();
  const project = `e2e-reuse-unit-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const env = {
    PATH: `${fx.bin}:${process.env.PATH}`,
    HOME: process.env.HOME,
    ORBIT_E2E_ARTIFACT_ROOT: join(fx.dir, "artifacts"),
  };
  if (configFiles !== undefined) env.STUB_CONFIG_FILES = configFiles;
  const result = failOnProcessDeadline(
    spawnSync(
      "bash",
      [join(fx.dir, "scripts/test-e2e-local.sh"), "--reuse", project, "--project", "desktop-chromium"],
      { cwd: fx.dir, encoding: "utf8", env, ...processGuard() },
    ),
    { label: "reuseStubbed" },
  );
  return { ...result, project, playwrightRan: fx.playwrightRan };
}

describe("test-e2e-local.sh --reuse only accepts an e2e stack", () => {
  it("refuses a healthy project whose orbit-app was not started with the e2e overlay", () => {
    const result = reuseStubbed("/srv/orbit/docker-compose.yml");
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    expect(result.stderr).toContain("not an e2e stack");
    expect(result.stderr).toContain(result.project);
    expect(existsSync(result.playwrightRan), "Playwright must not run against a non-e2e project").toBe(false);
  });

  it("reuses a healthy project whose config_files label includes the e2e overlay", () => {
    const result = reuseStubbed(E2E_OVERLAY_LABEL);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("not an e2e stack");
    expect(existsSync(result.playwrightRan), "Playwright should have run").toBe(true);
  });

  it("refuses a project whose config_files label is missing entirely", () => {
    const result = reuseStubbed(undefined);
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    expect(result.stderr).toContain("not an e2e stack");
    expect(result.stderr).toContain(result.project);
    expect(existsSync(result.playwrightRan), "Playwright must not run against a non-e2e project").toBe(false);
  });

  // Compose lists the files in -f order, and --ci-cap appends its overlay
  // after the e2e one, so the e2e overlay is not always last.
  it.each([
    ["first", "/x/compose/docker-compose.local-e2e.yml,/x/docker-compose.yml"],
    ["in the middle", "/x/docker-compose.yml,/x/compose/docker-compose.local-e2e.yml,/x/compose/docker-compose.ci-cap.yml"],
  ])("reuses a stack whose e2e overlay is listed %s", (_where, label) => {
    const result = reuseStubbed(label);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(result.playwrightRan), "Playwright should have run").toBe(true);
  });

  it.each([
    "/x/docker-compose.yml,/x/compose/docker-compose.local-e2e.yml.bak",
    "/x/docker-compose.yml,/x/compose/x-docker-compose.local-e2e.yml",
  ])("refuses a near-miss overlay name: %s", (label) => {
    const result = reuseStubbed(label);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not an e2e stack");
    expect(existsSync(result.playwrightRan), "Playwright must not run against a non-e2e project").toBe(false);
  });
});
