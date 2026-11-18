// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPageLoader, settle } from "../support/svelte-page.mjs";

/*
 * #1605 b1 W-R12: a file that changed on disk between "look inside" and "bring
 * in" is refused with the generic "not brought in - <whatever the browser
 * said>". The browser cannot read a File whose disk copy changed after it was
 * picked (it rejects the upload with a NotReadableError); the card should say
 * the file changed and has to be chosen again, not pass the browser's words on.
 *
 * The card is mounted in happy-dom with the data layer stood in; the file is
 * picked through the card's own input, previewed, and then the import is
 * refused the way a browser refuses an upload whose file changed.
 */
const ws = vi.hoisted(() => ({
  previewPortableArchive: vi.fn(),
  importPortableArchive: vi.fn(),
  readSignInMethods: vi.fn(),
  startStepUp: vi.fn(),
  writePortableArchive: vi.fn(),
  wordsOf: (/** @type {unknown} */ error, fallback = "Something went wrong.") => {
    const message = /** @type {{ message?: unknown } | null | undefined} */ (error)?.message;
    return typeof message === "string" && message !== "" ? message : fallback;
  },
}));
vi.mock("$lib/data/workspace.js", () => ws);

const page = createPageLoader("archive-file-changed-before-import");
const LIMITS = { archiveFileBytes: 2_000_000_000, passphraseMin: 12, passphraseMax: 256 };

beforeEach(() => {
  for (const fn of Object.values(ws)) if (typeof fn.mockReset === "function") fn.mockReset();
  ws.previewPortableArchive.mockResolvedValue({
    householdName: "Home", items: 2, sections: 1, documents: 0, documentsExcluded: 0, conflicts: [],
  });
});
afterEach(() => page.unmount());
afterAll(() => page.teardown());

/** @param {HTMLElement} target @param {string} text */
const buttonWith = (target, text) => /** @type {HTMLButtonElement} */ ([...target.querySelectorAll("button")].find((b) => b.textContent?.includes(text)));

describe("a file that changed on disk before the import (#1605 W-R12)", () => {
  it("is called what it is: the file changed, choose it again", async () => {
    const { target, flushSync } = await page.mount("routes/household/[id]/DeskArchive.svelte", {
      householdId: "h1", householdName: "Home", entries: 2, sections: 1, limits: LIMITS,
    });
    // The "bring one in" tab, then the file through the card's own input.
    buttonWith(target, "bring one in")?.click();
    flushSync();
    const input = /** @type {HTMLInputElement} */ (target.querySelector('input[type="file"]'));
    const file = new File(["{}"], "home.orbit", { type: "application/octet-stream" });
    Object.defineProperty(input, "files", { configurable: true, get: () => [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    await settle();

    const passphrase = /** @type {HTMLInputElement} */ (target.querySelector("#arch-pp-in"));
    passphrase.value = "a-long-enough-passphrase";
    passphrase.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    buttonWith(target, "look inside").click();
    flushSync();
    await settle();
    expect(ws.previewPortableArchive).toHaveBeenCalledTimes(1);

    ws.importPortableArchive.mockRejectedValue(new DOMException(
      "The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.",
      "NotReadableError",
    ));
    const bring = () => buttonWith(target, "bring in 2");
    bring().click();
    flushSync();
    buttonWith(target, "tap again").click();
    flushSync();
    await settle();

    expect(ws.importPortableArchive).toHaveBeenCalledTimes(1);
    const refusal = target.querySelector(".refuse")?.textContent ?? "";
    expect(refusal, "the card says why").toMatch(/changed/i);
    expect(refusal).toMatch(/choose (it|the file) again|pick (it|the file) again/i);
  });
});
