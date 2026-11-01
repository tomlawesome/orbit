/*
 * The static half of the 44px tap floor (#1616, ADR-0039 §6): reads the
 * pocket's own CSS and markup and says which rule or element can put a
 * tappable thing under the floor. The geometry check
 * (web/tests/fidelity/pocket-measure.spec.js) stays the proof; this finds
 * the common cause the moment the code that sets a size changes, in `fast`.
 *
 * Scope: the kit, the pocket pages (routes/** /pocket.svelte, pocket.css), and
 * every .svelte file those pages import, followed transitively within web/src
 * (relative and `$lib/` imports). Most pocket controls live in those
 * components (PocketArchive, PickSheet, EntryForm, ItemDrawer ...), not in the
 * page shells. A component the desk screens also render is read too: its size
 * rules reach the phone as well.
 *
 * Svelte's own parser reads both halves (the CSS files are wrapped in a
 * <style> block to reach it), so there is no CSS dependency beyond what the
 * web build already has.
 *
 * Three findings, each with file and line:
 *   - SMALL RULE: a rule that applies to a tappable element declares a
 *     literal width, height or block/inline size under 44px (a literal at or
 *     above the floor is fine; `var(--p-hit)` is the way to say it).
 *   - SIZE NOT RESOLVABLE: such a rule sets a size through a custom property
 *     the check cannot read (anything but the tokens.css ones), so it cannot
 *     tell whether the control is under the floor. Write the size inline or
 *     use a token. A percentage, `auto` or a viewport unit is not this: it
 *     has no px of its own and is left to the geometry run.
 *   - UNSIZED ELEMENT: a tappable element in pocket markup that no
 *     base (not hover, not media) rule gives a height of at least 44px.
 * Plus the token itself: `--p-hit` is 44px and is declared nowhere else.
 *
 * Selector matching takes the element's tag, classes, attributes and its
 * ancestors in the same file. It does not know sibling order, :has() or
 * what a component renders into a slot from another file; where it cannot
 * tell it assumes the rule matches, so an unknown makes a small rule more
 * likely to be flagged and an element more likely to count as sized.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, posix, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
export const WEB_SRC = join(ROOT, "web/src");
const { parse } = createRequire(join(ROOT, "web/package.json"))("svelte/compiler");

export const FLOOR = 44;
export const TOKENS_FILE = "lib/pocket/tokens.css";

/** The size properties a rule can use to shrink a control. */
const SIZE_PROPS = new Set([
  "width", "min-width", "max-width", "inline-size", "min-inline-size", "max-inline-size",
  "height", "min-height", "max-height", "block-size", "min-block-size", "max-block-size",
]);
/** The ones that can give a control its height (the block axis). */
const HEIGHT_PROPS = new Set(["height", "min-height", "block-size", "min-block-size"]);

/**
 * Tappable elements the UNSIZED ELEMENT finding cannot read, each with the
 * reason its size is not a height rule and the exact number of elements it
 * covers (a new one, or one fewer, fails until this list is read again). The
 * geometry check is what proves each of these at 44px.
 * @type {{path: string, tag: string, cls?: string, count: number, why: string}[]}
 */
export const UNREADABLE = [
  { path: "lib/pocket/StagedPage.svelte", tag: "button", cls: "bp-page", count: 1,
    why: "the page preview is the button: its height is the picture's plus 28px of padding, never a fixed height" },
  { path: "routes/administration/pocket.svelte", tag: "a", count: 1,
    why: "an inline link in a note: `.ad-note a` pads it 14px above and below its line to reach the floor" },
  { path: "routes/home/pocket.svelte", tag: "g", cls: "pk-body", count: 2,
    why: "a body on the dial is an SVG group: its tap is an invisible circle of HIT_R (pocket-dial.js), not a CSS box" },
  { path: "routes/home/pocket.svelte", tag: "div", cls: "skies", count: 1,
    why: "a focusable scroller, not a control: the chips inside it (`.msys`) carry the floor" },
  { path: "routes/home/pocket.svelte", tag: "b", cls: "ed", count: 3,
    why: "the live title: `.pocket .p-row .ed` (home/pocket.css) gives it 44px, but its `.p-row` ancestor is drawn by Row.svelte" },
  { path: "lib/reading/PreviewCard.svelte", tag: "button", cls: "sheet", count: 1,
    why: "the page preview is the button, as in StagedPage: its height is the picture's plus 18px of padding, never a fixed height" },
  { path: "routes/home/EditRows.svelte", tag: "button", cls: "pick", count: 5,
    why: "a chosen value: `.pocket .pick` pads its box 13px above and below its 18px line to reach 44px (a padding sum, no height rule)" },
  { path: "routes/home/EditRows.svelte", tag: "b", cls: "ed", count: 5,
    why: "a live value: `.pocket .ed:not(.notes)` pads 13px above and below its 18px line, same as `.pick`; the title's `.ed` in home/pocket.css is the 3 above" },
];

