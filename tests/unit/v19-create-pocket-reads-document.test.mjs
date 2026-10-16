import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1279: the phone's create form saved a picked document with the item
 * (#1245, 11a) but drew neither page one nor the read, while its "add a
 * document" row said the file is "read for you" -- true only on the desk.
 * The owner approved design/v19/create-phone-reading.html ("14a", note
 * 31038): the reading card lands straight under TYPE, page one lands on the
 * cream sheet within seconds, the empty fields the read filled carry "◆ from
 * document", and a refused file leaves the entry.
 *
 * Both forms now start the read through one shared module,
 * $lib/data/document-read.js, driven here with a stubbed fetch; the forms
 * have no import surface a plain test can mount, so their wiring is pinned
 * against the files' own text and tests/e2e/v19-create.spec.ts proves the
 * journey on the phone projects.
 */

const root = resolve(import.meta.dirname, "../..");
const read = (/** @type {string} */ p) => readFileSync(resolve(root, p), "utf8");

/** @param {(href: string) => Response} answer */
function stubFetch(answer) {
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const href = String(url);
    if (href.includes("/api/auth/session")) {
      return new Response(JSON.stringify({ user: { id: "u1" }, csrfToken: "t" }), { status: 200 });
    }
    if (init?.method === "POST") return answer(href);
    throw new Error(`unexpected fetch: ${href}`);
  }));
}

const file = () => new File([new Uint8Array([37, 80, 68, 70])], "boiler.pdf", { type: "application/pdf" });
const json = (/** @type {unknown} */ body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:page-one"), revokeObjectURL: vi.fn() }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("#1279: one read of a picked document, shared by the desk and the phone", () => {
  it("lands page one and hands back only the four fields the forms carry", async () => {
    stubFetch((href) => href.endsWith("/item-document-preview")
      ? new Response(
        `${JSON.stringify({ stage: "scanned", scanned: true })}\n${JSON.stringify({ stage: "preview", mediaType: "image/jpeg", bytes: "/9g=" })}\n`,
        { status: 200, headers: { "content-type": "application/x-ndjson; charset=utf-8" } },
      )
      : json({
        extracted: true, attachmentDisposition: "attachable",
        suggestions: [
          { field: "provider", value: "British Gas", source: "document_text", confidence: "medium" },
          { field: "title", value: "HomeCare", source: "document_text", confidence: "low" },
          { field: "cost", value: "144.00", source: "document_text", confidence: "medium" },
        ],
      }));
    const { readPickedDocument } = await import("../../web/src/lib/data/document-read.js");
    const { page, read: outcome } = readPickedDocument("h1", file());
    await expect(page).resolves.toEqual({ kind: "up", url: "blob:page-one", scanned: true });
    await expect(outcome).resolves.toEqual({
      kind: "read", extracted: true, message: "",
      suggestions: [{ field: "provider", value: "British Gas" }, { field: "cost", value: "144.00" }],
    });
  });

  it("refuses a file the scanner or the upload would not keep", async () => {
    stubFetch((href) => href.endsWith("/item-document-preview")
      ? json({ error: { code: "document_malware_detected", message: "malware" } }, 422)
      : json({ extracted: false, suggestions: [], attachmentDisposition: "rejected", message: "not a structure orbit keeps" }));
    const { readPickedDocument, WHY_REFUSED } = await import("../../web/src/lib/data/document-read.js");
    const { page, read: outcome } = readPickedDocument("h1", file());
    await expect(page).resolves.toEqual({ kind: "refused", why: WHY_REFUSED });
    await expect(outcome).resolves.toEqual({ kind: "refused", why: "not a structure orbit keeps" });
  });

  it("says a page it could not draw in its own words, and never rejects", async () => {
    stubFetch(() => json({ error: { code: "document_preview_unsupported", message: "no" } }, 415));
    const { readPickedDocument, WHY_UNDRAWABLE, whyLines } = await import("../../web/src/lib/data/document-read.js");
    const { page, read: outcome } = readPickedDocument("h1", file());
    await expect(page).resolves.toEqual({ kind: "undrawable", why: WHY_UNDRAWABLE });
    await expect(outcome).resolves.toMatchObject({ kind: "unread" });
    expect(whyLines(WHY_UNDRAWABLE)).toHaveLength(2);
    expect(whyLines("<b>a server's words</b><br>stay one line")).toHaveLength(1);
  });

  it("tells the card when the virus check is done, before the picture (ADR-0033 step 5)", async () => {
    /** @type {string[]} */
    const order = [];
    stubFetch((href) => href.endsWith("/item-document-preview")
      ? new Response(
        `${JSON.stringify({ stage: "scanned", scanned: false })}\n${JSON.stringify({ stage: "preview", mediaType: "image/png", bytes: "iVA=" })}\n`,
        { status: 200, headers: { "content-type": "application/x-ndjson; charset=utf-8" } },
      )
      : json({ extracted: false, suggestions: [], attachmentDisposition: "attachable" }));
    const { readPickedDocument, focusAfterScan, FOCUS_SCANNED, FOCUS_PREVIEWING } = await import("../../web/src/lib/data/document-read.js");
    const { page } = readPickedDocument("h1", file(), { onScanned: (scanned) => order.push(`scanned:${scanned}`) });
    await page.then((outcome) => order.push(outcome.kind));
    expect(order).toEqual(["scanned:false", "up"]);
    expect(focusAfterScan(true)).toBe(FOCUS_SCANNED);
    expect(focusAfterScan(false)).toBe(FOCUS_PREVIEWING);
  });

  it("never carries a suggestion over what someone typed", async () => {
    const { suggestionsToCarry } = await import("../../web/src/lib/data/document-read.js");
    const typed = /** @type {Record<string, string>} */ ({ provider: "Octopus", reference: " " });
    const carried = suggestionsToCarry(
      [{ field: "provider", value: "British Gas" }, { field: "reference", value: "BG-1" }],
      (field) => typed[field] ?? "",
    );
    expect(carried).toEqual([{ field: "reference", value: "BG-1" }]);
  });
});

