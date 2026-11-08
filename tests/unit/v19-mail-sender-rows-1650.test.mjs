// @vitest-environment happy-dom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { RELAY_FIXTURE } from "../../web/src/lib/data/fixtures/relay.js";

/*
 * #1650 screens, from note 49429 (the view), note 54816 (days left, held mail)
 * and note 55316, before the screens were built:
 *
 *   - Settings -> Mail relay: the sign-in row exactly as today; below it one
 *     row per extra address (the address, its state, `send check` while
 *     unchecked, `remove` always on an extra row and never on the seeded one),
 *     then one input `another address you send from` and a filled `add`
 *     button, disabled at five addresses with the caption `five is the most`.
 *     An unchecked extra row says it is `removed in {n} days` (54816).
 *     Errors are the server's own words in an alert, as the sender check's are.
 *   - the relay read carries `senders` (each with `id`, `source`, `daysLeft`).
 *   - the Inbox: a held item (`needsSenderCheck: true`, `canApprove: false`)
 *     has its `Add to orbit` control disabled with `Please verify sending
 *     address` beside it, on the desk and on the phone.
 *
 * Not reachable here: the phone's stacking of the input and button (CSS), and
 * the colours (no new ones, by the note). Same harness as
 * v19-mail-sender-check.test.mjs: the real components compiled with Svelte's
 * compiler and mounted in happy-dom over a stubbed server.
 */


/* ---- stand-ins for the parts that are not under test ----------------------- */

const media = vi.hoisted(() => ({ pocket: false }));
vi.mock("../../web/src/lib/pocket/media.js", () => ({
  POCKET_QUERY: "(max-width: 839.98px), (max-height: 479.98px)",
  isPocket: () => media.pocket,
}));
const wake = vi.hoisted(() => vi.fn());
vi.mock("../../web/src/lib/pocket/wake.js", () => ({
  WAKE_HOLD_MS: 4000,
  wake: (...args) => wake(...args),
  dismissWake: () => {},
  undoWake: () => {},
  subscribeWake: () => () => {},
}));
vi.mock("../../web/src/lib/backdrops/satellites.js", () => ({ mountSatellites: () => () => {} }));
vi.mock("../../web/src/lib/Chrome.svelte", () => ({ default: () => {} }));
vi.mock("../../web/src/lib/pocket/Sky.svelte", () => ({ default: () => {} }));
vi.mock("../../web/src/lib/PageSky.svelte", () => ({ default: () => {} }));
vi.mock("../../web/src/lib/pocket/ArmButton.svelte", () => ({ default: () => {} }));
vi.mock("../../web/src/lib/pocket/FailedRow.svelte", () => ({ default: () => {} }));

/** The svelte files above, by path under web/src: written into compiled code as they are. */
const STAND_INS = new Set(["lib/Chrome.svelte", "lib/pocket/Sky.svelte", "lib/pocket/ArmButton.svelte", "lib/pocket/FailedRow.svelte", "lib/PageSky.svelte"]);

/* ---- compiling the screen -------------------------------------------------- */

const web = resolve(import.meta.dirname, "../../web");
const svelteSrc = join(web, "node_modules/svelte/src");
const quoted = (/** @type {string} */ path) => JSON.stringify(path);
/** @type {string} */
let compiledDir;
/** @type {string} */
let compiledPage;
/** @type {string} */
let compiledInbox;
/** @type {Map<string, string>} */
const compiledFiles = new Map();
/** @type {(source: string, options: object) => { js: { code: string } }} */
let compile;

/** Where Svelte's own runtime lives, for the specifiers compiled code uses. */
function svelteTarget(/** @type {string} */ spec) {
  if (spec === "svelte") return join(svelteSrc, "index-client.js");
  if (spec.startsWith("svelte/internal/")) {
    const rest = spec.slice("svelte/internal/".length);
    return join(svelteSrc, "internal", rest === "client" ? "client/index.js" : `${rest}.js`);
  }
  if (spec === "svelte/reactivity" || spec === "svelte/store") return join(svelteSrc, spec.slice("svelte/".length), "index-client.js");
  return join(svelteSrc, spec.slice("svelte/".length), "index.js");
}

