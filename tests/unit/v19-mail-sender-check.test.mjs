// @vitest-environment happy-dom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { RELAY_FIXTURE } from "../../web/src/lib/data/fixtures/relay.js";
import { clockOf, dayMonth, localZone } from "../../web/src/lib/format.js";

/*
 * #1410 (ADR-0017 decision 7c, design note 36064): the sender check on the
 * settings mail screen. Your relay cannot match mail to you until you have
 * checked the address you send from; the screen shows where that stands and
 * carries the one button that starts it.
 *
 * Written from the design, before the screen was built. It covers:
 *   - the data helpers: the relay read carries `sender`, and
 *     `sendSenderCheck()` posts the request with no body;
 *   - the fixture gate: `RELAY_FIXTURE` carries a checked sender, so the
 *     ratified screenshots do not move;
 *   - both layouts of the screen (the desk page, and the phone's pocket.svelte
 *     through it): the words in each state, one bodyless request per press,
 *     the pending button, the 202 outcome, each refusal in a focused alert, a
 *     press that works again after a refusal, and the `?sender=` landing.
 *
 * Same harness as v19-newcomer-empty-subline.test.mjs and
 * v19-create-bind-refusal.test.mjs: the real components compiled with Svelte's
 * own compiler and mounted in happy-dom, over the real workspace.js and a
 * stubbed server. The shared chrome, sky and rows are stood in for; none has
 * a part in what is tested. Any other component the screen imports is
 * compiled too, so the screen may split itself up.
 *
 * Not covered here (CSS, not words): the desk dish's rings standing still
 * while the status is not usable.
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
  compiledDir = mkdtempSync(resolve(import.meta.dirname, "../../tmp/mail-sender-check-"));
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

/**
 * Mounts the settings mail screen over the relay read the server gives for
 * `sender`, in the desk or the phone layout, landing on `search`.
 */
