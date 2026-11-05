import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// #1362: the one textual reader of .gitlab-ci.yml for script tests.
export const CI_PATH = fileURLToPath(new URL("../../.gitlab-ci.yml", import.meta.url));

export function readCi() {
  return readFileSync(CI_PATH, "utf8");
}

// Top-level blocks by name, in file order: a line that is `name:` at column
// zero, with or without an `&anchor |` after it and an optional trailing
// comment, up to the next such line (or the end of the text). The header line
// is part of the block. Hidden keys (`.name:`) are included.
export function jobBlocks(text = readCi()) {
  const blocks = new Map();
  const headers = [...text.matchAll(/^([A-Za-z_.][A-Za-z0-9_.-]*):[ \t]*(?:&\S+[ \t]*\|?[ \t]*)?(?:#.*)?$/gmu)];
  headers.forEach((match, index) => {
    const end = index + 1 < headers.length ? headers[index + 1].index : text.length;
    blocks.set(match[1], text.slice(match.index, end));
  });
  return blocks;
}

export function jobBlock(name, text = readCi()) {
  const block = jobBlocks(text).get(name);
  if (block === undefined) {
    throw new Error(`job "${name}" not found in .gitlab-ci.yml`);
  }
  return block;
}

// ---------------------------------------------------------------------------
// #1698: rules lists, with GitLab's `!reference [a, b]` tag and aliases.
//
// The file has no YAML library in scope (none is a dependency), so this stays
// textual like jobBlocks. `!reference [a, b]` is a custom YAML tag that
// resolves to the value at key `b` under top-level key `a` -- of this file or
// of an included template, whose text is passed in `templates`. A rules list
// that is nested in a rules list (by alias or by `!reference`) is flattened, as
// GitLab does.
// ---------------------------------------------------------------------------

// Top-level keys that are not jobs (hidden `.name` keys are not jobs either).
export const NON_JOB_KEYS = new Set(["include", "stages", "workflow", "default", "variables"]);

const BLANK_OR_COMMENT = /^\s*(#.*)?$/u;

/** Names of the jobs a file defines, in file order. */
export function jobNamesOf(text = readCi()) {
  return [...jobBlocks(text).keys()].filter((name) => !name.startsWith(".") && !NON_JOB_KEYS.has(name));
}

/** The `stages:` list. */
export function stagesOf(text = readCi()) {
  const block = jobBlocks(text).get("stages");
  if (block === undefined) return [];
  return block
    .split("\n")
    .slice(1)
    .map((line) => /^ {2}- (\S+)\s*(?:#.*)?$/u.exec(line)?.[1])
    .filter((stage) => stage !== undefined);
}

/**
 * The `include:` entries as [{ project, ref, file, comment }]; `comment` is the
 * text after `#` on the `ref:` line (the tag a commit ref stands for).
 */
export function includesOf(text = readCi()) {
  const block = jobBlocks(text).get("include");
  if (block === undefined) return [];
  const entries = [];
  for (const line of block.split("\n").slice(1)) {
    const start = /^ {2}- (\w+): (.*)$/u.exec(line);
    const more = /^ {4}(\w+): (.*)$/u.exec(line);
    if (start) entries.push({ [start[1]]: start[2].trim() });
    else if (more && entries.length) {
      const [value, ...comment] = more[2].split(/\s+#\s*/u);
      entries.at(-1)[more[1]] = value.trim();
      if (more[1] === "ref") entries.at(-1).comment = comment.join(" # ");
    }
  }
  return entries;
}

// Groups the lines of a list whose `- ` sits at column `indent` into items
// { head, rest }: the text after `- ` and the item's following lines.
function groupItems(lines, indent) {
  const lead = " ".repeat(indent);
  const items = [];
  for (const line of lines) {
    if (BLANK_OR_COMMENT.test(line)) continue;
    if (line.startsWith(`${lead}- `)) items.push({ head: line.slice(indent + 2), rest: [] });
    else if (line.startsWith(`${lead} `) && items.length) items.at(-1).rest.push(line);
    else if (!line.startsWith(lead)) break;
    else break;
  }
  return items;
}

// A rule mapping from its first `key: value` and the lines after it; the keys
// sit at column `keyColumn`. A folded `>-` / `|` value is joined by spaces.
function ruleFields(head, rest, keyColumn) {
  const lines = [" ".repeat(keyColumn) + head, ...rest];
  const rule = {};
  for (let i = 0; i < lines.length; i += 1) {
    const pair = new RegExp(`^ {${keyColumn}}(\\w+):\\s*(.*)$`, "u").exec(lines[i]);
    if (!pair) continue;
    let value = pair[2].trim();
    if (/^[>|][-+]?$/u.test(value)) {
      const folded = [];
      while (i + 1 < lines.length && !new RegExp(`^ {${keyColumn}}\\w+:`, "u").test(lines[i + 1])) {
        folded.push(lines[i + 1].trim());
        i += 1;
      }
      value = folded.join(" ");
    }
    rule[pair[1]] = value === "" ? true : value;
  }
  return rule;
}

// One item of a rules list as an entry: { reference: [a, b] }, { alias },
// or { rule: { if, when, ... } }.
function entryOf({ head, rest }, keyColumn) {
  const reference = /^!reference\s*\[\s*([^,\]\s]+)\s*,\s*([^\]\s]+)\s*\]\s*(?:#.*)?$/u.exec(head);
  if (reference) return { reference: [reference[1], reference[2]] };
  const alias = /^\*(\S+)\s*(?:#.*)?$/u.exec(head);
  if (alias) return { alias: alias[1] };
  return { rule: ruleFields(head, rest, keyColumn) };
}

// The entries of a list given as the lines of a hidden key's body: a list at
// indent 2, or a single rule mapping at indent 2.
function entriesOfHiddenBody(body) {
  if (body.some((line) => /^ {2}- /u.test(line))) {
    return groupItems(body, 2).map((item) => entryOf(item, 4));
  }
  const lines = body.filter((line) => !BLANK_OR_COMMENT.test(line));
  return [{ rule: ruleFields(lines[0]?.slice(2) ?? "", lines.slice(1), 2) }];
}

/**
 * The entries of a job's (or `workflow`'s) `rules:` as written, with nothing
 * expanded: { reference: [a, b] } | { alias: name } | { rule: {...} }. A
 * `rules: *anchor` gives the entries of the anchored list. A block with no
 * `rules:` gives [].
 */
export function ruleEntries(name, text = readCi()) {
  const blocks = jobBlocks(text);
  const block = blocks.get(name);
  if (block === undefined) throw new Error(`job "${name}" not found in the CI text`);
  const lines = block.split("\n");
  const index = lines.findIndex((line) => /^ {2}rules:/u.test(line));
  if (index === -1) return [];
  const whole = /^ {2}rules:\s*\*(\S+)\s*(?:#.*)?$/u.exec(lines[index]);
  if (whole) {
    const hidden = blocks.get(`.${whole[1]}`);
    if (hidden === undefined) throw new Error(`no hidden key defines *${whole[1]}`);
    return entriesOfHiddenBody(hidden.split("\n").slice(1));
  }
  const body = [];
  for (const line of lines.slice(index + 1)) {
    if (!BLANK_OR_COMMENT.test(line) && /^ {2}[^\s#]/u.test(line)) break;
    body.push(line);
  }
  return groupItems(body, 4).map((item) => entryOf(item, 6));
}

// `!reference [a, b]`: the list at key b under top-level key a, in this file
// or the first template that defines a. Its entries, unexpanded.
function referenceEntries([top, key], sources) {
  for (const text of sources) {
    const block = jobBlocks(text).get(top);
    if (block === undefined) continue;
    const lines = block.split("\n");
    const index = lines.findIndex((line) => new RegExp(`^ {2}${key}:`, "u").test(line));
    if (index === -1) continue;
    const body = [];
    for (const line of lines.slice(index + 1)) {
      if (!BLANK_OR_COMMENT.test(line) && /^ {2}[^\s#]/u.test(line)) break;
      body.push(line);
    }
    return groupItems(body, 4).map((item) => entryOf(item, 6));
  }
  throw new Error(`!reference [${top}, ${key}] names nothing in the CI text or its templates`);
}

/**
 * The rules a job (or `workflow`) really has: `!reference`s resolved against
 * this file and `templates` (the texts of included files), aliases followed,
 * and nested lists flattened in order. Each is { if?, when?, ... } with the
 * values as written.
 */
export function effectiveRules(name, text = readCi(), templates = []) {
  const sources = [text, ...templates];
  const blocks = jobBlocks(text);
  const flatten = (entries, seen) =>
    entries.flatMap((entry) => {
      if (entry.rule) return [entry.rule];
      if (entry.reference) {
        const key = entry.reference.join("/");
        if (seen.includes(key)) throw new Error(`!reference loop at ${key}`);
        return flatten(referenceEntries(entry.reference, sources), [...seen, key]);
      }
      const hidden = blocks.get(`.${entry.alias}`);
      if (hidden === undefined) throw new Error(`no hidden key defines *${entry.alias}`);
      return flatten(entriesOfHiddenBody(hidden.split("\n").slice(1)), seen);
    });
  return flatten(ownOrIncludedRules(name, text, templates), []);
}

// GitLab merges a job this file defines over the same job from an include,
// key by key: a local block without `rules:` (backmerge-check, which only
// pins its image, S-ci-1) keeps the template's rules.
function ownOrIncludedRules(name, text, templates) {
  const block = jobBlocks(text).get(name);
  if (block !== undefined && !/^ {2}rules:/mu.test(block)) {
    const template = templates.find((t) => jobBlocks(t).has(name));
    if (template !== undefined) return ruleEntries(name, template);
  }
  return ruleEntries(name, text);
}