/** Points every import in compiled code at a file the test can load. */
function relink(/** @type {string} */ code, /** @type {string} */ fromFile) {
  return code.replace(/(\bfrom\s*|\bimport\s*)(["'])([^"'\n]+)\2/gu, (whole, lead, _quote, spec) => {
    if (spec === "$app/navigation") return `${lead}${quoted(join(compiledDir, "navigation.mjs"))}`;
    if (spec === "$app/paths") return `${lead}${quoted(join(compiledDir, "paths.mjs"))}`;
    if (spec === "$app/state") return `${lead}${quoted(join(compiledDir, "state.mjs"))}`;
    if (spec === "svelte" || spec.startsWith("svelte/")) return `${lead}${quoted(svelteTarget(spec))}`;
    if (spec.endsWith(".css")) return `${lead}${quoted(join(compiledDir, "empty.mjs"))}`;
    const target = spec.startsWith("$lib/")
      ? join(web, "src/lib", spec.slice("$lib/".length))
      : spec.startsWith(".") ? resolve(dirname(fromFile), spec) : null;
    if (target === null) return whole;
    if (!target.endsWith(".svelte")) return `${lead}${quoted(target)}`;
    return `${lead}${quoted(STAND_INS.has(target.slice(join(web, "src/").length)) ? target : compileSvelte(target))}`;
  });
}

function compileSvelte(/** @type {string} */ file) {
  const known = compiledFiles.get(file);
  if (known) return known;
  const out = join(compiledDir, `${compiledFiles.size}-${basename(file).replace(/[^\w.]/gu, "_")}.mjs`);
  compiledFiles.set(file, out);
  const code = compile(readFileSync(file, "utf8"), { filename: file, generate: "client", dev: false }).js.code;
  writeFileSync(out, relink(code, file));
  return out;
}

beforeAll(async () => {
  ({ compile } = await import(pathToFileURL(join(svelteSrc, "compiler/index.js")).href));
  /* Inside the checkout (tmp/ is git-ignored), so the module resolves Svelte,
     the $lib alias and the vitest transforms the way any web/ module does. */
  mkdirSync(resolve(import.meta.dirname, "../../tmp"), { recursive: true });
  compiledDir = mkdtempSync(resolve(import.meta.dirname, "../../tmp/mail-sender-rows-1650-"));
  writeFileSync(join(compiledDir, "empty.mjs"), "export {};");
  writeFileSync(join(compiledDir, "navigation.mjs"), "export const beforeNavigate = () => {}; export const afterNavigate = () => {}; export const onNavigate = () => {}; export const goto = async () => {}; export const invalidate = async () => {}; export const invalidateAll = async () => {};");
  writeFileSync(join(compiledDir, "paths.mjs"), "export const resolve = (path) => path; export const base = '';");
  writeFileSync(
    join(compiledDir, "state.mjs"),
    "export const page = { get url() { return new URL(window.location.href); }, params: {}, data: {}, status: 200, error: null };",
  );
  compiledPage = compileSvelte(join(web, "src/routes/settings/mail/+page.svelte"));
  compiledInbox = compileSvelte(join(web, "src/routes/inbox/+page.svelte"));
});
afterAll(() => { rmSync(compiledDir, { recursive: true, force: true }); });

/* ---- the stubbed server ---------------------------------------------------- */

const ADDRESS = "ned.harlow@example.test";
const SECOND = "ned.second@example.test";
const THIRD = "ned.third@example.test";
const json = (/** @type {unknown} */ body, status = 200) => new Response(JSON.stringify(body), { status });
const refusal = (/** @type {number} */ status, /** @type {string} */ code, /** @type {string} */ message) =>
  json({ error: { code, message } }, status);

const SEEDED = { id: "row-seeded", address: ADDRESS, source: "account", verified: true, verificationPending: false, expiresAt: null, daysLeft: null };
const SEEDED_UNCHECKED = { ...SEEDED, verified: false };
const extra = (/** @type {string} */ address, /** @type {object} */ state = {}) => ({
  id: `row-${address.split("@")[0]}`, address, source: "manual", verified: false, verificationPending: false, expiresAt: null, daysLeft: 9, ...state,
});
const CHECKED_EXTRA = (/** @type {string} */ address) => extra(address, { verified: true, daysLeft: null });
const FIVE = ["a1", "a2", "a3", "a4"].map((name) => extra(`${name}@example.test`));

/** What `GET /api/settings/mail-relay` answers. */
function relayBody(/** @type {object | null} */ sender, /** @type {any[] | undefined} */ senders) {
  const list = senders ?? (sender ? [sender] : []);
  return {
    relay: {
      ...RELAY_FIXTURE.relay,
      listening: list.some((row) => row.verified) ? "connected · listening" : "no checked sending address",
      sender: senders !== undefined ? (list.find((/** @type {any} */ row) => row.source !== "manual") ?? null) : (list[0] ?? sender),
      senders: list,
    },
  };
}

/** @type {{ relay: any, calls: { href: string, method: string, body: any }[], answer: (call: { href: string, method: string, body: any }) => Promise<Response> | Response | null }} */
let server;

function stubServer() {
  server = { relay: relayBody(null), calls: [], answer: () => null };
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const href = String(url);
    const method = init?.method ?? "GET";
    if (href.includes("/api/auth/session")) return json({ user: { id: "u1" }, csrfToken: "t1" });
    if (href.endsWith("/api/settings/mail-relay") && method === "GET") return json(server.relay);
    if (href.includes("/api/settings/mail-relay/")) {
      const call = { href, method, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      server.calls.push(call);
      const custom = server.answer(call);
      if (custom) return custom;
      const list = server.relay.relay.senders;
      if (method === "POST" && href.endsWith("/senders")) {
        const added = extra(call.body.address);
        server.relay = relayBody(null, [...list, added]);
        return json({ senders: server.relay.relay.senders });
      }
      if (method === "DELETE") {
        server.relay = relayBody(null, list.filter((/** @type {any} */ row) => !href.endsWith(`/${row.id}`)));
        return json({ senders: server.relay.relay.senders });
      }
      if (href.endsWith("/verification")) return json({ address: list.find((/** @type {any} */ row) => row.id === call.body?.id)?.address ?? ADDRESS, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }, 202);
    }
    return json({ error: { code: "unavailable", message: "not today" } }, 503);
  }));
}

