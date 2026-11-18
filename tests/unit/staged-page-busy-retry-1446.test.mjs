// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPageLoader, settle } from "../support/svelte-page.mjs";

/*
 * #1446 decision 3 for a waiting attachment's first page (StagedPage): a busy answer
 * is retried quietly, like any other page, and never reads as "Not yet in orbit".
 */

vi.mock("orbit/lib/env", () => ({ getAuthConfig: vi.fn().mockReturnValue({}) }));

const page = createPageLoader("staged-page-busy-retry-1446");
const NOT_YET = "Not yet in orbit";
const HREF = "/api/imap-inbox/r/attachments/a/preview";

beforeEach(() => {
  URL.createObjectURL = () => "blob:page";
  URL.revokeObjectURL = () => {};
});
afterEach(() => {
  page.unmount();
  vi.unstubAllGlobals();
});
afterAll(() => page.teardown());

const ok = () => new Response(new Blob(["x"]), { status: 200 });
const busy = () => new Response(
  JSON.stringify({ error: { code: "document_preview_busy", message: "Orbit is busy; try again shortly" } }),
  { status: 503, headers: { "Retry-After": "1", "Content-Type": "application/json" } },
);

describe("a busy first page of a waiting attachment (#1446 decision 3)", () => {
  it("is asked for again after Retry-After and draws; the not-yet-in-orbit line never shows because it was busy", async () => {
    // Catches StagedPage setting phase = "busy", which falls through to the
    // "Not yet in orbit. attached on acceptance" face with no retry at all.
    let calls = 0;
    const fetched = vi.fn(() => Promise.resolve(++calls === 1 ? busy() : ok()));
    vi.stubGlobal("fetch", fetched);
    const { target, flushSync } = await page.mount("lib/pocket/StagedPage.svelte", { href: HREF, name: "Policy.pdf", drawable: true });
    await settle();
    flushSync();

    expect(fetched).toHaveBeenCalledTimes(1);
    expect(target.textContent, "busy is not 'not yet in orbit'").not.toContain(NOT_YET);

    await new Promise((r) => setTimeout(r, 1_300));
    flushSync();
    await settle();

    expect(fetched, "one quiet retry").toHaveBeenCalledTimes(2);
    expect(target.querySelector("img"), "the page draws").not.toBeNull();
    expect(target.textContent).not.toContain(NOT_YET + ".");
  }, 20_000);
});
