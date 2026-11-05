import { describe, expect, it, vi } from "vitest";

import { FLOOR, SMALL_RULE_OVERRIDDEN, TOKENS_FILE, UNREADABLE, pocketFiles, pxOf, readPocketSources, tapFloorProblems, tokensOf } from "./pocket-tap-floor-lib.mjs";

/*
 * #1616 (ADR-0039 §6): the 44px tap floor, checked where the code that sets
 * a tap size changes. The geometry proof is web/tests/fidelity/pocket-
 * measure.spec.js (500 boxes, about 11 minutes; meant to be nightly work,
 * today it still runs inside `fidelity`); this is the static half that runs
 * in `fast` on every merge request except one into a batch (#1720). It reads the pocket kit, every pocket
 * page's own CSS and markup, and every component those pages import
 * (pocket-tap-floor-lib.mjs says how) and fails, with file and line, when
 *   - a rule that reaches a tappable element declares a literal size under
 *     44px (use var(--p-hit)), or sets one through a custom property it
 *     cannot resolve, or
 *   - a tappable element has no rule giving it a height of 44px, or
 *   - --p-hit is not 44px, or is redeclared.
 * It catches the common cause. It does not replace the geometry: a control
 * sized by its content or padding, or by a rule it cannot read, is listed in
 * the lib (UNREADABLE) and left to the measurement.
 *
 * The second block proves the check on small synthetic sources, so it is
 * known to fail when it should, in the same way the real files are read.
 */

/* Svelte's parser reads the seven pocket pages in a few seconds on a cold start. */
vi.setConfig({ testTimeout: 30_000 });

const sources = readPocketSources();

describe("the pocket keeps the 44px tap floor (static read of the kit and the pocket pages)", () => {
  it("reads the kit, the tokens and every pocket page", () => {
    const files = pocketFiles();
    for (const wanted of [
      "lib/pocket/kit.css", TOKENS_FILE, "routes/home/pocket.css", "routes/home/pocket.svelte",
      "routes/administration/pocket.svelte", "routes/create/pocket.svelte", "routes/inbox/pocket.svelte",
      "routes/settings/pocket.svelte", "routes/settings/mail/pocket.svelte", "routes/household/[id]/pocket.svelte",
      "lib/pocket/Row.svelte", "lib/pocket/Sheet.svelte", "lib/pocket/TopChrome.svelte",
    ]) expect(files).toContain(wanted);
  });

  it("reads the components the pocket pages render, followed through their imports", () => {
    const files = pocketFiles();
    for (const wanted of [
      "routes/household/[id]/PocketArchive.svelte", "routes/household/[id]/PickSheet.svelte", /* a relative import */
      "lib/Mark.svelte", "lib/HouseholdClosed.svelte", /* a $lib/ import */
    ]) expect(files).toContain(wanted);
    /* The desk screens are not the pocket's: nothing imports them from a pocket page. */
    expect(files).not.toContain("routes/household/[id]/+page.svelte");
    expect(files).not.toContain("routes/household/[id]/DeskArchive.svelte");
  });

  it("--p-hit is 44px", () => {
    expect(tokensOf(sources).get("--p-hit")).toBe(`${FLOOR}px`);
  });

  it("no pocket control is sized under the floor, and every one has a rule that sizes it", () => {
    const problems = tapFloorProblems(sources);
    expect(problems, problems.join("\n")).toEqual([]);
  });

  /** What a mutated copy reports beyond what the real sources report. */
  const fresh = (/** @type {string[]} */ problems) => problems.filter((p) => !tapFloorProblems(sources).includes(p));

  it("catches a 30px literal on a control in a component a pocket page imports", () => {
    const path = "routes/household/[id]/PocketArchive.svelte";
    const mutated = sources.map((s) => (s.path === path ? { path, text: s.text.replace("<style>", "<style>\n  .act-accent{min-height:30px}") } : s));
    expect(mutated.find((s) => s.path === path)?.text).toContain("min-height:30px");
    expect(fresh(tapFloorProblems(mutated))).toEqual([expect.stringMatching(/^routes\/household\/\[id\]\/PocketArchive\.svelte:\d+: \.act-accent sets min-height:30px/u)]);
  });

  it("reports a size set through a local custom property it cannot resolve", () => {
    const path = "routes/settings/pocket.svelte";
    const mutated = sources.map((s) => (s.path === path
      ? { path, text: s.text.replace("<style>", "<style>\n  .st-watch{--ww:20px;width:var(--ww);min-height:var(--p-hit)}") } : s));
    expect(fresh(tapFloorProblems(mutated))).toEqual([expect.stringMatching(/^routes\/settings\/pocket\.svelte:\d+: \.st-watch sets width:var\(--ww\): size not resolvable/u)]);
  });

  it("every listed exception still names something real", () => {
    for (const u of [...UNREADABLE, ...SMALL_RULE_OVERRIDDEN]) expect(sources.map((s) => s.path), u.why).toContain(u.path);
  });
});