/* ---- mounting and reading the screen --------------------------------------- */

/** @type {(() => void) | null} */
let unmountScreen = null;

beforeEach(() => {
  vi.resetModules();
  media.pocket = false;
  wake.mockClear();
  window.history.replaceState({}, "", "/settings/mail");
  stubServer();
});
afterEach(() => {
  unmountScreen?.();
  unmountScreen = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

/** The screen follows the phone query's `change`; this lets a test fire it. */
const mediaWatchers = new Set();
const phoneQuery = {
  get matches() { return media.pocket; },
  media: "(max-width: 839.98px), (max-height: 479.98px)",
  addEventListener: (/** @type {string} */ _type, /** @type {() => void} */ handler) => { mediaWatchers.add(handler); },
  removeEventListener: (/** @type {string} */ _type, /** @type {() => void} */ handler) => { mediaWatchers.delete(handler); },
  addListener: () => {},
  removeListener: () => {},
};
const settle = async () => {
  const { flushSync } = await import(pathToFileURL(join(svelteSrc, "index-client.js")).href);
  for (let turn = 0; turn < 6; turn += 1) {
    await new Promise((done) => setTimeout(done, 0));
    flushSync();
  }
};

/**
 * Mounts the settings mail screen over the relay read the server gives for
 * `sender`, in the desk or the phone layout, landing on `search`.
 */
async function mountScreen(/** @type {{ sender: object | null, senders?: object[], pocket: boolean, search?: string }} */ { sender, senders, pocket, search = "" }) {
  media.pocket = pocket;
  mediaWatchers.clear();
  window.matchMedia = /** @type {any} */ (() => phoneQuery);
  server.relay = relayBody(sender, senders);
  window.history.replaceState({}, "", `/settings/mail${search}`);
  const { readRelay } = await import("../../web/src/lib/data/workspace.js");
  const relay = await readRelay();
  const { mount, unmount } = await import(pathToFileURL(join(svelteSrc, "index-client.js")).href);
  const { default: Page } = await import(/* @vite-ignore */ compiledPage);
  const component = mount(Page, {
    target: document.body,
    props: { data: { relay, failures: [], user: { id: "u1" }, household: null } },
  });
  unmountScreen = () => unmount(component);
  await settle();
  server.reads = 0;
}

const text = (/** @type {Element | null | undefined} */ element) => (element?.textContent ?? "").replace(/\s+/gu, " ").trim();
const buttons = () => [...document.querySelectorAll("button")];
const buttonSaying = (/** @type {string} */ label) => buttons().find((one) => text(one) === label) ?? null;
const allText = () => text(document.body);

/** What a labelled row of the card says: the desk's `.kv`, the phone's `.rl-field`. */
function rowSays(/** @type {string} */ label) {
  const leaf = [...document.querySelectorAll("body *")].find((one) => one.children.length === 0 && text(one) === label);
  if (!leaf) return null;
  const row = leaf.closest(".kv, .rl-field") ?? leaf.parentElement;
  return text(row).replace(label, "").trim();
}

const alerts = () => [...document.querySelectorAll('[role="alert"]')];
const alertSaying = (/** @type {string} */ words) => alerts().find((one) => text(one) === words) ?? null;

const press = async (/** @type {string} */ label) => {
  const button = buttonSaying(label);
  expect(button, `a "${label}" button is on screen`).not.toBeNull();
  /** @type {HTMLButtonElement} */ (button).focus();
  /** @type {HTMLButtonElement} */ (button).click();
  await settle();
};

const isHeld = (/** @type {Element} */ button) =>
  /** @type {HTMLButtonElement} */ (button).disabled || button.getAttribute("aria-disabled") === "true";


/* ---- reading the rows ------------------------------------------------------ */

/** The row of the card that holds `address` (and no other of the given addresses): the walk up stops before a second address. */
function rowOf(/** @type {string} */ address, /** @type {string[]} */ all) {
  const leaf = [...document.querySelectorAll("body *")].find((one) => one.children.length === 0 && text(one) === address);
  if (!leaf) return null;
  const others = all.filter((one) => one !== address);
  let row = leaf;
  while (row.parentElement && row.parentElement !== document.body
    && !others.some((other) => text(row.parentElement).includes(other))
    && !text(row.parentElement).includes("sender check")) row = row.parentElement;
  return row;
}
const within = (/** @type {Element | null} */ row, /** @type {string} */ label) =>
  row ? [...row.querySelectorAll("button")].find((one) => text(one) === label) ?? null : null;
const input = () => /** @type {HTMLInputElement | null} */ (document.querySelector('input[placeholder="another address you send from"]'));
const typeInto = async (/** @type {string} */ value) => {
  const field = /** @type {HTMLInputElement} */ (input());
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
};
const addAll = (/** @type {any[]} */ rows) => rows.map((row) => row.address);

const LAYOUTS = [["the desk", false], ["the phone", true]];

describe("#1650: the relay read carries the list", () => {
  it("readRelay returns `senders` in the order the server gives, each with its id, state and days left", async () => {
    const rows = [SEEDED, extra(SECOND), CHECKED_EXTRA(THIRD)];
    server.relay = relayBody(null, rows);
    const { readRelay } = await import("../../web/src/lib/data/workspace.js");
    expect(/** @type {any} */ (await readRelay()).senders).toEqual(rows);
  });

  it("readRelay gives an empty list, not undefined, when the server sends none (administrator, mail-in off)", async () => {
    server.relay = relayBody(null);
    const { readRelay } = await import("../../web/src/lib/data/workspace.js");
    expect(/** @type {any} */ (await readRelay()).senders).toEqual([]);
  });
});

describe.each(LAYOUTS)("#1650: %s lists the extra addresses", (_name, pocket) => {
  it("keeps the sign-in rows as they were, and draws no extra row when there is only the sign-in address", async () => {
    await mountScreen({ sender: SEEDED, senders: [SEEDED], pocket });
    expect(rowSays("sending from")).toBe(ADDRESS);
    expect(rowSays("sender check")).toBe("checked");
    expect(buttonSaying("remove")).toBeNull();
    expect(buttonSaying("send check")).toBeNull();
    expect(input(), "the add input is there with room to add").not.toBeNull();
    expect(input()?.getAttribute("placeholder")).toBe("another address you send from");
    expect(buttonSaying("add")).not.toBeNull();
    expect(allText()).not.toContain("five is the most");
  });

  it("draws one row per extra address, in order, with its state in words, below the sign-in rows", async () => {
    const rows = [SEEDED, extra(SECOND), CHECKED_EXTRA(THIRD)];
    await mountScreen({ sender: SEEDED, senders: rows, pocket });
    const all = addAll(rows);
    const second = rowOf(SECOND, all);
    const third = rowOf(THIRD, all);
    expect(second, "a row for the unchecked extra address").not.toBeNull();
    expect(third, "a row for the checked extra address").not.toBeNull();
    expect(text(second)).toContain("unchecked");
    expect(text(second)).toContain("removed in 9 days");
    expect(text(third)).toContain("checked");
    expect(text(third)).not.toContain("removed in");
    const order = (/** @type {Element} */ a, /** @type {Element} */ b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(order(/** @type {Element} */ (second), /** @type {Element} */ (third))).toBe(true);
  });

  it("gives `send check` to an unchecked extra row only, and `remove` to every extra row and never to the sign-in row", async () => {
    const rows = [SEEDED_UNCHECKED, extra(SECOND), CHECKED_EXTRA(THIRD)];
    await mountScreen({ sender: SEEDED_UNCHECKED, senders: rows, pocket });
    const all = addAll(rows);
    expect(within(rowOf(SECOND, all), "send check")).not.toBeNull();
    expect(within(rowOf(SECOND, all), "remove")).not.toBeNull();
    expect(within(rowOf(THIRD, all), "send check")).toBeNull();
    expect(within(rowOf(THIRD, all), "remove")).not.toBeNull();
    expect(buttons().filter((one) => text(one) === "remove")).toHaveLength(2);
    expect(buttonSaying("send the check email"), "the sign-in row keeps its own button").not.toBeNull();
  });

  it("`send check` posts the row's id, and only that", async () => {
    const rows = [SEEDED, extra(SECOND)];
    await mountScreen({ sender: SEEDED, senders: rows, pocket });
    await /** @type {any} */ (within(rowOf(SECOND, addAll(rows)), "send check")).click();
    await settle();
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]).toMatchObject({ method: "POST", body: { id: extra(SECOND).id } });
    expect(server.calls[0].href).toMatch(/\/api\/settings\/mail-relay\/verification$/u);
  });

  it("`remove` deletes that row by id and the row goes", async () => {
    const rows = [SEEDED, extra(SECOND), extra(THIRD)];
    await mountScreen({ sender: SEEDED, senders: rows, pocket });
    await /** @type {any} */ (within(rowOf(SECOND, addAll(rows)), "remove")).click();
    await settle();
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]).toMatchObject({ method: "DELETE" });
    expect(server.calls[0].href).toMatch(new RegExp(`/api/settings/mail-relay/senders/${extra(SECOND).id}$`, "u"));
    expect(allText()).not.toContain(SECOND);
    expect(allText()).toContain(THIRD);
  });

  it("`add` posts the typed address, shows the new row, and clears the input", async () => {
    await mountScreen({ sender: SEEDED, senders: [SEEDED], pocket });
    await typeInto(SECOND);
    await press("add");
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]).toMatchObject({ method: "POST", body: { address: SECOND } });
    expect(server.calls[0].href).toMatch(/\/api\/settings\/mail-relay\/senders$/u);
    expect(allText()).toContain(SECOND);
    expect(input()?.value).toBe("");
  });

  it("shows the server's own words when the add is refused, in an alert, and keeps what was typed", async () => {
    await mountScreen({ sender: SEEDED, senders: [SEEDED], pocket });
    server.answer = () => refusal(409, "sender_address_unavailable", "That address can't be added to this account");
    await typeInto("someone.else@example.test");
    await press("add");
    expect(alertSaying("That address can't be added to this account")).not.toBeNull();
    expect(input()?.value).toBe("someone.else@example.test");
  });

  it("shows the server's own words when a send check is refused", async () => {
    const rows = [SEEDED, extra(SECOND)];
    await mountScreen({ sender: SEEDED, senders: rows, pocket });
    server.answer = () => refusal(429, "sender_check_too_soon", "not sent — too soon. try again in a few minutes");
    await /** @type {any} */ (within(rowOf(SECOND, addAll(rows)), "send check")).click();
    await settle();
    expect(alertSaying("not sent — too soon. try again in a few minutes")).not.toBeNull();
  });
});

