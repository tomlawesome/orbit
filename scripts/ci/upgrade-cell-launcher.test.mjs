import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
import { afterEach, describe, expect, it } from "vitest";

/*
 * scripts/ci/upgrade-cell-launcher.sh (#1666): the launcher update cell of the
 * upgrade matrix, latest-1 x plain, updated through the launcher. Driven here
 * with a fake `go` on PATH, written from the issue text alone, in the style of
 * upgrade-cell.test.mjs (#1664). The fakes of that file are copied; the update
 * step differs: the cell must NOT run the candidate installer itself, the
 * launcher test (fake go) does the update.
 *
 * Assumptions the issue does not state (the spec should adopt or overrule):
 *   - upgrade-cell.sh is sourced as a library. It already has the guard
 *     `[[ ${BASH_SOURCE[0]} == "$0" ]] && main`, so sourcing works as is.
 *   - The new script fixes SLOT=latest-1 and the shape-script name itself, so
 *     the tests set neither SLOT nor SHAPE; the verdict says shape=launcher.
 *     The fake shapes dir holds plain.sh and launcher.sh, both recording as
 *     "shape-<name>".
 *   - The script writes its artefacts under upgrade-cells/ in the working
 *     directory with a .line and .xml extension; the tests find them by glob.
 *   - Inputs: ORBIT_RELEASE_MANIFEST (step 1's, here the caller's),
 *     ORBIT_LIVE_EXISTING_DIR = the install target (UPGRADE_CELL_TARGET),
 *     ORBIT_LAUNCHER_INSTALL_SCRIPT_PATH = the new installer
 *     (UPGRADE_CELL_NEW_INSTALLER), ORBIT_LAUNCHER_LIVE_BINARY = the caller's
 *     environment value (build_launcher's archive), passed through unchanged.
 *   - Where go runs from (the launcher source in launcher/pin.json) is not
 *     asserted; the fake go ignores its cwd.
 *   - "Installer's user ID" is the uid the old/new installers run under (the
 *     current uid, in_target); go must run as that same non-zero uid. The
 *     tests run as a non-root user; if run as root the uid test is skipped.
 *   - Step order: 0-6 as upgrade-cell.sh, 7 = go test, 8 = cell_assert.
 *   - SKIP reason text for ORBIT_UPGRADE_LAUNCHER=false is not specified; only
 *     that it is non-empty and mentions nothing about secrets.
 */
const cellScript = fileURLToPath(new URL("./upgrade-cell-launcher.sh", import.meta.url));

const CLAIM_CODE = "FAKE-CLAIM-CODE-7Q2X9";
const SECRET = "fake-session-secret-value-5d4c3b2a";
const DIGEST = `sha256:${"a".repeat(64)}`;
const WRONG_DIGEST = `sha256:${"b".repeat(64)}`;
const REPOSITORY = "orbit/candidate-fake";
const GO_ARGS = "test -tags live -count=1 -v -timeout 15m -run ^TestLive_UpdateExistingDeployment$ ./test/live/";
const isRoot = process.getuid?.() === 0;

const scratch = [];
function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-upgrade-cell-launcher-"));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop(), { recursive: true, force: true });
});

function exe(path, body) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

