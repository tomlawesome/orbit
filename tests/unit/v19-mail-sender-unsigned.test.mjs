// @vitest-environment happy-dom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { landOnSettings, settingsAnswer, showOnly } from "./support/settings-relay-mount.mjs";
import { RELAY_FIXTURE } from "../../web/src/lib/data/fixtures/relay.js";
import { clockOf, dayMonth, localZone } from "../../web/src/lib/format.js";
import { firstClause } from "../../web/src/lib/pocket/words.js";

/*
 * #1681, design note 52496 (telling a member their forwards are not signed).
 *
 * Orbit learns from the forwards themselves: an unsigned forward from a
 * verified member is filed for them as `sender_unsigned`, and the relay page's
 * `sender check` row turns warm while their most recent forward was unsigned.
 * The relay read's `sender` carries `lastForwardSigned: boolean | null`
 * (null when nothing from the address has been checked yet).
 *
 * Covered here:
 *   - `checkRow` (sender.js), the one source of the row's words for both
 *     layouts: the fourth state, read before the other three, and the other
 *     three unchanged;
 *   - the settings mail screen, desk and phone: the warm row with no button,
 *     `checked` when the last forward was signed or nothing was checked yet,
 *     and the failed row in the "could not be read" list in the note's words;
 *   - `firstClause` resting the note's message where the note says.
 *
 * Same harness as v19-mail-sender-check.test.mjs, except that the phone's
 * FailedRow.svelte (and the Row it draws through) is compiled for real here,
 * so the phone's failed list can be read.
 */

/** The note's exact words for the row (§2). */
const UNSIGNED_ROW = "checked · but your last forward wasn't signed, so it wasn't kept";
/** The note's exact words for the failed row (§2), from review-state.ts. */
const UNSIGNED_MESSAGE = "Orbit could not confirm this came from you, so it was not kept. Your mail service did not sign it (DKIM). Send it again from a service that signs, or ask whoever runs your mail domain to turn signing on.";

/* ---- stand-ins for the parts that are not under test ----------------------- */

const media = vi.hoisted(() => ({ pocket: false }));
vi.mock("../../web/src/lib/pocket/media.js", () => ({
  POCKET_QUERY: "(max-width: 900px), (max-height: 600px)",
  isPocket: () => media.pocket,
}));
vi.mock("../../web/src/lib/pocket/wake.js", () => ({
  WAKE_HOLD_MS: 4000,
  wake: () => {},
  dismissWake: () => {},
  undoWake: () => {},
  subscribeWake: () => () => {},
}));
vi.mock("../../web/src/lib/backdrops/satellites.js", () => ({ mountSatellites: () => () => {} }));
vi.mock("../../web/src/lib/Chrome.svelte", () => ({ default: () => {} }));
vi.mock("../../web/src/lib/PageSky.svelte", () => ({ default: () => {} }));
vi.mock("../../web/src/lib/pocket/Sheet.svelte", () => ({ default: () => {} }));
vi.mock("../../web/src/lib/tour/watch.js", () => ({ watchTour: () => () => {} }));
vi.mock("../../web/src/lib/push/alerts.js", () => ({ alertsSupported: () => false, syncAlerts: async () => {}, enableAlerts: async () => {}, disableAlerts: async () => {} }));
vi.mock("../../web/src/lib/pocket/Sky.svelte", () => ({ default: () => {} }));
vi.mock("../../web/src/lib/pocket/ArmButton.svelte", () => ({ default: () => {} }));

const STAND_INS = new Set(["lib/Chrome.svelte", "lib/pocket/Sky.svelte", "lib/pocket/ArmButton.svelte", "lib/PageSky.svelte", "lib/pocket/Sheet.svelte"]);

/* ---- compiling the screen -------------------------------------------------- */

const web = resolve(import.meta.dirname, "../../web");
const svelteSrc = join(web, "node_modules/svelte/src");
const quoted = (/** @type {string} */ path) => JSON.stringify(path);
/** @type {string} */
let compiledDir;
/** @type {string} */
let compiledPage;
/** @type {Map<string, string>} */
const compiledFiles = new Map();
/** @type {(source: string, options: object) => { js: { code: string } }} */
let compile;

function svelteTarget(/** @type {string} */ spec) {
  if (spec === "svelte") return join(svelteSrc, "index-client.js");
  if (spec.startsWith("svelte/internal/")) {
    const rest = spec.slice("svelte/internal/".length);
    return join(svelteSrc, "internal", rest === "client" ? "client/index.js" : `${rest}.js`);
  }
  if (spec === "svelte/reactivity" || spec === "svelte/store") return join(svelteSrc, spec.slice("svelte/".length), "index-client.js");
  return join(svelteSrc, spec.slice("svelte/".length), "index.js");
}