describe("#1279: the phone's create form shows page one and the read, as the desk does", () => {
  const pocket = read("web/src/routes/create/pocket.svelte");
  const form = read("web/src/routes/create/EntryForm.svelte");
  const desk = read("web/src/routes/create/create.behaviour.js");
  const markup = form.slice(form.indexOf('<div class="pc-form">'));

  it("starts the shared read from the pick, on both forms", () => {
    expect(pocket).toMatch(/import \{[^}]*\breadPickedDocument\b[^}]*\} from "\$lib\/data\/document-read\.js"/u);
    expect(desk).toMatch(/import \{[^}]*\breadPickedDocument\b[^}]*\} from "\$lib\/data\/document-read\.js"/u);
    expect(desk).not.toMatch(/\bpreviewPickedDocument\(|\binspectPickedDocument\(/u);
  });

  it("moves the phone card's focus line from the virus check to the preview (ADR-0033 step 5)", () => {
    expect(pocket).toMatch(/line: FOCUS_SCANNING,/u);
    expect(pocket).toMatch(/picked\.line = focusAfterScan\(scanned\);/u);
    expect(pocket).toMatch(/readPickedDocument\(householdId, file, \{ signal: controller\.signal, onScanned \}\)/u);
  });

  it("lands the reading card straight under TYPE, in place of the row that picked the file", () => {
    const reading = markup.indexOf("pc-reading");
    expect(reading).toBeGreaterThan(markup.indexOf('id="{uid}-type"'));
    expect(reading).toBeLessThan(markup.indexOf('id="{uid}-details"'));
  });

  it("draws the desk's reticle, then page one on the sheet, with the desk's words", () => {
    expect(markup).toMatch(/class="pc-reticle"/u);
    expect(markup).toMatch(/<img [^>]*alt="Page one of \{[^}]+\}"/u);
    expect(markup).toMatch(/Page one of the file you added/u);
    expect(markup).toMatch(/scanned clean/u);
    expect(markup).toMatch(/>refused</u);
  });

  it("marks each field the read filled, and typing in it clears the mark", () => {
    for (const field of ["provider", "reference", "dueDate", "cost"]) {
      expect(markup).toMatch(new RegExp(`class:sugg=\\{marked\\.includes\\("${field}"\\)\\}`, "u"));
      expect(markup).toMatch(new RegExp(`oninput=\\{\\(\\) => unmark\\("${field}"\\)\\}`, "u"));
    }
    expect(markup).toMatch(/◆ from document/u);
  });

  it("keeps the row's promise: the document is read for you", () => {
    expect(markup).toMatch(/photo or file · read for you/u);
    expect(form).not.toMatch(/reading is wired on the desk's\s+\*?\s*form only/u);
  });
});