/* Each fake logs "<name> <args>" to $CALLS and obeys FAKE_FAIL_* variables. */
function buildWorld() {
  const root = tmp();
  const bin = join(root, "bin");
  const fakes = join(root, "fakes");
  const shapes = join(root, "shapes");
  const oldTree = join(root, "old-tree");
  const target = join(root, "target");
  const work = join(root, "work");
  for (const d of [bin, fakes, shapes, oldTree, target, work]) mkdirSync(d, { recursive: true });
  const calls = join(root, "calls.log");
  writeFileSync(calls, "");
  const manifest = join(root, "manifest.json");
  writeFileSync(
    manifest,
    JSON.stringify({ digest: DIGEST, image: { repository: `127.0.0.1:5000/${REPOSITORY}`, digest: DIGEST } }),
  );

  exe(
    join(fakes, "old-install.sh"),
    `printf 'old-install %s | ORBIT_CHANNEL=%s uid=%s\\n' "$*" "\${ORBIT_CHANNEL:-}" "$(id -u)" >> "$CALLS"
echo "claim code: ${CLAIM_CODE}"
if [ "\${FAKE_FAIL_INSTALL:-0}" = 1 ]; then
  echo "first line of a noisy failure with ${SECRET} inside"
  exit 3
fi
exit 0`,
  );
  // The candidate installer: the launcher test would run it; the cell must not.
  exe(
    join(fakes, "new-install.sh"),
    `printf 'new-install %s | uid=%s\\n' "$*" "$(id -u)" >> "$CALLS"
exit 0`,
  );
  exe(
    join(fakes, "seed.sh"),
    `printf 'seed %s\\n' "$*" >> "$CALLS"
echo "claim code ${CLAIM_CODE}"
if [ "$1" = seed ] && [ -n "\${FAKE_FAIL_SEED:-}" ]; then
  echo "step=seed assertion=$FAKE_FAIL_SEED detail=\\"fake seed failure ${CLAIM_CODE}\\""; exit 1
fi
if [ "$1" = readback ] && [ -n "\${FAKE_FAIL_READBACK:-}" ]; then
  echo "assertion=$FAKE_FAIL_READBACK detail=\\"fake readback failure\\""; exit 1
fi
exit 0`,
  );
  for (const shape of ["plain", "launcher"]) {
    exe(
      join(shapes, `${shape}.sh`),
      `printf 'shape-%s %s\\n' "${shape}" "$*" >> "$CALLS"
echo "token ${SECRET}"
if [ "$1" = "\${FAKE_FAIL_SHAPE_VERB:-none}" ]; then
  if [ "$1" = assert ]; then echo "assertion=\${FAKE_ASSERTION:-env-file-intact} detail=\\"fake drift\\""; fi
  exit 1
fi
exit 0`,
  );
  }
  exe(
    join(bin, "docker"),
    `printf 'docker %s\\n' "$*" >> "$CALLS"
if [ "\${1:-}" = compose ]; then
  case " $* " in
    *" down "*) [ "\${FAKE_FAIL_CLEANUP:-0}" = 1 ] && { echo "down failed" >&2; exit 1; } ;;
  esac
  exit 0
fi
if [ "\${1:-}" = inspect ] && [ "\${2:-}" = orbit ]; then
  echo "127.0.0.1:5000/${REPOSITORY}@\${FAKE_RUNNING_DIGEST:-${DIGEST}}"
  exit 0
fi
exit 1`,
  );
  // Fake go: logs argv (one per line group, joined by spaces), the four required
  // env vars, the registry vars, the uid and the stdout; on success it behaves
  // like the update left things: .env-orbit names the candidate image.
  exe(
    join(bin, "go"),
    `printf 'go %s\\n' "$*" >> "$CALLS"
printf 'go-env ORBIT_LIVE_EXISTING_DIR=%s ORBIT_RELEASE_MANIFEST=%s ORBIT_LAUNCHER_LIVE_BINARY=%s ORBIT_LAUNCHER_INSTALL_SCRIPT_PATH=%s ORBIT_REGISTRY=%s ORBIT_REPOSITORY=%s\\n' \\
  "\${ORBIT_LIVE_EXISTING_DIR:-}" "\${ORBIT_RELEASE_MANIFEST:-}" "\${ORBIT_LAUNCHER_LIVE_BINARY:-}" "\${ORBIT_LAUNCHER_INSTALL_SCRIPT_PATH:-}" "\${ORBIT_REGISTRY:-}" "\${ORBIT_REPOSITORY:-}" >> "$CALLS"
printf 'go-uid %s\\n' "$(id -u)" >> "$CALLS"
echo "token ${SECRET} claim code ${CLAIM_CODE}"
if [ "\${FAKE_FAIL_GO:-0}" = 1 ]; then
  for i in $(seq 1 "\${FAKE_GO_NOISE:-0}"); do echo "noise-line-$i"; done
  [ "\${FAKE_GO_NOISE:-0}" -gt 0 ] && printf '\\n   \\n'
  echo "--- FAIL: TestLive_UpdateExistingDeployment (3.2s)"
  echo "FAIL"
  exit 1
fi
digest="\${FAKE_IMAGE_DIGEST:-${DIGEST}}"
printf 'ORBIT_IMAGE=%s/%s@%s\\n' "\${ORBIT_REGISTRY:-x}" "\${ORBIT_REPOSITORY:-x}" "$digest" > "\${ORBIT_LIVE_EXISTING_DIR:?}/.env-orbit"
echo "--- PASS: TestLive_UpdateExistingDeployment (3.2s)"
echo "PASS"
exit 0`,
  );
  const gitSrc = join(root, "git-src");
  mkdirSync(join(gitSrc, "scripts"), { recursive: true });
  writeFileSync(join(gitSrc, "scripts/install.sh"), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(join(gitSrc, ".env-orbit.example"), "ORBIT_PORT=3000\n");
  exe(
    join(bin, "git"),
    `printf 'git %s\\n' "$*" >> "$CALLS"
case "$1" in
  fetch) exit 0 ;;
  archive) tar -C "${gitSrc}" -cf - scripts .env-orbit.example ;;
  *) exit 0 ;;
esac`,
  );

  // Launcher inputs (spec addition, note on #1666): a readable binary, and a launcher
  // source with test/live/ (UPGRADE_CELL_LAUNCHER_SRC; no fallback to the cwd).
  const launcherBinary = join(root, "launcher-archive", "orbit-launcher");
  mkdirSync(join(root, "launcher-archive"), { recursive: true });
  writeFileSync(launcherBinary, "fake launcher\n");
  const launcherSrc = join(root, "launcher-src");
  mkdirSync(join(launcherSrc, "test", "live"), { recursive: true });
  // Fake id: FAKE_ROOT=1 makes `id -u` print 0; everything else is the real id.
  exe(join(bin, "id"), `if [ "\${FAKE_ROOT:-0}" = 1 ] && [ "\${1:-}" = -u ]; then echo 0; exit 0; fi
exec /usr/bin/id "$@"`);

  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: root,
    CALLS: calls,
    ORBIT_UPGRADE_MATRIX: "true",
    ORBIT_UPGRADE_SINCE: "v0.3.6",
    ORBIT_UPGRADE_LAUNCHER: "true",
    ORBIT_UPGRADE_SLOT_LATEST_1: "v0.3.6",
    ORBIT_UPGRADE_SLOT_LATEST_2: "v0.3.5",
    IMAGE_NAME: REPOSITORY,
    ORBIT_RELEASE_MANIFEST: manifest,
    ORBIT_LAUNCHER_LIVE_BINARY: launcherBinary,
    UPGRADE_CELL_LAUNCHER_SRC: launcherSrc,
    UPGRADE_CELL_OLD_INSTALLER: join(fakes, "old-install.sh"),
    UPGRADE_CELL_NEW_INSTALLER: join(fakes, "new-install.sh"),
    UPGRADE_CELL_SKIP_REGISTRY: "1",
    UPGRADE_CELL_SEED: join(fakes, "seed.sh"),
    UPGRADE_CELL_SHAPES_DIR: shapes,
    UPGRADE_CELL_OLD_TREE: oldTree,
    UPGRADE_CELL_TARGET: target,
    ORBIT_FAKE_ENV_ONLY_SECRET: "fake-env-only-secret-0f1e2d3c",
  };
  return { root, work, calls, env, manifest, target, launcherBinary, launcherSrc };
}