describe.each(LAYOUTS)("#1650: %s at five addresses", (_name, pocket) => {
  const five = [SEEDED, ...FIVE];

  it("disables `add` and says `five is the most`, with the rows still removable", async () => {
    await mountScreen({ sender: SEEDED, senders: five, pocket });
    const add = buttonSaying("add");
    expect(add, "the add button is still drawn").not.toBeNull();
    expect(isHeld(/** @type {Element} */ (add))).toBe(true);
    expect(allText()).toContain("five is the most");
    expect(buttons().filter((one) => text(one) === "remove")).toHaveLength(4);
    /** @type {HTMLButtonElement} */ (add).click();
    await settle();
    expect(server.calls).toEqual([]);
  });

  it("at four, `add` works once something is typed and the caption is not there", async () => {
    await mountScreen({ sender: SEEDED, senders: five.slice(0, 4), pocket });
    await typeInto(SECOND);
    const add = buttonSaying("add");
    expect(isHeld(/** @type {Element} */ (add))).toBe(false);
    expect(allText()).not.toContain("five is the most");
  });

  it("frees `add` again after a remove brings it from five to four", async () => {
    await mountScreen({ sender: SEEDED, senders: five, pocket });
    await /** @type {any} */ (within(rowOf(FIVE[0].address, addAll(five)), "remove")).click();
    await settle();
    await typeInto(SECOND);
    expect(isHeld(/** @type {Element} */ (buttonSaying("add")))).toBe(false);
    expect(allText()).not.toContain("five is the most");
  });
});

