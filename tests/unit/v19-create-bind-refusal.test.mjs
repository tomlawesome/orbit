// @vitest-environment happy-dom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1406: an item and its file save together or not at all. Three rules about
 * what the create forms do when the server refuses the BIND (the one
 * item.upsert that names the staged file) with 422 "That document is no
 * longer available -- pick it again":
 *
 *  1. Re-staging after the sweep. A staged file not bound within 24 hours is
 *     retired by the sweep, and the server then answers a re-stage under the
 *     same document id with 503 "needs recovery" for ever. The member still
 *     holds the file, so the next Add must succeed: the form must not keep
 *     re-sending the retired id.
 *  2. Picking the same file again. A browser's file input fires `change` only
 *     when its value changes, so the desk must clear the input's value after
 *     each take, or choosing the same file again does nothing.
 *  3. One wording. The desk and the pocket show the same words for the same
 *     refusal.
 *
 * Same harness as v19-create-partial-landing-words.test.mjs: the desk's real
 * behaviour module on a copy of its markup, the pocket's real component
 * compiled and mounted, both over the real workspace.js and a stubbed server.
 * The stub here remembers which staged documents the sweep has retired.
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

const BIND_WORDS = "That document is no longer available — pick it again";

const workspace = {
  activeHouseholdId: "hh-1",
  households: [{
    id: "hh-1", name: "Home", currency: "GBP", items: [],
    sections: [{ id: "s-home", name: "Home", accent: "a", visible: true }],
  }],
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

/* ---- the stubbed server, which remembers what the sweep retired ---------- */

/** Every real request the form made, in order: stage or command. */
let calls = [];
/** Document ids the server holds as staged and usable. */
let staged = new Set();
/** Document ids the sweep has retired: re-staging one is "needs recovery", binding one is refused. */
let retired = new Set();
/** How many binds the server refuses (retiring the file as it does) before it accepts. */
let refusals = 1;
/** How many stage calls the server refuses with 409 "document_not_available" before it accepts (#1316). */
let stageRefusals = 0;
/** When true, the first document id a stage sees is answered 409 "document_conflict" (#1316 P-33: the id is held under another household); any other id is accepted. */
let conflictOnFirstId = false;
/** The document id the conflict answer was given for. */
let conflictId = null;
const CONFLICT_WORDS = "That document identity is already in use";

function stubFetch() {
  calls = [];
  staged = new Set();
  retired = new Set();
  refusals = 1;
  stageRefusals = 0;
  conflictOnFirstId = false;
  conflictId = null;
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const href = String(url);
    if (href.includes("/api/auth/session")) return json({ user: { id: "u1" }, csrfToken: "t1" });
    if (href.endsWith("/api/workspace") && !init?.method) return json({ workspace });
    if (href.includes("/api/workspace/commands") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (body.dryRun) return json({});
      calls.push({ kind: "command", url: href, init, body });
      const ids = body.documentIds ?? [];
      if (ids.some((id) => retired.has(id) || !staged.has(id))) {
        return json({ error: { code: "document_not_available", message: BIND_WORDS } }, 422);
      }
      if (refusals > 0) {
        refusals -= 1;
        for (const id of ids) { staged.delete(id); retired.add(id); }
        return json({ error: { code: "document_not_available", message: BIND_WORDS } }, 422);
      }
      return json({ workspace });
    }
    if (/\/api\/households\/[^/]+\/documents$/u.test(href) && init?.method === "POST") {
      calls.push({ kind: "stage", url: href, init });
      const id = init.headers["x-orbit-document-id"];
      if (stageRefusals > 0) {
        stageRefusals -= 1;
        return json({ error: { code: "document_not_available", message: BIND_WORDS } }, 409);
      }
      if (conflictOnFirstId) {
        conflictId ??= id;
        if (id === conflictId) return json({ error: { code: "document_conflict", message: CONFLICT_WORDS } }, 409);
      }
      if (retired.has(id)) {
        return json({ error: { code: "document_upload_recoverable", message: "That document upload needs recovery" } }, 503);
      }
      staged.add(id);
      return json({ document: { id, displayName: "policy.pdf" } }, 201);
    }
    if (href.endsWith("/item-document-inspection") && init?.method === "POST") {
      return json({ extracted: false, suggestions: [], attachmentDisposition: "attachable", reason: "supported_structure" });
    }
    return json({ error: { code: "unavailable", message: "not today" } }, 503);
  }));
}

const ofKind = (kind) => calls.filter((one) => one.kind === kind);
const header = (call, name) => /** @type {Record<string, string>} */ (call.init.headers)[name];
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
  mounted = mountCreate();
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
  compiledDir = mkdtempSync(resolve(import.meta.dirname, "../../tmp/pocket-bind-refusal-"));
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
  entryForm.props.entry = { ...entryForm.props.entry, name: "Boiler cover", sectionId: "s-home", notes: "the blue folder", provider: "British Gas" };
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
])("#1406: %s after a bind refusal on a staged file the sweep has retired", (_name, fill) => {
  it("the next Add stages and binds successfully: it does not re-send the retired id for a permanent 503", async () => {
    const form = await fill();
    await form.pressAdd();

    expect(ofKind("stage")).toHaveLength(1);
    expect(ofKind("command")).toHaveLength(1);
    expect(goto, "the bind was refused, so the form stays open").not.toHaveBeenCalled();
    const firstId = header(ofKind("stage")[0], "x-orbit-document-id");

    /* The form may ask for the file to be picked again before Add works. The
       member still holds the file either way. */
    if (form.addHeld()) await form.pickFile(pdf("policy.pdf"));
    await form.pressAdd();

    expect(form.note(), "no permanent 'needs recovery'").not.toMatch(/needs recovery/iu);
    const stages = ofKind("stage");
    const lastStage = stages[stages.length - 1];
    const freshId = header(lastStage, "x-orbit-document-id");
    expect(freshId, "a retired document id is not staged again").not.toBe(firstId);
    const commands = ofKind("command");
    expect(commands.length).toBeGreaterThanOrEqual(2);
    expect(commands[commands.length - 1].body.documentIds).toEqual([freshId]);
    expect(goto, "the item and its file saved together").toHaveBeenCalledTimes(1);
  });
});