function runCell(world, overrides = {}) {
  const env = { ...world.env, ...overrides };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const r = spawnSync("bash", [cellScript], { cwd: world.work, encoding: "utf8", env, timeout: 60_000 });
  const lines = (r.stdout ?? "").split("\n").filter((l) => l.length > 0);
  return { ...r, lines, last: lines.at(-1) ?? "", all: (r.stdout ?? "") + (r.stderr ?? "") };
}

const callLog = (w) => readFileSync(w.calls, "utf8").split("\n").filter(Boolean);
const verdictLines = (r) => r.lines.filter((l) => l.startsWith("upgrade-cell "));
function artefacts(w, ext) {
  const dir = join(w.work, "upgrade-cells");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(`.${ext}`)).map((f) => join(dir, f));
}

function expectNoSecrets(r, w) {
  for (const s of [CLAIM_CODE, SECRET, w.env.ORBIT_FAKE_ENV_ONLY_SECRET]) {
    expect(r.all).not.toContain(s);
    for (const ext of ["line", "xml"]) {
      for (const p of artefacts(w, ext)) expect(readFileSync(p, "utf8")).not.toContain(s);
    }
  }
}

function expectFail(r, w, { step, assertion, version = "v0.3.6" }) {
  expect(r.status, r.all).toBe(1);
  expect(r.last).toMatch(
    new RegExp(`^upgrade-cell FAIL version=${version} shape=launcher step=${step} assertion=${assertion} detail="[^"\\n]*"$`),
  );
  expect(verdictLines(r)).toHaveLength(1);
  expect(/detail="([^"]*)"$/.exec(r.last)[1].length).toBeLessThanOrEqual(200);
  const lineFiles = artefacts(w, "line");
  expect(lineFiles).toHaveLength(1);
  expect(readFileSync(lineFiles[0], "utf8").trimEnd()).toBe(r.last);
  expect(artefacts(w, "xml")).toHaveLength(1);
  expect(readFileSync(artefacts(w, "xml")[0], "utf8")).toContain("<failure");
  expectNoSecrets(r, w);
}

