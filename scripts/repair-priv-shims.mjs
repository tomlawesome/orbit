import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scratchDir } from "./repair-test-harness.mjs";

// Shared by the repair privilege-drop tests (#1848, #1857, #1858): root is simulated by PATH shims, since the
// tests have no real root. Moved here unchanged from repair-retire-privdrop-1848.test.mjs, plus the `variant`
// option of privShims (a setpriv that misbehaves, #1858).

export const UID = process.getuid();
export const GID = process.getgid();
export const USER_NAME = spawnSync("id", ["-un"], { encoding: "utf8" }).stdout.trim();
export const realTool = (name) => spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();

const TOOLS = ["mktemp", "dd", "chmod", "mv", "rm", "rmdir", "mkdir"];

// Bash source of each tool shim (String.raw, so bash's own ${...} is not JS interpolation; __TOKENS__ are filled in).
// Besides the marker log, each call records what the process it runs in actually inherited, read from /proc at
// the moment the tool starts (the real child of setpriv, whatever the code put in between): open fds other than
// 0-2, where stdin points, the session id, and the parent's command line (to tell the owner-write script,
// whose stdin legitimately carries the bytes, from every other child).
const TOOL_SHIM = String.raw`under=0
for a in "$@"; do
  [[ "$a" == -* ]] && continue
  case "$a" in of=*|if=*) a="\${a#*=}";; esac
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
// ".orbit-secrets/smtp-password" (file), ".env-orbit" (env), "orbit-install-backups" (backups) or a dated folder
// under it (undo): the owner (%u, %U) becomes root.
const STAT_SHIM = String.raw`args=("$@"); last="\${args[$((\${#args[@]} - 1))]}"
if [[ "$last" == . || "$last" == ./ ]] && [[ -n '__FAKEGID__' ]]; then
  for i in "\${!args[@]}"; do
    args[$i]="\${args[$i]//%g/__FAKEGID__}"; args[$i]="\${args[$i]//%G/orbit-fake-group}"
  done
fi
case "$last" in
  *orbit-install-backups|*orbit-install-backups/) lie=backups;;
  *orbit-install-backups/[0-9]*) lie=undo;;
  *.env-orbit) lie=env;;
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

// What a misbehaving setpriv does (#1858): `variant` is { kind, match } where match is a bash case pattern over the
// setpriv call's whole argument string (default: every call). Each variant bounds its own lifetime (a leak ends
// within ~40 s) and logs the pids it leaves, for privShims().cleanup().
// Except run-then-stop, a variant never runs the command it was asked to, so it leaves nothing in the folder.
//   stop        SIGSTOPs itself
//   ignore-term ignores TERM and waits (at most 40 s)
//   grandchild  leaves a background process (25 s) holding stdout and stderr, and exits 0
//   run-then-stop  runs the command it was asked to (as the owner), then SIGSTOPs itself: the step made its
//               change and then timed out (#1872 V10)
//   run-then-ignore-term  runs the command it was asked to, then ignores TERM and waits (at most 40 s) (#1873)
//   run-then-flood  runs the command it was asked to (its output discarded), then writes 8 MiB to stdout and exits 1 (#1873)
//   flood       writes 8 MiB (no newline) to stdout and to stderr, and exits 1
function variantSnippet(variant, pidLog) {
  if (!variant) return "";
  const body = {
    stop: `echo $$ >> '${pidLog}'; kill -STOP $$; exit 1`,
    "ignore-term": `echo $$ >> '${pidLog}'; trap '' TERM; for _i in $(seq 1 40); do sleep 1; done; exit 1`,
    grandchild: `sleep 25 & echo $! >> '${pidLog}'; exit 0`,
    "run-then-stop": `args=("$@"); while [[ $# -gt 0 && "$1" != -- ]]; do shift; done; shift; ( export ORBIT_TEST_PRIVDROP=1; "$@" ) >/dev/null 2>&1; echo $$ >> '${pidLog}'; kill -STOP $$; exit 1`,
    "run-then-ignore-term": `args=("$@"); while [[ $# -gt 0 && "$1" != -- ]]; do shift; done; shift; ( export ORBIT_TEST_PRIVDROP=1; "$@" ) >/dev/null 2>&1; echo $$ >> '${pidLog}'; trap '' TERM; for _i in $(seq 1 40); do sleep 1; done; exit 1`,
    "run-then-flood": `while [[ $# -gt 0 && "$1" != -- ]]; do shift; done; shift; ( export ORBIT_TEST_PRIVDROP=1; "$@" ) >/dev/null 2>&1; head -c 8388608 /dev/zero | tr '\\0' a; exit 1`,
    flood: `head -c 8388608 /dev/zero | tr '\\0' a; head -c 8388608 /dev/zero | tr '\\0' a >&2; exit 1`,
  }[variant.kind];
  if (body === undefined) throw new Error(`unknown setpriv variant ${variant.kind}`);
  return `case "$*" in ${variant.match ?? "*"}) ${body};; esac`;
}