function relink(/** @type {string} */ code, /** @type {string} */ fromFile) {
  return code.replace(/(\bfrom\s*|\bimport\s*)(["'])([^"'\n]+)\2/gu, (whole, lead, _quote, spec) => {
    if (spec === "$app/state") return `${lead}${quoted(join(compiledDir, "state.mjs"))}`;
    if (spec === "$app/env") return `${lead}${quoted(join(compiledDir, "env.mjs"))}`;
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
  mkdirSync(resolve(import.meta.dirname, "../../tmp"), { recursive: true });
  compiledDir = mkdtempSync(resolve(import.meta.dirname, "../../tmp/mail-sender-unsigned-"));
  writeFileSync(join(compiledDir, "empty.mjs"), "export {};");
  writeFileSync(join(compiledDir, "env.mjs"), "export const dev = false; export const browser = true;");
  writeFileSync(
    join(compiledDir, "state.mjs"),
    "export const page = { get url() { return new URL(window.location.href); }, params: {}, data: {}, status: 200, error: null };",
  );
  compiledPage = compileSvelte(join(web, "src/routes/settings/+page.svelte"));
});
afterAll(() => { rmSync(compiledDir, { recursive: true, force: true }); });

/* ---- the stubbed server ---------------------------------------------------- */

const ADDRESS = "ned.harlow@example.test";
const json = (/** @type {unknown} */ body, status = 200) => new Response(JSON.stringify(body), { status });
const hoursFromNow = (/** @type {number} */ hours) => new Date(Date.now() + hours * 3_600_000).toISOString();

const verified = (/** @type {boolean | null} */ lastForwardSigned) =>
  ({ address: ADDRESS, verified: true, verificationPending: false, expiresAt: null, lastForwardSigned });

/** @type {{ relay: object }} */
let server;

function relayBody(/** @type {object | null} */ sender) {
  const checked = Boolean(/** @type {any} */ (sender)?.verified);
  return { relay: { ...RELAY_FIXTURE.relay, listening: checked ? "connected · listening" : "no checked sending address", sender } };
}

beforeEach(() => {
  vi.resetModules();
  media.pocket = false;
  landOnSettings();
  server = { relay: relayBody(null) };
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const href = String(url);
    const method = init?.method ?? "GET";
    if (href.includes("/api/auth/session")) return json({ user: { id: "u1" }, csrfToken: "t1" });
    const screen = settingsAnswer(href, { receipts: server.receipts ?? [] });
    if (screen) return screen;
    if (href.endsWith("/api/settings/mail-relay") && method === "GET") return json(server.relay);
    return json({ error: { code: "unavailable", message: "not today" } }, 503);
  }));
});

