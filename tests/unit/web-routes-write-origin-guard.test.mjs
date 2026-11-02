import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * #1565: every write route holds the same-origin check itself.
 *
 * SvelteKit 3 / adapter-node 6 no longer take ORIGIN, so Orbit's start-up shim
 * (scripts/web-server.mjs) feeds kit the origin the app was configured with.
 * Kit's own CSRF check stays on, but it is a second line: the first is Orbit's,
 * `assertSameOrigin` (orbit/lib/auth/session), and the shim's whole claim is
 * that kit's origin and `assertSameOrigin`'s are now the same one. That claim
 * is only worth making while no write route can skip Orbit's check. So every
 * `POST`, `PUT`, `PATCH` or `DELETE` export under web/src/routes/**\/+server.*
 * is either
 *  - built with `write()` from `$lib/server/api.js`, whose body calls
 *    `assertCsrf` and so `assertSameOrigin`, or
 *  - an `api()` handler that calls `assertSameOrigin(` itself (sign-in and
 *    sign-out, which have no session to check a token against).
 * Anything else, or any export shape this test cannot read, fails: the test
 * does not guess.
 *
 * A guard, not a new rule: it is expected to pass on the code as it stands. It
 * reads real code, not a string: comments and string literals are stripped
 * first, so a comment that says "assertSameOrigin" or "write(" satisfies
 * nothing.
 */

const routesRoot = new URL("../../web/src/routes/", import.meta.url).pathname;
const apiModule = new URL("../../web/src/lib/server/api.js", import.meta.url).pathname;

const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

function serverFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return serverFiles(path);
    return /^\+server\.[cm]?[jt]s$/u.test(entry.name) ? [path] : [];
  });
}

/** The source with comments and the contents of string and template literals blanked, same length. */
function codeOnly(source) {
  let out = "";
  let i = 0;
  const blank = (text) => text.replace(/[^\n]/gu, " ");
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      out += blank(source.slice(i, stop));
      i = stop;
    } else if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += blank(source.slice(i, stop));
      i = stop;
    } else if (source[i] === '"' || source[i] === "'" || source[i] === "`") {
      const quote = source[i];
      let j = i + 1;
      while (j < source.length && source[j] !== quote) j += source[j] === "\\" ? 2 : 1;
      out += quote + blank(source.slice(i + 1, j)) + quote;
      i = j + 1;
    } else {
      out += source[i];
      i += 1;
    }
  }
  return out;
}

/** Every import of `name`, as the module specifier it comes from. */
function importSource(code, rawSource, name) {
  const pattern = /import\s*\{([^}]*)\}\s*from\s*(["'])([^"']*)\2/gu;
  for (const match of rawSource.matchAll(pattern)) {
    // Skip imports that sit inside a comment: the matching offset must be code.
    if (code.slice(match.index, match.index + 6) !== "import") continue;
    const names = match[1].split(",").map((part) => part.trim().split(/\s+as\s+/u).pop());
    if (names.includes(name)) return match[3];
  }
  return undefined;
}

/** The text of each top-level `export` statement, keyed by what it exports. */
function writeExports(code) {
  const starts = [...code.matchAll(/^export\b/gmu)].map((match) => match.index);
  const found = [];
  const unreadable = [];
  starts.forEach((start, index) => {
    const text = code.slice(start, starts[index + 1] ?? code.length);
    const declared = /^export\s+(?:async\s+)?(?:const|let|var|function\*?)\s+([A-Za-z_$][\w$]*)/u.exec(text);
    if (declared) {
      if (WRITE_METHODS.includes(declared[1])) found.push({ method: declared[1], text });
      return;
    }
    const listed = /^export\s*\{([^}]*)\}/u.exec(text);
    if (listed) {
      const names = listed[1].split(",").map((part) => part.trim().split(/\s+as\s+/u).pop());
      for (const name of names) if (WRITE_METHODS.includes(name)) unreadable.push(`${name} exported through an export list`);
      return;
    }
    if (/^export\s*\*/u.test(text) || /^export\s+default\b/u.test(text)) {
      if (/^export\s*\*/u.test(text)) unreadable.push("a re-export (export * from)");
      return;
    }
    unreadable.push(`an export this test cannot read: ${text.slice(0, 40)}`);
  });
  return { found, unreadable };
}

const routes = serverFiles(routesRoot).map((file) => {
  const raw = readFileSync(file, "utf8");
  const code = codeOnly(raw);
  return { name: relative(routesRoot, file), raw, code, ...writeExports(code) };
});

const withWrites = routes.filter((route) => route.found.length > 0 || route.unreadable.length > 0);

describe("every write route holds the same-origin check (#1565)", () => {
  it("finds the routes, and write handlers among them", () => {
    expect(routes.length).toBeGreaterThan(50);
    expect(withWrites.length).toBeGreaterThan(40);
  });

  it("reads every write export in a shape it understands", () => {
    expect(withWrites.flatMap((route) => route.unreadable.map((why) => `${route.name}: ${why}`))).toEqual([]);
  });

  it("has write() itself reach assertSameOrigin through assertCsrf", () => {
    const code = codeOnly(readFileSync(apiModule, "utf8"));
    const writer = /export function write\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/u.exec(code);
    expect(writer, "web/src/lib/server/api.js no longer defines write()").not.toBeNull();
    expect(writer[1]).toMatch(/\bassertCsrf\s*\(/u);
    expect(importSource(code, readFileSync(apiModule, "utf8"), "assertCsrf")).toBe("orbit/lib/auth/session");
    /* ...and assertCsrf is the one that runs the origin check first. */
    const session = codeOnly(readFileSync(new URL("../../src/lib/auth/session.ts", import.meta.url), "utf8"));
    const csrf = /export function assertCsrf\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\}/u.exec(session);
    expect(csrf, "src/lib/auth/session.ts no longer defines assertCsrf()").not.toBeNull();
    expect(csrf[1]).toMatch(/\bassertSameOrigin\s*\(/u);
  });

  it.each(withWrites.map((route) => [route.name, route]))("%s", (_name, route) => {
    const failures = [];
    for (const { method, text } of route.found) {
      const viaWrite =
        /=\s*write\s*\(/u.test(text) && importSource(route.code, route.raw, "write") === "$lib/server/api.js";
      const viaOwnCheck =
        /=\s*api\s*\(/u.test(text) &&
        importSource(route.code, route.raw, "api") === "$lib/server/api.js" &&
        /\bassertSameOrigin\s*\(/u.test(text) &&
        importSource(route.code, route.raw, "assertSameOrigin") === "orbit/lib/auth/session";
      if (!viaWrite && !viaOwnCheck) failures.push(method);
    }
    expect(failures, `${route.name}: ${failures.join(", ")} neither go through write() nor call assertSameOrigin`).toEqual([]);
  });
});
