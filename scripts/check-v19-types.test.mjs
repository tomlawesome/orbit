import { describe, expect, it } from "vitest";

import {
  compareToLedger,
  describeResult,
  parseMachineOutput,
} from "./check-v19-types.mjs";

const MACHINE_OUTPUT = [
  '1787607088256 START "/home/codex/projects/orbit/web"',
  '1787607088259 ERROR "src/lib/format.js" 9:21 "Parameter \'iso\' implicitly has an \'any\' type."',
  '1787607088260 ERROR "src/lib/format.js" 12:3 "Property \'style\' does not exist on type \'Element\'."',
  '1787607088261 WARNING "src/lib/format.js" 14:1 "Unused export let property."',
  '1787607088262 ERROR "src/routes/home/+page.svelte" 4:2 "Parameter \'row\' implicitly has an \'any\' type."',
  "1787607088276 COMPLETED 494 FILES 3 ERRORS 1 WARNINGS 2 FILES_WITH_PROBLEMS",
].join("\n");

describe("v19 type ledger", () => {
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

  it("passes only when every count matches its entry exactly", () => {
    const counts = new Map([["a.js", 3]]);
    expect(compareToLedger(counts, { "a.js": 3 })).toEqual({
      worse: [], unledgered: [], improved: [], stale: [],
    });
    expect(describeResult(compareToLedger(counts, { "a.js": 3 }))).toEqual([]);
  });

  it("fails a file that got worse", () => {
    const result = compareToLedger(new Map([["a.js", 4]]), { "a.js": 3 });
    expect(result.worse).toEqual([{ file: "a.js", count: 4, allowed: 3 }]);
    expect(describeResult(result)[0]).toContain("ledger allows 3");
  });

  /*
   * The rule that walks the ledger to zero (#624). Slack left in an entry is
   * slack nobody ever reclaims, so an improvement has to be banked before the
   * gate goes green again.
   */
  it("fails a file that got better, asking for its number to be lowered", () => {
    const result = compareToLedger(new Map([["a.js", 1]]), { "a.js": 3 });
    expect(result.improved).toEqual([{ file: "a.js", count: 1, allowed: 3 }]);
    expect(describeResult(result)[0]).toContain("Lower it to 1");
  });

  /* Every screen M2 rebuilds arrives this way, and has to arrive clean. */
  it("refuses errors in a file with no entry", () => {
    const result = compareToLedger(new Map([["new.svelte", 2]]), {});
    expect(result.unledgered).toEqual([{ file: "new.svelte", count: 2 }]);
    expect(describeResult(result)[0]).toContain("do not add an entry");
  });

  it("reports an entry whose file is clean or gone as stale", () => {
    const result = compareToLedger(new Map(), { "deleted.js": 5 });
    expect(result.stale).toEqual(["deleted.js"]);
    expect(describeResult(result)[0]).toContain("Delete its ledger entry");
  });

  it("says error in the singular", () => {
    expect(describeResult(compareToLedger(new Map([["a.js", 1]]), {}))[0]).toContain("1 error and");
  });
});
