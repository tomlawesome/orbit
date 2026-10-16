import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1439: settings' own sign-outs ("this device", and "sign out of every
 * device") ended Orbit's session but skipped the goodbye and the identity
 * provider's own sign-out that the ordinary sign-out plays (#1316 9a).
 *
 * The decision moves into one plain module beside helm.js,
 * web/src/routes/settings/sign-out.js, shared by the desk and the pocket:
 *   - signOutOfDevice(row, descendFrom) -> Promise<boolean>: true when this
 *     device left, false when another device's row was dropped;
 *   - signOutOfEveryDevice(descendFrom) -> Promise<void>.
 * The order is the ordinary sign-out's: end the server session first and wait
 * for it, then hand the answer's redirectTo to Chrome's descent, which owns
 * every navigation. The helper itself never navigates on success and never to
 * /login. When the descent cannot be had (missing, throws or rejects) it falls
 * back as Chrome does: location.href = redirectTo ?? "/logout". A failed
 * revoke is re-thrown untouched, so each caller keeps its own problem text.
 *
 * workspace.js is a stand-in recording every call into one ordered array;
 * window.location and window.history are the recording fakes of
 * sign-out-provider-session.test.mjs.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (/** @type {string} */ rel) => readFileSync(path.join(ROOT, rel), "utf8");

const PROVIDER = "https://idp.invalid/end?post_logout_redirect_uri=https%3A%2F%2Forbit.invalid%2Flogout";

/** Every call the helper makes, in order: "revoke:<id>", "everywhere", "descend:<redirectTo>". */
/** @type {string[]} */
let calls = [];
/** What the next revokeSession / signOutEverywhere does; set per test. */
/** @type {() => Promise<unknown>} */
let revokeAnswer = async () => null;
/** @type {() => Promise<unknown>} */
let everywhereAnswer = async () => null;

vi.mock("$lib/data/workspace.js", () => ({
  revokeSession: (/** @type {string} */ id) => {
    calls.push(`revoke:${id}`);
    return revokeAnswer();
  },
  signOutEverywhere: () => {
    calls.push("everywhere");
    return everywhereAnswer();
  },
  wordsOf: (/** @type {unknown} */ _error, /** @type {string} */ fallback) => fallback,
}));

const { signOutOfDevice, signOutOfEveryDevice } = await import("../../web/src/routes/settings/sign-out.js");

/**
 * Recording stand-ins for window.location and window.history, installed as
 * the globals the module reads (copied from sign-out-provider-session.test.mjs).
 */
function fakeWindow() {
  const base = "http://orbit.invalid/settings";
  let href = base;
  /** @type {Array<{ how: string, to: string }>} every navigation, in order */
  const navigations = [];
  /** @type {Array<string | null>} every address history.replaceState was given */
  const addresses = [];
  /** @param {string} how @param {string | URL} to */
  const go = (how, to) => {
    href = new URL(String(to), href).href;
    navigations.push({ how, to: String(to) });
  };
  const location = {
    get href() { return href; },
    set href(to) { go("href", to); },
    replace: (/** @type {string} */ to) => go("replace", to),
    assign: (/** @type {string} */ to) => go("assign", to),
    get pathname() { return new URL(href).pathname; },
    origin: "http://orbit.invalid",
  };
  const history = {
    state: null,
    replaceState: (/** @type {unknown} */ _state, /** @type {string} */ _title, /** @type {string | null} */ address) => {
      addresses.push(address ?? null);
    },
    pushState: () => { throw new Error("a sign-out must never push a history entry"); },
  };
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("location", location);
  vi.stubGlobal("history", history);
  return { navigations, addresses };
}

/** @type {ReturnType<typeof fakeWindow>} */
let win;

/** A descent that records its call and plays (resolves) at once. */
const descend = (/** @type {string | null} */ redirectTo) => {
  calls.push(`descend:${redirectTo}`);
  return Promise.resolve();
};

