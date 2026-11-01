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
 *
 * #1267: the client output has its own shape of the same fault. A typed
 * `$props()` line that ends a component's script comes out as
 * `var /** @type {T} *\/ (p) = root();`, which is not JavaScript either. The
 * server output of that component is clean, so the client output is checked
 * too, for that one shape (a JSDoc comment between `var` and `(`), by pattern:
 * a legitimate parenthesised arrow parameter must keep passing.
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
  return serverOutputFault(compile(source, { generate: "server", filename }).js.code);
}

/**
 * The parse error compiled server code raises, or null. Split from the compile
 * so the check stays tested now svelte 5.57.3 no longer emits the #1138 shape.
 * @param {string} code
 * @returns {string | null}
 */
export function serverOutputFault(code) {
  try {
    transformSync(code, { loader: "js", format: "esm" });
    return null;
  } catch (error) {
    const first = /** @type {{ errors?: { text: string, location?: { line: number } }[] }} */ (error).errors?.[0];
    return first ? `${first.text} (compiled line ${first.location?.line ?? "?"})` : String(error);
  }
}

/**
 * The fault the client output of one component carries, or null.
 * @param {string} source
 * @param {string} [filename]
 * @returns {string | null}
 */
export function clientParseError(source, filename = "Component.svelte") {
  return clientOutputFault(compile(source, { generate: "client", filename }).js.code);
}

/**
 * The #1267 fault compiled client code carries, or null. Split from the compile
 * so the check stays tested now svelte 5.57.3 no longer emits the shape.
 * @param {string} code
 * @returns {string | null}
 */
export function clientOutputFault(code) {
  const match = /\bvar\s+\/\*\*(?:(?!\*\/)[\s\S])*\*\/\s*\(/.exec(code);
  return match ? `a JSDoc-typed binding wrapped in parentheses in the client output (${match[0].slice(0, 60)})` : null;
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
    const source = readFileSync(file, "utf8");
    const problem = serverParseError(source, file) ?? clientParseError(source, file);
    return problem ? [`${path.relative(repositoryRoot, file)}: ${problem}`] : [];
  });
  if (failures.length === 0) {
    console.log(`svelte server-output parse check: clean across ${files.length} components.`);
    return;
  }
  console.error("svelte server-output parse check: these compile to code vite dev cannot run (#1138, #1267).");
  console.error("Drop the parameter's JSDoc comment, or type the variable the function is assigned to instead.");
  console.error("A typed $props() line must not end the script: put a statement after it.\n");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
