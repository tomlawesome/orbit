import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * ADR-0013 decisions 2 and 3: every API route file calls the maintenance
 * guard first, and exemption is membership of this exact file set — no
 * pattern, no prefix, no URL comparison anywhere in the mechanism. This test
 * is the enforcement: a new route file that neither invokes the guard nor
 * appears here fails the suite, so new routes are guarded by default.
 */
const EXEMPT_ROUTE_FILES = [
  "api/health/route.ts", // orchestrators must keep probing (decision 6)
  "api/auth/login/route.ts", // an administrator must be able to begin sign-in
  "api/auth/callback/route.ts", // and complete it
  "api/auth/session/route.ts", // identity and the CSRF token before routing
  "api/auth/logout/route.ts", // anyone may end a session cleanly
];

const API_ROOT = join(process.cwd(), "src/app/api");

function routeFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...routeFiles(path));
    else if (entry.name === "route.ts") found.push(path);
  }
  return found;
}

function apiRelative(path: string): string {
  return join("api", path.slice(API_ROOT.length + 1)).split("\\").join("/");
}

const HANDLER_PATTERN = /export\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
const GUARD_CALL_PATTERN = /await\s+assertOutsideMaintenance\(/g;
const GUARD_IMPORT_PATTERN = /import\s*\{[^}]*\bassertOutsideMaintenance\b[^}]*\}\s*from\s*"@\/server\/maintenance"/;

describe("maintenance route contract (#523)", () => {
  const files = routeFiles(API_ROOT);
  const relativePaths = files.map(apiRelative);

  it("finds the API surface at all", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it("keeps the exemption set exact: every exempt file exists, nothing is exempted twice", () => {
    expect(new Set(EXEMPT_ROUTE_FILES).size).toBe(EXEMPT_ROUTE_FILES.length);
    for (const exempt of EXEMPT_ROUTE_FILES) {
      expect(relativePaths).toContain(exempt);
    }
  });

  it("every non-exempt route file awaits the guard in each of its handlers", () => {
    const unguarded: string[] = [];
    for (const file of files) {
      const relativePath = apiRelative(file);
      if (EXEMPT_ROUTE_FILES.includes(relativePath)) continue;

      const source = readFileSync(file, "utf8");
      const handlers = source.match(HANDLER_PATTERN) ?? [];
      const guardCalls = source.match(GUARD_CALL_PATTERN) ?? [];

      // A route file this test cannot see handlers in is a contract change:
      // extend HANDLER_PATTERN rather than letting the file slip through.
      if (handlers.length === 0) {
        unguarded.push(`${relativePath} (no recognisable handler exports)`);
        continue;
      }
      if (!GUARD_IMPORT_PATTERN.test(source) || guardCalls.length < handlers.length) {
        unguarded.push(`${relativePath} (${guardCalls.length} guard calls for ${handlers.length} handlers)`);
      }
    }
    expect(unguarded, `Route files missing the maintenance guard:\n${unguarded.join("\n")}`).toEqual([]);
  });

  it("exempt route files never import the guard, so the set stays honest", () => {
    for (const exempt of EXEMPT_ROUTE_FILES) {
      const source = readFileSync(join(API_ROOT, exempt.slice("api/".length)), "utf8");
      expect(GUARD_IMPORT_PATTERN.test(source), `${exempt} should not import the guard`).toBe(false);
    }
  });
});
