import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

/*
 * #1411 (owner answer 5a, 2026-10-14): the pages' Content-Security-Policy is
 * SvelteKit's own `kit.csp`, set in web/vite.config.js, in mode "auto": a nonce
 * in a header for the server-rendered pages, hashes in a <meta> tag for the
 * prerendered ones (/login, /logout, /auth/error). The standard pattern is the
 * OWASP CSP Cheat Sheet's strict policy.
 *
 * What is pinned here, from the issue's specification alone:
 *   - the directives, exactly: no more, no fewer, and no 'unsafe-inline' or
 *     'unsafe-eval' in script-src (styles keep 'unsafe-inline': about 140
 *     style= attributes, 80 style: directives, and markup built in JS);
 *   - mode "auto";
 *   - web/src/app.html's pre-paint script carries NO nonce placeholder: kit 3
 *     refuses to prerender a page whose app.html has %sveltekit.nonce% in it
 *     (render.js:77-79), and /login would fail to build. Its sha256 is in
 *     script-src instead, which covers it on server-rendered and prerendered
 *     pages alike, and it is the sha256 of THE SCRIPT'S TEXT IN app.html, so an
 *     edit to the script can never leave a stale hash behind.
 *
 * How the config is read: web/vite.config.js is imported for real, with
 * `sveltekit` from "@sveltejs/kit/vite" replaced by a recorder, because the
 * options are handed to that plugin and nothing else exposes them. (The mock
 * names kit's vite entry by its path under web/node_modules, which is where the
 * config resolves it from; the root has no copy.) However the
 * config builds its `csp` (inline, a constant, a helper), this sees the value
 * the plugin would have been given. kit writes a keyword source without its
 * quotes ('self' is `self`) and quotes it itself; a quoted spelling is read
 * the same, so the two are not told apart here.
 */
const here = dirname(fileURLToPath(import.meta.url));
const APP_HTML = resolve(here, "../../web/src/app.html");
const COLD_IMPORT_TIMEOUT_MS = 60_000;

/** @type {Array<Record<string, any>>} */
const recorded = vi.hoisted(() => []);

vi.mock("../../web/node_modules/@sveltejs/kit/src/exports/vite/index.js", () => ({
  sveltekit: (/** @type {Record<string, any>} */ options) => {
    recorded.push(options);
    return [];
  },
}));

/** @param {unknown} source */
const unquoted = (source) => String(source).replace(/^'(.*)'$/u, "$1");

/** @param {unknown} sources */
const tokens = (sources) => (Array.isArray(sources) ? sources.map(unquoted).sort() : []);

/** The inline scripts of app.html: `<script>` elements with no src, and their exact text. */
function inlineScripts() {
  const html = readFileSync(APP_HTML, "utf8");
  const found = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu)) {
    if (!/\bsrc\s*=/u.test(match[1])) found.push({ attributes: match[1], text: match[2] });
  }
  return found;
}

const sha256Source = (/** @type {string} */ text) => `sha256-${createHash("sha256").update(text, "utf8").digest("base64")}`;

describe("the page Content-Security-Policy in web/vite.config.js (#1411)", () => {
  /** @type {Record<string, any>} */
  let csp;

  beforeAll(async () => {
    await import("../../web/vite.config.js");
    expect(recorded, "vite.config.js calls sveltekit() once").toHaveLength(1);
    csp = recorded[0].csp;
  }, COLD_IMPORT_TIMEOUT_MS);

  it("sets kit.csp, in mode auto: a nonce for server-rendered pages, hashes for prerendered ones", () => {
    expect(csp, "sveltekit({ csp }) is not configured").toBeTypeOf("object");
    expect(csp.mode).toBe("auto");
  });

  it("sends exactly the OWASP strict directives, and nothing else", () => {
    const directives = csp?.directives ?? {};
    const { "script-src": scriptSrc, ...others } = directives;
    expect(Object.keys(directives).sort()).toEqual(
      [
        "base-uri",
        "connect-src",
        "default-src",
        "font-src",
        "form-action",
        "frame-ancestors",
        "frame-src",
        "img-src",
        "manifest-src",
        "object-src",
        "script-src",
        "style-src",
        "worker-src",
      ],
    );
    expect(Object.fromEntries(Object.entries(others).map(([name, sources]) => [name, tokens(sources)]))).toEqual({
      "default-src": ["self"],
      "style-src": ["self", "unsafe-inline"].sort(),
      "img-src": ["blob:", "data:", "self"],
      "font-src": ["data:", "self"],
      "connect-src": ["self"],
      "worker-src": ["self"],
      "manifest-src": ["self"],
      "frame-src": ["none"],
      "object-src": ["none"],
      "base-uri": ["self"],
      "form-action": ["self"],
      "frame-ancestors": ["none"],
    });
    expect(scriptSrc, "script-src is not configured").toBeDefined();
  });

  it("script-src is 'self' and the pre-paint script's hash: no 'unsafe-inline', no 'unsafe-eval'", () => {
    const sources = tokens(csp?.directives?.["script-src"]);
    expect(sources).toEqual(expect.arrayContaining(["self"]));
    expect(sources).not.toContain("unsafe-inline");
    expect(sources).not.toContain("unsafe-eval");
    expect(sources.filter((source) => source !== "self")).toHaveLength(1);
  });

  it("app.html has exactly one inline script, and it carries no nonce placeholder (kit 3 refuses to prerender one)", () => {
    const scripts = inlineScripts();
    expect(scripts).toHaveLength(1);
    expect(scripts[0].attributes).not.toMatch(/nonce/u);
    expect(readFileSync(APP_HTML, "utf8")).not.toContain("%sveltekit.nonce%");
  });

  it("the configured hash is the sha256 of the pre-paint script's own text in app.html", () => {
    const [{ text }] = inlineScripts();
    expect(text.trim().length, "the script text is not empty").toBeGreaterThan(0);
    const hashes = tokens(csp?.directives?.["script-src"]).filter((source) => /^sha\d{3}-/u.test(source));
    expect(hashes).toEqual([sha256Source(text)]);
  });
});
