import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * #1651, with the ratified override from design/v19/mail-setup/round-1/
 * j-one-card.html and note 54742: the button's words are `fetch now`, it is
 * the FIRST button of the Mailbox half's button row on the one Mail card,
 * before `change mailbox…`, not beside the poll interval. Source text, like
 * administration-mail-card-1629.test.mjs. The wire is
 * `{ action: "fetch_now" }` on /api/admin/mailbox.
 *
 * Words chosen here for the three refusals (the builder keeps them):
 * "a check is already running", "ingest is paused", "no mailbox is set up yet".
 * The outcome line says "messages read" and "receipts recorded", then the
 * reasons: sender unverified, unattributed, held, provider unavailable.
 */
const dir = new URL("../../web/src/routes/administration/", import.meta.url);
const page = readFileSync(new URL("+page.svelte", dir), "utf8");
const pocket = readFileSync(new URL("pocket.svelte", dir), "utf8");
const all = readdirSync(dir)
  .filter((name) => /\.(svelte|js)$/u.test(name) && !name.includes("server"))
  .map((name) => readFileSync(new URL(name, dir), "utf8"))
  .join("\n");
const flat = all.replace(/\s+/gu, " ");
const tick = "(?:'|’|&rsquo;|&#39;)";

const label = /(?:>\s*|["'`]\s*)fetch now\s*(?:<|["'`])/u;

/** The whole <button …> element text that carries the `fetch now` label. */
function fetchButton(text) {
  const at = text.search(label);
  if (at < 0) return null;
  const start = text.lastIndexOf("<button", at);
  return { start, at, open: text.slice(start, at + 20) };
}

describe("the fetch now button (#1651)", () => {
  for (const [name, text, row] of [["desk", page, /class="placerow mailboxrow"/u], ["phone", pocket, /class="p-pills"/u]]) {
    it(`is the first button in the Mailbox button row, before change mailbox, on the ${name}`, () => {
      const found = fetchButton(text);
      expect(found, "a button labelled fetch now").not.toBeNull();
      const change = text.search(/>\s*change mailbox/u);
      expect(change).toBeGreaterThan(-1);
      expect(found.at).toBeLessThan(change);
      /* Same row: no row closed between the two, and the row opens before fetch now. */
      expect(text.slice(found.start, change)).not.toMatch(/<\/div>/u);
      const rowStart = Math.max(...[...text.slice(0, found.start).matchAll(new RegExp(row.source, "gu"))].map((m) => m.index));
      expect(rowStart).toBeGreaterThan(-1);
      expect(text.slice(rowStart, found.start)).not.toMatch(/<button/u);
    });

    it(`is disabled by a condition, on the ${name}`, () => {
      expect(fetchButton(text).open).toMatch(/disabled=\{/u);
    });

    it(`shows the three refusal reasons in words, on the ${name}`, () => {
      const words = (text === page ? page : pocket).replace(/\s+/gu, " ") + flat;
      expect(words).toMatch(/a check is already running/u);
      expect(words).toMatch(/ingest is paused/u);
      expect(words).toMatch(new RegExp(`no mailbox is set up yet|the mailbox isn${tick}t set up yet`, "u"));
    });

    it(`sends the action and shows the outcome inline, on the ${name}`, () => {
      expect(text).toMatch(/["'`]fetch_now["'`]/u);
      expect(text.replace(/\s+/gu, " ")).toMatch(/fetchNow|fetch_now|fetched/u);
    });
  }

  it("is not placed beside the poll interval", () => {
    for (const text of [page, pocket]) {
      const found = fetchButton(text);
      const nearby = text.slice(Math.max(0, found.start - 400), found.start + 400);
      expect(nearby).not.toMatch(/poll ?(?:interval|seconds)/iu);
    }
  });

  it("reports messages read and receipts recorded, then the four reasons the log event carries", () => {
    expect(flat).toMatch(/messages? read/u);
    expect(flat).toMatch(/receipts? recorded/u);
    for (const reason of ["sender unverified", "unattributed", "held", "provider unavailable"]) {
      expect(flat, reason).toContain(reason);
    }
  });

  it("has no \"another change is in progress\" reason any more (#1651 review 6)", () => {
    expect(flat).not.toMatch(/another change is in progress/u);
  });

  it("disables the button with \"a check is already running\" when the mailbox view says a check is running at load, on both layouts", () => {
    expect(flat).toMatch(/checkRunning/u);
    for (const [name, text] of [["desk", page], ["phone", pocket]]) {
      const open = fetchButton(text).open;
      expect(open, name).toMatch(/disabled=\{/u);
    }
    expect(flat).toMatch(/checkRunning[^;]{0,200}a check is already running|a check is already running[^;]{0,200}checkRunning/u);
  });

  it("shows \"fetching…\" and no refusal text during its own press, on both layouts", () => {
    for (const [name, text] of [["desk", page], ["phone", pocket]]) {
      expect(text.replace(/\s+/gu, " "), name).toMatch(/fetching(?:…|&hellip;|\.\.\.)/u);
    }
    /* A press in flight is not a refusal: "a check is already running" must not be the pressed-state words. */
    expect(flat).not.toMatch(/busy === ["']fetch["'] \? ["']a check is already running["']/u);
  });

  it("says \"not checked\" with a plain reason when the check skipped its work", () => {
    expect(flat).toMatch(/not checked/u);
    expect(flat).toMatch(new RegExp(`the (?:encryption )?key isn${tick}t available|the key is not available`, "u"));
    expect(flat).toMatch(/DKIM DNS servers? setting (?:is|looks) (?:malformed|invalid)|MAIL_IN_DKIM_DNS_SERVERS (?:is|looks) (?:malformed|invalid)/u);
  });

  it("says the mailbox password can't be opened when the credential is locked", () => {
    expect(flat).toMatch(new RegExp(`the mailbox password can${tick}t be opened`, "u"));
    expect(flat).toMatch(/credential_locked/u);
  });

  it("goes through /api/admin/mailbox with the fetch_now action", () => {
    const workspace = readFileSync(new URL("../../web/src/lib/data/workspace.js", import.meta.url), "utf8");
    expect(`${all}\n${workspace}`).toMatch(/["'`]\/api\/admin\/mailbox["'`]/u);
    expect(all).toMatch(/action:\s*["'`]fetch_now["'`]/u);
  });
});
