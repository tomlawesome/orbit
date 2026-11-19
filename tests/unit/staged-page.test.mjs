// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadStagedPage, previewPageHref, STAGED_PAGE_ERROR_BODY_MAX_BYTES } from "../../web/src/lib/data/staged-page.js";

/*
 * #1155: loadStagedPage is what tells apart "gone" (404/410 -- the mail was
 * decided or burned up) from "could not draw" (415/422/5xx, or a thrown
 * network error) -- the one distinction a bare `<img src>` can never make,
 * because an `<img>`'s error event carries no status code.
 */

let fetched;

beforeEach(() => {
  fetched = vi.fn();
  vi.stubGlobal("fetch", fetched);
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => `blob:mock/${blob?.size ?? 0}`);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** @param {unknown} blob */
const okResponse = (blob) => ({ ok: true, status: 200, blob: async () => blob });
/** @param {number} status */
const statusResponse = (status) => ({
  ok: false, status, blob: async () => { throw new Error("blob() must not be read on a non-200 answer"); },
});

describe("loadStagedPage", () => {
  it("200 answers a page and an object URL for its blob", async () => {
    const blob = { size: 42 };
    fetched.mockResolvedValue(okResponse(blob));
    const result = await loadStagedPage("/api/imap-inbox/r/attachments/a/preview");
    expect(fetched).toHaveBeenCalledWith(
      "/api/imap-inbox/r/attachments/a/preview",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(result).toEqual({ kind: "page", url: "blob:mock/42", pageCount: null });
  });

  it("hands back the page count the response carries, and null for one that is not a count (#1300)", async () => {
    const withCount = (value) => ({ ...okResponse({ size: 1 }), headers: new Headers({ "x-orbit-page-count": value }) });
    fetched.mockResolvedValueOnce(withCount("3"));
    expect(await loadStagedPage("href")).toMatchObject({ kind: "page", pageCount: 3 });
    for (const bad of ["0", "-1", "2.5", "three", ""]) {
      fetched.mockResolvedValueOnce(withCount(bad));
      expect(await loadStagedPage("href")).toMatchObject({ kind: "page", pageCount: null });
    }
  });

  it("addresses page one as the endpoint itself and page N with ?page=N (#1300)", () => {
    expect(previewPageHref("/api/documents/d/preview", 1)).toBe("/api/documents/d/preview");
    expect(previewPageHref("/api/documents/d/preview", 3)).toBe("/api/documents/d/preview?page=3");
    expect(previewPageHref("/api/x/preview?a=b", 2)).toBe("/api/x/preview?a=b&page=2");
  });

  describe("a 503 document_preview_busy answers busy (#1446 decision 3)", () => {
    /** @param {Record<string, string>} headers @param {string} [code] */
    const busyResponse = (headers, code = "document_preview_busy") => ({
      ok: false, status: 503, headers: new Headers(headers),
      json: async () => ({ error: { code, message: "Orbit is busy; try again shortly" } }),
      blob: async () => { throw new Error("blob() must not be read on a non-200 answer"); },
    });

    it("carries the Retry-After seconds", async () => {
      fetched.mockResolvedValueOnce(busyResponse({ "retry-after": "7" }));
      expect(await loadStagedPage("href")).toEqual({ kind: "busy", retryAfterSeconds: 7 });
    });

    it("clamps Retry-After to 1-30 (#1915 W-F3) and defaults to 5 when absent or not whole seconds", async () => {
      for (const [header, expected] of [["0", 1], ["1", 1], ["10", 10], ["11", 11], ["30", 30], ["31", 30], ["99", 30], ["300", 30], ["-3", 5], ["soon", 5], ["", 5], ["2.5", 5]]) {
        fetched.mockResolvedValueOnce(busyResponse({ "retry-after": header }));
        expect(await loadStagedPage("href"), `Retry-After "${header}"`).toEqual({ kind: "busy", retryAfterSeconds: expected });
      }
      fetched.mockResolvedValueOnce(busyResponse({}));
      expect(await loadStagedPage("href")).toEqual({ kind: "busy", retryAfterSeconds: 5 });
    });

    it("only the document_preview_busy code says wait; any other 503 stays undrawable", async () => {
      fetched.mockResolvedValueOnce(busyResponse({ "retry-after": "5" }, "document_unavailable"));
      expect(await loadStagedPage("href")).toEqual({ kind: "undrawable" });
    });
  });

  describe("a 503's body is read within a size limit (#1446)", () => {
    const CHUNK = 1_024;
    /** A 503 whose body never ends; `pulled.bytes` is how much of it was asked for. */
    const endless = () => {
      const pulled = { bytes: 0 };
      const body = new ReadableStream({
        pull(controller) {
          /* "No end" for the test, but bounded so a loader that reads it all finishes (and fails) instead of spinning. */
          if (pulled.bytes >= 2 * 1024 * 1024) { controller.close(); return; }
          pulled.bytes += CHUNK;
          controller.enqueue(new TextEncoder().encode(" ".repeat(CHUNK)));
        },
      }, { highWaterMark: 0 });
      return { pulled, response: new Response(body, { status: 503, headers: { "retry-after": "3", "content-type": "application/json" } }) };
    };

    it("names a small limit", () => {
      expect(STAGED_PAGE_ERROR_BODY_MAX_BYTES).toBe(16 * 1024);
    });

    it("does not read a body with no end in full: it answers busy or undrawable from what is within the limit", async () => {
      const { pulled, response } = endless();
      fetched.mockResolvedValueOnce(response);
      const result = await Promise.race([
        loadStagedPage("href"),
        new Promise((resolve) => setTimeout(() => resolve({ kind: "hung" }), 3_000)),
      ]);
      expect(["busy", "undrawable"]).toContain(/** @type {{ kind: string }} */ (result).kind);
      expect(pulled.bytes).toBeLessThanOrEqual(STAGED_PAGE_ERROR_BODY_MAX_BYTES + 8 * CHUNK);
    });

    it("answers undrawable for an oversized body, and busy for the busy code within the limit", async () => {
      const huge = JSON.stringify({ error: { code: "document_preview_busy", message: "x".repeat(STAGED_PAGE_ERROR_BODY_MAX_BYTES * 4) } });
      fetched.mockResolvedValueOnce(new Response(huge, { status: 503, headers: { "retry-after": "3" } }));
      expect(await loadStagedPage("href")).toEqual({ kind: "undrawable" });
      const small = JSON.stringify({ error: { code: "document_preview_busy", message: "busy" } });
      fetched.mockResolvedValueOnce(new Response(small, { status: 503, headers: { "retry-after": "3" } }));
      expect(await loadStagedPage("href")).toEqual({ kind: "busy", retryAfterSeconds: 3 });
    });
  });

  it("404 and 410 both answer gone -- the mail was decided or burned up", async () => {
    fetched.mockResolvedValueOnce(statusResponse(404));
    expect(await loadStagedPage("href")).toEqual({ kind: "gone" });
    fetched.mockResolvedValueOnce(statusResponse(410));
    expect(await loadStagedPage("href")).toEqual({ kind: "gone" });
  });

  it("415, 500 and a thrown network error all answer undrawable", async () => {
    fetched.mockResolvedValueOnce(statusResponse(415));
    expect(await loadStagedPage("href")).toEqual({ kind: "undrawable" });
    fetched.mockResolvedValueOnce(statusResponse(500));
    expect(await loadStagedPage("href")).toEqual({ kind: "undrawable" });
    fetched.mockRejectedValueOnce(new TypeError("network error"));
    expect(await loadStagedPage("href")).toEqual({ kind: "undrawable" });
  });

  it("the caller's own abort answers no result, never a kind", async () => {
    const abortError = new DOMException("aborted", "AbortError");
    fetched.mockRejectedValueOnce(abortError);
    const controller = new AbortController();
    controller.abort();
    await expect(loadStagedPage("href", controller.signal)).rejects.toBe(abortError);
  });

  it(
    "#1151 W2-R5: a preview server that never answers resolves undrawable instead of hanging forever",
    async () => {
      /* Nothing in this loader's own code ever aborts on a timer by itself --
         fetch does that once past STAGED_PAGE_TIMEOUT_MS. Standing in for
         that here: the caller passed no signal of its own, so an AbortError
         with the caller's signal unset (or un-aborted) can only be this
         loader's own deadline, not a close the reader asked for. */
      const abortError = new DOMException("aborted", "AbortError");
      fetched.mockRejectedValueOnce(abortError);
      await expect(loadStagedPage("href")).resolves.toEqual({ kind: "undrawable" });
    },
  );
});
