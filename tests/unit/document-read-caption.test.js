import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * R3 (audit v0.3.1 fix review): the caption under a finished read. A message
 * beside extracted text is the server saying what it could not do, so the
 * caption says the one fact that holds ("the file is attached as it is")
 * rather than claiming the pages were read. The client carries only
 * provider, reference, dueDate and cost; a server "title" suggestion never
 * reaches a field.
 */

const NOTHING = "Nothing was able to be extracted from this file.";

describe("captionOf (R3)", () => {
  it("extracted text with the server's message and nothing carried says the file is attached as it is", async () => {
    const { captionOf, CAP_ATTACHED } = await import("../../web/src/lib/data/document-read.js");
    expect(captionOf({ kind: "read", extracted: true, suggestions: [], message: NOTHING }, 0)).toBe(CAP_ATTACHED);
  });

  it("extracted text, no message, nothing carried says nothing was found to carry across", async () => {
    const { captionOf, CAP_NOTHING } = await import("../../web/src/lib/data/document-read.js");
    expect(captionOf({ kind: "read", extracted: true, suggestions: [], message: "" }, 0)).toBe(CAP_NOTHING);
  });

  it("extracted text with a carried field says what was read across", async () => {
    const { captionOf, CAP_CARRIED } = await import("../../web/src/lib/data/document-read.js");
    expect(captionOf({ kind: "read", extracted: true, suggestions: [{ field: "provider", value: "Acme" }], message: "" }, 1)).toBe(CAP_CARRIED);
  });

  it("an unread file (no extracted text) still says orbit could not read the pages, message or not", async () => {
    const { captionOf, CAP_UNREAD } = await import("../../web/src/lib/data/document-read.js");
    expect(captionOf({ kind: "read", extracted: false, suggestions: [], message: NOTHING }, 0)).toBe(CAP_UNREAD);
  });
});

describe("readPickedDocument suggestions (R3)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      const href = String(url);
      if (href.includes("/api/auth/session")) {
        return new Response(JSON.stringify({ user: { id: "u1" }, csrfToken: "t" }), { status: 200 });
      }
      if (init?.method === "POST" && href.includes("item-document-inspection")) {
        return new Response(JSON.stringify({
          extracted: true,
          attachmentDisposition: "attachable",
          suggestions: [{ field: "title", value: "policy.pdf" }, { field: "provider", value: "Acme" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("nope", { status: 500 });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("drops a server title suggestion; only the fields the form carries remain", async () => {
    const { readPickedDocument } = await import("../../web/src/lib/data/document-read.js");
    const file = new File([new Uint8Array([37, 80, 68, 70])], "policy.pdf", { type: "application/pdf" });
    const outcome = await readPickedDocument("h1", file).read;
    expect(outcome.kind).toBe("read");
    expect(outcome.suggestions).toEqual([{ field: "provider", value: "Acme" }]);
  });
});
