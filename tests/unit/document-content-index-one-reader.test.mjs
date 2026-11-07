import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * #1437, detection note decision 2: `documents.content_index` (the blind
 * index of a file's SHA-256) has one reader, `findHeldDuplicate` in
 * src/server/document-repository.ts, and that query always binds
 * `household_id`, so the same bytes in another household can never match.
 * The only other code that names the column writes it: the upload's insert
 * and the backfill, which may test it for NULL (its work list) and set it.
 * Source tripwire; failures list file:line.
 */

const root = path.resolve(import.meta.dirname, "../..");
const repositoryFile = "src/server/document-repository.ts";
const backfillFile = "src/server/document-maintenance/content-index-backfill.ts";
const schemaFile = "src/db/schema.ts";

const isTest = (file) => /\.(test|spec)\.[cm]?[jt]sx?$/u.test(file);

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|js|mjs|svelte)$/u.test(name) && !isTest(name)) out.push(full);
  }
  return out;
}

/** Blank out comments, keeping line numbers. */
function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, (block) => block.replace(/[^\n]/gu, " "))
    .replace(/(^|[^:])\/\/.*$/gmu, "$1");
}

/** Every mention of the column, as { file, line, text }. */
function mentions() {
  const found = [];
  for (const dir of ["src", "web/src"]) {
    for (const full of sourceFiles(path.join(root, dir))) {
      const file = path.relative(root, full).split(path.sep).join("/");
      withoutComments(readFileSync(full, "utf8")).split("\n").forEach((text, index) => {
        if (/documents\.contentIndex|content_index/u.test(text)) found.push({ file, line: index + 1, text: text.trim() });
      });
    }
  }
  return found;
}

/** The body of `findHeldDuplicates`, from its signature to the next top-level export. */
function heldDuplicateBody() {
  const source = withoutComments(readFileSync(path.join(root, repositoryFile), "utf8"));
  const start = source.indexOf("export async function findHeldDuplicates(");
  expect(start, "findHeldDuplicates exists").toBeGreaterThan(-1);
  const end = source.indexOf("\nexport ", start + 1);
  return { source, start, end: end === -1 ? source.length : end };
}

describe("#1437: documents.content_index has one reader, and it binds the household", () => {
  it("nothing but findHeldDuplicates, the backfill and the schema names the column", () => {
    const { source, start, end } = heldDuplicateBody();
    const firstLine = source.slice(0, start).split("\n").length;
    const lastLine = source.slice(0, end).split("\n").length;
    const strays = mentions().filter(({ file, line, text }) => {
      if (file === schemaFile) return !/text\("content_index"\)|content_index_idx/u.test(text);
      if (file === repositoryFile) return line < firstLine || line > lastLine;
      if (file === backfillFile) return !/isNull\(documents\.contentIndex\)/u.test(text);
      return true;
    });
    expect(strays.map(({ file, line, text }) => `${file}:${line}: ${text}`)).toEqual([]);
  });

  it("findHeldDuplicates filters on the column once, alongside the household it was asked about", () => {
    const { source, start, end } = heldDuplicateBody();
    const body = source.slice(start, end);
    const filters = body.match(/(?:eq|inArray)\(documents\.contentIndex,/gu) ?? [];
    expect(filters, "one filter on the column").toHaveLength(1);
    const at = body.search(/(?:eq|inArray)\(documents\.contentIndex,/u);
    const where = body.slice(body.lastIndexOf(".where(and(", at));
    const clause = where.slice(0, where.indexOf("))"));
    expect(clause, "the same where binds household_id to the caller's household").toMatch(/eq\(documents\.householdId, householdId\)/u);
    const answers = body.slice(body.indexOf("held.set("));
    expect(answers, "the value is never handed back to the caller").not.toMatch(/contentIndex/u);
  });

  it("the reader's query takes one row per index asked, with an explicit LIMIT of that many", () => {
    const { source, start, end } = heldDuplicateBody();
    const body = source.slice(start, end);
    expect(body, "DISTINCT ON the index: only the earliest copy of each file").toMatch(/selectDistinctOn\(\[documents\.contentIndex\]/u);
    expect(body, "ordered so DISTINCT ON keeps the earliest").toMatch(/orderBy\(asc\(documents\.contentIndex\), asc\(documents\.createdAt\), asc\(documents\.id\)\)/u);
    expect(body, "a LIMIT of one row per index asked").toMatch(/\.limit\(asked\.size\)/u);
  });

  it("no select outside the reader projects the column", () => {
    const { source, start, end } = heldDuplicateBody();
    const firstLine = source.slice(0, start).split("\n").length;
    const lastLine = source.slice(0, end).split("\n").length;
    const projections = mentions().filter(({ file, line, text }) => /contentIndex:\s*documents\.contentIndex/u.test(text)
      && !(file === repositoryFile && line >= firstLine && line <= lastLine));
    expect(projections.map(({ file, line }) => `${file}:${line}`)).toEqual([]);
  });
});
