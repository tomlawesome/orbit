// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createPageLoader, settle } from "../support/svelte-page.mjs";
import { blankEntry } from "../../web/src/routes/create/entry.js";
import { suggestionPapersOf } from "../../web/src/lib/data/belt.js";
import { readFileSync } from "node:fs";

/*
 * #1795 (spec: the issue and design note 63499): `review & amend ->` from a mail
 * with a scanner-flagged attachment used to drop the flagged file without
 * saying so. Every screen it lands on now says why, in the owner's words, and
 * its add button says the file is left out:
 *   - phone ReviewSheet/EntryForm: a `.pc-flag` block under the disabled paper
 *     (the line, then the second sentence); the add button reads `add without
 *     it` (`add without them` for two or more); aria-describedby ties the paper
 *     and the add button to the block; no role="alert" on the block.
 *   - desk SuggestionView and phone-home SuggestionDrawer: the flagged row is
 *     a non-button `.doc.flagged` / `.attached.flagged` with the line in its
 *     meta slot; their amending buttons use the same wording.
 *   - belt.js stagedDocsOf keeps the flagged row with `flagged: true`.
 * Not flagged: wording and papers are unchanged (`add to orbit`).
 *
 * The note leaves open the suffix of the `{i}` in the ids; the tests follow the
 * aria-describedby references rather than spelling an index, except that the
 * desk row's id starts `{row.id}-flag-`.
 */

const LINE = (/** @type {string} */ name) => `The scanner flagged a virus or malware inside attachment: "${name}"`;
const ONE = "Add without it adds the mail and its other attachments. The flagged file is never added.";
const MANY = "Add without them adds the mail and its other attachments. The flagged files are never added.";

/** Collapses whitespace. @param {Element | null | undefined} el */
const words = (el) => (el?.textContent ?? "").replace(/\s+/gu, " ").trim();
/** The elements an aria-describedby names, in order. @param {Element | null | undefined} el */
const describers = (el) => (el?.getAttribute("aria-describedby") ?? "").split(/\s+/u).filter(Boolean)
  .map((id) => document.getElementById(id)).filter((one) => one !== null);

const matchMedia = (/** @type {string} */ query) => ({
  matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
});
beforeEach(() => { vi.stubGlobal("matchMedia", matchMedia); });

/* ── belt.js ──────────────────────────────────────────────────────────── */
const pdf = (/** @type {string} */ id, /** @type {string} */ scanState) => ({
  id, displayName: `${id}.pdf`, mediaType: "application/pdf", sizeBytes: 1234, scanState,
});
const mail = (/** @type {Record<string, unknown>[]} */ attachments) => ({
  id: "r-1795", receiptId: "r-1795", title: "Boiler service", receivedAt: "2026-03-01T09:00:00.000Z",
  canApprove: true, attachmentCount: attachments.length, attachments,
});

describe("belt.js stagedDocsOf keeps the flagged file (#1795)", () => {
  it("a flagged attachment stays in the list as flagged, not clean, with no preview route (the old filter dropped it)", () => {
    const rows = suggestionPapersOf(/** @type {any} */ (mail([pdf("a-ok", "clean"), pdf("a-bad", "flagged")])));
    expect(rows.map((row) => row.name)).toEqual(["a-ok.pdf", "a-bad.pdf"]);
    expect(rows[1]).toMatchObject({ flagged: true, clean: false, previewHref: "" });
  });

  it("only the flagged row is flagged; a clean PDF keeps its preview route", () => {
    const rows = suggestionPapersOf(/** @type {any} */ (mail([pdf("a-one", "clean"), pdf("a-bad", "flagged"), pdf("a-two", "clean")])));
    expect(rows.map((row) => Boolean(row.flagged))).toEqual([false, true, false]);
    expect(rows[0].previewHref).not.toBe("");
  });
});