/**
 * Small rules that reach a tappable element on paper and not on the phone,
 * each with the reason and a match by file, selector and property. The
 * geometry check is what proves the phone size.
 * @type {{path: string, selector: string, property: string, why: string}[]}
 */
export const SMALL_RULE_OVERRIDDEN = [
  { path: "routes/home/EditRows.svelte", selector: ".notes.ed", property: "min-height",
    why: "the desk's size (EditRows without `pocket`, ItemView and SuggestionView): the pocket drawers pass `pocket`, and `.pocket .notes.ed` in the same file sets min-height:44px" },
];

/** Tappable, as pocket-measure.spec.js counts it (`TAPPABLE` there). */
const TAPPABLE_TAGS = new Set(["button", "input", "select", "textarea", "summary"]);
const TAPPABLE_ROLES = new Set(["button", "link", "tab", "switch"]);
const STATE_PSEUDOS = new Set([
  "hover", "active", "focus", "focus-visible", "focus-within", "disabled", "enabled",
  "checked", "visited", "target", "link", "read-only", "invalid", "valid", "indeterminate",
]);

/**
 * The .svelte files a source imports (static `import ... from`, bare `import`,
 * dynamic `import()`), as paths under web/src: relative and `$lib/` specifiers
 * only; a package or `$app/` import is not ours.
 * @param {string} path the importing file, under web/src
 * @param {string} text
 * @returns {string[]}
 */
export function importsOf(path, text) {
  const out = new Set();
  for (const m of text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"'\n]+\.svelte)["']/gu)) {
    const spec = m[1];
    if (spec.startsWith("$lib/")) out.add(`lib/${spec.slice("$lib/".length)}`);
    else if (spec.startsWith("./") || spec.startsWith("../")) out.add(posix.normalize(posix.join(posix.dirname(path), spec)));
  }
  return [...out];
}

/**
 * The files the check reads, as paths under web/src: the kit and the pocket
 * pages' own CSS and markup (lib/pocket/, routes/** /pocket.svelte and
 * pocket.css), then every .svelte file they import, transitively.
 * @returns {string[]}
 */
export function pocketFiles() {
  const roots = readdirSync(WEB_SRC, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(WEB_SRC, join(entry.parentPath, entry.name)))
    .filter((path) => (path.startsWith("lib/pocket/") && /\.(css|svelte)$/u.test(path))
      || /^routes\/(?:.+\/)?pocket\.(css|svelte)$/u.test(path));
  const found = new Set(roots);
  const queue = roots.filter((path) => path.endsWith(".svelte"));
  for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
    for (const next of importsOf(path, readFileSync(join(WEB_SRC, path), "utf8"))) {
      if (found.has(next) || !existsSync(join(WEB_SRC, next))) continue;
      found.add(next);
      queue.push(next);
    }
  }
  return [...found].sort();
}

/** @param {string[]} [paths] @returns {{path: string, text: string}[]} */
export function readPocketSources(paths = pocketFiles()) {
  return paths.map((path) => ({ path, text: readFileSync(join(WEB_SRC, path), "utf8") }));
}

/* ---------------------------------------------------------------- parsing */

/**
 * A function from a character offset to its 1-based line.
 * @param {string} text @returns {(offset: number) => number}
 */
function lineFinder(text) {
  const starts = [0];
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid; else high = mid - 1;
    }
    return low + 1;
  };
}

/**
 * Both kinds of file as {css nodes, markup, offset of the CSS text}.
 * @param {{path: string, text: string}} source
 */
