import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import { composeUpCalls, makeFixture, runRepair, scratchDir, treeSnapshot } from "./repair-test-harness.mjs";

// #1848 FIX-S1 follow-up (spec: note 60094, approved in note 60099): run as root, retire-smtp-lines
// does every mutation under the deployment folder as the folder's owner, through
// `setpriv --reuid=U --regid=<U's primary gid> --init-groups --no-new-privs -- <cmd>` (the logrotate `su` /
// OpenSSH `temporarily_use_uid` pattern), and runs no chown. Written from the spec's Acceptance
// section alone. Root is simulated by PATH shims (no real root here): `id -u` prints 0; a `setpriv`
// shim checks its arguments, exports a marker and execs the rest; shims for mktemp, chmod, mv, rm,
// rmdir, mkdir and chown log each call with the marker state, then run the real tool.

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const FAKE_PASSWORD = "TEST-NOT-A-REAL-PASSWORD";
const RUNNING = { db: "running", app: "running" };
const answer = (source, imported = true) => `mail-sending source=${source} imported-from-environment=${imported}`;
const IMPORTED = { ...RUNNING, mailStatus: answer("imported") };
const GATE_FAILS_AFTER = { mailStatusAfterSecretGone: answer("none", false) };
const DONE = "execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done";
const RECORD = ".orbit-smtp-retirement";
const UID = process.getuid();
const GID = process.getgid();
const OVERLAY_MODE = "640";

function withMail() {
  const targetDir = makeFixture();
  const envPath = join(targetDir, ".env-orbit");
  const lines = [
    "COMPOSE_FILE=docker-compose.yml:docker-compose.mail.yml",
    "SMTP_HOST=smtp.example.test",
    "SMTP_PORT=587",
    "SMTP_SECURITY=starttls",
    "SMTP_USER=orbit@example.test",
    `SMTP_PASSWORD=${FAKE_PASSWORD}`,
    "SMTP_FROM=Orbit <orbit@example.test>",
    "",
  ];
  writeFileSync(envPath, `${readFileSync(envPath, "utf8")}${lines.join("\n")}`);
  chmodSync(envPath, 0o600);
  const overlay = join(targetDir, "docker-compose.mail.yml");
  writeFileSync(overlay, "services:\n  orbit-app:\n    secrets:\n      - orbit-smtp-password\n");
  chmodSync(overlay, Number.parseInt(OVERLAY_MODE, 8));
  writeFileSync(join(targetDir, ".orbit-secrets", "smtp-password"), FAKE_PASSWORD);
  chmodSync(join(targetDir, ".orbit-secrets", "smtp-password"), 0o600);
  return targetDir;
}

