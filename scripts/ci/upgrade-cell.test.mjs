import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/*
 * scripts/ci/upgrade-cell.sh (#1664): one cell of the upgrade matrix, one old
 * version x one shape. Driven here with fake installers, a fake seed script,
 * fake shape scripts and a fake docker and git, from the issue text alone.
 *
 * Test hooks the issue names: UPGRADE_CELL_OLD_INSTALLER,
 * UPGRADE_CELL_NEW_INSTALLER, UPGRADE_CELL_SKIP_REGISTRY=1.
 *
 * Hooks the issue does NOT name and this file therefore chooses (the spec
 * should adopt them):
 *   UPGRADE_CELL_SEED        path of the upgrade-seed.sh to run
 *   UPGRADE_CELL_SHAPES_DIR  directory holding <shape>.sh
 *   UPGRADE_CELL_OLD_TREE    a ready old-operator tree; when set, step 2
 *                            (git fetch + git archive) is not run
 *   UPGRADE_CELL_TARGET      the install target directory (the working
 *                            directory of the installers and shape scripts)
 * Other env names used, taken from the design note and the CI file:
 *   SLOT (e.g. latest-1), SHAPE, ORBIT_UPGRADE_MATRIX, ORBIT_UPGRADE_SINCE,
 *   ORBIT_UPGRADE_SLOT_LATEST_1.. (classify.env), IMAGE_NAME (candidate
 *   repository) and ORBIT_RELEASE_MANIFEST (candidate manifest, a JSON file
 *   with image.digest; the candidate digest is read from it).
 *
 * Decisions on spec gaps:
 *   - a step that fails with no assertion id of its own is reported as
 *     assertion=<step>-exited-0 (install, update, seed, shape);
 *   - shape provision/after_install failures are step=shape; the shape's
 *     assert and the seed script's readback failures are step=assert;
 *   - a shape/seed script reports its id as `assertion=<id>` somewhere in its
 *     output (the seed also prints `step=seed`);
 *   - a failed step 2 (git fetch/archive) is a FAIL with exit 1;
 *   - the "lane gate does not admit the job" skip is not covered: the spec
 *     does not say how the runner learns it.
 */
const cellScript = fileURLToPath(new URL("./upgrade-cell.sh", import.meta.url));

const CLAIM_CODE = "FAKE-CLAIM-CODE-7Q2X9";
const SECRET = "fake-session-secret-value-5d4c3b2a";
const DIGEST = `sha256:${"a".repeat(64)}`;
const WRONG_DIGEST = `sha256:${"b".repeat(64)}`;
const REPOSITORY = "orbit/candidate-fake";
const PREFLIGHT =
  "Orbit installer: configuration, OIDC discovery, and Docker Compose preflight passed; starting services.";

const scratch = [];
function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-upgrade-cell-"));
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

  // Old installer: the failure line carries a claim code and a very long, multi-line message.
  exe(
    join(fakes, "old-install.sh"),
    `printf 'old-install %s | ORBIT_CHANNEL=%s\\n' "$*" "\${ORBIT_CHANNEL:-}" >> "$CALLS"
echo "claim code: ${CLAIM_CODE}"
if [ "\${FAKE_FAIL_INSTALL:-0}" = 1 ]; then
  echo "first line of a noisy failure with ${SECRET} inside"
  printf 'x%.0s' $(seq 1 600); echo
  echo "last line: claim code ${CLAIM_CODE}"
  exit 3
fi
exit 0`,
  );
  // New installer: records its environment, writes ORBIT_IMAGE like an update would.
  exe(
    join(fakes, "new-install.sh"),
    `printf 'new-install %s | ORBIT_REGISTRY=%s ORBIT_REPOSITORY=%s ORBIT_RELEASE_MANIFEST=%s ORBIT_CHANNEL=%s\\n' "$*" "\${ORBIT_REGISTRY:-}" "\${ORBIT_REPOSITORY:-}" "\${ORBIT_RELEASE_MANIFEST:-}" "\${ORBIT_CHANNEL:-}" >> "$CALLS"
if [ "\${FAKE_FAIL_UPDATE:-0}" = 1 ]; then echo "update refused: COMPOSE_FILE is not an Orbit setting"; exit 4; fi
digest="\${FAKE_IMAGE_DIGEST:-${DIGEST}}"
printf 'ORBIT_IMAGE=%s/%s@%s\\n' "\${ORBIT_REGISTRY:-x}" "\${ORBIT_REPOSITORY:-x}" "$digest" > "\${UPGRADE_CELL_TARGET:?}/.env-orbit"
[ "\${FAKE_NO_PREFLIGHT:-0}" = 1 ] || echo "${PREFLIGHT}"
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
  for (const shape of ["plain", "mail", "secrets-file", "oidc", "all-keys"]) {
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
  // fake docker: logs; compose down can be made to fail; reports the running digest.
  exe(
    join(bin, "docker"),
    `printf 'docker %s\\n' "$*" >> "$CALLS"
if [ "\${1:-}" = compose ]; then
  case " $* " in
    *" down "*) [ "\${FAKE_FAIL_CLEANUP:-0}" = 1 ] && { echo "down failed" >&2; exit 1; } ;;
  esac
  exit 0
