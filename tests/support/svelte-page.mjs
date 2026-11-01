/*
 * Mounts a SvelteKit page in happy-dom, for the unit tests that took over from
 * fidelity runs that needed no browser (ADR-0039, #1613). One helper for all of
 * them. Use inside a test file that starts with `// @vitest-environment happy-dom`.
 *
 * The suite has no Svelte plugin, so the page and every .svelte file it
 * reaches are compiled here with Svelte's own compiler (runes modules,
 * .svelte.js, with compileModule) into a throwaway folder under tmp/
 * (git-ignored, inside the checkout so the output resolves the $lib alias and
 * vitest's transforms like any web/ module), their imports pointed at the real
 * files. Plain .js imports are left to vitest, so a test's vi.mock() of a
 * module (the data layer, for one) holds for the page too. Same method as
 * settings-text-size-tab-stop.test.mjs.
 *
 *   const loader = createPageLoader("name", { stub, stubs, page });
 *   beforeAll(() => loader.setup("routes/x/+page.svelte"));   // optional warm-up
 *   afterEach(() => loader.unmount());
 *   afterAll(() => loader.teardown());
 *   const { target, flushSync } = await loader.mount("routes/x/+page.svelte", props);
 *
 * Paths are under web/src ("routes/home/+page.svelte"), or absolute for a test host.
 *
 * Importing this file also sets the timeouts for the test file, once: the
 * first hand compile of a page's tree costs 5-10 s on a busy host and lands on
 * whichever test (or beforeAll) comes first.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { vi } from "vitest";

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

/** Lets pending promises and timers of a page settle, a few turns. */
export async function settle(turns = 8) {
  for (let i = 0; i < turns; i += 1) await new Promise((r) => setTimeout(r, 0));
}

/* The timeouts are per test file, set once for every test and hook in it. */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 90_000 });

/** What the default `$app/navigation` stub reports to; the loader owns the spy. */
const NAVIGATION_STUB = "export const beforeNavigate = () => {}; export const afterNavigate = () => {}; export const onNavigate = () => {};\n"
  + "export const goto = (...args) => globalThis.__svelteTestNavigation.goto(...args); export const pushState = () => {}; export const replaceState = () => {};\n"
  + "export const invalidate = async () => {}; export const invalidateAll = async () => {};\n";

/** A component that draws nothing, with the handles the pocket's pages call on a child. */
const STUB_COMPONENT = "export default function Stub() { return { ascend() {}, descend() {}, ready() {}, readyAtLeisure() {}, descendFrom() {} }; }\n";

/**
 * @param {string} name  prefix of the throwaway directory
 * @param {{
 *   stub?: (file: string) => boolean,
 *   stubs?: Record<string, string>,
 *   page?: { url?: string, params?: Record<string, string>, data?: unknown },
 * }} [options]
 *   `stub(file)`: a component that draws nothing (absolute path in);
 *   `stubs`: module sources standing in for a module, keyed by the specifier the
 *   sources import ("$app/state", "./sky.js") or by a path under web/src ("lib/Chrome.svelte");
 *   `page`: what `$app/state` reports.
 *
 * `$app/navigation` is stubbed by default (the suite's alias lacks the hooks a
 * bottom sheet listens with); `loader.navigation.goto` is the spy behind its `goto`.
 */