const realTool = (name) => spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
const modeOf = (path) => (statSync(path).mode & 0o777).toString(8);
const secretPath = (targetDir) => join(targetDir, ".orbit-secrets", "smtp-password");
const envOf = (targetDir) => readFileSync(join(targetDir, ".env-orbit"), "utf8");
const findIn = (targetDir, args) => spawnSync("find", [targetDir, ...args], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
const envBackups = (targetDir) => findIn(targetDir, ["-type", "f", "-name", ".env-orbit*", "-not", "-path", join(targetDir, ".env-orbit"), "-not", "-name", ".env-orbit.example"]);
const TOOLS = ["mktemp", "chmod", "mv", "rm", "rmdir", "mkdir"];

// Bash source of each tool shim (String.raw, so bash's own ${...} is not JS interpolation; __TOKENS__ are filled in).
// Besides the marker log, each call records what the process it runs in actually inherited, read from /proc at
// the moment the tool starts (the real child of setpriv, whatever the code put in between): open fds other than
// 0-2, where stdin points, the session id, and the parent's command line (to tell the owner-write script,
// whose stdin legitimately carries the bytes, from every other child).
const TOOL_SHIM = String.raw`under=0
for a in "$@"; do
  [[ "$a" == -* ]] && continue
  case "$a" in /*) p="$a";; *) p="$PWD/$a";; esac
  case "$p" in '__TARGET__'|'__TARGET__'/*) under=1;; esac
done
find /proc/$$/fd -mindepth 1 -printf '%f:%l\n' > '__FDLIST__' 2>/dev/null
fds=""
while IFS=: read -r n t; do
  case "$n" in 0|1|2|255) continue;; esac
  case "$t" in /proc/*/fd) continue;; esac
  fds="$fds $n:$t"
done < '__FDLIST__'
si="$(readlink /proc/$$/fd/0 2>/dev/null)"
sid="$(sed 's/.*) //' /proc/$$/stat | cut -d' ' -f4)"
pcmd="$(tr '\0' ' ' < /proc/$PPID/cmdline 2>/dev/null)"
printf '%s|%s|%s|%s|%s|%s\n' '__TOOL__' "\${ORBIT_TEST_PRIVDROP:-0}" "$sid" "$si" "$fds" "$pcmd" >> '__CHILDLOG__'
printf '%s|%s|%s|%s|%s\n' '__TOOL__' "\${ORBIT_TEST_PRIVDROP:-0}" "$(export -p | grep -c 'secret-marker-1848')" "\${HOME-}:\${USER-}:\${LOGNAME-}" "$(compgen -e | tr '\n' ' ')" >> '__ENVLOG__'
__FAILRULE__
printf '%s marker=%s under=%s cwd=%s args=%s\n' '__TOOL__' "\${ORBIT_TEST_PRIVDROP:-0}" "$under" "$PWD" "$*" >> '__TOOLLOG__'
exec '__REAL__' "$@"
`.replaceAll("\\${", "${");

// stat shim: lies about what a simulated run cannot make true without a second user. For the folder ".": the
// group (%g, %G) becomes a gid that is not the test user's primary group. For ".orbit-secrets" (dir) or
// ".orbit-secrets/smtp-password" (file): the owner (%u, %U) becomes root.
const STAT_SHIM = String.raw`args=("$@"); last="\${args[$((\${#args[@]} - 1))]}"
if [[ "$last" == . || "$last" == ./ ]] && [[ -n '__FAKEGID__' ]]; then
  for i in "\${!args[@]}"; do
    args[$i]="\${args[$i]//%g/__FAKEGID__}"; args[$i]="\${args[$i]//%G/orbit-fake-group}"
  done
fi
case "$last" in
  *.orbit-secrets/smtp-password) lie=file;;
  *.orbit-secrets|*.orbit-secrets/) lie=dir;;
  *) lie="";;
esac
if [[ -n "$lie" && "$lie" == '__ROOTOWNED__' ]]; then
  for i in "\${!args[@]}"; do
    args[$i]="\${args[$i]//%u/0}"; args[$i]="\${args[$i]//%U/root}"
  done
fi
exec '__REAL__' "\${args[@]}"
`.replaceAll("\\${", "${");

/**
 * Builds the shim directory. `setpriv: false` leaves setpriv off PATH altogether (every other executable of the
 * original PATH is linked into a private bin, setpriv excepted). `folderGid` makes `stat` report that gid for the
 * deployment folder; `rootOwned` ("dir" or "file") makes it report root as the owner of .orbit-secrets or its
 * secret file. Logs, one line each:
 *   tools.log:   "<tool> marker=<0|1> under=<0|1> cwd=<cwd> args=<args>"   (under: names a path under the folder)
 *   child.log:   "<tool>|<marker>|<session id>|<stdin target>|<extra fds>|<parent command line>"
 *   setpriv.log: "<argv of the setpriv call>"   (and "BAD <argv>" when it lacks the three required options; exit 99)
 *   chown.log:   "<argv>"
 */
function privShims(targetDir, { root = true, setpriv = true, setprivFail = null, folderGid = null, rootOwned = null, omit = [], getent = null, setsid = null, toolFail = null, dbGid = GID } = {}) {
  const dir = scratchDir("orbit-repair-privdrop-shims-");
  const toolLog = join(dir, "tools.log");
  const privLog = join(dir, "setpriv.log");
  const chownLog = join(dir, "chown.log");
  const childLog = join(dir, "child.log");
  const envLog = join(dir, "env.log");
  const idLog = join(dir, "id.log");
  const write = (name, body) => {
    writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}`);
    chmodSync(join(dir, name), 0o755);
  };
  if (root) write("id", `printf '%s\\n' "$(readlink /proc/$$/fd/0)" >> '${idLog}'\nif [[ $# -eq 1 && "$1" == -u ]]; then echo 0; exit 0; fi\nexec '${realTool("id")}' "$@"\n`);
  if (setpriv) {
    // The group options are not checked here (acceptance 3 reads the log); the user and no-new-privs are.
    write(
      "setpriv",
      `printf '%s\\n' "$*" >> '${privLog}'
ok=0
[[ " $* " == *" --reuid=${UID} "* && " $* " == *" --regid=${dbGid} "* && " $* " == *" --no-new-privs "* ]] && ok=1
if [[ $ok -ne 1 ]]; then printf 'BAD %s\\n' "$*" >> '${privLog}'; exit 99; fi
case "$*" in ${setprivFail ?? "__never__"}) exit 1;; esac
while [[ $# -gt 0 && "$1" != -- ]]; do shift; done
shift
export ORBIT_TEST_PRIVDROP=1
exec "$@"
`,
    );
  }
  for (const tool of TOOLS) {
    const rule = toolFail?.tool === tool ? `if [[ "\${ORBIT_TEST_PRIVDROP:-0}" == 1 ]]; then case "$*" in ${toolFail.match}) ${toolFail.emit}${toolFail.pass ? "" : "; exit 1"};; esac; fi` : "";
    write(tool, TOOL_SHIM.replaceAll("__FAILRULE__", rule).replaceAll("__ENVLOG__", envLog).replaceAll("__TARGET__", targetDir).replaceAll("__TOOL__", tool).replaceAll("__CHILDLOG__", childLog).replaceAll("__FDLIST__", join(dir, "fds.tmp")).replaceAll("__TOOLLOG__", toolLog).replaceAll("__REAL__", realTool(tool)));
  }
  if (folderGid !== null || rootOwned !== null) {
    write("stat", STAT_SHIM.replaceAll("__FAKEGID__", folderGid === null ? "" : String(folderGid)).replaceAll("__ROOTOWNED__", rootOwned ?? "none").replaceAll("__REAL__", realTool("stat")));
  }
  // getent: null (the real one), "fail" (exit 2, no output), or a gid string (an entry for the test user with that primary gid).
  if (getent === "fail") write("getent", "exit 2\n");
  else if (getent !== null) write("getent", `if [[ "$1" == passwd && "$2" == ${UID} ]]; then echo '${USER_NAME}:x:${UID}:${getent}:test:/nonexistent:/bin/sh'; exit 0; fi\nexec '${realTool("getent")}' "$@"\n`);
  // setsid: null (the real one) or "no-wait" (util-linux before 2.31: rejects --wait).
  if (setsid === "no-wait") {
    write("setsid", `for a in "$@"; do if [[ "$a" == --wait || "$a" == -w ]]; then echo "setsid: unrecognized option '--wait'" >&2; exit 1; fi; done\ncase "$1" in --version|-V) echo 'setsid from util-linux 2.30';; --help|-h) echo 'Usage: setsid [options] <program> [arguments ...]'; exit 0;; esac\nexec '${realTool("setsid")}' "$@"\n`);
  }
  write("chown", `printf '%s\\n' "$*" >> '${chownLog}'\nexec '${realTool("chown")}' "$@"\n`);
  let path = `${dir}:${process.env.PATH}`;
  const omitted = new Set([...omit, ...(setpriv ? [] : ["setpriv"])]);
  if (omitted.size > 0) {
    const bin = scratchDir("orbit-repair-privdrop-bin-");
    for (const part of (process.env.PATH ?? "").split(":").filter(Boolean)) {
      if (!existsSync(part)) continue;
      for (const name of readdirSync(part)) {
        if (omitted.has(name) || existsSync(join(bin, name))) continue;
        try {
          symlinkSync(join(part, name), join(bin, name));
        } catch {
          // a name that cannot be linked is not needed
        }
      }
    }
    path = `${dir}:${bin}`;
  }
  const read = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
  const children = () =>
    read(childLog).map((line) => {
      const [tool, marker, sid, stdin, fds, ...rest] = line.split("|");
      return { tool, marker, sid, stdin, fds: fds.trim(), parent: rest.join("|"), line };
    });
  return {
    env: { ORBIT_REPAIR_PROMPTS: "machine", PATH: path },
    toolCalls: () => read(toolLog),
    setprivCalls: () => read(privLog),
    chownCalls: () => read(chownLog),
    envRecords: () => read(envLog).map((line) => { const [tool, marker, leak, ids, names] = line.split("|"); return { tool, marker, leak: Number(leak), ids, names: names.trim().split(/\s+/u).filter(Boolean), line }; }),
    idStdin: () => read(idLog),
    children,
  };
}

const run = (targetDir, shims, { env: envExtra = {}, ...extra } = {}) =>
  runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, ...extra, env: { ...shims.env, ...envExtra }, input: "y\n" });

/** Every shimmed tool call that names a path under the folder ran with the marker set. */
function expectAllUnderSetpriv(shims) {
  // FIX-S1 addendum: the restore lock's folder and file under backups/ are made as the owner too, so nothing is excluded.
  const under = shims.toolCalls().filter((line) => / under=1 /u.test(line));
  expect(under.length, `no mktemp/chmod/mv/rm/rmdir/mkdir call named a path under the folder:\n${shims.toolCalls().join("\n")}`).toBeGreaterThan(0);
  const bare = under.filter((line) => !/ marker=1 /u.test(line));
  expect(bare, "calls under the deployment folder made by root, outside setpriv").toEqual([]);
  expect(shims.setprivCalls().filter((line) => line.startsWith("BAD ")), "setpriv called without the required options").toEqual([]);
  for (const line of shims.setprivCalls()) {
    expect(line).toContain(`--reuid=${UID}`);
    expect(line).toContain(`--regid=${GID}`);
    expect(line).toContain("--no-new-privs");
  }
  return under;
}

const notOwnedByTestUser = (targetDir) => findIn(targetDir, ["(", "-not", "-uid", String(UID), "-o", "-not", "-gid", String(GID), ")"]);

describe("#1848 FIX-S1 acceptance 1: every mutation under the folder runs under setpriv; no chown", () => {
  it("each mktemp, chmod, mv, rm, rmdir and mkdir that names a path under the folder runs under the setpriv shim; chown never runs", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir);
    const result = run(targetDir, shims);
    expect(result.stdout, result.stderr).toContain(DONE);
    const under = expectAllUnderSetpriv(shims);
    expect(shims.setprivCalls().length).toBeGreaterThan(0);
    // The kinds of mutation the action makes: each is among the calls checked.
    for (const tool of ["mktemp", "chmod", "mv", "rm", "mkdir"]) {
      expect(under.some((line) => line.startsWith(`${tool} `)), `no ${tool} call under the folder was seen:\n${shims.toolCalls().join("\n")}`).toBe(true);
    }
    expect(shims.chownCalls(), "chown was run by retire-smtp-lines under simulated root").toEqual([]);
  });

  it("the same holds when the undo copy is kept (mail sending not confirmed afterwards): record, marker, copies and cleanup all run under setpriv", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir);
    const result = run(targetDir, shims, GATE_FAILS_AFTER);
    expect(result.stdout, result.stderr).toContain(DONE);
    expectAllUnderSetpriv(shims);
    expect(shims.chownCalls()).toEqual([]);
  });

  it("a failed start (the record lingers) also keeps every mutation under setpriv, and a later run finishes", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir);
    const first = run(targetDir, shims, { upFails: true });
    expect(first.stdout).not.toContain(DONE);
    expectAllUnderSetpriv(shims);
    expect(shims.chownCalls()).toEqual([]);
  });

  it("docker calls are not under setpriv (they are not mutations of the folder): the run still starts the stack", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir);
    const result = run(targetDir, shims);
    expect(composeUpCalls(result).length).toBeGreaterThan(0);
  });
});

