import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

/*
 * Every `run:` script in a workflow must survive shell quoting (#1878). A
 * stray apostrophe in a comment inside a single-quoted `node -e '...'`
 * program ends the string early, yet `bash -n` still accepts the result, so
 * the syntax check alone cannot catch it.
 *
 * Method: the intended program is the text between `node -e '` and the first
 * later line that starts with a closing `'` (the house layout). Then the shell
 * itself decides: that fragment runs in bash with `node` replaced by a function
 * that writes its -e argument to a file. The argument must equal the intended
 * program byte for byte (an early close either errors or yields a different
 * string), and the program must pass `node --check`. The YAML is read with a
 * small indentation scanner because no YAML library is installed at the top
 * level.
 */
const WORKFLOW_DIR = new URL("../.github/workflows/", import.meta.url);
const OPEN = "node -e '";

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
  const found = [];
  let from = 0;
  for (;;) {
    const start = script.indexOf(OPEN, from);
    if (start === -1) return found;
    const bodyStart = start + OPEN.length;
    const close = /\n[ \t]*'/u.exec(script.slice(bodyStart));
    if (!close) {
      found.push({ fragment: script.slice(start), program: null });
      return found;
    }
    const program = script.slice(bodyStart, bodyStart + close.index + 1);
    const end = bodyStart + close.index + close[0].length;
    found.push({ fragment: `${script.slice(start, end)}`, program });
    from = end;
  }
}

const files = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/u.test(f)).sort();

describe("workflow run scripts survive shell quoting", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-quoting-"));
  let n = 0;
  const sh = (args, input) => spawnSync("bash", args, { encoding: "utf8", input });

  for (const file of files) {
    const text = readFileSync(new URL(file, WORKFLOW_DIR), "utf8");
    for (const { step, script } of runBlocks(text)) {
      it(`${file} / ${step}: run script parses with bash -n`, () => {
        const r = sh(["-n"], script);
        expect(r.status, `${file} step "${step}": ${r.stderr}`).toBe(0);
      });

      nodePrograms(script).forEach(({ fragment, program }, idx) => {
        it(`${file} / ${step}: node -e program #${idx + 1} is exactly the JavaScript between the quotes and passes node --check`, () => {
          expect(program, `${file} step "${step}": no closing quote line`).not.toBeNull();
          n += 1;
          const out = join(dir, `arg-${n}.txt`);
          const js = join(dir, `prog-${n}.cjs`);
          const stub = `node() { [ "$1" = -e ] && printf %s "$2" > "${out}"; }\n${fragment}\n`;
          const r = sh([], stub);
          let seen = null;
          try {
            seen = readFileSync(out, "utf8");
          } catch {
            // the stub never ran: the quoting is broken
          }
          expect(
            seen,
            `${file} step "${step}": shell passed a different program than the text between the quotes (an apostrophe inside ends the string early?) ${r.stderr}`,
          ).toBe(program);
          writeFileSync(js, program);
          const c = spawnSync(process.execPath, ["--check", js], { encoding: "utf8" });
          expect(c.status, `${file} step "${step}": ${c.stderr}`).toBe(0);
        });
      });
    }
  }

  it("cleans up", () => {
    rmSync(dir, { recursive: true, force: true });
  });
});