/** A promise held open by the test. */
function deferred() {
  /** @type {(value: unknown) => void} */
  let resolve = () => {};
  /** @type {(error: unknown) => void} */
  let reject = () => {};
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const THIS_DEVICE = { id: "s-this", current: true, device: "Firefox on Linux" };
const OTHER_DEVICE = { id: "s-other", current: false, device: "Safari on iPhone" };

beforeEach(() => {
  calls = [];
  revokeAnswer = async () => null;
  everywhereAnswer = async () => null;
  win = fakeWindow();
});

afterEach(() => {
  // Nowhere, in any case, does a settings sign-out go to /login: through the
  // provider's still-live single sign-on that signs the reader straight back in.
  for (const navigation of win.navigations) {
    expect(navigation.to, "a settings sign-out navigated to /login").not.toMatch(/\/login/u);
  }
  for (const address of win.addresses) {
    expect(address ?? "", "a settings sign-out put /login in the address").not.toMatch(/\/login/u);
  }
  vi.unstubAllGlobals();
});

describe("#1439: signing out of this device from settings (signOutOfDevice)", () => {
  it("ends the server session first, then hands the provider URL to the descent, and itself navigates nowhere", async () => {
    const revoke = deferred();
    revokeAnswer = () => revoke.promise;
    const descendFrom = vi.fn(descend);

    const leaving = signOutOfDevice(THIS_DEVICE, descendFrom);
    // The revoke is in flight: nothing may play yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["revoke:s-this"]);
    expect(descendFrom).not.toHaveBeenCalled();

    revoke.resolve(PROVIDER);
    await expect(leaving).resolves.toBe(true);

    expect(calls).toEqual(["revoke:s-this", `descend:${PROVIDER}`]);
    expect(descendFrom).toHaveBeenCalledTimes(1);
    expect(win.navigations).toEqual([]);
  });

  it("plays the descent with null when there is no provider session to end", async () => {
    revokeAnswer = async () => null;
    const descendFrom = vi.fn(descend);

    await expect(signOutOfDevice(THIS_DEVICE, descendFrom)).resolves.toBe(true);

    expect(descendFrom).toHaveBeenCalledTimes(1);
    expect(descendFrom).toHaveBeenCalledWith(null);
    expect(calls).toEqual(["revoke:s-this", "descend:null"]);
    expect(win.navigations).toEqual([]);
  });

  it("only drops another device's row: no descent, no navigation", async () => {
    revokeAnswer = async () => null;
    const descendFrom = vi.fn(descend);

    await expect(signOutOfDevice(OTHER_DEVICE, descendFrom)).resolves.toBe(false);

    expect(calls).toEqual(["revoke:s-other"]);
    expect(descendFrom).not.toHaveBeenCalled();
    expect(win.navigations).toEqual([]);
  });

  it.each([
    ["this device", THIS_DEVICE],
    ["another device", OTHER_DEVICE],
  ])("re-throws a failed revoke of %s untouched, with no descent and no navigation", async (_label, row) => {
    const failure = new Error("still signed in");
    revokeAnswer = async () => { throw failure; };
    const descendFrom = vi.fn(descend);

    await expect(signOutOfDevice(row, descendFrom)).rejects.toBe(failure);

    expect(calls).toEqual([`revoke:${row.id}`]);
    expect(descendFrom).not.toHaveBeenCalled();
    expect(win.navigations).toEqual([]);
  });
});

describe("#1439: signing out of every device from settings (signOutOfEveryDevice)", () => {
  it.each([
    ["the provider URL", PROVIDER],
    ["null", null],
  ])("ends every session first, then hands %s to the descent, and itself navigates nowhere", async (_label, answer) => {
    const everywhere = deferred();
    everywhereAnswer = () => everywhere.promise;
    const descendFrom = vi.fn(descend);

    const leaving = signOutOfEveryDevice(descendFrom);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["everywhere"]);
    expect(descendFrom).not.toHaveBeenCalled();

    everywhere.resolve(answer);
    await leaving;

    expect(calls).toEqual(["everywhere", `descend:${answer}`]);
    expect(descendFrom).toHaveBeenCalledTimes(1);
    expect(descendFrom).toHaveBeenCalledWith(answer);
    expect(win.navigations).toEqual([]);
  });

  it("re-throws a failed sign-out everywhere untouched, with no descent and no navigation", async () => {
    const failure = new Error("still signed in");
    everywhereAnswer = async () => { throw failure; };
    const descendFrom = vi.fn(descend);

    await expect(signOutOfEveryDevice(descendFrom)).rejects.toBe(failure);

    expect(calls).toEqual(["everywhere"]);
    expect(descendFrom).not.toHaveBeenCalled();
    expect(win.navigations).toEqual([]);
  });
});

describe("#1439: when the goodbye cannot be had, the helper leaves as Chrome's fallback does", () => {
  /** The three ways the flight or Chrome is not there to play the descent. */
  const UNAVAILABLE = [
    ["missing", undefined],
    ["throws", () => { throw new Error("the flight cannot be had"); }],
    ["rejects", () => Promise.reject(new Error("the flight cannot be had"))],
  ];
  const ANSWERS = [
    ["the provider URL", PROVIDER, PROVIDER],
    ["null", null, "/logout"],
  ];
  const CASES = UNAVAILABLE.flatMap(([how, descendFrom]) =>
    ANSWERS.map(([label, answer, to]) => [how, label, descendFrom, answer, to]));

  it.each(CASES)("this device, descent %s, answer %s: goes there without throwing", async (_how, _label, descendFrom, answer, to) => {
    revokeAnswer = async () => answer;

    await expect(signOutOfDevice(THIS_DEVICE, /** @type {any} */ (descendFrom))).resolves.toBe(true);

    expect(calls[0]).toBe("revoke:s-this");
    expect(win.navigations.at(-1)?.to).toBe(to);
  });

  it.each(CASES)("every device, descent %s, answer %s: goes there without throwing", async (_how, _label, descendFrom, answer, to) => {
    everywhereAnswer = async () => answer;

    await expect(signOutOfEveryDevice(/** @type {any} */ (descendFrom))).resolves.toBeUndefined();

    expect(calls[0]).toBe("everywhere");
    expect(win.navigations.at(-1)?.to).toBe(to);
  });

  it("another device's row never falls back to a navigation, even with no descent to hand", async () => {
    revokeAnswer = async () => null;

    await expect(signOutOfDevice(OTHER_DEVICE, /** @type {any} */ (undefined))).resolves.toBe(false);

    expect(win.navigations).toEqual([]);
  });
});

describe("#1439: both settings layouts use the one helper and never send the reader to /login", () => {
  it.each([
    ["the desk", "web/src/routes/settings/+page.svelte"],
    ["the pocket", "web/src/routes/settings/pocket.svelte"],
  ])("%s imports ./sign-out.js and names no /login address", (_label, file) => {
    const source = read(file);
    expect(source).toMatch(/from\s+["']\.\/sign-out\.js["']/u);
    expect(source).not.toContain('"/login"');
    expect(source).not.toMatch(/["'`]\/login\b/u);
  });
});