describe("#1848 FIX-S1 acceptance 2: the results are as before", () => {
  it("rewrite, secret and overlay gone; no SMTP lines; modes 600; nothing owned by anyone else; no leftovers (mail sending confirmed)", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir);
    const result = run(targetDir, shims);
    expect(result.stdout, result.stderr).toContain(DONE);
    expect(shims.setprivCalls().length, "the run never used setpriv").toBeGreaterThan(0);
    expect(envOf(targetDir)).not.toMatch(/^(SMTP_[A-Z_]+|COMPOSE_FILE=.*docker-compose\.mail\.yml)/mu);
    expect(modeOf(join(targetDir, ".env-orbit"))).toBe("600");
    expect(existsSync(secretPath(targetDir))).toBe(false);
    expect(existsSync(join(targetDir, "docker-compose.mail.yml"))).toBe(false);
    expect(existsSync(join(targetDir, RECORD))).toBe(false);
    expect(readdirSync(targetDir).filter((name) => /^\.(orbit-smtp-retirement|env-orbit\.retire-smtp)\./u.test(name))).toEqual([]);
    expect(notOwnedByTestUser(targetDir)).toEqual([]);
  });

  it("kept undo copy: copy, overlay copy (the overlay's own mode, not cp -a), marker, record and both folders have the stated modes and owner", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir);
    const result = run(targetDir, shims, GATE_FAILS_AFTER);
    expect(result.stdout, result.stderr).toContain(DONE);
    expect(shims.setprivCalls().length, "the run never used setpriv").toBeGreaterThan(0);
    expect(modeOf(join(targetDir, ".env-orbit"))).toBe("600");
    expect(modeOf(join(targetDir, RECORD))).toBe("600");
    const root = join(targetDir, "orbit-install-backups");
    expect(modeOf(root)).toBe("700");
    const [dated] = readdirSync(root);
    const folder = join(root, dated);
    expect(modeOf(folder)).toBe("700");
    expect(modeOf(join(folder, ".env-orbit"))).toBe("600");
    expect(modeOf(join(folder, ".orbit-smtp-undo"))).toBe("600");
    expect(modeOf(join(folder, "docker-compose.mail.yml"))).toBe(OVERLAY_MODE);
    expect(readFileSync(join(folder, ".env-orbit"), "utf8")).not.toContain(FAKE_PASSWORD);
    expect(notOwnedByTestUser(targetDir)).toEqual([]);
  });
});

const BACKUPS_NAME = /(^|[ /])backups([/ ]|$)/u;
const LOCK_NAME = /orbit-backup-restore\.lock/u;
const lockAndFolder = (targetDir) => [join(targetDir, "backups"), join(targetDir, "backups", ".orbit-backup-restore.lock")];

// FIX-S1 addendum, acceptance a: root no longer creates the backups folder or the restore lock itself.
describe("#1848 FIX-S1 addendum a: the restore lock's folder and file are made as the folder's owner", () => {
  it("with no backups/ folder, both are created, and every tool call naming them (and the lock) runs under setpriv", () => {
    const targetDir = withMail();
    expect(existsSync(join(targetDir, "backups"))).toBe(false);
    const shims = privShims(targetDir);
    const result = run(targetDir, shims);
    expect(result.stdout, result.stderr).toContain(DONE);
    const [folder, lock] = lockAndFolder(targetDir);
    expect(existsSync(folder) && existsSync(lock), "backups/ or its lock file was not created").toBe(true);
    const calls = shims.setprivCalls().filter((line) => !line.startsWith("BAD "));
    expect(calls.some((line) => BACKUPS_NAME.test(line)), `no setpriv call names backups/:\n${calls.join("\n")}`).toBe(true);
    expect(calls.some((line) => LOCK_NAME.test(line) || / backups$/u.test(line)), `no setpriv call makes the lock:\n${calls.join("\n")}`).toBe(true);
    const bare = shims.toolCalls().filter((line) => / under=1 /u.test(line) && BACKUPS_NAME.test(line) && !/ marker=1 /u.test(line));
    expect(bare, "root made something under backups/ itself").toEqual([]);
    expect(notOwnedByTestUser(targetDir)).toEqual([]);
  });

  it("when the owner's creation of the backups folder fails, the O-F5 refusal applies: exit 4, nothing created, no start", () => {
    const targetDir = withMail();
    // Fails any setpriv call naming backups/ (the dated undo folders are under orbit-install-backups, which comes later).
    const shims = privShims(targetDir, { setprivFail: '*" backups"*|*"/backups"*|*" ./backups"*' });
    const before = treeSnapshot(targetDir);
    const result = run(targetDir, shims);
    expect(result.stdout).not.toContain(DONE);
    expect(result.stderr).toMatch(/retire-smtp-lines refused, nothing was changed: .*can't create the backups folder/u);
    expect(result.status).toBe(4);
    expect(existsSync(join(targetDir, "backups")), "root made backups/ itself when the owner's creation failed").toBe(false);
    expect(composeUpCalls(result)).toEqual([]);
    expect(treeSnapshot(targetDir)).toBe(before);
  });

  it("when the folder exists but the lock file does not, only the lock file is created, as the owner", () => {
    const targetDir = withMail();
    mkdirSync(join(targetDir, "backups"), { mode: 0o700 });
    const shims = privShims(targetDir);
    const result = run(targetDir, shims);
    expect(result.stdout, result.stderr).toContain(DONE);
    expect(existsSync(lockAndFolder(targetDir)[1])).toBe(true);
    const calls = shims.setprivCalls().filter((line) => LOCK_NAME.test(line) || BACKUPS_NAME.test(line));
    expect(calls.length, "the lock file was not made through setpriv").toBeGreaterThan(0);
  });

  it("with the folder and lock already present, root only opens the lock: no setpriv call names them", () => {
    const targetDir = withMail();
    const [folder, lock] = lockAndFolder(targetDir);
    mkdirSync(folder, { mode: 0o700 });
    writeFileSync(lock, "", { mode: 0o600 });
    const shims = privShims(targetDir);
    const result = run(targetDir, shims);
    expect(result.stdout, result.stderr).toContain(DONE);
    expect(shims.setprivCalls().filter((line) => LOCK_NAME.test(line) || BACKUPS_NAME.test(line))).toEqual([]);
  });

  it("not root: the folder and lock are created directly, with no setpriv call", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir, { root: false });
    const result = run(targetDir, shims);
    expect(result.stdout, result.stderr).toContain(DONE);
    expect(shims.setprivCalls()).toEqual([]);
    expect(existsSync(lockAndFolder(targetDir)[1])).toBe(true);
  });
});

