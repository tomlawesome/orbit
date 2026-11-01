/*
 * Mounting a SvelteKit page in happy-dom, without the Svelte vite plugin (the
 * unit project has none): the page's .svelte files are compiled with Svelte's
 * own compiler, runes modules (.svelte.js) with compileModule, and written to
 * a throwaway directory under tmp/ (git-ignored, inside the checkout so the
 * output resolves the $lib alias and vitest's transforms like any web/ module).
 * Plain .js imports are left to vitest. A test passes the data layer in with
 * vi.mock or a fetch stub; components it does not care about are stubbed.
 *
 * The shape of settings-text-size-tab-stop.test.mjs, held once.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../..");
export const web = join(root, "web");
const svelteSrc = join(web, "node_modules/svelte/src");
const quoted = (/** @type {string} */ path) => JSON.stringify(path);

/** Where each `svelte` specifier lands, in the browser build the compiled output expects. */
const SVELTE = {
  svelte: "index-client.js",
  "svelte/internal/client": "internal/client/index.js",
  "svelte/internal/disclose-version": "internal/disclose-version.js",
  "svelte/internal/flags/async": "internal/flags/async.js",
  "svelte/internal/flags/legacy": "internal/flags/legacy.js",
  "svelte/internal/flags/tracing": "internal/flags/tracing.js",
  "svelte/reactivity": "reactivity/index-client.js",
  "svelte/store": "store/index-client.js",
  "svelte/motion": "motion/index.js",
  "svelte/easing": "easing/index.js",
  "svelte/transition": "transition/index.js",
  "svelte/animate": "animate/index.js",
  "svelte/events": "events/index.js",
};

/** The svelte runtime the compiled pages run on. */
export const runtime = () => import(/* @vite-ignore */ pathToFileURL(join(svelteSrc, "index-client.js")).href);

/**
 * @param {string} name  prefix of the throwaway directory
 * @param {{
 *   stub?: (file: string) => boolean,
 *   page?: { url?: string, params?: Record<string, string>, data?: unknown },
 * }} [options]
 *   `stub(file)`: a component that draws nothing (absolute path in);
 *   `page`: what `$app/state` reports.
 */
export function createPageLoader(name, options = {}) {
  /** @type {string} */
  let outDir = "";
  /** @type {Map<string, string>} */
  let compiled = new Map();
  /** @type {Promise<any> | null} */
  let compilerModule = null;
  const compiler = () => (compilerModule ??= import(/* @vite-ignore */ pathToFileURL(join(svelteSrc, "compiler/index.js")).href));

  /** Compiles a .svelte or .svelte.js file and, first, every one it imports. @returns {Promise<string>} the compiled file's path */
  async function build(/** @type {string} */ file) {
    const known = compiled.get(file);
    if (known) return known;
    const index = compiled.size;
    if (options.stub?.(file)) {
      const stub = join(outDir, `${index}-stub.mjs`);
      writeFileSync(stub, "export default function Stub() { return { ascend() {}, descend() {}, ready() {}, readyAtLeisure() {}, descendFrom() {} }; }\n");
      compiled.set(file, stub);
      return stub;
    }
    const { compile, compileModule } = await compiler();
    const source = readFileSync(file, "utf8");
    const isComponent = file.endsWith(".svelte");
    let js = (isComponent
      ? compile(source, { filename: file, generate: "client", dev: false })
      // JSDoc comments carry no behaviour, and the module printer turns a typed
      // parameter's comment into a parenthesised cast, which is not a parameter:
      // they are dropped before a runes module is compiled.
      : compileModule(source.replace(/\/\*\*[\s\S]*?\*\//g, ""), { filename: file, generate: "client", dev: false })
    ).js.code.replace(/^import\s+"[^"]+\.css";?$/gm, "");
    const specifiers = [...js.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
    for (const spec of new Set(specifiers)) {
      /** @type {string | null} */
      let target = null;
      if (spec in SVELTE) target = join(svelteSrc, SVELTE[/** @type {keyof typeof SVELTE} */ (spec)]);
      else if (spec === "$app/state") {
        target = join(outDir, "app-state-stub.mjs");
        const { url = "http://localhost/", params = {}, data = {} } = options.page ?? {};
        writeFileSync(target, `export const page = { get url() { return new URL(globalThis.__svelteTestUrl ?? ${quoted(url)}); }, params: ${JSON.stringify(params)}, data: ${JSON.stringify(data)}, state: {}, status: 200, error: null };\n`);
      } else if (spec.startsWith(".") || spec.startsWith("$lib/")) {
        const abs = spec.startsWith(".") ? resolve(dirname(file), spec) : join(web, "src/lib", spec.slice(5));
        target = /\.svelte(\.js)?$/.test(abs) ? await build(abs) : abs;
      }
      if (target === null) continue;
      js = js.replaceAll(`"${spec}"`, quoted(target)).replaceAll(`'${spec}'`, quoted(target));
    }
    const out = join(outDir, `${index}-${file.split("/").pop()}.mjs`);
    writeFileSync(out, js);
    compiled.set(file, out);
    return out;
  }

  /** @type {(() => void) | null} */
  let unmountPage = null;

  return {
    /**
     * Call from beforeAll. The files named (paths under web/) are compiled and
     * imported now, so the first test does not spend its time limit on it.
     * @param {...string} warm
     */
    async setup(...warm) {
      mkdirSync(join(root, "tmp"), { recursive: true });
      outDir = mkdtempSync(join(root, "tmp", `${name}-`));
      compiled = new Map();
      for (const file of warm) await import(/* @vite-ignore */ await build(join(web, file)));
    },
    /** Call from afterAll. */
    teardown() { rmSync(outDir, { recursive: true, force: true }); },
    /** Call from afterEach. */
    unmount() { unmountPage?.(); unmountPage = null; document.body.innerHTML = ""; delete globalThis.__svelteTestUrl; },
    build,
    /**
     * Mounts the component at `file` (a path under web/) on document.body.
     * @param {string} file
     * @param {Record<string, unknown>} [props]
     * @param {{ url?: string }} [where]  the address `$app/state` reports for this mount
     */
    async mount(file, props = {}, where = {}) {
      if (where.url) globalThis.__svelteTestUrl = where.url;
      const path = await build(join(web, file));
      const { mount, unmount, flushSync } = await runtime();
      const { default: Component } = await import(/* @vite-ignore */ path);
      const component = mount(Component, { target: document.body, props });
      unmountPage = () => unmount(component);
      flushSync();
      return component;
    },
  };
}
