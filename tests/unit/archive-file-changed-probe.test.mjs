// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPageLoader, settle } from "../support/svelte-page.mjs";

/*
 * #1605 b1 W-R12 (review): a browser does not hand a changed file's
 * NotReadableError to the import. A File that changed on disk inside FormData
 * makes fetch reject with a TypeError. So the card reads one byte of the file
 * before it sends anything: that read throws NotReadableError for a changed
 * file, the card says the file changed and to choose it again, and nothing is
 * sent. Both cards (desk and pocket).
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
vi.mock("$lib/pocket/wake.js", () => ({ wake: vi.fn() }));

const page = createPageLoader("archive-file-changed-probe");
const LIMITS = { archiveFileBytes: 2_000_000_000, passphraseMin: 12, passphraseMax: 256 };

beforeEach(() => {
  for (const fn of Object.values(ws)) if (typeof fn.mockReset === "function") fn.mockReset();
  ws.previewPortableArchive.mockResolvedValue({
    householdName: "Home", items: 2, sections: 1, documents: 0, documentsExcluded: 0, conflicts: [],
  });
  ws.importPortableArchive.mockResolvedValue({ importedItems: 2 });
});
afterEach(() => page.unmount());
afterAll(() => page.teardown());

/** @param {HTMLElement} target @param {string} text */
const buttonWith = (target, text) => /** @type {HTMLButtonElement} */ ([...target.querySelectorAll("button")].find((b) => b.textContent?.includes(text)));

/** A picked file that reads for the preview, then changes on disk before the import. */
function fileThatChanges() {
  const file = new File(["{}"], "home.orbit", { type: "application/octet-stream" });
  let changed = false;
  const slice = file.slice.bind(file);
  file.slice = (/** @type {any[]} */ ...args) => {
    const part = slice(...args);
    if (changed) {
      part.arrayBuffer = () => Promise.reject(new DOMException("The requested file could not be read.", "NotReadableError"));
    }
    return part;
  };
  return { file, change: () => { changed = true; } };
}

describe.each([
  ["routes/household/[id]/DeskArchive.svelte", "#arch-pp-in", ".refuse"],
  ["routes/household/[id]/PocketArchive.svelte", "#hh-pass-in", ".p-error"],
])("%s: a file that changed before the import (#1605 W-R12)", (component, passphraseField, refusalClass) => {
  it("is read before sending, not sent, and called changed", async () => {
    const { target, flushSync } = await page.mount(component, {
      householdId: "h1", householdName: "Home", entries: 2, sections: 1, limits: LIMITS,
    });
    buttonWith(target, "bring one in")?.click();
    flushSync();
    const input = /** @type {HTMLInputElement} */ (target.querySelector('input[type="file"]'));
    const { file, change } = fileThatChanges();
    Object.defineProperty(input, "files", { configurable: true, get: () => [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    await settle();
    const passphrase = /** @type {HTMLInputElement} */ (target.querySelector(passphraseField));
    passphrase.value = "a-long-enough-passphrase";
    passphrase.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    buttonWith(target, "look inside").click();
    flushSync();
    await settle();
    expect(ws.previewPortableArchive).toHaveBeenCalledTimes(1);

    change();
    buttonWith(target, "bring in 2").click();
    flushSync();
    buttonWith(target, "tap again").click();
    flushSync();
    await settle();

    expect(ws.importPortableArchive).not.toHaveBeenCalled();
    const refusal = target.querySelector(refusalClass)?.textContent ?? "";
    expect(refusal).toMatch(/changed/i);
    expect(refusal).toMatch(/choose (it|the file) again/i);
  });
});
