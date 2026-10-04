import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-R7: tapSignOut() armed on the first tap and fired signOut() on
 * the second, but armedOut stayed true for the whole span of that pending
 * request — with no separate in-flight flag and no `disabled` on the
 * button — so a third rapid tap re-entered the function and fired a
 * second, concurrent signOut() call.
 *
 * The fix adds `signingOut`, set before the request and checked at the top
 * of tapSignOut(), cleared only on failure (success moves on to the
 * descent, where the button no longer matters), and binds it to the
 * button's own `disabled`.
 *
 * `+page.svelte` is not import-tested here — a `.svelte` file needs the
 * compiler this suite does not pull in for a source check — so this pins
 * the fix the same way `v19-home-load-problem.test.mjs` does for the same
 * file.
 */

const HOME_PAGE = readFileSync(
  resolve(import.meta.dirname, "../../web/src/routes/home/+page.svelte"),
  "utf8",
);

describe("#1151 W1-R7: sign-out has an in-flight guard", () => {
  it("tapSignOut bails early while a request is already in flight", () => {
    const fn = HOME_PAGE.slice(HOME_PAGE.indexOf("async function tapSignOut()"), HOME_PAGE.indexOf("async function tapSignOut()") + 400);
    expect(fn).toMatch(/if \(signingOut\) return;/u);
    expect(fn).toMatch(/signingOut = true;/u);
  });

  it("clears signingOut on failure, so a retry after an error is possible", () => {
    const fn = HOME_PAGE.slice(HOME_PAGE.indexOf("async function tapSignOut()"), HOME_PAGE.indexOf("async function tapSignOut()") + 900);
    const catchBlock = fn.slice(fn.indexOf("} catch (error) {"), fn.indexOf("} catch (error) {") + 150);
    expect(catchBlock).toMatch(/signingOut = false;/u);
  });

  it("the button is disabled while signing out", () => {
    expect(HOME_PAGE).toMatch(/<button class="signout" onclick=\{tapSignOut\} disabled=\{signingOut\}>/u);
  });
});
