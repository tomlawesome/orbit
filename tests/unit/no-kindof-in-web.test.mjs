import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * ADR-0043 (#1466 note 53014, #1468 Part B): an item has no type, in the
 * browser either. #1346 removed the browser's copies of the kind inference
 * (`kindOf`, `kindOfItem`); this guard now also keeps out the five-kind
 * vocabulary and every read or send of an item's kind:
 *
 *   · `kindOf` / `kindOfItem` (the old inference);
 *   · `itemKinds`, `KINDS`, `kindHasDate`, `kindRecurs`, `typeChoices`
 *     (the vocabulary, the chips and the kind-driven field hiding);
 *   · `item.kind`, `entry.kind`, `draft.kind`, `command.kind`,
 *     `proposal.kind` (a kind read off, or put onto, an item or its command).
 *
 * Only whole identifiers count; `result.kind`, `job.kind`, `source.kind` and
 * an activity's `kind` are other things and are not looked for.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const SRC = join(ROOT, "web/src");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(js|ts|svelte)$/u.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every line of web/src matching `pattern`, as `file:line: text`. */
function find(pattern) {
  const found = [];
  for (const file of walk(SRC)) {
    readFileSync(file, "utf8").split("\n").forEach((line, at) => {
      if (pattern.test(line)) found.push(`${relative(ROOT, file)}:${at + 1}: ${line.trim()}`);
    });
  }
  return found;
}

describe("ADR-0043: the browser has no item type", () => {
  it("web/src has no kindOf or kindOfItem (#1346)", () => {
    expect(find(/\bkindOf(Item)?\b/u)).toEqual([]);
  });

  it("web/src has no itemKinds, KINDS, kindHasDate, kindRecurs or typeChoices", () => {
    expect(find(/\b(itemKinds|KINDS|kindHasDate|kindRecurs|typeChoices)\b/u)).toEqual([]);
  });

  it("web/src reads or sends no kind on an item, entry, draft, command or proposal", () => {
    expect(find(/\b(item|entry|draft|command|proposal)\.kind\b/u)).toEqual([]);
  });

  it("no item.upsert in web/src carries a kind: next to its item", () => {
    const found = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/type:\s*["']item\.upsert["'][^}]{0,200}?\bkind\s*:/gsu)) {
        const at = text.slice(0, match.index).split("\n").length;
        found.push(`${relative(ROOT, file)}:${at}`);
      }
    }
    expect(found).toEqual([]);
  });
});
