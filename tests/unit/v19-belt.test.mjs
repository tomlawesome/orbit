import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The belt's data is plain ESM inside web/, which root vitest excludes from
// COLLECTION (#425: web's own suites are Playwright); importing a module from
// there is fine — only test files are excluded. The belt page and its ring
// geometry (band.js) retired in #1319; lib/data/belt.js stays, home's item
// drawer reads it.
import { beltManifestOf, documentPreviewStateOf, sizeLabel } from "../../web/src/lib/data/belt.js";
import { DOCUMENTS_FIXTURE, WORKSPACE_FIXTURE } from "../../web/src/lib/data/fixtures/workspace.js";

const TODAY = WORKSPACE_FIXTURE.fixtureToday; // 2026-08-13, the date every mockup was drawn against
const LAWSON = WORKSPACE_FIXTURE.households[0];

const manifestOf = (options = {}) =>
  beltManifestOf({
    household: LAWSON,
    documentsByItem: DOCUMENTS_FIXTURE,
    today: TODAY,
    ...options,
  });

const MANIFEST = manifestOf();

/*
 * #458, and the owner's corrections of 2026-08-16: an ITEM belt — the whole
 * manifest laid out in time, all of it in one band, in strict order of when it
 * comes due, jumbled through the band's thickness but never out of order.
 */
describe("the belt's manifest", () => {
  it("is the household's items in date order, sooner first", () => {
    expect(MANIFEST.map((row) => row.id)).toEqual([
      "i-gutter", "i-mot", "i-boiler", "i-chimney", "i-smoke", "i-svc",
    ]);
    // Ascending, strictly: the belt IS this list, and it is never re-sorted.
    const days = MANIFEST.map((row) => row.days);
    expect(days).toEqual([...days].sort((a, b) => a - b));
    expect(days).toEqual([-16, 16, 22, 61, 122, 161]);
  });

  it("says what the rock says, in the manifest's own four tones", () => {
    // chart.js's bands, translated to the card and rim classes — not forked.
    expect(MANIFEST.map((row) => row.urg)).toEqual(["over", "soon", "soon", "up", "ok", "ok"]);
    expect(MANIFEST.map((row) => `${row.t} · ${row.when}`)).toEqual([
      "T+16d · 28 Jul", "T−16d · 29 Aug", "T−22d · 04 Sept",
      "T−61d · 13 Oct", "T−122d · 13 Dec", "T−161d · 21 Jan",
    ]);
  });

  it("reads the real documents, in the words the card shows", () => {
    const mot = MANIFEST.find((row) => row.id === "i-mot");
    expect(mot.docs).toEqual([
      {
        id: "d-mot-cert", name: "MOT certificate 2025", size: "240 KB",
        added: "12 June 2026", type: "PDF (application/pdf)", plate: "PDF",
        clean: true, scan: "clean", href: "/api/documents/d-mot-cert/download",
        // #1088: the reading card's own fields, added for the preview.
        previewHref: "/api/documents/d-mot-cert/preview",
        lifecycle: "stored", mediaType: "application/pdf", ready: true, deleteAfter: null,
      },
      {
        id: "d-mot-history", name: "Service history", size: "88 KB",
        added: "12 June 2026", type: "PDF (application/pdf)", plate: "PDF",
        clean: true, scan: "clean", href: "/api/documents/d-mot-history/download",
        previewHref: "/api/documents/d-mot-history/preview",
        lifecycle: "stored", mediaType: "application/pdf", ready: true, deleteAfter: null,
      },
    ]);
    expect(sizeLabel(2_400_000)).toBe("2.3 MB");
  });

  it("keeps a retired item's seat only when it is the one being arrived at", () => {
    const retired = {
      ...LAWSON,
      items: [...LAWSON.items, {
        id: "i-old", title: "Gone", sectionId: "s-home", status: "archived",
        subtype: "service", scheduleKind: "service", dueDate: "2026-08-20",
        currency: "GBP", version: 1,
      }],
    };
    expect(manifestOf({ household: retired }).map((r) => r.id)).not.toContain("i-old");
    expect(manifestOf({ household: retired, keepId: "i-old" }).map((r) => r.id)).toContain("i-old");
  });
});

