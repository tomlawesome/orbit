#!/usr/bin/env node
/**
 * Scaffolds one screen from its ratified mockup — the "build the real deal"
 * step, run once per screen.
 *
 * It lifts the mockup's <style> block and <body> markup into files byte for
 * byte, so the first version of a screen is the design itself rather than
 * somebody's retyping of it. That retyping step is where the design died in
 * #408. The generated files are then promoted into src/routes/<screen>/, lose
 * their GENERATED banners, and become the application's own code: from that
 * point the screen iterates in the running app and the mockup is history.
 *
 *   node scripts/scaffold-screen.mjs           # scaffold the listed screen
 *   node scripts/scaffold-screen.mjs --check   # verify nothing drifted mid-scaffold
 *
 * Why the CSS cannot live in a Svelte <style> block: Svelte scopes component
 * styles and prunes selectors it believes are unused. The mockups style `body`
 * and depend on `body.lit .rays`-style state selectors that no component can
 * see, so scoping would silently drop them. Plain imported CSS is global and
 * untouched.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");

/**
 * Mockup source → generated stylesheet and markup fragment. One entry per
 * screen. The fragment is a .svelte file because Svelte's template language
 * *is* HTML: the mockup's markup is already valid Svelte and needs no
 * translation step. That is the whole reason the framework was chosen.
 */
const TARGETS = [
  // Populated with the one screen being scaffolded, then emptied again once
  // its files are promoted into src/routes/<screen>/ and become the app's own.
];

const CSS_BANNER = (source) =>
  `/* GENERATED — do not edit.\n` +
  `   Lifted verbatim from ${source} by web/scripts/scaffold-screen.mjs.\n` +
  `   Edit the mockup, then re-run the script. */\n`;

const MARKUP_BANNER = (source) =>
  `<!-- GENERATED — do not edit.\n` +
  `     Lifted verbatim from ${source} by web/scripts/scaffold-screen.mjs.\n` +
  `     Behaviour is attached by the page that renders this, never in here.\n` +
  `     Edit the mockup, then re-run the script. -->\n`;

/**
 * The mockups carry exactly one <style> block each. Anything else is a design
 * change that should be noticed, so this refuses to guess.
 */
function styleBlockOf(html, source) {
  const blocks = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  if (blocks.length !== 1) {
    throw new Error(
      `${source}: expected exactly 1 <style> block, found ${blocks.length}`,
    );
  }
  return blocks[0][1];
}

/**
 * The <body>, minus its <script> blocks — behaviour is re-attached by the page
 * component so it can reach real data and real routes, while the markup it
 * drives stays untouched.
 */
function bodyMarkupOf(html, source) {
  const body = html.match(/<body>([\s\S]*)<\/body>/);
  if (!body) throw new Error(`${source}: no <body> found`);

  const markup = body[1].replace(/<script>[\s\S]*?<\/script>/g, "").trim();

  // Svelte reads { and } as template expressions. No mockup markup uses them
  // today; if one ever does it must be escaped deliberately, not discovered as
  // a parse error three screens later.
  const braces = markup.match(/[{}]/g);
  if (braces) {
    throw new Error(
      `${source}: markup contains ${braces.length} brace(s), which Svelte ` +
        `would read as template syntax — escape them before extracting`,
    );
  }
  return markup + "\n";
}

/** The mockup's own <script> contents, concatenated in document order. */
function scriptOf(html, source) {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (!blocks.length) throw new Error(`${source}: no <script> block found`);
  return blocks.map((block) => block[1]).join("\n");
}

const check = process.argv.includes("--check");
const stale = [];
let written = 0;

for (const target of TARGETS) {
  const html = readFileSync(resolve(repo, target.from), "utf8");

  const outputs = [
    {
      to: target.css,
      content: CSS_BANNER(target.from) + styleBlockOf(html, target.from),
    },
    {
      to: target.markup,
      content: MARKUP_BANNER(target.from) + bodyMarkupOf(html, target.from),
    },
  ];

  /*
   * Screens whose behaviour *is* the design — the home chart's camera flights,
   * constellation placement and overlap relaxation — carry their JS across
   * too, so it can keep running as the imperative DOM code it was written as.
   * Rewriting it into reactive markup is the same translation step that lost
   * the design in #408, arriving by another door.
   */
  if (target.js) {
    outputs.push({
      to: target.js,
      content: CSS_BANNER(target.from) + scriptOf(html, target.from),
    });
  }

  for (const { to, content } of outputs) {
    const path = resolve(repo, to);

    if (check) {
      const actual = existsSync(path) ? readFileSync(path, "utf8") : null;
      if (actual !== content) stale.push(to);
      continue;
    }

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    written += 1;
    console.log(`extracted ${target.from} -> ${to}`);
  }
}

if (stale.length) {
  console.error(
    `Mockup CSS is stale — re-run "node scripts/scaffold-screen.mjs":\n` +
      stale.map((path) => `  ${path}`).join("\n"),
  );
  process.exit(1);
}

if (check) console.log(`mockup output up to date (${TARGETS.length * 2} files)`);
else console.log(`${written} file(s) written from ${TARGETS.length} mockup(s)`);
