import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * #1371 spec item 20: the type check reports nothing under web/src/lib/door/.
 * The folder is orbit-site's plain JavaScript and is never edited here, so the
 * check leaves it out (web/tsconfig.check.json) and Orbit's code sees its
 * interface through web/types/door/index.d.ts. Source tripwires: the stub
 * declares everything index.js exports, so an import that adds an export
 * fails here until the stub says so; and the check config keeps the two
 * mappings that make the redirect work (`exclude` alone does not: imported
 * JavaScript is checked whatever `exclude` says).
 */

const root = path.resolve(import.meta.dirname, "../..");
const read = (...parts) => readFileSync(path.join(root, ...parts), "utf8");

/** every name index.js exports, from `export { ... }` lists and `export function` */
const exportedBy = (text) => {
  const names = new Set();
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name);
    }
  }
  for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return [...names].sort();
};

describe("the type check sees the shared door through a declaration stub (item 20)", () => {
  const stub = read("web/types/door/index.d.ts");
  const names = exportedBy(read("web/src/lib/door/index.js"));

  it("index.js exports something to declare", () => {
    expect(names.length).toBeGreaterThan(30);
    expect(names).toContain("createDoor");
  });

  it("the stub declares every name index.js exports", () => {
    const missing = names.filter((name) => !new RegExp(`export\\s+(?:const|interface|type)\\s+${name.replace(/\$/g, "\\$")}\\b`).test(stub));
    expect(missing, `exported by web/src/lib/door/index.js but not declared in web/types/door/index.d.ts:\n${missing.join("\n")}`).toEqual([]);
  });

  const config = JSON.parse(read("web/tsconfig.check.json"));

  it("web/tsconfig.check.json maps $lib/door/* to the stub", () => {
    expect(config.compilerOptions.paths["$lib/door/*"]).toEqual(["./types/door/*"]);
  });

  it("it keeps SvelteKit's own aliases, which a paths of its own replaces", () => {
    const paths = Object.keys(config.compilerOptions.paths);
    for (const alias of ["@", "@/*", "$lib", "$lib/*", "$app/types"]) expect(paths).toContain(alias);
  });

  it("it leaves the folder out of the files it checks", () => {
    expect(config.exclude).toContain("src/lib/door/**");
  });

  it("the web type check reads it, not tsconfig.json", () => {
    expect(read("web/package.json")).toContain("--tsconfig ./tsconfig.check.json");
    expect(read("scripts/check-v19-types.mjs")).toContain('"./tsconfig.check.json"');
  });
});
