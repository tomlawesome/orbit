#!/usr/bin/env node
/**
 * Cosign call checker (#1841; owner, 2026-11-14: cosign sends no telemetry
 * and publishes nothing beyond what signing needs).
 *
 * Scans .gitlab-ci.yml and every file it includes with `local:` (nested
 * includes followed, each file once), .github/workflows/*.yml and *.yaml, and
 * scripts/**\/*.sh, plus (anywhere under --root, except node_modules, .git,
 * .worktrees and __fixtures__ directories) every .mjs and .ts file other than
 * *.test.mjs and *.test.ts, and every Dockerfile (Dockerfile, Dockerfile.*,
 * *.Dockerfile), under --root <dir> (default the working directory), and
 * prints `file:line: reason` for each problem:
 *
 * - an OTEL_ variable set or exported (a YAML variables:/env: key, a shell
 *   assignment, or any entry of an export/declare/readonly/env list), so no
 *   OpenTelemetry export is ever switched on;
 * - a cosign sign, sign-blob, attest or attest-blob call without the whole
 *   token `--tlog-upload=false` (or `--tlog-upload false`; the last one
 *   wins), so nothing goes to the public Rekor log. The one allowed exception
 *   is the keyless public release proof (ADR-0031), marked by
 *   `# cosign-public-upload: <reason>` on the line directly above the call.
 *
 * A command is a logical line: trailing-backslash continuations are joined
 * and a `#` comment outside quotes is dropped. It is split into tokens and
 * simple commands at unquoted ; && || | & ( ), and each $(...) and `...` is
 * checked as a command of its own. A call is an unquoted cosign token (cosign,
 * /path/cosign, or a variable whose name contains "cosign", such as
 * "${cosign}" or $COSIGN_BIN) followed later in the same simple command by a
 * signing subcommand, bare or quoted, so wrappers (env, sudo, exec, xargs,
 * x=1 prefixes) and global flags in between still count. A cosign whose first
 * non-flag argument is a variable ("$@", $*, $sub) may be signing, so it
 * counts too. Quoted text is prose, except the script of bash -c, sh -c,
 * flock -c (--command), env -S (--split-string) and the arguments of eval,
 * which are checked as commands.
 *
 * A variable named *cosign* counts only in command position: the command
 * word, or after env (its VAR=value, -u NAME and -C DIR), exec (-a NAME),
 * sudo (-u USER and its other value options), nohup, command, time, xargs
 * (and its value options) or VAR=value prefixes, or after timeout, nice,
 * ionice, setsid, stdbuf or flock with their own options and arguments (the
 * duration of timeout, the lock of flock). `# cosign-passthrough: <reason>`
 * directly above allows only the variable-subcommand case (a wrapper that
 * forwards "$@"); it never excuses an explicit signing subcommand.
 *
 * In .mjs and .ts files the calls are execFile, execFileSync, spawn and
 * spawnSync, and the names they are imported as from node:child_process or
 * child_process (`import { execFile as x }`, `const { spawn: y } =
 * require(...)`), whose first argument's basename is cosign (a literal array
 * of arguments is read; any other second argument may sign and counts), or sh
 * or bash with a literal array holding -c (its script is checked as a shell
 * command); and exec or execSync, or their aliases, with a command string
 * (its string and template pieces are checked as a shell command). Comments
 * and strings that are not such a call are prose, and an OTEL_ key or
 * assignment in code is flagged. In a Dockerfile the shell and exec forms of
 * RUN are checked as commands and ENV or ARG may not set OTEL_.
 *
 * Includes that come from outside the repository are never fetched and never
 * scanned (owner decision 37b, #1843; the check stays offline). In
 * .gitlab-ci.yml and every local file it includes, every top-level include
 * key in any spelling is read, and only this block form is accepted (#1843
 * review, note 59935; anything else fails closed, naming the line):
 *
 *   include:                # at column 0, unquoted, nothing after but a comment
 *     - local: ci/x.yml     # items are indented `- key: value` lines
 *     - project: group/name
 *       ref: <40-hex sha>   # only the item's own key counts, not one under rules/inputs
 *       file: a.yml         # a scalar, or a block list of scalars
 *       rules:              # rules: and inputs: are not read; every node in them
 *         - if: $X          #   must be a plain or quoted scalar
 *     - component: host/group/name/c@<40-hex sha>
 *
 * Item keys are local, project, ref, file, rules and inputs, plus component;
 * values are plain or quoted scalars without escapes. These fail: flow style
 * ([ or {), an anchor, alias or tag (&, *, !reference) at any node in the
 * block, a list dash at column 0, a quoted key, a value on the include: line,
 * a string item, an unknown or repeated item key, ref: or file: outside a
 * project: item, remote: and template: always (templates cannot be pinned),
 * project: without a 40-hex ref:, component: not ending in @<40-hex>. A
 * local: must be a plain (unquoted) path, without glob characters (*?[{) or
 * $, naming an existing regular file inside the repository; that file is then
 * read the same way. Outside the include block, a top-level merge key (<<), a
 * top-level line starting with a YAML indicator (flow, ?, !, &, *, %), an
 * indented top-level mapping and a quoted top-level key that is escaped or
 * spells include fail too, so an anchor elsewhere cannot bring an include in.
 * Each pinned project or component include prints one `not scanned:` line
 * (project, ref, files) and does not affect the exit code.
 *
 * A job's `trigger: include:` (a child pipeline; #1843 note 59967) gets the
 * same reader and pin rules, at its own indentation, plus one more form:
 * `include: <path>`, a plain scalar naming an existing local file, which is
 * followed and scanned. Any other value of a trigger's include (flow, alias,
 * URL, a missing file) fails, and so does a trigger: value that is not a
 * plain scalar (a flow mapping could hold an include); a scalar trigger:
 * must be an unquoted project path (group/project), never a URL. In every
 * followed CI file, a flow value ({ or [ after key: or - ) that names
 * include or trigger fails at its line wherever it sits (#1843 note 59980),
 * so a one-line or anchored flow job cannot hide one; inside its double
 * quotes a backslash escapes the next character, and a double-quoted key
 * holding a backslash (an escape such as \x69, or a fold) fails too. In
 * block style, a double-quoted key holding a backslash fails at any depth
 * (the first one is reported); a backslash in a value is fine. An explicit
 * key (?) and a key with an anchor or tag in front of it fail at any depth;
 * anchors and tags on values stay allowed. An include: key
 * anywhere else is ignored, as GitLab ignores it. Known limits (Low):
 * `trigger:\n  - include: x`, which GitLab rejects, and a job-level
 * `<<: *j`, whose anchored body is itself scanned.
 *
 * Known limits (Low, #1843 note 59935): `cosign sign x -- --tlog-upload=false`
 * passes (the flag after -- is read as a flag); a quoted "OTEL_X=1"
 * assignment is not seen; .js and .cjs files are not scanned (the spec names
 * .mjs and .ts); names built at run time are not followed (a cosign path held
 * in a variable not named cosign, renamed binaries, shell aliases, an
 * argument list or command built elsewhere in code, promisify wrappers).
 *
 * Deliberately plain line scanning with a small linear tokenizer, not a YAML
 * or shell parser. Exits 1 on any problem, 0 otherwise.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const SIGNING = new Set(["sign", "sign-blob", "attest", "attest-blob"]);
const MARKER = /^\s*#\s*cosign-public-upload:\s*\S/;
const PASSTHROUGH = /^\s*#\s*cosign-passthrough:\s*\S/;
const KEYWORDS = new Set(["-", "run:", "!", "{", "if", "then", "do", "else", "elif", "while", "until"]);
const WRAPPERS = new Set(["env", "exec", "sudo", "nohup", "command", "time", "xargs"]);
// Wrappers that take options and arguments of their own before the command:
// need = positional arguments before it, short/long = options that take a value.
const ARG_WRAPPERS = {
  timeout: { need: 1, short: new Set(["-k", "-s"]), long: new Set(["--kill-after", "--signal"]) },
  nice: { need: 0, short: new Set(["-n"]), long: new Set(["--adjustment"]) },
  ionice: { need: 0, short: new Set(["-c", "-n", "-p", "-P", "-u"]), long: new Set(["--class", "--classdata", "--pid", "--pgid", "--uid"]) },
  setsid: { need: 0, short: new Set(), long: new Set() },
  stdbuf: { need: 0, short: new Set(["-i", "-o", "-e"]), long: new Set(["--input", "--output", "--error"]) },
  flock: { need: 1, short: new Set(["-w", "-E", "-c"]), long: new Set(["--timeout", "--wait", "--conflict-exit-code", "--command"]) },
};
// Wrapper options whose value is the next token, so the command word comes after it.
const WRAPPER_VALUE_FLAGS = {
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
  sudo: new Set(["-u", "--user", "-g", "--group", "-C", "--close-from", "-D", "--chdir", "-h", "--host", "-p", "--prompt", "-r", "--role", "-t", "--type", "-U", "--other-user", "-T", "--command-timeout"]),
  exec: new Set(["-a"]),
  xargs: new Set(["-a", "--arg-file", "-d", "--delimiter", "-E", "-I", "-L", "--max-lines", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars"]),
};
const YAML_OTEL = /^\s*(?:-\s+)?["']?(OTEL_\w*)["']?\s*:/;
const VARIABLE = /^("?)\$(\{?)([A-Za-z_][A-Za-z0-9_]*)(\}?)"?$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\+?=|$)/;
const DECLARERS = new Set(["export", "declare", "typeset", "local", "readonly", "env"]);
const TRANSPARENT = new Set(["-", "run:", "sudo", "exec", "nohup", "command", "time"]);

function parseArgs(argv) {
  let root = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) root = argv[++i];
    else if (argv[i].startsWith("--root=")) root = argv[i].slice(7);
    else {
      console.error("usage: check-cosign-calls.mjs [--root <dir>]");
      process.exit(2);
    }
  }
  return root;
}

function shellFiles(dir, out) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) shellFiles(full, out);
    else if (name.endsWith(".sh")) out.push(full);
  }
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".worktrees", "__fixtures__"]);
const isDockerfile = (name) => /^Dockerfile(\.|$)/.test(name) || name.endsWith(".Dockerfile");
const isCode = (name) => /\.(mjs|ts)$/.test(name) && !/\.test\.(mjs|ts)$/.test(name);

/** .mjs and .ts files (not tests) and Dockerfiles anywhere under dir. */
function codeFiles(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) codeFiles(join(dir, e.name), out);
    } else if (e.isFile() && (isCode(e.name) || isDockerfile(e.name))) out.add(join(dir, e.name));
  }
}

