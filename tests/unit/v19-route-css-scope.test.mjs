import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1051: a route stylesheet that writes a top-level, unscoped rule on a
 * generic class name reaches every other route's markup that happens to use
 * the same name, because SvelteKit does not unload a visited route's CSS
 * chunk on client-side navigation. #1050 was one instance of this (home.css's
 * bare .group); this file is the check the issue asked for, so the next
 * generic class name fails here instead of shipping unnoticed for weeks.
 *
 * The rule this file enforces, in the same words as every "clean" stylesheet
 * in this family (administration.css, inbox.css, settings.css, home/pocket.css)
 * already follows: every class selector in a route's own plain CSS file is
 * either written under that route's own wrapper class (`.mission-page .card`,
 * not bare `.card`), or is a name no other route's markup happens to use.
 * `html body`, `body.xxx`, `:root`, `*` and `[data-theme=...]` selectors are
 * exempt -- they cannot be scoped to a wrapper div (they style the document
 * or a body-level toggle), and every route stylesheet in this family already
 * declares some of them; #1047 owns the `[data-theme=...]` roster separately.
 */

const ROUTES_DIR = resolve(import.meta.dirname, "../../web/src/routes");

/** @param {string} dir @param {string[]} exts @returns {string[]} */
function walk(dir, exts) {
  const out = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!exts.includes(extname(entry.name))) continue;
    out.push(resolve(entry.parentPath ?? entry.path, entry.name));
  }
  return out;
}

const CLASS_ATTR_RE = /class(?:List)?="([^"]*)"/g;
const CLASS_DIRECTIVE_RE = /class:([a-zA-Z0-9_-]+)/g;

/**
 * Every class name each route's own .svelte markup uses, keyed by the
 * directory the markup file lives in (a route's own subdirectory, or the
 * routes root for the shared layout/error/splash files).
 *
 * @param {string[]} svelteFiles
 * @returns {Map<string, Set<string>>}
 */
function routeClassesOf(svelteFiles) {
  const map = new Map();
  for (const file of svelteFiles) {
    const text = readFileSync(file, "utf8");
    const rd = dirname(file);
    const set = map.get(rd) ?? new Set();
    map.set(rd, set);
    for (const m of text.matchAll(CLASS_ATTR_RE)) {
      for (const cls of m[1].split(/\s+/)) {
        const trimmed = cls.trim();
        if (trimmed && !trimmed.startsWith("{")) set.add(trimmed);
      }
    }
    for (const m of text.matchAll(CLASS_DIRECTIVE_RE)) set.add(m[1]);
  }
  return map;
}

/** @param {string} text */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Flat list of (selector, body) pairs, descending into @media/@supports so a
 * rule hiding inside a reduced-motion or max-width block is not missed —
 * everything else (@keyframes, @font-face, ...) is left alone, since their
 * "selectors" (`from`, `50%`, ...) are never class names.
 *
 * @param {string} text
 * @returns {[string, string][]}
 */
function extractRules(text) {
  const rules = [];
  let buf = "";
  let depth = 0;
  let selectorBuf = "";
  for (const c of text) {
    if (c === "{") {
      if (depth === 0) {
        selectorBuf = buf;
        buf = "";
      } else {
        buf += c;
      }
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        const sel = selectorBuf.trim();
        if (sel.startsWith("@media") || sel.startsWith("@supports")) rules.push(...extractRules(buf));
        else rules.push([selectorBuf, buf]);
        buf = "";
      } else if (depth < 0) {
        depth = 0;
        buf = "";
      } else {
        buf += c;
      }
    } else {
      buf += c;
    }
  }
  return rules;
}

