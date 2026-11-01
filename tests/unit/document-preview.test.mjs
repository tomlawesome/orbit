// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPageBuilder, settle } from "./happy-page-mount-lib.mjs";
import { documentRowOf, documentPreviewStateOf } from "../../web/src/lib/data/belt.js";
import { DOCUMENTS_FIXTURE } from "../../web/src/lib/data/fixtures/workspace.js";

/*
 * #1141: with ORBIT_FIXTURES=1, `GET /api/documents/<id>/preview` had no
 * fixture answer (`web/src/lib/server/api.js`'s `fixture` option), so it fell
 * through to the real engine and 500'd. belt.js's `documentPreviewStateOf`
 * only asks the endpoint once a document's own metadata already says
 * "available" (stored, scanned clean, a supported media type) -- the honest
 * states (scanning, removed, refused, undrawable) never call it at all -- so
 * this was the ONE path a fixture document ever reached the endpoint on, and
 * it always came back as "Orbit could not draw a picture of this document",
 * whatever the document actually was.
 *
 * Both fixture documents on i-mot (MOT certificate 2025, Service history) are
 * ready, clean and application/pdf -- the "available" state.
 *
 * Moved from web/tests/fidelity/document-preview.spec.js (ADR-0039, #1613):
 * "a paper's page loads" is a chain of three things that need no browser --
 * the fixture route answers a page, the document says it is drawable, and the
 * preview card (lib/reading/PreviewCard.svelte, the desk card and the phone
 * sheet are the one component) shows that page under its alt text once the
 * picture has loaded. The card is mounted in happy-dom and fetches from the
 * route itself, so the chain is walked end to end; only the picture's own
 * decoding is not (happy-dom fires no load, the test fires it). Where the
 * card stands beside the drawer is layout and stays on the rig.
 */

vi.mock("orbit/server/document-preview", () => ({ readDocumentPagePreview: vi.fn() }));
vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: vi.fn() }));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: vi.fn().mockReturnValue({}) }));
vi.mock("orbit/lib/auth/session", () => ({ requireSession: vi.fn(), assertCsrf: vi.fn() }));
vi.mock("$lib/data/workspace.js", () => ({ wordsOf: (/** @type {unknown} */ _e, /** @type {string} */ fallback) => fallback }));

const page = createPageBuilder("document-preview");
const MOT = DOCUMENTS_FIXTURE["i-mot"];

/** The fixture route's GET, as the server runs it under ORBIT_FIXTURES=1. @param {string} href */
async function fixtureAnswer(href) {
  const { GET } = await import("../../web/src/routes/api/documents/[documentId]/preview/+server.js");
  const url = new URL(href, "http://localhost");
  const documentId = decodeURIComponent(url.pathname.split("/")[3]);
  return /** @type {any} */ (GET)({
    cookies: { get: () => undefined, set: () => {} },
    params: { documentId },
    url,
    request: new Request(url),
  });
}

beforeEach(() => {
  vi.stubEnv("ORBIT_FIXTURES", "1");
  /* The card's beat before its page shows is skipped for a reader who asks for less motion. */
  vi.stubGlobal("matchMedia", (/** @type {string} */ query) => ({
    matches: query.includes("prefers-reduced-motion"), media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }));
  URL.createObjectURL = () => "blob:fixture-page";
  URL.revokeObjectURL = () => {};
});
afterEach(() => {
  page.unmountAll();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(() => page.dispose());

describe("the fixture documents are drawable, and the fixture route draws them (#1141)", () => {
  it.each(MOT.map((doc) => [doc.displayName, doc]))("%s: the document says available, and the route answers a page", async (name, doc) => {
    const row = documentRowOf(doc);
    expect(documentPreviewStateOf(row)).toBe("available");
    const response = await fixtureAnswer(row.previewHref);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("x-orbit-page-count")).toBe("1");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toContain(name);
  });

  it("answers a document it does not know as the real route does: 404, not a 500", async () => {
    const response = await fixtureAnswer("/api/documents/d-nope/preview");
    expect(response.status).toBe(404);
  });
});

describe("a paper's page loads in the preview card (desk beside the drawer, and the phone's sheet)", () => {
  it.each(MOT.map((doc) => [doc.displayName, doc]))("%s: the card reaches its loaded page and the picture is described", async (name, doc) => {
    const asked = /** @type {string[]} */ ([]);
    vi.stubGlobal("fetch", vi.fn(async (/** @type {string} */ href) => { asked.push(String(href)); return fixtureAnswer(String(href)); }));
    const { target, flushSync } = await page.mount("lib/reading/PreviewCard.svelte", {
      doc: documentRowOf(doc), itemTitle: "Car MOT — Volvo V60",
      onclose: () => {}, onremove: async () => {}, onrestore: async () => {},
    });
    await settle();
    const card = target.querySelector("[data-preview-card]");
    expect(card, "the card is drawn").not.toBeNull();
    expect(card?.classList.contains("snap"), "no page before the picture has loaded").toBe(false);

    const img = /** @type {HTMLImageElement} */ (card?.querySelector(".sheet img"));
    expect(img.getAttribute("src"), "the page was fetched and handed to the picture").toBe("blob:fixture-page");
    img.dispatchEvent(new Event("load"));
    flushSync();
    await settle();

    expect(asked).toEqual([`/api/documents/${doc.id}/preview`]);
    expect(card?.classList.contains("snap"), "the card never reached its loaded page -- it is stuck on an honest state").toBe(true);
    expect(card?.querySelector(".sheet img")?.getAttribute("alt")).toBe(`Page one of ${name}`);
  });
});