/* ── phone form: EntryForm in review mode ─────────────────────────────── */
const households = [{ id: "hh-1", name: "Home", currency: "GBP",
  sections: [{ id: "s-1", name: "Home", icon: "home", accent: "a", visible: true }] }];
const CLEAN = { id: "a-ok", name: "cover.pdf", meta: "12 KB", drawable: true };
const BAD = { id: "a-bad", name: "invoice.pdf", meta: "40 KB", drawable: false, flagged: true };
const BAD_TWO = { id: "a-bad2", name: "quote.docx", meta: "9 KB", drawable: false, flagged: true };

describe("phone form: the flag block under the disabled paper (#1795)", () => {
  const loader = createPageLoader("review-amend-flagged-form", { stub: (file) => /\/lib\/pocket\/(Sheet|Sky)\.svelte$/.test(file) });
  beforeAll(() => loader.setup("routes/create/EntryForm.svelte"));
  afterAll(() => loader.teardown());
  afterEach(() => loader.unmount());

  /** @param {any[]} papers */
  async function mountForm(papers) {
    const entry = blankEntry({ name: "Boiler cover", householdId: "hh-1" });
    entry.sectionId = "s-1";
    await loader.mount("routes/create/EntryForm.svelte", { entry, households, mode: "review", papers, readings: [], receiptId: "r-1" });
    await settle(6);
  }
  const paperButtons = () => [...document.querySelectorAll("button.pc-paper")];
  const blocks = () => [...document.querySelectorAll(".pc-flag")];

  it("a flagged paper stays a disabled button and is followed by a block with the owner's line and the second sentence", async () => {
    await mountForm([CLEAN, BAD]);
    const [clean, bad] = paperButtons();
    expect(/** @type {HTMLButtonElement} */ (bad).disabled, "the flagged paper stays disabled").toBe(true);
    expect(blocks(), "one block, for the one flagged paper").toHaveLength(1);
    const block = blocks()[0];
    expect(bad.nextElementSibling, "straight after the paper it is about").toBe(block);
    expect(clean.nextElementSibling, "none after the clean paper").not.toBe(block);
    const paragraphs = [...block.querySelectorAll("p")].map((p) => words(p));
    expect(paragraphs).toEqual([LINE("invoice.pdf"), ONE]);
    expect(block.querySelector("p b")?.textContent).toBe(LINE("invoice.pdf"));
    expect(block.querySelector(".pc-bead")?.getAttribute("aria-hidden"), "the bead is decoration").toBe("true");
  });

  it("two flagged papers get a block each, quoting their own names, both with the plural second sentence", async () => {
    await mountForm([BAD, CLEAN, BAD_TWO]);
    expect(blocks().map((block) => [...block.querySelectorAll("p")].map((p) => words(p)))).toEqual([
      [LINE("invoice.pdf"), MANY],
      [LINE("quote.docx"), MANY],
    ]);
  });

  it("the disabled paper is described by its own line, so the two are read together", async () => {
    await mountForm([CLEAN, BAD, BAD_TWO]);
    const [clean, bad, badTwo] = paperButtons();
    expect(clean.hasAttribute("aria-describedby"), "a clean paper points at nothing").toBe(false);
    expect(describers(bad).map((one) => one.className)).toEqual(["pc-flag"]);
    expect(words(describers(bad)[0])).toContain(LINE("invoice.pdf"));
    expect(words(describers(badTwo)[0])).toContain(LINE("quote.docx"));
  });

  it("the block carries no live role: the line is there when the sheet rises, and the describedby carries it", async () => {
    await mountForm([BAD]);
    const block = blocks()[0];
    expect(block, "a block to look in").toBeDefined();
    expect(block.matches('[role="alert"], [role="status"]')).toBe(false);
    expect(block.querySelector('[role="alert"], [role="status"]')).toBeNull();
  });

  it("not flagged: no block, no describedby, the paper as before", async () => {
    await mountForm([CLEAN]);
    expect(blocks()).toHaveLength(0);
    expect(paperButtons()[0].hasAttribute("aria-describedby")).toBe(false);
    expect(document.body.textContent).not.toContain("The scanner flagged");
  });
});