function parseSource({ path, text }) {
  if (path.endsWith(".css")) {
    const wrapped = `<style>${text}</style>`;
    return { path, text, css: parse(wrapped, { modern: true }).css, fragment: null, cssOffset: "<style>".length };
  }
  const ast = parse(text, { modern: true });
  return { path, text, css: ast.css, fragment: ast.fragment, cssOffset: 0 };
}

/**
 * Every rule in a stylesheet as one entry per selector in its list.
 * @typedef {{path: string, line: number, selector: string, chain: Chain, global: boolean, top: boolean,
 *   stateful: boolean, pseudoElement: boolean, decls: {property: string, value: string, line: number}[]}} Rule
 * @param {ReturnType<typeof parseSource>} file
 * @returns {Rule[]}
 */
function rulesOf(file) {
  /** @type {Rule[]} */
  const out = [];
  const text = file.css ? file.text : "";
  const sliceOf = (/** @type {any} */ node) => text.slice(node.start - file.cssOffset, node.end - file.cssOffset);
  const find = lineFinder(text);
  const lineAt = (/** @type {number} */ offset) => find(offset - file.cssOffset);

  const visit = (/** @type {any[]} */ children, /** @type {boolean} */ top) => {
    for (const node of children) {
      if (node.type === "Atrule") {
        if (/keyframes$/u.test(node.name)) continue;
        if (node.block) visit(node.block.children, false);
        continue;
      }
      if (node.type !== "Rule") continue;
      if (node.block.children.some((/** @type {any} */ child) => child.type === "Rule"))
        throw new Error(`${file.path}:${lineAt(node.start)}: nested CSS rules are not read by the tap-floor check`);
      const decls = node.block.children
        .filter((/** @type {any} */ child) => child.type === "Declaration")
        .map((/** @type {any} */ d) => ({ property: d.property, value: d.value, line: lineAt(d.start) }));
      for (const complex of node.prelude.children) {
        const { chain, global, stateful, pseudoElement } = chainOf(complex);
        out.push({
          path: file.path, line: lineAt(complex.start), selector: sliceOf(complex).trim().replace(/\s+/gu, " "),
          chain, global: global || !file.path.endsWith(".svelte"), top, stateful, pseudoElement, decls,
        });
      }
    }
  };
  if (file.css) visit(file.css.children, true);
  return out;
}

/**
 * A complex selector as a chain of compounds, `:global(...)` unwrapped.
 * @typedef {{combinator: string | null, simple: any[]}[]} Chain
 * @param {any} complex
 */
function chainOf(complex) {
  const cached = chains.get(complex);
  if (cached) return cached;
  const made = buildChain(complex);
  chains.set(complex, made);
  return made;
}
/** @type {WeakMap<object, ReturnType<typeof buildChain>>} */
const chains = new WeakMap();
/** @param {any} complex */
function buildChain(complex) {
  /** @type {Chain} */
  const chain = [];
  let global = false;
  let pseudoElement = false;
  for (const relative of complex.children) {
    const globals = relative.selectors.filter((/** @type {any} */ s) => s.type === "PseudoClassSelector" && s.name === "global" && s.args);
    const rest = relative.selectors.filter((/** @type {any} */ s) => !globals.includes(s));
    const combinator = relative.combinator?.name ?? null;
    if (globals.length === 0) {
      chain.push({ combinator, simple: rest });
    } else {
      const inner = chainOf(globals[0].args.children[0]);
      pseudoElement ||= inner.pseudoElement;
      inner.chain.forEach((link, index) => {
        const last = index === inner.chain.length - 1;
        chain.push({ combinator: index === 0 ? combinator : link.combinator, simple: last ? [...link.simple, ...rest] : link.simple });
      });
    }
    if (globals.length && relative === complex.children.at(-1)) global = true;
    if (rest.some((/** @type {any} */ s) => s.type === "PseudoElementSelector")) pseudoElement = true;
  }
  const subject = chain.at(-1)?.simple ?? [];
  const stateful = subject.some((/** @type {any} */ s) => s.type === "PseudoClassSelector" && STATE_PSEUDOS.has(s.name));
  return { chain, global, stateful, pseudoElement };
}

