import { spawnSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { isV19Path } from "./v19-dispatch.mjs";
import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

// The container-server startup test below spawns the real entry point; a
// spawn that takes tens of milliseconds quiet takes seconds on a starved
// core (#698). Budget and reasoning: scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

// #450: the composite container entry serves the Next.js app and the v19
// front end from ONE process on ONE socket, dispatching on path — one origin,
// so __Host- cookies and assertSameOrigin keep working unchanged. This table
// is the entire routing decision; nothing about it may depend on headers.
describe("v19 path dispatch", () => {
  it("routes every v19 page to the v19 handler", () => {
    expect(isV19Path("/")).toBe(true);
    expect(isV19Path("/home")).toBe(true);
    expect(isV19Path("/create")).toBe(true);
    expect(isV19Path("/login")).toBe(true);
    expect(isV19Path("/logout")).toBe(true);
    expect(isV19Path("/maintenance")).toBe(true);
    expect(isV19Path("/settings/mail")).toBe(true);
    expect(isV19Path("/item/i-mot")).toBe(true);
    expect(isV19Path("/household/hh-lawson-1")).toBe(true);
  });

  it("routes the v19 asset roots to the v19 handler", () => {
    expect(isV19Path("/_app/immutable/entry/start.js")).toBe(true);
    expect(isV19Path("/licenses/fonts.txt")).toBe(true);
    expect(isV19Path("/screens/family.css")).toBe(true);
  });

  // `/` is the ratified v19 sign-in from #410/§15 on; the retiring engine's
  // workspace answers at /workspace so its acceptance suite keeps a door.
  // /admin and /settings are LIVE Next routes (admin-operations.spec.ts, and
  // App Router client navigation fetches RSC payloads from the server for
  // them) — they move to v19 at the cutover, not in this slice.
  it("leaves the existing application on Next", () => {
    expect(isV19Path("/workspace")).toBe(false);
    expect(isV19Path("/admin")).toBe(false);
    expect(isV19Path("/settings")).toBe(false);
    expect(isV19Path("/auth/error")).toBe(false);
    expect(isV19Path("/api/health")).toBe(false);
    expect(isV19Path("/api/auth/login")).toBe(false);
    expect(isV19Path("/_next/static/anything.js")).toBe(false);
  });

  // Prefix matching must not swallow lookalike paths: /homework is not /home,
  // /items is not /item/, and /settings/mailbox is not the v19 mail screen.
  it("does not swallow lookalike paths", () => {
    expect(isV19Path("/homework")).toBe(false);
    expect(isV19Path("/items")).toBe(false);
    expect(isV19Path("/item")).toBe(false);
    expect(isV19Path("/settings/mailbox")).toBe(false);
    expect(isV19Path("/loginhelp")).toBe(false);
    expect(isV19Path("/households")).toBe(false);
    expect(isV19Path("/household")).toBe(false);
  });

  // trailingSlash is "never" on both sides, but a client can still send one;
  // exact pages accept it rather than falling through to a Next 404.
  it("accepts a trailing slash on exact pages", () => {
    expect(isV19Path("/home/")).toBe(true);
    expect(isV19Path("/settings/mail/")).toBe(true);
  });

  // #456: goto() to a v19 page with a server `load` (currently only /home)
  // fetches "<route>/__data.json" as its own request, on client-side
  // navigation only — a full page load never asks for it. That request must
  // land on v19 too, or the destination page renders but its data request
  // 404s into the retiring engine, and SvelteKit shows its own error page
  // with the URL bar still on the route that "worked".
  it("routes a v19 page's own __data.json request, not just the page", () => {
    expect(isV19Path("/home/__data.json")).toBe(true);
    expect(isV19Path("/__data.json")).toBe(true);
    expect(isV19Path("/settings/mail/__data.json")).toBe(true);
    expect(isV19Path("/item/i-mot/__data.json")).toBe(true);
    // Still not swallowed for a route this table does not own.
    expect(isV19Path("/workspace/__data.json")).toBe(false);
    expect(isV19Path("/settings/__data.json")).toBe(false);
  });
});

// The entry must fail closed: a container whose image is missing either
// application must exit nonzero at startup, not serve a half-app.
describe("container-server startup", () => {
  const scratch = mkdtempSync(join(tmpdir(), "orbit-composite-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it("exits nonzero with a clear error when the Next build is absent", () => {
    cpSync(join(process.cwd(), "scripts/container-server.mjs"), join(scratch, "scripts/container-server.mjs"));
    cpSync(join(process.cwd(), "scripts/v19-dispatch.mjs"), join(scratch, "scripts/v19-dispatch.mjs"));
    const result = failOnProcessDeadline(spawnSync(process.execPath, [join(scratch, "scripts/container-server.mjs")], {
      cwd: scratch,
      encoding: "utf8",
      ...processGuard(),
    }), { label: "container-server startup" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("required-server-files.json");
  });
});
