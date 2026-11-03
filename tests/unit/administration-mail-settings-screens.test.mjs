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
 *   - the form has a "trusted authserv-id" field on desk and phone, prefilled
 *     with the effective value (the profile's built-in one for gmail and
 *     outlook, empty for mailcow and other), with one line saying where to
 *     find it (the first word of the Authentication-Results header);
 *   - saving sends trustedAuthservId with the rest of the mailbox settings;
 *   - with the mailcow profile and an empty value the screen warns that "no
 *     mail will be matched"; with a value set, or with gmail, it does not;
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
  if (layout === "phone") return phone?.textContent ?? "";
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

describe.each(LAYOUTS)("administration %s: the trusted authserv-id field (#1630)", (layout) => {
  it("is in the mail settings form, prefilled with the value the server holds", async () => {
    await mountWith(screen({ providerProfile: "mailcow", trustedAuthservId: "mx.provider.test", effectiveAuthservId: "mx.provider.test" }));
    await openEditor(layout);
    const input = authservInput(layout);
    expect(input, `${layout}: a trusted authserv-id field`).not.toBeNull();
    expect(input?.value).toBe("mx.provider.test");
  });

  it("is prefilled with the profile's built-in value for gmail (the effective value, not the stored empty one)", async () => {
    await mountWith(screen({ providerProfile: "gmail", trustedAuthservId: "", effectiveAuthservId: "mx.google.com" }));
    await openEditor(layout);
    expect(authservInput(layout)?.value).toBe("mx.google.com");
  });

  it("is empty for mailcow with nothing set, and says where to find it", async () => {
    await mountWith(screen());
    await openEditor(layout);
    expect(authservInput(layout)?.value).toBe("");
    expect(formOf(layout)?.textContent ?? "", `${layout}: the line saying where to find it`).toMatch(/Authentication-Results/u);
  });

  it("is saved with the rest of the mailbox settings", async () => {
    const sent = await mountWith(screen({ providerProfile: "mailcow", trustedAuthservId: "", effectiveAuthservId: "" }));
    await openEditor(layout);
    const input = authservInput(layout);
    expect(input, `${layout}: a trusted authserv-id field`).not.toBeNull();
    type(/** @type {HTMLInputElement} */ (input), "mx.provider.test");
    const password = /** @type {HTMLInputElement} */ (formOf(layout)?.querySelector("input[type=password]"));
    type(password, "fake-mailbox-password");
    formOf(layout)?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    flushSync();
    await FLUSH();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      action: "set", expectedVersion: 3, host: "imap.example.test", providerProfile: "mailcow",
      trustedRecipientHeader: "X-Original-To", trustedAuthservId: "mx.provider.test",
    });
  });

  it("warns that no mail will be matched for mailcow with an empty value", async () => {
    await mountWith(screen({ providerProfile: "mailcow", trustedAuthservId: "", effectiveAuthservId: "" }));
    expect(textOf(layout)).toMatch(/no mail will be matched/iu);
  });

  it("warns for the other profile with an empty value too", async () => {
    await mountWith(screen({ providerProfile: "other", trustedAuthservId: "", effectiveAuthservId: "" }));
    expect(textOf(layout)).toMatch(/no mail will be matched/iu);
  });

  it("does not warn once the value is set, or for gmail's built-in one", async () => {
    await mountWith(screen({ providerProfile: "mailcow", trustedAuthservId: "mx.provider.test", effectiveAuthservId: "mx.provider.test" }));
    expect(textOf(layout)).not.toMatch(/no mail will be matched/iu);
    cleanups.splice(0).forEach((undo) => undo());
    document.body.innerHTML = "";
    await mountWith(screen({ providerProfile: "gmail", trustedAuthservId: "", effectiveAuthservId: "mx.google.com" }));
    expect(textOf(layout)).not.toMatch(/no mail will be matched/iu);
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

describe.each(LAYOUTS)("administration %s: a built-in authserv-id is not saved as typed (#1630)", (layout) => {
  it("gmail with nothing stored, switched to mailcow, saves an empty value", async () => {
    const sent = await mountWith(screen({ providerProfile: "gmail", trustedAuthservId: "", effectiveAuthservId: "mx.google.com" }));
    await openEditor(layout);
    const select = /** @type {HTMLSelectElement} */ (formOf(layout)?.querySelector("select"));
    select.value = "mailcow";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    await submitForm(layout);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: "set", providerProfile: "mailcow", trustedAuthservId: "" });
  });

  it("gmail with nothing stored, saved unchanged, saves an empty value", async () => {
    const sent = await mountWith(screen({ providerProfile: "gmail", trustedAuthservId: "", effectiveAuthservId: "mx.google.com" }));
    await openEditor(layout);
    await submitForm(layout);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: "set", providerProfile: "gmail", trustedAuthservId: "" });
  });

  it("a stored value is saved unchanged", async () => {
    const sent = await mountWith(screen({ providerProfile: "mailcow", trustedAuthservId: "mx.example.test", effectiveAuthservId: "mx.example.test" }));
    await openEditor(layout);
    await submitForm(layout);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: "set", trustedAuthservId: "mx.example.test" });
  });

  it("a newly typed value is saved", async () => {
    const sent = await mountWith(screen({ providerProfile: "mailcow", trustedAuthservId: "mx.example.test", effectiveAuthservId: "mx.example.test" }));
    await openEditor(layout);
    type(/** @type {HTMLInputElement} */ (authservInput(layout)), "mx.other.test");
    await submitForm(layout);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: "set", trustedAuthservId: "mx.other.test" });
  });
});

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
