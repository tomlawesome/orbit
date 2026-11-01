/*
 * Mounts a SvelteKit page (+page.svelte) in happy-dom, for the unit tests that
 * took over from fidelity runs that needed no browser (ADR-0039, #1613).
 *
 * The suite has no Svelte plugin, so the page and every .svelte file it
 * reaches are compiled here with Svelte's own compiler into a scratch folder
 * under tmp/, their imports pointed at the real files, and loaded through
 * Vitest, so a test's vi.mock() of a module (the data layer, for one) holds
 * for the page too. Same method as settings-text-size-tab-stop.test.mjs and
 * review-sheet-pending-approval.test.mjs, shared instead of copied.
 *
 * Use inside a test file that starts with `// @vitest-environment happy-dom`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { vi } from "vitest";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/* The timeout is per file, set once for every test in it. The cost it covers
   is the first hand compile of a page's tree (5-10 s), which lands on whichever
   test mounts first; it is not a busy host, and the default 5 s is under it. */
vi.setConfig({ testTimeout: 30000 });

const ROOT = resolve(import.meta.dirname, "../..");
const WEB = join(ROOT, "web");
const SRC = join(WEB, "src");
const svelteSrc = join(WEB, "node_modules/svelte/src");
const quoted = (/** @type {string} */ path) => JSON.stringify(path);

const RUNTIME = /** @type {Record<string, string>} */ ({
  "svelte/internal/client": join(svelteSrc, "internal/client/index.js"),
  "svelte/internal/disclose-version": join(svelteSrc, "internal/disclose-version.js"),
  "svelte/internal/flags/async": join(svelteSrc, "internal/flags/async.js"),
  "svelte/internal/flags/legacy": join(svelteSrc, "internal/flags/legacy.js"),
  svelte: join(svelteSrc, "index-client.js"),
});

/**
 * @param {string} name a short label for the scratch folder
 * @param {object} [options]
 * @param {Record<string, string>} [options.stubs] module sources standing in for a module, keyed by the
 *   specifier the sources import ("$app/state") or by a path under web/src ("lib/Chrome.svelte")
 * @param {string} [options.url] the address the page believes it is at ($app/state's page.url)
 */
export function createPageBuilder(name, { stubs = {}, url = "http://localhost/" } = {}) {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const outDir = mkdtempSync(join(ROOT, "tmp", `${name}-`));
  /** @type {Map<string, string>} */
  const compiled = new Map();
  let count = 0;

  /** @param {string} source @param {string} tag */
  const write = (source, tag) => {
    const out = join(outDir, `${count++}-${tag}.mjs`);
    writeFileSync(out, source);
    return out;
  };

  /** The stub standing in for a specifier or a source file, if the test gave one. @param {string} spec @param {string | null} abs */
  const stubFor = (spec, abs) => {
    if (spec in stubs) return stubs[spec];
    if (abs) for (const [key, source] of Object.entries(stubs)) if (abs.endsWith(`/src/${key}`)) return source;
    return null;
  };

  /** Compiles a .svelte or .svelte.js file and, first, every one it imports. @param {string} file */
  async function build(file) {
    const known = compiled.get(file);
    if (known) return known;
    const stub = stubFor("", file);
    if (stub !== null) {
      const out = write(stub, "stub");
      compiled.set(file, out);
      return out;
    }
    const { compile, compileModule } = await import(pathToFileURL(join(svelteSrc, "compiler/index.js")).href);
    // JSDoc type comments are dropped first: the compiler prints one on an
    // arrow's parameter with the parameter wrapped in brackets, which is not JavaScript.
    const source = readFileSync(file, "utf8").replace(/\/\*\*(?:(?!\*\/)[^])*\*\//g, "");
    let js = file.endsWith(".svelte")
      ? compile(source, { filename: file, generate: "client", dev: false }).js.code
      : compileModule(source, { filename: file, generate: "client", dev: false }).js.code;
    js = js.replace(/^import\s+["'][^"']+\.css["'];?$/gm, "");
    const specifiers = [...js.matchAll(/(?:from|import)\s*\(?\s*(["'])([^"'\n]+)\1/g)].map((m) => m[2]);
    for (const spec of new Set(specifiers)) {
      let target = null;
      if (spec in RUNTIME) target = RUNTIME[spec];
      else if (spec === "$app/state") {
        target = write(
          stubFor(spec, null) ?? `export const page = { url: new URL(${quoted(url)}), params: {}, data: {}, state: {}, status: 200, error: null, route: { id: null } };\n`,
          "app-state",
        );
      } else if (spec === "$app/navigation" && stubFor(spec, null) === null) {
        /* The suite's own alias lacks the hooks a bottom sheet listens with. */
        target = write(
          "export const beforeNavigate = () => {}; export const afterNavigate = () => {}; export const onNavigate = () => {};\n"
          + "export const goto = async () => {}; export const pushState = () => {}; export const replaceState = () => {};\n"
          + "export const invalidate = async () => {}; export const invalidateAll = async () => {};\n",
          "app-navigation",
        );
      } else if (stubFor(spec, null) !== null) target = write(/** @type {string} */ (stubFor(spec, null)), "stub");
      else {
        let abs = null;
        if (spec.startsWith(".")) abs = resolve(dirname(file), spec);
        else if (spec.startsWith("$lib/")) abs = join(SRC, "lib", spec.slice(5));
        if (abs === null) continue;
        target = abs.endsWith(".svelte") || abs.endsWith(".svelte.js") ? await build(abs) : abs;
      }
      js = js.replaceAll(`"${spec}"`, quoted(target)).replaceAll(`'${spec}'`, quoted(target));
    }
    const out = write(js, file.split("/").pop() ?? "module");
    compiled.set(file, out);
    return out;
  }

  /** @type {Array<() => void>} */
  const unmounts = [];

  /* A page's <link rel="stylesheet"> cannot load here; happy-dom would log an
     error for each one, which is noise, not a finding. */
  const happy = /** @type {any} */ (window).happyDOM;
  if (happy?.settings) happy.settings.handleDisabledFileLoadingAsSuccess = true;

  return {
    /**
     * Mounts a page under web/src (e.g. "routes/maintenance/+page.svelte"), or a test host given
     * by absolute path, into document.body.
     * @param {string} page @param {Record<string, unknown>} props
     */
    async mount(page, props) {
      const compiledPage = await build(page.startsWith("/") ? page : join(SRC, page));
      const { mount, unmount, flushSync } = await import(pathToFileURL(RUNTIME.svelte).href);
      const { default: Component } = await import(/* @vite-ignore */ compiledPage);
      const target = document.body.appendChild(document.createElement("div"));
      const component = mount(Component, { target, props });
      unmounts.push(() => unmount(component));
      flushSync();
      return { target, flushSync };
    },
    /** Unmounts everything mounted and empties the body. */
    unmountAll() {
      for (const undo of unmounts.splice(0)) undo();
      document.body.innerHTML = "";
    },
    /** Removes the scratch folder. */
    dispose() {
      rmSync(outDir, { recursive: true, force: true });
    },
  };
}

/** Lets pending promises and timers of a page settle, a few turns. */
export async function settle(turns = 8) {
  for (let i = 0; i < turns; i += 1) await new Promise((r) => setTimeout(r, 0));
}