describe("#1406: the desk clears its file input so the same file can be picked again", () => {
  it("the input is empty after a file is taken", async () => {
    const form = await fillDesk();
    expect(form.pickerValue()).toBe("");
  });

  it("after a bind refusal, choosing the same file again is accepted and a fresh stage follows", async () => {
    const form = await fillDesk();
    await form.pressAdd();
    expect(ofKind("command")).toHaveLength(1);
    expect(goto).not.toHaveBeenCalled();
    const firstId = header(ofKind("stage")[0], "x-orbit-document-id");

    await form.pickFile(pdf("policy.pdf"));
    expect(form.addHeld(), "the same file, taken again, does not leave Add held").toBe(false);
    await form.pressAdd();

    const stages = ofKind("stage");
    expect(stages.length, "the file was staged again").toBeGreaterThanOrEqual(2);
    expect(header(stages[stages.length - 1], "x-orbit-document-id")).not.toBe(firstId);
    expect(goto).toHaveBeenCalledTimes(1);
  });
});

describe("#1406: the desk and the pocket say the same words for a bind refusal", () => {
  it("shows the identical message on both surfaces, and it tells the member to pick the file again", async () => {
    const desk = await fillDesk();
    await desk.pressAdd();
    const deskWords = words(desk.note());
    mounted?.teardown();
    mounted = null;
    document.body.innerHTML = "";
    document.body.className = "";
    goto.mockClear();
    stubFetch();

    const pocket = await fillPocket();
    await pocket.pressAdd();
    const pocketWords = words(pocket.note());

    expect(deskWords, "the desk says something").not.toBe("");
    expect(deskWords).toMatch(/pick it again/iu);
    expect(pocketWords).toBe(deskWords);
  });
});

/* ---- #1316: the stage itself says the id is retired --------------------------
   A staged file the 24-hour sweep retired (pending_deletion, later deleted)
   used to be answered "needs recovery" for ever when staged again under its id.
   The server now answers that re-stage 409 "document_not_available" -- the
   same refusal bindRefused() reads -- so the form must stage the file afresh
   under a new id and save, whether it does so inside the same Add or on the
   member's next Add (the member still holds the file either way). */
describe.each([
  ["the desk form", fillDesk],
  ["the pocket form", fillPocket],
])("#1316: %s when the stage answers 409 document_not_available for the retired id", (_name, fill) => {
  it("stages the file again under a different document id and then saves", async () => {
    const form = await fill();
    refusals = 0; // the bind is not what refuses here: the first stage is
    stageRefusals = 1;
    await form.pressAdd();
    const firstStages = ofKind("stage");
    expect(firstStages.length, "the first Add reached the stage").toBeGreaterThanOrEqual(1);
    const firstId = header(firstStages[0], "x-orbit-document-id");

    /* Either the same Add already retried and saved, or the member presses Add
       again (picking the file again first if the form asks for it). */
    if (goto.mock.calls.length === 0) {
      if (form.addHeld()) await form.pickFile(pdf("policy.pdf"));
      await form.pressAdd();
    }

    const stages = ofKind("stage");
    expect(stages.length, "a second stage call followed the refused one").toBeGreaterThanOrEqual(2);
    const freshId = header(stages[stages.length - 1], "x-orbit-document-id");
    expect(freshId, "the refused (retired) document id is not staged again").not.toBe(firstId);
    const commands = ofKind("command");
    expect(commands, "the item was saved").toHaveLength(1);
    expect(commands[0].body.documentIds, "bound to the freshly staged id").toEqual([freshId]);
    expect(goto, "the item and its file saved together").toHaveBeenCalledTimes(1);
  });
});

/* ---- #1316 P-33: the stage says the id is held under another household -----
   The pocket stages under an id cached per File, with the household read at
   press time. After a save whose answer was lost, a member of two households
   picks the other household and presses Add: the same id reaches the stage
   under another household and is refused 409 "document_conflict". The pocket
   must stage the same held file afresh under a new id within that press,
   as it does for "document_not_available", instead of showing the refusal on
   every press until the file is removed and picked again. */
describe("#1316: the pocket form when the stage answers 409 document_conflict for the cached id", () => {
  it("stages the held file again under a different id within the same Add, and saves with the second id", async () => {
    const form = await fillPocket();
    refusals = 0; // the bind is not what refuses here: the first stage is
    conflictOnFirstId = true;
    await form.pressAdd();

    const stages = ofKind("stage");
    expect(stages.length, "two stage calls within the one press").toBe(2);
    const firstId = header(stages[0], "x-orbit-document-id");
    const secondId = header(stages[1], "x-orbit-document-id");
    expect(secondId, "the refused id is not staged again").not.toBe(firstId);
    const commands = ofKind("command");
    expect(commands, "the item was saved").toHaveLength(1);
    expect(commands[0].body.documentIds, "bound to the second id").toEqual([secondId]);
    expect(form.note(), "no conflict wording left on screen").not.toMatch(/already in use/iu);
    expect(goto, "the form reports added").toHaveBeenCalledTimes(1);
  });
});
