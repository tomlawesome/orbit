#!/usr/bin/env node
/**
 * Guards the rolldown parse trap bisected for #782.
 *
 * `svelte-check` and `vite dev` both accept a JSDoc `/** ... *\/` block
 * comment sitting inside a `{#snippet ...}` parameter list, or inside a
 * multi-line, comma-separated parameter or call-argument list (an arrow
 * function's own parameters, or the arguments of a call on the right of a
 * `{@const ...}`) -- but the production build (`vite build`, which bundles
 * through rolldown) crashes there with an opaque "Unexpected token" thrown
 * by rolldown's builtin `vite-dynamic-import-vars` plugin, often with no
 * useful file/line pointer at all. See web/tests/rolldown-repro/ for the
 * minimal reproductions this was bisected to, and
 * web/src/routes/household/[id]/+page.svelte's own workarounds (moved
 * JSDoc, ternary-default destructuring) for what dodging it looks like.
 *
 * This is a plain-text scanner, not a real parser: it tracks bracket
 * nesting, comments and strings well enough to find the shape, and would
 * rather over-flag an unusual construct than let one slip through to the
 * build's own unreadable crash.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const webSrcRoot = path.join(repositoryRoot, "web", "src");

const SNIPPET_TAG_RE = /\{#snippet\s+[A-Za-z_$][\w$]*\s*\(/g;

/**
 * Scans one file's source for the trap shapes and returns findings in
 * source order. A pure function so it can be unit-tested against fixtures
 * without touching the filesystem.
 * @param {string} source
 * @returns {{ line: number, reason: string }[]}
 */
export function findTraps(source) {
  const findings = [];
  const snippetParamStarts = new Set();
  for (const match of source.matchAll(SNIPPET_TAG_RE)) {
    snippetParamStarts.add(match.index + match[0].length - 1);
  }

  /** @type {{ bracket: string, line: number, hasComma: boolean, hasJsdoc: boolean, jsdocLine: number, isSnippetParams: boolean }[]} */
  const stack = [];
  /** @type {"code" | "line-comment" | "block-comment" | "jsdoc-comment" | "html-comment" | "sq" | "dq" | "tpl"} */
  let mode = "code";
  let line = 1;
  const n = source.length;
  let i = 0;

  const startsWith = (str) => source.startsWith(str, i);
  let jsdocStartLine = 0;

  /**
   * A JSDoc comment just closed at index `i` (already past the `*\/`).
   * `/** @type {X} *\/ (expr)` -- a comment immediately followed by `(` --
   * is the ordinary type-cast idiom used throughout this codebase and is
   * not the trap: the trap is a comment sitting directly before a bare
   * parameter name. Skip past any whitespace to see which one this is, and
   * if it is a real parameter annotation, attach it to the nearest
   * enclosing `(` list, passing transparently through any destructuring
   * `{`/`[` shells directly around the parameter itself.
   * @param {number} startLine
   */
  function attachJsdoc(startLine) {
    let j = i;
    while (j < n && /\s/u.test(source[j])) j++;
    if (source[j] === "(") return;
    for (let k = stack.length - 1; k >= 0; k--) {
      const frame = stack[k];
      if (frame.bracket === "(") {
        if (!frame.hasJsdoc) frame.jsdocLine = startLine;
        frame.hasJsdoc = true;
        return;
      }
      // "{" / "[": a destructuring shell wrapped directly around the
      // parameter -- keep looking outward for the list it belongs to.
    }
  }

  while (i < n) {
    const ch = source[i];

    if (mode === "jsdoc-comment" || mode === "block-comment") {
      if (startsWith("*/")) {
        const wasJsdoc = mode === "jsdoc-comment";
        mode = "code";
        i += 2;
        if (wasJsdoc) attachJsdoc(jsdocStartLine);
        continue;
      }
      if (ch === "\n") line++;
      i++;
      continue;
    }
    if (mode === "line-comment") {
      if (ch === "\n") {
        mode = "code";
        line++;
      }
      i++;
      continue;
    }
    if (mode === "html-comment") {
      if (startsWith("-->")) {
        mode = "code";
        i += 3;
        continue;
      }
      if (ch === "\n") line++;
      i++;
      continue;
    }
    if (mode === "sq" || mode === "dq" || mode === "tpl") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      const closer = mode === "sq" ? "'" : mode === "dq" ? '"' : "`";
      if (ch === closer) mode = "code";
      if (ch === "\n") line++;
      i++;
      continue;
    }

    // mode === "code"
    if (ch === "\n") {
      line++;
      i++;
      continue;
    }
    if (startsWith("<!--")) {
      mode = "html-comment";
      i += 4;
      continue;
    }
    if (startsWith("//")) {
      mode = "line-comment";
      i += 2;
      continue;
    }
    if (startsWith("/**")) {
      jsdocStartLine = line;
      mode = "jsdoc-comment";
      i += 3;
      continue;
    }
    if (startsWith("/*")) {
      mode = "block-comment";
      i += 2;
      continue;
    }
    if (ch === "'") {
      mode = "sq";
      i++;
      continue;
    }
    if (ch === '"') {
      mode = "dq";
      i++;
      continue;
    }
    if (ch === "`") {
      mode = "tpl";
      i++;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      stack.push({
        bracket: ch,
        line,
        hasComma: false,
        hasJsdoc: false,
        jsdocLine: 0,
        isSnippetParams: ch === "(" && snippetParamStarts.has(i),
      });
      i++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      const frame = stack.pop();
      if (frame && frame.bracket === "(" && frame.hasJsdoc) {
        const spansLines = line > frame.line;
        if (frame.isSnippetParams) {
          findings.push({ line: frame.jsdocLine, reason: "JSDoc comment inside a {#snippet} parameter list" });
        } else if (spansLines && frame.hasComma) {
          findings.push({
            line: frame.jsdocLine,
            reason: "JSDoc comment inside a multi-line, comma-separated parameter/argument list",
          });
        }
      }
      i++;
      continue;
    }
    if (ch === "," && stack.length && stack[stack.length - 1].bracket === "(") {
      stack[stack.length - 1].hasComma = true;
    }
    i++;
  }

  return findings;
}

/** @param {string} absolutePath */
function checkFile(absolutePath) {
  const source = readFileSync(absolutePath, "utf8");
  const relativePath = path.relative(repositoryRoot, absolutePath);
  return findTraps(source).map((finding) => ({ ...finding, file: relativePath }));
}

/** Recursively lists every `.svelte` file under web/src, skipping node_modules. */
function listSvelteFiles(dir = webSrcRoot) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listSvelteFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".svelte")) files.push(full);
  }
  return files;
}

function main() {
  const findings = listSvelteFiles().flatMap(checkFile);

  if (findings.length === 0) {
    console.log("rolldown JSDoc trap check: clean across web/src/**/*.svelte.");
    return;
  }

  console.error(`\nrolldown JSDoc trap check: ${findings.length} finding${findings.length === 1 ? "" : "s"}:\n`);
  for (const { file, line, reason } of findings) console.error(`  ${file}:${line}  ${reason}`);
  console.error(
    "\nThese shapes parse fine everywhere except rolldown's production build, which fails with an" +
      " opaque \"Unexpected token\" and no useful pointer (#782, web/tests/rolldown-repro/). Move the" +
      " JSDoc above the declaration, or out to a named helper, instead.",
  );
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
