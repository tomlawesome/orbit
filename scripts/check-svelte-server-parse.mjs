#!/usr/bin/env node
/**
 * Guards the dev-server crash of #1138.
 *
 * Svelte 5.57's server output rewrites a JSDoc type comment on an arrow
 * function's own parameter, `(/** @type {T} *\/ x) => ...`, as
 * `(/** @type {T} *\/ (x)) => ...`: a parenthesised parameter, which is not
 * JavaScript. `vite build` bundles through rolldown and smooths it over, so
 * production is fine; `vite dev`'s SSR runner hands the text to V8, which
 * throws "Invalid destructuring assignment target", and every page reaching
 * the component 500s in dev only (#1133 was one).
 *
 * Whether a given comment triggers it depends on where it sits (a template
 * expression, or inside `$derived(...)`, comes out clean), so this does not
 * guess from the text: it compiles every component the way the dev server
 * does and parses the result.
 */
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const webRoot = path.join(repositoryRoot, "web");
const fromWeb = createRequire(path.join(webRoot, "package.json"));
/* The ES module build, which is what vite dev runs. `require` would load the
   package's CommonJS bundle, whose output does not carry the bug, and this
   check would pass everything. */
const svelteRoot = path.dirname(fromWeb.resolve("svelte/package.json"));
const { compile } = await import(pathToFileURL(path.join(svelteRoot, "src", "compiler", "index.js")).href);
const { transformSync } = fromWeb("esbuild");

/**
 * The parse error the server output of one component raises, or null.
 * @param {string} source
 * @param {string} [filename]
 * @returns {string | null}
 */
export function serverParseError(source, filename = "Component.svelte") {
  const code = compile(source, { generate: "server", filename }).js.code;
  try {
    transformSync(code, { loader: "js", format: "esm" });
    return null;
  } catch (error) {
    const first = /** @type {{ errors?: { text: string, location?: { line: number } }[] }} */ (error).errors?.[0];
    return first ? `${first.text} (compiled line ${first.location?.line ?? "?"})` : String(error);
  }
}

/** @param {string} dir @returns {string[]} */
const componentsUnder = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return componentsUnder(full);
  return entry.name.endsWith(".svelte") ? [full] : [];
});

function main() {
  const files = componentsUnder(path.join(webRoot, "src"));
  const failures = files.flatMap((file) => {
    const problem = serverParseError(readFileSync(file, "utf8"), file);
    return problem ? [`${path.relative(repositoryRoot, file)}: ${problem}`] : [];
  });
  if (failures.length === 0) {
    console.log(`svelte server-output parse check: clean across ${files.length} components.`);
    return;
  }
  console.error("svelte server-output parse check: these compile to code vite dev cannot run (#1138).");
  console.error("Drop the parameter's JSDoc comment, or type the variable the function is assigned to instead.\n");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
