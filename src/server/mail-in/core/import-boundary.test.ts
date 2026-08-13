import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Enforces the mail-in/core boundary documented in
 * src/server/mail-in/README.md: core/ is the pure parsing layer and must
 * never reach into the database or the IMAP network client. If a future
 * change needs `getDb`/`db`/schema access or `imapflow` from here, that
 * logic belongs in the shell (src/server/mail-in/*.ts) or persistence layer
 * instead, not in core/.
 *
 * Modeled on the existing source-scanning contract test in
 * src/lib/observability-contract.test.ts.
 */
const coreDirectory = new URL(".", import.meta.url);

const coreSourceFiles = readdirSync(coreDirectory)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));

// Matched only against import/export-from *specifiers* (not comments or
// prose), so a doc comment that merely mentions "getDb" or "imapflow" while
// describing the boundary — as this module's own header comments do — does
// not trip the check.
const forbiddenImportSpecifiers: Array<{ label: string; pattern: RegExp }> = [
  { label: "@/db (getDb/schema)", pattern: /from\s+["']@\/db(?:\/[^"']*)?["']/u },
  { label: "imapflow", pattern: /from\s+["']imapflow["']/u },
];

describe("mail-in/core import boundary", () => {
  it("has at least the expected pure-parsing modules (sanity check for the scan itself)", () => {
    expect(coreSourceFiles).toEqual(expect.arrayContaining([
      "config.ts",
      "review-state.ts",
      "imap-attachment-validation.ts",
      "imap-recipient.ts",
      "imap-rotation.ts",
    ]));
  });

  it.each(coreSourceFiles)("%s does not import getDb/db/schema or imapflow", (fileName) => {
    const source = readFileSync(new URL(fileName, coreDirectory), "utf8");
    const importLines = source.split("\n").filter((line) => /^\s*(?:import|export)\b.*\bfrom\b/u.test(line));
    for (const { label, pattern } of forbiddenImportSpecifiers) {
      expect(importLines, `${fileName} must not import ${label}`).not.toEqual(
        expect.arrayContaining([expect.stringMatching(pattern)]),
      );
    }
  });
});
