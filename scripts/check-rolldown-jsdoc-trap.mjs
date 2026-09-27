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
  // Whether a JSDoc comment has already closed while sitting at the top
  // level -- outside every bracket, as a plain doc comment above a
  // declaration rather than annotating one parameter inside a list. The
  // `$props.id()` shape (#1130) turns on this: Svelte hoists the compiled
  // `$props.id()` declaration above an earlier comment. (The `{#snippet}`
  // hoist shape is narrower and has its own pass, rootSnippetTraps below.)
  let sawTopLevelJsdoc = false;
  const PROPS_ID_CALL_RE = /^\$props\.id\s*\(\s*\)/;

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
        if (wasJsdoc) {
          attachJsdoc(jsdocStartLine);
          if (stack.length === 0) sawTopLevelJsdoc = true;
        }
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
      const isSnippetParams = ch === "(" && snippetParamStarts.has(i);
      stack.push({
        bracket: ch,
        line,
        hasComma: false,
        hasJsdoc: false,
        jsdocLine: 0,
        isSnippetParams,
      });
      i++;
      continue;
    }
    if (ch === "$" && sawTopLevelJsdoc && PROPS_ID_CALL_RE.test(source.slice(i))) {
      findings.push({
        line,
        reason: "$props.id() called after an earlier top-level JSDoc comment (rolldown hoists $props.id() and fails to parse it, #1130)",
      });
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

  findings.push(...rootSnippetTraps(source));
  findings.sort((a, b) => a.line - b.line);
  return findings;
}

/**
 * The comment test Svelte's printer (esrap, `flush_comments_until`) uses to
 * guess that a block comment is a JSDoc `@type` cast: a line of the
 * comment's body that starts with `* @type {`. When such a comment is still
 * waiting to be printed as esrap reaches an identifier the compiler has
 * moved above it, esrap writes it in front of that identifier as a cast,
 * `const /** @type {X} *\/ (face) = ...` -- a parenthesised binding name,
 * which is not valid JavaScript. rolldown's parser rejects it; vite dev and
 * svelte-check never parse the compiled client output that way, so only the
 * production build sees it.
 */
const TYPE_CAST_COMMENT_RE = /(?:^|\n)\s*\*\s*@type\s*\{/;
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);

/**
 * Skips one JavaScript span starting at `i` -- a `{...}` expression when
 * `until` is null (returns the index just past its closing `}`), or the
 * body of a `<script>` up to the index `until`. Reports each block
 * comment's body to `onComment`. Strings and template literals are
 * skipped whole; that is enough to keep brace counting and comment
 * detection honest for this codebase.
 * @param {string} source
 * @param {number} i
 * @param {number | null} until
 * @param {(body: string) => void} onComment
 */
function skipJs(source, i, until, onComment) {
  const end = until ?? source.length;
  let depth = 0;
  while (i < end) {
    const ch = source[i];
    if (source.startsWith("/*", i)) {
      const close = source.indexOf("*/", i + 2);
      const stop = close === -1 ? end : close;
      onComment(source.slice(i + 2, stop));
      i = stop + 2;
      continue;
    }
    if (source.startsWith("//", i)) {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? end : nl + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      i++;
      while (i < end && source[i] !== ch) i += source[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (until === null) {
      if (ch === "{") depth++;
      if (ch === "}" && --depth === 0) return i + 1;
    }
    i++;
  }
  return end;
}

/**
 * The narrowed `{#snippet}` hoist shape (#1130). Svelte's client compiler
 * lifts a `{#snippet}` that sits at the component's ROOT -- not inside any
 * element, component or `{#...}` block -- to the top of the component
 * function, above every statement of the instance script. Any `@type`-style
 * block comment (TYPE_CAST_COMMENT_RE) that comes earlier in the source,
 * anywhere in the instance script or in a markup expression, is then
 * printed in front of the snippet's name as a bogus cast and the production
 * build fails to parse it. Flags exactly that pair. A snippet nested inside
 * an element, component or block is not lifted and is not flagged, nor is
 * a comment in `<script module>` (printed at module level, ahead of the
 * component). Over-flags one case on purpose: a root snippet that uses
 * nothing from the instance script is lifted out to module level instead
 * and builds; telling the two apart needs the compiler's scope analysis.
 * @param {string} source
 * @returns {{ line: number, reason: string }[]}
 */
export function rootSnippetTraps(source) {
  const findings = [];
  const n = source.length;
  let depth = 0;
  let sawTypeComment = false;
  const noteComment = (/** @type {string} */ body) => {
    if (TYPE_CAST_COMMENT_RE.test(body)) sawTypeComment = true;
  };
  const lineAt = (/** @type {number} */ index) => source.slice(0, index).split("\n").length;
  let i = 0;
  while (i < n) {
    if (source.startsWith("<!--", i)) {
      const close = source.indexOf("-->", i + 4);
      i = close === -1 ? n : close + 3;
      continue;
    }
    const raw = /^<(script|style)\b([^>]*)>/i.exec(source.slice(i, i + 200));
    if (raw) {
      const bodyStart = i + raw[0].length;
      const close = source.indexOf(`</${raw[1]}`, bodyStart);
      const bodyEnd = close === -1 ? n : close;
      const isModule = /\bmodule\b|context\s*=\s*["']module["']/.test(raw[2]);
      if (raw[1].toLowerCase() === "script" && !isModule) skipJs(source, bodyStart, bodyEnd, noteComment);
      const tagEnd = source.indexOf(">", bodyEnd);
      i = tagEnd === -1 ? n : tagEnd + 1;
      continue;
    }
    if (source.startsWith("</", i)) {
      depth = Math.max(0, depth - 1);
      const tagEnd = source.indexOf(">", i);
      i = tagEnd === -1 ? n : tagEnd + 1;
      continue;
    }
    const open = /^<([A-Za-z][\w:.-]*)/.exec(source.slice(i, i + 100));
    if (open) {
      let j = i + open[0].length;
      let selfClosing = false;
      while (j < n) {
        const ch = source[j];
        if (ch === "{") j = skipJs(source, j, null, noteComment);
        else if (ch === '"' || ch === "'") {
          const close = source.indexOf(ch, j + 1);
          j = close === -1 ? n : close + 1;
        } else if (source.startsWith("/>", j)) {
          selfClosing = true;
          j += 2;
          break;
        } else if (ch === ">") {
          j++;
          break;
        } else j++;
      }
      if (!selfClosing && !VOID_ELEMENTS.has(open[1].toLowerCase())) depth++;
      i = j;
      continue;
    }
    if (source[i] === "{") {
      if (source.startsWith("{#snippet", i) && depth === 0 && sawTypeComment) {
        findings.push({
          line: lineAt(i),
          reason:
            "{#snippet} at the component root after an earlier `@type` comment (Svelte lifts the snippet above the script and prints the comment as a cast on its name, which rolldown cannot parse, #1130)",
        });
      }
      if (source.startsWith("{#", i)) depth++;
      else if (source.startsWith("{/", i)) depth = Math.max(0, depth - 1);
      i = skipJs(source, i, null, noteComment);
      continue;
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
