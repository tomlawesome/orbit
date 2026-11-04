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
