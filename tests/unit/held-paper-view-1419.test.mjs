// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPageLoader, settle } from "../support/svelte-page.mjs";
import { documentPreviewStateOf, documentRowOf } from "../../web/src/lib/data/belt.js";
import { readPickedDocument } from "../../web/src/lib/data/document-read.js";
import { drawerDocumentOf } from "../../web/src/lib/data/workspace.js";
import { DOCUMENTS_FIXTURE } from "../../web/src/lib/data/fixtures/workspace.js";

/*
 * #1419, the member's held view (direction P, design/v19/held-paper/round-1;
 * spec 1419-view-spec.md). A paper is held while the virus scanner is down.
 * The document read model says so with `scanHeld` (true while the paper is
 * `scanning` and the last attempt found the scanner unreachable), separate
 * from `ready`. What the member sees:
 *   - the row's meta word is `waiting`, not `scanning` (workspace.js)
 *   - the preview state is `held` (belt.js documentPreviewStateOf); the card's
 *     plate says `waiting`, nothing sweeps, the one line is HELD_LINE, and the
 *     foot is empty
 *   - scanner back but not yet clean: row `scanning`, plate `scanning`, the
 *     line "Scanning this file now"
 *   - clean: unchanged
 *   - /create while held: the lane says HELD_LINE where it said "could not draw"
 */
const HELD_LINE = "The scanner couldn't be reached, Admin have been notified";

vi.mock("orbit/server/document-preview", () => ({ readDocumentPagePreview: vi.fn() }));
vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: vi.fn() }));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: vi.fn().mockReturnValue({}) }));
vi.mock("orbit/lib/auth/session", () => ({ requireSession: vi.fn(), assertCsrf: vi.fn() }));

const page = createPageLoader("held-paper-view-1419");
const MOT = DOCUMENTS_FIXTURE["i-mot"][0];

const held = { ...MOT, lifecycle: "scanning", scanStatus: "pending", ready: false, availableAt: null, scanHeld: true };
const scanningAgain = { ...held, scanHeld: false };
const clean = { ...MOT, scanHeld: false };

beforeEach(() => {
  vi.stubGlobal("matchMedia", (/** @type {string} */ query) => ({
    matches: query.includes("prefers-reduced-motion"), media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }));
});
afterEach(() => {
  page.unmount();
  vi.unstubAllGlobals();
});
afterAll(() => page.teardown());

describe("the row's word", () => {
  it("is `waiting` for a held paper", () => {
    expect(drawerDocumentOf(held).meta.split(" · ").pop()).toBe("waiting");
  });
  it("is `scanning` once the scanner is back and the paper is not yet clean", () => {
    expect(drawerDocumentOf(scanningAgain).meta.split(" · ").pop()).toBe("scanning");
  });
  it("is no word for a clean paper", () => {
    expect(drawerDocumentOf(clean).meta).not.toMatch(/waiting|scanning/);
  });
});

describe("the preview state", () => {
  it("is `held` for a held paper, `scanning` once the scanner is back, `available` when clean", () => {
    expect(documentPreviewStateOf(documentRowOf(held))).toBe("held");
    expect(documentPreviewStateOf(documentRowOf(scanningAgain))).toBe("scanning");
    expect(documentPreviewStateOf(documentRowOf(clean))).toBe("available");
  });
});

/** @param {object} doc */
async function mountCard(doc) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
  const { target } = await page.mount("lib/reading/PreviewCard.svelte", {
    doc: documentRowOf(doc), itemTitle: "Car MOT — Volvo V60",
    onclose: () => {}, onremove: async () => {}, onrestore: async () => {},
  });
  await settle();
  const card = /** @type {Element} */ (target.querySelector("[data-preview-card]"));
  expect(card, "the card is drawn").not.toBeNull();
  return card;
}

describe("the preview card", () => {
  it("held: the plate says waiting, nothing is scanning, the one line is said, the foot is empty", async () => {
    const card = await mountCard(held);
    expect(card.querySelector(".plate")?.textContent?.trim()).toBe("waiting");
    expect(card.querySelector(".plate.scanning"), "no sweep: nothing is being scanned").toBeNull();
    expect(card.querySelector(".focusline")?.textContent?.trim()).toBe(HELD_LINE);
    expect(card.querySelector(".rcfoot")?.textContent?.trim() ?? "").toBe("");
    expect(card.querySelectorAll(".rcfoot button")).toHaveLength(0);
  });

  it("scanner back, not yet clean: the ordinary scan, and the line says it is scanning now", async () => {
    const card = await mountCard(scanningAgain);
    expect(card.querySelector(".plate")?.textContent?.trim()).toBe("scanning");
    expect(card.querySelector(".plate.scanning")).not.toBeNull();
    expect(card.querySelector(".focusline")?.textContent?.trim()).toBe("Scanning this file now");
  });

  it("clean: unchanged, no scan plate and neither new line", async () => {
    const card = await mountCard(clean);
    expect(card.querySelector(".plate.scanning, .plate.held")).toBeNull();
    expect(card.textContent).not.toContain(HELD_LINE);
    expect(card.textContent).not.toContain("Scanning this file now");
  });
});

describe("the /create lane while the scanner is down", () => {
  /** The preview route answers as the server does when it cannot reach the scanner. */
  function scannerDownAnswers() {
    vi.stubGlobal("fetch", vi.fn(async (/** @type {string} */ url) => {
      const href = String(url);
      if (href.includes("/api/auth/session")) return new Response(JSON.stringify({ user: { id: "u1" }, csrfToken: "t1" }), { status: 200 });
      return new Response(JSON.stringify({ error: {
        code: "document_scanner_unreachable",
        message: "Document preview is not possible because the malware scanner cannot be reached. It stays blocked until the scanner is running.",
      } }), { status: 503 });
    }));
  }
  const pdf = () => new File([new Uint8Array([37, 80, 68, 70])], "policy.pdf", { type: "application/pdf" });

  it("says the held line where it said \"could not draw\", and the paper is not refused", async () => {
    scannerDownAnswers();
    const { page: outcome } = readPickedDocument("hh-1", pdf(), { documentReading: false });
    const settled = await outcome;
    expect(settled.kind).toBe("undrawable");
    expect(settled).toMatchObject({ why: HELD_LINE });
    expect(JSON.stringify(settled)).not.toMatch(/could not draw/i);
  });

  it("says the held line when the refusal arrives as a stream event", async () => {
    vi.stubGlobal("fetch", vi.fn(async (/** @type {string} */ url) => {
      const href = String(url);
      if (href.includes("/api/auth/session")) return new Response(JSON.stringify({ user: { id: "u1" }, csrfToken: "t1" }), { status: 200 });
      const line = JSON.stringify({ error: { code: "document_scanner_unreachable", message: "The malware scanner cannot be reached." } });
      return new Response(`${line}\n`, { status: 200, headers: { "content-type": "application/x-ndjson" } });
    }));
    const { page: outcome } = readPickedDocument("hh-1", pdf(), { documentReading: false });
    const settled = await outcome;
    expect(settled.kind).toBe("undrawable");
    expect(settled).toMatchObject({ why: HELD_LINE });
  });
});
