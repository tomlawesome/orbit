import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * The administration form draft that survives a sign-in round trip.
 *
 * Before an administrator is sent to re-confirm their sign-in, the person
 * they were typing (email and name) is kept in the tab's session storage so
 * the form can be refilled on return. That personal data must not outlive the
 * errand: if the re-check cannot start, nothing may be left behind, and a
 * return that belongs to a different errand must neither refill the form nor
 * leave the old draft sitting in storage.
 *
 * Evaluated rather than mounted (no component-mounting harness in this suite;
 * see administration-landed-then-reread.test.mjs): each function is lifted out
 * of its source and run against stand-in state and a stand-in storage.
 */

const DESK_PATH = "web/src/routes/administration/+page.svelte";
const DRAFT_KEY = "orbit-local-user-draft";
const BLANK = { email: "", displayName: "", expiresInDays: 7 };
const TYPED = { email: "someone@example.invalid", displayName: "Someone Example", expiresInDays: 7 };

/** @returns {Storage} */
function fakeStorage() {
  const map = new Map();
  return /** @type {any} */ ({
    getItem: (/** @type {string} */ k) => (map.has(k) ? map.get(k) : null),
    setItem: (/** @type {string} */ k, /** @type {string} */ v) => { map.set(k, String(v)); },
    removeItem: (/** @type {string} */ k) => { map.delete(k); },
    key: (/** @type {number} */ i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
    clear: () => map.clear(),
  });
}

/**
 * Lift a (possibly async) top-level function out of the desk component and run
 * it with `scope` in reach. State it assigns lands back on `scope`.
 * @param {string} name @param {Record<string, unknown>} scope
 */
function lift(name, scope) {
  const src = readFileSync(new URL(`../../${DESK_PATH}`, import.meta.url), "utf8");
  const match = new RegExp(`(async )?function ${name}\\(`).exec(src);
  expect(match, `${DESK_PATH} has no \`${name}\``).not.toBeNull();
  const start = /** @type {RegExpExecArray} */ (match).index;
  const end = src.indexOf("\n  }\n", start);
  const body = src.slice(start, end + "\n  }".length);
  const sandbox = new Proxy(scope, {
    has: (target, key) => typeof key === "string" && (key in target || !(key in globalThis)),
  });
  return new Function("sandbox", `with (sandbox) { return (${body}); }`)(sandbox);
}

/** @param {{ startStepUp: () => Promise<void>, sessionStorage: Storage }} parts */
function desk({ startStepUp, sessionStorage }) {
  /** @type {Record<string, any>} */
  const scope = {
    DRAFT_KEY,
    SETUP_LINK_DAYS: { fallback: 7 },
    sessionStorage,
    localDraft: { ...TYPED },
    localCard: { busy: false, problem: null },
    resendCard: { busy: false, problem: null },
    localArmed: false,
    provenIntent: null,
    actorHasPassword: false,
    resumedResendPersonId: null,
    startStepUp,
    setupWords: (/** @type {unknown} */ e) => (e instanceof Error ? e.message : String(e)),
    wordsOf: (/** @type {unknown} */ e) => (e instanceof Error ? e.message : String(e)),
  };
  scope.stashDraft = lift("stashDraft", scope);
  return scope;
}

describe("administration form draft in session storage", () => {
  it("leaves nothing in storage when the sign-in re-check cannot start", async () => {
    const sessionStorage = fakeStorage();
    const scope = desk({ startStepUp: async () => { throw new Error("provider is down"); }, sessionStorage });
    const challengeThen = lift("challengeThen", scope);
    let reported = null;
    await challengeThen("local_user_create", () => { scope.localArmed = true; }, (/** @type {string} */ m) => { reported = m; });

    expect(reported, "the failure should still be shown").toBeTruthy();
    expect(sessionStorage.getItem(DRAFT_KEY), "the typed person must not be left in storage").toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("does not refill the form on a return for a different errand, and drops the stored draft", async () => {
    const sessionStorage = fakeStorage();
    const scope = desk({ startStepUp: async () => {}, sessionStorage });
    const challengeThen = lift("challengeThen", scope);
    await challengeThen("local_user_create", () => { scope.localArmed = true; });
    expect(sessionStorage.getItem(DRAFT_KEY), "precondition: the draft was kept for the round trip").not.toBeNull();

    scope.localDraft = { ...BLANK };
    const restoreDraft = lift("restoreDraft", scope);
    restoreDraft("setup_link_issue");

    expect(scope.localDraft.email).toBe("");
    expect(scope.localDraft.displayName).toBe("");
    expect(sessionStorage.getItem(DRAFT_KEY), "a draft for another errand must be removed, not kept").toBeNull();
  });

  it("still refills the form on a return for the same errand, and removes the draft", async () => {
    const sessionStorage = fakeStorage();
    const scope = desk({ startStepUp: async () => {}, sessionStorage });
    const challengeThen = lift("challengeThen", scope);
    await challengeThen("local_user_create", () => { scope.localArmed = true; });

    scope.localDraft = { ...BLANK };
    const restoreDraft = lift("restoreDraft", scope);
    restoreDraft("local_user_create");

    expect(scope.localDraft.email).toBe(TYPED.email);
    expect(scope.localDraft.displayName).toBe(TYPED.displayName);
    expect(sessionStorage.getItem(DRAFT_KEY), "the draft is single-use").toBeNull();
  });
});
