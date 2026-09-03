import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * #735: the route-set contract for the Next.js -> SvelteKit API port.
 *
 * `src/app/` (the old Next.js routes) is slated for deletion once the port is
 * verified. Nothing enumerates the SvelteKit side against a fixed list, so a
 * route that gets missed, renamed or left as an empty stub during the port
 * would only surface once its caller broke in production -- and for the
 * routes below, "its caller" is not `web/`, so a scan of what the front end
 * fetches would not have caught it either:
 *
 *  - `/api/auth/callback` is called by the identity provider's redirect, not
 *    by any Orbit code.
 *  - `/api/health` is called by the Dockerfile HEALTHCHECK and the installer.
 *  - `/api/push/config` and `/api/push/subscriptions` are kept and carried
 *    across the cut on the owner's ruling (2026-09-03): nothing in v19 calls
 *    them yet (the subscribe control is #763), but the back end works and the
 *    routes are not to be dropped for being unreferenced today.
 *
 * EXPECTED_ROUTES is deliberately written out literally rather than derived
 * from any shared source, so a reviewer can read the intended surface
 * directly and a removed or renamed route fails loudly here instead of
 * silently shrinking the API.
 */

const routesRoot = new URL("../../web/src/routes/api/", import.meta.url).pathname;

const HANDLER_NAMES = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const EXPECTED_ROUTES = [
  "/api/admin/users",
  "/api/auth/callback",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/session",
  "/api/auth/sessions/revoke",
  "/api/documents/[documentId]/download",
  "/api/health",
  "/api/households/[householdId]/items/[itemId]/documents",
  "/api/households/[householdId]/join-requests",
  "/api/households/[householdId]/lifecycle",
  "/api/households/[householdId]/members",
  "/api/imap-inbox",
  "/api/imap-inbox/[receiptId]",
  "/api/join-requests",
  "/api/join-requests/[requestId]",
  "/api/push/config",
  "/api/push/subscriptions",
  "/api/reviewed-intake/approve",
  "/api/settings/mail-relay",
  "/api/settings/reminders",
  "/api/settings/tour",
  "/api/workspace",
  "/api/workspace/commands",
].sort();

// Walks web/src/routes/api recursively and returns every +server.js file,
// paired with the URL path SvelteKit's file-based router derives from its
// location ([param] directories included, +server.js stripped).
function collectServerFiles(dir, routePrefix = "/api") {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectServerFiles(entryPath, `${routePrefix}/${entry.name}`);
    }
    if (entry.name === "+server.js") {
      return [{ routePath: routePrefix, filePath: entryPath }];
    }
    return [];
  });
}

// Source-text scan rather than a dynamic import: these modules import
// SvelteKit runtime aliases ($env/dynamic/private, $lib/server/*) that only
// resolve inside a SvelteKit/vite context, not plain Vitest. A regex over the
// exported bindings is enough to prove a real handler is exported, without
// needing to execute the module.
function exportedHandlers(source) {
  return HANDLER_NAMES.filter((name) => {
    const asFunction = new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`);
    const asConst = new RegExp(`export\\s+const\\s+${name}\\s*=`);
    return asFunction.test(source) || asConst.test(source);
  });
}

const routeFiles = collectServerFiles(routesRoot);

describe("SvelteKit API route-set contract (#735)", () => {
  it("finds route files to check, so a misconfigured glob cannot silently empty this test", () => {
    expect(routeFiles.length).toBeGreaterThan(20);
  });

  it("has exactly the expected 24 route families -- no fewer, no more", () => {
    const actual = routeFiles.map((file) => file.routePath).sort();
    expect(actual).toEqual(EXPECTED_ROUTES);
  });

  it.each(routeFiles.map((file) => [file.routePath, file.filePath]))(
    "%s exports at least one HTTP handler",
    (routePath, filePath) => {
      const source = readFileSync(filePath, "utf8");
      const handlers = exportedHandlers(source);
      expect(
        handlers.length,
        `${routePath} (${filePath}) exports no GET/POST/PUT/PATCH/DELETE handler -- ` +
          `an empty or stub +server.js cannot satisfy the route-set contract.`,
      ).toBeGreaterThan(0);
    },
  );
});