// Acceptance b and c: a root-owned (or other-user-owned) folder under a run that must refuse needs real file
// ownership, which an unprivileged run cannot fake. Opt-in, for the owner to run as root with a second user:
//   sudo ORBIT_TEST_OTHER_USER=<user> npx vitest run scripts/repair-retire-privdrop-1848.test.mjs
describe("#1848 FIX-S1 addendum b, c (opt-in, needs root and a second user)", () => {
  const other = process.env.ORBIT_TEST_OTHER_USER ?? "nobody";
  const otherId = (flag) => Number(spawnSync("id", [flag, other], { encoding: "utf8" }).stdout.trim());
  const realRoot = process.getuid?.() === 0;
  const realRun = (targetDir) => runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, env: { ORBIT_REPAIR_PROMPTS: "machine" }, input: "y\n" });
  /** A fixture whose folder (not backups/) is owned by `owner` ("other" or "root"), world-searchable. */
  function ownedFixture(owner) {
    const targetDir = withMail();
    if (owner === "other") spawnSync("chown", ["-R", `${otherId("-u")}:${otherId("-g")}`, targetDir]);
    spawnSync("chmod", ["755", targetDir]);
    return targetDir;
  }
  /** The tree minus backups/ and its lock, which the gate may legitimately make before a later refusal. */
  const settled = (targetDir) => treeSnapshot(targetDir).split("\n").filter((line) => !/^\.\/backups( |\/)/u.test(line)).join("\n");
  const expectRefusal = (result) => {
    expect(result.stdout).not.toContain(DONE);
    expect(result.status).toBe(4);
    expect(result.stderr).toContain("orbit-install-backups");
    expect(composeUpCalls(result)).toEqual([]);
  };

  it.skipIf(!realRoot)("b: a root-owned orbit-install-backups in the other user's folder is refused, named, with the fix; nothing changed", () => {
    const targetDir = ownedFixture("other");
    const backups = join(targetDir, "orbit-install-backups");
    mkdirSync(backups, { mode: 0o700 });
    spawnSync("chown", ["0:0", backups]);
    const before = settled(targetDir);
    const result = realRun(targetDir);
    expectRefusal(result);
    expect(result.stderr).toMatch(/another user|belongs to/u);
    expect(result.stderr).toMatch(/remove it|empty/u);
    expect(result.stderr).toMatch(/re-run repair/u);
    expect(settled(targetDir)).toBe(before);
  });

  it.skipIf(!realRoot)("c: in a root-owned folder, an orbit-install-backups owned by another user is refused, named; nothing changed", () => {
    const targetDir = ownedFixture("root");
    const backups = join(targetDir, "orbit-install-backups");
    mkdirSync(backups, { mode: 0o700 });
    spawnSync("chown", [`${otherId("-u")}:${otherId("-g")}`, backups]);
    const before = settled(targetDir);
    const result = realRun(targetDir);
    expectRefusal(result);
    expect(result.stderr).toMatch(/another user|not root|owned by/u);
    expect(settled(targetDir)).toBe(before);
  });

  it.skipIf(!realRoot)("c: in a root-owned folder, an adopted undo folder owned by another user is refused; nothing changed", () => {
    const targetDir = ownedFixture("root");
    const dated = "orbit-install-backups/20260101T000000Z";
    const folder = join(targetDir, dated);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(join(folder, ".orbit-smtp-undo"), `copy=${dated}\n`, { mode: 0o600 });
    spawnSync("chown", ["-R", `${otherId("-u")}:${otherId("-g")}`, folder]);
    const before = settled(targetDir);
    const result = realRun(targetDir);
    expectRefusal(result);
    expect(settled(targetDir)).toBe(before);
  });
});

describe("#1848 FIX-S1 acceptance 3: root without setpriv on PATH refuses and changes nothing", () => {
  it("names setpriv, exits 4, and leaves .env-orbit, the secret, the overlay and orbit-install-backups as they were", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir, { setpriv: false });
    const check = spawnSync("bash", ["-c", "command -v setpriv"], { env: shims.env, encoding: "utf8" });
    expect(check.stdout.trim(), "the test PATH still has setpriv").toBe("");
    const before = treeSnapshot(targetDir);
    const envBefore = readFileSync(join(targetDir, ".env-orbit"));
    const result = run(targetDir, shims);
    expect(result.stdout).not.toContain(DONE);
    expect(result.stderr).toMatch(/retire-smtp-lines refused, nothing was changed: .*setpriv/u);
    expect(result.status).toBe(4);
    expect(readFileSync(join(targetDir, ".env-orbit")).equals(envBefore)).toBe(true);
    expect(existsSync(secretPath(targetDir))).toBe(true);
    expect(existsSync(join(targetDir, "docker-compose.mail.yml"))).toBe(true);
    expect(existsSync(join(targetDir, "orbit-install-backups"))).toBe(false);
    expect(existsSync(join(targetDir, RECORD))).toBe(false);
    expect(composeUpCalls(result)).toEqual([]);
    expect(treeSnapshot(targetDir)).toBe(before);
  });

  it("with a pre-existing orbit-install-backups, that folder is left as it was too", () => {
    const targetDir = withMail();
    mkdirSync(join(targetDir, "orbit-install-backups"), { mode: 0o700 });
    const shims = privShims(targetDir, { setpriv: false });
    const before = treeSnapshot(targetDir);
    const result = run(targetDir, shims);
    expect(result.stderr).toMatch(/retire-smtp-lines refused, nothing was changed: .*setpriv/u);
    expect(result.status).toBe(4);
    expect(treeSnapshot(targetDir)).toBe(before);
  });
});

