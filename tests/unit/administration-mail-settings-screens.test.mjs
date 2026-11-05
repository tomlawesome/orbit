import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Window } from "happy-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/*
 * #1630 and #1626, mounted: the real +page.svelte (desk layout and the phone's
 * pocket.svelte side by side) with the mail settings form.
 *
 *   - #1681 retired #1630's "trusted authserv-id" field: it, its hint, its
 *     effective-value row and its warning are gone on desk and phone, and a
 *     saved configuration that still carries the value loads without error;
 *   - a failed provider check says which half failed: "outgoing mail failed"
 *     or "incoming mail failed".
 *
 * Same harness as administration-failed-card-screens.test.mjs: the page and
 * what it imports are compiled and mounted in happy-dom with stand-ins for the
 * server-reading module and the browser-only parts. The phone's sheet is a
 * stand-in that always renders its content, so the phone form can be reached.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const web = createRequire(path.join(ROOT, "web/package.json"));
const { compile } = web("svelte/compiler");
const url = (/** @type {string} */ file) => pathToFileURL(file).href;
const nativeImport = (/** @type {string} */ specifier) => import(/* @vite-ignore */ specifier);

const DOM_GLOBALS = [
  "window", "document", "Node", "Element", "HTMLElement", "SVGElement", "DocumentFragment", "Text", "Comment",
  "HTMLTemplateElement", "HTMLInputElement", "HTMLButtonElement", "HTMLAnchorElement", "Event", "CustomEvent",
  "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
  "MutationObserver", "navigator", "location", "history", "sessionStorage", "localStorage", "customElements", "NodeFilter", "Range", "ShadowRoot",
];
const win = new Window({ url: "http://orbit.invalid/administration" });
for (const key of Object.getOwnPropertyNames(win)) if (/^(HTML|SVG)\w*Element$/u.test(key)) DOM_GLOBALS.push(key);
for (const key of DOM_GLOBALS) {
  const value = /** @type {any} */ (win)[key];
  Object.defineProperty(globalThis, key, { value: typeof value === "function" && !/^[A-Z]/u.test(key) ? value.bind(win) : value, configurable: true, writable: true });
}
Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true, writable: true });
for (const key of ["addEventListener", "removeEventListener", "dispatchEvent"]) {
  Object.defineProperty(globalThis, key, { value: /** @type {any} */ (win)[key].bind(win), configurable: true, writable: true });
}

const SRC = path.join(ROOT, "web/src");

/** @type {string} */
let dir;
/** @type {typeof import("svelte").mount} */
let mount;
/** @type {typeof import("svelte").flushSync} */
let flushSync;
/** @type {typeof import("svelte").unmount} */
let unmount;
/** @type {any} */
let Page;

/** The stand-ins, by the specifier the sources import. */
const STUBS = {
  "$lib/data/workspace.js": `
    export const readAdminScreen = () => globalThis.__readAdminScreen();
    export const wordsOf = (error, fallback) => fallback;
    const never = () => { throw new Error("not under test"); };
    export const addMember = never, commandContact = never, commandUploadLimit = never,
      createLocalUser = never, createSystem = never, hardDeleteHousehold = never, readSignInMethods = async () => [],
      restoreHousehold = never, retryDocumentJob = never, sendSetupLink = never, setUserDisabled = never,
      startStepUp = never, testMail = async () => ({});
    export const commandMailbox = (command) => globalThis.__commandMailbox(command);`,
  "$lib/pocket/Sheet.svelte": `<script>let { open = $bindable(false), title = "", children, foot } = $props();</script>
    <section>{@render children?.()}{@render foot?.()}</section>`,
  "$lib/Chrome.svelte": `<script>let { user = null, current = "", household = null } = $props();</script>`,
  "$lib/backdrops/station.js": `export const mountStation = () => () => {};`,
  "$lib/pocket/media.js": `export const isPocket = () => false; export const pocketQuery = "(max-width: 0px)";`,
  "$lib/pocket/wake.js": `export const wake = () => {};`,
  "$app/env": `export const dev = false; export const browser = true;`,
  "$app/navigation": `export const beforeNavigate = () => {}; export const goto = async () => {}; export const pushState = () => {}; export const replaceState = () => {};`,
  "$app/state": `export const page = { data: {}, state: {}, url: new URL("http://orbit.invalid/administration") };`,
  "$app/paths": `export const resolve = (p) => p;`,
};

