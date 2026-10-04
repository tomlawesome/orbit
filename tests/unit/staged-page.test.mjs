// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadStagedPage } from "../../web/src/lib/data/staged-page.js";

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
    expect(result).toEqual({ kind: "page", url: "blob:mock/42" });
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