// CI file -> what readIncludes found in it.
const includes = new Map();

function filesToScan(root) {
  const files = new Set();
  const seen = new Set(); // real paths, so a cycle or a symlinked name is read once
  const queue = [join(root, ".gitlab-ci.yml")].filter((f) => existsSync(f));
  while (queue.length) {
    const file = queue.shift();
    const real = realpathSync(file);
    if (seen.has(real)) continue;
    seen.add(real);
    files.add(file);
    const found = readIncludes(file, root);
    includes.set(file, found);
    queue.push(...found.locals);
  }
  const wf = join(root, ".github", "workflows");
  if (existsSync(wf)) {
    for (const name of readdirSync(wf)) if (/\.ya?ml$/.test(name)) files.add(join(wf, name));
  }
  const sh = [];
  shellFiles(join(root, "scripts"), sh);
  for (const f of sh) files.add(f);
  codeFiles(root, files);
  return [...files].sort();
}

const isComment = (line) => /^\s*#/.test(line);

/** Join backslash continuations; each logical line keeps where its physical lines start. */
function logicalLines(lines) {
  const out = [];
  let cur = null;
  lines.forEach((line, i) => {
    if (!cur) cur = { text: "", parts: [] };
    cur.parts.push({ offset: cur.text.length, line: i + 1 });
    const continued = !isComment(line) && /\\\s*$/.test(line);
    cur.text += continued ? line.replace(/\\\s*$/, " ") : line;
    if (!continued) {
      out.push(cur);
      cur = null;
    }
  });
  if (cur) out.push(cur);
  return out;
}

/**
 * Split text into simple commands (arrays of tokens). One linear pass: each
 * $(...) and each `...` opens a frame of its own, and leaves `$_` in the
 * enclosing token. A backtick closes its frame even inside quotes, as in sh.
 * A token is { raw, value, quoted, offset }; offsets are base-relative.
 */
