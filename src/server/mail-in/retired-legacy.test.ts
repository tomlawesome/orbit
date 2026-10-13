import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as config from "./core/config";
import { failureReasonOf, reviewInboxState } from "./core/review-state";

/**
 * #1403 slice D4. Mail-in code kept only for older installs is gone:
 *
 *  - the four `src/server/imap-*.ts` stubs that re-exported the modules moved
 *    into `src/server/mail-in/` by #298, with every importer and `vi.mock`
 *    path pointing at the real module;
 *  - the `legacy_review_item` receipt code (and the `older_review` reason
 *    word it fed), left over from the review drafts that predate private
 *    review;
 *  - the environment-variable IMAP parser, kept only so tests could build an
 *    `ImapIngestionConfig`. The runtime config has come from the database
 *    since ADR-0017, so tests build the config object directly.
 *
 * Each case names the file or phrase that must stay absent. The generation-0
 * alias CHECK and the `review_item_id` column are slice E, and the
 * `drizzle/` history and `tests/integration/migrations.test.ts` are not
 * searched.
 */
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const TEXT_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".svelte", ".md"]);

function textFilesUnder(directory: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".svelte-kit" || entry.name.startsWith(".")) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (TEXT_EXTENSIONS.has(extname(entry.name))) found.push(full);
    }
  };
  walk(join(repoRoot, directory));
  return found;
}

const thisFile = "src/server/mail-in/retired-legacy.test.ts";
const sources = [...textFilesUnder("src"), ...textFilesUnder("web/src"), ...textFilesUnder("tests")]
  .map((full) => relative(repoRoot, full))
  .filter((path) => path !== thisFile && path !== "tests/integration/migrations.test.ts")
  .map((path) => ({ path, text: readFileSync(join(repoRoot, path), "utf8") }));

const filesMatching = (pattern: RegExp): string[] => sources.filter(({ text }) => pattern.test(text)).map(({ path }) => path);

const STUBS = ["attachment-holding", "inbox", "ingestion", "receipt-worker"] as const;

describe("the pre-#298 imap-* re-export stubs are gone (#1403 D4)", () => {
  it.each(STUBS)("src/server/imap-%s.ts does not exist", (name) => {
    expect(existsSync(join(repoRoot, `src/server/imap-${name}.ts`))).toBe(false);
  });

  it("keeps the real modules the stubs pointed at", () => {
    for (const name of STUBS) {
      expect(existsSync(join(repoRoot, `src/server/mail-in/imap-${name}.ts`)), name).toBe(true);
    }
  });

  it("no import, dynamic import or vi.mock names a stub by its old path", () => {
    const oldPath = /["'`](?:@|orbit)\/server\/imap-(?:attachment-holding|inbox|ingestion|receipt-worker)["'`]/;
    expect(filesMatching(oldPath)).toEqual([]);
  });
});

describe("the legacy_review_item receipt code is gone (#1403 D4)", () => {
  it("is named by no source, web file, unit test or README outside the migration history", () => {
    expect(filesMatching(/legacy_review_item/)).toEqual([]);
  });

  it("no longer feeds an older_review reason word", () => {
    expect(filesMatching(/older_review/)).toEqual([]);
  });

  it("reads a failed receipt with that code like any other unmapped code", () => {
    expect(failureReasonOf("legacy_review_item")).toBe("unknown");
    expect(reviewInboxState("failed", "legacy_review_item")).toMatchObject({
      classification: "unavailable",
      canApprove: false,
      canDiscard: false,
      reason: "unknown",
    });
  });
});

describe("the environment-variable IMAP config parser is gone (#1403 D4)", () => {
  it("core/config.ts no longer exports the parser", () => {
    expect(Object.keys(config)).not.toContain("parseImapIngestionConfigFromEnvironment");
  });

  it("core/config.ts has no environment schema, runtime-secret read or IMAP_* variable names", () => {
    const text = readFileSync(join(repoRoot, "src/server/mail-in/core/config.ts"), "utf8");
    expect(text).not.toContain("ingestionEnvironmentSchema");
    expect(text).not.toContain("readRuntimeSecret");
    expect(text).not.toMatch(/\bIMAP_[A-Z_]+\b/);
  });

  it("nothing builds a config through the parser, so tests construct ImapIngestionConfig directly", () => {
    expect(filesMatching(/parseImapIngestionConfigFromEnvironment/)).toEqual([]);
  });

  it("keeps the config helpers that the running code uses", () => {
    expect(typeof config.imapProviderConfigCommitment).toBe("function");
    expect(typeof config.imapAttachmentRetryDelayMs).toBe("function");
  });
});
