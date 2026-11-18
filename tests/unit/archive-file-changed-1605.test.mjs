// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPageLoader, settle } from "../support/svelte-page.mjs";

/*
 * #1605 W-R12: if the chosen archive file changes on disk between look-inside
 * and bring-in, the upload used to fail with a bare connection error ("could
 * not reach Orbit"), and nothing said the file changed. Before the import
 * upload, bring-in reads one byte of the chosen file (`slice(0, 1)
 * .arrayBuffer()`). When that throws, nothing is uploaded and the card says
 * the file changed, in archive.js's words (FILE_CHANGED_WORDS), never the
 * connection error. Both the desk card and the pocket card.
 */
const ws = vi.hoisted(() => ({
  importPortableArchive: vi.fn(), previewPortableArchive: vi.fn(), readSignInMethods: vi.fn(),
  startStepUp: vi.fn(), writePortableArchive: vi.fn(),
  wordsOf: (/** @type {unknown} */ e) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("$lib/data/workspace.js", () => ws);

const { FILE_CHANGED_WORDS } = await import("../../web/src/routes/household/[id]/archive.js");
const WORDS = `not brought in — ${FILE_CHANGED_WORDS}`;
const PASSPHRASE = "correct horse battery staple";
const LIMITS = { archiveFileBytes: 1_000_000, passphraseMin: 12, passphraseMax: 200 };
const PREVIEW = { householdName: "Home", items: 2, sections: 1, documents: 0, documentsExcluded: false, conflicts: [] };

const loader = createPageLoader("archive-file-changed-1605", { stub: (file) => /\/Sheet\.svelte$/.test(file) });
beforeEach(() => {
  for (const fn of [ws.importPortableArchive, ws.previewPortableArchive, ws.readSignInMethods, ws.startStepUp, ws.writePortableArchive]) fn.mockReset();
  ws.previewPortableArchive.mockResolvedValue(PREVIEW);
  ws.importPortableArchive.mockResolvedValue({ importedItems: 2 });
});
afterEach(() => { loader.unmount(); });
afterAll(() => loader.teardown());

/** A small archive file (under the 64-byte v2 header, so look-inside sends it whole), with its one-byte read stubbed. */
function archiveFile(name, { changed }) {
  const file = new File(["{}"], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "slice", {
    value: () => ({ arrayBuffer: () => (changed ? Promise.reject(new DOMException("changed", "NotReadableError")) : Promise.resolve(new ArrayBuffer(1))) }),
  });
  return file;
}

const CARDS = [
  { name: "DeskArchive", path: "routes/household/[id]/DeskArchive.svelte", pass: "#arch-pp-in" },
  { name: "PocketArchive", path: "routes/household/[id]/PocketArchive.svelte", pass: "#hh-pass-in" },
];

describe.each(CARDS)("$name: a chosen file that changed since it was chosen", ({ path, pass }) => {
  /** @type {{ target: HTMLElement, flushSync: () => void }} */
  let screen;
  const button = (/** @type {string} */ text) =>
    [...screen.target.querySelectorAll("button")].find((one) => (one.textContent ?? "").replace(/\s+/g, " ").includes(text));
  const press = async (/** @type {string} */ text) => {
    const found = button(text);
    expect(found, `a "${text}" button`).toBeTruthy();
    /** @type {HTMLButtonElement} */ (found).click();
    await settle();
    screen.flushSync();
  };
  const choose = async (/** @type {File} */ file) => {
    const input = /** @type {HTMLInputElement} */ (screen.target.querySelector('input[type="file"]'));
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    screen.flushSync();
  };
  const typePassphrase = async () => {
    const input = /** @type {HTMLInputElement} */ (screen.target.querySelector(pass));
    input.value = PASSPHRASE;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    screen.flushSync();
  };
  /** Up to the preview with `file` chosen, then bring in. */
  async function bringIn(file) {
    screen = await loader.mount(path, { householdId: "h1", householdName: "Home", entries: 3, sections: 2, limits: LIMITS });
    await choose(file);
    await typePassphrase();
    await press("look inside");
    await press("bring in 2 entries");
    await press("bring in 2 entries"); // the second tap fires (two-tap)
  }

  it("is not uploaded, and the card says the file changed, not that Orbit could not be reached", async () => {
    await bringIn(archiveFile("home.orbit", { changed: true }));
    expect(ws.importPortableArchive).not.toHaveBeenCalled();
    const text = (screen.target.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain(WORDS);
    expect(text).not.toContain("could not reach Orbit");
  });

  it("keeps the passphrase: choosing a file again asks for none", async () => {
    await bringIn(archiveFile("home.orbit", { changed: true }));
    await choose(archiveFile("home.orbit", { changed: false }));
    expect(/** @type {HTMLInputElement} */ (screen.target.querySelector(pass)).value).toBe(PASSPHRASE);
  });

  it("a file that has not changed is still sent", async () => {
    await bringIn(archiveFile("home.orbit", { changed: false }));
    expect(ws.importPortableArchive).toHaveBeenCalledTimes(1);
    expect((screen.target.textContent ?? "")).not.toContain(WORDS);
  });
});
