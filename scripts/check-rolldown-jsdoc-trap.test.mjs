import { describe, expect, it } from "vitest";

import { findTraps } from "./check-rolldown-jsdoc-trap.mjs";

describe("rolldown JSDoc trap check", () => {
  it("flags a JSDoc comment inside a multi-line, comma-separated arrow-parameter list", () => {
    const source = [
      "<script>",
      "  const decide = (",
      "    /** @type {string} */ request,",
      "    /** @type {\"approve\" | \"decline\"} */ action,",
      "  ) => request + action;",
      "</script>",
    ].join("\n");
    expect(findTraps(source)).toEqual([
      { line: 3, reason: "JSDoc comment inside a multi-line, comma-separated parameter/argument list" },
    ]);
  });

  it("flags the same shape inside a {@const ...} call's argument list", () => {
    const source = [
      "{#each items as item}",
      "  {@const doubled = decide(",
      "    /** @type {number} */ item[0],",
      "    /** @type {number} */ item[1],",
      "  )}",
      "{/each}",
    ].join("\n");
    // One finding per bracketed group -- a second comment in the same list
    // does not add a second finding for it.
    expect(findTraps(source)).toEqual([
      { line: 3, reason: "JSDoc comment inside a multi-line, comma-separated parameter/argument list" },
    ]);
  });

  it("flags any JSDoc comment inside a {#snippet} parameter list, single line or not", () => {
    const oneLine = '{#snippet mark({ /** @type {string | null} */ icon, accent })}{/snippet}';
    expect(findTraps(oneLine)).toEqual([
      { line: 1, reason: "JSDoc comment inside a {#snippet} parameter list" },
    ]);

    const multiLine = ["{#snippet mark(", "  /** @type {string | null} */ icon,", ")}"].join("\n");
    expect(findTraps(multiLine)).toEqual([
      { line: 2, reason: "JSDoc comment inside a {#snippet} parameter list" },
    ]);
  });

  it("does not flag the control case with the comments removed", () => {
    const source = ["<script>", "  const decide = (", "    request,", "    action,", "  ) => request + action;", "</script>"].join(
      "\n",
    );
    expect(findTraps(source)).toEqual([]);
  });

  it("does not flag the /** @type {X} */ (expr) cast idiom, single- or multi-argument", () => {
    const singleArg = 'const el = /** @type {HTMLDivElement} */ (document.getElementById("x"));';
    expect(findTraps(singleArg)).toEqual([]);

    const multiArgCall = [
      "mountStation(",
      "  /** @type {HTMLDivElement} */ (backdropRoot), {",
      "  seed, galaxy,",
      "});",
    ].join("\n");
    expect(findTraps(multiArgCall)).toEqual([]);
  });

  it("does not flag a single-line, single-parameter arrow with a JSDoc comment", () => {
    const source = 'const initials = parts.map((/** @type {string} */ part) => part[0] ?? "");';
    expect(findTraps(source)).toEqual([]);
  });

  it("does not flag a plain @typedef import comment outside any parameter list", () => {
    const source = "<script>\n  /** @typedef {import('./x.js').Foo} Foo */\n</script>\n";
    expect(findTraps(source)).toEqual([]);
  });

  it("ignores prose that merely mentions the trap inside an HTML comment", () => {
    const source = [
      "<!-- No JSDoc /** @type */ comment can sit in this snippet's own parameter",
      "     list, see (",
      "       one,",
      "       two,",
      "     ) for the shape that fails. -->",
      "<p>fine</p>",
    ].join("\n");
    expect(findTraps(source)).toEqual([]);
  });

  it("ignores lookalike text inside strings and template literals", () => {
    const source = [
      'const s = "(",',
      "  t = `/** @type {X} */ (",
      "    a,",
      "    b,",
      "  )`;",
    ].join("\n");
    expect(findTraps(source)).toEqual([]);
  });
});
