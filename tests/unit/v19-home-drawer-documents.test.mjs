import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1319: home's item drawer holds everything the belt did, and a paper in it
 * opens the same preview card and reader. Those read the belt's own document
 * row (belt.js documentRowOf): where the page comes from, where the download
 * is, and the lifecycle the honest states are read off. readItem (the desk's
 * drawer) and readItemDocuments (the phone's) used to hand back only a name
 * and a meta line, so neither drawer could open anything.
 */

const ITEM = {
  id: "i1",
  title: "Car MOT",
  sectionId: "s1",
  status: "active",
  currency: "GBP",
  dueDate: "2026-08-29",
  version: 3,
};

const WORKSPACE_BODY = {
  workspace: {
    households: [{ id: "h1", name: "Home", items: [ITEM], sections: [{ id: "s1", name: "Vehicles" }] }],
    activeHouseholdId: "h1",
    fixtureToday: "2026-08-13",
  },
};

const DOCUMENTS = [
  { id: "d-ready", itemId: "i1", displayName: "Service history", availableAt: "2026-06-12T09:00:00Z",
    sizeBytes: 88 * 1024, mediaType: "application/pdf", lifecycle: "available", scanStatus: "clean", ready: true },
  { id: "d-scan", itemId: "i1", displayName: "V5C logbook scan", availableAt: "2026-08-13T09:00:00Z",
    sizeBytes: 240 * 1024, mediaType: "image/jpeg", lifecycle: "pending_scan", ready: false },
  { id: "d-gone", itemId: "i1", displayName: "Old certificate", availableAt: "2026-05-01T09:00:00Z",
    sizeBytes: 1024 * 1024, mediaType: "application/pdf", lifecycle: "pending_deletion", ready: true,
    deleteAfter: "2026-09-12T00:00:00Z" },
  { id: "d-word", itemId: "i1", displayName: "notes.docx", availableAt: "2026-06-12T09:00:00Z",
    sizeBytes: 12 * 1024, mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    lifecycle: "available", scanStatus: "clean", ready: true },
];

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const href = String(url);
    if (href.includes("/api/auth/session")) return new Response("", { status: 503 });
    if (href.includes("/api/workspace")) return new Response(JSON.stringify(WORKSPACE_BODY), { status: 200 });
    if (href.includes("/items/i1/documents")) return new Response(JSON.stringify({ documents: DOCUMENTS }), { status: 200 });
    throw new Error(`unexpected fetch: ${href}`);
  }));
}

beforeEach(() => {
  vi.resetModules();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readItem: the desk drawer's papers open the preview", () => {
  it("carries each paper's preview, download and lifecycle, as the belt's row does", async () => {
    const { readItem } = await import("../../web/src/lib/data/workspace.js");
    const item = await readItem("i1");
    const ready = item?.documents?.[0];
    expect(ready).toMatchObject({
      id: "d-ready",
      name: "Service history",
      href: "/api/documents/d-ready/download",
      previewHref: "/api/documents/d-ready/preview",
      mediaType: "application/pdf",
      lifecycle: "available",
      ready: true,
      plate: "PDF",
    });
  });

  it("reads the same honest states the belt's preview card does", async () => {
    const { readItem } = await import("../../web/src/lib/data/workspace.js");
    const { documentPreviewStateOf } = await import("../../web/src/lib/data/belt.js");
    const item = await readItem("i1");
    expect((item?.documents ?? []).map(documentPreviewStateOf)).toEqual([
      "available", "scanning", "removed", "undrawable",
    ]);
    expect(item?.documents?.[2]?.deleteAfter).toBe("12 September 2026");
  });

  it("keeps the drawer's own meta line, with the state word where there is one", async () => {
    const { readItem } = await import("../../web/src/lib/data/workspace.js");
    const item = await readItem("i1");
    expect((item?.documents ?? []).map((doc) => doc.meta)).toEqual([
      "added 12 Jun · 88 KB",
      "added 13 Aug · 240 KB · scanning",
      "added 01 May · 1.0 MB · removed",
      "added 12 Jun · 12 KB",
    ]);
  });
});

describe("readItemDocuments: the phone drawer's papers open the preview", () => {
  it("carries the belt's row as well as the search's id, item and meta", async () => {
    const { readItemDocuments } = await import("../../web/src/lib/data/workspace.js");
    const papers = await readItemDocuments("h1", "i1");
    expect(papers[0]).toMatchObject({
      id: "d-ready",
      itemId: "i1",
      name: "Service history",
      meta: "88 KB · added 12 Jun",
      previewHref: "/api/documents/d-ready/preview",
      href: "/api/documents/d-ready/download",
      ready: true,
    });
    expect(papers.map((paper) => paper.meta)).toEqual([
      "88 KB · added 12 Jun",
      "240 KB · added 13 Aug · scanning",
      "1.0 MB · added 01 May · removed",
      "12 KB · added 12 Jun",
    ]);
  });
});
