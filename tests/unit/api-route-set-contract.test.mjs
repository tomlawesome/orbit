import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * #735: the route-set contract for the Next.js -> SvelteKit API port.
 *
 * `src/app/` (the old Next.js routes) is gone (merge 2de45bc, ADR-0018).
 * Nothing else enumerates the SvelteKit side against a fixed list, so a
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
 * The list is all 46 families, not the 24 ported first. ADR-0012's amendment
 * was clarified by the owner on 2026-09-03: the cut keeps what the new front
 * end NEEDS, not what it currently calls, and a working back end whose screen
 * is merely undrawn is needed -- #410 defers sixteen such surfaces to M9
 * because they are wanted. Only Next- and React-specific code goes.
 * `/api/documents/[documentId]/preview` is the case that exposed it: the item
 * screen says in a comment that the endpoint exists and that it deliberately
 * does not call it yet.
 *
 * EXPECTED_ROUTES is deliberately written out literally rather than derived
 * from any shared source, so a reviewer can read the intended surface
 * directly and a removed or renamed route fails loudly here instead of
 * silently shrinking the API.
 */

const routesRoot = new URL("../../web/src/routes/api/", import.meta.url).pathname;

const HANDLER_NAMES = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const EXPECTED_ROUTES = [
  // What this Orbit runs on, for the About page (#1256): any signed-in member.
  "/api/about",
  "/api/admin/contact",
  "/api/admin/documents/health",
  // Whether a document-KEK rotation is open and since when (#956).
  "/api/admin/documents/rotation",
  // The real Operations panel rows and build stamp (#1000).
  "/api/admin/health",
  "/api/admin/mailbox",
  "/api/admin/maintenance",
  "/api/admin/operations",
  "/api/admin/operations/document-jobs/[jobId]",
  "/api/admin/operations/imap-test",
  "/api/admin/operations/smtp-test",
  "/api/admin/recovery-bundle",
  // An administrator creates a system for a named owner (#1052): the flow
  // behind the Systems card's "new system" button, which was drawn from the
  // v19 mockup and left inert until the decision of 2026-09-19.
  "/api/admin/systems",
  // The document upload size limit an administrator sets (#1285).
  "/api/admin/upload-limit",
  "/api/admin/users",
  // Admin-issued setup and recovery links (M7 slice 8, #911, ADR-0023 §3):
  // re-issues a `recovery` token for a local user who has forgotten their
  // password; the initial link comes back from the plain POST above.
  "/api/admin/users/[userId]/setup-link",
  // Deciding a pending sign-in (#1033, ADR-0027 §4): signed out by design --
  // the person reading the approval mail is not signed in, and answering does
  // not sign them in. The token in the body is its whole authorisation.
  "/api/auth/approve",
  "/api/auth/availability",
  // The claim (M7, ADR-0022 §2): signed out by design, and called by the
  // door and by the e2e claim helper, never by the identity provider.
  "/api/auth/bootstrap/claim",
  // The first administrator with a password (M7, ADR-0022 §2): the claim
  // cookie is its whole authorisation, and it is called by the first-run card.
  "/api/auth/bootstrap/local",
  "/api/auth/callback",
  // Linking a provider identity to the signed-in account (M7, ADR-0023 §6):
  // called by the settings sign-in-methods block, never by the provider.
  "/api/auth/link/oidc/start",
  // Local sign-in (M7, ADR-0023 §4): signed out by design, called by the door.
  "/api/auth/local/login",
  // The waiting tab's two routes (#1033, ADR-0027 §4, §8). Both are signed out
  // and both are authorised by the pending-sign-in cookie alone, never by
  // anything in the body: `pending` is where the session is finally minted,
  // for that browser and no other, and `resend` posts the link again inside
  // the send limits.
  "/api/auth/local/login/pending",
  "/api/auth/local/login/resend",
  // Sets or changes the signed-in caller's own password (M7 slice 8, #911,
  // ADR-0023 §6-§7): a session route, guarded by `write()`.
  "/api/auth/local/password",
  // Spends a setup or recovery link and signs its owner in (M7 slice 8,
  // #911, ADR-0023 §3): signed out by design, called by `/setup/<token>`.
  "/api/auth/local/setup",
  "/api/auth/login",
  // The caller's own sign-in methods and their removal (M7, ADR-0023 §6).
  "/api/auth/methods",
  "/api/auth/methods/local",
  "/api/auth/methods/oidc/[identityId]",
  // The one line a refused sign-in leaves for its owner (#1033): a session
  // route, and a read that spends the notice as it answers.
  "/api/auth/sign-in-notice",
  "/api/auth/logout",
  "/api/auth/session",
  // The OIDC step-up (M7, ADR-0023 §5): the challenge for a reader with no
  // password, called by every sensitive action's screen, never by the provider.
  "/api/auth/step-up/start",
  "/api/auth/sessions",
  "/api/auth/sessions/[sessionId]/revoke",
  "/api/auth/sessions/revoke",
  "/api/documents/[documentId]",
  "/api/documents/[documentId]/download",
  "/api/documents/[documentId]/preview",
  "/api/documents/[documentId]/restore",
  "/api/health",
  // #1316: the stage half of an all-or-nothing create -- a document stored
  // before any item exists, bound later by item.upsert's documentIds.
  "/api/households/[householdId]/documents",
  "/api/households/[householdId]/invitations",
  "/api/households/[householdId]/item-document-inspection",
  "/api/households/[householdId]/item-document-preview",
  "/api/households/[householdId]/items/[itemId]/documents",
  "/api/households/[householdId]/join-requests",
  "/api/households/[householdId]/lifecycle",
  "/api/households/[householdId]/members",
  "/api/households/[householdId]/portable-archives",
  "/api/imap-inbox",
  "/api/imap-inbox/[receiptId]",
  "/api/imap-inbox/[receiptId]/attachments/[attachmentId]/preview",
  "/api/join-requests",
  "/api/join-requests/[requestId]",
  "/api/portable-archives/[archiveId]/download",
  "/api/portable-archives/import",
  "/api/portable-archives/preview",
  "/api/preferences",
  "/api/push/config",
  "/api/push/subscriptions",
  "/api/reviewed-intake/approve",
  "/api/settings/mail-relay",
  "/api/settings/mail-relay/verification",
  "/api/settings/mail-relay/verify",
  "/api/settings/reminders",
  "/api/settings/sent",
  "/api/settings/tour",
  // The system-status drawer's own data (#863): any signed-in reader, not
  // only an administrator (#869's ruling put per-subsystem truth "behind
  // sign-in"), called by /home's #statusdrawer.
  "/api/system-status",
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
//
// T-Q5 (#1151): comments are stripped first. The regex alone matched a
// commented-out or dead `// export function GET() {}` just as readily as a
// live one -- a route stubbed out mid-edit still "satisfied" this contract.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function exportedHandlers(source) {
  const live = stripComments(source);
  return HANDLER_NAMES.filter((name) => {
    const asFunction = new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`);
    const asConst = new RegExp(`export\\s+const\\s+${name}\\s*=`);
    return asFunction.test(live) || asConst.test(live);
  });
}

const routeFiles = collectServerFiles(routesRoot);

// #1399 (#1316): the document-draft feature is removed. Its two routes,
// `POST /api/documents/{id}/draft` and `POST /api/document-drafts/{draftId}/approve`,
// are absent from EXPECTED_ROUTES above, so the exact-set test already fails if
// either returns. The `document_drafts` table is gone too (migration 0053), so
// only the module and its importers are checked here.
const repoRoot = new URL("../../", import.meta.url).pathname;
const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]s|svelte)$/;
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", ".svelte-kit", "build", "dist", "coverage"]);

function collectSourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry.name) ? [] : collectSourceFiles(entryPath);
    }
    return SOURCE_EXTENSIONS.test(entry.name) ? [entryPath] : [];
  });
}

// Any quoted module specifier ending in `document-drafts` (optionally .js/.ts):
// static and dynamic imports, re-exports and vi.mock all name the module this
// way. Route paths such as "document-drafts/[draftId]/approve" do not end there.
const DRAFT_MODULE_SPECIFIER = /["'`][^"'`\n]*\/document-drafts(?:\.[jt]s)?["'`]/;

describe("SvelteKit API route-set contract (#735)", () => {
  it("finds route files to check, so a misconfigured glob cannot silently empty this test", () => {
    expect(routeFiles.length).toBeGreaterThan(20);
  });

  it("has exactly the expected 76 route families -- no fewer, no more", () => {
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

describe("exportedHandlers (#1151 T-Q5)", () => {
  it("does not count a commented-out export as a live handler", () => {
    expect(exportedHandlers("// export function GET() {}")).toEqual([]);
    expect(exportedHandlers("/* export const POST = async () => {}; */")).toEqual([]);
  });

  it("still finds a real handler sitting next to a dead one", () => {
    expect(exportedHandlers("// export function GET() {}\nexport function POST() {}")).toEqual(["POST"]);
  });
});

describe("document drafts are gone (#1399)", () => {
  it("has no src/server/document-drafts module", () => {
    expect(existsSync(join(repoRoot, "src/server/document-drafts.ts"))).toBe(false);
  });

  it("has no route directory for document drafts", () => {
    expect(existsSync(join(routesRoot, "document-drafts"))).toBe(false);
    expect(existsSync(join(routesRoot, "documents/[documentId]/draft"))).toBe(false);
  });

  it("is imported, mocked or re-exported by no module in src, web/src, tests or scripts", () => {
    const importers = ["src", "web/src", "tests", "scripts"]
      .map((directory) => join(repoRoot, directory))
      .filter((directory) => existsSync(directory))
      .flatMap(collectSourceFiles)
      .filter((file) => !file.endsWith("/api-route-set-contract.test.mjs"))
      .filter((file) => DRAFT_MODULE_SPECIFIER.test(stripComments(readFileSync(file, "utf8"))))
      .map((file) => file.slice(repoRoot.length));
    expect(importers).toEqual([]);
  });
});

describe("DRAFT_MODULE_SPECIFIER (#1399)", () => {
  it("matches the ways a module can name the draft module", () => {
    for (const text of [
      'import { x } from "./document-drafts";',
      'import { x } from "@/server/document-drafts";',
      'import { x } from "orbit/server/document-drafts";',
      'vi.mock("./document-drafts.js", () => ({}));',
      'await import("../src/server/document-drafts.ts");',
    ]) {
      expect(DRAFT_MODULE_SPECIFIER.test(text), text).toBe(true);
    }
  });

  it("does not match unrelated names", () => {
    for (const text of [
      'loadRoute("document-drafts/[draftId]/approve")',
      'import { x } from "./document-draft-helpers";',
      'import { x } from "./document-worker";',
    ]) {
      expect(DRAFT_MODULE_SPECIFIER.test(text), text).toBe(false);
    }
  });
});
