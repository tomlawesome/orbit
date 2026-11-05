import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as archive from "@/server/portable-archive";
import * as repository from "@/server/portable-archive-repository";
import { PortableArchiveStorage } from "@/server/portable-archive-storage";

/** Dead production helpers stay removed (#1569). */
const ROOT = resolve(__dirname, "../..");
const SELF = resolve(__filename);
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "coverage"]);

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) files.push(...sourceFiles(path));
    } else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name)) {
      files.push(path);
    }
  }
  return files;
}

describe("dead portable-archive helpers stay gone (#1569)", () => {
  it("does not export encryptPortableArchive", () => {
    expect(archive).not.toHaveProperty("encryptPortableArchive");
  });

  it("does not export server previewPortableArchive", () => {
    expect(repository).not.toHaveProperty("previewPortableArchive");
  });

  it("removes PortableArchiveStorage.write but keeps writeStream", () => {
    expect(PortableArchiveStorage.prototype.write).toBeUndefined();
    expect(typeof PortableArchiveStorage.prototype.writeStream).toBe("function");
  });

  it("no file under src/ or tests/ calls the removed helpers", () => {
    const offenders = [join(ROOT, "src"), join(ROOT, "tests")]
      .flatMap(sourceFiles)
      .filter((file) => file !== SELF)
      .filter((file) => {
        const text = readFileSync(file, "utf8");
        return text.includes("encryptPortableArchive(") || text.includes("previewPortableArchive(");
      })
      .map((file) => file.slice(ROOT.length + 1));
    expect(offenders).toEqual([]);
  });
});
