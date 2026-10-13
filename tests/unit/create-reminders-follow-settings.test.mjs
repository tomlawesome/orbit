// @vitest-environment happy-dom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1316 (release audit: the create forms' reminder defaults). Owner decision,
 * 2026-10-12, fix in v0.3 the minimal way: a new entry's reminder chips start
 * from the signed-in member's own Settings pair (firstWarningDays and
 * finalWarningDays, as the web app already reads them for the Settings
 * reminders tab: GET /api/settings/reminders), falling back to the default
 * pair (14 and 3) when the pair cannot be read. A member who changes the chips
 * still sends what they chose.
 *
 * Both forms are driven as the existing create tests drive them
 * (v19-create-partial-landing-words.test.mjs): the desk's real behaviour
 * module on a minimal copy of its markup, and the pocket's Svelte component
 * compiled and mounted in happy-dom with only EntryForm, Sheet and Sky stood
 * in for. Both run over the real workspace.js and a stubbed fetch, so the
 * member's pair is stubbed at the route, not at any function.
 */

/** What the stand-in EntryForm was handed: the pocket's `entry` binding. */
const entryForm = vi.hoisted(() => ({ props: /** @type {any} */ (null) }));
vi.mock("../../web/src/routes/create/EntryForm.svelte", () => ({
  default: (/** @type {unknown} */ _anchor, /** @type {any} */ props) => { entryForm.props = props; },
}));
vi.mock("../../web/src/lib/pocket/Sheet.svelte", () => ({ default: () => {} }));
vi.mock("../../web/src/lib/pocket/Sky.svelte", () => ({ default: () => {} }));

const goto = vi.fn(async () => {});
vi.mock("$app/navigation", () => ({ goto: (...args) => goto(...args), beforeNavigate: () => {} }));

/** @typedef {"pair" | "nulls" | "fails"} ReadMode */
/** What the settings route answers: the member's own pair, null days, or a failure. @type {ReadMode} */
let readMode = "pair";
const MEMBER_PAIR = [30, 7];
const DEFAULT_PAIR = [14, 3];

/** @type {{ url: string, init: RequestInit }[]} */
let saves = [];

const workspace = {
  activeHouseholdId: "hh-1",
  households: [{
    id: "hh-1", name: "Home", currency: "GBP", items: [],
    sections: [{ id: "s-home", name: "Home", accent: "a", visible: true }],
  }],
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function remindersAnswer() {
  if (readMode === "fails") return json({ error: { code: "unavailable", message: "not today" } }, 503);
  const days = readMode === "pair" ? MEMBER_PAIR : [null, null];
  return json({
    reminders: {
      emailEnabled: true,
      firstWarningDays: days[0],
      finalWarningDays: days[1],
      firstWarning: "30 days before closest approach",
      finalWarning: "7 days before",
      outboundMail: "configured",
    },
  });
}

function stubFetch() {
  saves = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const href = String(url);
    if (href.includes("/api/auth/session")) return json({ user: { id: "u1" }, csrfToken: "t1" });
    if (href.includes("/api/settings/reminders") && (!init?.method || init.method === "GET")) return remindersAnswer();
    if (href.endsWith("/api/workspace") && !init?.method) return json({ workspace });
    if (href.includes("/api/workspace/commands") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (body.dryRun) return json({});
      saves.push({ url: href, init });
      return json({ workspace });
    }
    return json({ error: { code: "unavailable", message: "not today" } }, 503);
  }));
}

/** The reminder days of the one item the form saved. */
const savedReminderDays = () => {
  expect(saves, "the item was sent once").toHaveLength(1);
  return JSON.parse(String(saves[0].init.body)).item.reminderDays;
};