function simpleCommands(text, base) {
  const done = [];
  const frame = (close = null) => ({ seg: [], tok: null, q: null, close });
  const stack = [frame()];
  const top = () => stack[stack.length - 1];
  const begin = (f, i) => (f.tok ??= { raw: "", value: "", quoted: false, offset: base + i });
  const add = (f, i, raw, value = raw) => {
    const t = begin(f, i);
    t.raw += raw;
    t.value += value;
  };
  const endTok = (f) => {
    if (f.tok) f.seg.push(f.tok);
    f.tok = null;
  };
  const endSeg = (f) => {
    endTok(f);
    if (f.seg.length) done.push(f.seg);
    f.seg = [];
  };
  const openSub = (f, i, close) => {
    begin(f, i);
    stack.push(frame(close));
  };
  const closeSub = (f, i) => {
    endSeg(f);
    stack.pop();
    add(top(), i, "$_");
  };
  let i = 0;
  scan: for (; i < text.length; i++) {
    const f = top();
    const c = text[i];
    const n = text[i + 1];
    if (c === "`" && f.close === "`") {
      closeSub(f, i);
      continue;
    }
    if (f.q === "'") {
      if (c === "'") f.q = null;
      else add(f, i, c);
      if (c === "'") f.tok.raw += c;
      continue;
    }
    if (f.q === '"') {
      if (c === "\\" && n !== undefined) {
        add(f, i, c + n, n);
        i++;
      } else if (c === '"') {
        f.q = null;
        f.tok.raw += c;
      } else if (c === "$" && n === "(") {
        openSub(f, i, ")");
        i++;
      } else if (c === "`") openSub(f, i, "`");
      else add(f, i, c);
      continue;
    }
    if (c === " " || c === "\t") endTok(f);
    else if (c === "\\") {
      if (n !== undefined) {
        add(f, i, c + n, n);
        i++;
      }
    } else if (c === "'" || c === '"') {
      begin(f, i).quoted = true;
      f.tok.raw += c;
      f.q = c;
    } else if (c === "#" && !f.tok) break scan;
    else if (c === "$" && n === "(") {
      openSub(f, i, ")");
      i++;
    } else if (c === "`") openSub(f, i, "`");
    else if (c === ")" && f.close === ")") closeSub(f, i);
    else if (c === ";" || c === "(" || c === ")") endSeg(f);
    else if (c === "|") {
      endSeg(f);
      if (n === "|") i++;
    } else if (c === "&") {
      if (n === ">" || (f.tok && f.tok.raw.endsWith(">"))) add(f, i, c);
      else {
        endSeg(f);
        if (n === "&") i++;
      }
    } else add(f, i, c);
  }
  while (stack.length) endSeg(stack.pop());
  return done;
}

/**
 * The cosign token test. The literal cosign or /path/cosign counts anywhere
 * unquoted; a variable named *cosign* only in command position, so
 * "$COSIGN_SHA256" as an argument is not a call.
 */
function isCosign(t, commandPosition) {
  if (!t.quoted && (t.value === "cosign" || (t.value.endsWith("/cosign") && !t.raw.includes("$")))) return true;
  if (!commandPosition) return false;
  const m = VARIABLE.exec(t.raw);
  if (!m || (m[2] === "{") !== (m[4] === "}")) return false;
  if (m[1] === '"' && !t.raw.endsWith('"')) return false;
  return m[3].toLowerCase().includes("cosign");
}

/** Which tokens of a simple command stand where its command word may be. */
function commandPositions(seg) {
  const at = [];
  let pos = true;
  let wrapped = null; // after a wrapper word (its name), its flags keep the position
  let envName = false; // after a wrapper's value flag (env -u, env -C), the next token is its value
  let arg = null; // inside an ARG_WRAPPERS wrapper's own options and arguments
  for (const t of seg) {
    at.push(pos);
    if (!pos) continue;
    const v = t.quoted ? null : t.value;
    if (arg) {
      const flag = v !== null && v.length > 1 && v.startsWith("-");
      if (arg.pending) {
        arg.pending = false;
        continue;
      }
      if (flag) {
        const name = v.startsWith("--") ? v.split("=")[0] : v;
        if (!v.includes("=") && (v.startsWith("--") ? arg.spec.long : arg.spec.short).has(name)) arg.pending = true;
        continue;
      }
      if (arg.need > 0) {
        arg.need--;
        continue;
      }
      arg = null;
    }
    if (v !== null && Object.hasOwn(ARG_WRAPPERS, v)) {
      arg = { spec: ARG_WRAPPERS[v], need: ARG_WRAPPERS[v].need, pending: false };
      wrapped = null;
      continue;
    }
    if (envName) envName = false;
    else if (wrapped && WRAPPER_VALUE_FLAGS[wrapped]?.has(v)) envName = true;
    else if (v !== null && (KEYWORDS.has(v) || WRAPPERS.has(v))) wrapped = WRAPPERS.has(v) ? v : null;
    else if (v !== null && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(v)) {
      // a VAR=value prefix, or env's assignments: still before the command word
    } else if (!(wrapped && v !== null && v.startsWith("-"))) pos = false;
  }
  return at;
}

const isExpansion = (t) => t.raw.startsWith("$") || t.raw.startsWith('"$');

/** Signing calls in one simple command: [{ offset, sub, passthrough, ok }]. */
function signingCalls(seg) {
  const calls = [];
  const positions = commandPositions(seg);
  for (let i = 0; i < seg.length; i++) {
    if (!isCosign(seg[i], positions[i])) continue;
    const rest = seg.slice(i + 1);
    let sub = rest.find((t) => SIGNING.has(t.value))?.value;
    let passthrough = false;
    if (!sub) {
      const first = rest.find((t) => !t.value.startsWith("-"));
      if (first && isExpansion(first)) sub = `${first.raw} (a subcommand that may sign)`;
      passthrough = Boolean(sub);
    }
    if (!sub) continue;
    let upload = null;
    rest.forEach((t, k) => {
      if (t.value === "--tlog-upload") upload = rest[k + 1]?.value ?? "";
      else if (t.value.startsWith("--tlog-upload=")) upload = t.value.slice("--tlog-upload=".length);
    });
    calls.push({ offset: seg[i].offset, sub, passthrough, ok: upload === "false" });
    break;
  }
  return calls;
}

/** OTEL_ assignments in one simple command: [{ offset, name }]. */
function otelAssignments(seg) {
  const found = [];
  const note = (t) => {
    if (!t.quoted && t.value.startsWith("OTEL_") && ASSIGNMENT.test(t.value)) found.push({ offset: t.offset, name: t.value.split(/\+?=/)[0] });
  };
  let i = 0;
  while (i < seg.length) {
    const t = seg[i];
    if (TRANSPARENT.has(t.value)) i++;
    else if (!t.quoted && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(t.value)) {
      note(t);
      i++;
    }
    else break;
  }
  if (i < seg.length && DECLARERS.has(seg[i].value)) {
    const isEnv = seg[i].value === "env";
    for (i++; i < seg.length; i++) {
      const t = seg[i];
      if (t.value.startsWith("-")) continue;
      if (isEnv && !t.value.includes("=")) break;
      note(t);
    }
  }
  return found;
}

/** Scripts that bash -c, sh -c, flock -c, env -S or eval run, as [{ text, base }]. */
function innerScripts(seg) {
  const out = [];
  const script = (t) => ({ text: t.value, base: t.offset + (t.quoted ? 1 : 0) });
  for (let i = 0; i < seg.length; i++) {
    const t = seg[i];
    if (t.quoted) continue;
    const word = t.value.slice(t.value.lastIndexOf("/") + 1);
    if (word === "eval" && i + 1 < seg.length) {
      out.push({ text: seg.slice(i + 1).map((x) => x.value).join(" "), base: seg[i + 1].offset });
    } else if (word === "bash" || word === "sh") {
      const k = seg.findIndex((x, j) => j > i && /^-[a-z]*c[a-z]*$/.test(x.value));
      if (k !== -1 && seg[k + 1]) out.push(script(seg[k + 1]));
    } else if (word === "flock" || word === "env") {
      // flock's -c/--command and env's -S/--split-string take a whole command line.
      const [short, long] = word === "flock" ? ["c", "--command"] : ["S", "--split-string"];
      for (let k = i + 1; k < seg.length; k++) {
        const v = seg[k].value;
        if (v === `-${short}` || v === long || (word === "flock" && /^-[a-zA-Z]*c$/.test(v) && !seg[k].quoted)) {
          if (seg[k + 1]) out.push(script(seg[k + 1]));
          break;
        }
        const attached = v.startsWith(`${long}=`) ? long.length + 1 : word === "env" && v.startsWith("-S") ? 2 : 0;
        if (attached) {
          out.push({ text: v.slice(attached), base: seg[k].offset + attached });
          break;
        }
      }
    }
  }
  return out;
}

