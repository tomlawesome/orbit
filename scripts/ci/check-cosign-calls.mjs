#!/usr/bin/env node
/**
 * Cosign call checker (#1841; owner, 2026-11-14: cosign sends no telemetry
 * and publishes nothing beyond what signing needs).
 *
 * Scans .gitlab-ci.yml, the files it includes with `local:`,
 * .github/workflows/*.yml and scripts/**\/*.sh under --root <dir> (default
 * the working directory), and prints `file:line: reason` for each problem:
 *
 * - an OTEL_ variable set or exported (a YAML variables:/env: key, or a shell
 *   assignment or export), so no OpenTelemetry export is ever switched on;
 * - a cosign sign, sign-blob, attest or attest-blob command without
 *   `--tlog-upload=false`, so nothing goes to the public Rekor log. The one
 *   allowed exception is the keyless public release proof (ADR-0020), marked
 *   by `# cosign-public-upload: <reason>` on the line directly above the call.
 *
 * The command word is `cosign` or a variable whose name contains "cosign"
 * ($cosign, "${cosign}", "$cosign_cmd", ${COSIGN_BIN}). It counts only at the
 * start of a command: the line start (after a YAML `- ` or `run: `), or after
 * &&, ||, ;, |, & or $(. Quoted text is not a command, so prose in an echo or
 * fail message is ignored. Comment lines are ignored; a trailing backslash
 * joins the next line into the same command.
 *
 * Deliberately plain line scanning with a small quote tracker, not a YAML or
 * shell parser. Exits 1 on any problem, 0 otherwise.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const FLAG = "--tlog-upload=false";
const MARKER = /^\s*#\s*cosign-public-upload:\s*\S/;
const SIGNING = /^(?:(?:if|then|do|else|elif|while|until|time|!)\s+|[({]\s*)*(?:(?:[^\s"'$;&|()]*\/)?cosign|"?\$\{?[A-Za-z0-9_]*cosign[A-Za-z0-9_]*\}?"?)\s+(sign|sign-blob|attest|attest-blob)(?=[\s;&|)]|$)/i;
const LINE_START = /^\s*(?:-\s+)?(?:run:\s*)?/;
const YAML_OTEL = /^\s*(?:-\s+)?["']?(OTEL_\w*)["']?\s*:/;
const SHELL_OTEL = /(?:^\s*(?:-\s+)?(?:run:\s*)?|&&\s*|\|\|\s*|;\s*|\|\s*|\$\(\s*|\bexport\s+(?:-\w+\s+)*|\bdeclare\s+-\w*\s+|\breadonly\s+|\benv\s+)(OTEL_\w*)=/;

function parseArgs(argv) {
  let root = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) root = argv[++i];
    else if (argv[i].startsWith("--root=")) root = argv[i].slice(7);
    else {
      console.error(`usage: check-cosign-calls.mjs [--root <dir>]`);
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
    const st = statSync(full);
    if (st.isDirectory()) shellFiles(full, out);
    else if (name.endsWith(".sh")) out.push(full);
  }
}

function filesToScan(root) {
  const files = new Set();
  const ci = join(root, ".gitlab-ci.yml");
  if (existsSync(ci)) {
    files.add(ci);
    for (const line of readFileSync(ci, "utf8").split("\n")) {
      const m = /^\s*(?:-\s+)?local:\s*["']?([^"'\s#]+)/.exec(line);
      if (m) {
        const inc = join(root, m[1].replace(/^\//, ""));
        if (existsSync(inc)) files.add(inc);
      }
    }
  }
  const wf = join(root, ".github", "workflows");
  if (existsSync(wf)) {
    for (const name of readdirSync(wf)) if (/\.ya?ml$/.test(name)) files.add(join(wf, name));
  }
  const sh = [];
  shellFiles(join(root, "scripts"), sh);
  for (const f of sh) files.add(f);
  return [...files].sort();
}

const isComment = (line) => /^\s*#/.test(line);

/** Join backslash continuations; each logical line keeps the offsets where its physical lines start. */
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

/** Find signing invocations in one logical line: [{ start, end, sub }]. */
function invocations(text) {
  const found = [];
  const open = []; // { start, sub, depth }
  const stack = ["top"]; // top | sub | sq | dq
  const close = (depth, at) => {
    for (let k = open.length - 1; k >= 0; k--) {
      if (open[k].depth >= depth) found.push({ ...open.splice(k, 1)[0], end: at });
    }
  };
  const startAt = (pos) => {
    const m = SIGNING.exec(text.slice(pos).replace(/^\s+/, ""));
    if (m) open.push({ start: pos + (text.slice(pos).length - text.slice(pos).trimStart().length), sub: m[1], depth: stack.length });
  };
  let i = LINE_START.exec(text)[0].length;
  startAt(i);
  for (; i < text.length; i++) {
    const c = text[i];
    const ctx = stack[stack.length - 1];
    if (ctx === "sq") {
      if (c === "'") stack.pop();
      continue;
    }
    if (ctx === "dq") {
      if (c === "\\") i++;
      else if (c === '"') stack.pop();
      else if (c === "$" && text[i + 1] === "(") {
        stack.push("sub");
        i++;
        startAt(i + 1);
      }
      continue;
    }
    if (c === "\\") {
      i++;
    } else if (c === "'") {
      stack.push("sq");
    } else if (c === '"') {
      stack.push("dq");
    } else if (c === "#" && (i === 0 || /\s/.test(text[i - 1]))) {
      break;
    } else if (c === "$" && text[i + 1] === "(") {
      stack.push("sub");
      i++;
      startAt(i + 1);
    } else if (c === ")" && ctx === "sub") {
      close(stack.length, i);
      stack.pop();
    } else if ((c === "&" && text[i + 1] === "&") || (c === "|" && text[i + 1] === "|")) {
      close(stack.length, i);
      i++;
      startAt(i + 1);
    } else if (c === ";" || c === "|" || (c === "&" && text[i - 1] !== ">" && text[i + 1] !== ">")) {
      close(stack.length, i);
      startAt(i + 1);
    }
  }
  close(0, text.length);
  return found.sort((a, b) => a.start - b.start);
}

function lineOf(logical, offset) {
  let n = logical.parts[0].line;
  for (const p of logical.parts) if (p.offset <= offset) n = p.line;
  return n;
}

function check(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const problems = [];
  lines.forEach((line, i) => {
    if (isComment(line)) return;
    const m = YAML_OTEL.exec(line) || SHELL_OTEL.exec(line);
    if (m) problems.push({ line: i + 1, reason: `${m[1]} is set; cosign and CI send no telemetry (#1841)` });
  });
  for (const logical of logicalLines(lines)) {
    if (isComment(logical.text) || !/cosign/i.test(logical.text)) continue;
    for (const inv of invocations(logical.text)) {
      if (logical.text.slice(inv.start, inv.end).includes(FLAG)) continue;
      const n = lineOf(logical, inv.start);
      if (n >= 2 && MARKER.test(lines[n - 2])) continue;
      problems.push({
        line: n,
        reason: `cosign ${inv.sub} without ${FLAG} uploads to the public Rekor log (#1841); add the flag, or mark an intended public upload with "# cosign-public-upload: <reason>" on the line above`,
      });
    }
  }
  return problems.sort((a, b) => a.line - b.line);
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
