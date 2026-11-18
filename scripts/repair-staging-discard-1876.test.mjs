import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { runOwner } from "./repair-owner-fixtures.mjs";
import { privShims, realTool } from "./repair-priv-shims.mjs";
import { makeFixture, scratchDir, scriptsDir, treeSnapshot } from "./repair-test-harness.mjs";

// #1876: repair never leaves a half-removed folder that still has the staging name. Both removals in
// do_restore_transaction first rename `.orbit-install-staging.<x>` to `.orbit-repair-discard.<x>` (a tombstone), then
// delete that name; repair never reads a `.orbit-repair-discard.*`; the next --execute removes a leftover one, without
// following symlinks. Written from the spec alone, on the #1872 shims (root is simulated by PATH shims).

vi.setConfig({ testTimeout: 90_000 });

const STAGING = ".orbit-install-staging.abc123";
const DISCARD = ".orbit-repair-discard.abc123";
const RUNNING = { db: "running", app: "running" };
const DONE = "execute action=restore-transaction resolves=staging-evidence-present result=done";
const FAILED = "execute action=restore-transaction resolves=staging-evidence-present result=failed";
const ENV_BYTES = "APP_URL=https://orbit.old-good-state.internal\nCOMPOSE_PROJECT_NAME=repairtest\n";
const COMPOSE_BYTES = "services:\n  orbit-app:\n    image: old-good\n";
const names = (targetDir, prefix) => readdirSync(targetDir).filter((entry) => entry.startsWith(prefix));
const staged = (targetDir) => names(targetDir, ".orbit-install-staging.");
const discarded = (targetDir) => names(targetDir, ".orbit-repair-discard.");

function stagingIn(targetDir) {
  const original = join(targetDir, STAGING, "rollback", "original");
  mkdirSync(original, { recursive: true, mode: 0o700 });
  for (const dir of [join(targetDir, STAGING), join(targetDir, STAGING, "rollback"), original]) chmodSync(dir, 0o700);
  return original;
}

/** A finished-restore scenario: the saved files differ from the live ones, plus a live file the install created. */
function restoreFolder() {
  const targetDir = makeFixture();
  const original = stagingIn(targetDir);
  writeFileSync(join(original, ".env-orbit"), ENV_BYTES, { mode: 0o600 });
  writeFileSync(join(original, "docker-compose.yml"), COMPOSE_BYTES);
  writeFileSync(join(targetDir, "docker-compose.mail.yml"), "services: {}\n");
  return { targetDir, state: { ...RUNNING } };
}

/** A no-op scenario: every saved file is byte- and mode-identical to the live one. */
function noopFolder() {
  const targetDir = makeFixture();
  const original = stagingIn(targetDir);
  for (const path of ["docker-compose.yml", ".env-orbit", ".env-orbit.example", "scripts/configure.sh", "scripts/installer-ui.sh", "scripts/repair.sh", ".orbit-secrets"]) {
    mkdirSync(dirname(join(original, path)), { recursive: true });
    cpSync(join(targetDir, path), join(original, path), { recursive: true, preserveTimestamps: true });
    spawnSync("chmod", ["--reference", join(targetDir, path), join(original, path)]);
  }
  return { targetDir, state: { ...RUNNING } };
}

/** What a kill part way through `rm -rf` of a staging folder leaves: the folder, with some saved entries already gone. */
function halfDeletedDiscard(targetDir) {
  const original = join(targetDir, DISCARD, "rollback", "original");
  mkdirSync(original, { recursive: true, mode: 0o700 });
  for (const dir of [join(targetDir, DISCARD), join(targetDir, DISCARD, "rollback"), original]) chmodSync(dir, 0o700);
  writeFileSync(join(original, "docker-compose.mail.yml"), "services: {}\n");
}

/** Stub commands first on PATH (the way the other repair tests stub); `shims` logs calls and keeps the PATH. */
function withStubs(targetDir, stubs) {
  const shims = privShims(targetDir, { root: false });
  const dir = scratchDir("orbit-discard-stubs-");
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return { ...shims, env: { ...shims.env, PATH: `${dir}:${shims.env.PATH}` } };
}

// rm that dies part way: removes one saved entry, then fails, for any staging or discard name.
const RM_DIES = `hit=0
for a in "$@"; do case "$a" in *.orbit-install-staging.*|*.orbit-repair-discard.*) hit=\${a%%/*}; hit=$a;; esac; done
if [[ "$hit" != 0 ]]; then
  for a in "$@"; do case "$a" in -*) ;; *) '${realTool("rm")}' -rf -- "$a/rollback/original/.env-orbit" "$a/rollback/original/docker-compose.yml";; esac; done
  echo "rm: interrupted" >&2
  exit 1
fi
exec '${realTool("rm")}' "$@"`;
// mv that refuses to rename onto a tombstone name.
const MV_REFUSES = `for a in "$@"; do case "$a" in *.orbit-repair-discard.*) echo "mv: cannot move: Input/output error" >&2; exit 1;; esac; done
exec '${realTool("mv")}' "$@"`;

