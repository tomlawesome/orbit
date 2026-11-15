#!/usr/bin/env node
/**
 * Cosign call checker (#1841; owner, 2026-11-14: cosign sends no telemetry
 * and publishes nothing beyond what signing needs).
 *
 * Scans .gitlab-ci.yml and every file it includes with `local:` (nested
 * includes followed), .github/workflows/*.yml and *.yaml, and
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
 * simple commands at unquoted ; && || | & ( ), and each $(...) is checked as
 * a command of its own. A call is an unquoted cosign token (cosign,
 * /path/cosign, or a variable whose name contains "cosign", such as
 * "${cosign}" or $COSIGN_BIN) followed later in the same simple command by a
 * signing subcommand, bare or quoted, so wrappers (env, sudo, exec, xargs,
 * x=1 prefixes) and global flags in between still count. A cosign whose first
 * non-flag argument is a variable ("$@", $*, $sub) may be signing, so it
 * counts too. Quoted text is prose, except the script of bash -c, sh -c and
 * the arguments of eval, which are checked as commands.
 *
 * A variable named *cosign* counts only in command position: the command
 * word, or after env (its VAR=value and -u NAME), exec, sudo, nohup,
 * command, time, xargs or VAR=value prefixes, or after timeout, nice, ionice,
 * setsid, stdbuf or flock with their own options and arguments (the duration
 * of timeout, the lock of flock). `# cosign-passthrough: <reason>`
 * directly above allows only the variable-subcommand case (a wrapper that
 * forwards "$@"); it never excuses an explicit signing subcommand.
 *
 * In .mjs and .ts files the calls are execFile, execFileSync, spawn and
 * spawnSync with "cosign" as the first argument (a literal array of arguments
 * is read; any other second argument may sign and counts), and exec or
 * execSync with a command string (its string and template pieces are checked
 * as a shell command). Comments and strings that are not such a call are
 * prose, and an OTEL_ key or assignment in code is flagged. In a Dockerfile
 * the shell and exec forms of RUN are checked as commands and ENV or ARG may
 * not set OTEL_. Known limits: the scan goes by name (a cosign path held in a
 * variable not named cosign, aliases, renamed binaries, env -S), and code
 * that builds the command or the argument list elsewhere is not followed.
 *
 * Deliberately plain line scanning with a small linear tokenizer, not a YAML
 * or shell parser. Exits 1 on any problem, 0 otherwise.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

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

function filesToScan(root) {
  const files = new Set();
  const queue = [join(root, ".gitlab-ci.yml")].filter((f) => existsSync(f));
  while (queue.length) {
    const file = queue.shift();
    if (files.has(file)) continue;
    files.add(file);
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*(?:-\s+)?local:\s*["']?([^"'\s#]+)/.exec(line);
      if (!m) continue;
      const inc = join(root, m[1].replace(/^\/+/, ""));
      if (existsSync(inc) && statSync(inc).isFile()) queue.push(inc);
    }
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
 * $(...) opens a frame of its own, and leaves `$_` in the enclosing token.
 * A token is { raw, value, quoted, offset }; offsets are base-relative.
 */
function simpleCommands(text, base) {
  const done = [];
  const frame = () => ({ seg: [], tok: null, q: null });
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
  const openSub = (f, i) => {
    begin(f, i);
    stack.push(frame());
  };
  let i = 0;
  scan: for (; i < text.length; i++) {
    const f = top();
    const c = text[i];
    const n = text[i + 1];
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
        openSub(f, i);
        i++;
      }
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
      openSub(f, i);
      i++;
    }
    else if (c === ")" && stack.length > 1) {
      endSeg(f);
      stack.pop();
      add(top(), i, "$_");
    } else if (c === ";" || c === "(" || c === ")") endSeg(f);
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
  let wrapped = false; // after a wrapper word, its flags keep the position
  let envName = false; // after env -u, the next token is a name
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
      wrapped = false;
      continue;
    }
    if (envName) envName = false;
    else if (v === "-u" && wrapped) envName = true;
    else if (v !== null && (KEYWORDS.has(v) || WRAPPERS.has(v))) wrapped = WRAPPERS.has(v);
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

/** Scripts that bash -c, sh -c or eval run, as [{ text, base }]. */
function innerScripts(seg) {
  const out = [];
  for (let i = 0; i < seg.length; i++) {
    const t = seg[i];
    if (t.quoted) continue;
    const word = t.value.slice(t.value.lastIndexOf("/") + 1);
    if (word === "eval" && i + 1 < seg.length) {
      out.push({ text: seg.slice(i + 1).map((x) => x.value).join(" "), base: seg[i + 1].offset });
    } else if (word === "bash" || word === "sh") {
      const k = seg.findIndex((x, j) => j > i && /^-[a-z]*c[a-z]*$/.test(x.value));
      if (k !== -1 && seg[k + 1]) out.push({ text: seg[k + 1].value, base: seg[k + 1].offset + (seg[k + 1].quoted ? 1 : 0) });
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
  for (const m of code.matchAll(/(?<![\w$])(?:execFile|execFileSync|spawn|spawnSync)\s*\(\s*\u0001(\d+)\u0001\s*([,)])/g)) {
    if (strs[Number(m[1])] !== "cosign" || m[2] === ")") continue;
    const rest = code.slice(m.index + m[0].length).trimStart();
    const at = code.length - rest.length;
    if (!rest.startsWith("[")) {
      report(m.index, noFlagReason("with arguments not given as a literal array (may sign)"));
      continue;
    }
    const args = bracketed(code, at).items.filter((x) => x !== "");
    const values = args.map(literal);
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
  for (const m of code.matchAll(/(?<![\w$])(?:exec|execSync)\s*\(/g)) {
    const first = bracketed(code, m.index + m[0].length - 1).items[0] ?? "";
    const command = first
      .split("+")
      .map((piece) => literal(piece.trim()) ?? "$_")
      .join("");
    checkText(command, 0, {
      otel: (a) => report(m.index, otelReason(a.name)),
      call: (c) => {
        if (!c.ok) report(m.index, noFlagReason(c.sub));
      },
    });
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

function check(file) {
  const name = file.slice(file.lastIndexOf("/") + 1);
  if (isDockerfile(name)) return checkDockerfile(file);
  if (isCode(name)) return checkCode(file);
  return checkShell(file);
}

const root = parseArgs(process.argv.slice(2));
let count = 0;
for (const file of filesToScan(root)) {
  const rel = relative(root, file).split(sep).join("/");
  for (const p of check(file)) {
    console.log(`${rel}:${p.line}: ${p.reason}`);
    count++;
  }
}
process.exit(count ? 1 : 0);
