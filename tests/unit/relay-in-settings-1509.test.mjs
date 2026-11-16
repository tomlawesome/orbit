import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { pocketFiles } from "./pocket-tap-floor-lib.mjs";

/*
 * #1509 (note 56340): a member's mail relay moves from /settings/mail into the
 * Settings screen, as the third tab of the Mail card. What the screen shows,
 * state by state, and the 44px floor on the phone, are in the rig spec
 * web/tests/rig/relay-in-settings-1509.spec.js; the sender-check, sending-
 * address and administrator-pause cases that mount the screen are the
 * v19-mail-sender-*, mail-admin-paused-and-copy and tour tests, now pointed at
 * Settings. This file holds what needs no browser: where the old address
 * sends the reader, which links lead to the relay, what is gone from the
 * source, and that the phone's static tap-floor check reads the relay's panel.
 */

const web = (/** @type {string} */ path) => resolve(import.meta.dirname, "../../web", path);
const read = (/** @type {string} */ path) => readFileSync(web(path), "utf8");

afterEach(() => { vi.unstubAllGlobals(); });

describe("/settings/mail redirects to /settings#mail, keeping ?sender=", () => {
  /** The page's own load, over a relay read that works, so only the redirect is in question. */
  async function loadAt(/** @type {string} */ search) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ relay: { address: "x@example.test" }, workspace: { households: [] }, receipts: [] }))));
    const { load } = await import("../../web/src/routes/settings/mail/+page.js");
    try {
      const result = await load(/** @type {any} */ ({ url: new URL(`http://orbit.test/settings/mail${search}`) }));
      return { thrown: null, result };
    } catch (thrown) {
      return { thrown: /** @type {{ status?: number, location?: string }} */ (thrown), result: null };
    }
  }

  it("throws a redirect to /settings#mail", async () => {
    const { thrown, result } = await loadAt("");
    expect(result, "the old page's load answered with page data instead of redirecting").toBeNull();
    expect(thrown?.status).toBeGreaterThanOrEqual(301);
    expect(thrown?.status).toBeLessThanOrEqual(308);
    expect(thrown?.location).toBe("/settings#mail");
  });

  it.each(["verified", "unverified"])("keeps ?sender=%s, so the check email's landing still announces itself", async (word) => {
    const { thrown } = await loadAt(`?sender=${word}`);
    expect(thrown?.location).toMatch(/^\/settings\?sender=[a-z]+#mail$/u);
    expect(thrown?.location).toContain(`sender=${word}`);
  });
});

describe("the verify route lands on Settings", () => {
  it("RELAY_PAGE is /settings", () => {
    expect(read("src/routes/api/settings/mail-relay/verify/+server.js")).toMatch(/const RELAY_PAGE = "\/settings";/u);
  });
});

describe("every link to the relay goes to /settings#mail", () => {
  it.each([
    ["the desk inbox's `your relay →`", "src/routes/inbox/+page.svelte"],
    ["the phone inbox's `open the relay →`", "src/routes/inbox/pocket.svelte"],
  ])("%s", (_name, file) => {
    const source = read(file);
    expect(source).not.toContain("/settings/mail");
    expect(source).toContain("#mail");
  });

  it("the tour's walkTo has no special case for the mail route, and reaches /settings", () => {
    const tour = read("src/lib/tour/Tour.svelte");
    expect(tour).not.toContain("/settings/mail");
    expect(tour).toMatch(/route === "\/settings"/u);
    expect(read("src/lib/tour/chapters/06-paper-by-post.js")).not.toContain('"/settings/mail"');
  });
});

describe("what the move removes", () => {
  it("the small relay card that only linked to the page is gone, desk and phone", () => {
    for (const file of ["src/routes/settings/+page.svelte", "src/routes/settings/pocket.svelte"]) {
      const source = read(file);
      expect(source, file).not.toContain("/settings/mail");
      expect(source, file).not.toContain("open the relay →");
      expect(source, file).not.toContain("rotate · pause · details");
    }
  });

  it("the old page's screens are gone; the route is only a redirect", () => {
    expect(existsSync(web("src/routes/settings/mail/+page.svelte")), "settings/mail/+page.svelte").toBe(false);
    expect(existsSync(web("src/routes/settings/mail/pocket.svelte")), "settings/mail/pocket.svelte").toBe(false);
    expect(existsSync(web("src/routes/settings/mail/+page.js")), "settings/mail/+page.js still redirects").toBe(true);
  });

  it("the docs that named /settings/mail name Settings", () => {
    expect(readFileSync(resolve(import.meta.dirname, "../../docs/testing.md"), "utf8")).not.toContain("/settings/mail");
  });
});

describe("the Mail card carries the relay, desk and phone", () => {
  it("the desk's card is #mail, wide, with three tabs, the third `your relay`, and the card is named Mail", () => {
    const source = read("src/routes/settings/+page.svelte");
    expect(source).toMatch(/id="mail"/u);
    expect(source).toMatch(/class="card wide[^"]*"[^>]*\bid="mail"|id="mail"[^>]*class="card wide/u);
    expect(source).toContain(">your relay</button>");
    expect(source).toMatch(/<h2 id="rem-h">Mail<\/h2>/u);
    expect(source).not.toMatch(/<h2 id="rem-h">Reminders<\/h2>/u);
  });

  it("the phone's card is #p-mail, named Mail, with `your relay` among its tabs", () => {
    const source = read("src/routes/settings/pocket.svelte");
    expect(source).toMatch(/id="p-mail"/u);
    expect(source).toContain(">your relay</button>");
    expect(source).not.toMatch(/id="st-reminders">Reminders</u);
  });

  it("the phone's static tap-floor check reads the file that draws the relay's panel", () => {
    const drawn = pocketFiles().filter((file) => readFileSync(web(`src/${file}`), "utf8").includes('id="p-mail"'));
    expect(drawn, "no file the tap-floor check reads draws #p-mail").not.toEqual([]);
    expect(pocketFiles()).not.toContain("routes/settings/mail/pocket.svelte");
  });
});