const runRestore = (folder, shims, args = ["--execute", "--safe-only"]) => runOwner(folder.targetDir, { shims, state: folder.state, args, input: "y\n", capSeconds: 60 });
const plainShims = (targetDir) => privShims(targetDir, { root: false });

describe("#1876: no staging or discard folder remains after a clean removal", () => {
  it("a no-op removal leaves neither a .orbit-install-staging.* nor a .orbit-repair-discard.* folder", () => {
    const folder = noopFolder();
    const result = runRestore(folder, plainShims(folder.targetDir));
    expect(result.stderr).toContain(`removed ${STAGING}; no install is running and restoring from it would change nothing`);
    expect(staged(folder.targetDir)).toEqual([]);
    expect(discarded(folder.targetDir)).toEqual([]);
  });

  it("a finished restore leaves neither a .orbit-install-staging.* nor a .orbit-repair-discard.* folder", () => {
    const folder = restoreFolder();
    const result = runRestore(folder, plainShims(folder.targetDir));
    expect(result.stdout, result.stderr).toContain(DONE);
    expect(readFileSync(join(folder.targetDir, ".env-orbit"), "utf8")).toBe(ENV_BYTES);
    expect(staged(folder.targetDir)).toEqual([]);
    expect(discarded(folder.targetDir)).toEqual([]);
  });

  it("the no-op removal still tells the operator the staging folder was removed, by its staging name", () => {
    const folder = noopFolder();
    const result = runRestore(folder, plainShims(folder.targetDir));
    expect(result.stderr).toContain(`Orbit repair: removed ${STAGING}; no install is running and restoring from it would change nothing (every saved file matches the live one).`);
    expect(result.stderr).not.toContain(".orbit-repair-discard");
  });
});

describe("#1876: an rm that fails part way never leaves a folder that can be read as an interrupted install", () => {
  for (const [what, make] of [["a no-op removal", noopFolder], ["the end of a finished restore", restoreFolder]]) {
    it(`${what}: after rm dies part way no folder has the staging name`, () => {
      const folder = make();
      const shims = withStubs(folder.targetDir, { rm: RM_DIES });
      runRestore(folder, shims);
      expect(staged(folder.targetDir), "a half-removed folder still has the staging name").toEqual([]);
    });
  }

  it("a repair run after a killed removal leaves the live docker-compose.yml and .env-orbit untouched", () => {
    const folder = noopFolder();
    const compose = readFileSync(join(folder.targetDir, "docker-compose.yml"));
    const env = readFileSync(join(folder.targetDir, ".env-orbit"));
    runRestore(folder, withStubs(folder.targetDir, { rm: RM_DIES }));
    const second = runRestore({ ...folder }, plainShims(folder.targetDir));
    expect(second.stdout).not.toContain(DONE);
    expect(readFileSync(join(folder.targetDir, "docker-compose.yml"))).toEqual(compose);
    expect(readFileSync(join(folder.targetDir, ".env-orbit"))).toEqual(env);
    expect(existsSync(join(folder.targetDir, "docker-compose.yml"))).toBe(true);
  });
});

