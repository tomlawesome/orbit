import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

/*
 * Every `run:` script in a workflow must survive shell quoting (#1878). A
 * stray apostrophe in a comment inside a single-quoted `node -e '...'`
 * program ends the string early, yet `bash -n` still accepts the result, so
 * the syntax check alone cannot catch it.
 *
 * Method, which never executes workflow text beyond `bash -n`: inside a
 * single-quoted shell string no `'` can appear (the repo does not use the
 * `'"'"'` idiom), so the program is the text after `node -e '` up to the
 * closing line, a line holding just `'` plus any trailing shell arguments.
 * That text must contain no `'` at all, and must pass `node --check`. Any
 * other node -e spelling (--eval, -p, double quotes, extra spaces) is
 * refused, so a new form cannot slip past unchecked. The YAML is read with a
 * small indentation scanner because no YAML library is installed at the top
 * level.
 */
const WORKFLOW_DIR = new URL("../.github/workflows/", import.meta.url);
const ACTIONS_DIR = new URL("../.github/actions/", import.meta.url);
const OPEN = "node -e '";
const ANY_NODE_EVAL = /\bnode\s+(?:-e|-p|--eval|--print)\b[^\n]{0,3}/gu;
const CLOSE = /\n[ \t]*'(?=[\s)"|;&<>]|$)/u;

function runBlocks(text) {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const blocks = [];
  let step = "(unnamed)";
  for (let i = 0; i < lines.length; i += 1) {
    const name = /^\s*-\s+name:\s*(.+?)\s*$/u.exec(lines[i]);
    if (name) step = name[1].replace(/^["']|["']$/gu, "");
    const run = /^(\s*)(?:-\s+)?run:\s*(.*)$/u.exec(lines[i]);
    if (!run) continue;
    if (!/^[|>][+-]?$/u.test(run[2])) {
      blocks.push({ step, script: run[2] });
      continue;
    }
    const body = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trim() !== "" && lines[j].search(/\S/u) <= run[1].length) break;
      body.push(lines[j]);
    }
    const indent = Math.min(...body.filter((l) => l.trim() !== "").map((l) => l.search(/\S/u)));
    blocks.push({ step, script: `${body.map((l) => l.slice(indent)).join("\n")}\n` });
  }
  return blocks;
}

function nodePrograms(script) {
  const programs = [];
  const unsupported = [];
  for (const m of script.matchAll(ANY_NODE_EVAL)) {
    if (!m[0].startsWith(OPEN)) unsupported.push(m[0].trim());
  }
  let from = 0;
  for (;;) {
    const start = script.indexOf(OPEN, from);
    if (start === -1) return { programs, unsupported };
    const bodyStart = start + OPEN.length;
    const close = CLOSE.exec(script.slice(bodyStart));
    if (!close) {
      programs.push(null);
      return { programs, unsupported };
    }
    programs.push(script.slice(bodyStart, bodyStart + close.index + 1));
    from = bodyStart + close.index + close[0].length;
  }
}

function sources() {
  const out = [];
  for (const file of readdirSync(WORKFLOW_DIR)) {
    if (/\.ya?ml$/u.test(file)) out.push([file, new URL(file, WORKFLOW_DIR)]);
  }
  if (existsSync(ACTIONS_DIR)) {
    for (const d of readdirSync(ACTIONS_DIR)) {
      for (const f of ["action.yml", "action.yaml"]) {
        const u = new URL(`${d}/${f}`, ACTIONS_DIR);
        if (existsSync(u)) out.push([`actions/${d}/${f}`, u]);
      }
    }
  }
  return out.sort(([a], [b]) => a.localeCompare(b));
}

const found = [];
const cases = sources().map(([file, url]) => ({
  file,
  blocks: runBlocks(readFileSync(url, "utf8")).map((b) => ({ ...b, ...nodePrograms(b.script) })),
}));
for (const { file, blocks } of cases) {
  for (const b of blocks) for (const _ of b.programs) found.push(file);
}

describe("workflow run scripts survive shell quoting", () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "wf-quoting-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds the known node -e programs, so none is skipped silently", () => {
    for (const f of ["countersign.yml", "publish-from-gitlab.yml", "release-on-tag.yml"]) {
      expect(found, `no node -e program found in ${f}`).toContain(f);
    }
  });

  let n = 0;
  for (const { file, blocks } of cases) {
    for (const { step, script, programs, unsupported } of blocks) {
      it(`${file} / ${step}: run script parses with bash -n`, () => {
        const r = spawnSync("bash", ["-n"], { encoding: "utf8", input: script });
        expect(r.status, `${file} step "${step}": ${r.stderr}`).toBe(0);
      });

      it(`${file} / ${step}: uses only the checkable node -e ' form`, () => {
        expect(unsupported, `${file} step "${step}": unsupported node eval form`).toEqual([]);
      });

      programs.forEach((program, idx) => {
        it(`${file} / ${step}: node -e program #${idx + 1} has no apostrophe and passes node --check`, () => {
          expect(program, `${file} step "${step}": no closing quote line`).not.toBeNull();
          expect(
            program.includes("'"),
            `${file} step "${step}": an apostrophe inside the program ends the shell string early`,
          ).toBe(false);
          n += 1;
          const js = join(dir, `prog-${n}.cjs`);
          writeFileSync(js, program);
          const c = spawnSync(process.execPath, ["--check", js], { encoding: "utf8" });
          expect(c.status, `${file} step "${step}": ${c.stderr}`).toBe(0);
        });
      });
    }
  }
});
