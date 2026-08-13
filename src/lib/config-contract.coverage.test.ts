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
  // CLI-invocation-only operational toggles (issue #296 slice 4,
  // src/cli/orbit.ts) — never written to .env-orbit, so out of the
  // deployment configuration contract entirely, mirroring the Bash
  // scripts' own non-contract operational env vars (e.g. restore.sh's
  // ORBIT_NONINTERACTIVE_RESTORE, configure.sh's ORBIT_CONFIGURE_PROMPTS).
  // ORBIT_RECOVERY_PROMPTS=machine switches orbit backup/restore/export-
  // recovery-bundle/import-recovery-bundle's passphrase/confirmation
  // prompts to the machine-readable line grammar (docs/engine-events.md,
  // "Machine prompts"); ORBIT_NONINTERACTIVE_RESTORE=true is required
  // alongside `orbit restore --yes` for unattended restore (guarantee #46).
  "ORBIT_RECOVERY_PROMPTS",
  "ORBIT_NONINTERACTIVE_RESTORE",
  // orbit configure's own machine-prompt/scripted-guided-init toggles
  // (issue #294, src/cli/orbit.ts / src/lib/configure-engine.ts), mirroring
  // configure.sh's own identically-named, identically-scoped environment
  // variables (configure.sh's guided_init dispatch): never written to
  // .env-orbit, so out of the deployment configuration contract entirely,
  // same reasoning as ORBIT_RECOVERY_PROMPTS above.
  "ORBIT_CONFIGURE_PROMPTS",
  "ORBIT_CONFIGURE_APP_URL",
  "ORBIT_CONFIGURE_OIDC_ISSUER",
  "ORBIT_CONFIGURE_OIDC_CLIENT_ID",
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