fi
# The spec reads: docker inspect orbit --format '{{.Config.Image}}'
if [ "\${1:-}" = inspect ] && [ "\${2:-}" = orbit ]; then
  echo "127.0.0.1:5000/${REPOSITORY}@\${FAKE_RUNNING_DIGEST:-${DIGEST}}"
  exit 0
fi
exit 1`,
  );
  // fake git: fetch is logged; archive emits a tar holding scripts/ and .env-orbit.example
  const gitSrc = join(root, "git-src");
  mkdirSync(join(gitSrc, "scripts"), { recursive: true });
  writeFileSync(join(gitSrc, "scripts/install.sh"), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(join(gitSrc, ".env-orbit.example"), "ORBIT_PORT=3000\n");
  exe(
    join(bin, "git"),
    `printf 'git %s\\n' "$*" >> "$CALLS"
case "$1" in
  fetch) [ "\${FAKE_FAIL_GIT:-0}" = 1 ] && { echo "fatal: couldn't find remote ref" >&2; exit 128; }; exit 0 ;;
  archive) [ "\${FAKE_FAIL_GIT:-0}" = 1 ] && exit 128
    out=""; for a in "$@"; do case "$a" in --output=*) out="\${a#--output=}";; esac; done
    if [ -n "$out" ]; then tar -C "${gitSrc}" -cf "$out" scripts .env-orbit.example; else tar -C "${gitSrc}" -cf - scripts .env-orbit.example; fi ;;
  *) exit 0 ;;
esac`,
  );

  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: root,
    CALLS: calls,
    SLOT: "latest-1",
    SHAPE: "plain",
    ORBIT_UPGRADE_MATRIX: "true",
    ORBIT_UPGRADE_SINCE: "v0.3.5",
    ORBIT_UPGRADE_SLOT_LATEST_1: "v0.3.5",
    ORBIT_UPGRADE_SLOT_LATEST_2: "v0.3.4",
    ORBIT_UPGRADE_SLOT_LATEST_3: "",
    IMAGE_NAME: REPOSITORY,
    ORBIT_RELEASE_MANIFEST: manifest,
    UPGRADE_CELL_OLD_INSTALLER: join(fakes, "old-install.sh"),
    UPGRADE_CELL_NEW_INSTALLER: join(fakes, "new-install.sh"),
    UPGRADE_CELL_SKIP_REGISTRY: "1",
    UPGRADE_CELL_SEED: join(fakes, "seed.sh"),
    UPGRADE_CELL_SHAPES_DIR: shapes,
    UPGRADE_CELL_OLD_TREE: oldTree,
    UPGRADE_CELL_TARGET: target,
    // Present in the environment only; no fake prints it.
    ORBIT_FAKE_ENV_ONLY_SECRET: "fake-env-only-secret-0f1e2d3c",
  };
  return { root, work, calls, env };
}

function runCell(world, overrides = {}) {
  const env = { ...world.env, ...overrides };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const r = spawnSync("bash", [cellScript], { cwd: world.work, encoding: "utf8", env, timeout: 60_000 });
  const lines = r.stdout.split("\n").filter((l) => l.length > 0);
  return { ...r, lines, last: lines.at(-1) ?? "", all: r.stdout + r.stderr };
}

const callLog = (w) => readFileSync(w.calls, "utf8").split("\n").filter(Boolean);
const verdictLines = (r) => r.lines.filter((l) => l.startsWith("upgrade-cell "));
const artefact = (w, ext, slot = "latest-1", shape = "plain") => join(w.work, "upgrade-cells", `${slot}-${shape}.${ext}`);

function xmlAttrDecode(s) {
  return s.replaceAll("&quot;", '"').replaceAll("&#34;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}
function junit(w, slot, shape) {
  return readFileSync(artefact(w, "xml", slot, shape), "utf8");
}
function failureMessage(xml) {
  const m = /<failure[^>]*\smessage="([^"]*)"/.exec(xml);
  return m ? xmlAttrDecode(m[1]) : null;
}

function expectFail(r, w, { step, assertion, version = "v0.3.5", shape = "plain" }) {
  expect(r.status, r.all).toBe(1);
  expect(r.last).toMatch(
    new RegExp(`^upgrade-cell FAIL version=${version} shape=${shape} step=${step} assertion=${assertion} detail="[^"\\n]*"$`),
  );
  expect(verdictLines(r)).toHaveLength(1);
  const detail = /detail="([^"]*)"$/.exec(r.last)[1];
  expect(detail.length).toBeLessThanOrEqual(200);
  expect(readFileSync(artefact(w, "line", "latest-1", shape), "utf8").trimEnd()).toBe(r.last);
  const xml = junit(w, "latest-1", shape);
  expect(xml).toContain(`name="${version}/${shape}"`);
  expect(failureMessage(xml)).toBe(r.last);
  expectNoSecrets(r, w);
}

