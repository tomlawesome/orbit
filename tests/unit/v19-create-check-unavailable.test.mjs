// @vitest-environment happy-dom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1593: when Orbit's structure check could not run, the server answers 503
 * `document_check_unavailable` -- "The file couldn't be uploaded. Please try
 * again." -- at the stage and at the "check this file" step. The member must
 * read that as a retry: the server's own words, the file NOT marked refused
 * (it is not the file's fault), Add not held, nothing saved, and the next Add
 * going through once the check runs again. Never "choose another file".
 *
 * Same harness as v19-create-bind-refusal.test.mjs: the desk's real behaviour
 * module on a copy of its markup, the pocket's real component compiled and
 * mounted, both over the real workspace.js and a stubbed server.
 */

/** What the stand-in EntryForm was handed: the pocket's `entry`, `attachment` and `picked`. */
const entryForm = vi.hoisted(() => ({ props: /** @type {any} */ (null) }));
vi.mock("../../web/src/routes/create/EntryForm.svelte", () => ({
  default: (/** @type {unknown} */ _anchor, /** @type {any} */ props) => { entryForm.props = props; },
}));
vi.mock("../../web/src/lib/pocket/Sheet.svelte", () => ({ default: () => {} }));
vi.mock("../../web/src/lib/pocket/Sky.svelte", () => ({ default: () => {} }));

const goto = vi.fn(async () => {});
vi.mock("$app/navigation", () => ({ goto: (...args) => goto(...args), beforeNavigate: () => {} }));

const UNAVAILABLE_WORDS = "The file couldn't be uploaded. Please try again.";

const workspace = {
  activeHouseholdId: "hh-1",
  households: [{
    id: "hh-1", name: "Home", currency: "GBP", items: [],
    sections: [{ id: "s-home", name: "Home", accent: "a", visible: true }],
  }],
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

/* ---- the stubbed server, whose structure check can fail to run ----------- */

/** Every real request the form made, in order: stage or command. */
let calls = [];
/** How many stages the server answers 503 document_check_unavailable before it accepts. */
let stageUnavailable = 0;
/** What the check step answers: "ok", or "unavailable" (503 document_check_unavailable). */
let inspection = "ok";

function stubFetch() {
  calls = [];
  stageUnavailable = 0;
  inspection = "ok";
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const href = String(url);
    if (href.includes("/api/auth/session")) return json({ user: { id: "u1" }, csrfToken: "t1" });
    if (href.endsWith("/api/workspace") && !init?.method) return json({ workspace });
    if (href.includes("/api/workspace/commands") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (body.dryRun) return json({});
      calls.push({ kind: "command", url: href, init, body });
      return json({ workspace });
    }
    if (/\/api\/households\/[^/]+\/documents$/u.test(href) && init?.method === "POST") {
      calls.push({ kind: "stage", url: href, init });
      if (stageUnavailable > 0) {
        stageUnavailable -= 1;
        return json({ error: { code: "document_check_unavailable", message: UNAVAILABLE_WORDS } }, 503);
      }
      return json({ document: { id: init.headers["x-orbit-document-id"], displayName: "policy.pdf" } }, 201);
    }
    if (href.endsWith("/item-document-inspection") && init?.method === "POST") {
      if (inspection === "unavailable") {
        return json({ error: { code: "document_check_unavailable", message: UNAVAILABLE_WORDS } }, 503);
      }
      return json({ extracted: false, suggestions: [], attachmentDisposition: "attachable", reason: "supported_structure" });
    }
    return json({ error: { code: "unavailable", message: "not today" } }, 503);
  }));
}

const ofKind = (kind) => calls.filter((one) => one.kind === kind);
const pdf = (name) => new File([new Uint8Array([37, 80, 68, 70])], name, { type: "application/pdf" });

/** Let promises and the dry run's 300 ms timer settle. */
const settle = async () => { await vi.advanceTimersByTimeAsync(400); };

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  goto.mockClear();
  document.body.className = "";
  stubFetch();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/* ---- the desk form --------------------------------------------------------- */

const MARKUP = `
  <form id="card" novalidate>
    <div id="disclose">
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
  <div id="rc-size"></div><div id="rc-refused"></div><div id="rc-scan"></div><button id="rc-drop" type="button"></button><div id="docnote"></div>
`;

/** @type {{ teardown: () => void } | null} */
let mounted = null;
afterEach(() => {
  mounted?.teardown();
  mounted = null;
});

const text = (/** @type {string} */ id) => document.getElementById(id)?.textContent ?? "";


/**
 * Fills the desk form and picks a file through a file input that behaves like
 * a browser's: it holds the chosen path as its `value`, fires `change` only
 * when that value changes, and goes back to empty when the page sets it to "".
 */