/* ── phone sheet: ReviewSheet's add button ────────────────────────────── */
describe("phone sheet: the add button says the flagged file is left out (#1795)", () => {
  const SHEET = "export default function Sheet(anchor, props) { props.children?.(anchor); props.foot?.(anchor); }\n";
  const loader = createPageLoader("review-amend-flagged-sheet", { stubs: { "lib/pocket/Sheet.svelte": SHEET },
    stub: (file) => /\/lib\/pocket\/Sky\.svelte$/.test(file) });
  beforeAll(() => loader.setup("lib/pocket/ReviewSheet.svelte"));
  afterAll(() => loader.teardown());
  afterEach(() => { loader.unmount(); vi.unstubAllGlobals(); });

  const json = (/** @type {unknown} */ body, status = 200) => new Response(JSON.stringify(body), { status });
  /** @param {any[]} papers */
  async function openSheet(papers) {
    vi.stubGlobal("matchMedia", matchMedia);
    vi.stubGlobal("fetch", vi.fn(async (/** @type {string} */ url) => {
      const href = String(url);
      if (href.includes("/api/auth/session")) return json({ user: { id: "u1" }, csrfToken: "t1" });
      if (href.includes("/api/imap-inbox/r-1")) return json({ receipt: { id: "r-1", draftVersion: 2, proposal: { title: "Boiler cover" } }, sections: households[0].sections, attachments: [] });
      if (href.includes("/api/settings/reminders")) return json({ reminders: { emailEnabled: true, firstWarningDays: 14, finalWarningDays: 3, firstWarning: "", finalWarning: "", outboundMail: "configured" } });
      return json({ error: { code: "unavailable", message: "not today" } }, 503);
    }));
    await loader.mount("lib/pocket/ReviewSheet.svelte", {
      open: true, title: "Boiler cover", proposal: { title: "Boiler cover" }, householdId: "hh-1", households,
      receiptId: "r-1", papers, readings: [], onsave: async () => true,
    });
    await settle(12);
  }
  const go = () => /** @type {HTMLElement} */ (document.querySelector(".rv-go"));

  it("one flagged file: `add without it`, tied to that file's line", async () => {
    await openSheet([CLEAN, BAD]);
    expect(words(go())).toBe("add without it");
    const tied = describers(go()).filter((one) => one.classList.contains("pc-flag"));
    expect(tied.map((one) => words(one.querySelector("p b")))).toEqual([LINE("invoice.pdf")]);
  });

  it("two flagged files: `add without them`, tied to both lines", async () => {
    await openSheet([BAD, CLEAN, BAD_TWO]);
    expect(words(go())).toBe("add without them");
    const tied = describers(go()).filter((one) => one.classList.contains("pc-flag"));
    expect(tied.map((one) => words(one.querySelector("p b")))).toEqual([LINE("invoice.pdf"), LINE("quote.docx")]);
  });

  it("there is no alert on the form's block, though the sheet itself is mounted", async () => {
    await openSheet([BAD]);
    expect(document.querySelector(".pc-flag"), "the block is drawn").not.toBeNull();
    expect(document.querySelector('.pc-flag [role="alert"], .pc-flag[role="alert"]')).toBeNull();
  });

  it("not flagged: the button still reads `add to orbit` and points at no flag", async () => {
    await openSheet([CLEAN]);
    expect(words(go())).toBe("add to orbit");
    expect(describers(go()).filter((one) => one.classList.contains("pc-flag"))).toHaveLength(0);
    expect(document.querySelector(".pc-flag")).toBeNull();
  });
});