describe("upgrade-cell-launcher.sh: PASS", () => {
  it("prints the PASS line last with shape=launcher, exit 0", () => {
    const w = buildWorld();
    const r = runCell(w);
    expect(r.status, r.all).toBe(0);
    expect(r.last).toMatch(/^upgrade-cell PASS version=v0\.3\.6 shape=launcher seconds=\d+$/);
    expect(verdictLines(r)).toHaveLength(1);
    expect(r.stdout.trimEnd().split("\n").at(-1)).toBe(r.last);
    expectNoSecrets(r, w);
  });

  it("writes the .line artefact and a JUnit file with one case and no failure", () => {
    const w = buildWorld();
    const r = runCell(w);
    const lineFiles = artefacts(w, "line");
    expect(lineFiles).toHaveLength(1);
    expect(readFileSync(lineFiles[0], "utf8").trimEnd()).toBe(r.last);
    const xml = readFileSync(artefacts(w, "xml")[0], "utf8");
    expect(xml).toContain('name="v0.3.6/launcher"');
    expect(xml.match(/<testcase\b/g)).toHaveLength(1);
    expect(xml).not.toContain("<failure");
  });

  it("runs steps 0-6 as upgrade-cell.sh, then go test, then the step 8 checks", () => {
    const w = buildWorld();
    const r = runCell(w);
    expect(r.status, r.all).toBe(0);
    const names = callLog(w).map((l) => l.split(" ").slice(0, 2).join(" "));
    const at = (pred, from = 0) => names.findIndex((n, i) => i >= from && pred(n));
    const order = [
      (n) => /^shape-\w+ provision$/.test(n),
      (n) => n === "old-install --plain",
      (n) => n === "seed seed",
      (n) => /^shape-\w+ after_install$/.test(n),
      (n) => n === "go test",
      (n) => /^shape-\w+ assert$/.test(n),
      (n) => n === "seed readback",
    ];
    let from = 0;
    for (const pred of order) {
      const i = at(pred, from);
      expect(i, names.join(" | ")).toBeGreaterThanOrEqual(from);
      from = i + 1;
    }
    expect(callLog(w)).toContain("old-install --plain --install | ORBIT_CHANNEL=v0.3.6 uid=" + process.getuid());
  });

  it("does not run the candidate installer itself: the launcher test does the update", () => {
    const w = buildWorld();
    runCell(w);
    expect(callLog(w).filter((l) => l.startsWith("new-install"))).toEqual([]);
  });

  it("tears the stack down with compose down -v after a pass", () => {
    const w = buildWorld();
    runCell(w);
    expect(callLog(w).join("\n")).toMatch(/docker compose .*down.* -v|docker compose .*down.*--volumes/);
  });
});

