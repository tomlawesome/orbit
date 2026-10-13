import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * #1408: fixtures, mockups and docs use invented names only. This guard keeps
 * a real person's name from coming back. Only the digest of the banned word is
 * stored, so the guard does not itself repeat the name.
 */
const root = path.resolve(import.meta.dirname, "../..");

/** sha256 of each banned word, lower case. */
const BANNED = new Set([
  // a real person's surname, #1408
  "4aa59b5a3761c43828cf2c0f44a385d94d078934936482f66e573cb444e7e481",
]);

/** @type {Map<string, boolean>} */
const seen = new Map();
/** @param {string} word */
function banned(word) {
  let hit = seen.get(word);
  if (hit === undefined) {
    hit = BANNED.has(createHash("sha256").update(word).digest("hex"));
    seen.set(word, hit);
  }
  return hit;
}

function trackedTextFiles() {
  const names = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  /** @type {{ name: string, text: string }[]} */
  const files = [];
  for (const name of names) {
    let data;
    try {
      data = readFileSync(path.join(root, name));
    } catch {
      continue; // deleted in the working tree, or a directory entry such as a submodule
    }
    if (data.subarray(0, 8192).includes(0)) continue; // binary
    files.push({ name, text: data.toString("utf8") });
  }
  return files;
}

describe("no real names (#1408)", () => {
  it("no tracked text file contains a banned word", () => {
    /** @type {string[]} */
    const hits = [];
    for (const { name, text } of trackedTextFiles()) {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const tokens = new Set(lines[i].toLowerCase().match(/[a-z0-9]+/g) ?? []);
        for (const token of tokens) {
          if (banned(token)) hits.push(`${name}:${i + 1}`);
        }
      }
    }
    expect(hits, "use an invented name instead (#1408)").toEqual([]);
  }, 60_000); // reads every tracked file: seconds, not milliseconds
});
