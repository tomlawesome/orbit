import { describe, expect, it } from "vitest";

import { parseMachineOutput, summarize } from "./check-v19-types.mjs";

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
