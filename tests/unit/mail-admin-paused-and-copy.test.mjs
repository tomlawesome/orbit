// @vitest-environment happy-dom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { RELAY_FIXTURE } from "../../web/src/lib/data/fixtures/relay.js";
import { clockOf, dayMonth, localZone } from "../../web/src/lib/format.js";

/*
 * #1654 and #1658: the member's Settings -> Mail screen, desk and phone.
 *   - while the administrator has paused ingest the address stays on screen,
 *     copyable, under a line saying collection is paused by the administrator
 *     and mail sent now waits and is read when it resumes; "no address yet"
 *     only for a member who has none;
 *   - on the desk, a click on the address copies it, with the phone's words
 *     ("copied · your relay address" / "not copied — your browser kept the
 *     clipboard closed"); it cannot be clicked while it cannot be used; its
 *     name is "Copy your relay address, <address>" and a visible "click to
 *     copy" hint sits beside it.
 *
 * The paused flag on the server's body is named `adminPaused` here (the issue
 * only says "a paused flag"). Same harness as v19-mail-sender-check.test.mjs.
 */

/* ---- stand-ins for the parts that are not under test ----------------------- */

const media = vi.hoisted(() => ({ pocket: false }));
vi.mock("../../web/src/lib/pocket/media.js", () => ({
  POCKET_QUERY: "(max-width: 900px), (max-height: 600px)",
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
vi.mock("../../web/src/lib/pocket/ArmButton.svelte", () => ({ default: () => {} }));
vi.mock("../../web/src/lib/pocket/FailedRow.svelte", () => ({ default: () => {} }));

/** The svelte files above, by path under web/src: written into compiled code as they are. */
const STAND_INS = new Set(["lib/Chrome.svelte", "lib/pocket/Sky.svelte", "lib/pocket/ArmButton.svelte", "lib/pocket/FailedRow.svelte"]);

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
  compiledDir = mkdtempSync(resolve(import.meta.dirname, "../../tmp/mail-admin-paused-copy-"));
  writeFileSync(join(compiledDir, "empty.mjs"), "export {};");
  writeFileSync(
    join(compiledDir, "state.mjs"),
    "export const page = { get url() { return new URL(window.location.href); }, params: {}, data: {}, status: 200, error: null };",
  );
  compiledPage = compileSvelte(join(web, "src/routes/settings/mail/+page.svelte"));
});
afterAll(() => { rmSync(compiledDir, { recursive: true, force: true }); });

/* ---- the stubbed server ---------------------------------------------------- */

const ADDRESS = "ned.harlow@example.test";
const json = (/** @type {unknown} */ body, status = 200) => new Response(JSON.stringify(body), { status });
const hoursFromNow = (/** @type {number} */ hours) => new Date(Date.now() + hours * 3_600_000).toISOString();

const UNCHECKED = { address: ADDRESS, verified: false, verificationPending: false, expiresAt: null };
const CHECKED = { address: ADDRESS, verified: true, verificationPending: false, expiresAt: null };

/** What `GET /api/settings/mail-relay` answers for a sender. */
function relayBody(/** @type {object | null} */ sender) {
  const checked = Boolean(/** @type {any} */ (sender)?.verified);
  return {
    relay: {
      ...RELAY_FIXTURE.relay,
      listening: checked ? "connected · listening" : "no checked sending address",
      sender,
    },
  };
}

/** @type {{ relay: object, reads: number, failReads: boolean, readGate: { promise: Promise<unknown> } | null, calls: { href: string, init: RequestInit | undefined }[], answer: (init?: RequestInit) => Promise<Response> | Response }} */
let server;

function stubServer() {
  server = {
    relay: relayBody(UNCHECKED),
    reads: 0,
    failReads: false,
    readGate: null,
    calls: [],
    answer: () => json({ address: ADDRESS, expiresAt: hoursFromNow(24) }, 202),
  };
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const href = String(url);
    const method = init?.method ?? "GET";
    if (href.includes("/api/auth/session")) return json({ user: { id: "u1" }, csrfToken: "t1" });
    if (href.endsWith("/api/settings/mail-relay/verification") && method === "POST") {
      server.calls.push({ href, init });
      return server.answer(init);
    }
    if (href.endsWith("/api/settings/mail-relay") && method === "GET") {
      server.reads += 1;
      if (server.failReads) throw new TypeError("Failed to fetch");
      if (server.readGate) await server.readGate.promise;
      return json(server.relay);
    }
    return json({ error: { code: "unavailable", message: "not today" } }, 503);
  }));
}

/** A request the test answers when it chooses. */
function held() {
  /** @type {(response: Response) => void} */
  let release = () => {};
  const promise = new Promise((done) => { release = done; });
  return { promise, release };
}

/**
 * The server's refusal. The engine words every refusal once (ADR-0034
 * decision 4, #1410 note 38589): the screen shows the envelope's `message`
 * exactly and does not map codes to words of its own.
 */
const refusal = (/** @type {number} */ status, /** @type {string} */ code, /** @type {string} */ message = `not sent — the engine's words for ${code}`) =>
  json({ error: { code, message } }, status);

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
  media: "(max-width: 900px), (max-height: 600px)",
  addEventListener: (/** @type {string} */ _type, /** @type {() => void} */ handler) => { mediaWatchers.add(handler); },
  removeEventListener: (/** @type {string} */ _type, /** @type {() => void} */ handler) => { mediaWatchers.delete(handler); },
  addListener: () => {},
  removeListener: () => {},
};
/** The window is resized across the phone breakpoint, and the screen is told. */
const switchLayout = async (/** @type {boolean} */ pocket) => {
  media.pocket = pocket;
  for (const handler of [...mediaWatchers]) handler();
  await settle();
};

