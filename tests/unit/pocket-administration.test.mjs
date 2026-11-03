// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { fixtureApi } from "../support/fixture-api.mjs";
import { createPageLoader, runtime } from "../support/svelte-page.mjs";
import { subscribeWake } from "$lib/pocket/wake.js";

/*
 * ADMINISTRATION ON A PHONE (#1123, proposal §2.12 and §2.11; owner decisions
 * §25 and §19; review round §1.1, §2.6), mounted in happy-dom over the
 * fixtures instance's own answers (#1613, ADR-0039). The fixtures instance
 * answers people, systems and the mockup's machinery rows; the states it
 * cannot reach (a system on the clock, document jobs, alerts) are given here
 * as the routes would answer them, as the rig's spec did.
 *   · a tap opens a row's acts in place, and they are real named buttons
 *   · a system on the clock keeps `restore` on show; `delete now` sits in
 *     its opened row and wakes only for the name typed exactly
 *   · a failed document job says why, and offers retry, with no interaction
 *   · alerts stand first; the jump strip is plain links, not tabs
 *
 * A command that landed and only the re-read after it failed (#1584 web-admin-1)
 * is run on the page: the workspace read fails once the first load is in, and
 * the page must say done, keep its undo, and never say "not deleted". The act
 * itself is also proved at the act level (administration-landed-then-reread.test.mjs,
 * "disable and hard delete"), which uses stand-ins for the card and the system.
 */

vi.mock("$lib/backdrops/station.js", () => ({ mountStation: () => () => {} }));

const PAGE = "routes/administration/+page.svelte";
const NOW = Date.parse("2026-08-13T12:00:00.000Z");
const at = (/** @type {number} */ minutes) => new Date(NOW - minutes * 60000).toISOString();
const ahead = (/** @type {number} */ days) => new Date(NOW + days * 86400000).toISOString();
const JOBS = [
  { id: "f1", kind: "scan", status: "failed", attempts: 5, lastErrorCode: "scanner_unavailable", nextAttemptAt: null, createdAt: at(40), updatedAt: at(6) },
  { id: "d1", kind: "encrypt", status: "completed", attempts: 1, lastErrorCode: null, nextAttemptAt: null, createdAt: at(90), updatedAt: at(88) },
];

