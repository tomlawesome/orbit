import { describe, expect, it } from "vitest";

import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { foreignWorkspaceRoot, parseMachineOutput, summarize } from "./check-v19-types.mjs";

const MACHINE_OUTPUT = [
  '1787607088256 START "/home/codex/projects/orbit/web"',
  '1787607088259 ERROR "src/lib/format.js" 9:21 "Parameter \'iso\' implicitly has an \'any\' type."',
  '1787607088260 ERROR "src/lib/format.js" 12:3 "Property \'style\' does not exist on type \'Element\'."',
  '1787607088261 WARNING "src/lib/format.js" 14:1 "Unused export let property."',
  '1787607088262 ERROR "src/routes/home/+page.svelte" 4:2 "Parameter \'row\' implicitly has an \'any\' type."',
  "1787607088276 COMPLETED 494 FILES 3 ERRORS 1 WARNINGS 2 FILES_WITH_PROBLEMS",
].join("\n");

describe("v19 type check", () => {
  it("counts errors per file and ignores warnings and progress lines", () => {
    expect(parseMachineOutput(MACHINE_OUTPUT)).toEqual(
      new Map([
        ["src/lib/format.js", 2],
        ["src/routes/home/+page.svelte", 1],
      ]),
    );
  });

  it("survives empty and malformed output rather than reporting a clean tree", () => {
    expect(parseMachineOutput("")).toEqual(new Map());
    expect(parseMachineOutput(undefined)).toEqual(new Map());
    expect(parseMachineOutput("ERROR without a timestamp")).toEqual(new Map());
  });

  /* #624: no per-file tolerance is left, so any error at all is a failure --
     there is no ledger left to consult. */
  it("passes only when there are no errors anywhere", () => {
    expect(summarize(new Map())).toEqual({ total: 0, lines: [] });
  });

  it("fails on a single error, naming the file and the count", () => {
    expect(summarize(new Map([["a.js", 1]]))).toEqual({ total: 1, lines: ["a.js: 1 error"] });
  });

  it("sums errors across every file", () => {
    expect(summarize(new Map([["a.js", 2], ["b.svelte", 3]]))).toEqual({
      total: 5,
      lines: ["a.js: 2 errors", "b.svelte: 3 errors"],
    });
  });
});

/*
 * #1029: in a worktree, `web/node_modules` is usually a link to the main
 * checkout, so `orbit/server/*` resolves to whatever branch THAT directory has
 * out. The check then reads this tree's .svelte and .js files against another
 * branch's server source and answers for neither — a false error at best, and
 * at worst a false pass on an import that is genuinely broken.
 */
describe("foreignWorkspaceRoot (#1029)", () => {
  /** A checkout whose workspace link points wherever `target` says. */
  function checkout(target) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "orbit-v19-types-")));
    mkdirSync(join(root, "web", "node_modules"), { recursive: true });
    if (target) symlinkSync(target, join(root, "web", "node_modules", "orbit"));
    return `${root}/`;
  }

  it("is silent when the link points at this checkout, which is the main one", () => {
    const root = checkout(null);
    symlinkSync(realpathSync(root), join(root, "web", "node_modules", "orbit"));
    try {
      expect(foreignWorkspaceRoot(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names the other checkout when the link leaves this tree, as it does in a worktree", () => {
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "orbit-main-checkout-")));
    const root = checkout(elsewhere);
    try {
      // The value is the path, so the message can say where the answer would
      // have come from rather than only that something is wrong.
      expect(foreignWorkspaceRoot(root)).toBe(elsewhere);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("is silent when there is no link at all: a missing dependency is svelte-check's to report", () => {
    const root = checkout(null);
    try {
      expect(foreignWorkspaceRoot(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