/**
 * The tappable elements of a component's markup, each with its ancestors.
 * @typedef {{tag: string | null, classes: Set<string>, classText: string, attrs: Map<string, string | true | null>}} El
 * @typedef {El & {path: string, line: number, ancestors: El[], text: string}} Tappable
 * @param {ReturnType<typeof parseSource>} file
 * @returns {Tappable[]}
 */
function tappablesOf(file) {
  /** @type {Tappable[]} */
  const out = [];
  if (!file.fragment) return out;
  const { text } = file;
  const lineOf = lineFinder(text);

  /** A string literal's content inside an expression, for `class={a ? "x" : "y"}`. */
  const literalsIn = (/** @type {string} */ code) =>
    [...code.matchAll(/"([^"]*)"|'([^']*)'|`([^`$]*)`/gu)].flatMap((m) => (m[1] ?? m[2] ?? m[3]).split(/\s+/u)).filter(Boolean);

  const elementOf = (/** @type {any} */ node) => {
    /** @type {Map<string, string | true | null>} */
    const attrs = new Map();
    const classes = new Set();
    let spread = false;
    for (const a of node.attributes) {
      if (a.type === "SpreadAttribute") { spread = true; continue; }
      if (a.type === "ClassDirective") { classes.add(a.name); continue; }
      if (a.type !== "Attribute") continue;
      /** @type {string | true | null} */
      let value;
      if (a.value === true) value = true;
      else {
        const parts = Array.isArray(a.value) ? a.value : [a.value];
        const dynamic = parts.some((/** @type {any} */ p) => p.type !== "Text");
        value = dynamic ? null : parts.map((/** @type {any} */ p) => p.data).join("");
        if (a.name === "class") {
          for (const p of parts) {
            if (p.type === "Text") p.data.split(/\s+/u).filter(Boolean).forEach((/** @type {string} */ c) => classes.add(c));
            else literalsIn(text.slice(p.expression.start, p.expression.end)).forEach((c) => classes.add(c));
          }
        }
      }
      attrs.set(a.name, value);
    }
    const tag = node.type === "RegularElement" ? node.name : null;
    return { el: { tag, classes, classText: [...classes].join(" "), attrs }, spread };
  };

  const tappable = (/** @type {El} */ el, /** @type {boolean} */ spread, /** @type {any} */ node) => {
    if (el.attrs.get("hidden") === true || el.attrs.get("hidden") === "") return false;
    if (el.attrs.get("tabindex") === "-1") return false;
    if (el.tag === "input" && el.attrs.get("type") === "hidden") return false;
    if (el.tag && TAPPABLE_TAGS.has(el.tag)) return true;
    if (el.tag === "a") return el.attrs.has("href") || spread;
    if (node.type === "SvelteElement") return el.attrs.has("href") || el.attrs.has("type");
    const role = el.attrs.get("role");
    if (typeof role === "string" && TAPPABLE_ROLES.has(role)) return true;
    return el.attrs.has("tabindex");
  };

  const walk = (/** @type {any} */ node, /** @type {El[]} */ ancestors) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach((child) => walk(child, ancestors)); return; }
    let next = ancestors;
    if (node.type === "RegularElement" || node.type === "SvelteElement" || node.type === "Component") {
      const { el, spread } = elementOf(node);
      if (node.type !== "Component" && tappable(el, spread, node))
        out.push({ ...el, path: file.path, line: lineOf(node.start), ancestors, text: text.slice(node.start, node.start + 80).split("\n")[0] });
      next = [...ancestors, node.type === "Component" ? { tag: null, classes: new Set(), classText: "", attrs: new Map() } : el];
    }
    for (const key of ["fragment", "children", "nodes", "consequent", "alternate", "body", "pending", "then", "catch", "fallback"]) {
      if (node[key]) walk(node[key], next);
    }
  };
  walk(file.fragment, []);
  return out;
}

/* --------------------------------------------------------------- matching */

