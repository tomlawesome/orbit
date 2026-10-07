// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { screenScope } from "../../web/src/lib/teardown.js";

/*
 * #1244: dragging a file over the desk's drop zone gave no sign it had
 * registered. The owner-approved mockup (design/v19/create-dragover.html,
 * "8a yes") and Fable's build notes (note 31008 on #1244) add three states
 * from two classes on <body>: `dragging` while a file is anywhere over the
 * page, `over` while it is over the zone, and the zone's own `landed` settle
 * on the drop.
 *
 * The drag events are driven here under happy-dom, which has no DragEvent:
 * a plain bubbling Event carrying a `dataTransfer` reads the same to the
 * handlers. The flicker trap the notes name -- dragenter/dragleave bubble
 * from every child the pointer crosses -- is the case that matters most.
 * The markup and the sheet are pinned against the files' own text;
 * tests/e2e/v19-create.spec.ts dispatches real DragEvents in a browser.
 */

const root = resolve(import.meta.dirname, "../..");
const read = (/** @type {string} */ p) => readFileSync(resolve(root, p), "utf8");

/**
 * @param {string} type
 * @param {EventTarget} target
 * @param {{ types?: string[], files?: File[] }} [carry]
 */
function drag(type, target, { types = ["Files"], files = [] } = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types, files, dropEffect: "" } });
  target.dispatchEvent(event);
  return /** @type {Event & { dataTransfer: { dropEffect: string } }} */ (event);
}

const body = () => document.body.classList;

/** @type {{ teardown: () => void } | null} */
let scope = null;
/** @type {HTMLElement} */
let zone;
/** @type {HTMLElement} */
let child;
/** @type {HTMLElement} */
let live;
/** @type {HTMLElement} */
let outside;
/** @type {import('vitest').Mock} */
let takeFile;
/** @type {{ clear: () => void }} */
let feedback;

beforeEach(async () => {
  vi.stubGlobal("requestAnimationFrame", (/** @type {() => void} */ fn) => setTimeout(fn, 0));
  vi.stubGlobal("cancelAnimationFrame", (/** @type {number} */ id) => clearTimeout(id));
  document.body.className = "";
  document.body.innerHTML = `
    <div id="outside">elsewhere</div>
    <div id="dropzone"><div class="dz-main"><span data-when="rest">drop a document</span></div></div>
    <div id="dz-live" aria-live="polite"></div>`;
  zone = /** @type {HTMLElement} */ (document.getElementById("dropzone"));
  child = /** @type {HTMLElement} */ (zone.querySelector("span"));
  live = /** @type {HTMLElement} */ (document.getElementById("dz-live"));
  outside = /** @type {HTMLElement} */ (document.getElementById("outside"));
  takeFile = vi.fn();
  const { wireDropFeedback } = await import("../../web/src/routes/create/drop-feedback.js");
  const made = screenScope();
  scope = made;
  feedback = wireDropFeedback({ on: made.on, dropzone: zone, live, takeFile });
});

afterEach(() => {
  scope?.teardown();
  feedback?.clear();
  vi.unstubAllGlobals();
});

