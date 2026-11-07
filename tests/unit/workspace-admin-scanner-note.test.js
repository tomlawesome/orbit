import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1170: ClamAV is optional, on by default. Where the Operations panel shows
 * the virus scanner as off, the row carries one quiet recommendation with the
 * command that turns it back on. Nothing else changes: other rows, and the
 * scanner when it is not off, read exactly as before. No banner, no dismissal.
 *
 * `fetch` is stubbed globally and workspace.js is re-imported per test, the
 * same shape as workspace-admin-failed-read.test.js.
 */

const HOUSEHOLD = { id: "hh-scanner-1", name: "Real Household", today: "2026-10-15" };
const CHECKED_AT = "2026-10-15T11:59:00.000Z";
const REMEDY = "scripts/configure.sh --set-scanner on";

function stubFetch(services) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const href = String(url);
    if (href.includes("/api/auth/session")) {
      return new Response(JSON.stringify({ user: { id: "u1" }, csrfToken: "t" }), { status: 200 });
    }
    if (href.includes("/api/workspace")) {
      return new Response(JSON.stringify({ workspace: { households: [HOUSEHOLD], activeHouseholdId: HOUSEHOLD.id } }), { status: 200 });
    }
    if (href.includes("/api/admin/health")) {
      const health = { build: { version: "0.3.0", channel: "stable", revision: "abcdef0123456" }, services };
      return new Response(JSON.stringify({ health }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }));
}

async function scannerRow(scannerState, extra = {}) {
  stubFetch([
    { id: "database", state: "ok", checkedAt: CHECKED_AT },
    { id: "virus-scanner", state: scannerState, checkedAt: CHECKED_AT, ...extra },
    { id: "document-parser", state: "off", checkedAt: CHECKED_AT },
  ]);
  const { readAdminScreen } = await import("../../web/src/lib/data/workspace.js");
  const view = await readAdminScreen();
  const rows = view.services;
  return { rows, scanner: rows.find((row) => /scanner/iu.test(row[1])), parser: rows.find((row) => /pars|document/iu.test(row[1])) };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Operations panel scanner recommendation (#1170)", () => {
  it("shows the quiet recommendation with the remedy when the scanner is off", async () => {
    const { scanner } = await scannerRow("off");
    expect(scanner).toBeDefined();
    expect(scanner[2]).toBe(`off by choice · recommended: ${REMEDY}`);
  });

  it("keeps the grey off tone: it is a choice, not a fault", async () => {
    const { scanner, parser } = await scannerRow("off");
    expect(scanner[0]).toBe(parser[0]);
  });

  it("gives no recommendation when the scanner is healthy", async () => {
    const { scanner } = await scannerRow("ok");
    expect(scanner[2]).toBe("healthy");
    expect(JSON.stringify(scanner)).not.toContain("set-scanner");
  });

  it("gives no recommendation when the scanner is down: that is a fault, not a choice", async () => {
    const { scanner } = await scannerRow("down");
    expect(scanner[2]).toBe("unreachable");
    expect(JSON.stringify(scanner)).not.toContain("set-scanner");
  });

  it("leaves other services that are off reading 'not enabled', with no recommendation", async () => {
    const { parser } = await scannerRow("off");
    expect(parser[2]).toBe("not enabled");
  });

  it("puts the recommendation on the one row only: no other row mentions it", async () => {
    const { rows } = await scannerRow("off");
    expect(rows.filter((row) => JSON.stringify(row).includes("set-scanner"))).toHaveLength(1);
  });
});