async function mountScreen(/** @type {{ sender: object | null, pocket: boolean, search?: string }} */ { sender, pocket, search = "" }) {
  media.pocket = pocket;
  mediaWatchers.clear();
  window.matchMedia = /** @type {any} */ (() => phoneQuery);
  server.relay = relayBody(sender);
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
const statusLines = () => [...document.querySelectorAll('[role="status"]')].map(text);
const wakeLines = () => wake.mock.calls.map(([message]) => message);

/** Good news is a `role="status"` line on the desk and a wake on the phone. */
const announced = (/** @type {string} */ words, /** @type {boolean} */ pocket) =>
  (pocket ? wakeLines() : statusLines()).includes(words);

const press = async (/** @type {string} */ label) => {
  const button = buttonSaying(label);
  expect(button, `a "${label}" button is on screen`).not.toBeNull();
  /** @type {HTMLButtonElement} */ (button).focus();
  /** @type {HTMLButtonElement} */ (button).click();
  await settle();
};

const isHeld = (/** @type {Element} */ button) =>
  /** @type {HTMLButtonElement} */ (button).disabled || button.getAttribute("aria-disabled") === "true";

/* ---- the data helpers ------------------------------------------------------ */

describe("#1410: the relay read and the check request", () => {
  it("the relay read carries the sender in every state, and null when there is none", async () => {
    const { readRelay } = await import("../../web/src/lib/data/workspace.js");
    const pending = { address: ADDRESS, verified: false, verificationPending: true, expiresAt: hoursFromNow(20) };
    for (const sender of [UNCHECKED, pending, CHECKED, null]) {
      server.relay = relayBody(sender);
      expect((await readRelay()).sender).toEqual(sender);
    }
  });

  it("sendSenderCheck posts to the verification route with the CSRF token and no body", async () => {
    const { sendSenderCheck } = await import("../../web/src/lib/data/workspace.js");
    expect(sendSenderCheck, "workspace.js exports sendSenderCheck").toBeTypeOf("function");
    await sendSenderCheck();
    expect(server.calls).toHaveLength(1);
    const [{ href, init }] = server.calls;
    expect(href).toMatch(/\/api\/settings\/mail-relay\/verification$/u);
    expect(init?.method).toBe("POST");
    expect(init?.body, "no body: the registered address is the only candidate").toBeUndefined();
    expect(/** @type {Record<string, string>} */ (init?.headers)["x-csrf-token"]).toBe("t1");
  });

  it("the gate's relay fixture carries a checked sender, so the ratified screenshots do not move", () => {
    expect(/** @type {any} */ (RELAY_FIXTURE.relay).sender).toEqual({
      address: ADDRESS,
      verified: true,
      verificationPending: false,
      expiresAt: null,
    });
  });
});

/* ---- the screen, in both layouts ------------------------------------------- */

const LAYOUTS = [
  ["the desk", false, `check email sent to ${ADDRESS} · open the link while signed in, within 24 hours`],
  ["the phone", true, "check email sent · open the link within 24 hours"],
];

const lapsesAt = (/** @type {string} */ iso) => `email sent · link lapses ${dayMonth(iso, localZone())} ${clockOf(iso, localZone())}`;

describe.each(LAYOUTS)("#1410: %s shows where the sender check stands", (_name, pocket) => {
  it("not yet checked: the address, `not yet checked`, and the button to send the check email", async () => {
    await mountScreen({ sender: UNCHECKED, pocket });
    expect(rowSays("sending from")).toBe(ADDRESS);
    expect(rowSays("sender check")).toBe("not yet checked");
    expect(buttonSaying("send the check email")).not.toBeNull();
    expect(allText()).toContain("no checked sending address");
  });

  it("email sent and the link still good: says when it lapses, and offers `send it again`", async () => {
    const expiresAt = hoursFromNow(20);
    await mountScreen({ sender: { address: ADDRESS, verified: false, verificationPending: true, expiresAt }, pocket });
    expect(rowSays("sending from")).toBe(ADDRESS);
    expect(rowSays("sender check")).toBe(lapsesAt(expiresAt));
    expect(buttonSaying("send it again")).not.toBeNull();
    expect(buttonSaying("send the check email")).toBeNull();
  });

  it("link lapsed and still unchecked: says the last link lapsed, and offers the check email again", async () => {
    await mountScreen({
      sender: { address: ADDRESS, verified: false, verificationPending: true, expiresAt: hoursFromNow(-2) },
      pocket,
    });
    expect(rowSays("sender check")).toBe("not yet checked · the last link lapsed");
    expect(buttonSaying("send the check email")).not.toBeNull();
  });

  it("link lapsed as the server reports it (not pending, past expiry): says the last link lapsed (#1403 review)", async () => {
    await mountScreen({
      sender: { address: ADDRESS, verified: false, verificationPending: false, expiresAt: hoursFromNow(-2) },
      pocket,
    });
    expect(rowSays("sender check")).toBe("not yet checked · the last link lapsed");
    expect(buttonSaying("send the check email")).not.toBeNull();
  });

  it("checked: says `checked`, the status row says the relay is listening, and there is no button", async () => {
    server.relay = relayBody(CHECKED);
    await mountScreen({ sender: CHECKED, pocket });
    expect(rowSays("sending from")).toBe(ADDRESS);
    expect(rowSays("sender check")).toBe("checked");
    expect(allText()).toContain("connected · listening");
    expect(buttonSaying("send the check email")).toBeNull();
    expect(buttonSaying("send it again")).toBeNull();
  });

  it("the gate's own fixture reads as checked", async () => {
    await mountScreen({ sender: /** @type {any} */ (RELAY_FIXTURE.relay).sender, pocket });
    expect(rowSays("sender check")).toBe("checked");
    expect(allText()).toContain("connected · listening");
  });

  it("no sender (an administrator, or mail-in off): the block is not there at all", async () => {
    await mountScreen({ sender: null, pocket });
    expect(rowSays("sending from")).toBeNull();
    expect(rowSays("sender check")).toBeNull();
    expect(buttonSaying("send the check email")).toBeNull();
    expect(buttonSaying("send it again")).toBeNull();
  });
});

describe.each(LAYOUTS)("#1410: %s presses the button", (_name, pocket, sentWords) => {
  it("one press sends exactly one request, with no body", async () => {
    await mountScreen({ sender: UNCHECKED, pocket });
    await press("send the check email");
    expect(server.calls).toHaveLength(1);
    const [{ href, init }] = server.calls;
    expect(href).toMatch(/\/api\/settings\/mail-relay\/verification$/u);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
  });

  it("while the request is pending the button is disabled and reads `sending…`, and a second press sends nothing", async () => {
    await mountScreen({ sender: UNCHECKED, pocket });
    const pending = held();
    server.answer = () => pending.promise;
    await press("send the check email");
    const button = buttonSaying("sending…");
    expect(button, "the button reads sending… while the request is out").not.toBeNull();
    expect(isHeld(/** @type {Element} */ (button))).toBe(true);
    /** @type {HTMLButtonElement} */ (button).click();
    await settle();
    expect(server.calls, "a press on the held button sends nothing more").toHaveLength(1);
    pending.release(json({ address: ADDRESS, expiresAt: hoursFromNow(24) }, 202));
    await settle();
    expect(buttonSaying("sending…")).toBeNull();
  });

  it("a 202 updates the row, announces the good news, and relabels the button, which keeps focus", async () => {
    await mountScreen({ sender: UNCHECKED, pocket });
    const expiresAt = hoursFromNow(24);
    server.answer = () => json({ address: ADDRESS, expiresAt }, 202);
    await press("send the check email");
    expect(rowSays("sender check")).toBe(lapsesAt(expiresAt));
    expect(announced(sentWords, pocket), `"${sentWords}" is announced`).toBe(true);
    expect(alerts(), "good news is not an alert").toHaveLength(0);
    const again = buttonSaying("send it again");
    expect(again, "the button now reads send it again").not.toBeNull();
    expect(document.activeElement, "focus stays on the button").toBe(again);
    expect(isHeld(/** @type {Element} */ (again))).toBe(false);
  });

  it("409 sender_already_verified: reads the relay again and says there is nothing to send, as a status and not an alert", async () => {
    await mountScreen({ sender: UNCHECKED, pocket });
    const words = "already checked — the engine's words, nothing to send";
    server.answer = () => {
      server.relay = relayBody(CHECKED);
      return refusal(409, "sender_already_verified", words);
    };
    await press("send the check email");
    expect(server.reads, "the relay is read again").toBeGreaterThanOrEqual(1);
    expect(announced(words, pocket)).toBe(true);
    expect(alertSaying(words)).toBeNull();
    expect(rowSays("sender check")).toBe("checked");
    expect(allText()).toContain("connected · listening");
    expect(buttonSaying("send the check email")).toBeNull();
  });

  const NOT_REACHED = "not sent — Orbit could not reach your relay. try again";
  const engineWords = (/** @type {string} */ code) => `not sent — the engine's words for ${code}`;
  it.each([
    ["409 sender_address_unavailable", () => refusal(409, "sender_address_unavailable"), engineWords("sender_address_unavailable")],
    ["409 sender_address_unreadable", () => refusal(409, "sender_address_unreadable"), engineWords("sender_address_unreadable")],
    ["429 sender_check_too_soon (owner 1a, #1403 note 38581)", () => refusal(429, "sender_check_too_soon"), engineWords("sender_check_too_soon")],
    ["503 smtp_not_configured", () => refusal(503, "smtp_not_configured"), engineWords("smtp_not_configured")],
    ["503 app_url_not_configured", () => refusal(503, "app_url_not_configured"), engineWords("app_url_not_configured")],
    ["503 metadata_locked", () => refusal(503, "metadata_locked"), engineWords("metadata_locked")],
    ["503 a mailer refusal or timeout code", () => refusal(503, "sender_check_mailer_timeout"), engineWords("sender_check_mailer_timeout")],
    ["500 with a code the screen does not know, and a message", () => refusal(500, "something_new"), engineWords("something_new")],
    ["500 with a code and no usable message", () => json({ error: { code: "something_new" } }, 500), NOT_REACHED],
    ["500 with an empty message", () => json({ error: { code: "something_new", message: "" } }, 500), NOT_REACHED],
    ["503 encryption_key_unavailable from the gate, a bare string with no message", () => json({ error: "encryption_key_unavailable" }, 503), NOT_REACHED],
    ["502 from a proxy, with no JSON", () => new Response("<html>bad gateway</html>", { status: 502 }), NOT_REACHED],
    ["no answer at all", () => { throw new TypeError("Failed to fetch"); }, NOT_REACHED],
  ])("%s: its words show in an alert that takes focus", async (_case, answer, words) => {
    await mountScreen({ sender: UNCHECKED, pocket });
    server.answer = answer;
    await press("send the check email");
    const alert = alertSaying(words);
    expect(alert, `an alert says "${words}"`).not.toBeNull();
    expect(alert?.getAttribute("tabindex"), "the alert can take focus without joining the tab order").toBe("-1");
    expect(document.activeElement, "the alert has focus").toBe(alert);
    expect(rowSays("sender check"), "a refusal leaves the row as it was").toBe("not yet checked");
    expect(buttonSaying("send the check email"), "the button is back, enabled").not.toBeNull();
    expect(isHeld(/** @type {Element} */ (buttonSaying("send the check email")))).toBe(false);
  });

  it("a press after a refusal works again: it sends, and the refusal goes", async () => {
    await mountScreen({ sender: UNCHECKED, pocket });
    const smtpWords = "not sent — the engine's words for smtp_not_configured";
    server.answer = () => refusal(503, "smtp_not_configured", smtpWords);
    await press("send the check email");
    expect(alertSaying(smtpWords)).not.toBeNull();

    const expiresAt = hoursFromNow(24);
    server.answer = () => json({ address: ADDRESS, expiresAt }, 202);
    await press("send the check email");
    expect(server.calls, "the second press sent its own request").toHaveLength(2);
    expect(rowSays("sender check")).toBe(lapsesAt(expiresAt));
    expect(announced(sentWords, pocket)).toBe(true);
    expect(alerts().map(text)).not.toContain(smtpWords);
    expect(buttonSaying("send it again")).not.toBeNull();
  });
});

describe.each(LAYOUTS)("#1410: %s after the link in the check email", (_name, pocket) => {
  it("?sender=verified announces the address is checked, shows it, and cleans the address bar", async () => {
    server.relay = relayBody(CHECKED);
    await mountScreen({ sender: CHECKED, pocket, search: "?sender=verified" });
    expect(announced("address checked · your relay is listening", pocket)).toBe(true);
    expect(rowSays("sender check")).toBe("checked");
    expect(allText()).toContain("connected · listening");
    expect(window.location.search, "?sender= is gone from the address bar").toBe("");
    expect(window.location.pathname).toBe("/settings/mail");
  });

  it("?sender=unverified puts a refusal in an alert that takes focus, shows the button, and cleans the address bar", async () => {
    await mountScreen({ sender: UNCHECKED, pocket, search: "?sender=unverified" });
    const words = "that link didn't work — it may have lapsed, been used already, or belong to another sign-in. send a new check email";
    const alert = alertSaying(words);
    expect(alert, `an alert says "${words}"`).not.toBeNull();
    expect(alert?.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement, "the alert has focus").toBe(alert);
    expect(buttonSaying("send the check email"), "the way to a new email is on screen").not.toBeNull();
    expect(window.location.search, "?sender= is gone from the address bar").toBe("");
    expect(window.location.pathname).toBe("/settings/mail");
  });

  it("with no ?sender= nothing is announced and no alert is raised", async () => {
    await mountScreen({ sender: UNCHECKED, pocket });
    expect(statusLines().concat(wakeLines())).not.toContain("address checked · your relay is listening");
    expect(alerts()).toHaveLength(0);
  });
});

/* ---- review findings: written before the fix -------------------------------- */

/** The check button, whatever it reads at the moment. */
const checkButton = () => buttons().find((one) => /^(send the check email|send it again|sending…)$/u.test(text(one))) ?? null;

describe.each(LAYOUTS)("#1410 review: %s", (_name, pocket) => {
  it("shows the lapse time in the member's own zone, not UTC", async () => {
    const before = process.env.TZ;
    process.env.TZ = "Europe/London";
    try {
      /* The next 15 July, 17:05 UTC: 18:05 in London in summer. */
      const now = new Date();
      const year = now.getUTCMonth() > 6 || (now.getUTCMonth() === 6 && now.getUTCDate() >= 15) ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
      const expiresAt = new Date(Date.UTC(year, 6, 15, 17, 5)).toISOString();
      await mountScreen({ sender: { address: ADDRESS, verified: false, verificationPending: true, expiresAt }, pocket });
      expect(rowSays("sender check")).toBe("email sent · link lapses 15 Jul 18:05");
    } finally {
      if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
    }
  });

  it("409 sender_already_verified whose re-read then fails: the row reads `checked` and the button is gone", async () => {
    await mountScreen({ sender: UNCHECKED, pocket });
    server.answer = () => {
      server.failReads = true;
      return refusal(409, "sender_already_verified");
    };
    await press("send the check email");
    expect(server.reads, "the relay was read again, and failed").toBeGreaterThanOrEqual(1);
    expect(rowSays("sender check")).toBe("checked");
    expect(checkButton(), "nothing left to press").toBeNull();
    expect(alerts(), "the failed re-read is not an error to show").toHaveLength(0);
  });

  it("409 sender_already_verified: the button stays held while the re-read is in flight, and a press then sends no second request", async () => {
    await mountScreen({ sender: UNCHECKED, pocket });
    const reread = held();
    server.readGate = reread;
    server.answer = () => {
      server.relay = relayBody(CHECKED);
      return refusal(409, "sender_already_verified");
    };
    await press("send the check email");
    expect(server.reads, "the re-read is out").toBeGreaterThanOrEqual(1);
    const button = checkButton();
    if (button) {
      expect(isHeld(button), "the button is held until the re-read answers").toBe(true);
      button.click();
      await settle();
    }
    expect(server.calls, "no second request").toHaveLength(1);
    reread.release(json({}));
    await settle();
    expect(rowSays("sender check")).toBe("checked");
  });
});

describe.each([
  ["from the desk to the phone", false],
  ["from the phone to the desk", true],
])("#1410 review: the window is resized %s after a press", (_name, startsAsPocket) => {
  it("the other layout shows the same sender check, not the state the page was loaded in", async () => {
    await mountScreen({ sender: UNCHECKED, pocket: startsAsPocket });
    const expiresAt = hoursFromNow(24);
    server.answer = () => json({ address: ADDRESS, expiresAt }, 202);
    await press("send the check email");
    expect(rowSays("sender check")).toBe(lapsesAt(expiresAt));

    await switchLayout(!startsAsPocket);
    expect(rowSays("sender check")).toBe(lapsesAt(expiresAt));
    expect(buttonSaying("send it again")).not.toBeNull();
    expect(buttonSaying("send the check email")).toBeNull();
    expect(allText()).not.toContain("not yet checked");
  });
});

describe("#1410 review: the phone after a 409 sender_already_verified", () => {
  it("focus moves to the status message (or its field) when the button goes, not to the page", async () => {
    await mountScreen({ sender: UNCHECKED, pocket: true });
    server.answer = () => {
      server.relay = relayBody(CHECKED);
      return refusal(409, "sender_already_verified");
    };
    await press("send the check email");
    expect(checkButton(), "the button has gone").toBeNull();
    const active = document.activeElement;
    expect(active, "focus is not dropped on the page").not.toBe(document.body);
    expect(active?.closest('[role="status"], .rl-field'), "focus is on the status message or its field").not.toBeNull();
  });
});
