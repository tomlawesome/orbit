import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/* The engine ships inside the SvelteKit server now (#735), so its runtime
 * dependencies have to be dependencies of `orbit-web` as well: adapter-node
 * builds the production `node_modules` from web's own list, and anything
 * missing from it resolves fine in the repo — where the root package has it —
 * and then throws MODULE_NOT_FOUND in the image, which is the worst place to
 * find out.
 *
 * The two lists are pinned to identical versions by one lockfile; what this
 * guards is the list, not the version. Adding a runtime dependency to the
 * engine without adding it to web is the mistake it exists to catch.
 */

const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const web = JSON.parse(readFileSync(new URL("../web/package.json", import.meta.url), "utf8"));

/* Deleted with `src/app/` in the final commit of #735; until then they are
   the only root dependencies that are NOT the engine's. */
const NEXT_ONLY = new Set(["next", "react", "react-dom"]);

const engineDeps = Object.entries(root.dependencies).filter(([name]) => !NEXT_ONLY.has(name));

describe("engine runtime dependencies reach the SvelteKit build", () => {
  it("web declares every engine runtime dependency", () => {
    const missing = engineDeps
      .map(([name]) => name)
      .filter((name) => !Object.hasOwn(web.dependencies ?? {}, name));
    expect(missing, `web/package.json is missing engine runtime deps: ${missing.join(", ")}`).toEqual([]);
  });

  it("web pins them to the same versions the engine asks for", () => {
    const drifted = engineDeps
      .filter(([name, range]) => (web.dependencies ?? {})[name] !== undefined)
      .filter(([name, range]) => web.dependencies[name] !== range)
      .map(([name, range]) => `${name}: root ${range}, web ${web.dependencies[name]}`);
    expect(drifted, `version drift between the two package.json files: ${drifted.join("; ")}`).toEqual([]);
  });

  it("takes the engine itself as a workspace link, not a published version", () => {
    /* A real version range here would mean web had silently started resolving
       some published `orbit` from a registry rather than this source tree. */
    expect(web.devDependencies?.orbit).toBe("workspace:*");
  });
});