function expectNoSecrets(r, w) {
  for (const s of [CLAIM_CODE, SECRET, w.env.ORBIT_FAKE_ENV_ONLY_SECRET]) {
    expect(r.all).not.toContain(s);
    for (const ext of ["line", "xml"]) {
      const p = artefact(w, ext, "latest-1", w.env.SHAPE);
      if (existsSync(p)) expect(readFileSync(p, "utf8")).not.toContain(s);
    }
  }
}

describe("upgrade-cell.sh: PASS", () => {
  it("runs the steps in order and prints the PASS line last", () => {
    const w = buildWorld();
    const r = runCell(w);
    expect(r.status, r.all).toBe(0);
    expect(r.last).toMatch(/^upgrade-cell PASS version=v0\.3\.5 shape=plain seconds=\d+$/);
    expect(verdictLines(r)).toHaveLength(1);
    const names = callLog(w).map((l) => l.split(" ").slice(0, 2).join(" "));
    const order = ["shape-plain provision", "old-install --plain", "seed seed", "shape-plain after_install", "new-install --plain", "shape-plain assert", "seed readback"];
    let from = 0;
    for (const step of order) {
      const at = names.findIndex((n, i) => i >= from && n === step);
      expect(at, `${step} in ${names.join(" | ")}`).toBeGreaterThanOrEqual(from);
      from = at + 1;
    }
    expectNoSecrets(r, w);
  });

  it("writes the .line artefact and a JUnit file with one case named <version>/<shape> and no failure", () => {
    const w = buildWorld();
    const r = runCell(w);
    expect(readFileSync(artefact(w, "line"), "utf8").trimEnd()).toBe(r.last);
    const xml = junit(w, "latest-1", "plain");
    expect(xml).toContain('name="v0.3.5/plain"');
    expect(xml.match(/<testcase\b/g)).toHaveLength(1);
    expect(xml).not.toContain("<failure");
  });

  it("passes the documented arguments and environment to the installers and the scripts", () => {
    const w = buildWorld();
    runCell(w, { SLOT: "latest-2", SHAPE: "mail" });
    const log = callLog(w);
    expect(log.find((l) => l.startsWith("old-install"))).toBe("old-install --plain --install | ORBIT_CHANNEL=v0.3.4");
    const update = log.find((l) => l.startsWith("new-install"));
    expect(update).toContain("--plain --update");
    expect(update).toContain("ORBIT_CHANNEL=preview");
    expect(callLog(w)).toContain("docker inspect orbit --format {{.Config.Image}}");
    expect(update).toContain("ORBIT_REGISTRY=127.0.0.1:5000");
    expect(update).toContain(`ORBIT_REPOSITORY=${REPOSITORY}`);
    expect(update).toContain(`ORBIT_RELEASE_MANIFEST=${w.env.ORBIT_RELEASE_MANIFEST}`);
    for (const l of log.filter((x) => x.startsWith("shape-mail"))) {
      expect(l).toContain(w.env.UPGRADE_CELL_TARGET);
      expect(l).toContain(w.env.UPGRADE_CELL_OLD_TREE);
    }
    const seed = log.find((l) => l.startsWith("seed seed"));
    expect(seed.split(" ")).toHaveLength(4); // seed seed <target> <base-url>
    expect(seed).toContain(w.env.UPGRADE_CELL_TARGET);
    expect(artefact(w, "line", "latest-2", "mail")).toSatisfy(existsSync);
  });

  it("tears the stack down with compose down -v after a pass", () => {
    const w = buildWorld();
    runCell(w);
    expect(callLog(w).join("\n")).toMatch(/docker compose .*down.* -v|docker compose .*down.*--volumes/);
  });

  it("fetches and archives the old release when no old tree is supplied", () => {
    const w = buildWorld();
    const r = runCell(w, { UPGRADE_CELL_OLD_TREE: undefined });
    expect(r.status, r.all).toBe(0);
    const log = callLog(w);
    expect(log).toContain("git fetch --depth=1 origin tag v0.3.5");
    expect(log.find((l) => l.startsWith("git archive"))).toMatch(/v0\.3\.5 scripts \.env-orbit\.example/);
  });
});

