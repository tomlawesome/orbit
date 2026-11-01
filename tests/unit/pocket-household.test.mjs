// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { fixtureApi, jsonResponse } from "../support/fixture-api.mjs";
import { createPageLoader, runtime } from "../support/svelte-page.mjs";
import { readHouseholdScreen } from "$lib/data/workspace.js";
import { tabbables } from "$lib/pocket/focus.js";

// The household on a phone (#1122, design/v19/phone-vision/proposal.md §2.10):
// what the rising save bar counts (owner decision 2b), the list moves it
// collects, home's chip carried onto the page, and the archive card's rules.
import { changesLabel, changesOf, chipBodyOf, commandsFor, moved } from "../../web/src/routes/household/[id]/edits.js";
import {
  archiveFileProblem, passphraseProblem,
} from "../../web/src/routes/household/[id]/archive.js";
import { sizeLabel } from "../../web/src/lib/format.js";

const identity = { name: "Harlow Home", timezone: "Europe/London", currency: "GBP" };
const sections = [
  { id: "s-home", name: "Home", icon: "home", visible: true },
  { id: "s-car", name: "Vehicles", icon: "vehicle", visible: true },
  { id: "s-dates", name: "Dates", icon: "hook", visible: true },
];
const saved = { identity, sections };
/** @param {Partial<typeof saved>} over */
const local = (over = {}) => ({ identity: { ...identity }, sections: sections.map((row) => ({ ...row })), ...over });

describe("the save bar's changes (2b)", () => {
  it("counts nothing when nothing moved, so the bar stays down", () => {
    expect(changesOf(saved, local())).toEqual([]);
  });

  it("counts each field of the system once, ignoring edge spaces on the name", () => {
    expect(changesOf(saved, local({ identity: { ...identity, name: " Harlow Home " } }))).toEqual([]);
    expect(changesOf(saved, local({ identity: { name: "Home", timezone: "UTC", currency: "EUR" } })))
      .toEqual(["name", "timezone", "currency"]);
  });

  it("counts a section once however many of its parts changed", () => {
    const rows = local().sections;
    rows[0].visible = false;
    rows[0].name = "House";
    expect(changesOf(saved, local({ sections: rows }))).toEqual(["edit s-home"]);
  });

  it("counts an added section, and a removed one, and forgets a section added then removed", () => {
    const rows = [...local().sections, { id: "new", name: "Pets", icon: "kite", visible: true, fresh: true }];
    rows[2].removed = true;
    expect(changesOf(saved, local({ sections: rows }))).toEqual(["remove s-dates", "add new"]);
    rows[3].removed = true;
    expect(changesOf(saved, local({ sections: rows }))).toEqual(["remove s-dates"]);
  });

  it("counts a reorder once, however many rows moved", () => {
    const rows = local().sections;
    expect(changesOf(saved, local({ sections: [rows[2], rows[0], rows[1]] }))).toEqual(["order"]);
  });

  it("does not call removing a row a reorder", () => {
    const rows = local().sections;
    rows[1].removed = true;
    expect(changesOf(saved, local({ sections: [rows[0], rows[2], rows[1]] }))).toEqual(["remove s-car"]);
  });

  it("sends only the commands that changed", () => {
    expect(commandsFor(["name"])).toEqual({ identity: true, sections: false });
    expect(commandsFor(["order"])).toEqual({ identity: false, sections: true });
    expect(commandsFor(["currency", "add x"])).toEqual({ identity: true, sections: true });
  });

  it("says the count in words", () => {
    expect(changesLabel(1)).toBe("1 change");
    expect(changesLabel(3)).toBe("3 changes");
  });
});