/* ── desk and phone home: the suggestion's drawer ─────────────────────── */
/** @param {{ edit?: Record<string, unknown> }} [o] */
const actsOf = (o = {}) => ({
  modes: { edit: { id: "s-1795", busy: false, refused: null, problem: null, refusal: null, ...o.edit }, discardArmed: false },
  sections: [], onaccept: () => {}, oncancel: () => {},
});
const suggestionOf = (/** @type {Record<string, unknown>[]} */ attachments) => ({
  ...mail(attachments), id: "s-1795", receiptId: "r-1795", proposal: { title: "Boiler service" },
});

describe("desk SuggestionView: the flagged row and the amending button (#1795)", () => {
  const loader = createPageLoader("review-amend-flagged-desk", { stub: (file) => /\/home\/EditRows\.svelte$/.test(file) });
  beforeAll(() => loader.setup("routes/home/SuggestionView.svelte"));
  afterAll(() => loader.teardown());
  afterEach(() => loader.unmount());

  /** @param {Record<string, unknown>[]} attachments @param {boolean} amending */
  async function open(attachments, amending) {
    const suggestion = suggestionOf(attachments);
    const acts = actsOf();
    if (!amending) acts.modes.edit.id = /** @type {any} */ (null);
    await loader.mount("routes/home/SuggestionView.svelte", {
      row: { id: "s-1795", title: "Boiler service" }, suggestion, busyReceipt: null, armed: { id: null, act: null },
      mailProblem: null, today: "2026-03-10", onReceiptTap: () => {}, copied: false, onCopyAddress: () => {},
      showingDoc: null, onOpenDoc: () => {}, acts,
    });
    await settle(4);
    return /** @type {HTMLElement} */ (document.getElementById("s-1795-view"));
  }

  it("a flagged paper is a `.doc.flagged` that is not a button, with the line in its meta slot", async () => {
    const view = await open([pdf("a-ok", "clean"), pdf("a-bad", "flagged")], false);
    const row = /** @type {HTMLElement} */ (view.querySelector(".doc.flagged"));
    expect(row, "the flagged row is drawn").not.toBeNull();
    expect(row.tagName).toBe("DIV");
    expect(row.id.startsWith("s-1795-flag-")).toBe(true);
    expect(row.hasAttribute("aria-haspopup")).toBe(false);
    expect(row.querySelector("button, .go")).toBeNull();
    expect(row.getAttribute("aria-label") ?? "").not.toMatch(/^Open /u);
    expect(words(row.querySelector(".name small .flag"))).toBe(LINE("a-bad.pdf"));
    expect(row.querySelector(".mark")?.textContent).toBe("◆");
    expect(words(row.querySelector(".name"))).toContain("a-bad.pdf");
  });

  it("the clean paper beside it is still an Open button", async () => {
    const view = await open([pdf("a-ok", "clean"), pdf("a-bad", "flagged")], false);
    const buttons = [...view.querySelectorAll("button.doc")];
    expect(buttons.map((one) => one.getAttribute("aria-label"))).toEqual(["Open a-ok.pdf"]);
  });

  it("amending, one flagged file: the button reads `add without it` and is tied to the line", async () => {
    const view = await open([pdf("a-ok", "clean"), pdf("a-bad", "flagged")], true);
    const add = /** @type {HTMLElement} */ (view.querySelector(".actions button.yes"));
    expect(words(add)).toBe("add without it");
    expect(describers(add).map((one) => one.className)).toContain("doc flagged");
    expect(describers(add).some((one) => words(one).includes(LINE("a-bad.pdf")))).toBe(true);
  });

  it("amending, two flagged files: `add without them`, tied to both rows", async () => {
    const view = await open([pdf("a-bad", "flagged"), pdf("a-ok", "clean"), pdf("a-bad2", "flagged")], true);
    const add = /** @type {HTMLElement} */ (view.querySelector(".actions button.yes"));
    expect(words(add)).toBe("add without them");
    expect(describers(add)).toHaveLength(2);
  });

  it("not flagged: no flagged row, `add to orbit`, no describedby", async () => {
    const view = await open([pdf("a-ok", "clean")], true);
    expect(view.querySelector(".flagged, .flag")).toBeNull();
    const add = /** @type {HTMLElement} */ (view.querySelector(".actions button.yes"));
    expect(words(add)).toBe("add to orbit");
    expect(add.hasAttribute("aria-describedby")).toBe(false);
  });

  it("home.css colours the line like the held word: `.itemview .doc small .flag` in --overdue-text", () => {
    const css = readFileSync(`${import.meta.dirname}/../../web/src/routes/home/home.css`, "utf8");
    expect(css).toMatch(/\.itemview \.doc small \.flag\s*\{[^}]*color:\s*var\(--overdue-text\)/u);
  });
});

