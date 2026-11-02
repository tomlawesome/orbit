import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";
import { clientOutputFault, serverOutputFault, serverParseError } from "./check-svelte-server-parse.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

describe("serverParseError (#1138)", () => {
  // svelte 5.57.1 fixed #1138 upstream: the sources that used to compile to
  // unparseable output now give no error.
  it("passes a JSDoc-typed arrow parameter in the script", () => {
    expect(serverParseError("<script>const f = (/** @type {string} */ t) => t;</script>")).toBeNull();
  });

  it("passes one inside a nested function", () => {
    // Fixed upstream in svelte 5.57.1, like the top-level case above.
    expect(serverParseError("<script>function g(a) { return a.map((/** @type {string} */ p) => p); }</script>")).toBeNull();
  });

  it("passes the same function typed on its variable", () => {
    expect(serverParseError("<script>/** @type {(t: string) => string} */\nconst f = (t) => t;</script>")).toBeNull();
  });

  it("passes the cast idiom the codebase uses", () => {
    expect(serverParseError("<script>let e = null; const m = /** @type {{ message?: string }} */ (e)?.message;</script>")).toBeNull();
  });
});

/*
 * #1267: Svelte used to rewrite a typed `$props()` line that ended a component's
 * script, in the client output, as `var /** @type {T} *\/ (p) = root();`, which
 * is not JavaScript. The server output was clean, so the #1138 check alone let
 * it through. Svelte 5.57.3 fixed it (it now emits `var /** @type {T} *\/ p =
 * root();`), so no fixture reproduces it and these pass; the check stays as a
 * guard against a regression, and clientOutputFault below tests the shape. These run the real script (its API is the command line) against
 * a scratch repository whose web/src holds one fixture component, so they say
 * what a person running the check sees: the exit code and the file named.
 */
const realScript = join(dirname(fileURLToPath(import.meta.url)), "check-svelte-server-parse.mjs");
const realRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = [];
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop(), { recursive: true, force: true });
});

function checkFixtures(files) {
  const root = mkdtempSync(join(tmpdir(), "svelte-client-parse-"));
  scratch.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "web/src/lib"), { recursive: true });
  copyFileSync(realScript, join(root, "scripts/check-svelte-server-parse.mjs"));
  // The script finds svelte and esbuild through web/node_modules, then the root's.
  symlinkSync(join(realRoot, "web/node_modules"), join(root, "web/node_modules"));
  symlinkSync(join(realRoot, "node_modules"), join(root, "node_modules"));
  for (const [name, source] of Object.entries(files)) writeFileSync(join(root, "web/src/lib", name), source);
  return failOnProcessDeadline(
    spawnSync("node", [join(root, "scripts/check-svelte-server-parse.mjs")], { ...processGuard(), encoding: "utf8" }),
    { label: "check-svelte-server-parse.mjs" },
  );
}

describe("the client output check (#1267)", () => {
  it("passes a typed $props() line that ends the script, and does not name the file", () => {
    // fixed upstream in svelte 5.57.3; the shape is still caught by clientOutputFault/serverOutputFault below
    const r = checkFixtures({
      "EndsWithProps.svelte": "<script>/** @type {{a:string}} */ let { a } = $props();</script><p>{a}</p>",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain("EndsWithProps.svelte");
  });

  it("names no component when a typed $props() line ends one and others are fine", () => {
    // fixed upstream in svelte 5.57.3; the shape is still caught by clientOutputFault/serverOutputFault below
    const r = checkFixtures({
      "EndsWithProps.svelte": "<script>/** @type {{a:string}} */ let { a } = $props();</script><p>{a}</p>",
      "Fine.svelte": "<script>/** @type {{a:string}} */ let { a } = $props();\nlet b = 1;</script><p>{a}{b}</p>",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain("EndsWithProps.svelte");
    expect(r.stderr).not.toContain("Fine.svelte");
  });

  it("passes the same component with a statement after the $props() line", () => {
    const r = checkFixtures({
      "Fine.svelte": "<script>/** @type {{a:string}} */ let { a } = $props();\nlet b = 1;</script><p>{a}{b}</p>",
    });
    expect(r.status, r.stderr).toBe(0);
  });

  it("passes the arrow-parameter shape of #1138 where it already passes the server check", () => {
    // The shape web/src/lib/Chrome.svelte uses, inside $effect: the server
    // output drops the comment, the client output keeps `(/** @type {Event} */ (event)) =>`.
    // That is a parenthesised parameter, but it is not the `var /** ... */ (` binding.
    const r = checkFixtures({
      "ArrowParameter.svelte":
        '<script>let open = $state(false); $effect(() => { const close = (/** @type {Event} */ event) => { open = !!event; }; addEventListener("click", close); });</script><p>{open}</p>',
    });
    expect(r.status, r.stderr).toBe(0);
  });

  it("passes the #1138 arrow-parameter component and does not name the file", () => {
    // fixed upstream in svelte 5.57.3; the shape is still caught by clientOutputFault/serverOutputFault below
    const r = checkFixtures({
      "ServerBug.svelte": "<script>const f = (/** @type {string} */ t) => t;</script><p>{f('x')}</p>",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain("ServerBug.svelte");
  });

  it("passes every component in web/src today", () => {
    const r = failOnProcessDeadline(
      spawnSync("node", [realScript], { ...processGuard(), encoding: "utf8" }),
      { label: "check-svelte-server-parse.mjs over web/src" },
    );
    expect(r.status, r.stderr).toBe(0);
  });
});

describe("clientOutputFault and serverOutputFault (compiled JS text)", () => {
  it("flags the pre-fix svelte output, a JSDoc-typed binding wrapped in parentheses", () => {
    expect(clientOutputFault("var /** @type {{a:string}} */ (p) = root();")).toContain(
      "a JSDoc-typed binding wrapped in parentheses",
    );
  });

  it("flags the same shape when the comment spans several lines", () => {
    expect(clientOutputFault("var /**\n * @type {{a:string}}\n */ (p) = root();")).toContain(
      "a JSDoc-typed binding wrapped in parentheses",
    );
  });

  it("passes the output svelte 5.57.3 emits", () => {
    expect(clientOutputFault("var /** @type {{a:string}} */ p = root();")).toBeNull();
  });

  it("passes the cast idiom, which is not a var binding", () => {
    expect(clientOutputFault("const m = /** @type {X} */ (e)?.message;")).toBeNull();
  });

  it("passes a parenthesised arrow parameter", () => {
    expect(clientOutputFault("addEventListener('click', (/** @type {Event} */ (event)) => event);")).toBeNull();
  });

  it("serverOutputFault returns null for valid module code", () => {
    expect(serverOutputFault("export const f = (t) => t;\nexport default f;")).toBeNull();
  });

  it("serverOutputFault names the parse error and the compiled line for code that does not parse", () => {
    // esbuild rejects the pre-fix #1138 server shape ("Invalid binding pattern"), so use it as is.
    expect(serverOutputFault("const ok = 1;\nconst f = (/** @type {string} */ (t)) => t;")).toMatch(/compiled line \d+/);
  });

  it("serverOutputFault also reports a plainly invalid line", () => {
    expect(serverOutputFault("let { a } = ;")).toMatch(/compiled line \d+/);
  });
});