describe("upgrade-cell-launcher.sh: the go test invocation", () => {
  it("passes exactly the documented arguments", () => {
    const w = buildWorld();
    const r = runCell(w);
    expect(r.status, r.all).toBe(0);
    const goCalls = callLog(w).filter((l) => l.startsWith("go "));
    expect(goCalls).toEqual([`go ${GO_ARGS}`]);
  });

  it("passes the four required env vars through", () => {
    const w = buildWorld();
    runCell(w);
    const env = callLog(w).find((l) => l.startsWith("go-env "));
    expect(env).toContain(`ORBIT_LIVE_EXISTING_DIR=${w.env.UPGRADE_CELL_TARGET}`);
    expect(env).toContain(`ORBIT_RELEASE_MANIFEST=${w.manifest}`);
    expect(env).toContain(`ORBIT_LAUNCHER_LIVE_BINARY=${w.launcherBinary}`);
    expect(env).toContain(`ORBIT_LAUNCHER_INSTALL_SCRIPT_PATH=${w.env.UPGRADE_CELL_NEW_INSTALLER}`);
  });

  it("exports ORBIT_REGISTRY=127.0.0.1:5000 and ORBIT_REPOSITORY to it", () => {
    const w = buildWorld();
    runCell(w);
    const env = callLog(w).find((l) => l.startsWith("go-env "));
    expect(env).toContain("ORBIT_REGISTRY=127.0.0.1:5000");
    expect(env).toContain(`ORBIT_REPOSITORY=${REPOSITORY}`);
  });

  it.skipIf(isRoot)("runs go as non-root, with the installer's user ID", () => {
    const w = buildWorld();
    runCell(w);
    const log = callLog(w);
    const installerUid = /uid=(\d+)$/.exec(log.find((l) => l.startsWith("old-install")))[1];
    const goUid = log.find((l) => l.startsWith("go-uid ")).split(" ")[1];
    expect(goUid).not.toBe("0");
    expect(goUid).toBe(installerUid);
  });

  it("verifies the candidate image after go: a wrong digest is image-is-candidate", () => {
    const w = buildWorld();
    const r = runCell(w, { FAKE_IMAGE_DIGEST: WRONG_DIGEST });
    expectFail(r, w, { step: "assert", assertion: "image-is-candidate" });
  });
});

describe("upgrade-cell-launcher.sh: SKIP", () => {
  it("skips when ORBIT_UPGRADE_LAUNCHER=false, exit 0, running no go and no install", () => {
    const w = buildWorld();
    const r = runCell(w, { ORBIT_UPGRADE_LAUNCHER: "false" });
    expect(r.status, r.all).toBe(0);
    expect(r.last).toMatch(/^upgrade-cell SKIP version=(-|v0\.3\.6) shape=launcher reason="[^"\n]+"$/);
    expect(verdictLines(r)).toHaveLength(1);
    expect(callLog(w).filter((l) => !l.startsWith("docker"))).toEqual([]);
    const lineFiles = artefacts(w, "line");
    expect(lineFiles).toHaveLength(1);
    expect(readFileSync(lineFiles[0], "utf8").trimEnd()).toBe(r.last);
    expect(readFileSync(artefacts(w, "xml")[0], "utf8")).not.toContain("<failure");
  });

  it("skips an empty latest-1, exit 0, running no go and no install", () => {
    const w = buildWorld();
    const r = runCell(w, { ORBIT_UPGRADE_SLOT_LATEST_1: "" });
    expect(r.status, r.all).toBe(0);
    expect(r.last).toBe('upgrade-cell SKIP version=- shape=launcher reason="slot latest-1 is empty"');
    expect(callLog(w).filter((l) => !l.startsWith("docker"))).toEqual([]);
    expect(readFileSync(artefacts(w, "line")[0], "utf8").trimEnd()).toBe(r.last);
  });

  it("also treats an unset latest-1 as empty", () => {
    const w = buildWorld();
    const r = runCell(w, { ORBIT_UPGRADE_SLOT_LATEST_1: undefined });
    expect(r.status).toBe(0);
    expect(r.last).toContain('reason="slot latest-1 is empty"');
  });

  it("does not skip when ORBIT_UPGRADE_LAUNCHER is true", () => {
    const w = buildWorld();
    const r = runCell(w, { ORBIT_UPGRADE_LAUNCHER: "true" });
    expect(r.last).toMatch(/^upgrade-cell PASS /);
  });
});