describe("#1244: the drop zone answers a file in the air", () => {
  it("arms when a file comes over the page, and only for a file", () => {
    drag("dragenter", outside, { types: ["text/plain"] });
    expect(body().contains("dragging")).toBe(false);
    drag("dragenter", outside);
    expect(body().contains("dragging")).toBe(true);
    expect(body().contains("over")).toBe(false);
  });

  it("locks on over the zone, and does not flicker off crossing its own text", () => {
    drag("dragenter", outside);
    drag("dragenter", zone);
    expect(body().contains("over")).toBe(true);
    // The pointer moves from the zone's padding onto its words: the child's
    // dragenter arrives, then the zone's own dragleave.
    drag("dragenter", child);
    drag("dragleave", zone);
    expect(body().contains("over")).toBe(true);
    // And out of the zone altogether: the lock goes, the page stays armed.
    drag("dragleave", child);
    expect(body().contains("over")).toBe(false);
    expect(body().contains("dragging")).toBe(true);
  });

  it("clears both states when the file leaves the page", () => {
    drag("dragenter", outside);
    drag("dragenter", zone);
    drag("dragleave", zone);
    drag("dragleave", outside);
    expect(body().contains("dragging")).toBe(false);
    expect(body().contains("over")).toBe(false);
  });

  it("clears a drag the window lost without a dragleave, on blur or the next mousemove", () => {
    drag("dragenter", zone);
    window.dispatchEvent(new Event("blur"));
    expect(body().contains("dragging") || body().contains("over")).toBe(false);
    drag("dragenter", zone);
    window.dispatchEvent(new Event("mousemove"));
    expect(body().contains("dragging") || body().contains("over")).toBe(false);
  });

  it("refuses a drop off the zone, so the browser never opens the file", () => {
    drag("dragenter", outside);
    const off = drag("dragover", outside);
    expect(off.defaultPrevented).toBe(true);
    expect(off.dataTransfer.dropEffect).toBe("none");
    const on = drag("dragover", child);
    expect(on.defaultPrevented).toBe(true);
    expect(on.dataTransfer.dropEffect).toBe("copy");
    const dropped = drag("drop", outside, { files: [new File(["x"], "stray.pdf")] });
    expect(dropped.defaultPrevented).toBe(true);
    expect(takeFile).not.toHaveBeenCalled();
    expect(body().contains("dragging")).toBe(false);
  });

  it("takes the dropped file, settles the zone and says so politely", async () => {
    const file = new File(["%PDF"], "renewal.pdf", { type: "application/pdf" });
    drag("dragenter", zone);
    await vi.waitFor(() => expect(live.textContent).toBe("Release to add the document"));
    const dropped = drag("drop", child, { files: [file] });
    expect(dropped.defaultPrevented).toBe(true);
    expect(takeFile).toHaveBeenCalledWith(file);
    expect(body().contains("dragging") || body().contains("over")).toBe(false);
    expect(zone.classList.contains("landed")).toBe(true);
    await vi.waitFor(() => expect(live.textContent).toBe("renewal.pdf added. Reading it in the lane on the right."));
  });

  it("offers a swap when a document is already held", async () => {
    document.body.classList.add("doc");
    drag("dragenter", zone);
    await vi.waitFor(() => expect(live.textContent).toBe("Release to swap the document"));
  });

  it("hands every class back on the way out", () => {
    drag("dragenter", zone);
    zone.classList.add("landed");
    feedback.clear();
    expect(body().contains("dragging") || body().contains("over")).toBe(false);
    expect(zone.classList.contains("landed")).toBe(false);
  });
});

describe("#1244: the zone's markup and sheet carry the mockup's look", () => {
  const page = read("web/src/routes/create/+page.svelte");
  const css = read("web/src/routes/create/create.css");
  const behaviour = read("web/src/routes/create/create.behaviour.js");

  it("draws the four brackets, one copy of the words per state, and a polite live region", () => {
    for (const corner of ["tl", "tr", "br", "bl"]) {
      expect(page).toContain(`<span class="dz-corner ${corner}" aria-hidden="true"></span>`);
    }
    expect(page).toMatch(/<span data-when="lock">release to add it<\/span>/u);
    expect(page).toMatch(/<span data-when="swap">release to swap the document<\/span>/u);
    expect(page).toMatch(/<span data-when="arm">bring it to this box &middot; PDF, email or photo<\/span>/u);
    expect(page).toMatch(/<span data-when="lock">orbit will read what it can &middot; nothing is saved until you say<\/span>/u);
    expect(page).toMatch(/<div class="sr-only" id="dz-live" aria-live="polite"><\/div>/u);
    expect(page).toContain('aria-label="drop a document, or press enter to choose one"');
  });

  it("styles the armed, locked and landed states from the build notes", () => {
    expect(css).toContain("body.dragging .create-page .dropzone{border-color:color-mix(in srgb, var(--accent) 55%, var(--line))}");
    expect(css).toMatch(/body\.over \.create-page \.dropzone\{border-style:solid;border-color:var\(--accent\);\s*background:color-mix\(in srgb, var\(--accent\) 10%, transparent\)\}/u);
    expect(css).toContain("body.over .create-page .dz-corner{opacity:1;--dx:0px;--dy:0px;animation:dz-pull 3.6s ease-in-out infinite}");
    expect(css).toContain("@keyframes dz-pull{0%,100%{opacity:1}50%{opacity:.55}}");
    expect(css).toMatch(/body\.doc \.dropzone\.landed\{animation:dz-landed \.6s cubic-bezier\(\.3,\.7,\.2,1\) backwards\}/u);
    expect(css).toMatch(/@keyframes dz-landed\{/u);
  });

  it("is wired through the screen's own scope and torn down with it", () => {
    expect(behaviour).toMatch(/wireDropFeedback\(\{ on, dropzone, live: [^}]*, takeFile \}\)/u);
    expect(behaviour).toMatch(/dropFeedback\.clear\(\)/u);
  });
});
