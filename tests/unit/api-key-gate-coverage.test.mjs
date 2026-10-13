import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * #1405: no route can be added that forgets the encryption-key gate.
 *
 * The gate lives in the `api()` wrapper (web/src/lib/server/api.js, which
 * `read()` and `write()` build on), so a route is covered by being built with
 * one of the three. This is the same idea as ADR-0013's exact file list, not a
 * pattern: every route file either uses the wrapper or is named here, and the
 * ones named here each carry their own reason and, where they can start a
 * session or touch the encrypted data, their own call to `assertKeyUsable()`.
 *
 *  - /api/health is the healthcheck: 200 `maintenance` while locked, by design.
 *  - /api/auth/availability is what the door reads to learn the instance is locked.
 *  - /api/auth/callback is the identity provider's return, not wrapped (it
 *    answers with redirects, and a thrown error would become a JSON body), so
 *    it calls the gate itself, first.
 *  - /api/settings/mail-relay/verify is a link in a mail, also not wrapped for
 *    the same redirect reason; it reads a session and the encrypted sender
 *    addresses, so it calls the gate itself too.
 *
 * `openWhileKeyUnusable` names the one route that stays open for a member to
 * leave: sign-out. It appears nowhere else.
 */

const routesRoot = new URL("../../web/src/routes/api/", import.meta.url).pathname;

function routeFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === "+server.js" ? [path] : [];
  });
}

const routes = routeFiles(routesRoot).map((file) => ({
  name: relative(routesRoot, file).replace(/\/\+server\.js$/, ""),
  source: readFileSync(file, "utf8"),
}));

const usesWrapper = (source) =>
  /import\s*\{[^}]*\b(?:api|read|write)\b[^}]*\}\s*from\s*["']\$lib\/server\/api\.js["']/u.test(source);

const NOT_WRAPPED = ["auth/availability", "auth/callback", "health", "settings/mail-relay/verify"];
const CALLS_THE_GATE_ITSELF = ["auth/callback", "settings/mail-relay/verify"];

describe("every API route is behind the encryption-key gate (#1405)", () => {
  it("finds the routes", () => {
    expect(routes.length).toBeGreaterThan(50);
  });

  it("uses the api wrapper in every route but exactly the four named", () => {
    const unwrapped = routes.filter((route) => !usesWrapper(route.source)).map((route) => route.name).sort();
    expect(unwrapped).toEqual(NOT_WRAPPED);
  });

  it.each(CALLS_THE_GATE_ITSELF)("calls assertKeyUsable() itself in %s", (name) => {
    const route = routes.find((candidate) => candidate.name === name);
    expect(route, `${name} is not a route`).toBeDefined();
    expect(route.source).toMatch(/\bassertKeyUsable\s*\(/u);
    expect(route.source).toMatch(/from\s*["']orbit\/server\/key-state["']/u);
  });

  it("lets the callback's gate failure land on the error screen, inside its own try", () => {
    const callback = routes.find((route) => route.name === "auth/callback");
    const tryAt = callback.source.indexOf("try {");
    const gateAt = callback.source.search(/\bassertKeyUsable\s*\(/u);
    expect(tryAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(tryAt);
  });

  it("names openWhileKeyUnusable in exactly one route: sign-out", () => {
    const using = routes.filter((route) => route.source.includes("openWhileKeyUnusable")).map((route) => route.name);
    expect(using).toEqual(["auth/logout"]);
  });

  it("has the wrapper itself open the gate", () => {
    const wrapper = readFileSync(new URL("../../web/src/lib/server/api.js", import.meta.url), "utf8");
    expect(wrapper).toMatch(/\bassertKeyUsable\s*\(/u);
    expect(wrapper).toContain("openWhileKeyUnusable");
    expect(wrapper).toMatch(/from\s*["']orbit\/server\/key-state["']/u);
  });
});
