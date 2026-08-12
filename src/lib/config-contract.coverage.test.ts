import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ALLOWED_KEYS } from "./config-contract";

// Every environment key the application reads anywhere must be documented
// in the configuration contract (#292): an undocumented key is invisible
// configuration. Non-contract keys the platform or tooling own are listed
// explicitly, never silently.

const srcRoot = fileURLToPath(new URL("..", import.meta.url));

const PLATFORM_KEYS = new Set([
  // Node/Next platform and test-harness keys — not deployment configuration.
  "NODE_ENV",
  "NEXT_RUNTIME",
  "NEXT_PHASE",
  "NO_COLOR",
  "TERM",
  "CI",
  "ORBIT_TEST_COVERAGE",
  "PLAYWRIGHT_BASE_URL",
  "ORBIT_ACCEPTANCE_OIDC",
  "ORBIT_CAPTURE_PRODUCT_TOUR",
  "ORBIT_SKIP_E2E",
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\./.test(entry)) out.push(path);
  }
  return out;
}

function envKeysIn(content: string): Set<string> {
  const keys = new Set<string>();
  for (const match of content.matchAll(
    /(?:process\.env|environment)(?:\.([A-Z][A-Z0-9_]+)|\[["']([A-Z][A-Z0-9_]+)["']\])/g,
  )) {
    keys.add(match[1] ?? match[2]);
  }
  return keys;
}

describe("configuration contract coverage (#292)", () => {
  it("documents every environment key the application reads", () => {
    const undocumented: string[] = [];
    for (const file of sourceFiles(srcRoot)) {
      for (const key of envKeysIn(readFileSync(file, "utf8"))) {
        if (
          !(ALLOWED_KEYS as readonly string[]).includes(key) &&
          !(ALLOWED_KEYS as readonly string[]).includes(key.replace(/_FILE$/, "")) &&
          !PLATFORM_KEYS.has(key)
        ) {
          undocumented.push(`${file.replace(srcRoot, "src/")}: ${key}`);
        }
      }
    }
    expect(undocumented).toEqual([]);
  });
});