/*
 * #1145: the suggestion in the belt. A mail-in receipt arrived at by its own
 * address is seated at the date the relay read, among its neighbours in
 * time, with the paper
 * it came in staged beside it -- and only that arrival seats it.
 */
describe("the suggestion's seat", () => {
  /* The inbox fixture's r-insurance as readItem hands it to the belt
     (fixtures/inbox.js through receiptSuggestionsOf, plus the receipt's own
     proposal and count): spelled out here so the seat is pinned to values,
     not to whatever the fixture says this week. */
  const PROPOSAL = {
    title: "Home insurance renewal", provider: "Harbour Mutual", costMinor: 40000, currency: "GBP",
    dueDate: "2026-10-03", scheduleKind: "renewal", recurrenceMonths: 12,
  };
  const SUGGESTION = {
    id: "r-insurance", receiptId: "r-insurance", householdId: null, draftVersion: 1,
    title: "Home insurance renewal", renewsOn: "2026-10-03", scheduleKind: "renewal",
    provider: "Harbour Mutual", expiresAt: "2026-09-25T12:00:00.000Z", receivedAt: "2026-08-11T09:24:00.000Z",
    costMinor: 40000, currency: "GBP", sourceDocument: "1 forwarded document",
    attachments: [{
      id: "a-insurance-1", ordinal: 1, displayName: "policy-schedule.pdf",
      mediaType: "application/pdf", sizeBytes: 831488, scanState: "clean",
    }],
    suggestion: true, proposal: PROPOSAL, attachmentCount: 1, today: TODAY,
  };
  const RECEIPT = { proposal: PROPOSAL };

  it("takes its seat at the relay's date, in order, and nowhere else", () => {
    const rows = manifestOf({ suggestion: SUGGESTION });
    expect(rows.map((row) => row.id)).toEqual([
      "i-gutter", "i-mot", "i-boiler", "r-insurance", "i-chimney", "i-smoke", "i-svc",
    ]);
    const seat = rows.find((row) => row.id === "r-insurance");
    expect(seat.suggestion).toBe(SUGGESTION);
    expect(seat.title).toBe("Home insurance renewal");
    expect(seat.days).toBe(51);
    expect(`${seat.t} · ${seat.when}`).toBe("T−51d · 03 Oct");
    expect(seat.longWhen).toBe("3 October 2026");
    expect(seat.status).toBe("suggested");
    expect(seat.section).toBeNull();
    expect(seat.cost).toBe(40000);
    expect(seat.costIsEstimate).toBe(true);
    // No arrival, no visitor: a filed item's belt carries no suggestions.
    expect(manifestOf().map((row) => row.id)).not.toContain("r-insurance");
  });

  it("stages the forwarded paper beside it: named, dated by the mail, no download -- but a page for a named PDF (#1155)", () => {
    const seat = manifestOf({ suggestion: SUGGESTION }).find((row) => row.id === "r-insurance");
    expect(seat.docs).toHaveLength(1);
    expect(seat.docs[0]).toMatchObject({
      id: "r-insurance-paper-1", name: "policy-schedule.pdf", size: "812 KB", added: "11 August 2026",
      plate: "PDF", clean: true, href: "", ready: false, staged: true, attachmentId: "a-insurance-1",
      previewHref: "/api/imap-inbox/r-insurance/attachments/a-insurance-1/preview",
    });
    expect(documentPreviewStateOf(seat.docs[0])).toBe("available");

    // A named attachment that is not a PDF has no page to ask for: undrawable
    // -- "staged" is now only the count-only fallback below.
    const nonPdf = manifestOf({
      suggestion: {
        ...SUGGESTION,
        attachments: [{
          id: "a-insurance-1", ordinal: 1, displayName: "policy.docx",
          mediaType: "application/octet-stream", sizeBytes: 1000, scanState: "clean",
        }],
      },
    }).find((row) => row.id === "r-insurance");
    expect(nonPdf.docs[0].previewHref).toBe("");
    expect(documentPreviewStateOf(nonPdf.docs[0])).toBe("undrawable");

    // clean follows the API's own scanState, never a guess.
    const unscanned = manifestOf({
      suggestion: { ...SUGGESTION, attachments: [{ ...SUGGESTION.attachments[0], scanState: "unknown" }] },
    }).find((row) => row.id === "r-insurance");
    expect(unscanned.docs[0].clean).toBe(false);

    // Named or not, an attachments-less receipt (the count-only fallback)
    // still answers "staged": the one paper Orbit genuinely has no page for.
    const counted = manifestOf({ suggestion: { ...SUGGESTION, attachments: null, attachmentCount: 2 } })
      .find((row) => row.id === "r-insurance");
    expect(counted.docs.map((doc) => doc.name)).toEqual(["forwarded document 1", "forwarded document 2"]);
    expect(documentPreviewStateOf(counted.docs[0])).toBe("staged");
  });

  it("falls to the later end when the relay read no date", () => {
    const undated = { ...SUGGESTION, renewsOn: null, proposal: { ...RECEIPT.proposal, dueDate: undefined } };
    const rows = manifestOf({ suggestion: undated });
    expect(rows.at(-1).id).toBe("r-insurance");
    expect(rows.at(-1).when).toBe("undated");
  });
});

