// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPageLoader, settle } from "../support/svelte-page.mjs";

/*
 * #1605 W-R12, round two: bring-in reads one byte of the chosen file before
 * the upload. While that read is in flight, "choose another file" or a new
 * pick makes its late result moot: it must neither upload the old file nor
 * clear the new pick (file, preview, phase, words). Desk and pocket cards.
 * Harness as archive-file-changed-1605.test.mjs.
 */
const ws = vi.hoisted(() => ({
  importPortableArchive: vi.fn(), previewPortableArchive: vi.fn(), readSignInMethods: vi.fn(),
  startStepUp: vi.fn(), writePortableArchive: vi.fn(),
  wordsOf: (/** @type {unknown} */ e) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("$lib/data/workspace.js", () => ws);

const WORDS = "this file changed since you chose it";
const PASSPHRASE = "correct horse battery staple";
const LIMITS = { archiveFileBytes: 1_000_000, passphraseMin: 12, passphraseMax: 200 };
const PREVIEW = { householdName: "Home", items: 2, sections: 1, documents: 0, documentsExcluded: false, conflicts: [] };

const loader = createPageLoader("archive-late-read-1605", { stub: (file) => /\/Sheet\.svelte$/.test(file) });
beforeEach(() => {
  for (const fn of [ws.importPortableArchive, ws.previewPortableArchive, ws.readSignInMethods, ws.startStepUp, ws.writePortableArchive]) fn.mockReset();
  ws.previewPortableArchive.mockResolvedValue(PREVIEW);
  ws.importPortableArchive.mockResolvedValue({ importedItems: 2 });
});
afterEach(() => { loader.unmount(); });
afterAll(() => loader.teardown());

/** A file whose one-byte read is held until `settleRead` is called. */
function heldFile(name) {
  /** @type {{ ok: () => void, fail: () => void }} */
  const read = { ok: () => {}, fail: () => {} };
  const file = new File(["{}"], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "slice", {
    value: () => ({ arrayBuffer: () => new Promise((resolve, reject) => {
      read.ok = () => resolve(new ArrayBuffer(1));
      read.fail = () => reject(new DOMException("changed", "NotReadableError"));
    }) }),
  });
  return { file, read };
}
const plainFile = (/** @type {string} */ name) => new File(["{}"], name, { type: "application/octet-stream" });

const CARDS = [
  { name: "DeskArchive", path: "routes/household/[id]/DeskArchive.svelte", pass: "#arch-pp-in" },
  { name: "PocketArchive", path: "routes/household/[id]/PocketArchive.svelte", pass: "#hh-pass-in" },
];

describe.each(CARDS)("$name: a late one-byte read of a file no longer chosen", ({ path, pass }) => {
  /** @type {{ target: HTMLElement, flushSync: () => void }} */
  let screen;
  const text = () => (screen.target.textContent ?? "").replace(/\s+/g, " ");
  const button = (/** @type {string} */ label) =>
    [...screen.target.querySelectorAll("button")].find((one) => (one.textContent ?? "").replace(/\s+/g, " ").includes(label));
  const press = async (/** @type {string} */ label) => {
    const found = button(label);
    expect(found, `a "${label}" button`).toBeTruthy();
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
  /** Chooses the held file, gets to the preview and fires bring-in, whose one-byte read stays pending. */
  async function startHeldBringIn(old) {
    screen = await loader.mount(path, { householdId: "h1", householdName: "Home", entries: 3, sections: 2, limits: LIMITS });
    await choose(old.file);
    await typePassphrase();
    await press("look inside");
    await press("bring in 2 entries");
    await press("bring in 2 entries");
  }
  const afterRead = async (/** @type {() => void} */ finish) => { finish(); await settle(); screen.flushSync(); };

  it("choose another file, then pick a new one; the old read succeeds late: nothing is uploaded and the new pick stands", async () => {
    const old = heldFile("old.orbit");
    await startHeldBringIn(old);
    await press("choose another file");
    await choose(plainFile("new.orbit"));
    await afterRead(old.read.ok);

    expect(ws.importPortableArchive, "the old file is not uploaded").not.toHaveBeenCalled();
    expect(text()).toContain("new.orbit");
  });

  it("choose another file, then pick a new one; the old read fails late: the new pick is not cleared and no words are said", async () => {
    const old = heldFile("old.orbit");
    await startHeldBringIn(old);
    await press("choose another file");
    await choose(plainFile("new.orbit"));
    await afterRead(old.read.fail);

    expect(text()).toContain("new.orbit");
    expect(text()).not.toContain(WORDS);
    expect(button("look inside"), "still at the new pick's step").toBeTruthy();
  });

  it("a new pick made straight over the held read: the old read's late success uploads nothing", async () => {
    const old = heldFile("old.orbit");
    await startHeldBringIn(old);
    await choose(plainFile("new.orbit"));
    await afterRead(old.read.ok);

    expect(ws.importPortableArchive).not.toHaveBeenCalled();
    expect(text()).toContain("new.orbit");
  });
});