describe("upgrade-cell.sh: SKIP", () => {
  it("skips when ORBIT_UPGRADE_MATRIX=false, exit 0, touching nothing", () => {
    const w = buildWorld();
    const r = runCell(w, { ORBIT_UPGRADE_MATRIX: "false" });
    expect(r.status, r.all).toBe(0);
    expect(r.last).toMatch(
      /^upgrade-cell SKIP version=(-|v0\.3\.5) shape=plain reason="nothing install-relevant changed since v0\.3\.5 \(#1647\)"$/,
    );
    expect(verdictLines(r)).toHaveLength(1);
    expect(callLog(w).filter((l) => !l.startsWith("docker"))).toEqual([]);
    expect(readFileSync(artefact(w, "line"), "utf8").trimEnd()).toBe(r.last);
    expect(junit(w, "latest-1", "plain")).not.toContain("<failure");
  });

  it("skips an empty slot with the slot's name, exit 0", () => {
    const w = buildWorld();
    const r = runCell(w, { SLOT: "latest-3", SHAPE: "oidc" });
    expect(r.status, r.all).toBe(0);
    expect(r.last).toBe('upgrade-cell SKIP version=- shape=oidc reason="slot latest-3 is empty"');
    expect(callLog(w).filter((l) => !l.startsWith("docker"))).toEqual([]);
    expect(readFileSync(artefact(w, "line", "latest-3", "oidc"), "utf8").trimEnd()).toBe(r.last);
    expect(junit(w, "latest-3", "oidc")).not.toContain("<failure");
  });

  it("also treats an unset slot variable as empty", () => {
    const w = buildWorld();
    const r = runCell(w, { SLOT: "latest-3", ORBIT_UPGRADE_SLOT_LATEST_3: undefined });
    expect(r.status).toBe(0);
    expect(r.last).toContain('reason="slot latest-3 is empty"');
  });
});