describe("#1650: a member with no sender rows at all (none seeded, none extra)", () => {
  it.each(LAYOUTS)("%s still shows the add box, so a first address can be added", async (_name, pocket) => {
    await mountScreen({ sender: null, senders: [], pocket });
    expect(input(), "the add input is there").not.toBeNull();
    expect(input()?.getAttribute("placeholder")).toBe("another address you send from");
    expect(buttonSaying("add")).not.toBeNull();
    expect(buttonSaying("remove")).toBeNull();
    expect(buttonSaying("send check")).toBeNull();
    expect(allText()).not.toContain("five is the most");
  });

  it.each(LAYOUTS)("%s adds that first address", async (_name, pocket) => {
    await mountScreen({ sender: null, senders: [], pocket });
    await typeInto(SECOND);
    await press("add");
    expect(server.calls[0]).toMatchObject({ method: "POST", body: { address: SECOND } });
    expect(allText()).toContain(SECOND);
  });
});

/* ---- the inbox ------------------------------------------------------------- */

const RECEIPT = {
  id: "r-1", status: "pending_review", householdId: "hh-1", draftVersion: 1,
  expiresAt: "2099-01-01T00:00:00.000Z", receivedAt: "2026-11-01T09:00:00.000Z",
  attachmentCount: 0, attachments: [], classification: "ready", canApprove: true, canDiscard: true,
  message: "Ready for your review.", proposal: { title: "Boiler service" }, fieldEvidence: {},
};
const HELD = { ...RECEIPT, id: "r-held", canApprove: false, needsSenderCheck: true };

