// @vitest-environment happy-dom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The phone's Text size tiles sit in the settings page's Pocket layout, which
 * mounts before the page learns the applied step from the document. A reader
 * whose text size is not the default must still land, on Tab, on the tile
 * that is ticked: the tab stop matches the document's data-text-size.
 *
 * +page.svelte is compiled with Svelte's own compiler, with every .svelte
 * file it reaches compiled the same way, and mounted in happy-dom. The data
 * layer is stood in for: nothing it returns has a part in the tab stop.
 */

const never = () => new Promise(() => {});
vi.mock("$lib/data/workspace.js", () => ({
  readAuthMethodsOffered: never,
  readSentLately: never,
  readSessions: never,
  readSettingsScreen: () => Promise.reject(new Error("not under test")),
  readSignInMethods: never,
  removeLocalPassword: never,
  startProviderLink: never,
  startStepUp: never,
  unlinkProviderIdentity: never,
  writeLocalPassword: never,
  writeReminders: never,
  revokeSession: never,
  signOutEverywhere: never,
  savePreferences: never,
  wordsOf: (/** @type {unknown} */ _e, /** @type {string} */ fallback) => fallback,
}));
vi.mock("$lib/push/alerts.js", () => ({
  alertsSupported: () => false,
  disableAlerts: never,
  enableAlerts: never,
  syncAlerts: never,
}));

vi.mock("$lib/tour/watch.js", () => ({ watchTour: () => () => {} }));

const web = resolve(import.meta.dirname, "../../web");
const svelteSrc = join(web, "node_modules/svelte/src");
const quoted = (/** @type {string} */ path) => JSON.stringify(path);
/** @type {string} */
let outDir;
/** @type {Map<string, string>} */
const compiled = new Map();

/** Compiles a .svelte file and, first, every .svelte file it imports. */
async function build(/** @type {string} */ file) {
  const known = compiled.get(file);
  if (known) return known;
  if (file.endsWith("/lib/Chrome.svelte") || file.endsWith("/lib/pocket/Sheet.svelte")) {
    /* The site chrome and the bottom sheet have no part in the tab stop: a component that draws nothing. */
    const stub = join(outDir, `stub-${compiled.size}.mjs`);
    writeFileSync(stub, "export default function Stub() {}\n");
    compiled.set(file, stub);
    return stub;
  }
  const { compile } = await import(pathToFileURL(join(svelteSrc, "compiler/index.js")).href);
  let js = compile(readFileSync(file, "utf8"), { filename: file, generate: "client", dev: false }).js.code
    .replaceAll("'svelte/internal/client'", quoted(join(svelteSrc, "internal/client/index.js")))
    .replaceAll("'svelte/internal/disclose-version'", quoted(join(svelteSrc, "internal/disclose-version.js")))
    .replaceAll("'svelte/internal/flags/async'", quoted(join(svelteSrc, "internal/flags/async.js")))
    .replaceAll("'svelte/internal/flags/legacy'", quoted(join(svelteSrc, "internal/flags/legacy.js")))
    .replaceAll('from "svelte"', `from ${quoted(join(svelteSrc, "index-client.js"))}`)
    .replace(/^import\s+"[^"]+\.css";?$/gm, "");
  const specifiers = [...js.matchAll(/(?:from|import)\s+"([^"]+)"/g)].map((m) => m[1]);
  for (const spec of new Set(specifiers)) {
    let abs = null;
    if (spec === "$app/state") {
      /* SvelteKit's page state, outside SvelteKit: a fixed settings URL. */
      abs = join(outDir, "app-state-stub.mjs");
      writeFileSync(abs, 'export const page = { url: new URL("http://localhost/settings"), params: {}, data: {}, state: {} };\n');
    }
    if (spec.startsWith(".")) abs = resolve(dirname(file), spec);
    else if (spec.startsWith("$lib/")) abs = join(web, "src/lib", spec.slice(5));
    if (abs === null) continue;
    const target = abs.endsWith(".svelte") ? await build(abs) : abs;
    js = js.replaceAll(`"${spec}"`, quoted(target));
  }
  const out = join(outDir, `${compiled.size}-${file.split("/").pop()}.mjs`);
  writeFileSync(out, js);
  compiled.set(file, out);
  return out;
}

beforeAll(() => {
  mkdirSync(resolve(import.meta.dirname, "../../tmp"), { recursive: true });
  outDir = mkdtempSync(resolve(import.meta.dirname, "../../tmp/settings-tab-stop-"));
});
afterAll(() => { rmSync(outDir, { recursive: true, force: true }); });

/** @type {(() => void) | null} */
let unmountPage = null;
beforeEach(() => { document.documentElement.removeAttribute("data-text-size"); });
afterEach(() => {
  unmountPage?.(); unmountPage = null; document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-text-size");
});

async function mountSettings(/** @type {string} */ applied) {
  document.documentElement.setAttribute("data-text-size", applied);
  const page = await build(join(web, "src/routes/settings/+page.svelte"));
  const { mount, unmount, flushSync } = await import(pathToFileURL(join(svelteSrc, "index-client.js")).href);
  const { default: Settings } = await import(/* @vite-ignore */ page);
  const component = mount(Settings, { target: document.body, props: { data: { fixtures: false } } });
  unmountPage = () => unmount(component);
  flushSync();
  await Promise.resolve();
  flushSync();
  const group = document.querySelector('[role=radiogroup][aria-label="Text size"]');
  expect(group, "the text size tiles are drawn").not.toBeNull();
  const tiles = [...(group?.querySelectorAll("[role=radio]") ?? [])];
  return {
    checked: tiles.filter((t) => t.getAttribute("aria-checked") === "true").map((t) => t.textContent),
    tabStops: tiles.filter((t) => t.getAttribute("tabindex") === "0").map((t) => t.textContent),
  };
}

describe("settings, phone layout: the text size tab stop starts on the applied step", () => {
  for (const applied of ["standard", "large", "extra-large"]) {
    it(`with ${applied} applied, the one tab stop is the ticked tile`, async () => {
      const tiles = await mountSettings(applied);
      expect(tiles.checked).toHaveLength(1);
      expect(tiles.tabStops).toEqual(tiles.checked);
    });
  }
});
