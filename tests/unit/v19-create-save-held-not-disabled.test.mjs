// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1327: since ADR-0034 the create form's save button waits for the engine's
 * dry run (~300 ms after the last keystroke plus a round trip). Held with the
 * `disabled` attribute it left the tab order for that whole time, so typing
 * the last field and pressing Tab at once skipped save. The standard pattern
 * is `aria-disabled="true"`: the button stays focusable, and activation is
 * ignored while the engine has not answered or refuses.
 *
 * The first part drives the desk form's real behaviour module on a minimal
 * copy of its markup, with the engine's check held open by the test. The
 * second pins the other dry-run-gated save buttons against their own text.
 */

/** @type {{ resolve: (refusal: string | null) => void } | null} */
let pendingCheck = null;
const applyCommand = vi.fn(async () => ({}));
const goto = vi.fn(async () => {});

vi.mock("$app/navigation", () => ({ goto: (...args) => goto(...args) }));
vi.mock("$lib/data/workspace.js", () => ({
  WorkspaceError: class WorkspaceError extends Error {},
  activeHousehold: async () => ({
    id: "hh-1", currency: "GBP",
    sections: [{ id: "s-home", name: "Home", accent: "a", visible: true }],
  }),
  applyCommand: (...args) => applyCommand(...args),
  attachItemDocument: async () => ({}),
  checkCommand: () => new Promise((done) => { pendingCheck = { resolve: done }; }),
}));

const { mountCreate } = await import("../../web/src/routes/create/create.behaviour.js");

const MARKUP = `
  <form id="card" novalidate>
    <div id="disclose">
      <div id="types"><button type="button" data-type="service" aria-pressed="false">service</button></div>
      <div id="sections"></div>
      <div id="field-date"><input id="f-date" type="date"></div>
      <div class="f-recur"><select id="f-recur"><option value="0">once</option></select>
        <input id="f-recur-months" hidden></div>
      <input id="f-cost"><input id="f-provider"><input id="f-ref"><textarea id="f-notes"></textarea>
      <select id="f-reminder"><option value="14">14</option></select>
    </div>
    <input id="f-name">
    <div id="dropzone"></div><span id="dz-held-name"></span><span id="dz-held-size"></span><div id="dz-live"></div>
    <div class="save-row">
      <div class="save-note" id="save-note"></div>
      <button type="submit" class="btn-primary">Add to orbit</button>
    </div>
  </form>
  <div id="readcard"></div><div id="read-head"></div><div id="focusline"></div><div id="focuswhy"></div>
  <img id="sheet-page"><div id="rc-capline"></div><div id="rc-honest"></div><div id="rc-file"></div>
  <div id="rc-size"></div><div id="rc-scan"></div><button id="rc-drop" type="button"></button><div id="docnote"></div>
`;

/** @type {{ teardown: () => void } | null} */
let mounted = null;
beforeEach(() => {
  vi.useFakeTimers();
  pendingCheck = null;
  applyCommand.mockClear();
  goto.mockClear();
  document.body.innerHTML = MARKUP;
});
afterEach(() => {
  mounted?.teardown();
  mounted = null;
  vi.useRealTimers();
});

/** Let promises and the dry run's 300 ms timer settle. */
const settle = async () => { await vi.advanceTimersByTimeAsync(400); };

describe("#1327: the desk create form's save button stays focusable while the engine checks", () => {
  it("is aria-disabled, focusable and inert while the dry run is pending, then saves once it passes", async () => {
    mounted = mountCreate();
    const save = /** @type {HTMLButtonElement} */ (document.querySelector(".btn-primary"));
    const card = /** @type {HTMLFormElement} */ (document.getElementById("card"));
    const name = /** @type {HTMLInputElement} */ (document.getElementById("f-name"));
    await settle(); // the household loads; the form's first question is now out

    name.value = "Gutter clearing";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("#sections button")?.dispatchEvent(new Event("click", { bubbles: true }));

    // Pending: nothing has answered yet.
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(save.hasAttribute("disabled")).toBe(false);
    save.focus();
    expect(document.activeElement).toBe(save);

    // Activation (click, or Enter in a field) does nothing.
    save.click();
    card.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await settle();
    expect(applyCommand).not.toHaveBeenCalled();

    // The engine passes the entry: the button is released and activation saves.
    await vi.advanceTimersByTimeAsync(400);
    pendingCheck?.resolve(null);
    await settle();
    expect(save.hasAttribute("aria-disabled")).toBe(false);
    expect(save.hasAttribute("disabled")).toBe(false);
    save.click();
    await settle();
    expect(applyCommand).toHaveBeenCalledTimes(1);
  });

  it("stays focusable and leaves the refusal showing when the engine refuses", async () => {
    mounted = mountCreate();
    const save = /** @type {HTMLButtonElement} */ (document.querySelector(".btn-primary"));
    const note = /** @type {HTMLElement} */ (document.getElementById("save-note"));
    await settle();
    pendingCheck?.resolve("not yet — give it a name");
    await settle();

    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(save.hasAttribute("disabled")).toBe(false);
    expect(note.textContent).toBe("not yet — give it a name");
    save.focus();
    expect(document.activeElement).toBe(save);
    save.click();
    await settle();
    expect(applyCommand).not.toHaveBeenCalled();
    expect(note.textContent).toBe("not yet — give it a name");
  });
});

describe("#1327: the other dry-run-gated save buttons are held by aria-disabled, not `disabled`", () => {
  const read = (p) => readFileSync(resolve(import.meta.dirname, "../..", p), "utf8");
  /** The opening tag of the button whose label is `label`, from the file's text. */
  const gated = [
    ["web/src/routes/create/pocket.svelte", 'class="p-pill filled pk-save"'],
    ["web/src/lib/pocket/ReviewSheet.svelte", 'class="p-pill filled rv-go"'],
    ["web/src/routes/home/FootRow.svelte", 'class="act-accent"'],
    ["web/src/routes/home/SuggestionView.svelte", 'class="yes" disabled={adding}'],
    ["web/src/routes/home/SuggestionDrawer.svelte", "p-pill filled"],
  ];
  it.each(gated)("%s", (file, marker) => {
    const text = read(file);
    const at = text.indexOf(marker);
    expect(at, `${marker} in ${file}`).toBeGreaterThan(-1);
    const tag = text.slice(text.lastIndexOf("<button", at), text.indexOf("</button>", at));
    expect(tag).toMatch(/aria-disabled=\{/u);
    expect(tag).not.toMatch(/(?<![-\w])disabled=\{[^}]*(refus|held)/u);
  });
});