function stubInbox(/** @type {object[]} */ receipts) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const href = String(url);
    if (href.includes("/api/auth/session")) return new Response("", { status: 503 });
    if (href.includes("/api/workspace")) {
      return json({ workspace: { households: [{ id: "hh-1", name: "Harlow", currency: "GBP" }], activeHouseholdId: "hh-1", fixtureToday: "2026-11-02" } });
    }
    if (href.includes("/api/imap-inbox")) return json({ receipts, households: [{ id: "hh-1", name: "Harlow", currency: "GBP" }], filed: [] });
    if (href.includes("/api/settings/mail-relay")) return json(RELAY_FIXTURE);
    return json({}, 404);
  }));
}

async function mountInbox(/** @type {object[]} */ receipts, /** @type {boolean} */ pocket) {
  media.pocket = pocket;
  mediaWatchers.clear();
  window.matchMedia = /** @type {any} */ (() => phoneQuery);
  stubInbox(receipts);
  window.history.replaceState({}, "", "/inbox");
  const { mount, unmount } = await import(pathToFileURL(join(svelteSrc, "index-client.js")).href);
  const { default: Page } = await import(/* @vite-ignore */ compiledInbox);
  const component = mount(Page, { target: document.body, props: { data: {} } });
  unmountScreen = () => unmount(component);
  await settle();
}

const addButtons = () => buttons().filter((one) => /^add to orbit$/iu.test(text(one)));

