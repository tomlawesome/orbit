import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { formatRecord, operationalReasons, resetLoggerForTests } from "../src/lib/logger.ts";

/*
 * #447: scripts/repair.sh's docker-logs scan (around the `reason=...`
 * literals near line 2748) matches sentinel substrings that are not bound to
 * anything - `src/lib/logger.ts`'s `operationalReasons` is the single list a
 * reason has to belong to, and its `renderText` is the only place that turns
 * a reason into the `reason=<token>` text repair.sh greps for. This pins
 * every `reason=<token>` literal in repair.sh to that list, checks the
 * logger actually emits the exact bytes repair.sh matches, and checks each
 * sentinel repair.sh looks for is still emitted somewhere in src/ - so a
 * renamed or removed reason fails here instead of silently breaking repair
 * diagnosis in production.
 */

const repairShPath = new URL("../scripts/repair.sh", import.meta.url);
const repairSh = readFileSync(repairShPath, "utf8");

const requiredSentinels = ["database_mismatch", "database_below_floor", "migration_failed"];

/*
 * repair.sh also uses `reason=` for an unrelated mini-vocabulary (the
 * dangerous-command approval flow's own reason codes, e.g.
 * `reason=refused-by-operator`, `reason=checkpoint-failed`) that has nothing
 * to do with logger.ts's operationalReasons. Only the docker-logs sentinel
 * scan (`"$app_log" == *"reason=<token>"*`) is this contract's concern, so
 * the pattern is scoped to that construct rather than every `reason=` in the
 * file.
 */
function extractReasonLiterals(text) {
  const tokens = new Set();
  for (const match of text.matchAll(/\$app_log"\s*==\s*\*"reason=([a-z_]+)"\*/gu)) tokens.add(match[1]);
  return [...tokens];
}

describe("repair.sh reason= literals stay bound to logger.ts's operationalReasons (#447)", () => {
  const reasonLiterals = extractReasonLiterals(repairSh);

  it("finds at least the three known operational sentinels in repair.sh", () => {
    for (const sentinel of requiredSentinels) {
      expect(reasonLiterals).toContain(sentinel);
    }
  });

  it.each(reasonLiterals)("repair.sh's reason=%s is a member of logger.ts's operationalReasons", (token) => {
    expect(operationalReasons).toContain(token);
  });

  it.each(requiredSentinels)(
    "logger.ts's formatRecord emits the exact `reason=%s` substring repair.sh greps for",
    (reason) => {
      resetLoggerForTests();
      const previousFormat = process.env.ORBIT_LOG_FORMAT;
      delete process.env.ORBIT_LOG_FORMAT;
      try {
        const line = formatRecord("error", {
          event: "startup.migration",
          state: "exhausted",
          reason,
          action: "check_migrations",
        });
        expect(line).toContain(`reason=${reason}`);
      } finally {
        if (previousFormat === undefined) delete process.env.ORBIT_LOG_FORMAT;
        else process.env.ORBIT_LOG_FORMAT = previousFormat;
        resetLoggerForTests();
      }
    },
  );

  it.each(requiredSentinels)("the %s sentinel is still emitted somewhere in src/ (not dead)", (reason) => {
    const bootTs = readFileSync(new URL("../src/server/boot.ts", import.meta.url), "utf8");
    const migrateTs = readFileSync(new URL("../src/db/migrate.ts", import.meta.url), "utf8");
    const literal = `"${reason}"`;
    expect(bootTs.includes(literal) || migrateTs.includes(literal)).toBe(true);
  });
});