/** @param {any} simple @param {El | null} el @param {El[]} ancestors */
function simpleMatches(simple, el, ancestors) {
  if (!el) return false;
  switch (simple.type) {
    case "TypeSelector":
      return simple.name === "*" || simple.name === el.tag || (el.tag === null && (simple.name === "a" || simple.name === "button"));
    case "ClassSelector":
      return el.classes.has(simple.name);
    case "IdSelector": {
      const id = el.attrs.get("id");
      return id === null || id === simple.value || id === simple.name;
    }
    case "AttributeSelector": {
      if (!el.attrs.has(simple.name)) return simple.name === "class" ? el.classes.size > 0 && classAttrMatches(simple, el.classText) : false;
      const value = simple.name === "class" ? el.classText : el.attrs.get(simple.name);
      if (!simple.matcher) return true;
      if (typeof value !== "string") return true;
      return attrMatches(simple, value);
    }
    case "PseudoClassSelector":
      if (simple.name === "not") return !simple.args?.children.some((/** @type {any} */ c) => chainMatches(chainOf(c).chain, el, ancestors));
      if (simple.name === "is" || simple.name === "where" || simple.name === "matches")
        return Boolean(simple.args?.children.some((/** @type {any} */ c) => chainMatches(chainOf(c).chain, el, ancestors)));
      return true;
    default:
      return true;
  }
}

/** @param {any} simple @param {string} value */
function attrMatches(simple, value) {
  const want = simple.value ?? "";
  switch (simple.matcher) {
    case "=": return value === want;
    case "*=": return value.includes(want);
    case "^=": return value.startsWith(want);
    case "$=": return value.endsWith(want);
    case "~=": return value.split(/\s+/u).includes(want);
    case "|=": return value === want || value.startsWith(`${want}-`);
    default: return true;
  }
}
/** @param {any} simple @param {string} classText */
const classAttrMatches = (simple, classText) => !simple.matcher || attrMatches(simple, classText);

/** @param {Chain} chain @param {El} el @param {El[]} ancestors */
export function chainMatches(chain, el, ancestors) {
  const last = chain.length - 1;
  if (last < 0) return false;
  if (!chain[last].simple.every((s) => simpleMatches(s, el, ancestors))) return false;
  /** The compounds before `index` against `from` upward. */
  const up = (/** @type {number} */ index, /** @type {El[]} */ above) => {
    if (index < 0) return true;
    const { combinator } = chain[index + 1];
    const test = (/** @type {number} */ at) => {
      const candidate = above[at];
      return chain[index].simple.every((s) => simpleMatches(s, candidate, above.slice(0, at))) && up(index - 1, above.slice(0, at));
    };
    if (combinator === ">") return above.length > 0 && test(above.length - 1);
    if (combinator === "+" || combinator === "~") return up(index - 1, above);
    for (let at = above.length - 1; at >= 0; at -= 1) if (test(at)) return true;
    return false;
  };
  return up(last - 1, ancestors);
}

/* ----------------------------------------------------------------- values */

/**
 * The custom properties tokens.css declares on :root, raw.
 * @param {{path: string, text: string}[]} sources
 * @returns {Map<string, string>}
 */
export function tokensOf(sources) {
  const tokens = new Map();
  const file = sources.find((s) => s.path === TOKENS_FILE);
  if (!file) return tokens;
  for (const rule of rulesOf(parseSource(file))) {
    if (!rule.top || rule.selector !== ":root") continue;
    for (const d of rule.decls) if (d.property.startsWith("--")) tokens.set(d.property, d.value.trim());
  }
  return tokens;
}

/**
 * A CSS length in px, or null where it is not a plain length (a percentage,
 * `auto`, a viewport unit, an unknown variable).
 * @param {string} value @param {Map<string, string>} tokens @param {number} [depth]
 * @returns {number | null}
 */
