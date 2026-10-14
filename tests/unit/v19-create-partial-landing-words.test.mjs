// @vitest-environment happy-dom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1316 (owner, 2026-10-13): creating an item with a document is
 * all-or-nothing. This file replaces the round-2 "partial landing" words
 * (R1-20 / R2-8: "The item is recorded, but its document needs another try")
 * with the new rule, on both forms:
 *
 *  - Save stages the document first (stageDocument, POST
 *    /api/households/:id/documents), then sends ONE item.upsert carrying
 *    `documentIds`. The item and its document land together or not at all, so
 *    no sentence says half of one landed.
 *  - A stage the server refuses (a 413, 415 or 422: size, type, structure, malware) sends
 *    no command at all. Everything entered stays, the file included; the file
 *    is marked refused with the server's own words, and Add is held until the
 *    file is replaced or removed (owner's answer 6a). Removing it lets Add
 *    save without it.
 *  - A read that refuses the file (the inspection says "rejected") is held the
 *    same way instead of dropping the file from the form.
 *  - Network loss and a 5xx keep the form and say so honestly, and a retry
 *    re-sends the same ids. A lost answer followed by version_required means
 *    the whole item landed: go home.
 *
 * The desk's real behaviour module is driven on a minimal copy of its markup
 * (as v19-create-save-held-not-disabled.test.mjs does) over the real
 * workspace.js and a stubbed fetch, so every answer travels the whole way.
 *
 * The pocket's form is a Svelte component, which no plain unit test can mount
 * without a browser, so pocket.svelte is compiled here with Svelte's own
 * compiler and mounted in happy-dom, over the same workspace.js and stubbed
 * fetch. Only its three child components are stood in for: EntryForm (the
 * test fills the entry and the picked file through the bindings EntryForm
 * would), Sheet and Sky, which have no part in saving.
 *
 * The same scenarios run against both forms through one small driver each.
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

/** The server's own words for a file it will not keep. */
const FILE_WORDS = "That file is not a PDF or image we can keep";
const ENGINE_WORDS = "not yet — give it a name";
const NETWORK_WORDS = "not saved — couldn't reach Orbit; check the connection and try again";
const SERVER_WORDS = "not saved — Orbit had a problem; try again";

const workspace = {
  activeHouseholdId: "hh-1",
  households: [{
    id: "hh-1", name: "Home", currency: "GBP", items: [],
    sections: [{ id: "s-home", name: "Home", accent: "a", visible: true }],
  }],
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

/* ---- the stubbed server ------------------------------------------------- */

/** Every real request the form made, in order: stage, command, item-document attach. */
let calls = [];
/** The live checks (dry runs) the form asked while it was being filled. */
let dryRuns = [];
/** Answers in order (the last repeats). A function may return or throw. */
let stageAnswers = [];
let commandAnswers = [];
let inspectAnswers = [];
/** When a gate is set, the next request of that kind waits for the test to answer it. */
let gates = { stage: false, read: false };
let pending = { stage: null, read: null };

const stagedOk = (status = 201) => () => json({ document: { id: "d1", displayName: "policy.pdf" } }, status);
const refusedFile = () => json({ error: { code: "document_unsupported_type", message: FILE_WORDS } }, 422);
const lostNetwork = () => { throw new TypeError("Failed to fetch"); };
const serverDown = () => new Response("", { status: 500 });
const commandOk = () => json({ workspace });
const commandVersionRequired = () =>
  json({ error: { code: "version_required", message: "This item changed on another device; refresh and try again" } }, 409);
const commandRefused = () => json({ error: { code: "item_name_missing", message: ENGINE_WORDS } }, 422);
const attachable = () => json({ extracted: false, suggestions: [], attachmentDisposition: "attachable", reason: "supported_structure" });
const rejectedByRead = () => json({ attachmentDisposition: "rejected", message: FILE_WORDS });

const next = (answers, count) => answers[Math.min(count, answers.length) - 1];

function stubFetch() {
  calls = [];
  dryRuns = [];
  stageAnswers = [stagedOk()];
  commandAnswers = [commandOk];
  inspectAnswers = [attachable];
  gates = { stage: false, read: false };
  pending = { stage: null, read: null };
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const href = String(url);
    if (href.includes("/api/auth/session")) return json({ user: { id: "u1" }, csrfToken: "t1" });
    if (href.endsWith("/api/workspace") && !init?.method) return json({ workspace });
    if (href.includes("/api/workspace/commands") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (body.dryRun) { dryRuns.push(body); return json({}); }
      calls.push({ kind: "command", url: href, init, body });
      return next(commandAnswers, calls.filter((one) => one.kind === "command").length)();
    }
    if (/\/api\/households\/[^/]+\/documents$/u.test(href) && init?.method === "POST") {
      calls.push({ kind: "stage", url: href, init });
      if (gates.stage) return new Promise((answer) => { pending.stage = answer; });
      return next(stageAnswers, calls.filter((one) => one.kind === "stage").length)();
    }
    if (/\/items\/[^/]+\/documents$/u.test(href) && init?.method === "POST") {
      calls.push({ kind: "attach", url: href, init });
      return json({ document: { id: "d1", displayName: "policy.pdf" } }, 201);
    }
    if (href.endsWith("/item-document-inspection") && init?.method === "POST") {
      calls.push({ kind: "read", url: href, init });
      if (gates.read) return new Promise((answer) => { pending.read = answer; });
      return next(inspectAnswers, calls.filter((one) => one.kind === "read").length)();
    }
    // The page preview: not drawn, which is not a refusal of the file.
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

/** Fills the desk form: a name, a section, two more fields and a picked file. */
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
  type("f-notes", "the blue folder");
  type("f-provider", "British Gas");
  document.querySelector("#sections button")?.dispatchEvent(new Event("click", { bubbles: true }));
  const picker = /** @type {HTMLInputElement} */ (document.querySelector('#card input[type="file"]'));
  const save = /** @type {HTMLElement} */ (document.querySelector(".btn-primary"));
  const card = /** @type {HTMLFormElement} */ (document.getElementById("card"));
  const pickFile = async (/** @type {File} */ file) => {
    Object.defineProperty(picker, "files", { configurable: true, value: [file] });
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
  };
  await pickFile(pdf("policy.pdf"));
  return {
    drawsItsOwnWords: true,
    pickFile,
    pressAdd: async () => { card.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true })); await settle(); },
    /** Presses Add without waiting for the save to finish. */
    pressAddPending: async () => { card.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true })); await settle(); },
    note: () => text("save-note"),
    everything: () => document.body.textContent ?? "",
    addHeld: () => save.getAttribute("aria-disabled") === "true",
    fileName: () => text("dz-held-name"),
    fileMarkedRefused: () => /refused/iu.test(text("dz-held-name")),
    fieldsKept: () => {
      expect(/** @type {HTMLInputElement} */ (document.getElementById("f-name")).value).toBe("Boiler cover");
      expect(/** @type {HTMLInputElement} */ (document.getElementById("f-notes")).value).toBe("the blue folder");
      expect(/** @type {HTMLInputElement} */ (document.getElementById("f-provider")).value).toBe("British Gas");
    },
    removeFile: async () => { document.getElementById("rc-drop")?.dispatchEvent(new Event("click", { bubbles: true })); await settle(); },
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
  compiledDir = mkdtempSync(resolve(import.meta.dirname, "../../tmp/pocket-partial-landing-"));
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