describe("administration on a phone, mounted", () => {
  const loader = createPageLoader("pocket-administration", {
    stub: (file) => /\/lib\/Chrome\.svelte$/.test(file),
  });
  beforeAll(() => loader.setup(PAGE));
  afterAll(() => loader.teardown());
  /** @type {(() => void) | null} */
  let stopWatching = null;
  afterEach(() => { loader.unmount(); stopWatching?.(); stopWatching = null; vi.unstubAllGlobals(); });

  /**
   * @param {{ alerts?: boolean, overrides?: Parameters<typeof fixtureApi>[0] }} [options]
   */
  async function mountAdmin({ alerts = false, overrides = {} } = {}) {
    /** Set once the page has loaded: from then on the workspace read fails, as an aborted request does. */
    const reread = { fails: false };
    const api = fixtureApi({
      "GET /api/admin/operations": () => ({ operations: { documentJobs: JOBS, documentJobCounts: {} } }),
      /* the one thing the fixtures instance cannot say: a system on the clock */
      "GET /api/workspace": async () => {
        if (reread.fails) throw new TypeError("Failed to fetch");
        const { WORKSPACE_FIXTURE, WORKSPACE_FIXTURE_TODAY } = await import("$lib/data/fixtures/workspace.js");
        const workspace = structuredClone(WORKSPACE_FIXTURE);
        /** @type {any} */ (workspace).recoverableHouseholds = [{ id: "hh-gone-1", name: "Aunt May’s Cottage", deleteAfter: ahead(13) }];
        return { workspace, fixtureToday: WORKSPACE_FIXTURE_TODAY };
      },
      ...(alerts ? { "GET /api/admin/recovery-bundle": () => ({ recoveryBundle: { exported: false, exportedAt: null } }) } : {}),
      /* the fixtures instance has no database to write to: the writes are answered */
      "PATCH /api/admin/users": () => ({ ok: true }),
      ...overrides,
    });
    vi.stubGlobal("fetch", api.fetch);
    vi.stubGlobal("matchMedia", (/** @type {string} */ query) => ({
      matches: true, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
    /** @type {string[]} */
    const wakes = [];
    /** @type {import("$lib/pocket/wake.js").WakeEntry[]} */
    const entries = [];
    /* subscribing replays the wake standing now (a previous test's, held 4 s): not this one's */
    let replay = true;
    stopWatching = subscribeWake((entry) => {
      if (replay) { replay = false; return; }
      if (entry) { wakes.push(entry.message); entries.push(entry); }
    });
    await loader.mount(PAGE, { data: { fixtures: true } });
    const { flushSync } = await runtime();
    /** Lets promises and timers at zero run, then draws what they changed. */
    const settle = async () => { await new Promise((done) => setTimeout(done, 0)); flushSync(); };
    await vi.waitFor(() => expect(document.querySelector(".ad-pocket [data-ad=people] .p-row")).not.toBeNull());
    await settle();
    return { api, wakes, entries, reread, settle };
  }

  const $ = (/** @type {string} */ selector, /** @type {ParentNode} */ scope = document) =>
    /** @type {HTMLElement} */ (scope.querySelector(selector));
  const $$ = (/** @type {string} */ selector, /** @type {ParentNode} */ scope = document) =>
    /** @type {HTMLElement[]} */ ([...scope.querySelectorAll(selector)]);
  /** A row of a card, by text. */
  const row = (/** @type {string} */ scope, /** @type {string} */ text) => /** @type {HTMLElement} */ (
    $$(`.ad-pocket ${scope} .p-row`).find((el) => el.textContent?.includes(text)));
  /** A button or link by its accessible name (aria-label, else its text). */
  const control = (/** @type {string} */ name, /** @type {ParentNode} */ scope = document) =>
    $$("button, a", scope).find((el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim() === name) ?? null;
  const reachable = (/** @type {Element | null} */ el) => Boolean(el) && !el?.closest("[hidden]");
  const click = (/** @type {HTMLElement | null} */ el) => { if (!el) throw new Error("no such control"); el.click(); };
  const open = async (/** @type {HTMLElement} */ one, /** @type {() => Promise<void>} */ settle) => {
    click($("[data-row-face]", one));
    await settle();
  };
  /** A dialog by a part of its title. */
  const dialog = (/** @type {string} */ title) => $$('[role="dialog"]').find((el) => el.textContent?.includes(title)) ?? null;
  const labelled = (/** @type {ParentNode} */ scope, /** @type {RegExp} */ text) => /** @type {HTMLInputElement} */ (
    document.getElementById($$("label", scope).find((el) => text.test(el.textContent ?? ""))?.getAttribute("for") ?? ""));
  const text = (/** @type {Element} */ el) => (el.textContent ?? "").replace(/\s+/gu, " ").trim();

  it("a tap opens a person's row, naming its acts; your own row has none", async () => {
    const { settle } = await mountAdmin();
    /* At rest every row is shut: its acts are hidden, out of the page. */
    expect($$(".ad-pocket [data-row-panel]").filter((el) => !el.hidden)).toHaveLength(0);
    expect(reachable(control("Disable Emma Harlow"))).toBe(false);
    const emma = row("[data-ad=people]", "Emma Harlow");
    await open(emma, settle);
    for (const name of ["Place Emma Harlow in a system", "Send Emma Harlow a new setup link", "Disable Emma Harlow"]) {
      expect(reachable(control(name, emma)), name).toBe(true);
    }
    /* Your own row has none. */
    expect(row("[data-ad=people]", "· you").querySelector("[data-row-acts]")).toBeNull();
  });

  it("disable arms before it fires", async () => {
    const { api, wakes, settle } = await mountAdmin();
    const emma = row("[data-ad=people]", "Emma Harlow");
    await open(emma, settle);
    click(control("Disable Emma Harlow", emma));
    await settle();
    expect(control("tap again to disable Emma Harlow", emma)).not.toBeNull();
    expect(api.calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
    click(control("tap again to disable Emma Harlow", emma));
    await vi.waitFor(() => expect(wakes.some((words) => words.includes("Emma Harlow is disabled"))).toBe(true));
    expect(api.calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
  });

  it("a system on the clock keeps restore on show; delete now sits in its opened row", async () => {
    const { settle } = await mountAdmin();
    const clock = row("[data-ad=systems]", "Aunt May");
    /* Round 3 §3.9: the meta is the state and the days; the date is the panel's. */
    expect(text($(".meta", clock))).toBe("deleted · 13 days left");
    expect(reachable(control("Restore Aunt May’s Cottage"))).toBe(true);
    expect(reachable(control("Delete Aunt May’s Cottage now, for good"))).toBe(false);

    await open(clock, settle);
    expect(text($("[data-row-panel] .p-kv", clock))).toMatch(/gone for good\s*26 Aug/);
    click(control("Delete Aunt May’s Cottage now, for good", clock));
    await settle();
    click(control("tap again to delete Aunt May’s Cottage now, for good", clock));
    await settle();
    const sheet = /** @type {HTMLElement} */ (dialog("Delete Aunt May’s Cottage now"));
    expect(sheet).not.toBeNull();
    expect(text(sheet)).toContain("Nothing comes back after this");
    /* the button is dead until the name is typed exactly */
    expect($$("button", sheet).some((el) => el.disabled && text(el) === "delete for good")).toBe(true);
    expect(sheet.querySelector("button.arm")).toBeNull();
    const typed = labelled(sheet, /type the system’s name exactly/i);
    typed.value = "Aunt May’s Cottage";
    typed.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect($$("button", sheet).some((el) => el.disabled && /delete for good/.test(el.textContent ?? ""))).toBe(false);
    expect($("button.arm", sheet)).not.toBeNull();
  });

  /*
   * #1584 web-admin-1: the command lands and only the re-read after it fails.
   * The act is done and must be said so, never as a refusal.
   */
  it("a disable whose re-read fails still says disabled, keeps its undo, and says done on the card", async () => {
    const { entries, reread, settle } = await mountAdmin();
    reread.fails = true;
    const emma = row("[data-ad=people]", "Emma Harlow");
    await open(emma, settle);
    click(control("Disable Emma Harlow", emma));
    await settle();
    click(control("tap again to disable Emma Harlow", emma));
    await vi.waitFor(() => expect($("[data-ad=people] .p-error")).not.toBeNull());
    const card = text($("[data-ad=people] .p-error"));
    expect(card).toContain("done —");
    expect(card).toContain("reload");
    const said = entries.find((entry) => entry.message.includes("Emma Harlow is disabled"));
    expect(said, "the wake says it is disabled").toBeDefined();
    expect(typeof said?.undo, "and keeps its undo").toBe("function");
    expect(entries.filter((entry) => entry.failure)).toHaveLength(0);
  });

  it("a delete-now whose re-read fails closes the sheet, replaces the row and says done", async () => {
    const { entries, reread, settle } = await mountAdmin({
      overrides: { "POST /api/households/hh-gone-1/lifecycle": () => ({ ok: true }) },
    });
    reread.fails = true;
    const clock = row("[data-ad=systems]", "Aunt May");
    await open(clock, settle);
    click(control("Delete Aunt May’s Cottage now, for good", clock));
    await settle();
    click(control("tap again to delete Aunt May’s Cottage now, for good", clock));
    await settle();
    const sheet = /** @type {HTMLElement} */ (dialog("Delete Aunt May’s Cottage now"));
    const typed = labelled(sheet, /type the system’s name exactly/i);
    typed.value = "Aunt May’s Cottage";
    typed.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    /* the sheet's button is an ArmButton: the first tap arms it, the second fires */
    click($("button.arm", sheet));
    await settle();
    expect($("button.arm", sheet).classList.contains("armed")).toBe(true);
    click($("button.arm", sheet));

    await vi.waitFor(() => expect($("[data-ad=systems] .ad-said.ok")).not.toBeNull());
    expect(dialog("Delete Aunt May’s Cottage now")?.closest(".p-sheet-layer.open") ?? null).toBeNull();
    const said = text($("[data-ad=systems] .ad-said.ok"));
    expect(said).toContain("Aunt May’s Cottage is gone for good");
    expect(said).toContain("reload");
    expect(control("Restore Aunt May’s Cottage")).toBeNull();
    expect(entries.some((entry) => entry.message.includes("done —"))).toBe(true);
    expect(document.body.textContent).not.toContain("not deleted");
  });

  it("a failed document job says why and offers retry, with no interaction", async () => {
    const { settle } = await mountAdmin();
    const card = $(".ad-pocket [data-ad=documents]");
    const failed = $$(".p-row", card).find((el) => /failed/i.test(el.textContent ?? "")) ?? null;
    expect(failed).not.toBeNull();
    expect(text(/** @type {HTMLElement} */ (failed))).toContain("Virus scan");
    /* Round 3 §3.9 and §8: the reason alone at rest; the tries and when it was last tried are the panel's. */
    expect(text($(".meta", /** @type {HTMLElement} */ (failed)))).toBe("couldn’t reach the scanner");
    expect(reachable(control("Retry the virus scan"))).toBe(true);
    await open(/** @type {HTMLElement} */ (failed), settle);
    const kvs = $$("[data-row-panel] .p-kv", /** @type {HTMLElement} */ (failed)).map(text);
    expect(kvs[0]).toMatch(/tries\s*5/);
    expect(kvs[1]).toMatch(/last tried\s*6m ago/);
    /* Kind only, never a document's name (owner, 2026-09-19); one retry, on the failed row only. */
    expect($$("button", card).filter((el) => /^Retry/.test(el.getAttribute("aria-label") ?? ""))).toHaveLength(1);
    /* And it is told at the top of the page. */
    const tell = $$(".ad-pocket .ad-tells a").find((el) => el.textContent?.includes("1 job failed"));
    expect(tell?.getAttribute("href")).toBe("#ad-documents");
  });

  it("a row's meta is its data alone; the rest is the panel's first line", async () => {
    const { settle } = await mountAdmin();
    expect(text($(".ad-pocket .ad-sub"))).toBe("5 people · 5 systems");
    /* People: the email alone at rest; the systems they are in, once opened. */
    const emma = row("[data-ad=people]", "Emma Harlow");
    expect(text($(".meta", emma))).not.toContain("·");
    expect(text($(".meta", emma))).not.toContain("system");
    await open(emma, settle);
    expect(text($("[data-row-panel] .p-kv", emma))).toBe("owns 2 systems");
    /* Systems: members and items at rest; the owner, once opened. */
    const harlow = row("[data-ad=systems]", "Harlow Home");
    expect(text($(".meta", harlow))).toMatch(/^\d+ members? · \d+ items?$/);
    await open(harlow, settle);
    expect(text($("[data-row-panel] .p-kv", harlow))).toMatch(/owner\s*Ned Harlow/);
    /* The public contact carries no sentence at rest. (The rotate row's twin on
       the rig matched no row under the fixtures instance, which has no mailbox
       configured, so it asserted nothing and is not carried.) */
    expect($$(".ad-pocket [data-ad=contact] .p-row .meta")).toHaveLength(0);
    /* The jobs card has no foot, and the version is one line with no promise (10b). */
    expect(text($(".ad-pocket [data-ad=documents]"))).not.toContain("most recently");
    expect(text($(".ad-pocket .ad-strip"))).toBe("ORBIT 1.3.0 · PREVIEW · FD6A7E6");
  });

  it("alerts stand first, and the jump strip is links, not tabs", async () => {
    const { settle } = await mountAdmin({ alerts: true });
    const first = $(".ad-pocket main > section, .ad-pocket main > .ad-alerts");
    expect(first.getAttribute("data-ad")).toBe("alerts");
    expect(text(first)).toContain("No recovery bundle exported");
    click(control("what to do", first));
    await settle();
    expect(text(/** @type {HTMLElement} */ (dialog("No recovery bundle exported")))).toContain("scripts/export-recovery-bundle.sh");

    const strip = $('nav[aria-label="Jump to a card"]');
    expect($$('[role="tab"]', strip)).toHaveLength(0);
    for (const [word, id] of [["people", "ad-people"], ["systems", "ad-systems"], ["documents", "ad-documents"]]) {
      expect(control(word, strip)?.getAttribute("href")).toBe(`#${id}`);
    }
  });

  it("invite someone is a sheet, and never shows a link", async () => {
    const { settle } = await mountAdmin();
    click(control("invite someone"));
    await settle();
    const sheet = /** @type {HTMLElement} */ (dialog("Invite someone"));
    expect(sheet).not.toBeNull();
    expect(labelled(sheet, /^email/)).not.toBeNull();
    expect(labelled(sheet, /^display name/)).not.toBeNull();
    click(control("One day more", sheet));
    await settle();
    expect(text($("output", sheet))).toBe("8 days");
    expect(text(sheet)).toContain("The link is never shown here.");
    expect(sheet.querySelector("a[href*='setup']")).toBeNull();
  });
});