export function pxOf(value, tokens, depth = 0) {
  if (depth > 8) return null;
  const src = value.replace(/!important/u, "").trim();
  let pos = 0;
  const peek = () => src[pos];
  const space = () => { while (src[pos] === " ") pos += 1; };

  const fn = (/** @type {string} */ name) => {
    /** @type {(number | null)[]} */
    const args = [];
    let argStart = pos;
    let nest = 0;
    const raw = [];
    for (; pos < src.length; pos += 1) {
      if (src[pos] === "(") nest += 1;
      if (src[pos] === ")") { if (nest === 0) break; nest -= 1; }
      if (src[pos] === "," && nest === 0) { raw.push(src.slice(argStart, pos)); argStart = pos + 1; }
    }
    raw.push(src.slice(argStart, pos));
    pos += 1;
    if (name === "var") {
      const resolved = tokens.get(raw[0].trim());
      if (resolved !== undefined) return pxOf(resolved, tokens, depth + 1);
      return raw.length > 1 ? pxOf(raw.slice(1).join(","), tokens, depth + 1) : null;
    }
    for (const a of raw) args.push(pxOf(a, tokens, depth + 1));
    if (name === "calc" || name === "") return args[0];
    if (args.some((a) => a === null)) return null;
    const nums = /** @type {number[]} */ (args);
    if (name === "min") return Math.min(...nums);
    if (name === "max") return Math.max(...nums);
    if (name === "clamp") return Math.min(Math.max(nums[0], nums[1]), nums[2]);
    return null;
  };

  const atom = () => {
    space();
    if (peek() === "(") { pos += 1; return fn(""); }
    const named = /^[a-z-]+(?=\()/u.exec(src.slice(pos));
    if (named) { pos += named[0].length + 1; return fn(named[0]); }
    const num = /^(-?\d*\.?\d+)([a-z%]*)/u.exec(src.slice(pos));
    if (!num) { pos = src.length; return null; }
    pos += num[0].length;
    const n = Number(num[1]);
    if (num[2] === "px" || num[2] === "") return n; /* a bare number is a scale (`/ 2`) or 0 */
    if (num[2] === "rem" || num[2] === "em") return n * 16;
    return null; /* %, vw, vh, dvh and the rest: not a plain length */
  };
  const term = () => {
    let left = atom();
    for (;;) {
      space();
      const op = peek();
      if (op !== "*" && op !== "/") return left;
      pos += 1;
      const right = atom();
      /* A bare number is a scale: a unitless operand has no px of its own. */
      left = left === null || right === null ? null : op === "*" ? left * right : left / right;
    }
  };
  const sum = () => {
    let left = term();
    for (;;) {
      space();
      const op = peek();
      if (op !== "+" && op !== "-") return left;
      pos += 1;
      const right = term();
      left = left === null || right === null ? null : op === "+" ? left + right : left - right;
    }
  };
  const result = sum();
  space();
  return pos >= src.length ? result : null;
}

/**
 * Whether a value reads a custom property that `tokens` does not hold.
 * @param {string} value @param {Map<string, string>} tokens
 */
function unknownVar(value, tokens) {
  return [...value.matchAll(/var\(\s*(--[\w-]+)/gu)].some((m) => !tokens.has(m[1]));
}

/* ------------------------------------------------------------------ check */

/**
 * Every finding in `sources`, as `path:line: words`. Empty means the pocket's
 * CSS and markup keep the floor as far as a static read can tell.
 * @param {{path: string, text: string}[]} sources
 * @returns {string[]}
 */
export function tapFloorProblems(sources) {
  const files = sources.map(parseSource);
  const tokens = tokensOf(sources);
  const rules = files.flatMap(rulesOf);
  const tappables = files.flatMap(tappablesOf);
  /** @type {string[]} */
  const problems = [];

  /* The token. */
  const hit = tokens.get("--p-hit");
  if (hit === undefined) problems.push(`${TOKENS_FILE}: --p-hit is not declared on :root`);
  else if (hit !== `${FLOOR}px`) problems.push(`${TOKENS_FILE}: --p-hit is ${hit}, the tap floor is ${FLOOR}px`);
  for (const rule of rules) {
    for (const d of rule.decls) {
      if (d.property === "--p-hit" && !(rule.path === TOKENS_FILE && rule.top && rule.selector === ":root"))
        problems.push(`${rule.path}:${d.line}: ${rule.selector} redeclares --p-hit as ${d.value.trim()}; the token is set once, in ${TOKENS_FILE}`);
    }
  }

  /**
   * The rules that apply to an element: its own file's, and the global ones.
   * `strict` reads the ancestors too; without it only the element itself is
   * matched, so a rule is never skipped because its ancestor is drawn by
   * another component.
   */
  /** @type {Map<Tappable, Rule[]>[]} */
  const memo = [new Map(), new Map()];
  const rulesFor = (/** @type {Tappable} */ el, /** @type {boolean} */ strict) => {
    const cache = memo[strict ? 1 : 0];
    if (!cache.has(el)) cache.set(el, matching(el, strict));
    return /** @type {Rule[]} */ (cache.get(el));
  };
  const matching = (/** @type {Tappable} */ el, /** @type {boolean} */ strict) =>
    rules.filter((rule) => !rule.pseudoElement && (rule.global || rule.path === el.path)
      && (strict ? chainMatches(rule.chain, el, el.ancestors) : chainMatches(rule.chain.slice(-1).map((link) => ({ ...link, combinator: null })), el, [])));

  /* SMALL RULE: a literal size under the floor on a rule that reaches a tappable element. */
  const seen = new Set();
  /** @type {Set<(typeof SMALL_RULE_OVERRIDDEN)[number]>} */
  const overrides = new Set();
  /** @type {Map<Rule, Tappable[]>} */
  const reached = new Map();
  for (const el of tappables) {
    for (const rule of rulesFor(el, false)) reached.set(rule, [...(reached.get(rule) ?? []), el]);
  }
  for (const [rule, els] of reached) {
    for (const d of rule.decls) {
      if (!SIZE_PROPS.has(d.property)) continue;
      const px = pxOf(d.value, tokens);
      const key = `${rule.path}:${d.line}`;
      if (px === null && unknownVar(d.value, tokens)) {
        if (seen.has(key)) continue;
        seen.add(key);
        problems.push(`${rule.path}:${d.line}: ${rule.selector} sets ${d.property}:${d.value.trim()}: size not resolvable, it goes through a custom property`
          + ` the check cannot read (${els[0].path}:${els[0].line} ${els[0].text.trim()}); use a literal at or above ${FLOOR}px or var(--p-hit)`);
        continue;
      }
      if (px === null || px <= 0 || px >= FLOOR) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      const overridden = SMALL_RULE_OVERRIDDEN.find((o) => o.path === rule.path && o.selector === rule.selector && o.property === d.property);
      if (overridden) { overrides.add(overridden); continue; }
      problems.push(`${rule.path}:${d.line}: ${rule.selector} sets ${d.property}:${d.value.trim()} (${px}px) on a tappable element`
        + ` (${els[0].path}:${els[0].line} ${els[0].text.trim()}); the floor is ${FLOOR}px, use var(--p-hit)`);
    }
  }

  for (const o of SMALL_RULE_OVERRIDDEN) {
    if (sources.some((src) => src.path === o.path) && !overrides.has(o))
      problems.push(`${o.path}: the exception for ${o.selector} ${o.property} no longer matches a small rule (SMALL_RULE_OVERRIDDEN in pocket-tap-floor-lib.mjs)`);
  }

  /* UNSIZED ELEMENT: nothing gives it a height of at least the floor. */
  /** @type {Map<(typeof UNREADABLE)[number], number>} */
  const used = new Map();
  for (const el of tappables) {
    const sized = rulesFor(el, true).some((rule) => rule.top && !rule.stateful
      && rule.decls.some((d) => HEIGHT_PROPS.has(d.property) && (pxOf(d.value, tokens) ?? 0) >= FLOOR));
    if (sized) continue;
    const exempt = UNREADABLE.find((u) => u.path === el.path && u.tag === el.tag && (!u.cls || el.classes.has(u.cls)));
    if (exempt) { used.set(exempt, (used.get(exempt) ?? 0) + 1); continue; }
    const names = el.classes.size ? ` with class ${[...el.classes].map((c) => `.${c}`).join(" ")}` : "";
    problems.push(`${el.path}:${el.line}: tappable <${el.tag ?? "element"}>${names} has no rule giving it a min-height or height of ${FLOOR}px (--p-hit): ${el.text.trim()}`);
  }
  /* A listed exception that no longer matches exactly what it names is stale. Only
     checked when the file it names is among the sources (a synthetic set has none). */
  for (const u of UNREADABLE) {
    if (!sources.some((s) => s.path === u.path)) continue;
    const got = used.get(u) ?? 0;
    if (got !== u.count) problems.push(`${u.path}: the exception for <${u.tag}${u.cls ? `.${u.cls}` : ""}> covers ${got} unsized elements, listed as ${u.count} (UNREADABLE in pocket-tap-floor-lib.mjs)`);
  }
  return problems;
}