/**
 * Builds the shim directory. `setpriv: false` leaves setpriv off PATH altogether (every other executable of the
 * original PATH is linked into a private bin, setpriv excepted). `folderGid` makes `stat` report that gid for the
 * deployment folder; `rootOwned` ("dir", "file", "env", "backups" or "undo") makes it report root as the owner of
 * .orbit-secrets, its secret file, .env-orbit, orbit-install-backups or a dated folder under it. Logs, one line each:
 *   tools.log:   "<tool> marker=<0|1> under=<0|1> cwd=<cwd> args=<args>"   (under: names a path under the folder)
 *   child.log:   "<tool>|<marker>|<session id>|<stdin target>|<extra fds>|<parent command line>"
 *   setpriv.log: "<argv of the setpriv call>"   (and "BAD <argv>" when it lacks the three required options; exit 99)
 *   chown.log:   "<argv>"
 */
export function privShims(targetDir, { root = true, setpriv = true, setprivFail = null, folderGid = null, rootOwned = null, omit = [], getent = null, setsid = null, toolFail = null, dbGid = GID, variant = null, extraTools = [], ownerUnreadable = false } = {}) {
  const dir = scratchDir("orbit-repair-privdrop-shims-");
  const toolLog = join(dir, "tools.log");
  const privLog = join(dir, "setpriv.log");
  const chownLog = join(dir, "chown.log");
  const childLog = join(dir, "child.log");
  const envLog = join(dir, "env.log");
  const idLog = join(dir, "id.log");
  const pidLog = join(dir, "pids.log");
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
${variantSnippet(variant, pidLog)}
while [[ $# -gt 0 && "$1" != -- ]]; do shift; done
shift
export ORBIT_TEST_PRIVDROP=1
exec "$@"
`,
    );
  }
  for (const tool of [...TOOLS, ...extraTools]) {
    const rule = toolFail?.tool === tool ? `if [[ "\${ORBIT_TEST_PRIVDROP:-0}" == 1 ]]; then case "$*" in ${toolFail.match}) ${toolFail.emit}${toolFail.pass ? "" : "; exit 1"};; esac; fi` : "";
    write(tool, TOOL_SHIM.replaceAll("__FAILRULE__", rule).replaceAll("__ENVLOG__", envLog).replaceAll("__TARGET__", targetDir).replaceAll("__TOOL__", tool).replaceAll("__CHILDLOG__", childLog).replaceAll("__FDLIST__", join(dir, "fds.tmp")).replaceAll("__TOOLLOG__", toolLog).replaceAll("__REAL__", realTool(tool)));
  }
  // ownerUnreadable: `stat -c %u .` (the folder's owner) fails, as when the folder's status can't be read.
  if (ownerUnreadable) {
    write("stat", `last="\${@: -1}"\nfor a in "$@"; do if [[ "$a" == *%u* && "$last" == . ]]; then exit 1; fi; done\nexec '${realTool("stat")}' "$@"\n`);
  } else if (folderGid !== null || rootOwned !== null) {
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
    /** Kills every process a misbehaving setpriv variant left behind (pids it logged). */
    cleanup: () => {
      for (const pid of read(pidLog)) spawnSync("kill", ["-KILL", pid], { stdio: "ignore" });
    },
  };
}
