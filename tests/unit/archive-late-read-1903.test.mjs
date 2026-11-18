// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPageLoader, settle } from "../support/svelte-page.mjs";

/*
 * #1903 (after #1605 W-R12): bring-in reads one byte of the chosen file
 * before the upload. While a file is being brought in, only the "bringing it
 * in · N entries" status shows (and, on the desk, the step-up challenge):
 * no "choose another file", no "bring in" button, and a stray change event
 * on the file input is ignored. A failed bring returns to the preview with
 * its buttons and the refusal. Desk and pocket cards.
 * Harness as archive-file-changed-1605.test.mjs.
 */
const ws = vi.hoisted(() => ({
  importPortableArchive: vi.fn(), previewPortableArchive: vi.fn(), readSignInMethods: vi.fn(),
  startStepUp: vi.fn(), writePortableArchive: vi.fn(),
  wordsOf: (/** @type {unknown} */ e) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("$lib/data/workspace.js", () => ws);

const WORDS = "the file changed after it was chosen — choose it again";
const PASSPHRASE = "correct horse battery staple";
const LIMITS = { archiveFileBytes: 1_000_000, passphraseMin: 12, passphraseMax: 200 };
const PREVIEW = { householdName: "Home", items: 2, sections: 1, documents: 0, documentsExcluded: false, conflicts: [] };

const loader = createPageLoader("archive-late-read-1903", { stub: (file) => /\/Sheet\.svelte$/.test(file) });
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

describe.each(CARDS)("$name: while a file is brought in", ({ path, pass }) => {
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

  it("while the read is held only the bringing status shows: no choose-another, no bring-in", async () => {
    const old = heldFile("old.orbit");
    await startHeldBringIn(old);

    expect(text()).toContain("bringing it in");
    expect(button("choose another file"), "no choose another file").toBeUndefined();
    expect(button("bring in"), "no bring-in button").toBeUndefined();
    expect(button("tap again"), "no armed bring-in button").toBeUndefined();
    await afterRead(old.read.ok);
  });

  it("the read succeeds: the old file is uploaded once and the card reaches brought in", async () => {
    const old = heldFile("old.orbit");
    await startHeldBringIn(old);
    await afterRead(old.read.ok);

    expect(ws.importPortableArchive).toHaveBeenCalledTimes(1);
    expect(ws.importPortableArchive.mock.calls[0][1].file).toBe(old.file);
    expect(text()).toContain("brought in");
  });

  it("the read fails: back to the preview with both buttons and the file-changed words", async () => {
    const old = heldFile("old.orbit");
    await startHeldBringIn(old);
    await afterRead(old.read.fail);

    expect(ws.importPortableArchive).not.toHaveBeenCalled();
    expect(button("bring in 2 entries"), "bring-in is back").toBeTruthy();
    expect(button("choose another file"), "choose another file is back").toBeTruthy();
    expect(text()).toContain(WORDS);
  });

  it("a change event on the file input while bringing is ignored; the old file is uploaded once", async () => {
    const old = heldFile("old.orbit");
    await startHeldBringIn(old);
    await choose(plainFile("new.orbit"));

    expect(text()).not.toContain("new.orbit");
    expect(text()).toContain("bringing it in");
    await afterRead(old.read.ok);
    expect(ws.importPortableArchive).toHaveBeenCalledTimes(1);
    expect(ws.importPortableArchive.mock.calls[0][1].file).toBe(old.file);
    expect(text()).not.toContain("new.orbit");
  });
});

describe("DeskArchive: the step-up challenge during an import", () => {
  /** @type {{ target: HTMLElement, flushSync: () => void }} */
  let screen;
  const text = () => (screen.target.textContent ?? "").replace(/\s+/g, " ");
  const click = async (/** @type {string} */ label) => {
    const found = [...screen.target.querySelectorAll("button")].find((one) => (one.textContent ?? "").replace(/\s+/g, " ").includes(label));
    expect(found, `a "${label}" button`).toBeTruthy();
    /** @type {HTMLButtonElement} */ (found).click();
    await settle();
    screen.flushSync();
  };

  it("renders once, with its password field, when the import asks for proof", async () => {
    ws.readSignInMethods.mockResolvedValue({ local: { set: true } });
    ws.importPortableArchive.mockRejectedValueOnce(Object.assign(new Error("sign in again"), { code: "recent_authentication_required" }));
    screen = await loader.mount(CARDS[0].path, { householdId: "h1", householdName: "Home", entries: 3, sections: 2, limits: LIMITS });
    const input = /** @type {HTMLInputElement} */ (screen.target.querySelector('input[type="file"]'));
    Object.defineProperty(input, "files", { value: [plainFile("old.orbit")], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(); screen.flushSync();
    const pp = /** @type {HTMLInputElement} */ (screen.target.querySelector("#arch-pp-in"));
    pp.value = PASSPHRASE;
    pp.dispatchEvent(new Event("input", { bubbles: true }));
    await settle(); screen.flushSync();
    await click("look inside");
    await click("bring in 2 entries");
    await click("bring in 2 entries");
    await settle(); screen.flushSync();

    expect(screen.target.querySelectorAll("#arch-proof")).toHaveLength(1);
    expect(text()).toContain("sign in again");
  });
});