async function fillDesk() {
  document.body.innerHTML = MARKUP;
  const { mountCreate } = await import("../../web/src/routes/create/create.behaviour.js");
  mounted = mountCreate({ importance: { get: () => "normal", setColour: () => {} } });
  await settle();
  const type = (/** @type {string} */ id, /** @type {string} */ value) => {
    const field = /** @type {HTMLInputElement} */ (document.getElementById(id));
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  };
  type("f-name", "Boiler cover");
  document.querySelector("#sections button")?.dispatchEvent(new Event("click", { bubbles: true }));
  const picker = /** @type {HTMLInputElement} */ (document.querySelector('#card input[type="file"]'));
  const card = /** @type {HTMLFormElement} */ (document.getElementById("card"));
  const save = /** @type {HTMLElement} */ (document.querySelector(".btn-primary"));
  let chosen = "";
  let files = /** @type {File[]} */ ([]);
  Object.defineProperty(picker, "value", {
    configurable: true,
    get: () => chosen,
    set: (next) => { if (next === "") { chosen = ""; files = []; } },
  });
  Object.defineProperty(picker, "files", { configurable: true, get: () => files });
  const pickFile = async (/** @type {File} */ file) => {
    const path = `C:\\fakepath\\${file.name}`;
    const changed = chosen !== path;
    chosen = path;
    files = [file];
    if (changed) picker.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
  };
  await pickFile(pdf("policy.pdf"));
  return {
    pickFile,
    pickerValue: () => picker.value,
    pressAdd: async () => { card.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true })); await settle(); },
    note: () => text("save-note"),
    addHeld: () => save.getAttribute("aria-disabled") === "true",
    fileName: () => text("dz-held-name"),
    fileMarkedRefused: () => /refused/iu.test(text("dz-held-name")),
    fieldsKept: () => {
      expect(/** @type {HTMLInputElement} */ (document.getElementById("f-name")).value).toBe("Boiler cover");
    },
  };
}

/* ---- the pocket's form ----------------------------------------------------- */

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
  compiledDir = mkdtempSync(resolve(import.meta.dirname, "../../tmp/pocket-check-unavailable-"));
  writeFileSync(join(compiledDir, "state.mjs"), 'export const page = { url: new URL("http://localhost/create") };');
  compiledPocket = join(compiledDir, "pocket.mjs");
  writeFileSync(compiledPocket, js.replaceAll('"$app/state"', quoted(join(compiledDir, "state.mjs"))));
});
afterAll(() => { rmSync(compiledDir, { recursive: true, force: true }); });

/** @type {(() => void) | null} */
let unmountPocket = null;
afterEach(() => { unmountPocket?.(); unmountPocket = null; entryForm.props = null; });

/** Mounts the pocket's form and fills it the way EntryForm would: fields, then a picked file. */
async function fillPocket() {
  const { mount, unmount, flushSync } = await import(pathToFileURL(join(svelteSrc, "index-client.js")).href);
  const { default: Pocket } = await import(/* @vite-ignore */ compiledPocket);
  const component = mount(Pocket, { target: document.body });
  unmountPocket = () => unmount(component);
  await settle(); // the household loads and the form is ready
  expect(entryForm.props, "the form is on screen").not.toBeNull();
  entryForm.props.entry = { ...entryForm.props.entry, importance: "normal", name: "Boiler cover", sectionId: "s-home", notes: "the blue folder", provider: "British Gas" };
  flushSync();
  await settle(); // the engine's check of the filled entry
  const pickFile = async (/** @type {File} */ file) => {
    entryForm.props.attachment = file;
    // EntryForm tells the pocket of a pick through onpick, which starts the document read.
    entryForm.props.onpick(file);
    flushSync();
    await settle();
  };
  await pickFile(pdf("policy.pdf"));
  const pressAdd = async () => {
    document.getElementById("pocket-entry")?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await settle();
  };
  return {
    drawsItsOwnWords: false,
    pickFile,
    pressAdd,
    pressAddPending: pressAdd,
    note: () => document.querySelector(".pk-problem")?.textContent ?? "",
    everything: () => `${document.body.textContent ?? ""} ${entryForm.props.picked?.why ?? ""} ${entryForm.props.picked?.line ?? ""}`,
    addHeld: () => document.querySelector(".pk-save")?.getAttribute("aria-disabled") === "true",
    fileName: () => entryForm.props.attachment?.name ?? "",
    fileMarkedRefused: () => entryForm.props.picked?.refused === true && String(entryForm.props.picked?.why ?? "").length > 0,
    fieldsKept: () => {
      expect(entryForm.props.entry).toMatchObject({ name: "Boiler cover", notes: "the blue folder", provider: "British Gas" });
    },
    removeFile: async () => {
      // EntryForm clears the file itself and then tells the pocket.
      entryForm.props.attachment = null;
      entryForm.props.ondrop();
      flushSync();
      await settle();
    },
  };
}