describe("#1848 FIX-S1 acceptance 4: not root, no setpriv call and the same results as today", () => {
  it("runs the action directly, calls neither setpriv nor chown, and ends with the same files", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir, { root: false });
    const result = run(targetDir, shims);
    expect(result.stdout, result.stderr).toContain(DONE);
    expect(shims.setprivCalls(), "setpriv was called by a run that is not root").toEqual([]);
    expect(shims.chownCalls()).toEqual([]);
    expect(shims.toolCalls().filter((line) => / marker=1 /u.test(line))).toEqual([]);
    expect(envOf(targetDir)).not.toMatch(/^(SMTP_[A-Z_]+|COMPOSE_FILE=.*docker-compose\.mail\.yml)/mu);
    expect(modeOf(join(targetDir, ".env-orbit"))).toBe("600");
    expect(existsSync(secretPath(targetDir))).toBe(false);
    expect(existsSync(join(targetDir, "docker-compose.mail.yml"))).toBe(false);
    expect(existsSync(join(targetDir, RECORD))).toBe(false);
    expect(envBackups(targetDir)).toEqual([]);
  });

  it("with the undo copy kept, the files and modes are those of the root-simulated run", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir, { root: false });
    const result = run(targetDir, shims, GATE_FAILS_AFTER);
    expect(result.stdout, result.stderr).toContain(DONE);
    expect(shims.setprivCalls()).toEqual([]);
    const root = join(targetDir, "orbit-install-backups");
    const [dated] = readdirSync(root);
    expect(modeOf(root)).toBe("700");
    expect(modeOf(join(root, dated))).toBe("700");
    expect(modeOf(join(root, dated, ".env-orbit"))).toBe("600");
    expect(modeOf(join(root, dated, "docker-compose.mail.yml"))).toBe(OVERLAY_MODE);
    expect(modeOf(join(targetDir, RECORD))).toBe("600");
  });

  it("a missing setpriv does not matter when not root", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir, { root: false, setpriv: false });
    const result = run(targetDir, shims);
    expect(result.stdout, result.stderr).toContain(DONE);
  });
});

describe("#1848 FIX-S1 acceptance 5 (and FR-O5c): an adopted undo folder and a pre-existing backups root owned by the folder's owner", () => {
  const ORPHAN = "orbit-install-backups/20260101T000000Z";
  const REMOVED_LINES = [
    "COMPOSE_FILE=docker-compose.yml:docker-compose.mail.yml",
    "SMTP_HOST=smtp.example.test",
    "SMTP_PORT=587",
    "SMTP_SECURITY=starttls",
    "SMTP_USER=orbit@example.test",
    "SMTP_FROM=Orbit <orbit@example.test>",
  ];

  it("as root, a pre-existing orbit-install-backups owned by the folder's owner is accepted, and every write runs under setpriv", () => {
    const targetDir = withMail();
    mkdirSync(join(targetDir, "orbit-install-backups"), { mode: 0o700 });
    chmodSync(join(targetDir, "orbit-install-backups"), 0o700);
    const shims = privShims(targetDir);
    const result = run(targetDir, shims, GATE_FAILS_AFTER);
    expect(result.stdout, result.stderr).toContain(DONE);
    expect(result.stderr).not.toContain("could not be made in orbit-install-backups");
    expectAllUnderSetpriv(shims);
    expect(shims.chownCalls()).toEqual([]);
    expect(modeOf(join(targetDir, "orbit-install-backups"))).toBe("700");
    expect(envBackups(targetDir)).toHaveLength(1);
  });

  it("as root, an undo folder adopted from a killed install is used with no second folder, every write under setpriv", () => {
    const targetDir = withMail();
    const folder = join(targetDir, ORPHAN);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    chmodSync(join(targetDir, "orbit-install-backups"), 0o700);
    chmodSync(folder, 0o700);
    writeFileSync(join(folder, ".orbit-smtp-undo"), `copy=${ORPHAN}\n`, { mode: 0o600 });
    writeFileSync(join(folder, ".env-orbit"), `${REMOVED_LINES.join("\n")}\n`, { mode: 0o600 });
    const shims = privShims(targetDir);
    const result = run(targetDir, shims, GATE_FAILS_AFTER);
    expect(result.stdout, result.stderr).toContain(DONE);
    expectAllUnderSetpriv(shims);
    expect(shims.chownCalls()).toEqual([]);
    expect(readdirSync(join(targetDir, "orbit-install-backups"))).toEqual(["20260101T000000Z"]);
    expect(notOwnedByTestUser(targetDir)).toEqual([]);
  });
});

// FIX-S1 addendum 2 (note 60194). Items 1, 2, 3, 4 and 6 of its acceptance line.
const USER_NAME = spawnSync("id", ["-un"], { encoding: "utf8" }).stdout.trim();
// U's primary group from the user database (not the process's current group, not the folder's).
const DB_GID = Number(spawnSync("getent", ["passwd", String(UID)], { encoding: "utf8" }).stdout.split(":")[3]);
const NODE_SID = readFileSync("/proc/self/stat", "utf8").replace(/^.*\) /u, "").split(" ")[3];
const FOREIGN_GID = 4242;

// Item 1: a root-owned .orbit-secrets (or secret file in it) in U's folder: step 3's removal runs as U and would
// fail with no message, leaving the record at `restarted` for ever. It is refused up front, as for the other folders.
describe("#1848 FIX-S1 addendum 2, item 1: a root-owned .orbit-secrets in the owner's folder is refused before anything changes", () => {
  for (const [what, rootOwned] of [
    ["the .orbit-secrets folder", "dir"],
    ["the secret file in it", "file"],
  ]) {
    it(`${what} owned by root (stat shim): refused, named, 'belongs to another user', exit 4, nothing changed, no start`, () => {
      const targetDir = withMail();
      const shims = privShims(targetDir, { rootOwned });
      const before = treeSnapshot(targetDir);
      const result = run(targetDir, shims);
      expect(result.stdout).not.toContain(DONE);
      expect(result.stderr).toMatch(/retire-smtp-lines refused, nothing was changed: .*\.orbit-secrets.*belongs to another user/u);
      expect(result.stderr).toContain("root");
      expect(result.status).toBe(4);
      expect(composeUpCalls(result)).toEqual([]);
      expect(treeSnapshot(targetDir)).toBe(before);
      expect(shims.toolCalls().filter((line) => / under=1 /u.test(line)), "something under the folder was changed before the refusal").toEqual([]);
    });
  }

  it("owned by the folder's owner (the shim lies about nothing): not refused", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir, { rootOwned: "none" });
    const result = run(targetDir, shims);
    expect(result.stdout, result.stderr).toContain(DONE);
  });

  it("not root: not checked, the run is unchanged even when stat says root owns .orbit-secrets", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir, { root: false, rootOwned: "dir" });
    const result = run(targetDir, shims);
    expect(result.stdout, result.stderr).toContain(DONE);
  });
});