describe("#1876: a half-deleted .orbit-repair-discard.* is never restored from and the next --execute removes it", () => {
  function liveFolder() {
    const targetDir = makeFixture();
    halfDeletedDiscard(targetDir);
    return { targetDir, state: { ...RUNNING } };
  }

  it("--execute leaves docker-compose.yml and .env-orbit byte-identical and removes the discard folder", () => {
    const folder = liveFolder();
    const compose = readFileSync(join(folder.targetDir, "docker-compose.yml"));
    const env = readFileSync(join(folder.targetDir, ".env-orbit"));
    const result = runRestore(folder, plainShims(folder.targetDir));
    expect(result.stdout + result.stderr).not.toContain(DONE);
    expect(readFileSync(join(folder.targetDir, "docker-compose.yml"))).toEqual(compose);
    expect(readFileSync(join(folder.targetDir, ".env-orbit"))).toEqual(env);
    expect(discarded(folder.targetDir), "the leftover discard folder is still there").toEqual([]);
  });

  it("--check leaves the discard folder exactly as it was and reports no staging evidence", () => {
    const folder = liveFolder();
    const before = treeSnapshot(folder.targetDir);
    const result = runRestore(folder, plainShims(folder.targetDir), ["--check"]);
    expect(result.stdout + result.stderr).not.toContain("staging-evidence-present");
    expect(discarded(folder.targetDir)).toEqual([DISCARD]);
    expect(treeSnapshot(folder.targetDir)).toBe(before);
  });

  it("--plan leaves the discard folder exactly as it was", () => {
    const folder = liveFolder();
    const before = treeSnapshot(folder.targetDir);
    runRestore(folder, plainShims(folder.targetDir), ["--plan"]);
    expect(treeSnapshot(folder.targetDir)).toBe(before);
  });

  it("--execute removes the discard folder without following a symlink inside it", () => {
    const folder = liveFolder();
    const outside = scratchDir("orbit-discard-outside-");
    writeFileSync(join(outside, "keep.txt"), "keep\n");
    symlinkSync(outside, join(folder.targetDir, DISCARD, "link-to-outside"));
    runRestore(folder, plainShims(folder.targetDir));
    expect(discarded(folder.targetDir)).toEqual([]);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep\n");
  });

  it("a .orbit-repair-discard.* that is a symlink is not removed, and what it points at is untouched", () => {
    const folder = { targetDir: makeFixture(), state: { ...RUNNING } };
    const outside = scratchDir("orbit-discard-outside-");
    writeFileSync(join(outside, "keep.txt"), "keep\n");
    symlinkSync(outside, join(folder.targetDir, DISCARD));
    runRestore(folder, plainShims(folder.targetDir));
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep\n");
    expect(spawnSync("test", ["-L", join(folder.targetDir, DISCARD)]).status, "the symlink was removed or replaced").toBe(0);
  });
});

describe("#1876: a failed rename deletes nothing and fails the step as before", () => {
  for (const [what, make] of [["a no-op removal", noopFolder], ["the end of a finished restore", restoreFolder]]) {
    it(`${what}: with the rename refused the staging folder and everything in it is still there`, () => {
      const folder = make();
      const stagingBefore = spawnSync("bash", ["-c", `find ${STAGING} -printf '%p %m %s %y\\n' | LC_ALL=C sort`], { cwd: folder.targetDir, encoding: "utf8" }).stdout;
      const shims = withStubs(folder.targetDir, { mv: MV_REFUSES });
      const result = runRestore(folder, shims);
      expect(result.stderr + result.stdout).not.toContain(`removed ${STAGING}`);
      expect(staged(folder.targetDir)).toEqual([STAGING]);
      expect(discarded(folder.targetDir)).toEqual([]);
      const stagingAfter = spawnSync("bash", ["-c", `find ${STAGING} -printf '%p %m %s %y\\n' | LC_ALL=C sort`], { cwd: folder.targetDir, encoding: "utf8" }).stdout;
      expect(stagingAfter).toBe(stagingBefore);
    });
  }

  it("the finished restore whose final rename is refused reports the restore step as failed, not done", () => {
    const folder = restoreFolder();
    const result = runRestore(folder, withStubs(folder.targetDir, { mv: MV_REFUSES }));
    expect(result.stdout).not.toContain(DONE);
    expect(result.stdout).toContain(FAILED);
  });
});

describe("#1876: as root in a folder another user owns, the rename and the removals run as that owner", () => {
  const rootShims = (targetDir) => privShims(targetDir, { extraTools: ["cp", "install", "touch", "ln", "tee"] });
  const setprivNaming = (shims, re) => shims.setprivCalls().filter((line) => re.test(line));
  const rootCalls = (shims, tools) => shims.toolCalls().filter((line) => tools.includes(line.split(" ")[0]) && / marker=0 /u.test(line) && / under=1 /u.test(line));

  for (const [what, make] of [["a no-op removal", noopFolder], ["the end of a finished restore", restoreFolder]]) {
    it(`${what}: the rename to .orbit-repair-discard.* and the rm -rf of it both go through setpriv; root runs neither`, () => {
      const folder = make();
      const shims = rootShims(folder.targetDir);
      runRestore(folder, shims);
      expect(setprivNaming(shims, new RegExp(`mv .*${STAGING.replaceAll(".", "\\.")} .*${DISCARD.replaceAll(".", "\\.")}`, "u")), "the rename was not made as the owner").not.toEqual([]);
      expect(setprivNaming(shims, new RegExp(`rm -rf -- \\S*${DISCARD.replaceAll(".", "\\.")}`, "u")), "the removal was not made as the owner").not.toEqual([]);
      expect(rootCalls(shims, ["rm"]), "root ran rm on a name in the owner's folder").toEqual([]);
      expect(rootCalls(shims, ["mv"]).filter((line) => line.includes("orbit-repair-discard")), "root ran the rename").toEqual([]);
      expect(staged(folder.targetDir)).toEqual([]);
      expect(discarded(folder.targetDir)).toEqual([]);
    });
  }

  it("a leftover .orbit-repair-discard.* at the start of --execute is removed as the owner, never by root", () => {
    const targetDir = makeFixture();
    halfDeletedDiscard(targetDir);
    const shims = rootShims(targetDir);
    runRestore({ targetDir, state: { ...RUNNING } }, shims);
    expect(setprivNaming(shims, new RegExp(`rm .*${DISCARD.replaceAll(".", "\\.")}`, "u")), "the cleanup was not made as the owner").not.toEqual([]);
    expect(rootCalls(shims, ["rm"]), "root ran rm in the owner's folder").toEqual([]);
    expect(discarded(targetDir)).toEqual([]);
  });
});