describe("upgrade-cell.sh: FAIL, every step", () => {
  it("old tree fetch failure is a FAIL", () => {
    const w = buildWorld();
    const r = runCell(w, { UPGRADE_CELL_OLD_TREE: undefined, FAKE_FAIL_GIT: "1" });
    expect(r.status, r.all).toBe(1);
    expect(r.last).toMatch(/^upgrade-cell FAIL version=v0\.3\.5 shape=plain step=\w+ assertion=\S+ detail="[^"]*"$/);
    expect(callLog(w).filter((l) => l.startsWith("old-install"))).toEqual([]);
  });

  it("provision failure: step=shape, nothing installed", () => {
    const w = buildWorld();
    const r = runCell(w, { FAKE_FAIL_SHAPE_VERB: "provision" });
    expectFail(r, w, { step: "shape", assertion: "shape-exited-0" });
    expect(callLog(w).filter((l) => l.startsWith("old-install"))).toEqual([]);
  });

  it("old install failure: step=install install-exited-0, with a sanitised detail", () => {
    const w = buildWorld();
    const r = runCell(w, { FAKE_FAIL_INSTALL: "1" });
    expectFail(r, w, { step: "install", assertion: "install-exited-0" });
    expect(callLog(w).filter((l) => l.startsWith("seed"))).toEqual([]);
  });

  it.each(["claim-code-found", "claim-accepted", "login-accepted", "item-created", "document-uploaded"])(
    "seed failure %s: step=seed with that id",
    (id) => {
      const w = buildWorld();
      const r = runCell(w, { FAKE_FAIL_SEED: id });
      expectFail(r, w, { step: "seed", assertion: id });
      expect(callLog(w).filter((l) => l.startsWith("shape-plain after_install"))).toEqual([]);
    },
  );

  it("after_install failure: step=shape, update never runs", () => {
    const w = buildWorld();
    const r = runCell(w, { FAKE_FAIL_SHAPE_VERB: "after_install" });
    expectFail(r, w, { step: "shape", assertion: "shape-exited-0" });
    expect(callLog(w).filter((l) => l.startsWith("new-install"))).toEqual([]);
  });

  it("update exiting non-zero: step=update update-exited-0, with the installer's line as detail", () => {
    const w = buildWorld();
    const r = runCell(w, { FAKE_FAIL_UPDATE: "1" });
    expectFail(r, w, { step: "update", assertion: "update-exited-0" });
    expect(r.last).toContain("COMPOSE_FILE");
    expect(callLog(w).filter((l) => l.startsWith("shape-plain assert"))).toEqual([]);
  });

  it("update exiting 0 without the preflight line: preflight-accepted", () => {
    const w = buildWorld();
    const r = runCell(w, { FAKE_NO_PREFLIGHT: "1" });
    expectFail(r, w, { step: "update", assertion: "preflight-accepted" });
  });

  it("ORBIT_IMAGE naming another digest: image-is-candidate", () => {
    const w = buildWorld();
    const r = runCell(w, { FAKE_IMAGE_DIGEST: WRONG_DIGEST });
    expectFail(r, w, { step: "assert", assertion: "image-is-candidate" });
    expect(callLog(w).filter((l) => l.startsWith("shape-plain assert"))).toEqual([]);
  });

  it("running container on another digest: image-is-candidate", () => {
    const w = buildWorld();
    const r = runCell(w, { FAKE_RUNNING_DIGEST: WRONG_DIGEST });
    expectFail(r, w, { step: "assert", assertion: "image-is-candidate" });
  });

  it.each(["env-file-intact", "overlay-composed", "secret-file-referenced", "oidc-intact"])(
    "shape assert failure %s is passed through; readback never runs",
    (id) => {
      const w = buildWorld();
      const r = runCell(w, { FAKE_FAIL_SHAPE_VERB: "assert", FAKE_ASSERTION: id });
      expectFail(r, w, { step: "assert", assertion: id });
      expect(callLog(w).filter((l) => l.startsWith("seed readback"))).toEqual([]);
    },
  );

  it.each(["health-ready", "item-readable", "document-readable"])("readback failure %s: step=assert", (id) => {
    const w = buildWorld();
    const r = runCell(w, { FAKE_FAIL_READBACK: id });
    expectFail(r, w, { step: "assert", assertion: id });
  });

  it("a failure still runs clean-up", () => {
    const w = buildWorld();
    runCell(w, { FAKE_FAIL_INSTALL: "1" });
    expect(callLog(w).join("\n")).toMatch(/docker compose .*down/);
  });

  it("detail is one line of at most 200 characters even for a 600-character multi-line failure", () => {
    const w = buildWorld();
    const r = runCell(w, { FAKE_FAIL_INSTALL: "1" });
    expect(r.last).not.toContain("\n");
    expect(/detail="([^"]*)"$/.exec(r.last)[1].length).toBeLessThanOrEqual(200);
  });
});

describe("upgrade-cell.sh: clean-up failure", () => {
  it("prints the PASS verdict last and still exits 0 when compose down fails", () => {
    const w = buildWorld();
    const r = runCell(w, { FAKE_FAIL_CLEANUP: "1" });
    expect(r.status, r.all).toBe(0);
    expect(r.last).toMatch(/^upgrade-cell PASS /);
    expect(r.stdout.trimEnd().split("\n").at(-1)).toBe(r.last);
    expect(verdictLines(r)).toHaveLength(1);
  });

  it("prints the FAIL verdict last and exits 1 when the step and clean-up both fail", () => {
    const w = buildWorld();
    const r = runCell(w, { FAKE_FAIL_CLEANUP: "1", FAKE_FAIL_UPDATE: "1" });
    expect(r.status).toBe(1);
    expect(r.stdout.trimEnd().split("\n").at(-1)).toMatch(/^upgrade-cell FAIL .* step=update assertion=update-exited-0 /);
    expect(verdictLines(r)).toHaveLength(1);
    expect(failureMessage(junit(w, "latest-1", "plain"))).toBe(r.last);
  });
});

describe("upgrade-cell.sh: no secrets", () => {
  it.each([{}, { FAKE_FAIL_INSTALL: "1" }, { FAKE_FAIL_SEED: "claim-accepted" }, { FAKE_FAIL_UPDATE: "1" }])(
    "never prints the claim code, a token or an env-only secret (%j)",
    (overrides) => {
      const w = buildWorld();
      const r = runCell(w, overrides);
      expect(r.status === 0 || r.status === 1).toBe(true);
      expectNoSecrets(r, w);
    },
  );
});