// Item 2: the child that has dropped to U must not hold root's terminal or files. Each tool shim reads /proc for
// the process it really is (the child of setpriv, however the code wrapped it).
describe("#1848 FIX-S1 addendum 2, item 2: the setpriv child inherits nothing from root's process", () => {
  const children = (shims) => shims.children().filter((child) => child.marker === "1");

  it("has no open fd beyond 0-2 (the held lock fd included) in any child that touches the folder", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir);
    const result = run(targetDir, shims);
    expect(result.stdout, result.stderr).toContain(DONE);
    const seen = children(shims);
    expect(seen.length, "no child was recorded under setpriv").toBeGreaterThan(0);
    expect(seen.filter((child) => child.fds !== "").map((child) => child.line)).toEqual([]);
  });

  it("the same holds with the lock made by the owner and the undo copy kept", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir);
    const result = run(targetDir, shims, GATE_FAILS_AFTER);
    expect(result.stdout, result.stderr).toContain(DONE);
    expect(children(shims).filter((child) => child.fds !== "").map((child) => child.line)).toEqual([]);
  });

  it("every child reads stdin from /dev/null, except the owner-write script, whose stdin carries the bytes (a pipe, never repair's own)", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir);
    const result = run(targetDir, shims);
    expect(result.stdout, result.stderr).toContain(DONE);
    const seen = children(shims);
    expect(seen.length).toBeGreaterThan(0);
    const direct = seen.filter((child) => !child.parent.includes("smtp-owner-write"));
    expect(direct.length, "no direct (non owner-write) child was recorded").toBeGreaterThan(0);
    expect(direct.filter((child) => child.stdin !== "/dev/null").map((child) => child.line)).toEqual([]);
    for (const child of seen.filter((candidate) => candidate.parent.includes("smtp-owner-write"))) {
      expect(child.stdin, child.line).toMatch(/^pipe:\[\d+\]$/u);
    }
  });

  it("every child runs in a new session, not the one repair (and its terminal) belongs to", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir);
    const result = run(targetDir, shims);
    expect(result.stdout, result.stderr).toContain(DONE);
    const seen = children(shims);
    expect(seen.length).toBeGreaterThan(0);
    expect(NODE_SID).toMatch(/^\d+$/u);
    expect(seen.filter((child) => !/^\d+$/u.test(child.sid) || child.sid === NODE_SID).map((child) => child.line)).toEqual([]);
  });

  it("not root: nothing is wrapped, so the run's children are not recorded under setpriv", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir, { root: false });
    const result = run(targetDir, shims);
    expect(result.stdout, result.stderr).toContain(DONE);
    expect(children(shims)).toEqual([]);
  });
});

// Item 3: the child runs as U's own primary group from the user database with U's own supplementary groups
// (--init-groups), as su does: never the folder's group (which may be docker) and never an empty group list.
describe("#1848 FIX-S1 addendum 2, item 3: the group is U's own, not the folder's", () => {
  const argvOf = (shims) => shims.setprivCalls().filter((line) => !line.startsWith("BAD "));

  it("with the folder in a group that is not U's primary group, every setpriv call uses U's primary gid and --init-groups", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir, { folderGid: FOREIGN_GID });
    const result = run(targetDir, shims);
    const all = shims.setprivCalls();
    expect(all.length, "the run never used setpriv").toBeGreaterThan(0);
    for (const line of all) {
      expect(line, "the folder's group was passed").not.toContain(`--regid=${FOREIGN_GID}`);
      expect(line).toContain(`--reuid=${UID}`);
      expect(line).toContain(`--regid=${DB_GID}`);
      expect(line).toContain("--init-groups");
      expect(line).not.toContain("--clear-groups");
      expect(line).toContain("--no-new-privs");
    }
    expect(result.stdout, result.stderr).toContain(DONE);
  });

  it("with the folder in U's own group, the calls are the same shape (U's gid, --init-groups, no --clear-groups)", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir);
    const result = run(targetDir, shims);
    expect(result.stdout, result.stderr).toContain(DONE);
    expect(argvOf(shims).length).toBeGreaterThan(0);
    for (const line of argvOf(shims)) {
      expect(line).toContain(`--regid=${DB_GID}`);
      expect(line).toContain("--init-groups");
      expect(line).not.toContain("--clear-groups");
    }
  });
});

// Item 4: root's O-F5 refusal says who must be able to create the lock.
describe("#1848 FIX-S1 addendum 2, item 4: the root O-F5 message names the folder's owner", () => {
  const OWNER_WORDS = [/as the deployment folder's owner/u, /run backup\.sh once/u, /writable by/u];
  const expectOwnerMessage = (result) => {
    expect(result.stdout).not.toContain(DONE);
    expect(result.status).toBe(4);
    expect(result.stderr).toMatch(/retire-smtp-lines refused, nothing was changed: /u);
    for (const words of OWNER_WORDS) expect(result.stderr).toMatch(words);
    expect(result.stderr).toContain(`writable by ${USER_NAME}`);
    expect(result.stderr).toContain(`owner ${USER_NAME}`);
    expect(result.stderr, "root is told to make it writable for the user running repair").not.toContain("for the user running repair");
  };

  it("default backups folder, the owner's creation fails: the lock is made as the owner <U>; run backup.sh once or make the folder writable by <U>", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir, { setprivFail: '*" backups"*|*"/backups"*|*" ./backups"*' });
    expectOwnerMessage(run(targetDir, shims));
  });

  it("ORBIT_BACKUP_DIR at a folder the owner cannot create: the same wording", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir);
    expectOwnerMessage(run(targetDir, shims, { env: { ORBIT_BACKUP_DIR: "/proc/orbit-no-such-folder/backups" } }));
  });

  it("not root: the message is unchanged (for the user running repair)", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir, { root: false });
    const result = run(targetDir, shims, { env: { ORBIT_BACKUP_DIR: "/proc/orbit-no-such-folder/backups" } });
    expect(result.status).toBe(4);
    expect(result.stderr).toContain("for the user running repair");
    expect(result.stderr).not.toContain("as the deployment folder's owner");
  });
});

// Opt-in (real root and a second user): addendum 2 item 1 for real, with the folder owned by the other user.
describe("#1848 FIX-S1 addendum 2, item 1 (opt-in, needs root and a second user)", () => {
  const other = process.env.ORBIT_TEST_OTHER_USER ?? "nobody";
  const otherId = (flag) => Number(spawnSync("id", [flag, other], { encoding: "utf8" }).stdout.trim());
  for (const [what, relative] of [
    ["folder", ".orbit-secrets"],
    ["secret file", join(".orbit-secrets", "smtp-password")],
  ]) {
    it.skipIf(process.getuid?.() !== 0)(`a root-owned .orbit-secrets ${what} in the other user's folder is refused, named; nothing changed`, () => {
      const targetDir = withMail();
      spawnSync("chown", ["-R", `${otherId("-u")}:${otherId("-g")}`, targetDir]);
      spawnSync("chmod", ["755", targetDir]);
      spawnSync("chown", ["0:0", join(targetDir, relative)]);
      const before = treeSnapshot(targetDir);
      const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...IMPORTED, env: { ORBIT_REPAIR_PROMPTS: "machine" }, input: "y\n" });
      expect(result.stdout).not.toContain(DONE);
      expect(result.status).toBe(4);
      expect(result.stderr).toMatch(/\.orbit-secrets.*belongs to another user/u);
      expect(composeUpCalls(result)).toEqual([]);
      expect(treeSnapshot(targetDir)).toBe(before);
    });
  }
});

