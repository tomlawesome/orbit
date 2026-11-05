import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * One shell (#1689, design call on the issue): the shared page CSS lives in
 * PageSky.svelte's own scoped <style> and nowhere else, and the account card is
 * one presentational component that Chrome and home both render. Read from the
 * files, no DOM, as pocket-input-no-zoom.test.mjs does (#1356). The pixel proof
 * is the unchanged fidelity baselines (screens.spec.js and the specs named in
 * the issue), not this file.
 */

const WEB_SRC = resolve(import.meta.dirname, "../../web/src");
const ROUTES = join(WEB_SRC, "routes");
const read = (/** @type {string} */ path) => readFileSync(resolve(WEB_SRC, path), "utf8");

/** @param {string} dir @returns {string[]} */
function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name === ".svelte-kit") return [];
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** The style a file carries, comments removed: the file for css, the <style> blocks for svelte.
 *  @param {string} path */
function styleOf(path) {
  const text = readFileSync(path, "utf8");
  const style = path.endsWith(".svelte")
    ? [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n")
    : text;
  return style.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The markup and script of a svelte file, style blocks and comments removed.
 *  @param {string} text */
const withoutStyle = (text) =>
  text.replace(/<style[^>]*>[\s\S]*?<\/style>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("shared page CSS lives in PageSky.svelte only (#1689)", () => {
  const routeStyles = filesUnder(ROUTES)
    .filter((p) => /\.(css|svelte)$/.test(p))
    .filter((p) => !relative(ROUTES, p).startsWith("home/"));

  it("finds route stylesheets to check", () => {
    expect(routeStyles.length).toBeGreaterThan(10);
  });

  it("no route stylesheet outside home/ names .sky or .vignette", () => {
    const offenders = routeStyles
      .filter((p) => /\.(sky|vignette)(?![\w-])/.test(styleOf(p)))
      .map((p) => relative(WEB_SRC, p));
    expect(offenders).toEqual([]);
  });

  it("there is no page-shell.css", () => {
    const found = filesUnder(WEB_SRC).filter((p) => /page-shell\.css$/.test(p));
    expect(found.map((p) => relative(WEB_SRC, p))).toEqual([]);
  });

  it("PageSky.svelte owns .sky and .vignette in its own <style>", () => {
    const style = styleOf(resolve(WEB_SRC, "lib/PageSky.svelte"));
    expect(style).toMatch(/\.sky\b/);
    expect(style).toMatch(/\.vignette\b/);
    expect(style).toContain("--vignette-z");
    expect(style).toContain("--vignette-gradient");
  });
});

describe("one account card for Chrome and home (#1689)", () => {
  const cardPath = resolve(WEB_SRC, "lib/AccountCard.svelte");

  it("AccountCard.svelte exists and keeps class account, id account and region role", () => {
    expect(existsSync(cardPath)).toBe(true);
    const text = readFileSync(cardPath, "utf8");
    expect(text).toMatch(/class="account\b/);
    expect(text).toContain('id="account"');
    expect(text).toContain('role="region"');
    expect(text).toMatch(/\.account\b/); // its own styles
  });

  it("is presentational: no router, page store or fetch", () => {
    const text = withoutStyle(readFileSync(cardPath, "utf8"));
    expect(text).not.toMatch(/\$app\/(state|navigation)/);
    expect(text).not.toMatch(/\bfetch\(/);
  });

  it("Chrome renders it", () => {
    const text = read("lib/Chrome.svelte");
    expect(text).toMatch(/import\s+AccountCard\s+from\s+["']\$lib\/AccountCard\.svelte["']/);
    expect(text).toMatch(/<AccountCard\b/);
  });

  it("home renders it", () => {
    const text = read("routes/home/+page.svelte");
    expect(text).toMatch(/import\s+AccountCard\s+from\s+["']\$lib\/AccountCard\.svelte["']/);
    expect(text).toMatch(/<AccountCard\b/);
  });

  it("neither host keeps its own copy of the card markup or styles", () => {
    const chrome = read("lib/Chrome.svelte");
    const home = read("routes/home/+page.svelte");
    expect(withoutStyle(chrome)).not.toMatch(/class="[^"]*\bsignout\b/);
    expect(withoutStyle(home)).not.toMatch(/class="[^"]*\bsignout\b/);
    expect(styleOf(resolve(WEB_SRC, "lib/Chrome.svelte"))).not.toMatch(/\.swatches\b/);
    expect(styleOf(resolve(WEB_SRC, "routes/home/home.css"))).not.toMatch(/\.account\s+\.swatches\b|\.account\s+\.signout\b/);
  });

  it("Chrome has no switch-off props and no onclose seam", () => {
    const text = withoutStyle(read("lib/Chrome.svelte"));
    expect(text).not.toMatch(/\bonclose\b/);
    const props = text.match(/let\s*\{([\s\S]*?)\}\s*=\s*\$props\(\)/)?.[1] ?? "";
    expect(props).not.toBe("");
    expect(props).not.toMatch(/\b(showBack|hideBack|noBack|showTop|hideTop|noTop|showHatch|hideHatch|noHatch|bare|standalone|onclose)\b/);
  });
});
