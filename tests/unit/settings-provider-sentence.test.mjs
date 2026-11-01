// @vitest-environment happy-dom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * #1444 (moved from tests/e2e/settings-provider-sentence.spec.ts, #1612):
 * under "sign out of every device" settings adds that it "signs you out of
 * your sign-in provider in this browser only" -- true only when THIS session
 * came through the provider. A reader who signed in with a password on an
 * instance that also offers a provider has no provider token, and the sentence
 * would be wrong for them.
 *
 * The real settings page (desk and phone layouts, both drawn into the DOM and
 * switched by CSS) is compiled with Svelte's own compiler and mounted in
 * happy-dom, with the data layer answering what the server answers:
 *   - password session, provider offered: the base sentence, not the provider part;
 *   - provider session, provider offered: the provider part is shown;
 *   - provider session on an instance that no longer offers a provider: not shown.
 * Every "not shown" check is paired with the base sentence being drawn, so it
 * cannot pass on a page that has not drawn.
 */

const answers = vi.hoisted(() => ({
  sessions: /** @type {unknown[]} */ ([]),
  oidc: true,
}));

const never = () => new Promise(() => {});
vi.mock("$lib/data/workspace.js", () => ({
  readAuthMethodsOffered: async () => ({ oidc: answers.oidc, secondFactor: true }),
  readSentLately: async () => [],
  readSessions: async () => answers.sessions,
  readSettingsScreen: async () => ({
    user: { id: "u1", displayName: "Reader", email: "reader@example.test" },
    household: null,
    primary: null,
    memberships: [],
    relay: { status: "unavailable" },
    waiting: 0,
    reminders: { emailEnabled: false },
  }),
  readSignInMethods: async () => ({ local: { set: true }, identities: [] }),
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
    /* The site chrome and the bottom sheet have no part in the sentence: a component that draws nothing. */
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

/* The cold compile of the page and everything it reaches is paid here, not inside a
   test's 5s: a full run spawns a worker per file and the host is busy. */
const COLD_COMPILE_TIMEOUT_MS = 60_000;
/** @type {string} */
let pageModule;
beforeAll(async () => {
  mkdirSync(resolve(import.meta.dirname, "../../tmp"), { recursive: true });
  outDir = mkdtempSync(resolve(import.meta.dirname, "../../tmp/settings-provider-sentence-"));
  pageModule = await build(join(web, "src/routes/settings/+page.svelte"));
  await import(/* @vite-ignore */ pageModule);
}, COLD_COMPILE_TIMEOUT_MS);
afterAll(() => { rmSync(outDir, { recursive: true, force: true }); });

/** @type {(() => void) | null} */
let unmountPage = null;
afterEach(() => { unmountPage?.(); unmountPage = null; document.body.innerHTML = ""; });

const BASE_SENTENCE = /signs Orbit out everywhere/iu;
const PROVIDER_SENTENCE = /sign-in provider in this browser only/iu;

/**
 * Mounts settings with the server answering the given sessions and offered
 * methods, and returns the text of both layouts' "what this does" lines.
 *
 * @param {{ sessions: unknown[], oidc: boolean }} given
 */
async function mountSettings(given) {
  answers.sessions = given.sessions;
  answers.oidc = given.oidc;
  const { mount, unmount, flushSync } = await import(pathToFileURL(join(svelteSrc, "index-client.js")).href);
  const { default: Settings } = await import(/* @vite-ignore */ pageModule);
  const component = mount(Settings, { target: document.body, props: { data: { fixtures: false } } });
  unmountPage = () => unmount(component);
  for (let turn = 0; turn < 20; turn += 1) {
    flushSync();
    await new Promise((done) => setTimeout(done, 0));
  }
  flushSync();
  return {
    desk: document.querySelector(".everywhere-says")?.textContent ?? null,
    phone: document.querySelector(".st-everywhere")?.textContent ?? null,
  };
}

const row = (/** @type {string} */ id, /** @type {boolean} */ current, /** @type {boolean} */ viaProvider) =>
  ({ id, current, viaProvider, device: current ? "Firefox on Linux" : "Safari on iPhone", lastSeenAt: null });

describe("settings: the provider sentence (#1444)", () => {
  it("a password session on a provider-enabled instance is not told the provider signs it out", async () => {
    const lines = await mountSettings({ sessions: [row("s1", true, false), row("s2", false, true)], oidc: true });
    for (const [layout, text] of Object.entries(lines)) {
      expect(text, `${layout}: the base sentence is missing`).toMatch(BASE_SENTENCE);
      expect(text, `${layout}: a password session is told the provider will sign it out`).not.toMatch(PROVIDER_SENTENCE);
    }
  });

  it("a provider session is told the provider signs it out too, on both layouts", async () => {
    const lines = await mountSettings({ sessions: [row("s1", true, true)], oidc: true });
    for (const [layout, text] of Object.entries(lines)) {
      expect(text, `${layout}: the base sentence is missing`).toMatch(BASE_SENTENCE);
      expect(text, `${layout}: a provider session is not told the provider signs it out`).toMatch(PROVIDER_SENTENCE);
    }
  });

  it("a provider session on an instance that no longer offers a provider is not told it", async () => {
    const lines = await mountSettings({ sessions: [row("s1", true, true)], oidc: false });
    for (const [layout, text] of Object.entries(lines)) {
      expect(text, `${layout}: the base sentence is missing`).toMatch(BASE_SENTENCE);
      expect(text, `${layout}: told of a provider the instance does not offer`).not.toMatch(PROVIDER_SENTENCE);
    }
  });
});
