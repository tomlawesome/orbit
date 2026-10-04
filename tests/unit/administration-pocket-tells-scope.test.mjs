import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * #1151 A1-Q6 (follow-up): the pocket layout's `tells` block still read
 * `tests.relay?.word` / `tests.mailbox?.word` after the `tests` local state
 * it once read was removed in favour of the server-backed `mailProbes`
 * (#1151 A1-Q6 itself) -- `tests` was never renamed in this one spot, so
 * svelte-check's "Cannot find name 'tests'" was a real dangling reference
 * that would throw at run time the first time `tells` was read (every
 * visit, since view is already loaded by then).
 *
 * Static scan rather than a mount, same shape as
 * tests/unit/archive-passphrase-min-gate.test.mjs: there is no component-
 * mounting harness in this suite, and the bug is a name that does not
 * exist in scope at all, which a source scan proves directly.
 */

const POCKET_PATH = "web/src/routes/administration/pocket.svelte";

function readPocket() {
  return readFileSync(new URL(`../../${POCKET_PATH}`, import.meta.url), "utf8");
}

describe("administration/pocket.svelte's tells block (#1151 A1-Q6)", () => {
  it("never references the removed `tests` local state", () => {
    const src = readPocket();
    expect(src, `${POCKET_PATH} still references the removed \`tests\` state`).not.toMatch(/\btests\.(relay|mailbox)\b/);
  });

  it("reads the relay and mailbox failures off mailProbes, like the desk layout does", () => {
    const src = readPocket();
    expect(src).toMatch(/mailProbes\.relay/);
    expect(src).toMatch(/mailProbes\.mailbox/);
  });
});
