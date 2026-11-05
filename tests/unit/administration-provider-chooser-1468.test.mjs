// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { fixtureApi } from "../support/fixture-api.mjs";
import { createPageLoader, runtime, settle } from "../support/svelte-page.mjs";

/*
 * #1468 Part A, point 4 (spec: note 53008; owner decision 43): the mail
 * provider profile on /administration, on the desk (+page.svelte) and on the
 * phone (pocket.svelte), is not a native <select>. It is a pressed value (a
 * button with aria-haspopup="dialog" showing the profile) that opens the
 * chooser card (web/src/lib/editing/ChooserCard.svelte) on its tiles
 * (Tiles.svelte, a radiogroup), the chooser's own body for a short fixed list
 * (the four profiles of PROVIDER_PROFILES: mailcow, gmail, outlook, other).
 * Whichever of tiles or pick-list the build uses, it is the chooser card's
 * own: a role=dialog named "Choose provider".
 *
 * Same harness as administration-mail-settings-screens.test.mjs: the real
 * page, both layouts, the phone's sheet standing in as a plain section.
 */

const PAGE = "routes/administration/+page.svelte";

/* A sheet that always draws its content (a compiled component is a function of (anchor, props); a snippet one of (anchor)). */
const SHEET = "export default function Sheet(anchor, props) { props.children?.(anchor); props.foot?.(anchor); }";

const MAILBOX = {
  configured: true, enabled: true, host: "imap.example.test", port: 993, accountUser: "intake@example.test",
  mailbox: "INBOX", tlsServerName: "imap.example.test", providerProfile: "mailcow",
  trustedRecipientHeader: "X-Original-To", trustedAuthservId: "", effectiveAuthservId: "",
  pollSeconds: 300, verificationState: "verified", verifiedAt: "2026-10-01T10:00:00.000Z",
  aliasPattern: "intake+<code>@example.test", credentialSetAt: "2026-10-01T10:00:00.000Z", credentialSetBy: "Ada Admin",
  hasPassword: true, version: 3,
  health: { status: "available", smtp: "available", imap: "available", checkedAt: "2026-10-01T10:00:00.000Z", credentialLocked: false },
};

describe("administration: the mail provider profile is the chooser card's, not a select (#1468)", () => {
  const loader = createPageLoader("admin-provider-1468", {
    stub: (file) => /\/lib\/Chrome\.svelte$/.test(file),
    stubs: { "lib/pocket/Sheet.svelte": SHEET, "$lib/backdrops/station.js": "export const mountStation = () => () => {};" },
  });
  beforeAll(() => loader.setup(PAGE));
  afterAll(() => loader.teardown());
  afterEach(() => { loader.unmount(); vi.unstubAllGlobals(); });

  async function mount() {
    vi.stubGlobal("fetch", fixtureApi({ "GET /api/admin/mailbox": () => ({ mailbox: MAILBOX }) }).fetch);
    vi.stubGlobal("matchMedia", (/** @type {string} */ query) => ({
      matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
    await loader.mount(PAGE, { data: { fixtures: false } }, { url: "http://localhost/administration" });
    const { flushSync } = await runtime();
    for (let turn = 0; turn < 10; turn += 1) { await settle(2); flushSync(); }
  }

  /** Presses "change mailbox…" in a layout: the desk's own button, or the phone's. @param {"desk" | "phone"} layout */
  async function openEditor(layout) {
    const label = layout === "desk" ? "change mailbox…" : "change mailbox";
    const open = [...document.querySelectorAll("button")].find((one) => (one.textContent ?? "").trim() === label);
    expect(open, `${layout}: the change mailbox button`).toBeDefined();
    /** @type {HTMLElement} */ (open).click();
    const { flushSync } = await runtime();
    flushSync();
    await settle(4);
  }

  /** @param {"desk" | "phone"} layout */
  const formOf = (layout) => document.querySelector(layout === "desk" ? ".mailboxform" : "#ad-mailbox-form");
  /** The provider's value in a layout's form: the button named for it. @param {"desk" | "phone"} layout */
  const providerOf = (layout) => [...formOf(layout)?.querySelectorAll("button[aria-haspopup]") ?? []]
    .find((one) => /mailcow/iu.test(one.textContent ?? "")) ?? null;

  describe.each(/** @type {const} */ (["desk", "phone"]))("%s", (layout) => {
    it("has no native select in the mail settings form", async () => {
      await mount();
      await openEditor(layout);
      expect(formOf(layout), `${layout}: the form is open`).not.toBeNull();
      expect(formOf(layout)?.querySelectorAll("select").length, "native selects in the form").toBe(0);
    });

    it("shows the provider as a pressed value that opens the chooser card's tiles", async () => {
      await mount();
      await openEditor(layout);
      const value = providerOf(layout);
      expect(value, `${layout}: a pressed value showing the saved profile, mailcow`).not.toBeNull();
      expect(value?.getAttribute("aria-haspopup")).toBe("dialog");
      /** @type {HTMLElement} */ (value).click();
      const { flushSync } = await runtime();
      flushSync();
      await settle(4);
      const chooser = [...document.querySelectorAll('[role="dialog"]')].find((one) => /^Choose provider/iu.test(one.getAttribute("aria-label") ?? ""));
      expect(chooser, "the chooser card named Choose provider stands").toBeDefined();
      const names = [...(chooser?.querySelectorAll('[role="radio"]') ?? [])].map((one) => (one.textContent ?? "").trim().toLowerCase());
      expect(names, "one tile for each profile").toEqual(["mailcow", "gmail", "outlook", "other"]);
    });
  });
});