function checkText(text, base, sink, depth = 0) {
  for (const seg of simpleCommands(text, base)) {
    for (const call of signingCalls(seg)) sink.call(call);
    for (const a of otelAssignments(seg)) sink.otel(a);
    if (depth < 8) for (const s of innerScripts(seg)) checkText(s.text, s.base, sink, depth + 1);
  }
}

function lineOf(logical, offset) {
  let n = logical.parts[0].line;
  for (const p of logical.parts) if (p.offset <= offset) n = p.line;
  return n;
}

function checkShell(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const problems = new Map();
  const report = (line, reason) => problems.set(`${line}\0${reason}`, { line, reason });
  const otelReason = (name) => `${name} is set; cosign and CI send no telemetry (#1841)`;
  lines.forEach((line, i) => {
    const m = !isComment(line) && YAML_OTEL.exec(line);
    if (m) report(i + 1, otelReason(m[1]));
  });
  for (const logical of logicalLines(lines)) {
    if (isComment(logical.text) || !/cosign|OTEL_/i.test(logical.text)) continue;
    const calls = [];
    checkText(logical.text, 0, {
      otel: (a) => report(lineOf(logical, a.offset), otelReason(a.name)),
      call: (c) => calls.push(c),
    });
    // A marker excuses the first call on the line below it, and no other.
    const perLine = new Map();
    for (const c of calls.sort((a, b) => a.offset - b.offset)) {
      const n = lineOf(logical, c.offset);
      const first = !perLine.has(n);
      perLine.set(n, true);
      if (c.ok) continue;
      const above = n >= 2 ? lines[n - 2] : "";
      if ((first && MARKER.test(above)) || (c.passthrough && PASSTHROUGH.test(above))) continue;
      report(
        n,
        `cosign ${c.sub} without --tlog-upload=false uploads to the public Rekor log (#1841); add the flag, or mark an intended public upload with "# cosign-public-upload: <reason>" on the line above`,
      );
    }
  }
  return [...problems.values()].sort((a, b) => a.line - b.line);
}

const noFlagReason = (sub) =>
  `cosign ${sub} without --tlog-upload=false uploads to the public Rekor log (#1841); add the flag (code files and Dockerfiles have no public-upload marker)`;
const otelReason = (name) => `${name} is set; cosign and CI send no telemetry (#1841)`;

/** The text after the closing quote of the string or template starting at i. */
function skipString(text, i) {
  const q = text[i];
  let value = "";
  let j = i + 1;
  for (; j < text.length && text[j] !== q; j++) {
    if (text[j] === "\\" && j + 1 < text.length) {
      value += text[++j];
    } else if (q === "`" && text[j] === "$" && text[j + 1] === "{") {
      let depth = 1;
      for (j += 2; j < text.length && depth; j++) {
        if (text[j] === '"' || text[j] === "'" || text[j] === "`") j = skipString(text, j).end - 1;
        else if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
      }
      j--;
      value += "$_";
    } else if (text[j] === "\n" && q !== "`") break;
    else value += text[j];
  }
  return { value, end: j + 1 };
}

/**
 * JS/TS source with comments blanked and each string, template or regex
 * literal replaced by \u0001<n>\u0001 (strs[n] holds its value), keeping every
 * newline so line numbers carry over.
 */