// Acceptance 6: the symlink swap itself cannot be shown without a second user. Proved by inspection of the
// rule in acceptance 1 (root runs no command that creates, writes, chmods, renames or removes a path under
// the folder), plus this opt-in test, for the owner to run as root: it needs root, a second user
// (ORBIT_TEST_OTHER_USER, default "nobody") and sudo-style privilege, e.g.
//   sudo ORBIT_TEST_OTHER_USER=<user> npx vitest run scripts/repair-retire-privdrop-1848.test.mjs
// Real root, a folder owned by the other user. The temporary names are random (mktemp), so a link cannot be
// planted at one ahead of time; instead a mktemp shim does what the folder's owner would do in the race: right
// after mktemp made its file it swaps the file for a link to a root-only file. Whoever then writes to that name
// (root, before the fix; the owner, after it) is tested: the root-only file must be unchanged. The shim records
// each swap, so the test cannot pass without one having happened.
describe("#1848 FIX-S1 acceptance 6 (opt-in, needs root and a second user)", () => {
  it.skipIf(process.getuid?.() !== 0)("a link swapped in at the temporary names the code really uses is not followed by a real root run", () => {
    const other = process.env.ORBIT_TEST_OTHER_USER ?? "nobody";
    const otherId = (flag) => Number(spawnSync("id", [flag, other], { encoding: "utf8" }).stdout.trim());
    const [uid, gid] = [otherId("-u"), otherId("-g")];
    const targetDir = withMail();
    spawnSync("chown", ["-R", `${uid}:${gid}`, targetDir]);
    spawnSync("chmod", ["755", targetDir]);
    const victimDir = scratchDir("orbit-repair-privdrop-rootonly-");
    spawnSync("chmod", ["700", victimDir]);
    const victim = join(victimDir, "victim");
    writeFileSync(victim, "KEEP\n", { mode: 0o600 });
    const shimDir = scratchDir("orbit-repair-privdrop-swap-");
    const plantLog = join(shimDir, "planted.log");
    writeFileSync(
      join(shimDir, "mktemp"),
      `#!/usr/bin/env bash\nout="$('${realTool("mktemp")}' "$@")" || exit $?\ncase "$out" in '${targetDir}'/*) rm -f -- "$out"; ln -s -- '${victim}' "$out"; printf '%s\\n' "$out" >> '${plantLog}';; esac\nprintf '%s\\n' "$out"\n`,
    );
    chmodSync(join(shimDir, "mktemp"), 0o755);
    spawnSync("chmod", ["755", shimDir]);
    const result = runRepair(targetDir, ["--execute", "--safe-only"], {
      ...IMPORTED,
      env: { ORBIT_REPAIR_PROMPTS: "machine", PATH: `${shimDir}:${process.env.PATH}` },
      input: "y\n",
    });
    const planted = existsSync(plantLog) ? readFileSync(plantLog, "utf8").split("\n").filter(Boolean) : [];
    expect(planted.length, "no temporary name was swapped for a link, so nothing was tested").toBeGreaterThan(0);
    expect(planted.every((name) => /\.(retire-smtp|smtp-copy)\.|\.orbit-smtp-retirement\./u.test(name)), planted.join("\n")).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe("KEEP\n");
    expect(statSync(victim).uid).toBe(0);
    expect(modeOf(victim)).toBe("600");
    expect(result.status).not.toBeNull();
  });
});

// FIX-S1 addendum 3 (note 60195).
const everything = (result) => `${result.stdout}\n${result.stderr}`;
const repairLines = (result) => everything(result).split("\n").filter((line) => line.startsWith("Orbit repair:"));
const ERR_TEXT = "ORBIT-TEST-ERR-1848: Operation not permitted";
const BIG_UNIT = "ZQXJ";
const countBig = (text) => text.split(BIG_UNIT).length - 1;

// Item 1: the child's stderr is captured (cap 4 KiB) and printed when the child fails; the failure names its step.
describe("#1848 FIX-S1 addendum 3, item 1: a failure as the owner says why", () => {
  const rmFails = (emit) => ({ tool: "rm", match: "*smtp-password*", emit });

  it("step 3's removal fails as the owner with a known stderr text: the text and a repair line naming the step reach the output", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir, { toolFail: rmFails(`echo '${ERR_TEXT}' >&2`) });
    const result = run(targetDir, shims);
    expect(result.stdout).not.toContain(DONE);
    expect(everything(result), "the child's error text was swallowed").toContain(ERR_TEXT);
    const named = repairLines(result).filter((line) => /step 3|smtp-password|overlay|secret/iu.test(line));
    expect(named, `no 'Orbit repair:' line names the step or path:\n${repairLines(result).join("\n")}`.slice(0, 2000)).not.toEqual([]);
    expect(repairLines(result).some((line) => line.includes(ERR_TEXT)), "the error text is not on a repair line").toBe(true);
  });

  it("a stderr larger than 4 KiB comes out cut to 4 KiB or less (and some of it is shown)", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir, { toolFail: rmFails(`yes ${BIG_UNIT} | tr -d '\\n' | head -c 10000 >&2`) });
    const result = run(targetDir, shims);
    expect(result.stdout).not.toContain(DONE);
    const seen = countBig(everything(result));
    expect(seen, "none of the child's stderr was shown").toBeGreaterThan(0);
    expect(seen * BIG_UNIT.length, "more than 4 KiB of the child's stderr was printed").toBeLessThanOrEqual(4096);
  });

  it("the record write fails as the owner (mktemp): the error text and a repair line naming the record or step reach the output", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir, { toolFail: { tool: "mktemp", match: "*orbit-smtp-retirement.XXXXXX*", emit: `echo '${ERR_TEXT}' >&2` } });
    const result = run(targetDir, shims);
    expect(result.stdout).not.toContain(DONE);
    expect(everything(result), "the child's error text was swallowed").toContain(ERR_TEXT);
    expect(repairLines(result).some((line) => /record|orbit-smtp-retirement|step/iu.test(line)), repairLines(result).join("\n").slice(0, 2000)).toBe(true);
  });
});

// Item 2: every as-U child sees a cleared environment.
describe("#1848 FIX-S1 addendum 3, item 2: the owner's children get a cleared environment", () => {
  const ALLOWED = new Set(["PATH", "LC_ALL", "HOME", "USER", "LOGNAME", "PWD", "OLDPWD", "SHLVL", "_", "ORBIT_TEST_PRIVDROP"]);

  it("a marker variable in repair's environment reaches no child, and only the listed names are set", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir);
    const result = run(targetDir, shims, { env: { ORBIT_TEST_SECRET: "secret-marker-1848" } });
    expect(result.stdout, result.stderr).toContain(DONE);
    const seen = shims.envRecords().filter((record) => record.marker === "1");
    expect(seen.length, "no child under setpriv recorded its environment").toBeGreaterThan(0);
    expect(seen.filter((record) => record.leak > 0 || record.names.includes("ORBIT_TEST_SECRET")).map((record) => record.line)).toEqual([]);
    const extra = seen.map((record) => ({ tool: record.tool, extra: record.names.filter((name) => !ALLOWED.has(name)) })).filter((entry) => entry.extra.length > 0);
    expect(extra, "variables other than PATH, LC_ALL, HOME, USER, LOGNAME").toEqual([]);
    for (const record of seen) {
      for (const name of ["PATH", "LC_ALL", "HOME", "USER", "LOGNAME"]) expect(record.names, record.line).toContain(name);
    }
  });

  it("not root: nothing is cleared (the marker is still seen by the run's own tools, which are not children of setpriv)", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir, { root: false });
    const result = run(targetDir, shims, { env: { ORBIT_TEST_SECRET: "secret-marker-1848" } });
    expect(result.stdout, result.stderr).toContain(DONE);
    expect(shims.envRecords().some((record) => record.leak > 0)).toBe(true);
  });
});