describe("upgrade-cell-launcher.sh: FAIL", () => {
  it("a non-zero go exit is step=update assertion=launcher-update-passed", () => {
    const w = buildWorld();
    const r = runCell(w, { FAKE_FAIL_GO: "1" });
    expectFail(r, w, { step: "update", assertion: "launcher-update-passed" });
    expect(callLog(w).filter((l) => /^shape-\w+ assert\b/.test(l))).toEqual([]);
    expect(callLog(w).filter((l) => l.startsWith("seed readback"))).toEqual([]);
  });

  // #1748: the cell shows the step's own last words in the job log, as fail_from_out does (#1746).
  it("prints up to the last 5 non-blank output lines to stderr, prefixed and in order (#1748)", () => {
    const w = buildWorld();
    const r = runCell(w, { FAKE_FAIL_GO: "1", FAKE_GO_NOISE: "8" });
    expectFail(r, w, { step: "update", assertion: "launcher-update-passed" });
    const shown = r.stderr.split("\n").filter((l) => l.startsWith("upgrade-cell output: "));
    expect(shown).toEqual([
      "upgrade-cell output: noise-line-6",
      "upgrade-cell output: noise-line-7",
      "upgrade-cell output: noise-line-8",
      "upgrade-cell output: --- FAIL: TestLive_UpdateExistingDeployment (3.2s)",
      "upgrade-cell output: FAIL",
    ]);
    expect(r.stdout).not.toContain("upgrade-cell output:");
  });

  it("prints every non-blank line when the output is shorter than 5, redacted (#1748)", () => {
    const w = buildWorld();
    const r = runCell(w, { FAKE_FAIL_GO: "1" });
    const shown = r.stderr.split("\n").filter((l) => l.startsWith("upgrade-cell output: "));
    expect(shown).toHaveLength(3);
    expect(shown[0]).toMatch(/^upgrade-cell output: token \[redacted\] claim code \[redacted\]$/);
    expect(shown[2]).toBe("upgrade-cell output: FAIL");
    expectNoSecrets(r, w);
  });

  it("a go failure still runs clean-up", () => {
    const w = buildWorld();
    runCell(w, { FAKE_FAIL_GO: "1" });
    expect(callLog(w).join("\n")).toMatch(/docker compose .*down/);
  });

  it("a go failure's detail is one line and carries no secret", () => {
    const w = buildWorld();
    const r = runCell(w, { FAKE_FAIL_GO: "1" });
    expect(r.last).not.toContain("\n");
    expectNoSecrets(r, w);
  });

  it("old install failure: step=install install-exited-0, go never runs", () => {
    const w = buildWorld();
    const r = runCell(w, { FAKE_FAIL_INSTALL: "1" });
    expectFail(r, w, { step: "install", assertion: "install-exited-0" });
    expect(callLog(w).filter((l) => l.startsWith("go "))).toEqual([]);
  });

  it("seed failure: step=seed with that id, go never runs", () => {
    const w = buildWorld();
    const r = runCell(w, { FAKE_FAIL_SEED: "claim-accepted" });
    expectFail(r, w, { step: "seed", assertion: "claim-accepted" });
    expect(callLog(w).filter((l) => l.startsWith("go "))).toEqual([]);
  });

  it("after_install failure: step=shape, go never runs", () => {
    const w = buildWorld();
    const r = runCell(w, { FAKE_FAIL_SHAPE_VERB: "after_install" });
    expectFail(r, w, { step: "shape", assertion: "shape-exited-0" });
    expect(callLog(w).filter((l) => l.startsWith("go "))).toEqual([]);
  });

  it("running container on another digest after go: image-is-candidate", () => {
    const w = buildWorld();
    const r = runCell(w, { FAKE_RUNNING_DIGEST: WRONG_DIGEST });
    expectFail(r, w, { step: "assert", assertion: "image-is-candidate" });
  });

  it("shape assert failure is passed through, readback never runs", () => {
    const w = buildWorld();
    const r = runCell(w, { FAKE_FAIL_SHAPE_VERB: "assert", FAKE_ASSERTION: "env-file-intact" });
    expectFail(r, w, { step: "assert", assertion: "env-file-intact" });
    expect(callLog(w).filter((l) => l.startsWith("seed readback"))).toEqual([]);
  });

  it("readback failure: step=assert", () => {
    const w = buildWorld();
    const r = runCell(w, { FAKE_FAIL_READBACK: "item-readable" });
    expectFail(r, w, { step: "assert", assertion: "item-readable" });
  });

  it("prints the FAIL verdict last when go and clean-up both fail", () => {
    const w = buildWorld();
    const r = runCell(w, { FAKE_FAIL_CLEANUP: "1", FAKE_FAIL_GO: "1" });
    expect(r.status).toBe(1);
    expect(r.stdout.trimEnd().split("\n").at(-1)).toMatch(/^upgrade-cell FAIL .* step=update assertion=launcher-update-passed /);
    expect(verdictLines(r)).toHaveLength(1);
  });
});

