import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * #1442 (review round 2): the administration screens say so when the People
 * panel, the Public contact panel or the whole screen could not be read,
 * instead of "0 people" / "only you so far" / "address not set" or a blank
 * "Loading administration" that never ends.
 *
 * Static scan rather than a mount, the same shape as
 * administration-pocket-tells-scope.test.mjs (there is no component-mounting
 * harness in this suite). The shape the builder implements, chosen as the
 * smallest that can be scanned:
 *
 *   - readAdminScreen() gives `failed.users` and `failed.contact` (see
 *     workspace-admin-failed-read.test.js) and REJECTS when the workspace read
 *     fails;
 *   - the desk (+page.svelte) has a `loadScreen` function that awaits
 *     readAdminScreen() inside a try/catch (or `.catch`), sets
 *     `screenProblem` to words containing "could not load administration" on
 *     failure and clears it on success; the first read on mount goes through
 *     `loadScreen`, so no bare `readAdminScreen().then(` is left;
 *   - the desk shows `screenProblem` (while there is no `view`) with a
 *     "try again" button wired to `loadScreen`;
 *   - the desk passes the phone `{screenProblem}` and `onretry={loadScreen}`;
 *     pocket.svelte takes `screenProblem` and `onretry` props and, while there
 *     is no `view`, shows the words with a "try again" button wired to
 *     `onretry` (not the endless skeleton);
 *   - the People and Public contact panels, on both layouts, show a "try
 *     again" next to their failure note (`failed.users`, `failed.contact`),
 *     wired to the layout's existing retry (desk `rereadScreen`, phone
 *     `tryAgain`);
 *   - a failed users read is `view.users === null`, so nothing reads
 *     `view.users.length` unguarded, and "only you so far" is not what a
 *     failed read shows.
 */

const DESK_PATH = "web/src/routes/administration/+page.svelte";
const POCKET_PATH = "web/src/routes/administration/pocket.svelte";

/** @param {string} rel */
const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

/**
 * The text of the braces block that follows `declaration` (a function or an
 * arrow assigned to a const), found by counting braces.
 *
 * @param {string} src @param {RegExp} declaration
 */
function bodyOf(src, declaration) {
  const match = declaration.exec(src);
  expect(match, `no declaration matching ${declaration}`).not.toBeNull();
  const open = src.indexOf("{", /** @type {RegExpExecArray} */ (match).index + /** @type {RegExpExecArray} */ (match)[0].length);
  expect(open, `${declaration} has no body`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`${declaration} body never closes`);
}

/** Every match of `needle` in `src`, as the text from the match to `reach` characters on. */
/** @param {string} src @param {string | RegExp} needle @param {number} reach */
function windowsAfter(src, needle, reach) {
  const re = new RegExp(needle, "g");
  /** @type {string[]} */
  const out = [];
  for (const m of src.matchAll(re)) out.push(src.slice(m.index, m.index + reach));
  return out;
}

describe.each([
  ["desk (+page.svelte)", DESK_PATH, /onclick=\{rereadScreen\}/],
  ["phone (pocket.svelte)", POCKET_PATH, /onclick=\{tryAgain\}/],
])("administration %s names a failed People and Public contact read (#1442)", (_label, file, retry) => {
  it("offers 'try again' beside the failed people note", () => {
    const hits = windowsAfter(read(file), /failed\.users\b/, 700);
    expect(hits.length, `${file} never reads failed.users`).toBeGreaterThan(0);
    expect(hits.some((w) => /try again/.test(w) && retry.test(w)), `${file}: no 'try again' wired to the retry after failed.users`).toBe(true);
  });

  it("offers 'try again' beside the failed contact note", () => {
    const hits = windowsAfter(read(file), /failed\.contact\b/, 700);
    expect(hits.length, `${file} never reads failed.contact`).toBeGreaterThan(0);
    expect(hits.some((w) => /try again/.test(w) && retry.test(w)), `${file}: no 'try again' wired to the retry after failed.contact`).toBe(true);
  });

  it("never reads the people list unguarded: a failed read is null, not []", () => {
    expect(read(file)).not.toMatch(/\bview\.users\.length\b/);
  });
});