export function createPageLoader(name, options = {}) {
  const stubs = options.stubs ?? {};
  /** @type {string} */
  let outDir = "";
  /** @type {Map<string, string>} */
  let compiled = new Map();
  let count = 0;
  /** @type {Promise<any> | null} */
  let compilerModule = null;
  const compiler = () => (compilerModule ??= import(/* @vite-ignore */ pathToFileURL(join(svelteSrc, "compiler/index.js")).href));
  const navigation = { goto: vi.fn(async (/** @type {unknown[]} */ ..._args) => {}) };
  /** @type {any} */ (globalThis).__svelteTestNavigation = navigation;

  /* A page's <link rel="stylesheet"> cannot load here; happy-dom would log an
     error for each one, which is noise, not a finding. */
  const happy = /** @type {any} */ (globalThis).window?.happyDOM;
  if (happy?.settings) happy.settings.handleDisabledFileLoadingAsSuccess = true;

  /** The folder the compiled files go in, made on first use. */
  const ensureOut = () => {
    if (!outDir) {
      mkdirSync(join(root, "tmp"), { recursive: true });
      outDir = mkdtempSync(join(root, "tmp", `${name}-`));
      compiled = new Map();
    }
    return outDir;
  };

  /** @param {string} source @param {string} tag */
  const write = (source, tag) => {
    const out = join(ensureOut(), `${count++}-${tag}.mjs`);
    writeFileSync(out, source);
    return out;
  };

  /** The stub standing in for a specifier or a source file, if the test gave one. @param {string} spec @param {string | null} abs */
  const stubFor = (spec, abs) => {
    if (spec in stubs) return stubs[spec];
    if (abs) for (const [key, source] of Object.entries(stubs)) if (abs.endsWith(`/src/${key}`)) return source;
    return null;
  };

  /** @param {string} file a path under web/src, or an absolute one */
  const resolvePage = (file) => (file.startsWith("/") ? file : join(web, "src", file));

  /** Compiles a .svelte or .svelte.js file and, first, every one it imports. @returns {Promise<string>} the compiled file's path */
  async function build(/** @type {string} */ file) {
    const known = compiled.get(file);
    if (known) return known;
    if (options.stub?.(file)) {
      const out = write(STUB_COMPONENT, "stub");
      compiled.set(file, out);
      return out;
    }
    const sourceStub = stubFor("", file);
    if (sourceStub !== null) {
      const out = write(sourceStub, "stub");
      compiled.set(file, out);
      return out;
    }
    const { compile, compileModule } = await compiler();
    // JSDoc comments carry no behaviour, and the compiler prints one on an
    // arrow's parameter with the parameter wrapped in brackets, which is not
    // JavaScript: they are dropped before compiling.
    const source = readFileSync(file, "utf8").replace(/\/\*\*(?:(?!\*\/)[^])*\*\//g, "");
    let js = (file.endsWith(".svelte")
      ? compile(source, { filename: file, generate: "client", dev: false })
      : compileModule(source, { filename: file, generate: "client", dev: false })
    ).js.code.replace(/^import\s+["'][^"']+\.css["'];?$/gm, "");
    const specifiers = [...js.matchAll(/(?:from|import)\s*\(?\s*(["'])([^"'\n]+)\1/g)].map((m) => m[2]);
    for (const spec of new Set(specifiers)) {
      /** @type {string | null} */
      let target = null;
      if (spec in SVELTE) target = join(svelteSrc, SVELTE[/** @type {keyof typeof SVELTE} */ (spec)]);
      else if (spec === "$app/state" && stubFor(spec, null) === null) {
        const { url = "http://localhost/", params = {}, data = {} } = options.page ?? {};
        target = write(`export const page = { get url() { return new URL(globalThis.__svelteTestUrl ?? ${quoted(url)}); }, params: ${JSON.stringify(params)}, data: ${JSON.stringify(data)}, state: {}, status: 200, error: null, route: { id: null } };\n`, "app-state");
      } else if (spec === "$app/navigation" && stubFor(spec, null) === null) target = write(NAVIGATION_STUB, "app-navigation");
      else if (stubFor(spec, null) !== null) target = write(/** @type {string} */ (stubFor(spec, null)), "stub");
      else if (spec.startsWith(".") || spec.startsWith("$lib/")) {
        const abs = spec.startsWith(".") ? resolve(dirname(file), spec) : join(web, "src/lib", spec.slice(5));
        target = /\.svelte(\.js)?$/.test(abs) ? await build(abs) : abs;
      }
      if (target === null) continue;
      js = js.replaceAll(`"${spec}"`, quoted(target)).replaceAll(`'${spec}'`, quoted(target));
    }
    const out = write(js, file.split("/").pop() ?? "module");
    compiled.set(file, out);
    return out;
  }

  /** @type {Array<() => void>} */
  const unmounts = [];

  return {
    /** The spy behind the stubbed `$app/navigation`'s `goto`; cleared by `unmount`. */
    navigation,
    /**
     * Call from beforeAll (its timeout is the helper's). The files named (paths
     * under web/src) are compiled and imported now, so the first test does not
     * spend its time limit on it.
     * @param {...string} warm
     */
    async setup(...warm) {
      ensureOut();
      for (const file of warm) await import(/* @vite-ignore */ await build(resolvePage(file)));
    },
    /** Call from afterAll: removes the scratch folder. */
    teardown() {
      if (outDir) rmSync(outDir, { recursive: true, force: true });
      outDir = "";
      compiled = new Map();
    },
    /** Call from afterEach: unmounts everything mounted and empties the body. */
    unmount() {
      for (const undo of unmounts.splice(0)) undo();
      document.body.innerHTML = "";
      delete (/** @type {any} */ (globalThis)).__svelteTestUrl;
      navigation.goto.mockClear();
    },
    build,
    /**
     * Mounts the component at `file` (a path under web/src, or a test host by
     * absolute path) in a div on document.body.
     * @param {string} file
     * @param {Record<string, unknown>} [props]
     * @param {{ url?: string }} [where]  the address `$app/state` reports for this mount
     */
    async mount(file, props = {}, where = {}) {
      if (where.url) /** @type {any} */ (globalThis).__svelteTestUrl = where.url;
      const path = await build(resolvePage(file));
      const { mount, unmount, flushSync } = await runtime();
      const { default: Component } = await import(/* @vite-ignore */ path);
      const target = document.body.appendChild(document.createElement("div"));
      const component = mount(Component, { target, props });
      unmounts.push(() => unmount(component));
      flushSync();
      return { component, target, flushSync };
    },
  };
}