const settle = async () => {
  const { flushSync } = await import(pathToFileURL(join(svelteSrc, "index-client.js")).href);
  for (let turn = 0; turn < 6; turn += 1) {
    await new Promise((done) => setTimeout(done, 0));
    flushSync();
  }
};

const text = (/** @type {Element | null | undefined} */ element) => (element?.textContent ?? "").replace(/\s+/gu, " ").trim();
const allText = () => text(document.body);
const wakeLines = () => wake.mock.calls.map(([message]) => message);

const ADDRESS_LIVE = "ned.harlow.k3x9@relay.example.test";
const SENDER = { address: ADDRESS, verified: true, verificationPending: false, expiresAt: null };

/** The relay read as the server answers it. */
function relayAnswer(/** @type {object} */ over) {
  return {
    relay: {
      ...RELAY_FIXTURE.relay,
      address: ADDRESS_LIVE,
      listening: "connected · listening",
      ingest: "enabled",
      sender: SENDER,
      ...over,
    },
  };
}
const ADMIN_PAUSED = { ingest: "paused", adminPaused: true };
const NO_MAILBOX = { address: null, listening: "not listening", ingest: "paused", sender: null };

async function mountAnswer(/** @type {object} */ answer, /** @type {boolean} */ pocket) {
  media.pocket = pocket;
  mediaWatchers.clear();
  window.matchMedia = /** @type {any} */ (() => phoneQuery);
  server.relay = answer.relay ? answer : relayAnswer({});
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
}

/* The page always mounts the phone's column (CSS hides it on the desk); the
   desk's own card is .relay-card, the phone's is .rl-column. */
const scope = (/** @type {boolean} */ pocket) => pocket ? ".rl-column" : ".relay-card";
const textOf = (/** @type {boolean} */ pocket) => text(document.querySelector(scope(pocket)));
const copyButton = (pocket = false) => document.querySelector(`${scope(pocket)} button[aria-label^="Copy your relay address"]`);
const said = () => allText() + " | " + wakeLines().join(" | ");

describe("#1654: the address while the administrator has paused ingest", () => {
  for (const { name, pocket } of [{ name: "desk", pocket: false }, { name: "phone", pocket: true }]) {
    it(`${name}: shows the address, copyable, with the paused line`, async () => {
      await mountAnswer(relayAnswer(ADMIN_PAUSED), pocket);
      expect(textOf(pocket)).toContain(ADDRESS_LIVE);
      expect(textOf(pocket)).not.toMatch(/no address yet/iu);
      expect(textOf(pocket)).toMatch(/paused by the administrator/iu);
      expect(textOf(pocket)).toMatch(/mail sent now waits/iu);
      expect(textOf(pocket)).toMatch(/read when it resumes/iu);
      const button = /** @type {HTMLButtonElement | null} */ (copyButton(pocket));
      expect(button, "the address is still a copy button").not.toBeNull();
      expect(button?.disabled).toBe(false);
      expect(button?.getAttribute("aria-label")).toBe(`Copy your relay address, ${ADDRESS_LIVE}`);
    });

    it(`${name}: a mailbox that is not configured says "no address yet", not the paused line`, async () => {
      await mountAnswer(relayAnswer(NO_MAILBOX), pocket);
      expect(textOf(pocket)).toMatch(/no address yet/iu);
      expect(textOf(pocket)).not.toMatch(/paused by the administrator/iu);
    });

    it(`${name}: without an administrator pause the paused line is not shown`, async () => {
      await mountAnswer(relayAnswer({}), pocket);
      expect(textOf(pocket)).toContain(ADDRESS_LIVE);
      expect(textOf(pocket)).not.toMatch(/paused by the administrator/iu);
    });
  }
});

describe("#1658: clicking the address on the desk copies it", () => {
  /** @type {import("vitest").Mock} */
  let writeText;
  const stubClipboard = (/** @type {boolean} */ works) => {
    writeText = vi.fn(() => (works ? Promise.resolve() : Promise.reject(new DOMException("denied", "NotAllowedError"))));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  };

  it("names the button, shows the hint, and copies the address on a click", async () => {
    stubClipboard(true);
    await mountAnswer(relayAnswer({}), false);
    const button = /** @type {HTMLButtonElement} */ (copyButton());
    expect(button, "the address is a button on the desk").not.toBeNull();
    expect(button.getAttribute("aria-label")).toBe(`Copy your relay address, ${ADDRESS_LIVE}`);
    expect(text(button)).toMatch(/click to copy/iu);
    button.click();
    await settle();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(ADDRESS_LIVE);
    expect(said()).toContain("copied · your relay address");
    expect(said()).not.toContain("not copied");
  });

  it("says so when the browser refuses the copy", async () => {
    stubClipboard(false);
    await mountAnswer(relayAnswer({}), false);
    /** @type {HTMLButtonElement} */ (copyButton())?.click();
    await settle();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(said()).toContain("not copied — your browser kept the clipboard closed");
    expect(said()).not.toContain("copied · your relay address");
  });

  it("cannot be clicked while there is no address to use", async () => {
    stubClipboard(true);
    await mountAnswer(relayAnswer(NO_MAILBOX), false);
    const button = /** @type {HTMLButtonElement | null} */ (copyButton());
    expect(button, "the control is still there").not.toBeNull();
    expect(button?.disabled).toBe(true);
    button?.click();
    await settle();
    expect(writeText).not.toHaveBeenCalled();
  });
});