describe("phone home SuggestionDrawer: the flagged row and the amending button (#1795)", () => {
  const loader = createPageLoader("review-amend-flagged-drawer", { stub: (file) => /\/home\/EditRows\.svelte$/.test(file) });
  beforeAll(() => loader.setup("routes/home/SuggestionDrawer.svelte"));
  afterAll(() => loader.teardown());
  afterEach(() => loader.unmount());

  /** @param {Record<string, unknown>[]} attachments */
  async function open(attachments) {
    const { target } = await loader.mount("routes/home/SuggestionDrawer.svelte", {
      suggestion: suggestionOf(attachments), acts: actsOf(), onopenpaper: () => {},
    });
    await settle(4);
    return target;
  }

  it("a flagged paper is a non-button `.attached.flagged`: the mark, the name, the line as a block under it, no `scanned clean`", async () => {
    const target = await open([pdf("a-ok", "clean"), pdf("a-bad", "flagged")]);
    const row = /** @type {HTMLElement} */ (target.querySelector(".attached.flagged"));
    expect(row, "the flagged row is drawn").not.toBeNull();
    expect(row.tagName).toBe("DIV");
    expect(row.hasAttribute("aria-haspopup")).toBe(false);
    expect(row.querySelector("button")).toBeNull();
    expect(words(row.querySelector(".p-paper"))).toBe("◆");
    expect(words(row.querySelector(".name"))).toContain("a-bad.pdf");
    expect(words(row.querySelector(".flag"))).toBe(LINE("a-bad.pdf"));
    expect(row.textContent).not.toContain("scanned clean");
  });

  it("the clean paper beside it is still an Open button with `scanned clean`", async () => {
    const target = await open([pdf("a-ok", "clean"), pdf("a-bad", "flagged")]);
    const buttons = [...target.querySelectorAll("button.attached")];
    expect(buttons.map((one) => one.getAttribute("aria-label"))).toEqual(["Open a-ok.pdf"]);
    expect(buttons[0].textContent).toContain("scanned clean");
  });

  it("amending: `add without it`, or `add without them` for two, tied to the flagged rows", async () => {
    const one = await open([pdf("a-ok", "clean"), pdf("a-bad", "flagged")]);
    const add = /** @type {HTMLElement} */ (one.querySelector(".p-pill.filled"));
    expect(words(add)).toBe("add without it");
    expect(describers(add).some((el) => words(el).includes(LINE("a-bad.pdf")))).toBe(true);
    loader.unmount();
    const two = await open([pdf("a-bad", "flagged"), pdf("a-bad2", "flagged")]);
    const addTwo = /** @type {HTMLElement} */ (two.querySelector(".p-pill.filled"));
    expect(words(addTwo)).toBe("add without them");
    expect(describers(addTwo)).toHaveLength(2);
  });

  it("not flagged: `add to orbit`, no flagged row, no describedby", async () => {
    const target = await open([pdf("a-ok", "clean")]);
    expect(target.querySelector(".flagged, .flag")).toBeNull();
    const add = /** @type {HTMLElement} */ (target.querySelector(".p-pill.filled"));
    expect(words(add)).toBe("add to orbit");
    expect(add.hasAttribute("aria-describedby")).toBe(false);
  });
});