/** @type {Map<string, string>} source file -> compiled copy */
const built = new Map();
/** @param {string} spec @param {string} from */
function resolveSource(spec, from) {
  if (spec.startsWith("$lib/")) return path.join(SRC, "lib", spec.slice(5));
  return path.resolve(path.dirname(from), spec);
}
const CLIENT = () => url(web.resolve("svelte").replace(/index-server\.js$/u, "index-client.js"));
const RUNTIME = () => ({
  svelte: CLIENT(),
  "svelte/internal/client": url(web.resolve("svelte/internal/client")),
  "svelte/internal/disclose-version": url(web.resolve("svelte/internal/disclose-version")),
  "svelte/internal/flags/legacy": url(web.resolve("svelte/internal/flags/legacy")),
  "svelte/internal/flags/async": url(web.resolve("svelte/internal/flags/async")),
});

/** Copy (compiling .svelte) a source file and, recursively, what it imports. @param {string} file */
function load(file) {
  const known = built.get(file);
  if (known) return known;
  const out = path.join(dir, String(built.size) + "-" + path.basename(file).replace(/\.svelte$/u, "") + ".mjs");
  built.set(file, out);
  let code = readFileSync(file, "utf8");
  if (file.endsWith(".svelte")) code = compile(code, { generate: "client", filename: file }).js.code;
  const runtime = /** @type {Record<string, string>} */ (RUNTIME());
  code = code.replace(/((?:from|import)\s*\(?\s*)(["'])([^"'\n]+)\2/gu, (whole, lead, quote, spec) => {
    if (spec in runtime) return `${lead}${quote}${runtime[spec]}${quote}`;
    if (spec in STUBS) return `${lead}${quote}${url(stub(spec))}${quote}`;
    if (spec.endsWith(".css")) return `${lead}${quote}${url(stub("css"))}${quote}`;
    if (spec.startsWith("$lib/") || spec.startsWith(".")) return `${lead}${quote}${url(load(resolveSource(spec, file)))}${quote}`;
    return whole;
  });
  writeFileSync(out, code);
  return out;
}
/** @param {string} spec */
function stub(spec) {
  const out = path.join(dir, "stub-" + spec.replace(/[^a-z]+/giu, "-") + (spec.endsWith(".svelte") ? ".svelte.mjs" : ".mjs"));
  const body = /** @type {Record<string, string>} */ (STUBS)[spec] ?? "export {};";
  if (spec.endsWith(".svelte")) {
    writeFileSync(out, compile(body, { generate: "client", filename: "stub.svelte" }).js.code.replace(/(["'])(svelte[^"'\n]*)\1/gu, (w, q, s) => (/** @type {any} */ (RUNTIME())[s] ? JSON.stringify(/** @type {any} */ (RUNTIME())[s]) : w)));
  } else writeFileSync(out, body);
  return out;
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "orbit-admin-card-"));
  mkdirSync(dir, { recursive: true });
  ({ mount, unmount, flushSync } = await nativeImport(CLIENT()));
  Page = (await nativeImport(url(load(path.join(SRC, "routes/administration/+page.svelte"))))).default;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** @type {Array<() => void>} */
let cleanups = [];
afterEach(() => {
  for (const undo of cleanups.splice(0)) undo();
  delete (/** @type {any} */ (globalThis)).__readAdminScreen;
  document.body.innerHTML = "";
});

afterEach(() => { delete (/** @type {any} */ (globalThis)).__commandMailbox; });

const FLUSH = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
const FAILED_KEYS = ["relay", "services", "instance", "owners", "users", "contact", "uploadLimit", "operations", "rotation", "metadata", "recoveryBundle"];

/** The mailbox as /api/admin/mailbox answers it. @param {Record<string, any>} [over] */
function mailbox(over = {}) {
  return {
    configured: true, enabled: true, host: "imap.example.test", port: 993, accountUser: "intake@example.test",
    mailbox: "INBOX", tlsServerName: "imap.example.test", providerProfile: "mailcow",
    trustedRecipientHeader: "X-Original-To", trustedAuthservId: "", effectiveAuthservId: "",
    pollSeconds: 300, verificationState: "verified", verifiedAt: "2026-10-01T10:00:00.000Z",
    aliasPattern: "intake+<code>@example.test", credentialSetAt: "2026-10-01T10:00:00.000Z", credentialSetBy: "Ada Admin",
    hasPassword: true, version: 3,
    health: { status: "available", smtp: "available", imap: "available", checkedAt: "2026-10-01T10:00:00.000Z", credentialLocked: false },
    ...over,
  };
}

/** @param {Record<string, any>} [mailboxOver] */
function screen(mailboxOver = {}) {
  return {
    user: { id: "u1", displayName: "Ada Admin", email: "ada@example.invalid", isInstanceAdmin: true },
    household: null, primary: null, today: "2026-10-01",
    users: [{ id: "u1", displayName: "Ada Admin", email: "ada@example.invalid", isInstanceAdmin: true, disabledAt: null }],
    households: [], peopleMeta: {}, relay: [], services: [], instance: "orbit",
    failed: Object.fromEntries(FAILED_KEYS.map((key) => [key, false])),
    health: null, now: "2026-10-01T12:00:00Z", operations: { jobs: [], counts: {} }, recoverable: [],
    mailbox: mailbox(mailboxOver),
    contact: { name: null, email: null },
    uploadLimit: { maxBytes: 26214400, defaultBytes: 26214400, overrideBytes: null, minBytes: 1048576, ceilingBytes: 104857600, version: 1, updatedAt: null },
    rotation: null, metadata: null, recoveryBundle: null, owners: {},
  };
}

/** @param {any} view @returns {Promise<any[]>} the commands sent to the mailbox route */
async function mountWith(view) {
  /** @type {any[]} */
  const sent = [];
  /** @type {any} */ (globalThis).__readAdminScreen = () => Promise.resolve(view);
  /** @type {any} */ (globalThis).__commandMailbox = async (/** @type {any} */ command) => { sent.push(command); return { mailbox: view.mailbox, outcome: "verified" }; };
  const target = document.body.appendChild(document.createElement("div"));
  const mounted = mount(Page, { target, props: { data: { fixtures: false } } });
  cleanups.push(() => unmount(mounted));
  flushSync();
  await FLUSH();
  return sent;
}

/** The phone's root: the highest ancestor of its form that holds none of the desk's own .mailboxrow buttons. */
function phoneRoot() {
  let node = /** @type {HTMLElement | null} */ (document.getElementById("ad-mailbox-form"));
  if (!node) return null;
  const deskHeading = (/** @type {HTMLElement} */ el) => el.querySelector(".mailboxrow") !== null;
  while (node.parentElement && !deskHeading(node.parentElement)) node = node.parentElement;
  return node;
}
/** The text of one layout. @param {"desk" | "phone"} layout */
function textOf(layout) {
  const phone = phoneRoot();
  const all = document.body.textContent ?? "";
  /* Fail, rather than read "" and pass every "does not say" check, when the phone form is not there. */
  if (layout === "phone") {
    expect(phone, "phone: the mail settings form was found").not.toBeNull();
    return phone?.textContent ?? "";
  }
  return phone?.textContent ? all.replace(phone.textContent, "") : all;
}
/** @param {"desk" | "phone"} layout */
async function openEditor(layout) {
  const label = layout === "desk" ? "change mailbox…" : "change mailbox";
  const buttons = /** @type {HTMLElement[]} */ ([...document.querySelectorAll("button")]);
  const open = layout === "desk"
    ? buttons.find((b) => (b.textContent ?? "").trim() === label)
    : buttons.find((b) => (b.textContent ?? "").trim() === label && phoneRoot()?.contains(b));
  expect(open, `${layout}: the change mailbox button`).toBeDefined();
  open?.click();
  flushSync();
  await FLUSH();
}
/** @param {"desk" | "phone"} layout @returns {HTMLFormElement | null} */
const formOf = (layout) => /** @type {any} */ (layout === "desk" ? document.querySelector(".mailboxform") : document.getElementById("ad-mailbox-form"));
/** The trusted authserv-id input of a layout's form. @param {"desk" | "phone"} layout */
function authservInput(layout) {
  const form = formOf(layout);
  const label = [...(form?.querySelectorAll("label") ?? [])].find((l) => /authserv/iu.test(l.textContent ?? ""));
  if (!label) return null;
  const id = label.getAttribute("for");
  return /** @type {HTMLInputElement | null} */ (id ? document.getElementById(id) : label.querySelector("input"));
}
/** @param {HTMLInputElement} input @param {string} value */
function type(input, value) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

const LAYOUTS = /** @type {const} */ (["desk", "phone"]);

/*
 * #1681 (owner decision 86a): the trusted authserv-id is retired. Attribution
 * rests only on a DKIM signature Orbit verifies itself, so the administrator
 * has nothing to enter: the field, its hint, its effective-value row and the
 * "only DKIM-signed forwards" warning are gone on desk and phone. A saved
 * configuration that still carries the old value (the column is kept and
 * ignored this release) loads without error, and saving sends no such field.
 */
describe.each(LAYOUTS)("administration %s: no trusted authserv-id any more (#1681)", (layout) => {
  const STALE = { providerProfile: "mailcow", trustedAuthservId: "mx.provider.test", effectiveAuthservId: "mx.provider.test" };

  it("has no authserv-id field in the mail settings form", async () => {
    await mountWith(screen(STALE));
    await openEditor(layout);
    expect(formOf(layout), `${layout}: the mail settings form`).not.toBeNull();
    expect(authservInput(layout), `${layout}: no trusted authserv-id field`).toBeNull();
    expect(formOf(layout)?.textContent ?? "").not.toMatch(/authserv|Authentication-Results/iu);
  });

  it("shows no authserv-id anywhere on the screen, nor the value a saved configuration still holds", async () => {
    await mountWith(screen(STALE));
    expect(textOf(layout)).not.toMatch(/authserv/iu);
    expect(textOf(layout)).not.toContain("mx.provider.test");
  });

  it.each(["mailcow", "other", "gmail", "outlook"])("shows no DKIM-only warning for the %s profile with nothing set", async (providerProfile) => {
    await mountWith(screen({ providerProfile, trustedAuthservId: "", effectiveAuthservId: "" }));
    expect(textOf(layout)).not.toMatch(/only forwards with a valid DKIM signature/iu);
    expect(textOf(layout)).not.toMatch(/no mail will be matched/iu);
  });

  it("loads a saved configuration that still carries the old value, and saves without the field", async () => {
    const sent = await mountWith(screen(STALE));
    await openEditor(layout);
    await submitForm(layout);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: "set", expectedVersion: 3, host: "imap.example.test", providerProfile: "mailcow", trustedRecipientHeader: "X-Original-To" });
    expect(sent[0]).not.toHaveProperty("trustedAuthservId");
  });

  it("loads a configuration with no authserv-id fields at all", async () => {
    const view = screen();
    delete view.mailbox.trustedAuthservId;
    delete view.mailbox.effectiveAuthservId;
    const sent = await mountWith(view);
    await openEditor(layout);
    await submitForm(layout);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: "set", providerProfile: "mailcow" });
    expect(sent[0]).not.toHaveProperty("trustedAuthservId");
  });
});

/** Submit a layout's form with a password typed; returns nothing, the stub records the command. @param {"desk" | "phone"} layout */
async function submitForm(layout) {
  const password = /** @type {HTMLInputElement} */ (formOf(layout)?.querySelector("input[type=password]"));
  type(password, "fake-mailbox-password");
  formOf(layout)?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  flushSync();
  await FLUSH();
}

describe.each(LAYOUTS)("administration %s: a failed provider check says which half (#1626)", (layout) => {
  /** @param {string} smtp @param {string} imap */
  const health = (smtp, imap) => ({ status: "provider_unavailable", smtp, imap, checkedAt: "2026-10-01T10:00:00.000Z", credentialLocked: false });

  it("outgoing mail failed, incoming mail fine", async () => {
    await mountWith(screen({ health: health("provider_unavailable", "available") }));
    const text = textOf(layout);
    expect(text).toMatch(/outgoing mail (?:failed|couldn’t be reached)/iu);
    expect(text).not.toMatch(/incoming mail (?:failed|couldn’t be reached)/iu);
  });

  it("incoming mail failed, outgoing mail fine", async () => {
    await mountWith(screen({ health: health("available", "provider_unavailable") }));
    const text = textOf(layout);
    expect(text).toMatch(/incoming mail (?:failed|couldn’t be reached)/iu);
    expect(text).not.toMatch(/outgoing mail (?:failed|couldn’t be reached)/iu);
  });

  it("both failed says both; neither failed says neither", async () => {
    await mountWith(screen({ health: health("provider_unavailable", "provider_unavailable") }));
    expect(textOf(layout)).toMatch(/outgoing mail (?:failed|couldn’t be reached)/iu);
    expect(textOf(layout)).toMatch(/incoming mail (?:failed|couldn’t be reached)/iu);
    cleanups.splice(0).forEach((undo) => undo());
    document.body.innerHTML = "";
    await mountWith(screen());
    expect(textOf(layout)).not.toMatch(/(?:outgoing|incoming) mail (?:failed|couldn’t be reached)/iu);
  });

  it("never shows a credential or raw provider text", async () => {
    await mountWith(screen({ health: health("provider_unavailable", "provider_unavailable") }));
    expect(textOf(layout)).not.toMatch(/password=|ECONN|ENOTFOUND/u);
  });

  it("the outgoing mail test button is not called a relay test", async () => {
    await mountWith(screen());
    const names = [...document.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
    expect(names.filter((name) => /relay/iu.test(name) && /test/iu.test(name))).toEqual([]);
    expect(names.some((name) => /outgoing mail/iu.test(name))).toBe(true);
  });
});

/*
 * #1631: the setup probe's "not delivered" answer. With the mailcow profile it names Mailcow's
 * Tagged mail setting first (set the relay mailbox's Tagged mail to "Do nothing", because Mailcow
 * files plus-addressed mail into a subfolder Orbit never reads); for other profiles it does not
 * mention Tagged mail. The server answers only with the outcome code, so the words are the screen's.
 */
describe.each(LAYOUTS)("administration %s: the not-delivered probe answer (#1631)", (layout) => {
  /** Mount, click "run setup probe" in the layout, with the route answering `not_delivered`. @param {string} providerProfile */
  async function probeNotDelivered(providerProfile) {
    const view = screen({ providerProfile, trustedAuthservId: "mx.provider.test", effectiveAuthservId: "mx.provider.test" });
    await mountWith(view);
    /** @type {any} */ (globalThis).__commandMailbox = async () => ({ mailbox: view.mailbox, outcome: "not_delivered" });
    const buttons = /** @type {HTMLElement[]} */ ([...document.querySelectorAll("button")]);
    const probe = buttons.find((b) => /^run setup probe$/iu.test((b.textContent ?? "").trim()) && (layout === "phone" ? phoneRoot()?.contains(b) : !phoneRoot()?.contains(b)));
    expect(probe, `${layout}: the run setup probe button`).toBeDefined();
    probe?.click();
    flushSync();
    await FLUSH();
    return textOf(layout);
  }

  it("mailcow: names the setting as Mailcow labels it, where it is, and 'Do nothing' (#1660)", async () => {
    const text = await probeNotDelivered("mailcow");
    expect(text).toMatch(/Set handling for tagged mail/u);
    expect(text).toMatch(/Mailbox › Settings/u);
    expect(text).toMatch(/Do nothing/u);
  });

  it("mailcow: Tagged mail comes first in the answer, before any other advice", async () => {
    const text = await probeNotDelivered("mailcow");
    const setting = text.indexOf("Set handling for tagged mail");
    const where = text.indexOf("Mailbox › Settings");
    const why = text.indexOf("subfolder Orbit never reads");
    expect(setting, `${layout}: Tagged mail is named`).toBeGreaterThanOrEqual(0);
    expect(why, `${layout}: the reason follows`).toBeGreaterThan(setting);
    expect(text.indexOf("Do nothing"), `${layout}: the value to set follows`).toBeGreaterThan(setting);
    expect(where, `${layout}: where to find it is named`).toBeGreaterThanOrEqual(0);
    /* The answer opens with the Mailcow advice: nothing else is said before the setting but the location. */
    expect(text.slice(Math.max(0, text.indexOf("not delivered")), setting), `${layout}: only the location precedes the setting`).toMatch(/^not delivered · in Mailcow, sign in as the relay mailbox and, under Mailbox › Settings, set "$/u);
  });

  it("other profiles: the not-delivered answer does not mention Tagged mail", async () => {
    for (const profile of ["gmail", "other"]) {
      cleanups.splice(0).forEach((undo) => undo());
      document.body.innerHTML = "";
      const text = await probeNotDelivered(profile);
      expect(text, `${layout}: ${profile}`).not.toMatch(/Tagged mail/iu);
    }
  });
});

describe.each(LAYOUTS)("administration %s: the mail card shows the server's last answer on load (FR-1)", (layout) => {
  it("says why the last incoming and outgoing tests failed, with no test run in this visit", async () => {
    const view = screen();
    /** @type {any} */ (view.operations).mailProbes = {
      mailbox: { result: "provider_unavailable", at: "2026-10-01T09:00:00.000Z" },
      relay: { result: "smtp_rejected", at: "2026-10-01T09:30:00.000Z" },
    };
    await mountWith(view);
    expect(textOf(layout)).toMatch(/the mail provider couldn’t be reached/u);
    expect(textOf(layout)).toMatch(/the outgoing mail server refused the sign-in/u);
  });

  it("shows no verdict row when the server holds no answer", async () => {
    await mountWith(screen());
    expect(textOf(layout)).not.toMatch(/the outgoing mail server refused the sign-in/u);
    expect(textOf(layout)).not.toMatch(/the mail provider couldn’t be reached/u);
  });
});