/* A tiny pocket: the token file, a kit, and one page. */
const TOKENS = { path: TOKENS_FILE, text: ":root{\n  --p-hit:44px;\n  --p-row-min:56px;\n}\n" };
const KIT = {
  path: "lib/pocket/kit.css",
  text: [
    ".p-pill{min-height:var(--p-hit);min-width:var(--p-hit)}",
    ".p-pill:hover{border-color:red}",
    ".p-tabs button{min-height:var(--p-hit)}",
    ".p-dot{width:10px;height:10px}",
    "",
  ].join("\n"),
};
/** @param {string} markup @param {string} [style] @param {string} [path] */
const page = (markup, style = "", path = "routes/demo/pocket.svelte") => ({
  path, text: `${markup}\n${style ? `<style>\n${style}\n</style>\n` : ""}`,
});
/** @param {...{path: string, text: string}} extra */
const run = (...extra) => tapFloorProblems([TOKENS, KIT, ...extra]);

describe("the static tap-floor check, on small sources", () => {
  it("passes a page whose controls take the kit's sizes", () => {
    expect(run(page('<button class="p-pill">Go</button><a class="p-pill" href="/x">Link</a><span class="p-dot"></span>'))).toEqual([]);
  });

  it("fails a literal size under the floor on a control's rule, naming file and line", () => {
    const problems = run(page('<button class="p-pill go">Go</button>', ".go{\n  min-height:40px;\n}"));
    // The markup is line 1, `<style>` line 2, `.go` line 3, the declaration line 4.
    expect(problems).toEqual([expect.stringMatching(/^routes\/demo\/pocket\.svelte:4: \.go sets min-height:40px \(40px\) on a tappable element/u)]);
  });

  it("reports the line of the declaration, not the rule", () => {
    const problems = run(page('<button class="go p-pill">Go</button>', ".go{\n  color:red;\n  width:30px;\n}"));
    expect(problems).toEqual([expect.stringMatching(/^routes\/demo\/pocket\.svelte:5: \.go sets width:30px/u)]);
  });

  it.each([
    ["height", "height:36px"],
    ["block-size", "block-size:2rem"],
    ["a width under the floor", "min-width:calc(var(--p-hit) / 2)"],
    ["a calc", "min-height:calc(20px + 10px)"],
    ["rem", "min-height:2.5rem"],
    ["max-height", "max-height:40px"],
  ])("fails %s", (_name, decl) => {
    expect(run(page('<button class="p-pill go">Go</button>', `.go{${decl}}`))).toEqual([expect.stringContaining("on a tappable element")]);
  });

  it.each([
    "min-height:var(--p-hit)", "min-height:48px", "min-height:var(--p-row-min)", "width:100%", "min-width:0",
    "min-height:max(var(--p-hit), 3rem)", "height:auto", "width:calc(100% - 8px)", "min-height:3rem",
  ])("accepts %s", (decl) => {
    expect(run(page('<button class="p-pill go">Go</button>', `.go{${decl}}`))).toEqual([]);
  });

  it("fails a size it cannot resolve (an unknown custom property), but not a percentage or auto", () => {
    const problems = run(page('<button class="p-pill go">Go</button>', ".go{--w:20px;width:var(--w)}"));
    expect(problems).toEqual([expect.stringMatching(/^routes\/demo\/pocket\.svelte:3: \.go sets width:var\(--w\): size not resolvable/u)]);
    expect(run(page('<button class="p-pill go">Go</button>', ".go{min-width:var(--w, 30px)}"))).toHaveLength(1);
    expect(run(page('<button class="p-pill go">Go</button>', ".go{width:var(--p-hit);height:auto;min-width:50%}"))).toEqual([]);
  });

  it("fails a small size inside a media query or a state rule too", () => {
    expect(run(page('<button class="p-pill go">Go</button>', "@media (max-width:400px){ .go{min-height:36px} }"))).toHaveLength(1);
    expect(run(page('<button class="p-pill go">Go</button>', ".go:active{min-height:36px}"))).toHaveLength(1);
  });

  it("reads a small size set through a descendant or :global selector", () => {
    expect(run(page('<div class="box"><button class="p-pill">Go</button></div>', ":global(.p-pill){min-height:30px}"))).toHaveLength(1);
    expect(run(page('<div class="box"><button class="p-pill">Go</button></div>', ".box :global(.p-pill){min-height:30px}"))).toHaveLength(1);
    expect(run(page('<div class="box"><button class="p-pill">Go</button></div>', ".box button{width:20px}"))).toHaveLength(1);
  });

  it("fails a tappable element that no rule sizes, naming file and line", () => {
    const problems = run(page('<p>hello</p>\n<button class="mystery">Go</button>'));
    expect(problems).toEqual([expect.stringMatching(/^routes\/demo\/pocket\.svelte:2: tappable <button> with class \.mystery has no rule/u)]);
  });

  it("counts every kind of tappable element", () => {
    const kinds = [
      '<button>x</button>', '<a href="/x">x</a>', '<input type="text">', "<select></select>", "<textarea></textarea>",
      "<summary>x</summary>", '<div role="button">x</div>', '<div role="tab">x</div>', '<div role="switch">x</div>',
      '<div role="link">x</div>', '<div tabindex="0">x</div>', '<a {...rest}>x</a>',
    ];
    for (const html of kinds) expect(run(page(html)), html).toHaveLength(1);
  });

  it("does not count what a phone cannot tap", () => {
    for (const html of ['<a name="top">x</a>', '<input type="hidden">', "<button hidden>x</button>", '<div tabindex="-1">x</div>', '<div role="group">x</div>'])
      expect(run(page(html)), html).toEqual([]);
  });

  it("reads classes set by a directive or an expression", () => {
    expect(run(page('<button class="p-pill" class:mystery={on}>x</button>'))).toEqual([]);
    expect(run(page('<button class={on ? "p-pill" : "other"}>x</button>'))).toEqual([]);
    expect(run(page('<button class="a {on ? "b" : "c"}">x</button>'))).toEqual([expect.stringContaining("with class .a .b .c")]);
  });

  it("sizes an element by its own scoped rule, a global one, or the tag", () => {
    expect(run(page('<button class="go">x</button>', ".go{min-height:var(--p-hit)}"))).toEqual([]);
    expect(run(page('<button class="go">x</button>', ":global(.go){min-height:var(--p-hit)}"))).toEqual([]);
    expect(run(page('<div><button>x</button></div>', "button{min-height:var(--p-hit)}"))).toEqual([]);
  });

  it("does not let another page's scoped rule, a hover rule, or a media rule size an element", () => {
    const other = page('<i></i>', ".go{min-height:var(--p-hit)}", "routes/other/pocket.svelte");
    expect(run(other, page('<button class="go">x</button>'))).toHaveLength(1);
    expect(run(page('<button class="go">x</button>', ".go:hover{min-height:var(--p-hit)}"))).toHaveLength(1);
    expect(run(page('<button class="go">x</button>', "@media (min-width:1px){ .go{min-height:var(--p-hit)} }"))).toHaveLength(1);
    expect(run(page('<button class="go">x</button>', ".go{min-height:0}"))).toHaveLength(1);
  });

  it("only lets a descendant rule size what is inside its ancestor", () => {
    expect(run(page('<div class="p-tabs"><button>x</button></div>'))).toEqual([]);
    expect(run(page('<div class="elsewhere"><button>x</button></div>'))).toHaveLength(1);
    expect(run(page('<div class="p-tabs"><div><button>x</button></div></div>'))).toEqual([]);
  });

  it("does not flag a small size on something nobody taps", () => {
    expect(run(page('<span class="mark">x</span>', ".mark{width:8px;height:8px}"))).toEqual([]);
    expect(run(page('<button class="p-pill">x</button>', ".p-pill::after{width:8px;height:8px}"))).toEqual([]);
  });

  it("fails a --p-hit that is not 44px, or is set anywhere else", () => {
    expect(tapFloorProblems([{ path: TOKENS_FILE, text: ":root{--p-hit:40px}" }, KIT])).toEqual([expect.stringContaining("--p-hit is 40px")]);
    expect(tapFloorProblems([KIT])).toEqual([expect.stringContaining("--p-hit is not declared")]);
    expect(run(page("<i></i>", ".go{--p-hit:40px}"))).toEqual([expect.stringContaining("redeclares --p-hit")]);
  });

  it("reads lengths", () => {
    const tokens = new Map([["--p-hit", "44px"]]);
    expect(pxOf("var(--p-hit)", tokens)).toBe(44);
    expect(pxOf("calc(var(--p-hit) / 2)", tokens)).toBe(22);
    expect(pxOf("calc(var(--p-hit) + 4px)", tokens)).toBe(48);
    expect(pxOf("var(--nope, 30px)", tokens)).toBe(30);
    expect(pxOf("var(--nope)", tokens)).toBe(null);
    expect(pxOf("max(30px, 3rem)", tokens)).toBe(48);
    expect(pxOf("2.75rem !important", tokens)).toBe(44);
    expect(pxOf("100%", tokens)).toBe(null);
    expect(pxOf("auto", tokens)).toBe(null);
  });
});