/*
 * #1088: the reading card's own honest state (owner-decisions.md §18) — a
 * pure read of the document's own lifecycle, never a guess and never
 * anything the endpoint would have to be asked first. `ready` alone answers
 * "still scanning"; the two server lifecycles that are neither reachable
 * from `ready` nor from the media kind — removed and refused — take
 * priority over everything else.
 */
describe("the reading card's honest state", () => {
  const doc = (overrides) => ({
    lifecycle: "available", mediaType: "application/pdf", ready: true, ...overrides,
  });

  it("shows the page when the file is ready and its kind is one Orbit can draw", () => {
    expect(documentPreviewStateOf(doc())).toBe("available");
    expect(documentPreviewStateOf(doc({ mediaType: "image/jpeg" }))).toBe("available");
    expect(documentPreviewStateOf(doc({ mediaType: "image/png" }))).toBe("available");
  });

  it("is scanning whenever the content is not ready yet, whatever the lifecycle word", () => {
    expect(documentPreviewStateOf(doc({ ready: false, lifecycle: "receiving" }))).toBe("scanning");
    expect(documentPreviewStateOf(doc({ ready: false, lifecycle: "scanning" }))).toBe("scanning");
    expect(documentPreviewStateOf(doc({ ready: false, lifecycle: "encrypting" }))).toBe("scanning");
  });

  it("is removed once the file is on its retention clock, even mid-scan", () => {
    expect(documentPreviewStateOf(doc({ lifecycle: "pending_deletion" }))).toBe("removed");
    expect(documentPreviewStateOf(doc({ lifecycle: "pending_deletion", ready: false }))).toBe("removed");
  });

  it("is refused for a rejected file, even one whose stored kind looks fine", () => {
    expect(documentPreviewStateOf(doc({ lifecycle: "rejected" }))).toBe("refused");
    expect(documentPreviewStateOf(doc({ lifecycle: "rejected", ready: true, mediaType: "application/pdf" }))).toBe("refused");
  });

  it("is a kind Orbit cannot draw once ready and clean but not one of the three it renders", () => {
    expect(documentPreviewStateOf(doc({ mediaType: "application/msword" }))).toBe("undrawable");
    expect(documentPreviewStateOf(doc({ mediaType: null }))).toBe("undrawable");
  });

});

describe("the belt's data reads no clock and rolls no dice", () => {
  it("has no Math.random, Date.now or bare new Date in anything the gate sees", () => {
    const sources = ["web/src/lib/data/belt.js"];
    for (const path of sources) {
      const source = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
      /* Calls, not the words: these modules TALK about not reading a clock. */
      expect(source, path).not.toMatch(/Math\.random\s*\(/);
      expect(source, path).not.toMatch(/Date\.now\s*\(/);
      expect(source, path).not.toMatch(/new Date\(\s*\)/);
    }
  });
});
