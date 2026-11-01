// @vitest-environment happy-dom
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { createPageBuilder } from "./happy-page-mount-lib.mjs";

/*
 * #1405: the screen a member sees when Orbit holds no usable encryption key.
 * One route, /maintenance, with `kind: "key"` (the fixture harness draws it
 * with ?kind=key, and ?kind=key&contact=1 for the variant that names the
 * instance's public contact address). The words are the design's
 * (design-1405 section 6), and the rules about what it must NOT say are as
 * much the point as what it does: no "back by" time and no timeline (nothing
 * says when the key will return), no counts, no mechanics, no setting names.
 *
 * Moved from web/tests/fidelity/maintenance-key.spec.js (ADR-0039, #1613): the
 * words are markup, so the page is mounted in happy-dom with what the route's
 * own fixture load hands it. The desk and the phone draw the same markup (the
 * route has no layout fork, only CSS), so the words are proven once; the
 * "does not spill sideways" run needs a real layout and stays on the rig.
 * The apostrophe is compared as a straight one, as before.
 */

vi.stubEnv("ORBIT_FIXTURES", "1");

const page = createPageBuilder("maintenance-key", {
  url: "http://localhost/maintenance?kind=key",
  stubs: {
    "lib/Grain.svelte": "export default function Grain() {}\n",
    "./sky.js": "export const mountTotalitySky = () => () => {};\n",
  },
});
afterEach(() => page.unmountAll());
afterAll(() => { page.dispose(); vi.unstubAllEnvs(); });

/** @param {string} text */
const straight = (text) => text.replace(/[‘’]/gu, "'").replace(/\s+/gu, " ").trim();

const HEADING = "locked — back once the key is restored";
const FIRST = "Orbit's encryption key isn't available, so it can't open anyone's records or sign anyone in right now.";
const SECOND = "Nothing is lost. Everything is intact and waiting. An administrator needs to fix this on the server Orbit runs on — it can't be done from here, and signing in won't help until it's done.";
/** @param {string} address */
const ADDRESS_LINE = (address) => `If you're not sure who that is, write to ${address}.`;

/** The page as the fixture harness draws it: the route's own load, then the page. @param {string} query */
async function keyScreen(query) {
  const { load } = await import("../../web/src/routes/maintenance/+page.server.js");
  const data = await load(/** @type {any} */ ({ url: new URL(`http://localhost/maintenance${query}`), setHeaders: () => {} }));
  const { target } = await page.mount("routes/maintenance/+page.svelte", { data });
  return {
    target,
    main: straight(target.querySelector("main")?.textContent ?? ""),
    body: straight(target.textContent ?? ""),
  };
}

describe("the key screen", () => {
  it("says what the design says, word for word, without an address", async () => {
    const screen = await keyScreen("?kind=key");
    const headings = screen.target.querySelectorAll("h1");
    expect(headings).toHaveLength(1);
    expect(straight(headings[0].textContent ?? "").toLowerCase()).toBe(HEADING);
    expect(screen.main).toContain(FIRST);
    expect(screen.main).toContain(SECOND);
    expect(screen.main).not.toContain("not sure who that is");
    expect(screen.main).not.toMatch(/@/u);
  });

  it("names the public contact address when there is one", async () => {
    const screen = await keyScreen("?kind=key&contact=1");
    expect(screen.main).toContain(FIRST);
    expect(screen.main).toContain(SECOND);
    const address = screen.main.match(/write to (\S+@\S+?)\.(?:\s|$)/u)?.[1];
    expect(address, "the contact line names no address").toBeTruthy();
    expect(screen.main).toContain(ADDRESS_LINE(address ?? ""));
  });

  it("promises no return time, no timeline and no earlier updates", async () => {
    const screen = await keyScreen("?kind=key&contact=1");
    const text = screen.body.toLowerCase();
    for (const forbidden of ["back by", "expected", "earlier updates", "scheduled", "started", "update"]) {
      expect(text, `the key screen must not say "${forbidden}"`).not.toContain(forbidden);
    }
    expect(screen.target.querySelectorAll(".earlier")).toHaveLength(0);
    expect(screen.target.querySelectorAll("time")).toHaveLength(0);
  });

  it("names no setting, key id or command", async () => {
    const screen = await keyScreen("?kind=key");
    expect(screen.body).not.toMatch(/DOCUMENT_KEK|OPERATOR_ALERT_ADDRESS|docker|\.env/iu);
    expect(screen.body).not.toMatch(/\b[0-9a-f]{24}\b/u);
  });

  /*
   * Owner decision on #1405 (9a): with no alert address set, the container log
   * is the alert, and the maintenance screen itself tells the administrator to
   * look there. Design section 6 leaves the line out; the owner's answer
   * wins, so it is asserted loosely (it has to say "log"), until the copy is
   * ratified.
   */
  it("tells an administrator where to look: the server's log (owner decision 9a)", async () => {
    const screen = await keyScreen("?kind=key");
    expect(screen.body.toLowerCase()).toMatch(/\blogs?\b/u);
  });
});