// The start cleanup runs only once the operator has approved a batch (after the version gate and the confirmation): a
// declined or refused run changes nothing (installer guarantees 33 and 56).
describe("#1876: a declined or refused --execute keeps a leftover .orbit-repair-discard.* folder", () => {
  function leftoverFolder(extra = () => {}) {
    const targetDir = makeFixture();
    extra(targetDir);
    halfDeletedDiscard(targetDir);
    return { targetDir, state: { ...RUNNING } };
  }
  // A safe action is on the table, so the confirmation is really asked.
  const withSafeAction = (targetDir) => chmodSync(join(targetDir, ".orbit-secrets", "postgres-password"), 0o644);

  for (const [what, input] of [["Enter", "\n"], ["end of input", ""]]) {
    it(`an operator who declines with ${what} leaves the discard folder in place`, () => {
      const folder = leftoverFolder(withSafeAction);
      const result = runOwner(folder.targetDir, { shims: plainShims(folder.targetDir), state: folder.state, args: ["--execute", "--safe-only"], input, capSeconds: 60 });
      expect(result.status, result.stderr).toBe(1);
      expect(discarded(folder.targetDir)).toEqual([DISCARD]);
      expect(result.stderr).not.toContain("which an earlier repair run left part removed");
    });
  }

  it("a run that ends with exit 5 (not an Orbit installation) leaves the discard folder in place", () => {
    const targetDir = scratchDir("orbit-discard-notorbit-");
    mkdirSync(join(targetDir, "scripts"));
    writeFileSync(join(targetDir, "scripts", "repair.sh"), readFileSync(join(scriptsDir, "repair.sh")));
    chmodSync(join(targetDir, "scripts", "repair.sh"), 0o755);
    halfDeletedDiscard(targetDir);
    const result = runOwner(targetDir, { shims: plainShims(targetDir), args: ["--execute", "--safe-only"], capSeconds: 60 });
    expect(result.status, result.stderr).toBe(5);
    expect(discarded(targetDir)).toEqual([DISCARD]);
  });

  it("a run refused with exit 6 (deployment version unsupported) leaves the discard folder in place", () => {
    const folder = leftoverFolder((targetDir) => {
      withSafeAction(targetDir);
      const envPath = join(targetDir, ".env-orbit");
      writeFileSync(envPath, readFileSync(envPath, "utf8").split("\n").filter((line) => !line.startsWith("ORBIT_CONFIG_APPLIED_")).join("\n"));
      chmodSync(envPath, 0o600);
    });
    const result = runRestore(folder, plainShims(folder.targetDir));
    expect(result.status, result.stderr).toBe(6);
    expect(result.stdout).toContain("reason=deployment-version-unsupported");
    expect(discarded(folder.targetDir)).toEqual([DISCARD]);
  });

  it("an approved run still removes the leftover", () => {
    const folder = leftoverFolder(withSafeAction);
    const result = runRestore(folder, plainShims(folder.targetDir));
    expect(result.status, result.stderr).toBe(0);
    expect(discarded(folder.targetDir)).toEqual([]);
  });
});

describe("#1876: a refused rename names the path and a next step", () => {
  it("with the discard name already taken by a file at restore time, stderr names that path", () => {
    const folder = restoreFolder();
    writeFileSync(join(folder.targetDir, DISCARD), "in the way\n");
    const result = runRestore(folder, plainShims(folder.targetDir));
    expect(result.stdout).not.toContain(DONE);
    expect(result.stderr, "the refusal is silent").toContain(DISCARD);
    expect(staged(folder.targetDir)).toEqual([STAGING]);
  });
});
