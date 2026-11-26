// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { fixtureApi, jsonResponse } from "../support/fixture-api.mjs";
import { createPageLoader, runtime, settle } from "../support/svelte-page.mjs";

/*
 * #1633 review gap 2: an administrator with NO password is challenged by a
 * provider step-up (intent `administrator_set`) and comes back to
 * /administration?stepup=administrator_set with a proof. The band reopens for
 * the person they were changing, as the setup link's does. The proof pays
 * for one PUT: once that PUT is refused (here 409 last_administrator), a
 * second press must not send a PUT carrying neither proof nor password, which
 * can only fail. The band either closes, or the next press starts a fresh
 * step-up.
 *
 * Mounted, not run in the rig: the fixtures instance (ORBIT_FIXTURES=1) never
 * takes the `stepup` return path and always has a password, so the rig cannot
 * stand an OIDC-only administrator up. Same harness as
 * administration-draft-plain-mount-1604.test.mjs (desk) and
 * pocket-administration.test.mjs (phone), with the real Sheet.
 */

vi.mock("$lib/backdrops/station.js", () => ({ mountStation: () => () => {} }));

const PAGE = "routes/administration/+page.svelte";
const DRAFT_KEY = "orbit-local-user-draft";
const LAST_WORDS = "Orbit must retain at least one administrator";
const GIVE_NOTE = "Gives Emma Harlow administrator access";

const ROSTER = {
  users: [
    { id: "u-fixture", displayName: "Ned Harlow", email: "ned@harlow.example", isInstanceAdmin: true, isPrimaryAdministrator: false, disabledAt: null },
    { id: "u-emma", displayName: "Emma Harlow", email: "emma@harlow.example", isInstanceAdmin: false, isPrimaryAdministrator: false, disabledAt: null },
    { id: "u-sue", displayName: "Sue Harlow", email: "sue@harlow.example", isInstanceAdmin: true, isPrimaryAdministrator: false, disabledAt: null },
  ],
  totalUsers: 3,
  truncated: false,
};

describe("administrator access after a provider step-up (#1633)", () => {
  const loader = createPageLoader("admin-access-stepup-1633", {
    stub: (file) => /\/lib\/Chrome\.svelte$/.test(file),
  });
  beforeAll(() => loader.setup(PAGE));
  afterAll(() => loader.teardown());
  afterEach(() => { loader.unmount(); vi.unstubAllGlobals(); sessionStorage.clear(); history.replaceState(null, "", "/"); });

  /**
   * Mounts the screen as the provider's return lands on it: not fixtures, an
   * administrator with no password, the errand stashed for Emma.
   * @param {{ phone: boolean }} options
   */
  async function returnFromStepUp({ phone }) {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ intent: "administrator_set", admin: { personId: "u-emma" }, at: Date.now() }));
    const api = fixtureApi({
      "GET /api/auth/methods": () => ({ local: { set: false, changedAt: null }, oidc: [] }),
      "GET /api/admin/users": () => structuredClone(ROSTER),
      "PUT /api/admin/users": () => jsonResponse({ error: { code: "last_administrator", message: LAST_WORDS } }, 409),
      /* A fresh step-up would leave the page for the provider; refused here, so the page stays to be looked at. */
      "POST /api/auth/step-up/start": () => jsonResponse({ error: { code: "provider_unavailable", message: "the provider is not reachable in this test" } }, 503),
    });
    vi.stubGlobal("fetch", api.fetch);
    vi.stubGlobal("matchMedia", (/** @type {string} */ query) => ({
      matches: phone, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
    /* The desk reads the return from the window's own address, not $app/state's. */
    history.replaceState(null, "", "/administration?stepup=administrator_set");
    await loader.mount(PAGE, { data: { fixtures: false } }, { url: "http://localhost/administration?stepup=administrator_set" });
    const { flushSync } = await runtime();
    const turn = async () => { for (let i = 0; i < 10; i += 1) { await settle(2); flushSync(); } };
    await turn();
    return { api, turn };
  }

  /** The band (desk) or the sheet (phone) that carries the give note, when it is open. @param {boolean} phone */
  function openBand(phone) {
    if (phone) {
      const sheet = [...document.querySelectorAll('[role="dialog"]')].find((el) => el.textContent?.includes(GIVE_NOTE));
      return sheet?.closest(".p-sheet-layer.open") ? /** @type {HTMLElement} */ (sheet) : null;
    }
    return /** @type {HTMLElement | null} */ ([...document.querySelectorAll("form")].find((el) => el.textContent?.includes(GIVE_NOTE)) ?? null);
  }

  /** The band's submit: in the form on the desk, in the sheet's foot on the phone. @param {HTMLElement} band */
  const submitOf = (band) => /** @type {HTMLButtonElement | null} */ (
    [...(band.closest(".p-sheet-layer") ?? band).querySelectorAll("button")].find((el) => el.textContent?.trim() === "give it") ?? null);

  const puts = (/** @type {{ calls: { method: string, path: string }[] }} */ api) =>
    api.calls.filter((call) => call.method === "PUT" && call.path === "/api/admin/users").length;
  const stepUps = (/** @type {{ calls: { method: string, path: string }[] }} */ api) =>
    api.calls.filter((call) => call.method === "POST" && call.path === "/api/auth/step-up/start").length;

  for (const phone of [false, true]) {
    const dialect = phone ? "phone" : "desk";

    it(`${dialect}: the ?stepup=administrator_set return reopens the band for the same person, with no password field`, async () => {
      await returnFromStepUp({ phone });
      const band = openBand(phone);
      expect(band, "the band for Emma is open again").not.toBeNull();
      expect(band?.querySelector('input[type="password"]') ?? null, "no password is asked of an OIDC-only administrator").toBeNull();
    });

    it(`${dialect}: after the proven PUT is refused, the next press sends no PUT without a proof; it closes or starts a fresh step-up`, async () => {
      const { api, turn } = await returnFromStepUp({ phone });
      const band = openBand(phone);
      expect(band, "the band for Emma is open again").not.toBeNull();
      submitOf(/** @type {HTMLElement} */ (band))?.click();
      await turn();
      expect(puts(api), "the proven press sent its PUT").toBe(1);
      /* The phone says it in the wake, which the root layout draws, not this page. */
      if (!phone) expect(document.body.textContent).toContain(LAST_WORDS);

      const again = openBand(phone);
      if (again) {
        const startsBefore = stepUps(api);
        submitOf(again)?.click();
        await turn();
        expect(puts(api), "no second PUT goes out with the proof already spent").toBe(1);
        expect(stepUps(api), "the next press starts a fresh step-up").toBeGreaterThan(startsBefore);
      }
    });
  }
});