const MARKUP = `
  <form id="card" novalidate>
    <div id="disclose">
      <div id="types"><button type="button" data-type="service" aria-pressed="false">service</button></div>
      <div id="sections"></div>
      <div id="field-date"><input id="f-date" type="date"></div>
      <div class="f-recur"><select id="f-recur"><option value="0">once</option></select>
        <input id="f-recur-months" hidden></div>
      <input id="f-cost"><input id="f-provider"><input id="f-ref"><textarea id="f-notes"></textarea>
      <select id="f-reminder">
        <option value="7">1 week before</option>
        <option value="14" selected>2 weeks before</option>
        <option value="30">1 month before</option>
      </select>
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
  readMode = "pair";
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

/** Opens the desk form, fills a name and a section, and presses Add; `between` runs just before. */
async function deskSave(/** @type {() => void} */ between = () => {}) {
  const { mountCreate } = await import("../../web/src/routes/create/create.behaviour.js");
  mounted = mountCreate();
  await settle(); // the household loads and the member's pair is read
  const name = /** @type {HTMLInputElement} */ (document.getElementById("f-name"));
  name.value = "Boiler cover";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  document.querySelector("#sections button")?.dispatchEvent(new Event("click", { bubbles: true }));
  await settle();
  between();
  await settle();
  document.getElementById("card")?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  await settle();
}

describe("#1316: the desk create form's reminders start from the member's own Settings pair", () => {
  it("with the member's pair stubbed as 30 and 7, a new entry carries reminderDays [30, 7]", async () => {
    readMode = "pair";
    await deskSave();
    expect(savedReminderDays()).toEqual(MEMBER_PAIR);
  });

  it("with the read failing, a new entry carries the default pair [14, 3]", async () => {
    readMode = "fails";
    await deskSave();
    expect(savedReminderDays()).toEqual(DEFAULT_PAIR);
  });

  it("with the read answering nulls, a new entry carries the default pair [14, 3]", async () => {
    readMode = "nulls";
    await deskSave();
    expect(savedReminderDays()).toEqual(DEFAULT_PAIR);
  });

  it("a member who changes the reminder before saving still sends what they chose", async () => {
    readMode = "pair";
    await deskSave(() => {
      const reminder = /** @type {HTMLSelectElement} */ (document.getElementById("f-reminder"));
      reminder.value = "14";
      reminder.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(savedReminderDays()).toEqual([14]);
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
  compiledDir = mkdtempSync(resolve(import.meta.dirname, "../../tmp/pocket-reminders-follow-settings-"));
  writeFileSync(join(compiledDir, "state.mjs"), 'export const page = { url: new URL("http://localhost/create") };');
  compiledPocket = join(compiledDir, "pocket.mjs");
  writeFileSync(compiledPocket, js.replaceAll('"$app/state"', quoted(join(compiledDir, "state.mjs"))));
});
afterAll(() => { rmSync(compiledDir, { recursive: true, force: true }); });

/** @type {(() => void) | null} */
let unmountPocket = null;
afterEach(() => { unmountPocket?.(); unmountPocket = null; entryForm.props = null; });

/** Mounts the pocket's form. `chosen` is the chips the member then sets, if they change them. */
async function pocketSave({ chosen = /** @type {number[] | null} */ (null) } = {}) {
  const { mount, unmount, flushSync } = await import(pathToFileURL(join(svelteSrc, "index-client.js")).href);
  const { default: Pocket } = await import(/* @vite-ignore */ compiledPocket);
  const component = mount(Pocket, { target: document.body });
  unmountPocket = () => unmount(component);
  await settle(); // the household loads, the member's pair is read, and the form is ready
  expect(entryForm.props, "the form is on screen").not.toBeNull();
  const chipsOnScreen = [...entryForm.props.entry.reminderDays];
  entryForm.props.entry = { ...entryForm.props.entry, name: "Boiler cover", sectionId: "s-home" };
  if (chosen) entryForm.props.entry = { ...entryForm.props.entry, reminderDays: chosen };
  flushSync();
  await settle(); // the engine's check of the filled entry
  document.getElementById("pocket-entry")?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  await settle();
  return { chipsOnScreen };
}

describe("#1316: the phone create sheet's reminders start from the member's own Settings pair", () => {
  it("with the member's pair stubbed as 30 and 7, the chips start at 30 and 7 and the new entry carries reminderDays [30, 7]", async () => {
    readMode = "pair";
    const { chipsOnScreen } = await pocketSave();
    expect(chipsOnScreen).toEqual(MEMBER_PAIR);
    expect(savedReminderDays()).toEqual(MEMBER_PAIR);
  });

  it("with the read failing, a new entry carries the default pair [14, 3]", async () => {
    readMode = "fails";
    const { chipsOnScreen } = await pocketSave();
    expect(chipsOnScreen).toEqual(DEFAULT_PAIR);
    expect(savedReminderDays()).toEqual(DEFAULT_PAIR);
  });

  it("with the read answering nulls, a new entry carries the default pair [14, 3]", async () => {
    readMode = "nulls";
    const { chipsOnScreen } = await pocketSave();
    expect(chipsOnScreen).toEqual(DEFAULT_PAIR);
    expect(savedReminderDays()).toEqual(DEFAULT_PAIR);
  });

  it("a member who changes the chips still sends what they chose", async () => {
    readMode = "pair";
    await pocketSave({ chosen: [60, 1] });
    expect(savedReminderDays()).toEqual([60, 1]);
  });
});
