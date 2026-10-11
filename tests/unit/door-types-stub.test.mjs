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

  /**
   * The members of the object a function returns at its end, from the folder's
   * text: `name`, `name: value` and `get name()`. `from` is where the function
   * starts, so the last `return { ... }` after it is found.
   */
  const returnedMembers = (text, from, until) => {
    const start = text.indexOf(from);
    expect(start, `${from} not found in the folder`).toBeGreaterThan(-1);
    const end = until ? text.indexOf(until, start) : text.length;
    const returns = [...text.slice(start, end).matchAll(/^\s*return \{(.*)\};?\s*$/gm)];
    expect(returns.length, `no returned object after ${from}`).toBeGreaterThan(0);
    const body = returns.at(-1)[1];
    const members = new Set();
    for (const m of body.matchAll(/get\s+([A-Za-z_$][\w$]*)\s*\(\)/g)) members.add(m[1]);
    /* drop getters' bodies and call arguments before reading the plain members */
    const flat = body.replace(/get\s+[A-Za-z_$][\w$]*\s*\(\)\s*\{[^}]*\}/g, "").replace(/\([^()]*(?:\([^()]*\)[^()]*)*\)/g, "()");
    for (const part of flat.split(",")) {
      const name = part.trim().match(/^([A-Za-z_$][\w$]*)\s*(?::|$)/)?.[1];
      if (name) members.add(name);
    }
    return [...members].sort();
  };
  const interfaceBody = (name) => {
    const m = stub.match(new RegExp(`export interface ${name}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`));
    expect(m, `interface ${name} in the stub`).not.toBeNull();
    return m[1];
  };
  const declares = (name, member) => new RegExp(`^\\s*(?:readonly\\s+)?${member}\\??\\s*:`, "m").test(interfaceBody(name));

  it("Dawn, Dusk and Journey declare every member the folder's objects carry", () => {
    const dawn = read("web/src/lib/door/dawn.js");
    const journey = read("web/src/lib/door/journey.js");
    const cases = [
      ["Dawn", returnedMembers(dawn, "export function mountDawn(", "export function mountDusk(")],
      ["Dusk", returnedMembers(dawn, "export function mountDusk(")],
      ["Journey", returnedMembers(journey, "export function createJourney(")],
    ];
    for (const [name, members] of cases) {
      expect(members.length, name).toBeGreaterThan(3);
      const missing = members.filter((member) => !declares(name, member));
      expect(missing, `${name}: carried by the folder's object but not declared in the stub`).toEqual([]);
    }
  });

  it("Journey.reduced is a value in the folder, so the stub does not declare a function", () => {
    expect(read("web/src/lib/door/journey.js")).toMatch(/const reduced = matchMedia\(.*\)\.matches;/);
    expect(interfaceBody("Journey")).toMatch(/^\s*reduced:\s*boolean;/m);
  });

  it("Dawn.held is a getter in the folder, and the stub declares it read-only", () => {
    expect(read("web/src/lib/door/dawn.js")).toMatch(/get held\(\) \{ return \[\.\.\.held, \.\.\.rastered\.values\(\)\]; \}/);
    expect(interfaceBody("Dawn")).toMatch(/^\s*readonly held:/m);
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
