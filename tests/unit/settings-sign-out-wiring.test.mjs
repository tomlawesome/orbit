import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

/*
 * #1439 (review round 2): two faults in how settings uses sign-out.js.
 *
 * C. The desk's `descendFrom` wrapper was `(redirectTo) => chrome?.descendFrom(redirectTo)`.
 * With Chrome not bound that is `undefined(...)` quietly returning undefined,
 * so sign-out.js saw a descent that "worked", navigated nowhere, and its tested
 * fallback (location.href = redirectTo ?? "/logout") never ran. The shape the
 * builder implements: with Chrome unbound the wrapper THROWS (or rejects) --
 * sign-out.js treats a throw, a rejection or a non-function alike -- and with
 * Chrome bound it still hands the redirect on and returns Chrome's answer.
 * The wrapper stays a single `const descendFrom = ...` or `function
 * descendFrom` declaration in the desk's +page.svelte script that reads only
 * the `chrome` variable, so the test can lift it out and run it.
 *
 * D. The "signs you out of your sign-in provider in this browser only"
 * sentence is true only where a provider is offered: on both layouts it sits
 * inside an `{#if providerOffered ...}` block.
 */

const DESK = "web/src/routes/settings/+page.svelte";
const POCKET = "web/src/routes/settings/pocket.svelte";
/** @param {string} rel */
const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

vi.mock("$lib/data/workspace.js", () => ({
  revokeSession: async () => null,
  signOutEverywhere: async () => null,
  wordsOf: (/** @type {unknown} */ _error, /** @type {string} */ fallback) => fallback,
}));

/**
 * The desk's descendFrom declaration, lifted out of the source and run with
 * `chrome` as given.
 *
 * @param {unknown} chrome
 * @returns {((redirectTo: string | null) => unknown) | undefined}
 */
function wrapperWith(chrome) {
  const src = read(DESK);
  const start = src.search(/(?:const|let)\s+descendFrom\s*=|function\s+descendFrom\s*\(/);
  expect(start, `${DESK} has no descendFrom declaration`).toBeGreaterThan(-1);
  /* Walk to the end of the declaration: the `;` at depth 0, or for a function
     declaration the brace that closes its body. */
  let depth = 0;
  let end = -1;
  const isFunction = src.startsWith("function", start);
  for (let i = start; i < src.length; i += 1) {
    const c = src[i];
    if (c === "(" || c === "{" || c === "[") depth += 1;
    if (c === ")" || c === "}" || c === "]") {
      depth -= 1;
      if (isFunction && c === "}" && depth === 0) { end = i + 1; break; }
    }
    if (c === ";" && depth === 0 && !isFunction) { end = i + 1; break; }
  }
  expect(end, "descendFrom declaration never ends").toBeGreaterThan(start);
  const declaration = src.slice(start, end).replace(/^let\b/, "const");
  return new Function("chrome", `"use strict";\n${declaration}\nreturn typeof descendFrom === "undefined" ? undefined : descendFrom;`)(chrome);
}

describe("settings desk's descendFrom wrapper (#1439)", () => {
  it("with Chrome not bound, gives sign-out.js a descent that fails, so its fallback runs", async () => {
    const wrapper = wrapperWith(undefined);
    if (wrapper === undefined) return; /* not passing a descent at all is the other allowed shape */
    expect(typeof wrapper).toBe("function");
    /* sign-out.js does `await descendFrom(redirectTo)` inside a try: a sync
       throw or a rejection both reach its fallback; a quiet undefined does not. */
    await expect((async () => wrapper("https://idp.invalid/end"))()).rejects.toBeDefined();
    await expect((async () => wrapper(null))()).rejects.toBeDefined();
  });

  it("with Chrome bound, hands the redirect on and returns Chrome's answer", async () => {
    const descendFrom = vi.fn(async () => "descended");
    const wrapper = wrapperWith({ descendFrom });
    expect(typeof wrapper).toBe("function");
    await expect(Promise.resolve(wrapper?.("https://idp.invalid/end"))).resolves.toBe("descended");
    expect(descendFrom).toHaveBeenCalledWith("https://idp.invalid/end");
  });

  it("makes sign-out.js navigate by its own fallback when Chrome is not bound", async () => {
    const { signOutOfEveryDevice } = await import("../../web/src/routes/settings/sign-out.js");
    const wrapper = wrapperWith(undefined);
    /** @type {string[]} */
    const hrefs = [];
    vi.stubGlobal("location", {
      set href(to) { hrefs.push(String(to)); },
      get href() { return "http://orbit.invalid/settings"; },
    });
    try {
      await signOutOfEveryDevice(wrapper);
    } finally {
      vi.unstubAllGlobals();
    }
    /* revokeSession/signOutEverywhere answer null above, so redirectTo is null
       and the fallback is "/logout". */
    expect(hrefs).toEqual(["/logout"]);
  });
});

/**
 * The conditions of the `{#if}` blocks open at `index`, innermost last, each
 * with whether `index` is in that block's `{:else}` part.
 *
 * @param {string} src @param {number} index
 */
function openIfsAt(src, index) {
  /** @type {{ cond: string, inElse: boolean }[]} */
  const stack = [];
  const tokens = /\{#if\s+([^}]*)\}|\{:else if\s+([^}]*)\}|\{:else\}|\{\/if\}/g;
  for (const m of src.slice(0, index).matchAll(tokens)) {
    if (m[0].startsWith("{#if")) stack.push({ cond: m[1], inElse: false });
    else if (m[0].startsWith("{:else if")) stack[stack.length - 1] = { cond: m[2], inElse: false };
    else if (m[0] === "{:else}") stack[stack.length - 1].inElse = true;
    else stack.pop();
  }
  return stack;
}

describe.each([
  ["desk", DESK],
  ["phone", POCKET],
])("settings %s's provider sentence (#1439)", (_label, file) => {
  it("shows 'signs you out of your sign-in provider in this browser only' only where a provider is offered", () => {
    const src = read(file);
    const phrase = "sign-in provider in this browser only";
    const at = src.indexOf(phrase);
    expect(at, `${file} lost the provider sentence`).toBeGreaterThan(-1);
    expect(src.indexOf(phrase, at + 1), "the sentence appears twice").toBe(-1);
    const guarded = openIfsAt(src, at).some((one) => !one.inElse && /\bproviderOffered\b/.test(one.cond) && !/^\s*!/.test(one.cond));
    expect(guarded, `${file}: the provider sentence is not inside {#if providerOffered}`).toBe(true);
  });

  it("still says Orbit signs out everywhere", () => {
    expect(read(file)).toMatch(/signs Orbit out everywhere/);
  });
});