describe("long-press reorder", () => {
  it("moves a row and leaves the original list alone", () => {
    const list = ["a", "b", "c", "d"];
    expect(moved(list, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moved(list, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(list).toEqual(["a", "b", "c", "d"]);
  });

  it("gives the same list back for a move off either end", () => {
    const list = ["a", "b"];
    expect(moved(list, 0, -1)).toBe(list);
    expect(moved(list, 1, 2)).toBe(list);
  });
});

describe("home's chip, carried onto the page", () => {
  it("places the body at the angle the id fixes, on the given radius", () => {
    expect(chipBodyOf(0, 10)).toEqual({ x: 10, y: 0 });
    const quarter = chipBodyOf(0xffffffff / 4, 10);
    expect(quarter.x).toBeCloseTo(0, 1);
    expect(quarter.y).toBeCloseTo(10, 1);
  });
});

// The engine's numbers as the session carries them (#1336); the card holds none.
const LIMITS = { archiveFileBytes: 179_022_508, passphraseMin: 12, passphraseMax: 256 };

describe("the archive card", () => {
  it("asks for the engine's passphrase length and the same passphrase twice", () => {
    expect(passphraseProblem("short", "short", LIMITS)).toMatch(/at least 12/);
    expect(passphraseProblem("correct horse battery", "correct horse", LIMITS)).toMatch(/not the same/);
    expect(passphraseProblem("x".repeat(257), "x".repeat(257), LIMITS)).toMatch(/at most 256/);
    expect(passphraseProblem("correct horse battery", "correct horse battery", LIMITS)).toBeNull();
    expect(passphraseProblem("short", "short", { ...LIMITS, passphraseMin: 20 })).toMatch(/at least 20/);
  });

  it("counts the floor in code points, as the engine does", () => {
    // Six emoji are twelve UTF-16 units but six characters.
    expect(passphraseProblem("😀".repeat(6), "😀".repeat(6), LIMITS)).toMatch(/at least 12/);
    expect(passphraseProblem("😀".repeat(12), "😀".repeat(12), LIMITS)).toBeNull();
  });

  it("refuses a passphrase while the engine's bounds are unknown", () => {
    expect(passphraseProblem("correct horse battery", "correct horse battery", null)).toMatch(/reload/);
  });

  it("refuses an empty or oversized file before reading it", () => {
    expect(archiveFileProblem({ size: 0 }, LIMITS)).toMatch(/empty/);
    expect(archiveFileProblem({ size: LIMITS.archiveFileBytes + 1 }, LIMITS)).toMatch(/larger than 170.7 MB/);
    expect(archiveFileProblem({ size: 130_000_000 }, LIMITS)).toBeNull();
    expect(archiveFileProblem({ size: 2048 }, LIMITS)).toBeNull();
    // No ceiling from the engine: only the empty check is the card's own.
    expect(archiveFileProblem({ size: 2048 }, null)).toBeNull();
  });

  it("prints sizes the way a person reads them", () => {
    expect(sizeLabel(33)).toBe("33 B");
    expect(sizeLabel(84 * 1024)).toBe("84 KB");
    expect(sizeLabel(3.2 * 1024 * 1024)).toBe("3.2 MB");
    expect(sizeLabel(38 * 1024 * 1024)).toBe("38.0 MB");
  });
});

/*
 * THE HOUSEHOLD PAGE ON A PHONE, MOUNTED (#1613, ADR-0039): the real page in
 * happy-dom over the fixtures instance's own answers (a fetch stand-in built
 * from web/src/lib/data/fixtures), so what the rows show, what their acts are
 * called and what the save bar counts are proved without a browser. A real
 * Enter/Tab/Escape walk of a row stays in web/tests/fidelity/pocket-household.spec.js.
 */
vi.mock("$lib/tour/watch.js", () => ({ watchTour: () => () => {} }));

describe("the household page on a phone, mounted", () => {
  const PAGE = "routes/household/[id]/+page.svelte";
  const loader = createPageLoader("pocket-household", {
    stub: (file) => /\/lib\/(Chrome|pocket\/Sky|pocket\/NorthStar)\.svelte$/.test(file),
  });
  beforeAll(() => loader.setup(PAGE));
  afterAll(() => loader.teardown());
  afterEach(() => { loader.unmount(); vi.unstubAllGlobals(); });

  /** @param {Parameters<typeof fixtureApi>[0]} [overrides] */
  async function mountHousehold(overrides) {
    const api = fixtureApi(overrides);
    vi.stubGlobal("fetch", api.fetch);
    /* the phone: the pocket dialect's media query matches */
    vi.stubGlobal("matchMedia", (/** @type {string} */ query) => ({
      matches: true, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
    const household = await readHouseholdScreen("hh-harlow-1");
    await loader.mount(PAGE, { data: { household } });
    const { flushSync } = await runtime();
    /** Lets promises and timers at zero run, then draws what they changed. */
    const settle = async () => { await new Promise((done) => setTimeout(done, 0)); flushSync(); };
    await settle();
    return { api, flushSync, settle };
  }

  const $ = (/** @type {string} */ selector, /** @type {ParentNode} */ scope = document) =>
    /** @type {HTMLElement} */ (scope.querySelector(selector));
  /** A row of a list, by text. */
  const row = (/** @type {string} */ list, /** @type {string} */ text) => /** @type {HTMLElement} */ (
    [...document.querySelectorAll(`.hh-pocket ${list} [data-row]`)].find((el) => el.textContent?.includes(text)));
  /** The act of the document with this accessible name, if drawn. */
  const act = (/** @type {string} */ name, /** @type {ParentNode} */ scope = document) =>
    [...scope.querySelectorAll("button, a")].find((el) => el.getAttribute("aria-label") === name) ?? null;
  const reachable = (/** @type {Element | null} */ el) => Boolean(el) && !el?.closest("[hidden]");
  const bar = () => $("[data-hh=savebar]");
  const barUp = () => bar().classList.contains("up");

  it("draws every row shut: panels hidden, no act in the accessible tree or the Tab order", async () => {
    await mountHousehold();
    const panels = [...document.querySelectorAll(".hh-pocket [data-row-panel]")];
    expect(panels.length).toBeGreaterThan(0);
    expect(panels.every((panel) => /** @type {HTMLElement} */ (panel).hidden), "a row's panel is open without a tap").toBe(true);
    for (const name of [
      "Remove Emma Harlow", "Hand Harlow Home over to Gran", "Leave Harlow Home",
      "Withdraw the invitation to daniel.harlow@example.com", "Remove Services",
    ]) expect(reachable(act(name)), name).toBe(false);
    /* a Tab through a shut list reaches the faces and never an act */
    const stops = tabbables($(".hh-pocket"));
    expect(stops.length).toBeGreaterThan(0);
    expect(stops.filter((el) => el.closest("[data-row-acts]"))).toEqual([]);
  });

  it("opens a member's row on a tap, and only that row's acts show", async () => {
    const { flushSync } = await mountHousehold();
    const emma = row(".hh-members", "Emma Harlow");
    $("[data-row-face]", emma).click();
    flushSync();
    expect(emma.hasAttribute("data-open")).toBe(true);
    expect(reachable(act("Hand Harlow Home over to Emma Harlow", emma))).toBe(true);
    expect(reachable(act("Remove Emma Harlow", emma))).toBe(true);
    expect(row(".hh-members", "Rob Harlow").hasAttribute("data-open")).toBe(false);
    expect(reachable(act("Remove Rob Harlow"))).toBe(false);
  });

  it("puts an invitation's resend and withdraw in its opened row", async () => {
    const { flushSync } = await mountHousehold();
    const invite = row(".hh-members", "daniel.harlow@example.com");
    $("[data-row-face]", invite).click();
    flushSync();
    expect(invite.hasAttribute("data-open")).toBe(true);
    expect(reachable(act("Resend the invitation to daniel.harlow@example.com", invite))).toBe(true);
    expect(reachable(act("Withdraw the invitation to daniel.harlow@example.com", invite))).toBe(true);
  });

  it("keeps a knock's approve and decline on show, with no tap", async () => {
    await mountHousehold({
      "GET /api/join-requests": () => ({
        requests: [{ id: "jr-1", householdId: "hh-harlow-1", userId: "u-ben", displayName: "Ben Harlow", createdAt: "2026-08-11T09:00:00Z" }],
      }),
    });
    for (const name of ["Approve Ben Harlow", "Decline Ben Harlow"]) {
      const button = act(name);
      expect(button, name).not.toBeNull();
      expect(reachable(button), `${name} is behind a shut row`).toBe(true);
      expect(button?.closest("[data-row-panel]")).toBeNull();
    }
  });

  it("raises the save bar with a change, counts it, and undo puts it away", async () => {
    const { flushSync, settle } = await mountHousehold();
    expect(barUp()).toBe(false);
    expect(bar().hasAttribute("inert"), "a bar that is down must not take a tap").toBe(true);
    const services = /** @type {HTMLElement} */ (act("Services shown on the chart"));
    expect(services.getAttribute("aria-checked")).toBe("true");
    services.click();
    await settle();
    expect(services.getAttribute("aria-checked")).toBe("false");
    expect(barUp()).toBe(true);
    expect(bar().textContent).toContain("1 change");
    const name = /** @type {HTMLInputElement} */ ($("#hh-name"));
    name.value = "Harlow House";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(bar().textContent).toContain("2 changes");
    /** @type {HTMLElement} */ ([...bar().querySelectorAll("button")].find((b) => b.textContent?.trim() === "undo")).click();
    await settle();
    expect(barUp()).toBe(false);
    expect(services.getAttribute("aria-checked")).toBe("true");
    expect(/** @type {HTMLInputElement} */ ($("#hh-name")).value).toBe("Harlow Home");
  });

  it("keeps a failed save on the bar in red, with the change still made, past the toast's hold", async () => {
    const { api, settle } = await mountHousehold({
      "POST /api/workspace/commands": ({ body }) => body?.dryRun
        ? {}
        : jsonResponse({ error: { code: "internal", message: "Orbit could not store the sections just now" } }, 500),
    });
    const services = /** @type {HTMLElement} */ (act("Services shown on the chart"));
    services.click();
    await settle();
    /** @type {HTMLElement} */ ([...bar().querySelectorAll("button")].find((b) => b.textContent?.trim() === "save")).click();
    await vi.waitFor(() => expect(bar().querySelector("[role=alert]")?.textContent)
      .toBe("not saved — Orbit could not store the sections just now"));
    expect(api.calls.some((call) => call.path === "/api/workspace/commands" && !call.body?.dryRun), "the save was sent").toBe(true);
    /* the toast's 4 s hold is not the bar's: nothing the page runs on a clock puts the failure away */
    vi.useFakeTimers();
    try { await vi.advanceTimersByTimeAsync(4_500); } finally { vi.useRealTimers(); }
    await settle();
    expect(bar().querySelector("[role=alert]")).not.toBeNull();
    expect(services.getAttribute("aria-checked")).toBe("false");
    expect(barUp()).toBe(true);
  });

  it("moves a section from the keyboard (Alt-arrow down), and the move is collected into the bar", async () => {
    const { settle } = await mountHousehold();
    const titles = () => [...document.querySelectorAll(".hh-pocket .hh-sections [data-row] .title")].map((t) => t.textContent);
    const before = titles();
    $("[data-row-face]", row(".hh-sections", "Home")).dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true, cancelable: true }));
    await settle();
    expect(titles()).toEqual([before[1], before[0], ...before.slice(2)]);
    expect(bar().textContent).toContain("1 change");
  });

  it("opens a section's acts as edit, move up, move down, remove, with no move up on the first and no move down on the last", async () => {
    const { flushSync } = await mountHousehold();
    const names = (/** @type {HTMLElement} */ el) =>
      [...el.querySelectorAll("[data-row-acts] > *")].map((a) => a.getAttribute("aria-label"));
    const services = row(".hh-sections", "Services");
    $("[data-row-face]", services).click();
    flushSync();
    expect(names(services)).toEqual(["Edit Services", "Move Services up", "Move Services down", "Remove Services"]);
    const home = row(".hh-sections", "Home");
    $("[data-row-face]", home).click();
    flushSync();
    expect(names(home)).not.toContain("Move Home up");
    expect(names(home)).toContain("Move Home down");
    const dates = row(".hh-sections", "Dates & renewals");
    $("[data-row-face]", dates).click();
    flushSync();
    expect(names(dates)).not.toContain("Move Dates & renewals down");
    expect(names(dates)).toContain("Move Dates & renewals up");
  });
});
