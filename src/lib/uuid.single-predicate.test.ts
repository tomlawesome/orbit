import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * One predicate (#1334): five private copies of "is this a UUID" had drifted
 * (one accepted any hex, one refused version 7). Nothing outside this module
 * may build its own.
 */
describe("the engine keeps one UUID predicate", () => {
  const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
  const own = join(sourceRoot, "lib", "uuid.ts");

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) return name === "__fixtures__" ? [] : sourceFiles(path);
      return /\.ts$/u.test(name) && !/\.test\.ts$/u.test(name) ? [path] : [];
    });
  }

  it("has no hand-written UUID pattern or private UUID schema outside src/lib/uuid.ts", () => {
    const offenders = sourceFiles(sourceRoot)
      .filter((path) => path !== own)
      .filter((path) => {
        const text = readFileSync(path, "utf8");
        return /\[0-9a-f\](?:-|\{8\})/iu.test(text) && /\{8\}-\[0-9a-f\]\{4\}|\[0-9a-f-\]\{36\}/iu.test(text)
          || /const\s+\w*uuid\w*\s*=\s*z\.uuid\(\)/iu.test(text);
      })
      .map((path) => relative(sourceRoot, path));
    expect(offenders).toEqual([]);
  });
});
