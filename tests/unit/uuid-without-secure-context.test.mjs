// @vitest-environment happy-dom
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { createPageLoader, settle } from "../support/svelte-page.mjs";
import { readHome } from "../../web/src/lib/data/workspace.js";
import { SESSION_FIXTURE, WORKSPACE_FIXTURE, WORKSPACE_FIXTURE_TODAY } from "../../web/src/lib/data/fixtures/workspace.js";
import { INBOX_FIXTURE } from "../../web/src/lib/data/fixtures/inbox.js";

/*
 * #1623: over plain http on a LAN address browsers do not offer
 * crypto.randomUUID (secure origins only), so a class field initialiser threw
 * during hydration and /home rendered blank. One helper, web/src/lib/uuid.js
 * exporting `uuid`, uses randomUUID when present and otherwise builds an
 * RFC 4122 version 4 UUID from crypto.getRandomValues; every web/src use goes
 * through it.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const SRC = join(ROOT, "web/src");
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HELPER = "web/src/lib/uuid.js";
const HELPER_URL = pathToFileURL(join(ROOT, HELPER)).href;

afterEach(() => vi.unstubAllGlobals());

/** crypto as a non-secure origin has it: getRandomValues, no randomUUID. */
const realCrypto = globalThis.crypto;
function insecureCrypto() {
  /* The real crypto, captured before the stub replaces the global: reading
     globalThis.crypto here would call the stub itself, without end. */
  return { getRandomValues: (/** @type {any} */ a) => realCrypto.getRandomValues(a) };
}

describe("#1623: the uuid helper", () => {
  it("returns a valid version 4 UUID when crypto.randomUUID is absent, distinct each call", async () => {
    vi.stubGlobal("crypto", insecureCrypto());
    const { uuid } = await import(/* @vite-ignore */ HELPER_URL);
    const seen = new Set();
    for (let i = 0; i < 500; i++) {
      const id = uuid();
      expect(id).toMatch(V4);
      seen.add(id);
    }
    expect(seen.size).toBe(500);
  });

  it("uses crypto.randomUUID when the browser offers it", async () => {
    const randomUUID = vi.fn(() => "11111111-2222-4333-8444-555555555555");
    vi.stubGlobal("crypto", { ...insecureCrypto(), randomUUID });
    const { uuid } = await import(/* @vite-ignore */ HELPER_URL);
    expect(uuid()).toBe("11111111-2222-4333-8444-555555555555");
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });
});

function walk(/** @type {string} */ dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(js|ts|svelte)$/u.test(entry.name)) out.push(full);
  }
  return out;
}

describe("#1623: nothing in web/src calls crypto.randomUUID directly", () => {
  it("only the helper does", () => {
    const found = [];
    for (const file of walk(SRC)) {
      if (relative(ROOT, file) === HELPER) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, at) => {
        if (/\brandomUUID\b/u.test(line)) found.push(`${relative(ROOT, file)}:${at + 1}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });
});

const page = createPageLoader("uuid-without-secure-context");
const json = (/** @type {unknown} */ body) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const relay = async (/** @type {string} */ href) => {
  const path = new URL(href, "http://localhost").pathname;
  if (path === "/api/workspace") return json({ workspace: WORKSPACE_FIXTURE, fixtureToday: WORKSPACE_FIXTURE_TODAY });
  if (path === "/api/auth/session") return json(SESSION_FIXTURE);
  if (path === "/api/imap-inbox") return json(INBOX_FIXTURE);
  return json({});
};

afterEach(() => page.unmount());
afterAll(() => page.teardown());

/*
 * home/+page.svelte itself cannot be mounted in a unit test (its plain .js
 * imports reach $app/state, which nothing here resolves), so the home surface
 * is the one tests/unit/home-suggestion-drawer.test.mjs mounts: the corridor
 * with its drawer over the real data layer. Removing randomUUID must leave the
 * sky's corridor drawn and a suggestion's drawer openable.
 */
describe("#1623: /home on a non-secure origin", () => {
  it("draws the corridor and opens a suggestion's drawer with crypto.randomUUID removed", async () => {
    vi.stubEnv("ORBIT_FIXTURES", "1");
    vi.stubGlobal("fetch", vi.fn(relay));
    vi.stubGlobal("crypto", insecureCrypto());
    const first = await readHome();
    const { target, flushSync } = await page.mount(`${import.meta.dirname}/support/SuggestionDrawerHost.svelte`, { first });
    await settle();
    const row = /** @type {HTMLElement | null} */ (target.querySelector("a.item.suggest, div.item.suggest"));
    expect(row, "the corridor draws the suggestion row").not.toBeNull();
    row?.click();
    flushSync();
    await settle();
    expect(target.querySelector('[id="r-insurance-view"]'), "the drawer opens").not.toBeNull();
    vi.unstubAllEnvs();
  });
});