describe.each(LAYOUTS)("#1650: %s inbox", (_name, pocket) => {
  it("control: an ordinary receipt has an enabled `Add to orbit` and no warning", async () => {
    await mountInbox([RECEIPT], pocket);
    expect(addButtons().length).toBeGreaterThan(0);
    expect(addButtons().some((one) => !isHeld(one))).toBe(true);
    expect(allText()).not.toContain("Please verify sending address");
  });

  it("a held receipt has its `Add to orbit` disabled and `Please verify sending address` beside it", async () => {
    await mountInbox([HELD], pocket);
    expect(addButtons().length, "the held receipt is drawn with its add control").toBeGreaterThan(0);
    expect(addButtons().every((one) => isHeld(one))).toBe(true);
    expect(allText()).toContain("Please verify sending address");
    const near = addButtons()[0].parentElement?.parentElement ?? document.body;
    expect(text(near)).toContain("Please verify sending address");
  });

  it("only the held receipt is shaded out when an ordinary one sits beside it", async () => {
    await mountInbox([HELD, { ...RECEIPT, id: "r-2" }], pocket);
    const states = addButtons().map(isHeld);
    expect(states).toContain(true);
    expect(states).toContain(false);
    expect(allText().split("Please verify sending address").length - 1).toBeGreaterThanOrEqual(1);
  });

  it("a press on the held add control sends nothing", async () => {
    await mountInbox([HELD], pocket);
    const calls = /** @type {any} */ (fetch).mock.calls.length;
    for (const one of addButtons()) { /** @type {HTMLButtonElement} */ (one).click(); }
    await settle();
    expect(/** @type {any} */ (fetch).mock.calls.length).toBe(calls);
  });
});

/* Note on #1650 (lane and countdown): held mail sits where addable mail sits, and
   `senderDaysLeft` (whole days before the unchecked address is removed) drives the line. */
describe.each(LAYOUTS)("#1650: %s inbox, lane and countdown", (_name, pocket) => {
  it("draws the held receipt in the lane addable mail sits in, not under `Failed to process`", async () => {
    await mountInbox([HELD], pocket);
    const lane = addButtons()[0]?.closest(".lane");
    expect(lane, "the held receipt's add control sits in a lane").toBeTruthy();
    expect(text(lane)).not.toContain("Failed to process");
    if (!pocket) expect(text(lane?.querySelector("h2"))).toMatch(/^For your review/u);
  });

  it.each([[3, "3 days"], [2, "2 days"], [1, "1 day"]])("with %i day(s) left the line reads `Please verify sending address. This mail goes in %s.`", async (days, words) => {
    await mountInbox([{ ...HELD, senderDaysLeft: days }], pocket);
    expect(allText()).toContain(`Please verify sending address. This mail goes in ${words}.`);
  });

  it.each([[4], [14]])("with %i days left the line is just `Please verify sending address`", async (days) => {
    await mountInbox([{ ...HELD, senderDaysLeft: days }], pocket);
    expect(allText()).toContain("Please verify sending address");
    expect(allText()).not.toContain("This mail goes in");
  });
});


/* Review of #1650: a member with no readable seeded row (another member holds
   their sign-in address verified, or none was seeded) still manages the extras. */
describe.each(LAYOUTS)("#1650: %s with extra addresses and no seeded row", (_name, pocket) => {
  it("shows the extra rows, `remove` on each, and the add input", async () => {
    const rows = [extra(SECOND), extra(THIRD)];
    await mountScreen({ sender: null, senders: rows, pocket });
    expect(allText()).toContain(SECOND);
    expect(allText()).toContain(THIRD);
    expect(buttons().filter((one) => text(one) === "remove")).toHaveLength(2);
    expect(buttons().filter((one) => text(one) === "send check")).toHaveLength(2);
    expect(input(), "the add input is there").not.toBeNull();
    expect(buttonSaying("add")).not.toBeNull();
  });

  it("can still remove one of them", async () => {
    const rows = [extra(SECOND), extra(THIRD)];
    await mountScreen({ sender: null, senders: rows, pocket });
    await /** @type {any} */ (within(rowOf(SECOND, addAll(rows)), "remove")).click();
    await settle();
    expect(server.calls[0]).toMatchObject({ method: "DELETE" });
    expect(allText()).not.toContain(SECOND);
  });
});