/* ---- the scenarios, run against each form ------------------------------- */

describe.each([
  ["the desk form", fillDesk],
  ["the pocket form", fillPocket],
])("#1316: %s saves an item and its document all-or-nothing", (_name, fill) => {
  it("stages the file first, then sends one command carrying documentIds, and goes to the item", async () => {
    const form = await fill();
    await form.pressAdd();

    expect(calls.filter((one) => one.kind !== "read").map((one) => one.kind), "stage first, then exactly one command").toEqual(["stage", "command"]);
    const [stage, command] = [ofKind("stage")[0], ofKind("command")[0]];
    expect(stage.url).toBe("/api/households/hh-1/documents");
    expect(stage.init.body.name).toBe("policy.pdf");
    const documentId = header(stage, "x-orbit-document-id");
    expect(documentId).toBeTruthy();
    expect(command.body.type).toBe("item.upsert");
    expect(command.body.documentIds).toEqual([documentId]);
    // The ciphertext is sealed under the draft item's id, so the stage names the id the command will use.
    expect(header(stage, "x-orbit-item-id"), "the stage carries the draft item id").toBe(command.body.item.id);
    expect(ofKind("attach"), "the item's own documents route is no longer used to create").toHaveLength(0);
    expect(goto).toHaveBeenCalledTimes(1);
    expect(String(goto.mock.calls[0][0])).toContain(`/home?item=${encodeURIComponent(command.body.item.id)}`);
  });

  it("the live check asked while the member types never carries documentIds: the file is not staged yet, so the engine would refuse it", async () => {
    const form = await fill();
    await form.pressAdd();
    expect(dryRuns.length, "the form did ask the engine while it was filled").toBeGreaterThan(0);
    for (const one of dryRuns) expect(one.documentIds ?? []).toEqual([]);
  });

  it("a scanner outage at the stage (202, held for a scan retry) still saves the item with the document", async () => {
    stageAnswers = [stagedOk(202)];
    const form = await fill();
    await form.pressAdd();
    expect(ofKind("command")).toHaveLength(1);
    expect(ofKind("command")[0].body.documentIds).toEqual([header(ofKind("stage")[0], "x-orbit-document-id")]);
    expect(goto).toHaveBeenCalledTimes(1);
  });

  it("a file the server refuses at the stage sends no command, keeps everything, marks the file refused and holds Add", async () => {
    stageAnswers = [refusedFile];
    const form = await fill();
    await form.pressAdd();

    expect(ofKind("stage")).toHaveLength(1);
    expect(ofKind("command"), "no item is sent").toHaveLength(0);
    expect(goto, "the form stays open").not.toHaveBeenCalled();
    expect(form.note(), "the server's own words, and nothing about a half-saved item").toContain(FILE_WORDS);
    expect(form.note()).toMatch(/^\s*not saved/iu);
    expect(form.note()).not.toMatch(/recorded|another try/iu);
    form.fieldsKept();
    expect(form.fileName(), "the file is still in the form").toContain("policy.pdf");
    expect(form.fileMarkedRefused(), "the file is marked refused").toBe(true);
    expect(form.everything(), "with the server's reason").toContain(FILE_WORDS);
    if (form.drawsItsOwnWords) {
      /* The owner-approved draft: "<name> -- refused: <server reason>. Replace
         it, or remove it to save without it." The pocket draws this in
         EntryForm, which this file stands in for; its markup is the e2e's. */
      expect(form.everything(), "and what to do next").toMatch(/replace/iu);
      expect(form.everything()).toMatch(/remove/iu);
    }
    expect(form.addHeld(), "Add is held").toBe(true);

    await form.pressAdd();
    expect(ofKind("stage"), "a held Add sends nothing more").toHaveLength(1);
    expect(ofKind("command")).toHaveLength(0);
  });

  it("removing the refused file lets Add save the item without it", async () => {
    stageAnswers = [refusedFile];
    const form = await fill();
    await form.pressAdd();
    expect(form.addHeld()).toBe(true);

    await form.removeFile();
    expect(form.addHeld(), "Add is released").toBe(false);
    await form.pressAdd();

    expect(ofKind("stage"), "no second upload for a file that has gone").toHaveLength(1);
    expect(ofKind("command")).toHaveLength(1);
    const { documentIds } = ofKind("command")[0].body;
    expect(documentIds === undefined || documentIds.length === 0).toBe(true);
    form.fieldsKept();
    expect(goto).toHaveBeenCalledTimes(1);
  });

  it("replacing the refused file releases Add, and the new file is staged and bound under its own id", async () => {
    stageAnswers = [refusedFile, stagedOk()];
    const form = await fill();
    await form.pressAdd();
    expect(form.addHeld()).toBe(true);
    const refusedId = header(ofKind("stage")[0], "x-orbit-document-id");

    await form.pickFile(pdf("better.pdf"));
    expect(form.addHeld(), "Add is released by a new file").toBe(false);
    expect(form.fileMarkedRefused(), "the mark belongs to the old file").toBe(false);
    await form.pressAdd();

    const staged = ofKind("stage");
    expect(staged).toHaveLength(2);
    expect(staged[1].init.body.name).toBe("better.pdf");
    const newId = header(staged[1], "x-orbit-document-id");
    expect(newId).not.toBe(refusedId);
    expect(ofKind("command")).toHaveLength(1);
    expect(ofKind("command")[0].body.documentIds).toEqual([newId]);
    expect(goto).toHaveBeenCalledTimes(1);
  });

  it("a file the read refuses stays in the form marked refused, Add is held, and nothing is sent", async () => {
    inspectAnswers = [rejectedByRead];
    const form = await fill();

    expect(form.fileName(), "the file is not dropped from the form").toContain("policy.pdf");
    expect(form.fileMarkedRefused()).toBe(true);
    expect(form.everything()).toContain(FILE_WORDS);
    expect(form.addHeld()).toBe(true);
    form.fieldsKept();

    await form.pressAdd();
    expect(ofKind("stage")).toHaveLength(0);
    expect(ofKind("command")).toHaveLength(0);

    await form.removeFile();
    expect(form.addHeld()).toBe(false);
    await form.pressAdd();
    expect(ofKind("command")).toHaveLength(1);
    expect(goto).toHaveBeenCalledTimes(1);
  });

  it("a read refused while Add is pending: the stage's refusal sends no command, and the file stays marked refused", async () => {
    gates = { stage: true, read: true };
    stageAnswers = [refusedFile];
    const form = await fill();
    expect(pending.read, "the read is still pending when Add is pressed").not.toBeNull();

    await form.pressAddPending();
    expect(ofKind("stage"), "the stage is pending").toHaveLength(1);
    expect(pending.stage).not.toBeNull();

    // While the stage is pending, the read is answered: refused.
    pending.read(rejectedByRead());
    await settle();
    // Then the stage itself is refused.
    pending.stage(refusedFile());
    await settle();

    expect(ofKind("command"), "no item is sent").toHaveLength(0);
    expect(goto).not.toHaveBeenCalled();
    expect(form.note()).toContain(FILE_WORDS);
    expect(form.note()).not.toMatch(/recorded|another try/iu);
    expect(form.fileName(), "the file is still in the form").toContain("policy.pdf");
    expect(form.fileMarkedRefused()).toBe(true);
    expect(form.addHeld()).toBe(true);
    form.fieldsKept();
  });

  it("network loss at the stage keeps the form, says so honestly, and a retry re-sends the same ids", async () => {
    stageAnswers = [lostNetwork, stagedOk()];
    const form = await fill();
    await form.pressAdd();

    expect(ofKind("command")).toHaveLength(0);
    expect(goto).not.toHaveBeenCalled();
    expect(form.note().trim()).toBe(NETWORK_WORDS);
    expect(form.fileMarkedRefused(), "the file was not refused, the connection was lost").toBe(false);
    expect(form.addHeld(), "the member can try again").toBe(false);
    form.fieldsKept();

    await form.pressAdd();
    const staged = ofKind("stage");
    expect(staged).toHaveLength(2);
    expect(header(staged[1], "x-orbit-document-id")).toBe(header(staged[0], "x-orbit-document-id"));
    expect(header(staged[0], "x-orbit-item-id")).toBeTruthy();
    expect(header(staged[1], "x-orbit-item-id"), "a retry seals under the same draft item id").toBe(header(staged[0], "x-orbit-item-id"));
    expect(ofKind("command")).toHaveLength(1);
    expect(ofKind("command")[0].body.item.id).toBe(header(staged[0], "x-orbit-item-id"));
    expect(ofKind("command")[0].body.documentIds).toEqual([header(staged[0], "x-orbit-document-id")]);
    expect(goto).toHaveBeenCalledTimes(1);
  });

  it("a server error at the stage keeps the form and says Orbit had a problem; a retry works", async () => {
    stageAnswers = [serverDown, stagedOk()];
    const form = await fill();
    await form.pressAdd();

    expect(ofKind("command")).toHaveLength(0);
    expect(goto).not.toHaveBeenCalled();
    expect(form.note().trim()).toBe(SERVER_WORDS);
    expect(form.fileMarkedRefused()).toBe(false);
    expect(form.addHeld()).toBe(false);
    form.fieldsKept();

    await form.pressAdd();
    expect(ofKind("command")).toHaveLength(1);
    expect(goto).toHaveBeenCalledTimes(1);
  });

  it("a server error that carries the server's own words shows those words", async () => {
    stageAnswers = [() => json({ error: { code: "scanner_unavailable", message: "The virus scanner is not available just now" } }, 503)];
    const form = await fill();
    await form.pressAdd();

    expect(ofKind("command")).toHaveLength(0);
    expect(form.note()).toContain("The virus scanner is not available just now");
    expect(form.note()).toMatch(/^\s*not saved/iu);
    expect(form.note()).not.toMatch(/recorded|another try/iu);
    expect(form.addHeld(), "a scanner outage is not a verdict on the file").toBe(false);
  });

  it("an item the engine refuses after a good stage shows the engine's words, keeps the form, and a retry re-sends the same ids", async () => {
    commandAnswers = [commandRefused, commandOk];
    const form = await fill();
    await form.pressAdd();

    expect(ofKind("stage")).toHaveLength(1);
    expect(ofKind("command")).toHaveLength(1);
    expect(goto).not.toHaveBeenCalled();
    expect(form.note()).toContain(ENGINE_WORDS);
    expect(form.note()).not.toMatch(/recorded|another try/iu);
    expect(form.fileName()).toContain("policy.pdf");
    expect(form.fileMarkedRefused()).toBe(false);
    form.fieldsKept();

    await form.pressAdd();
    const commands = ofKind("command");
    expect(commands).toHaveLength(2);
    expect(commands[1].body.item.id).toBe(commands[0].body.item.id);
    expect(commands[1].body.documentIds).toEqual(commands[0].body.documentIds);
    const stagedIds = ofKind("stage").map((one) => header(one, "x-orbit-document-id"));
    expect(new Set(stagedIds).size, "every stage names the same document").toBe(1);
    expect(new Set(ofKind("stage").map((one) => header(one, "x-orbit-item-id"))).size, "and the same draft item").toBe(1);
    expect(commands[0].body.documentIds).toEqual([stagedIds[0]]);
    expect(goto).toHaveBeenCalledTimes(1);
  });

  it("a lost answer to the command, then version_required, means the whole item landed: go home", async () => {
    commandAnswers = [lostNetwork, commandVersionRequired];
    const form = await fill();
    await form.pressAdd();

    expect(goto).not.toHaveBeenCalled();
    expect(form.note().trim()).toBe(NETWORK_WORDS);
    expect(form.note()).not.toMatch(/recorded|another try/iu);
    form.fieldsKept();

    await form.pressAdd();
    const commands = ofKind("command");
    expect(commands).toHaveLength(2);
    expect(commands[1].body.item.id).toBe(commands[0].body.item.id);
    expect(commands[1].body.documentIds).toEqual(commands[0].body.documentIds);
    expect(goto, "version_required on a retry is a landed item").toHaveBeenCalledTimes(1);
    expect(String(goto.mock.calls[0][0])).toContain(`/home?item=${encodeURIComponent(commands[0].body.item.id)}`);
    expect(form.note()).not.toMatch(/not saved|recorded|another try/iu);
  });

  it("saves an item with no document in a single command and stages nothing", async () => {
    const form = await fill();
    await form.removeFile();
    await form.pressAdd();
    expect(ofKind("stage")).toHaveLength(0);
    expect(ofKind("command")).toHaveLength(1);
    expect(goto).toHaveBeenCalledTimes(1);
  });
});