/** @type {(() => void) | null} */
let unmountScreen = null;
afterEach(() => {
  unmountScreen?.();
  unmountScreen = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const phoneQuery = {
  get matches() { return media.pocket; },
  media: "(max-width: 900px), (max-height: 600px)",
  addEventListener: () => {},
  removeEventListener: () => {},
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

/** The failed receipt the inbox read gives for a `sender_unsigned` row (review-state.ts). */
const unsignedReceipt = {
  id: "11111111-1111-4111-8111-111111111111",
  receivedAt: "2026-11-04T09:30:00.000Z",
  classification: "unavailable",
  canApprove: false,
  canDiscard: true,
  message: UNSIGNED_MESSAGE,
  reason: "not_kept",
  metadataStatus: null,
};

async function mountScreen(/** @type {{ sender: object | null, pocket: boolean, receipts?: object[] }} */ { sender, pocket, receipts = [] }) {
  media.pocket = pocket;
  window.matchMedia = /** @type {any} */ (() => phoneQuery);
  server.relay = relayBody(sender);
  server.receipts = receipts;
  const { mount, unmount } = await import(pathToFileURL(join(svelteSrc, "index-client.js")).href);
  const { default: Page } = await import(/* @vite-ignore */ compiledPage);
  const component = mount(Page, {
    target: document.body,
    props: { data: { fixtures: false } },
  });
  unmountScreen = () => unmount(component);
  await settle();
  showOnly(pocket);
}

const text = (/** @type {Element | null | undefined} */ element) => (element?.textContent ?? "").replace(/\s+/gu, " ").trim();
const buttonSaying = (/** @type {string} */ label) => [...document.querySelectorAll("button")].find((one) => text(one) === label) ?? null;

/** The element a labelled row's value is drawn in: the desk's `.kv`, the phone's `.rl-field`. */
function rowValue(/** @type {string} */ label) {
  const leaf = [...document.querySelectorAll("body *")].find((one) => one.children.length === 0 && text(one) === label);
  if (!leaf) return null;
  const row = leaf.closest(".kv, .rl-field") ?? leaf.parentElement;
  return { says: text(row).replace(label, "").trim(), bold: row?.querySelector("b") ?? null };
}

/* ---- checkRow: the words both layouts draw ---------------------------------- */

describe("note 52496: checkRow's fourth state", () => {
  it("verified with lastForwardSigned false: the warm words and no button", async () => {
    const { checkRow } = await import("../../web/src/routes/settings/mail/sender.js");
    expect(checkRow(verified(false))).toEqual({ says: UNSIGNED_ROW, tone: "warm", button: null });
  });

  it.each([
    ["true", true],
    ["null (nothing checked yet)", null],
  ])("verified with lastForwardSigned %s: `checked`, ok, no button", async (_name, lastForwardSigned) => {
    const { checkRow } = await import("../../web/src/routes/settings/mail/sender.js");
    expect(checkRow(verified(lastForwardSigned))).toEqual({ says: "checked", tone: "ok", button: null });
  });

  it("the other three states are unchanged, whatever lastForwardSigned says of an unverified address", async () => {
    const { checkRow } = await import("../../web/src/routes/settings/mail/sender.js");
    const base = { address: ADDRESS, verified: false, lastForwardSigned: false };
    expect(checkRow({ ...base, verificationPending: false, expiresAt: null }))
      .toEqual({ says: "not yet checked", tone: "warm", button: "send the check email" });
    expect(checkRow({ ...base, verificationPending: true, expiresAt: hoursFromNow(-1) }))
      .toEqual({ says: "not yet checked · the last link lapsed", tone: "warm", button: "send the check email" });
    expect(checkRow({ ...base, verificationPending: true, expiresAt: null }))
      .toEqual({ says: "email sent · open the link within 24 hours", tone: "warm", button: "send it again" });
    const expiresAt = hoursFromNow(20);
    expect(checkRow({ ...base, verificationPending: true, expiresAt })).toEqual({
      says: `email sent · link lapses ${dayMonth(expiresAt, localZone())} ${clockOf(expiresAt, localZone())}`,
      tone: "warm",
      button: "send it again",
    });
  });
});

describe("note 52496: firstClause rests the unsigned failure where the note says", () => {
  it("cuts the message at its first comma", () => {
    expect(firstClause(UNSIGNED_MESSAGE)).toBe("Orbit could not confirm this came from you");
  });
});

/* ---- the screen, in both layouts ------------------------------------------- */

describe.each([
  ["the desk", false],
  ["the phone", true],
])("note 52496: %s", (_name, pocket) => {
  it("the last forward was unsigned: the sender check row is warm, says the note's words, and offers no button", async () => {
    await mountScreen({ sender: verified(false), pocket });
    const row = rowValue("sender check");
    expect(row?.says).toBe(UNSIGNED_ROW);
    expect(row?.bold?.classList.contains("warm"), "drawn warm").toBe(true);
    expect(buttonSaying("send the check email")).toBeNull();
    expect(buttonSaying("send it again")).toBeNull();
    /* The status row is untouched: the relay is listening. */
    expect(text(document.body)).toContain("connected · listening");
  });

  it.each([
    ["signed", true],
    ["never checked", null],
  ])("the last forward %s: `checked`, not warm", async (_case, lastForwardSigned) => {
    await mountScreen({ sender: verified(lastForwardSigned), pocket });
    const row = rowValue("sender check");
    expect(row?.says).toBe("checked");
    expect(row?.bold?.classList.contains("warm")).toBe(false);
  });

  it("the unsigned failure is in the could-not-be-read list, in the note's words", async () => {
    await mountScreen({ sender: verified(false), pocket, receipts: [unsignedReceipt] });
    const heading = [...document.querySelectorAll("h2")].find((one) => /could(n’t| not) be read/u.test(text(one)));
    expect(heading, "the could-not-be-read list is drawn").toBeDefined();
    const list = heading?.closest("section, .failures") ?? null;
    expect(text(list)).toContain(UNSIGNED_MESSAGE);
  });
});
