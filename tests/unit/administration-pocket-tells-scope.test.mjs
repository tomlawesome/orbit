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

/*
 * #1316 A1-F1: a warm service row's tell used to say `retrying` whatever the
 * row's detail was, so a virus scanner whose signatures are nine days old
 * read "virus scanner retrying" -- the opposite of what is wrong with it. The
 * tell now reads the row's detail: `out of date` for stale signatures,
 * `retrying` for a worker that is retrying, `signature age unknown` when the
 * scanner cannot say, and `down` for an overdue row.
 *
 * Evaluated rather than text-matched: there is no component-mounting harness
 * in this suite (see above), so the `tells` block is lifted out of the source
 * and run as a function over a stand-in `view`. It reads only `view`, `jobs`,
 * `mailProbes`, `plural` and `testVerdict`, handed in below.
 */

/** @param {unknown[]} services @returns {string[]} the tell words, in order */
function tellWords(services) {
  const src = readPocket();
  const start = src.indexOf("const tells = $derived.by(() => {");
  expect(start, `${POCKET_PATH} has no \`tells\` block`).toBeGreaterThan(-1);
  const end = src.indexOf("\n  });", start);
  const body = src.slice(start + "const tells = $derived.by(() => {".length, end);
  const run = new Function("view", "jobs", "mailProbes", "plural", "testVerdict", `"use strict";\n${body}`);
  const list = run(
    { services, mailbox: null },
    [],
    {},
    (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`,
    () => ({ tone: "ok" }),
  );
  return list.map((/** @type {{ word: string }} */ tell) => tell.word);
}

describe("administration/pocket.svelte's service tells say what the row says (#1316 A1-F1)", () => {
  it("names a stale virus scanner as out of date, not retrying", () => {
    const words = tellWords([
      ["warm", "virus scanner", "out of date · signatures 9d ago"],
      ["warm", "notification worker", "retrying · last error 2m ago"],
    ]);
    expect(words).toContain("virus scanner out of date");
    expect(words).not.toContain("virus scanner retrying");
  });

  it("still says retrying for a worker whose detail says it is retrying", () => {
    const words = tellWords([
      ["warm", "virus scanner", "out of date · signatures 9d ago"],
      ["warm", "notification worker", "retrying · last error 2m ago"],
    ]);
    expect(words).toContain("notification worker retrying");
  });

  it("says down for an overdue service", () => {
    expect(tellWords([["overdue", "relay", "unreachable"]])).toEqual(["relay down"]);
  });

  it("says the signature age is unknown when the scanner row says so", () => {
    expect(tellWords([["warm", "virus scanner", "signature age unknown"]])).toEqual([
      "virus scanner signature age unknown",
    ]);
  });
});
