// @vitest-environment happy-dom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1316 (owner decision, 2026-10-12, option a): when a create half-lands --
 * the item is recorded, its document is refused (say a 503 from the scanner)
 * -- the form tells the truth: "The item is recorded, but its document needs
 * another try -- try once more to finish." The message must not begin "not
 * saved" (the item is saved), must say the item is recorded and the document
 * needs another try, and must name the refusal's own words. The form stays
 * open, and a second press of Add re-sends the item and the document under
 * the same item id and document id.
 *
 * The desk's real behaviour module is driven on a minimal copy of its markup
 * (as v19-create-save-held-not-disabled.test.mjs does) over the real
 * workspace.js and a stubbed fetch, so the refusal travels the whole way.
 *
 * The pocket's form is a Svelte component, which no plain unit test can mount
 * without a browser, so pocket.svelte is compiled here with Svelte's own
 * compiler and mounted in happy-dom, over the same workspace.js and stubbed
 * fetch. Only its three child components are stood in for: EntryForm (the
 * test fills the entry and the picked file through the bindings EntryForm
 * would), Sheet and Sky, which have no part in saving.
 */

/** What the stand-in EntryForm was handed: the pocket's `entry` and `attachment` bindings. */
const entryForm = vi.hoisted(() => ({ props: /** @type {any} */ (null) }));
vi.mock("../../web/src/routes/create/EntryForm.svelte", () => ({
  default: (/** @type {unknown} */ _anchor, /** @type {any} */ props) => { entryForm.props = props; },
}));
vi.mock("../../web/src/lib/pocket/Sheet.svelte", () => ({ default: () => {} }));
vi.mock("../../web/src/lib/pocket/Sky.svelte", () => ({ default: () => {} }));

const REFUSAL = "The virus scanner is not available just now";
const goto = vi.fn(async () => {});
vi.mock("$app/navigation", () => ({ goto: (...args) => goto(...args), beforeNavigate: () => {} }));

/** @type {{ url: string, init: RequestInit }[]} */
let saves = [];
/** @type {{ url: string, init: RequestInit }[]} */
let attaches = [];
/** The item save's answers, in order; the last one repeats. @type {("ok" | "version_required")[]} */
let itemAnswers = [];
/** The document attach's statuses, in order; the last one repeats. @type {number[]} */
let attachStatuses = [];
/** When set, the item save and the document read wait here until the test answers them. */
let held = /** @type {{ save: ((response: Response) => void) | null, read: ((response: Response) => void) | null } | null} */ (null);