// Item 3: a failed user-database lookup is not "no entry".
describe("#1848 FIX-S1 addendum 3, item 3: a failed lookup of the folder's owner is refused with its own wording", () => {
  const WORDS = new RegExp(`retire-smtp-lines refused, nothing was changed: .*could not look up the deployment folder's owner \\(uid ${UID}\\) in the user database`, "u");
  for (const [what, options] of [
    ["getent is not on PATH", { omit: ["getent"] }],
    ["getent fails (exit 2, no output)", { getent: "fail" }],
  ]) {
    it(`${what}: refused, exit 4, nothing changed, no start`, () => {
      const targetDir = withMail();
      const shims = privShims(targetDir, options);
      if (options.omit) expect(spawnSync("bash", ["-c", "command -v getent"], { env: shims.env, encoding: "utf8" }).stdout.trim(), "the test PATH still has getent").toBe("");
      const before = treeSnapshot(targetDir);
      const result = run(targetDir, shims);
      expect(result.stdout).not.toContain(DONE);
      expect(result.stderr).toMatch(WORDS);
      expect(result.stderr).not.toContain("has no entry in the user database");
      expect(result.status).toBe(4);
      expect(composeUpCalls(result)).toEqual([]);
      expect(treeSnapshot(targetDir)).toBe(before);
    });
  }
});

// Item 4: setsid must support --wait (util-linux 2.31 and later).
describe("#1848 FIX-S1 addendum 3, item 4: setsid without --wait is refused before the lock", () => {
  const expectRefused = (targetDir, shims) => {
    const before = treeSnapshot(targetDir);
    const result = run(targetDir, shims);
    expect(result.stdout).not.toContain(DONE);
    expect(result.stderr).toMatch(/retire-smtp-lines refused, nothing was changed: .*setsid/u);
    expect(result.status).toBe(4);
    expect(existsSync(join(targetDir, "backups")), "the lock folder was made before the refusal").toBe(false);
    expect(composeUpCalls(result)).toEqual([]);
    expect(treeSnapshot(targetDir)).toBe(before);
  };

  it("a setsid that rejects --wait (\"unrecognized option '--wait'\", exit 1): refused, exit 4, nothing changed", () => {
    const targetDir = withMail();
    expectRefused(targetDir, privShims(targetDir, { setsid: "no-wait" }));
  });

  it("no setsid on PATH at all: the same refusal", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir, { omit: ["setsid"] });
    expect(spawnSync("bash", ["-c", "command -v setsid"], { env: shims.env, encoding: "utf8" }).stdout.trim(), "the test PATH still has setsid").toBe("");
    expectRefused(targetDir, shims);
  });

  it("not root: a setsid without --wait does not matter", () => {
    const targetDir = withMail();
    const result = run(targetDir, privShims(targetDir, { root: false, setsid: "no-wait" }));
    expect(result.stdout, result.stderr).toContain(DONE);
  });
});

// Test gaps from the review of addendum 2.
describe("#1848 FIX-S1 addendum 3: test gaps", () => {
  it("the user database's gid differs from the test process's gid: every setpriv call uses the database gid, never `id -g`", () => {
    const targetDir = withMail();
    const dbGid = GID + 1000;
    const shims = privShims(targetDir, { getent: String(dbGid), dbGid });
    const result = run(targetDir, shims);
    const calls = shims.setprivCalls();
    expect(calls.length, "the run never used setpriv").toBeGreaterThan(0);
    expect(calls.filter((line) => line.startsWith("BAD ")), "setpriv was called with a gid other than the database's").toEqual([]);
    for (const line of calls) {
      expect(line).toContain(`--regid=${dbGid}`);
      expect(line).not.toContain(`--regid=${GID} `);
    }
    expect(result.stdout, result.stderr).toContain(DONE);
  });

  it("the owner-write child's stdin is the write pipe, not repair's own stdin", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir);
    const result = run(targetDir, shims);
    expect(result.stdout, result.stderr).toContain(DONE);
    // The first `id -u` runs at repair's top level, with repair's own stdin (the pipe or socket the test feeds).
    const repairStdin = shims.idStdin()[0];
    expect(repairStdin, "repair's own stdin was not a pipe or socket at its first id call").toMatch(/^(pipe|socket):\[\d+\]$/u);
    const writers = shims.children().filter((child) => child.marker === "1" && child.parent.includes("smtp-owner-write"));
    expect(writers.length, "no owner-write child was recorded").toBeGreaterThan(0);
    for (const child of writers) {
      expect(child.stdin, child.line).toMatch(/^pipe:\[\d+\]$/u);
      expect(child.stdin, `the owner-write child reads repair's own stdin: ${child.line}`).not.toBe(repairStdin);
    }
  });
});

// FIX-S1 addendum 4 (note 60207), item 3.
describe("#1848 FIX-S1 addendum 4: the owner's identity, quiet successes, and clean error text", () => {
  it("the child's HOME, USER and LOGNAME are U's user-database entry (a home that is not the runner's HOME)", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir, { getent: String(GID) });
    const result = run(targetDir, shims, { env: { HOME: "/runner-home-not-u" } });
    expect(result.stdout, result.stderr).toContain(DONE);
    const seen = shims.envRecords().filter((record) => record.marker === "1");
    expect(seen.length, "no child under setpriv recorded its environment").toBeGreaterThan(0);
    expect(seen.filter((record) => record.ids !== `/nonexistent:${USER_NAME}:${USER_NAME}`).map((record) => record.line)).toEqual([]);
  });

  it("a child that succeeds but writes to stderr: the run still succeeds and the text is not printed", () => {
    const targetDir = withMail();
    const shims = privShims(targetDir, { toolFail: { tool: "rm", match: "*smtp-password*", emit: "echo 'QUIET-SUCCESS-TEXT-1848' >&2", pass: true } });
    const result = run(targetDir, shims);
    expect(result.stdout, result.stderr).toContain(DONE);
    expect(existsSync(secretPath(targetDir))).toBe(false);
    expect(everything(result)).not.toContain("QUIET-SUCCESS-TEXT-1848");
  });

  it("a failing child whose stderr holds C1 controls, a bidi override and invalid UTF-8: none reach the output, the plain text does", () => {
    const targetDir = withMail();
    const emit = "printf 'plain-before \\xc2\\x9b[31m mid \\xe2\\x80\\xae rtl \\xff plain-after\\n' >&2";
    const shims = privShims(targetDir, { toolFail: { tool: "rm", match: "*smtp-password*", emit } });
    const result = run(targetDir, shims);
    expect(result.stdout).not.toContain(DONE);
    const raw = Buffer.concat([Buffer.from(result.stdout), Buffer.from(result.stderr)]);
    expect(everything(result)).toContain("plain-before");
    expect(everything(result)).toContain("plain-after");
    expect(everything(result)).not.toContain("\u009b");
    expect(everything(result)).not.toContain("\u202e");
    expect(everything(result)).not.toContain("\ufffd");
    expect(raw.includes(Buffer.from([0xc2, 0x9b])), "C1 CSI reached the output").toBe(false);
    expect(raw.includes(Buffer.from([0xe2, 0x80, 0xae])), "bidi override reached the output").toBe(false);
    expect(raw.includes(Buffer.from([0xff])), "invalid UTF-8 reached the output").toBe(false);
  });
});