describe("#1316: no partial-landing sentence remains anywhere a member could read it", () => {
  const read = (/** @type {string} */ path) => readFileSync(resolve(import.meta.dirname, "../..", path), "utf8");
  const sources = {
    "web/src/lib/data/workspace.js": read("web/src/lib/data/workspace.js"),
    "web/src/routes/create/create.behaviour.js": read("web/src/routes/create/create.behaviour.js"),
    "web/src/routes/create/pocket.svelte": read("web/src/routes/create/pocket.svelte"),
    "web/src/routes/create/EntryForm.svelte": read("web/src/routes/create/EntryForm.svelte"),
  };

  it.each(Object.entries(sources))("%s has no PARTIAL_CREATE_MESSAGE and no 'recorded, but' sentence", (_file, source) => {
    expect(source).not.toMatch(/PARTIAL_CREATE_MESSAGE/u);
    // "its document" only: mail-in approval's "its documents" sentence is #1398's (v0.4).
    expect(source).not.toMatch(/recorded, but its document\b/iu);
    expect(source).not.toMatch(/needs another try/iu);
  });

  it("neither form still tracks a `landed` flag to decide between a partial and a plain failure", () => {
    expect(sources["web/src/routes/create/create.behaviour.js"]).not.toMatch(/\blanded\b\s*=\s*true/u);
    expect(sources["web/src/routes/create/pocket.svelte"]).not.toMatch(/\blanded\b\s*=\s*true/u);
  });
});