function scrubJs(text) {
  let code = "";
  const strs = [];
  const newlines = (a, b) => "\n".repeat((text.slice(a, b).match(/\n/g) ?? []).length);
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    const d = text[i + 1];
    if (c === "/" && d === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && d === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      code += newlines(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      const { value, end } = skipString(text, i);
      strs.push(value);
      code += `\u0001${strs.length - 1}\u0001${newlines(i, end)}`;
      i = end;
    } else if (c === "/" && (/[(,=:[!&|?{};+\-*%<>~^]\s*$/.test(code) || code.trim() === "" || /\b(return|typeof|case|in|of|delete|void|throw|new|else|do)\s*$/.test(code))) {
      let j = i + 1;
      for (let cls = false; j < text.length && text[j] !== "\n" && (cls || text[j] !== "/"); j++) {
        if (text[j] === "\\") j++;
        else if (text[j] === "[") cls = true;
        else if (text[j] === "]") cls = false;
      }
      j++; // the closing slash
      while (/[a-z]/.test(text[j] ?? "")) j++; // flags
      strs.push("");
      code += `\u0001${strs.length - 1}\u0001`;
      i = j;
    } else {
      code += c;
      i++;
    }
  }
  return { code, strs };
}

/** The index just past the bracket closing the one that opens at code[open], and its top-level elements. */
function bracketed(code, open) {
  const closer = { "(": ")", "[": "]" }[code[open]];
  const items = [];
  let depth = 0;
  let from = open + 1;
  let i = open;
  for (; i < code.length; i++) {
    const c = code[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      depth--;
      if (depth === 0) {
        if (c === closer) items.push(code.slice(from, i));
        break;
      }
    } else if (c === "," && depth === 1) {
      items.push(code.slice(from, i));
      from = i + 1;
    }
  }
  return { end: i + 1, items: items.map((x) => x.trim()) };
}

function checkCode(file) {
  const text = readFileSync(file, "utf8");
  if (!/cosign|OTEL_/i.test(text)) return [];
  const { code, strs } = scrubJs(text);
  const problems = new Map();
  const lineAt = (offset) => (code.slice(0, offset).match(/\n/g) ?? []).length + 1;
  const report = (offset, reason) => {
    const line = lineAt(offset);
    problems.set(`${line}\0${reason}`, { line, reason });
  };
  const literal = (x) => {
    const m = /^\u0001(\d+)\u0001$/.exec(x);
    return m ? strs[Number(m[1])] : null;
  };
  const pieces = (x) =>
    x
      .split("+")
      .map((piece) => literal(piece.trim()) ?? "$_")
      .join("");
  const shellSink = (at) => ({
    otel: (a) => report(at, otelReason(a.name)),
    call: (c) => {
      if (!c.ok) report(at, noFlagReason(c.sub));
    },
  });
  // Names that call child_process, with the aliases this file imports them under.
  const fileFns = new Set(["execFile", "execFileSync", "spawn", "spawnSync"]);
  const shellFns = new Set(["exec", "execSync"]);
  const alias = (list, spec, sep) => {
    if (spec !== "node:child_process" && spec !== "child_process") return;
    for (const part of list.split(",")) {
      const [orig, name] = part.split(sep).map((x) => x.trim());
      if (!name || !/^[\w$]+$/.test(name)) continue;
      if (fileFns.has(orig)) fileFns.add(name);
      if (shellFns.has(orig)) shellFns.add(name);
    }
  };
  for (const m of code.matchAll(/\bimport\s+(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*\u0001(\d+)\u0001/g)) alias(m[1], strs[Number(m[2])], /\s+as\s+/);
  for (const m of code.matchAll(/\{([^{}]*)\}\s*=\s*(?:require|await\s+import)\s*\(\s*\u0001(\d+)\u0001\s*\)/g)) alias(m[1], strs[Number(m[2])], ":");
  const names = (set) => [...set].map((n) => n.replace(/\$/g, "\\$")).join("|");
  for (const m of code.matchAll(new RegExp(`(?<![\\w$])(?:${names(fileFns)})\\s*\\(\\s*\\u0001(\\d+)\\u0001\\s*([,)])`, "g"))) {
    const prog = strs[Number(m[1])];
    const base = prog.slice(prog.lastIndexOf("/") + 1);
    const shell = base === "sh" || base === "bash";
    if ((base !== "cosign" && !shell) || m[2] === ")") continue;
    const rest = code.slice(m.index + m[0].length).trimStart();
    const at = code.length - rest.length;
    if (!rest.startsWith("[")) {
      report(m.index, noFlagReason(shell ? "through a shell whose arguments are not a literal array (may sign)" : "with arguments not given as a literal array (may sign)"));
      continue;
    }
    const args = bracketed(code, at).items.filter((x) => x !== "");
    const values = args.map(literal);
    if (shell) {
      // sh -c / bash -c: the script string is checked as a shell command.
      const k = values.findIndex((v) => v !== null && /^-[a-z]*c[a-z]*$/.test(v));
      if (k !== -1 && args[k + 1] !== undefined) checkText(pieces(args[k + 1]), 0, shellSink(m.index));
      continue;
    }
    let sub = values.find((v) => SIGNING.has(v));
    if (!sub && args.length && values[0] === null) sub = "(a first argument that may sign)";
    if (!sub) continue;
    let upload = null;
    values.forEach((v, k) => {
      if (v === "--tlog-upload") upload = values[k + 1] ?? "";
      else if (v?.startsWith("--tlog-upload=")) upload = v.slice("--tlog-upload=".length);
    });
    if (upload !== "false") report(m.index, noFlagReason(sub));
  }
  for (const m of code.matchAll(new RegExp(`(?<![\\w$])(?:${names(shellFns)})\\s*\\(`, "g"))) {
    const first = bracketed(code, m.index + m[0].length - 1).items[0] ?? "";
    checkText(pieces(first), 0, shellSink(m.index));
  }
  for (const m of code.matchAll(/\bOTEL_\w+\s*:|\.OTEL_\w+\s*=(?!=)|\u0001(\d+)\u0001\s*(?::|\]\s*=(?!=))/g)) {
    const name = m[1] === undefined ? /OTEL_\w+/.exec(m[0])?.[0] : strs[Number(m[1])].startsWith("OTEL_") ? strs[Number(m[1])] : null;
    if (name) report(m.index, otelReason(name));
  }
  return [...problems.values()].sort((a, b) => a.line - b.line);
}

function checkDockerfile(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const problems = new Map();
  const report = (line, reason) => problems.set(`${line}\0${reason}`, { line, reason });
  for (const logical of logicalLines(lines)) {
    const m = /^\s*(RUN|ENV|ARG)\s+/i.exec(logical.text);
    if (!m) continue;
    const kind = m[1].toUpperCase();
    let rest = logical.text.slice(m[0].length);
    const base = m[0].length;
    if (kind === "RUN") {
      rest = rest.replace(/^(?:--\S+\s+)+/, "");
      const offset = logical.text.length - rest.length;
      let text = rest;
      if (rest.trimStart().startsWith("[")) {
        try {
          text = JSON.parse(rest.trim()).join(" ");
        } catch {
          // not JSON: it is shell form after all
        }
      }
      checkText(text, offset, {
        otel: (a) => report(lineOf(logical, a.offset), otelReason(a.name)),
        call: (c) => {
          if (!c.ok) report(lineOf(logical, c.offset), noFlagReason(c.sub));
        },
      });
    } else if (/^[^\s=]+=/.test(rest)) {
      checkText(`export ${rest}`, base - 7, {
        otel: (a) => report(lineOf(logical, Math.max(0, a.offset)), otelReason(a.name)),
        call: () => {},
      });
    } else {
      const name = rest.split(/\s+/)[0];
      if (/^OTEL_\w*$/.test(name)) report(lineOf(logical, base), otelReason(name));
    }
  }
  return [...problems.values()].sort((a, b) => a.line - b.line);
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const INCLUDE_KEYS = new Set(["local", "project", "ref", "file", "rules", "inputs", "component", "remote", "template"]);
const NESTED_KEYS = new Set(["file", "rules", "inputs"]);
const SUBSET = "is outside the include subset this check reads (#1843)";
const blankOrComment = (l) => l.trim() === "" || /^\s*#/.test(l);
const QUOTED_KEY = /^(?:"[^"]*"|'(?:[^']|'')*')\s*:(?:\s|$)/;

/**
 * One block-context value: { value, quoted } for a plain or quoted scalar
 * (trailing comment dropped), { empty } for nothing, or { error }.
 */
function readScalar(text) {
  const s = text.trim();
  if (s === "" || s.startsWith("#")) return { empty: true };
  if (s[0] === '"') {
    const m = /^"([^"\\]*)"\s*(?:#.*)?$/.exec(s);
    return m ? { value: m[1], quoted: true } : { error: `a double-quoted value with escapes or text after it ${SUBSET}` };
  }
  if (s[0] === "'") {
    const m = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(s);
    return m ? { value: m[1].replace(/''/g, "'"), quoted: true } : { error: `a single-quoted value with text after it ${SUBSET}` };
  }
  if (/^[[\]{},&*!|>%@`]/.test(s) || /^[-?:](?:\s|$)/.test(s)) {
    return { error: `a flow collection, anchor (&), alias (*), tag (!), block scalar or nested entry ${SUBSET}` };
  }
  const value = s.replace(/\s+#.*$/, "");
  if (/:(?:\s|$)/.test(value)) return { error: `a plain value holding ": " ${SUBSET}` };
  return { value, quoted: false };
}

/**
 * Reads every top-level include key of one CI file, in any spelling, and
 * accepts only the block form in the header. Returns problems, not-scanned
 * notes, and the local files to follow.
 */
function readIncludes(file, root) {
  const lines = readFileSync(file, "utf8").split("\n").map((l) => l.replace(/\r$/, ""));
  const problems = [];
  const notes = [];
  const locals = [];
  const fail = (j, reason) => problems.push({ line: j + 1, reason });
  let docStart = true;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (blankOrComment(l)) {
      i++;
      continue;
    }
    if (/^(?:---|\.\.\.)(?:\s|$)/.test(l)) {
      if (!/^(?:---|\.\.\.)\s*(?:#.*)?$/.test(l)) fail(i, `content on a document marker line ${SUBSET}`);
      docStart = true;
      i++;
      continue;
    }
    if (/^\s/.test(l)) {
      if (docStart) fail(i, `an indented top-level mapping ${SUBSET}; top-level keys start at column 0`);
      docStart = false;
      i++;
      continue;
    }
    docStart = false;
    let key;
    let rest;
    let quoted = false;
    if (l[0] === '"' || l[0] === "'") {
      const m = QUOTED_KEY.exec(l);
      if (!m || (l[0] === '"' && l.slice(0, m[0].length).includes("\\"))) {
        fail(i, `a quoted top-level key with escapes, or not a key closed on its line, may spell include and ${SUBSET}`);
        i++;
        continue;
      }
      const raw = m[0].replace(/\s*:\s?$/, "");
      key = l[0] === "'" ? raw.slice(1, -1).replace(/''/g, "'") : raw.slice(1, -1);
      rest = l.slice(m[0].length);
      quoted = true;
    } else if (/^-(?:\s|$)/.test(l)) {
      i++; // an entry of the previous key's block sequence
      continue;
    } else if (/^[[\]{},?!&*%@`|>]/.test(l)) {
      fail(i, `a top-level line starting with a flow collection, explicit key (?), tag (!), anchor (&), alias (*) or directive ${SUBSET}`);
      i++;
      continue;
    } else {
      const m = /^([^\s#][^#]*?)\s*:(?:\s|$)/.exec(l);
      if (!m) {
        i++;
        continue;
      }
      key = m[1];
      rest = l.slice(m[0].length);
    }
    if (key === "<<") {
      fail(i, `a top-level merge key (<<) can bring in an include key and ${SUBSET}`);
      i++;
      continue;
    }
    if (key !== "include") {
      i++;
      continue;
    }
    if (quoted) fail(i, `a quoted include key ${SUBSET}; write include: unquoted`);
    else if (!l.startsWith("include:")) fail(i, `include with space before the colon ${SUBSET}`);
    if (!/^\s*(?:#.*)?$/.test(rest)) {
      fail(i, /https?:\/\//i.test(rest)
        ? "include of a URL (remote) is refused; the check never fetches (#1843)"
        : `a value on the include: line (a string, flow list or mapping, anchor, alias or tag) ${SUBSET}; write a block list of items`);
    }
    let end = i + 1;
    while (end < lines.length && (blankOrComment(lines[end]) || /^\s/.test(lines[end]) || /^-(?:\s|$)/.test(lines[end]))) end++;
    readIncludeBlock(lines, i + 1, end, root, { fail, notes, locals });
    i = end;
  }
  readTriggerIncludes(lines, root, { fail, notes, locals });
  refuseFlowIncludes(lines, fail);
  refuseEscapedKeys(lines, fail);
  refuseDecoratedKeys(lines, fail);
  return { problems, notes, locals };
}

/**
 * An explicit key (?) or a mapping key with an anchor (&name) or tag (!...)
 * in front of it fails at any depth (#1843 note 59989): either can hide an
 * escaped include or trigger key. Anchors and tags on values (.x: &x,
 * - !reference [...]) are fine. Comments, block-scalar bodies and the inner
 * lines of a multi-line quoted scalar are not read; column 0 is the
 * top-level reader's.
 */
function refuseDecoratedKeys(lines, fail) {
  const ind = (l) => l.length - l.trimStart().length;
  const KEY = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#"'][^#]*?)\s*:(?:\s|$)/;
  let blockAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (blankOrComment(l)) continue;
    if (blockAt >= 0 && ind(l) > blockAt) continue;
    blockAt = /(?:^\s*-|:)\s+(?:[&!]\S*\s+)*[|>][-+0-9]*\s*(?:#.*)?$/.test(l) ? ind(l) : -1;
    let t = l.trimStart().replace(/^(?:-(?:\s+|$))+/, "");
    if (ind(l) > 0 || l.startsWith("-")) {
      if (/^\?(?:\s|$)/.test(t)) {
        fail(i, `an explicit key (?) ${SUBSET}`);
        continue;
      }
      const deco = /^(?:[&!]\S*\s+)+/.exec(t);
      if (deco && KEY.test(t.slice(deco[0].length))) {
        fail(i, `a mapping key with an anchor (&) or tag (!) in front of it ${SUBSET}`);
        continue;
      }
    }
    // A quoted scalar starting this line's node may run on: skip its inner lines.
    const value = KEY.exec(t);
    if (value) t = t.slice(value[0].length).trimStart();
    t = t.replace(/^(?:[&!]\S*\s+)+/, "");
    const q = t[0];
    if (q !== '"' && q !== "'") continue;
    let j = i;
    let k = 1;
    let closed = false;
    for (; j < lines.length && !closed; j++, k = 0) {
      const line = j === i ? t : lines[j];
      for (; k < line.length; k++) {
        if (q === '"' && line[k] === "\\") k++;
        else if (q === "'" && line[k] === "'" && line[k + 1] === "'") k++;
        else if (line[k] === q) {
          closed = true;
          break;
        }
      }
      if (closed) break;
    }
    i = Math.max(i, j);
  }
}

/**
 * A double-quoted block-style key holding a backslash, at any depth, fails
 * at the first such line (#1843 note 59986): an escape (\x69nclude) or a fold
 * can spell include or trigger, and ordinary CI files need neither. A
 * backslash in a value is fine; comments and block-scalar bodies are not read.
 */
function refuseEscapedKeys(lines, fail) {
  const ind = (l) => l.length - l.trimStart().length;
  let blockAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (blankOrComment(l)) continue;
    if (blockAt >= 0 && ind(l) > blockAt) continue;
    blockAt = /(?:^\s*-|:)\s+(?:[&!]\S*\s+)*[|>][-+0-9]*\s*(?:#.*)?$/.test(l) ? ind(l) : -1;
    const m = /^\s*(?:[-?]\s+)*"/.exec(l);
    if (!m) continue;
    // Read the string to its closing quote, across lines, escapes skipped.
    let escaped = false;
    let j = i;
    let k = m[0].length;
    let after = null;
    for (; j < lines.length && after === null; j++, k = 0) {
      const line = lines[j];
      for (; k < line.length; k++) {
        if (line[k] === "\\") {
          escaped = true;
          k++;
        } else if (line[k] === '"') {
          after = line.slice(k + 1);
          break;
        }
      }
      if (after !== null) break;
    }
    // After ? (an explicit key) the string is a key wherever its colon sits.
    if (escaped && (after === null || /\?\s/.test(m[0]) || /^\s*:(?:\s|$)/.test(after))) {
      fail(i, `a double-quoted key holding a backslash (an escape or a fold, which can spell include or trigger) ${SUBSET}`);
      return;
    }
    i = Math.max(i, j);
  }
}

/**
 * A flow value ({ or [ after key: or - , behind any anchor or tag) that names
 * include or trigger fails at its first line, wherever it sits: a one-line
 * job can hide a trigger include (#1843 note 59980). Comments and the bodies
 * of block scalars (script: |) are not read.
 */
function refuseFlowIncludes(lines, fail) {
  const START = /^(\s*)(?:-\s+)*(?:(?:"[^"]*"|'[^']*'|[^\s#'"-][^#]*?|-[^\s#][^#]*?)\s*:\s+)?(?:[&!]\S*\s+)*([[{])/;
  const ind = (l) => l.length - l.trimStart().length;
  let blockAt = -1; // indent of the line that opened a block scalar
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (blankOrComment(l)) continue;
    if (blockAt >= 0 && ind(l) > blockAt) continue;
    blockAt = /(?:^\s*-|:)\s+(?:[&!]\S*\s+)*[|>][-+0-9]*\s*(?:#.*)?$/.test(l) ? ind(l) : -1;
    const m = START.exec(l);
    if (!m) continue;
    // The flow text: from its bracket until the brackets balance, across lines, quotes skipped.
    let text = "";
    let depth = 0;
    let q = null;
    let escaped = false; // the double-quoted string being read holds a backslash
    let escapedKey = false;
    let j = i;
    let k = m[0].length - 1;
    for (; j < lines.length; j++, k = 0) {
      const line = lines[j];
      for (; k < line.length; k++) {
        const c = line[k];
        if (q === '"' && c === "\\") {
          // An escape: the next character (or the line break it folds) is not the closing quote.
          escaped = true;
          text += c + (line[k + 1] ?? "");
          k++;
          continue;
        }
        if (q) {
          if (c === q) {
            q = null;
            // A double-quoted key with escapes can spell include or trigger without the word.
            if (escaped && /^\s*:/.test(line.slice(k + 1))) escapedKey = true;
          }
        } else if (c === '"' || c === "'") {
          q = c;
          escaped = false;
        }
        else if (c === "#" && /\s/.test(line[k - 1] ?? " ")) break;
        else if (c === "[" || c === "{") depth++;
        else if (c === "]" || c === "}") depth--;
        text += c;
        if (depth === 0) break;
      }
      if (depth <= 0) break;
      text += "\n";
    }
    if (/\b(?:include|trigger)\b/.test(text)) fail(i, `a flow value naming include or trigger ${SUBSET}; write it in block style`);
    else if (escapedKey) fail(i, `a flow value with a double-quoted key holding a backslash escape (which can spell include or trigger) ${SUBSET}`);
    i = Math.max(i, j);
  }
}

/**
 * A job's trigger: include: (a child pipeline) gets the top-level rules, plus
 * one extra form: `include: <path>`, a plain scalar naming a local file,
 * which is followed (#1843 note 59967).
 */
function readTriggerIncludes(lines, root, out) {
  const { fail } = out;
  const ind = (l) => l.length - l.trimStart().length;
  for (let i = 0; i < lines.length; i++) {
    const t = /^( *)(["']?)trigger\2\s*:(.*)$/.exec(lines[i]);
    if (!t) continue;
    const T = t[1].length;
    if (t[2] || !lines[i].slice(T).startsWith("trigger:")) fail(i, `a quoted trigger key, or a space before its colon, ${SUBSET}`);
    const v = readScalar(t[3]);
    if (v.error) fail(i, `trigger: ${v.error}`);
    if (!v.empty) {
      // trigger: group/project, a multi-project pipeline: unquoted, never a URL.
      if (!v.error && (v.quoted || v.value.includes("://"))) fail(i, `trigger: as a scalar must be an unquoted project path (group/project), not a quoted value or a URL ${SUBSET}`);
      continue;
    }
    let C = -1;
    let j = i + 1;
    for (; j < lines.length && (blankOrComment(lines[j]) || ind(lines[j]) > T); j++) {
      const l = lines[j];
      if (blankOrComment(l)) continue;
      if (C < 0) C = ind(l);
      if (ind(l) !== C) continue;
      const k = /^ *(["']?)([^\s:#"']+)\1\s*:(.*)$/.exec(l);
      if (!k) continue;
      if (k[2] === "<<") {
        fail(j, `a merge key (<<) under trigger: can bring in an include key and ${SUBSET}`);
        continue;
      }
      if (k[2] !== "include") continue;
      if (k[1] || !l.slice(C).startsWith("include:")) fail(j, `a quoted include key, or a space before its colon, ${SUBSET}`);
      const s = readScalar(k[3]);
      let end = j + 1;
      while (end < lines.length && (blankOrComment(lines[end]) || ind(lines[end]) > C || (ind(lines[end]) === C && /^ *-(?:\s|$)/.test(lines[end])))) end++;
      if (s.error) fail(j, `trigger include: ${s.error}`);
      else if (!s.empty) followLocal("a trigger's include:", { line: j, ...s }, root, fail, out.locals);
      readIncludeBlock(lines, j + 1, end, root, out, C);
      j = end - 1;
    }
    i = j - 1;
  }
}

function readIncludeBlock(lines, from, end, root, out, keyIndent = 0) {
  const { fail } = out;
  const items = [];
  let dash = -1;
  let item = null;
  const itemKey = (j, text) => {
    item.nested = null;
    if (QUOTED_KEY.test(text)) return fail(j, `a quoted key in an include item ${SUBSET}`);
    const m = /^([A-Za-z_][\w-]*):(?: +(.*))?$/.exec(text);
    if (!m) return fail(j, `an include item line that is not key: value ${SUBSET}`);
    const [, k, rest = ""] = m;
    if (!INCLUDE_KEYS.has(k)) {
      item.nested = { key: k, skip: true };
      return fail(j, `include item key ${k}: ${SUBSET} (local, project, ref, file, rules, inputs, component)`);
    }
    if (item.keys.has(k)) fail(j, `a second ${k}: in one include item ${SUBSET}`);
    const s = readScalar(rest);
    if (s.error) {
      item.keys.set(k, { line: j, value: null });
      item.nested = { key: k, skip: true };
      return fail(j, `${k}: ${s.error}`);
    }
    if (s.empty) {
      if (!NESTED_KEYS.has(k)) fail(j, `${k}: with no value on its line ${SUBSET}`);
      item.nested = { key: k, indent: -1, list: [] };
      item.keys.set(k, { line: j, value: null, list: item.nested.list });
    } else item.keys.set(k, { line: j, value: s.value, quoted: s.quoted });
  };
  const nestedLine = (j, l, ind) => {
    const n = item.nested;
    if (n.skip) return;
    if (n.key === "file") {
      if (n.indent < 0) n.indent = ind;
      const m = /^ *- +(.*)$/.exec(l);
      const s = m ? readScalar(m[1]) : null;
      if (ind !== n.indent || !s || s.error || s.empty) return fail(j, `file: takes a scalar or a block list of scalars; this line ${SUBSET}`);
      n.list.push(s.value);
      return;
    }
    // rules: and inputs: are not read, but every node on the line is a plain or quoted scalar.
    let t = l.slice(ind);
    while (/^-(?: +|$)/.test(t)) t = t.replace(/^- */, "");
    if (t === "" || t.startsWith("#")) return;
    if (QUOTED_KEY.test(t)) return fail(j, `a quoted key under ${n.key}: ${SUBSET}`);
    const m = /^([A-Za-z_][\w.-]*):(?: +(.*))?$/.exec(t);
    const s = readScalar(m ? (m[2] ?? "") : t);
    if (s.error) fail(j, `under ${n.key}: ${s.error}`);
  };
  for (let j = from; j < end; j++) {
    const l = lines[j];
    if (blankOrComment(l)) continue;
    if (/^ *\t/.test(l)) {
      fail(j, `a tab in the indentation ${SUBSET}`);
      continue;
    }
    const ind = l.length - l.trimStart().length;
    if (ind <= keyIndent) {
      fail(j, `a list dash at the include key's own column ${SUBSET}; indent the items`);
      item = null;
      continue;
    }
    const d = /^( *)(-(?: +|$))(.*)$/.exec(l);
    if (d && (dash < 0 || ind === dash)) {
      dash = ind;
      item = { line: j, keyCol: d[1].length + d[2].length, keys: new Map(), nested: null };
      items.push(item);
      const body = d[3];
      if (body.trim() === "" || body.trim().startsWith("#")) {
        fail(j, `an empty list dash ${SUBSET}; write - key: value`);
        item.bad = true;
      } else if (!QUOTED_KEY.test(body) && !/^[A-Za-z_][\w-]*:(?:\s|$)/.test(body)) {
        const s = readScalar(body);
        fail(j, s.error ?? (/^https?:\/\//i.test(s.value) ? "include of a URL (remote) is refused; the check never fetches (#1843)" : `a string include item ${SUBSET}; write - local: <path>`));
        item.bad = true;
      } else itemKey(j, body);
      continue;
    }
    if (!item || item.bad) {
      if (!item) fail(j, `an include entry that is not an indented - list item ${SUBSET}`);
      continue;
    }
    if (ind === item.keyCol && !d) itemKey(j, l.slice(ind));
    else if (ind > item.keyCol && item.nested) nestedLine(j, l, ind);
    else fail(j, `a line at this indentation under include: ${SUBSET}`);
  }
  for (const it of items) if (!it.bad) checkIncludeItem(it, root, out);
}

function checkIncludeItem(item, root, { fail, notes, locals }) {
  const K = item.keys;
  const sources = ["local", "project", "component", "remote", "template"].filter((k) => K.has(k));
  if (sources.length === 0) fail(item.line, `an include item with none of local:, project: or component: ${SUBSET}`);
  if (sources.length > 1) fail(item.line, `an include item naming more than one of ${sources.join(", ")} ${SUBSET}`);
  for (const k of ["ref", "file"]) if (K.has(k) && !K.has("project")) fail(K.get(k).line, `${k}: outside a project: item ${SUBSET}`);
  if (K.has("remote")) fail(K.get("remote").line, "remote: include is refused; the check never fetches (#1843)");
  if (K.has("template")) fail(K.get("template").line, "template: include is refused; GitLab's built-in templates cannot be pinned to a commit (#1843)");
  const comp = K.get("component");
  if (comp && comp.value !== null) {
    const v = comp.value;
    if (/@[0-9a-f]{40}$/.test(v)) notes.push(`${v.slice(0, v.lastIndexOf("@"))} ref ${v.slice(v.lastIndexOf("@") + 1)}`);
    else fail(comp.line, "component: include must end in @<40-hex commit sha>; the check never fetches (#1843)");
  }
  const proj = K.get("project");
  if (proj && proj.value !== null) {
    const ref = K.get("ref")?.value ?? "";
    if (!FULL_SHA.test(ref)) {
      fail(proj.line, "project: include needs ref: (the item's own key) set to a full 40-hex commit sha (tags and branches move); the check never fetches (#1843)");
    } else {
      const fl = K.get("file");
      const files = fl ? (fl.list ?? (fl.value === null ? [] : [fl.value])) : [];
      notes.push(`project ${proj.value} ref ${ref} files ${files.join(", ") || "(none)"}`);
    }
  }
  const loc = K.get("local");
  if (loc && loc.value !== null) followLocal("local:", loc, root, fail, locals);
}

/** A local path to follow: plain, no glob or $, an existing regular file inside the repository. */
function followLocal(what, { line, value: p, quoted }, root, fail, locals) {
  if (quoted) return fail(line, `a quoted ${what} path ${SUBSET}; write the path plain`);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return fail(line, `${what} naming a URL (remote) is refused; the check never fetches (#1843)`);
  if (/[*?[{$]/.test(p)) return fail(line, `${what} with a glob or a variable cannot be followed, so its file would go unscanned (#1843)`);
  const full = resolve(root, p.replace(/^\/+/, ""));
  let real;
  try {
    real = realpathSync(full);
  } catch {
    return fail(line, `${what} names a file that does not exist, so nothing would be scanned (#1843)`);
  }
  if (!real.startsWith(realpathSync(root) + sep)) return fail(line, `${what} names a file outside the repository (#1843)`);
  if (!statSync(real).isFile()) return fail(line, `${what} names something that is not a regular file (#1843)`);
  locals.push(full);
}

function check(file) {
  const name = file.slice(file.lastIndexOf("/") + 1);
  if (isDockerfile(name)) return checkDockerfile(file);
  if (isCode(name)) return checkCode(file);
  return checkShell(file);
}

const root = resolve(parseArgs(process.argv.slice(2)));
let count = 0;
for (const file of filesToScan(root)) {
  const rel = relative(root, file).split(sep).join("/");
  const found = check(file);
  const inc = includes.get(file) ?? { problems: [], notes: [] };
  const all = [...found, ...inc.problems].sort((a, b) => a.line - b.line);
  for (const p of all) {
    console.log(`${rel}:${p.line}: ${p.reason}`);
    count++;
  }
  for (const n of inc.notes) console.log(`${rel}: not scanned: ${n}`);
}
process.exit(count ? 1 : 0);
