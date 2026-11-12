// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1810 W-F3: a file refused as too large says its two lines on the create
 * form's reading lane, as two lines. The words carry a line break, so they
 * must be drawn as one, never as a literal "<br>" in the text.
 */
/** @type {Array<{ page: unknown, read: unknown }>} */
const nextReads = [];
vi.mock("$app/navigation", () => ({ goto: async () => {} }));
vi.mock("$lib/data/workspace.js", async (importOriginal) => ({
  ...(await importOriginal()),
  activeHousehold: async () => ({ id: "hh-1", currency: "GBP", sections: [{ id: "s-home", name: "Home", accent: "a", visible: true }] }),
  checkDraftCommand: async () => null,
  readReminders: async () => ({ firstWarningDays: null, finalWarningDays: null }),
}));
vi.mock("$lib/data/document-read.js", async (importOriginal) => {
  const real = /** @type {Record<string, unknown>} */ (await importOriginal());
  return { ...real, readPickedDocument: (/** @type {unknown[]} */ ...args) =>
    nextReads.length ? nextReads.shift() : /** @type {Function} */ (real.readPickedDocument)(...args) };
});

const MARKUP = `
  <form id="card" novalidate>
    <div id="disclose">
      <div id="types"><button type="button" data-type="service" aria-pressed="false">service</button></div>
      <div id="sections"></div>
      <div id="field-date"><input id="f-date" type="date"></div>
      <div class="f-recur"><select id="f-recur"><option value="0">once</option></select><input id="f-recur-months" hidden></div>
      <div id="field-cost"><input id="f-cost"></div><div id="field-provider"><input id="f-provider"></div>
      <div id="field-ref"><input id="f-ref"></div><textarea id="f-notes"></textarea>
      <select id="f-reminder"><option value="14">14</option></select>
    </div>
    <input id="f-name">
    <div id="dropzone"></div><span id="dz-held-name"></span><span id="dz-held-size"></span><div id="dz-live"></div>
    <div class="save-row"><div class="save-note" id="save-note"></div><button type="submit" class="btn-primary">Add to orbit</button></div>
  </form>
  <div id="readcard"></div><div id="read-head"></div><div id="focusline"></div><div id="focuswhy"></div>
  <img id="sheet-page"><div id="rc-capline"></div><div id="rc-honest"></div><div id="rc-file"></div>
  <div id="rc-size"></div><div id="rc-refused"></div><div id="rc-scan"></div><button id="rc-drop" type="button"></button><div id="docnote"></div>
`;
const settle = () => new Promise((done) => setTimeout(done, 20));

/** @type {{ teardown: () => void } | null} */
let mounted = null;
beforeEach(() => {
  vi.resetModules();
  nextReads.length = 0;
  document.body.innerHTML = MARKUP;
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() }));
});
afterEach(() => {
  mounted?.teardown();
  mounted = null;
  vi.unstubAllGlobals();
});

describe("W-F3: the too-large refusal on the create lane", () => {
  it("draws its two lines as two lines, with no literal <br>", async () => {
    const { WHY_TOO_LARGE } = await import("../../web/src/lib/data/document-read.js");
    const { mountCreate } = await import("../../web/src/routes/create/create.behaviour.js");
    mounted = mountCreate();
    await settle();
    nextReads.push({
      page: Promise.resolve({ kind: "undrawable", why: WHY_TOO_LARGE }),
      read: Promise.resolve({ kind: "unread", message: "this file is too large to send" }),
    });
    const picker = /** @type {HTMLInputElement} */ (document.querySelector('#card input[type="file"]'));
    Object.defineProperty(picker, "files", { configurable: true, value: [new File([new Uint8Array([37, 80, 68, 70])], "big.pdf", { type: "application/pdf" })] });
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();

    const why = /** @type {HTMLElement} */ (document.getElementById("focuswhy"));
    expect(why.textContent).toContain("choose a smaller document");
    expect(why.textContent).not.toContain("<br>");
    expect(why.querySelectorAll("br")).toHaveLength(1);
  });
});
