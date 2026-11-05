import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-R4: the client-side re-read home's onMount does after first paint
 * (+page.server.js's own view is read again live, #451) had no `.catch()` at
 * all. During a backend outage the server-rendered page stayed up, but
 * `sync()` — which binds every listener the screen answers to — only ran
 * inside the `.then()`, so a failed re-read left a screen that looked alive
 * and answered nothing, with no error shown anywhere.
 *
 * The pocket's own re-read — `<Pocket>`'s `onchanged` prop, fired after the
 * review sheet amends something on a phone — had the identical bare
 * `view = await readHome()` with nothing catching it, so the same failure
 * mode could happen there too; it now guards the same way, into the same
 * `homeLoadProblem`.
 *
 * `+page.svelte` is not import-tested here — a `.svelte` file needs the
 * compiler this suite does not pull in for a source check — so this pins
 * the fix the same way `v19-home-hit-area.test.mjs` pins `home.css`: against
 * the file's own text.
 */

const HOME_PAGE = readFileSync(
  resolve(import.meta.dirname, "../../web/src/routes/home/+page.svelte"),
  "utf8",
);

describe("#1151 W1-R4: the home re-read catches its own failure", () => {
  it("has a .catch() on the onMount re-read, setting a visible problem", () => {
    const onMountRead = HOME_PAGE.slice(HOME_PAGE.indexOf("readHome().then(async (data)"));
    const thenEnd = onMountRead.indexOf("}).catch(");
    expect(thenEnd).toBeGreaterThan(-1);
    const catchBlock = onMountRead.slice(thenEnd, thenEnd + 400);
    expect(catchBlock).toMatch(/homeLoadProblem\s*=/u);
  });

  it("renders the problem with the page's own alert pattern", () => {
    expect(HOME_PAGE).toMatch(/\{#if homeLoadProblem\}/u);
    expect(HOME_PAGE).toMatch(/class="p-error" role="alert"/u);
  });

  /* Design call 2026-11-05 (#1355 note 52781, #1671 T-F3): the banner is the
     mount read's voice only. The pocket's re-read is still never silent: a
     failure reaches the act that asked, which says done-but-unread. */
  it("also guards the pocket's own re-read, on <Pocket>'s onchanged prop: never silent, never the banner", () => {
    const onchanged = HOME_PAGE.slice(HOME_PAGE.indexOf("onchanged={async () => {"));
    const body = onchanged.slice(0, onchanged.indexOf("}} />"));
    expect(body).toMatch(/view = await readHomeBanner\(\);/u);
    expect(body, "the failure is not swallowed").not.toMatch(/\.catch\(|catch \(/u);
    expect(body, "a failed re-read does not raise the banner").not.toMatch(/homeLoadProblem\s*=/u);
    const banner = HOME_PAGE.slice(HOME_PAGE.indexOf("async function readHomeBanner()"));
    const bannerBody = banner.slice(0, banner.indexOf("\n  }\n"));
    expect(bannerBody, "a good read clears a stale banner").toMatch(/homeLoadProblem = null/u);
    expect(bannerBody, "a failed read never raises it").not.toMatch(/homeLoadProblem = (?!null)/u);
    const POCKET = readFileSync(resolve(import.meta.dirname, "../../web/src/routes/home/pocket.svelte"), "utf8");
    expect(POCKET, "the pocket says done-but-unread when the re-read fails").toMatch(/rereadAfterLanded\(async \(\) => \{ await onchanged\?\.\(\); \}, wake\)/u);
  });
});