const LEADING_CLASS_RE = /^\s*\.([a-zA-Z0-9_-]+)/;
const EXEMPT_PREFIX_RE = /^(html|body|:root|\*|\[data-theme)/;

/**
 * Splits a selector list on top-level commas only -- a plain `.split(",")`
 * would also split inside `:is(.a,.b)` / `:where(...)` / `:not(...)`, turning
 * one gated selector into several ungated-looking fragments (home.css's
 * `[data-theme=dawn] :is(.account,.docview,...)` read as a bare `.docview`
 * that way, a false positive this test tripped over while it was being
 * written).
 *
 * @param {string} selectorList
 * @returns {string[]}
 */
function splitSelectorList(selectorList) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const c of selectorList) {
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    if (c === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * @param {{path: string, css: string}[]} cssFiles
 * @param {Map<string, Set<string>>} routeClasses
 * @returns {{file: string, class: string, selector: string, collidesWith: string[]}[]}
 */
function findUnscopedCollisions(cssFiles, routeClasses) {
  const violations = [];
  for (const { path, css } of cssFiles) {
    const rd = dirname(path);
    const rules = extractRules(stripComments(css));

    /** @type {[string, string][]} */
    const flagged = [];
    for (const [selector] of rules) {
      const sel = selector.trim();
      if (!sel || sel.startsWith("@")) continue;
      for (const partRaw of splitSelectorList(sel)) {
        const part = partRaw.trim();
        if (!part || EXEMPT_PREFIX_RE.test(part)) continue;
        const m = LEADING_CLASS_RE.exec(part);
        if (m) flagged.push([m[1], part]);
      }
    }

    /* This file's own wrapper class, if it has one: whichever class is used
       most often as an ancestor prefix (".mission-page .card", not bare
       ".card"). A file with no such class (every selector bare) has no
       wrapper to exempt, which is itself the finding for create.css/item.css
       before this fix -- every bare rule in a wrapper-less file is flagged. */
    const prefixCounts = new Map();
    for (const [cls] of flagged) prefixCounts.set(cls, (prefixCounts.get(cls) ?? 0) + 1);
    let wrapper = null;
    let wrapperCount = 0;
    let total = 0;
    for (const [cls, count] of prefixCounts) {
      total += count;
      if (count > wrapperCount) {
        wrapper = cls;
        wrapperCount = count;
      }
    }
    const isWrapperFile = wrapper !== null && wrapperCount >= Math.max(3, total * 0.3);

    const seen = new Set();
    for (const [cls, part] of flagged) {
      if (isWrapperFile && cls === wrapper) continue;
      if (seen.has(cls)) continue;
      const collidesWith = [...routeClasses.entries()]
        .filter(([otherRoute, classes]) => otherRoute !== rd && classes.has(cls))
        .map(([otherRoute]) => otherRoute);
      if (collidesWith.length) {
        seen.add(cls);
        violations.push({ file: path, class: cls, selector: part, collidesWith });
      }
    }
  }
  return violations;
}

describe("route stylesheets stay scoped to their own route (#1051)", () => {
  it("declares no top-level rule on a class another route's markup uses", () => {
    const cssFiles = walk(ROUTES_DIR, [".css"]).map((path) => ({ path, css: readFileSync(path, "utf8") }));
    const svelteFiles = walk(ROUTES_DIR, [".svelte"]);
    const routeClasses = routeClassesOf(svelteFiles);

    const violations = findUnscopedCollisions(cssFiles, routeClasses)
      /* logout.css is retired, dead code -- its own header says so ("stay
         in the tree ... and are imported by nothing") and no +page.svelte
         imports it, so it never ships in any CSS chunk and cannot reach
         another route's markup however its own selectors are written. */
      .filter((violation) => !violation.file.endsWith("/logout/logout.css"));

    expect(violations, `unscoped route-stylesheet rules that collide with another route's markup:\n${JSON.stringify(violations, null, 2)}`).toEqual([]);
  });

  /* Proves the assertion above is not vacuously true -- a checker that never
     fails is not a check. */
  it("flags a planted violation", () => {
    const routeClasses = new Map([
      ["/routes/alpha", new Set(["shared-name"])],
      ["/routes/beta", new Set(["shared-name", "unique-to-beta"])],
    ]);
    const cssFiles = [
      {
        path: "/routes/beta/beta.css",
        css: `
          .beta-page{min-height:100vh}
          .beta-page .unique-to-beta{color:blue}
          /* bare, top-level, and "shared-name" is also alpha's own markup class */
          .shared-name{border:1px dashed red}
          @media (max-width:600px){ .shared-name{border-width:2px} }
        `,
      },
    ];

    const violations = findUnscopedCollisions(cssFiles, routeClasses);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      file: "/routes/beta/beta.css",
      class: "shared-name",
      collidesWith: ["/routes/alpha"],
    });
  });
});