const workspace = {
  activeHouseholdId: "hh-1",
  households: [{
    id: "hh-1", name: "Home", currency: "GBP", items: [],
    sections: [{ id: "s-home", name: "Home", accent: "a", visible: true }],
  }],
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function stubFetch() {
  saves = [];
  attaches = [];
  held = null;
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const href = String(url);
    if (held && href.endsWith("/item-document-inspection") && init?.method === "POST") {
      return new Promise((answer) => { held.read = answer; });
    }
    if (href.includes("/api/auth/session")) return json({ user: { id: "u1" }, csrfToken: "t1" });
    if (href.endsWith("/api/workspace") && !init?.method) return json({ workspace });
    if (href.includes("/api/workspace/commands") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (body.dryRun) return json({});
      saves.push({ url: href, init });
      if (held) return new Promise((answer) => { held.save = answer; });
      const answer = itemAnswers[Math.min(saves.length, itemAnswers.length) - 1];
      if (answer === "version_required") {
        return json({ error: { code: "version_required", message: "This item changed on another device; refresh and try again" } }, 409);
      }
      return json({ workspace });
    }
    if (/\/items\/[^/]+\/documents$/u.test(href) && init?.method === "POST") {
      attaches.push({ url: href, init });
      const status = attachStatuses[Math.min(attaches.length, attachStatuses.length) - 1];
      if (status >= 400) return json({ error: { code: "scanner_unavailable", message: REFUSAL } }, status);
      return json({ document: { id: "d1", displayName: "policy.pdf" } }, status);
    }
    // The document read and the page preview: unavailable, which is not a refusal of the file.
    return json({ error: { code: "unavailable", message: "not today" } }, 503);
  }));
}

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
  vi.resetModules();
  vi.useFakeTimers();
  goto.mockClear();
  document.body.className = "";
  document.body.innerHTML = MARKUP;
  stubFetch();
});
afterEach(() => {
  mounted?.teardown();
  mounted = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Let promises and the dry run's 300 ms timer settle. */
const settle = async () => { await vi.advanceTimersByTimeAsync(400); };

/** The words beside Add, and the facts they must carry. */
function expectHalfLandedWords(/** @type {string} */ words) {
  expect(words, "a message is shown beside Add").not.toBe("");
  expect(words, "the item is saved, so the message does not begin 'not saved'").not.toMatch(/^\s*not saved/iu);
  expect(words, "says the item is recorded").toMatch(/\brecorded\b/iu);
  expect(words, "says the document needs another try").toMatch(/another try/iu);
  expect(words, "names the refusal's words").toContain(REFUSAL);
}

describe("#1316: the desk form's words when the item landed and its document was refused", () => {
  it.each(["ok", "version_required"])(
    "item save answers %s, document refused: says recorded, another try, and the refusal's words",
    async (answer) => {
      itemAnswers = [/** @type {"ok" | "version_required"} */ (answer)];
      attachStatuses = [503];
      const { mountCreate } = await import("../../web/src/routes/create/create.behaviour.js");
      mounted = mountCreate();
      await settle();
      const name = /** @type {HTMLInputElement} */ (document.getElementById("f-name"));
      name.value = "Boiler cover";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#sections button")?.dispatchEvent(new Event("click", { bubbles: true }));
      const picker = /** @type {HTMLInputElement} */ (document.querySelector('#card input[type="file"]'));
      Object.defineProperty(picker, "files", { value: [new File([new Uint8Array([37, 80, 68, 70])], "policy.pdf", { type: "application/pdf" })] });
      picker.dispatchEvent(new Event("change", { bubbles: true }));
      await settle();

      document.getElementById("card")?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      await settle();

      expect(saves, "the item was sent").toHaveLength(1);
      expect(attaches, "the document was sent").toHaveLength(1);
      expect(goto, "the form stays open").not.toHaveBeenCalled();
      expectHalfLandedWords(/** @type {HTMLElement} */ (document.getElementById("save-note")).textContent ?? "");
    },
  );

  it("a read refused while Add is pending does not skip the upload: the file held at submit is sent and the words are shown", async () => {
    held = { save: null, read: null };
    attachStatuses = [503];
    const { mountCreate } = await import("../../web/src/routes/create/create.behaviour.js");
    mounted = mountCreate();
    await settle();
    const name = /** @type {HTMLInputElement} */ (document.getElementById("f-name"));
    name.value = "Boiler cover";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("#sections button")?.dispatchEvent(new Event("click", { bubbles: true }));
    const picker = /** @type {HTMLInputElement} */ (document.querySelector('#card input[type="file"]'));
    Object.defineProperty(picker, "files", { value: [new File([new Uint8Array([37, 80, 68, 70])], "policy.pdf", { type: "application/pdf" })] });
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(held.read, "the read is still pending when Add is pressed").not.toBeNull();

    document.getElementById("card")?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await settle();
    expect(saves, "the item save is pending").toHaveLength(1);
    expect(held.save, "applyCommand is waiting on its answer").not.toBeNull();

    // While applyCommand is pending, the read is answered: refused.
    held.read?.(json({ attachmentDisposition: "rejected", message: REFUSAL }));
    await settle();
    // Then the item save answers ok.
    held.save?.(json({ workspace }));
    await settle();

    expect(attaches, "the upload was still attempted").toHaveLength(1);
    const sent = /** @type {File} */ (attaches[0].init.body);
    expect(sent.name, "with the file held at submit").toBe("policy.pdf");
    expect(sent.size).toBe(4);
    expect(goto, "the form does not navigate away silently").not.toHaveBeenCalled();
    expectHalfLandedWords(/** @type {HTMLElement} */ (document.getElementById("save-note")).textContent ?? "");
  });

  it("a second press of Add sends the item and the document again under the same ids", async () => {
    itemAnswers = ["ok", "version_required"];
    attachStatuses = [503, 201];
    const { mountCreate } = await import("../../web/src/routes/create/create.behaviour.js");
    mounted = mountCreate();
    await settle();
    const name = /** @type {HTMLInputElement} */ (document.getElementById("f-name"));
    name.value = "Boiler cover";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("#sections button")?.dispatchEvent(new Event("click", { bubbles: true }));
    const picker = /** @type {HTMLInputElement} */ (document.querySelector('#card input[type="file"]'));
    Object.defineProperty(picker, "files", { value: [new File([new Uint8Array([37, 80, 68, 70])], "policy.pdf", { type: "application/pdf" })] });
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    const card = /** @type {HTMLFormElement} */ (document.getElementById("card"));

    card.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await settle();
    expectHalfLandedWords(/** @type {HTMLElement} */ (document.getElementById("save-note")).textContent ?? "");
    card.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await settle();

    expect(saves, "the item is sent again").toHaveLength(2);
    expect(attaches, "the document is sent again").toHaveLength(2);
    const itemIds = saves.map((one) => JSON.parse(String(one.init.body)).item.id);
    expect(itemIds[0]).toBeTruthy();
    expect(itemIds[1]).toBe(itemIds[0]);
    const documentIds = attaches.map((one) => /** @type {Record<string, string>} */ (one.init.headers)["x-orbit-document-id"]);
    expect(documentIds[0]).toBeTruthy();
    expect(documentIds[1]).toBe(documentIds[0]);
    expect(attaches[0].url).toBe(`/api/households/hh-1/items/${itemIds[0]}/documents`);
    expect(attaches[1].url).toBe(attaches[0].url);
    expect(goto, "the retry finished, so the form closes onto the item").toHaveBeenCalledTimes(1);
  });
});

/* ---- the pocket's form ---------------------------------------------------- */

const web = resolve(import.meta.dirname, "../../web");
const svelteSrc = join(web, "node_modules/svelte/src");
/** @type {string} */
let compiledDir;
/** @type {string} */
let compiledPocket;

beforeAll(async () => {
  const { compile } = await import(pathToFileURL(join(svelteSrc, "compiler/index.js")).href);
  const file = join(web, "src/routes/create/pocket.svelte");
  const quoted = (/** @type {string} */ path) => JSON.stringify(path);
  const js = compile(readFileSync(file, "utf8"), { filename: file, generate: "client", dev: false }).js.code
    .replaceAll("'svelte/internal/client'", quoted(join(svelteSrc, "internal/client/index.js")))
    .replaceAll("'svelte/internal/disclose-version'", quoted(join(svelteSrc, "internal/disclose-version.js")))
    .replaceAll('from "svelte"', `from ${quoted(join(svelteSrc, "index-client.js"))}`)
    .replaceAll('"./entry.js"', quoted(join(web, "src/routes/create/entry.js")))
    .replaceAll('"./EntryForm.svelte"', quoted(join(web, "src/routes/create/EntryForm.svelte")))
    .replaceAll('"$lib/pocket/Sheet.svelte"', quoted(join(web, "src/lib/pocket/Sheet.svelte")))
    .replaceAll('"$lib/pocket/Sky.svelte"', quoted(join(web, "src/lib/pocket/Sky.svelte")));
  /* Inside the checkout (tmp/ is git-ignored), so the module resolves Svelte,
     the $lib alias and the vitest transforms the way any web/ module does. */
  mkdirSync(resolve(import.meta.dirname, "../../tmp"), { recursive: true });
  compiledDir = mkdtempSync(resolve(import.meta.dirname, "../../tmp/pocket-partial-landing-"));
  writeFileSync(join(compiledDir, "state.mjs"), 'export const page = { url: new URL("http://localhost/create") };');
  compiledPocket = join(compiledDir, "pocket.mjs");
  writeFileSync(compiledPocket, js.replaceAll('"$app/state"', quoted(join(compiledDir, "state.mjs"))));
});
afterAll(() => { rmSync(compiledDir, { recursive: true, force: true }); });

/** @type {(() => void) | null} */
let unmountPocket = null;
afterEach(() => { unmountPocket?.(); unmountPocket = null; entryForm.props = null; });

/** Mounts the pocket's form and fills it the way EntryForm would: a name, a section and a picked file. */
async function fillPocket() {
  const { mount, unmount, flushSync } = await import(pathToFileURL(join(svelteSrc, "index-client.js")).href);
  const { default: Pocket } = await import(/* @vite-ignore */ compiledPocket);
  const component = mount(Pocket, { target: document.body });
  unmountPocket = () => unmount(component);
  await settle(); // the household loads and the form is ready
  expect(entryForm.props, "the form is on screen").not.toBeNull();
  entryForm.props.entry = { ...entryForm.props.entry, name: "Boiler cover", sectionId: "s-home" };
  entryForm.props.attachment = new File([new Uint8Array([37, 80, 68, 70])], "policy.pdf", { type: "application/pdf" });
  flushSync();
  await settle(); // the engine's check of the filled entry
  const pressAdd = async () => {
    document.getElementById("pocket-entry")?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await settle();
  };
  return { pressAdd, problem: () => document.querySelector(".pk-problem")?.textContent ?? "" };
}

describe("#1316: the pocket form's words when the item landed and its document was refused", () => {
  it.each(["ok", "version_required"])(
    "item save answers %s, document refused: says recorded, another try, and the refusal's words",
    async (answer) => {
      itemAnswers = [/** @type {"ok" | "version_required"} */ (answer)];
      attachStatuses = [503];
      const { pressAdd, problem } = await fillPocket();

      await pressAdd();

      expect(saves, "the item was sent").toHaveLength(1);
      expect(attaches, "the document was sent").toHaveLength(1);
      expect(goto, "the form stays open").not.toHaveBeenCalled();
      expectHalfLandedWords(problem());
    },
  );

  it("a read refused while Add is pending does not skip the upload: the file held at submit is sent and the words are shown", async () => {
    held = { save: null, read: null };
    attachStatuses = [503];
    const { pressAdd, problem } = await fillPocket();
    // EntryForm tells the pocket of a pick through onpick, which starts the document read.
    entryForm.props.onpick(entryForm.props.attachment);
    await settle();
    expect(held.read, "the read is still pending when Add is pressed").not.toBeNull();

    const pressed = pressAdd(); // not awaited: the item save stays pending
    await settle();
    expect(saves, "the item save is pending").toHaveLength(1);
    expect(held.save, "applyCommand is waiting on its answer").not.toBeNull();

    // While the save is pending, the read is answered: refused.
    held.read?.(json({ attachmentDisposition: "rejected", message: REFUSAL }));
    await settle();
    // Then the item save answers ok.
    held.save?.(json({ workspace }));
    await settle();
    await pressed;

    expect(attaches, "the upload was still attempted").toHaveLength(1);
    const sent = /** @type {File} */ (attaches[0].init.body);
    expect(sent.name, "with the file held at submit").toBe("policy.pdf");
    expect(sent.size).toBe(4);
    expect(goto, "the form does not navigate away silently").not.toHaveBeenCalled();
    expectHalfLandedWords(problem());
  });

  it("a second press of Add sends the item and the document again under the same ids", async () => {
    itemAnswers = ["ok", "version_required"];
    attachStatuses = [503, 201];
    const { pressAdd, problem } = await fillPocket();

    await pressAdd();
    expectHalfLandedWords(problem());
    await pressAdd();

    expect(saves, "the item is sent again").toHaveLength(2);
    expect(attaches, "the document is sent again").toHaveLength(2);
    const itemIds = saves.map((one) => JSON.parse(String(one.init.body)).item.id);
    expect(itemIds[0]).toBeTruthy();
    expect(itemIds[1]).toBe(itemIds[0]);
    const documentIds = attaches.map((one) => /** @type {Record<string, string>} */ (one.init.headers)["x-orbit-document-id"]);
    expect(documentIds[0]).toBeTruthy();
    expect(documentIds[1]).toBe(documentIds[0]);
    expect(attaches[0].url).toBe(`/api/households/hh-1/items/${itemIds[0]}/documents`);
    expect(attaches[1].url).toBe(attaches[0].url);
    expect(goto, "the retry finished, so the form closes onto the item").toHaveBeenCalledTimes(1);
  });
});
