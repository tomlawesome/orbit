import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dryRunner } from "../../web/src/lib/data/dry-run.js";
import { periodChoices } from "../../web/src/lib/editing/item-draft.js";

/*
 * #1337, the browser's half of the completion preview (design: owner answer
 * 7a, 2026-10-10). askCommand is the dry run read whole -- the refusal and
 * the engine's preview -- of which checkCommand keeps only the words; the
 * drawer's modes ask it for the completed-on date alone, and the foot row
 * shows "then <date>" under record and cancel. DrawerModes and the Svelte
 * files use runes or markup this suite does not compile, so their wiring is
 * read from source, as home-discard-guard.test.mjs does.
 */

const read = (path) => readFileSync(new URL(`../../web/src/${path}`, import.meta.url), "utf8");

/** @type {Array<{ status: number, body: unknown }>} */
let answers = [];
/** @type {Array<unknown>} */
let sent = [];

beforeEach(() => {
  answers = [];
  sent = [];
  vi.stubGlobal("fetch", vi.fn(async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
    if (url === "/api/auth/session") {
      return new Response(JSON.stringify({ csrfToken: "token" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const next = answers.shift();
    if (!next) throw new TypeError("network down");
    sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function workspace() {
  return import("../../web/src/lib/data/workspace.js");
}

const command = { type: "item.complete", householdId: "h-1", itemId: "i-1", completedDate: "2026-10-10" };

describe("askCommand, the dry run read whole", () => {
  it("answers the engine's preview beside no refusal, sending the command with dryRun", async () => {
    answers.push({ status: 200, body: { preview: { nextDate: "2027-10-10" } } });
    const { askCommand } = await workspace();
    await expect(askCommand(command)).resolves.toEqual({ refusal: null, preview: { nextDate: "2027-10-10" } });
    expect(sent).toEqual([{ ...command, dryRun: true }]);
  });

  it("answers no refusal and no preview for an empty verdict (a one-off, or another command)", async () => {
    answers.push({ status: 200, body: {} });
    const { askCommand } = await workspace();
    await expect(askCommand(command)).resolves.toEqual({ refusal: null, preview: null });
  });

  it("answers the refusal's words and no preview when the engine refuses", async () => {
    answers.push({ status: 200, body: { refusal: { code: "date_in_future", message: "not yet — that day is still to come" } } });
    const { askCommand } = await workspace();
    await expect(askCommand(command)).resolves.toEqual({ refusal: "not yet — that day is still to come", preview: null });
  });

  it("answers null when the server cannot be heard, a failed call or a network error", async () => {
    const { askCommand } = await workspace();
    answers.push({ status: 503, body: { error: "maintenance_active" } });
    await expect(askCommand(command)).resolves.toBeNull();
    await expect(askCommand(command)).resolves.toBeNull(); // nothing queued: fetch throws
  });

  it("is what checkCommand reads: checkCommand still answers a string or null", async () => {
    const { checkCommand } = await workspace();
    answers.push({ status: 200, body: { preview: { nextDate: "2027-10-10" } } });
    await expect(checkCommand(command)).resolves.toBeNull();
    answers.push({ status: 200, body: { refusal: { code: "x", message: "not yet — words" } } });
    await expect(checkCommand(command)).resolves.toBe("not yet — words");
    answers.push({ status: 503, body: {} });
    await expect(checkCommand(command)).resolves.toBeNull();
  });
});

describe("the dry-run runner hands on whatever its check answers", () => {
  it("passes the answer object to onanswer untouched", async () => {
    const answer = { refusal: null, preview: { nextDate: "2027-10-10" } };
    const heard = [];
    await dryRunner({ onanswer: (one) => heard.push(one), check: async () => answer }).now(() => ({}));
    expect(heard).toEqual([answer]);
  });
});

describe("the repeat options say what they are, not a date", () => {
  it("reads \"once\" under the first and \"from when it's done\" under the rest", () => {
    const notes = periodChoices(12).map((choice) => choice.note);
    expect(notes).toEqual(["once", ...Array(5).fill("from when it's done")]);
  });

  it("gives the same to a non-standard period slotted in", () => {
    expect(periodChoices(2).find((choice) => choice.value === "2")?.note).toBe("from when it's done");
  });

  it("the band speaks the words alone", () => {
    const band = read("lib/editing/RepeatBand.svelte");
    expect(band).toMatch(/const spoken = \(choice\) => choice\.words;/u);
  });
});

describe("the drawer's modes keep the engine's preview for the completion", () => {
  const modes = read("routes/home/drawer-modes.svelte.js");

  it("holds preview as state, empty to begin with", () => {
    expect(modes).toMatch(/preview = \$state\(null\)/u);
  });

  it("asks through askCommand, sets preview from nextDate and clears it when no date comes", () => {
    expect(modes).toMatch(/dryRunner\(\{[\s\S]*?check: askCommand/u);
    expect(modes).toMatch(/this\.preview = [^;]*nextDate/u);
  });

  it("builds the question from the date alone: completeCommand with completedDate only", () => {
    expect(modes).toMatch(/completeCommand\([^)]*\{ completedDate[^}]*\}\)/u);
    expect(modes).not.toMatch(/completeCommand\([^)]*(cost|notes)/u);
  });

  it("an effect on the completion's id and date clears the line at once and asks after the pause", () => {
    expect(modes).toMatch(/\$effect\(/u);
    expect(modes).toMatch(/completing\?\.id/u);
    expect(modes).toMatch(/completing\?\.completedDate/u);
    expect(modes).toMatch(/this\.preview = null/u);
    expect(modes).toMatch(/\.ask\(/u);
    expect(modes).toMatch(/\.now\(/u);
  });

  it("cancelComplete clears the preview", () => {
    expect(modes).toMatch(/cancelComplete\(\) \{[\s\S]*?this\.preview = null/u);
  });
});

describe("the foot row shows \"then <date>\" under record and cancel", () => {
  const foot = read("routes/home/FootRow.svelte");

  it("has a status line after cancel inside the completing group, and record points at it", () => {
    expect(foot).toMatch(/<span class="then" id=\{thenId\} role="status" aria-live="polite" aria-atomic="true">/u);
    expect(foot).toMatch(/\{#if thenWords\}then <b>\{thenWords\}<\/b>\{\/if\}/u);
    expect(foot).toMatch(/aria-describedby=\{thenWords \? thenId : undefined\}/u);
    const group = foot.match(/aria-label="Completing \{title\}">([\s\S]*?)\n    <\/div>/u)?.[1] ?? "";
    expect(group.indexOf("record")).toBeLessThan(group.indexOf("class=\"then\""));
    expect(group.indexOf("cancel")).toBeLessThan(group.indexOf("class=\"then\""));
  });

  it("says the date as dayMonthYear does", () => {
    expect(foot).toMatch(/dayMonthYear/u);
  });

  it("is plain text on its own line, the desk's mono 11.5px and the phone's meta size", () => {
    expect(foot).toMatch(/\.ivacts \.then\{flex-basis:100%;text-align:center;min-height:1\.6em;font:11\.5px\/1\.6 var\(--mono\);color:var\(--ink-mid\)\}/u);
    expect(foot).toMatch(/\.ivacts \.then b\{font-weight:500;color:var\(--ink\)\}/u);
    expect(foot).toMatch(/\.ivfootrow\.pocket \.ivacts \.then\{font:var\(--p-type-meta\)\/1\.4 var\(--mono\)\}/u);
  });

  it("both screens' drawers hand it the modes' preview", () => {
    for (const file of ["routes/home/ItemView.svelte", "routes/home/ItemDrawer.svelte"]) {
      expect(read(file), file).toMatch(/then=\{acts\.modes\.preview\}/u);
    }
  });
});
