// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { fixtureApi } from "../support/fixture-api.mjs";
import { createPageLoader, runtime, settle } from "../support/svelte-page.mjs";

/*
 * #1604 G11-FR1, owner ruling BUILD (lows-g2-rulings.md): opening
 * /administration plainly (no `stepup` in the address, not fixtures) removes
 * the tab's stashed local-user draft: an errand that comes back without its
 * proof is over, and the typed email and name must not sit in storage until
 * the tab closes. The form is blank. Same harness as
 * administration-provider-chooser-1468.test.mjs.
 */

const PAGE = "routes/administration/+page.svelte";
const DRAFT_KEY = "orbit-local-user-draft";
const SHEET = "export default function Sheet(anchor, props) { props.children?.(anchor); props.foot?.(anchor); }";
const TYPED = { email: "someone@example.invalid", displayName: "Someone Example", expiresInDays: 7 };

describe("administration: a plain visit drops an abandoned draft (#1604 G11-FR1)", () => {
  const loader = createPageLoader("admin-draft-plain-1604", {
    stub: (file) => /\/lib\/Chrome\.svelte$/.test(file),
    stubs: { "lib/pocket/Sheet.svelte": SHEET, "$lib/backdrops/station.js": "export const mountStation = () => () => {};" },
  });
  beforeAll(() => loader.setup(PAGE));
  afterAll(() => loader.teardown());
  afterEach(() => { loader.unmount(); vi.unstubAllGlobals(); sessionStorage.clear(); });

  it("removes the stashed draft and shows no typed person", async () => {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
      intent: "local_user_create", local: TYPED, systemName: "", resend: null, at: Date.now(),
    }));
    vi.stubGlobal("fetch", fixtureApi({}).fetch);
    vi.stubGlobal("matchMedia", (/** @type {string} */ query) => ({
      matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
    await loader.mount(PAGE, { data: { fixtures: false } }, { url: "http://localhost/administration" });
    const { flushSync } = await runtime();
    for (let turn = 0; turn < 10; turn += 1) { await settle(2); flushSync(); }

    expect(sessionStorage.getItem(DRAFT_KEY), "the abandoned draft is gone").toBeNull();
    const typed = [...document.querySelectorAll("input")].map((one) => one.value);
    expect(typed.some((value) => value.includes(TYPED.email) || value.includes(TYPED.displayName)), "no form is refilled").toBe(false);
  });
});