/**
 * The `{#if}` blocks open at `index`, innermost last, each with its condition
 * and whether `index` is in its `{:else}` part.
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

describe("administration pocket.svelte's people list (#1442)", () => {
  it("does not say 'only you so far' for a failed read", () => {
    const src = read(POCKET_PATH);
    const at = src.indexOf("only you so far");
    expect(at, "pocket.svelte no longer has the 'only you so far' line").toBeGreaterThan(-1);
    /* Either inside an {#if} that tests failed.users to be false, or in the
       {:else} of one that tests it to be true. */
    const guarded = openIfsAt(src, at).some((one) => /failed\.users\b/.test(one.cond)
      && (one.inElse ? !/^\s*!/.test(one.cond) : /^\s*!/.test(one.cond) || /failed\.users\s*(===\s*false|==\s*false)/.test(one.cond)));
    expect(guarded, "'only you so far' can still show for a failed users read").toBe(true);
  });
});

describe("administration desk +page.svelte's screen-level failure (#1442)", () => {
  it("loads the screen through loadScreen, which catches a failed read", () => {
    const src = read(DESK_PATH);
    const body = bodyOf(src, /(?:async\s+function\s+loadScreen\s*\([^)]*\)|const\s+loadScreen\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)/);
    expect(body).toMatch(/\breadAdminScreen\(\)/);
    expect(body).toMatch(/\bcatch\b/);
    expect(body).toMatch(/\bscreenProblem\s*=/);
    expect(src, "the first read on mount still chains a bare readAdminScreen().then(").not.toMatch(/readAdminScreen\(\)\s*\.then\(/);
  });

  it("says Orbit could not load administration, with a try again wired to loadScreen, while there is no view", () => {
    const src = read(DESK_PATH);
    expect(src).toMatch(/could not load administration/);
    const hits = windowsAfter(src, /\{#if\s+screenProblem\s*&&\s*!view\s*\}/, 600);
    expect(hits.length, "no `{#if screenProblem && !view}` block").toBeGreaterThan(0);
    expect(hits.some((w) => /try again/.test(w) && /onclick=\{loadScreen\}/.test(w))).toBe(true);
  });

  it("hands the phone layout the problem and the retry", () => {
    const src = read(DESK_PATH);
    const at = src.indexOf("<Pocket ");
    const tag = src.slice(at, src.indexOf("/>", at));
    expect(tag).toMatch(/\{screenProblem\}/);
    expect(tag).toMatch(/onretry=\{loadScreen\}/);
  });
});

describe("administration pocket.svelte's screen-level failure (#1442)", () => {
  it("takes screenProblem and onretry props", () => {
    const src = read(POCKET_PATH);
    const props = src.slice(src.indexOf("$props()") - 400, src.indexOf("$props()"));
    expect(props).toMatch(/\bscreenProblem\b/);
    expect(props).toMatch(/\bonretry\b/);
  });

  it("says the problem with a try again wired to onretry while there is no view", () => {
    const hits = windowsAfter(read(POCKET_PATH), /\{#if\s+screenProblem\s*&&\s*!view\s*\}/, 600);
    expect(hits.length, "no `{#if screenProblem && !view}` block").toBeGreaterThan(0);
    expect(hits.some((w) => /\{screenProblem\}/.test(w) && /try again/.test(w) && /onclick=\{onretry\}/.test(w))).toBe(true);
  });
});

/*
 * #1442 (review round 3): the same on the other four panels of a live
 * instance, on both layouts. When the relay (mail settings), services
 * (service checks), instance (build) or owners (every system's members) read
 * fails, the panel says so in a note with a "try again" wired to the layout's
 * retry, and the screen still renders: a failed list is treated as empty at
 * the point it is iterated (`view.relay ?? []`), never iterated as null.
 *
 *   - readAdminScreen() gives `failed.relay`, `failed.services`,
 *     `failed.instance` and `failed.owners`; relay, services and instance are
 *     null when their read failed, and owners stays an (incomplete) object;
 *   - each panel's note is the text from its `failed.<panel>` test to the
 *     `{/if}` that closes it: it says Orbit could not reach what was read,
 *     and holds the "try again" button, wired to `rereadScreen` on the desk
 *     and `tryAgain` on the phone;
 *   - the version strip's note is the `{:else if view.failed.instance}` of the
 *     `{#if view.instance}` that draws the line, so a failed read never prints
 *     a null build.
 */

/**
 * The text from each `needle` match to the `{/if}` that closes its block.
 * @param {string} src @param {string | RegExp} needle
 */
function notesAfter(src, needle) {
  return windowsAfter(src, needle, src.length).map((rest) => {
    const end = rest.indexOf("{/if}");
    return end === -1 ? rest : rest.slice(0, end);
  });
}

const FAILED_PANELS = [
  ["relay", "mail settings"],
  ["services", "service checks"],
  ["instance", "build"],
  ["owners", "members"],
];

describe.each([
  ["desk (+page.svelte)", DESK_PATH, /onclick=\{rereadScreen\}/],
  ["phone (pocket.svelte)", POCKET_PATH, /onclick=\{tryAgain\}/],
])("administration %s names a failed relay, services, instance and owners read (#1442)", (_label, file, retry) => {
  it.each(FAILED_PANELS)("says the %s read failed, with a 'try again' wired to the retry", (panel, what) => {
    const notes = notesAfter(read(file), new RegExp(`failed\\.${panel}\\b`));
    expect(notes.length, `${file} never reads failed.${panel}`).toBeGreaterThan(0);
    expect(
      notes.some((note) => /role="alert"/.test(note) && /could not reach/.test(note) && note.includes(what)
        && /try again/.test(note) && retry.test(note)),
      `${file}: no alert saying Orbit could not reach the ${what}, with a 'try again' wired to the retry, after failed.${panel}`,
    ).toBe(true);
  });

  it("iterates the relay rows and the service rows as empty when their read failed, never as null", () => {
    const src = read(file);
    for (const list of ["relay", "services"]) {
      expect(src, `${file}: view.${list} is iterated without a fallback`).not.toMatch(new RegExp(`\\{#each\\s+view\\.${list}\\s+as\\b`));
      expect(src, `${file}: view.${list} is not iterated as (view.${list} ?? [])`).toMatch(new RegExp(`\\{#each\\s+view\\.${list}\\s*\\?\\?\\s*\\[\\]\\s+as\\b`));
    }
    expect(src, `${file}: view.services is read unguarded`).not.toMatch(/\bview\.services\.(?:filter|map|find|length|forEach|some)\b/);
    expect(src, `${file}: view.relay is read unguarded`).not.toMatch(/\bview\.relay\.(?:filter|map|find|length|forEach|some)\b/);
  });

  it("shows the build line only for a build that was read, and the failed note in its else", () => {
    const src = read(file);
    const at = src.search(/failed\.instance\b/);
    expect(at, `${file} never reads failed.instance`).toBeGreaterThan(-1);
    const guarded = openIfsAt(src, at).some((one) => /\bview\.instance\b/.test(one.cond) && !/failed\./.test(one.cond))
      || /\{#if\s+view\.instance\s*\}[^]*\{:else if\s+view\.failed\.instance\s*\}/.test(src);
    expect(guarded, `${file}: the failed-instance note is not the else of the {#if view.instance} that draws the build`).toBe(true);
  });
});

describe("administration desk +page.svelte's backdrop caption facts (#1442)", () => {
  /* The caption itself is tested in administration-station-caption-failed-reads.test.mjs;
     this is the place the made-up number comes from. */
  const src = read(DESK_PATH);
  const at = src.indexOf("facts:");
  const facts = src.slice(at, src.indexOf("}", at) + 1);

  it("hands the backdrop the caption's facts", () => {
    expect(at, "no `facts:` handed to mountStation").toBeGreaterThan(-1);
    expect(facts).toMatch(/\bcrew\b/);
  });

  it("does not turn a failed users read (null) into a crew of 0", () => {
    expect(facts).not.toMatch(/\?\?\s*0\b|\|\|\s*0\b/);
  });
});