/* ---- the scenarios --------------------------------------------------------- */

const words = (/** @type {string} */ note) => note.replace(/\s+/gu, " ").trim();

describe.each([
  ["the desk form", fillDesk],
  ["the pocket form", fillPocket],
])("#1593: %s when the stage answers 503 document_check_unavailable", (_name, fill) => {
  it("tells the member to try again in the server's words, never to choose another file", async () => {
    const form = await fill();
    stageUnavailable = 1;
    await form.pressAdd();

    expect(words(form.note())).toContain(UNAVAILABLE_WORDS);
    expect(form.note()).not.toMatch(/choose another|could not open|pick it again|refused/iu);
    expect(ofKind("stage")).toHaveLength(1);
    expect(ofKind("command"), "nothing is saved without the file").toHaveLength(0);
    expect(goto).not.toHaveBeenCalled();
  });

  it("does not mark the file refused or hold Add: the file is fine and stays attached", async () => {
    const form = await fill();
    stageUnavailable = 1;
    await form.pressAdd();

    expect(form.fileMarkedRefused(), "a temporary failure is not a refused file").toBe(false);
    expect(form.addHeld()).toBe(false);
    expect(form.fileName()).toContain("policy.pdf");
    form.fieldsKept();
  });

  it("the next Add saves the item and its file once the check runs again", async () => {
    const form = await fill();
    stageUnavailable = 1;
    await form.pressAdd();
    expect(goto).not.toHaveBeenCalled();

    await form.pressAdd();

    expect(ofKind("stage")).toHaveLength(2);
    const commands = ofKind("command");
    expect(commands).toHaveLength(1);
    expect(commands[0].body.documentIds).toHaveLength(1);
    expect(goto).toHaveBeenCalledTimes(1);
  });
});

describe("#1593: the desk and the pocket say the same words for it", () => {
  it("shows the identical message on both surfaces", async () => {
    const desk = await fillDesk();
    stageUnavailable = 1;
    await desk.pressAdd();
    const deskWords = words(desk.note());
    mounted?.teardown();
    mounted = null;
    document.body.innerHTML = "";
    document.body.className = "";
    goto.mockClear();
    stubFetch();

    const pocket = await fillPocket();
    stageUnavailable = 1;
    await pocket.pressAdd();
    const pocketWords = words(pocket.note());

    expect(deskWords).toContain(UNAVAILABLE_WORDS);
    expect(pocketWords).toBe(deskWords);
  });
});

describe("#1593: the check step answering 503 document_check_unavailable", () => {
  it("reads as an unread document in the server's words, not a refused file", async () => {
    inspection = "unavailable";
    const { readPickedDocument } = await import("../../web/src/lib/data/document-read.js");
    const { read } = readPickedDocument("hh-1", pdf("policy.pdf"));
    await settle();
    const outcome = await read;

    expect(outcome.kind).toBe("unread");
    expect(outcome.message).toContain(UNAVAILABLE_WORDS);
    expect(outcome.message).not.toMatch(/choose another|choose a copy/iu);
  });

  it("leaves the picked file in the desk form, unrefused and Add not held, with the server's words on screen", async () => {
    inspection = "unavailable";
    const form = await fillDesk();

    expect(document.body.textContent).toContain(UNAVAILABLE_WORDS);
    expect(document.body.textContent).not.toMatch(/choose another/iu);
    expect(form.addHeld()).toBe(false);
  });

  it("leaves the picked file in the pocket form, unrefused and Add not held, with the server's words on screen", async () => {
    inspection = "unavailable";
    const form = await fillPocket();

    expect(form.everything()).toContain(UNAVAILABLE_WORDS);
    expect(form.everything()).not.toMatch(/choose another/iu);
    expect(form.fileMarkedRefused()).toBe(false);
    expect(form.addHeld()).toBe(false);
  });
});

describe("#1593: workspace.js treats the 503 as a temporary failure, not a file refusal", () => {
  it("is not a refusesFile code, and unsavedWords carries the server's words as a retry", async () => {
    const { WorkspaceError, refusesFile, unsavedWords } = await import("../../web/src/lib/data/workspace.js");
    const error = new WorkspaceError(UNAVAILABLE_WORDS, { status: 503, code: "document_check_unavailable" });

    expect(refusesFile(error)).toBe(false);
    expect(unsavedWords(error)).toContain(UNAVAILABLE_WORDS);
  });

  it("still treats an invalid structure and a password as a refused file", async () => {
    const { WorkspaceError, refusesFile } = await import("../../web/src/lib/data/workspace.js");

    expect(refusesFile(new WorkspaceError("x", { status: 422, code: "document_structure_invalid" }))).toBe(true);
    expect(refusesFile(new WorkspaceError("x", { status: 422, code: "document_password_required" }))).toBe(true);
  });
});