describe("upgrade-cell-launcher.sh: refuses root and missing inputs before any work", () => {
  const noWork = (w) => {
    const log = callLog(w);
    for (const p of ["old-install", "seed", "go ", "shape-"]) expect(log.filter((l) => l.startsWith(p))).toEqual([]);
  };

  it("running as root: FAIL step=update runs-as-non-root, before the old installer", () => {
    const w = buildWorld();
    const r = runCell(w, { FAKE_ROOT: "1" });
    expectFail(r, w, { step: "update", assertion: "runs-as-non-root" });
    noWork(w);
  });

  it("a missing launcher source: FAIL launcher-source-present, go never called", () => {
    const w = buildWorld();
    const r = runCell(w, { UPGRADE_CELL_LAUNCHER_SRC: join(w.root, "no-such-dir") });
    expectFail(r, w, { step: "update", assertion: "launcher-source-present" });
    expect(callLog(w).filter((l) => l.startsWith("go "))).toEqual([]);
  });

  it("a launcher source without test/live/: FAIL launcher-source-present, go never called", () => {
    const w = buildWorld();
    const src = join(w.root, "src-no-live");
    mkdirSync(src, { recursive: true });
    const r = runCell(w, { UPGRADE_CELL_LAUNCHER_SRC: src });
    expectFail(r, w, { step: "update", assertion: "launcher-source-present" });
    expect(callLog(w).filter((l) => l.startsWith("go "))).toEqual([]);
  });

  it("an unset UPGRADE_CELL_LAUNCHER_SRC does not fall back to the working directory", () => {
    const w = buildWorld();
    mkdirSync(join(w.work, "test", "live"), { recursive: true });
    const r = runCell(w, { UPGRADE_CELL_LAUNCHER_SRC: undefined });
    expectFail(r, w, { step: "update", assertion: "launcher-source-present" });
    expect(callLog(w).filter((l) => l.startsWith("go "))).toEqual([]);
  });

  it.each(["ORBIT_RELEASE_MANIFEST", "ORBIT_LAUNCHER_LIVE_BINARY"])(
    "%s unset: FAIL launcher-inputs-present naming it, before the old installer",
    (name) => {
      const w = buildWorld();
      const r = runCell(w, { [name]: undefined });
      expectFail(r, w, { step: "update", assertion: "launcher-inputs-present" });
      expect(r.last).toContain(name);
      noWork(w);
    },
  );

  it.each(["ORBIT_RELEASE_MANIFEST", "ORBIT_LAUNCHER_LIVE_BINARY"])(
    "%s unreadable: FAIL launcher-inputs-present naming it, before the old installer",
    (name) => {
      const w = buildWorld();
      const r = runCell(w, { [name]: join(w.root, "no-such-file") });
      expectFail(r, w, { step: "update", assertion: "launcher-inputs-present" });
      expect(r.last).toContain(name);
      noWork(w);
    },
  );
});

describe("upgrade-cell-launcher.sh: source text", () => {
  const text = () => readFileSync(cellScript, "utf8");
  const code = () => text().split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

  it("sources upgrade-cell.sh as a library", () => {
    expect(code()).toMatch(/^\s*(source|\.)\s+.*upgrade-cell\.sh/m);
  });

  it("does not copy upgrade-cell.sh's steps", () => {
    const c = code();
    for (const copied of [
      /^\s*(cell_skip_checks|cell_registry|cell_old_tree|cell_shape|cell_old_install|cell_seed|cell_assert|cell_cleanup|cell_init|one_line|fail|skip)\s*\(\)/m,
      /docker load/,
      /start-installer-registry/,
      /git archive/,
      /clean-up-installer/,
      /docker inspect/,
    ]) {
      expect(c).not.toMatch(copied);
    }
  });

  it("names the go test, not the installer, for the update step", () => {
    expect(code()).toContain("TestLive_UpdateExistingDeployment");
  });
});
