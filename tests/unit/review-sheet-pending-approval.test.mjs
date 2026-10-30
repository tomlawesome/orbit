// @vitest-environment happy-dom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1396, owner decision 7a (note 46142): while a receipt has a pending
 * approval pair -- `approval: { operationId, request }`, reported by the review
 * read GET /api/imap-inbox/:receiptId -- the review sheet hides its amend
 * fields and shows "finishing your earlier approval" instead, because an
 * amendment made then would finish the earlier approval rather than apply
 * (error prevention).
 *
 * Shaped like review-amend-reminders-follow-settings.test.mjs: the sheet
 * (ReviewSheet.svelte) is compiled and mounted in happy-dom with the entry form
 * and the sheet's frame stood in for. The plan does not say how the sheet is
 * told about the pair, so the pair reaches it both ways at once: as an
 * `approval` prop beside `receiptId`, and in the answer to the review read for
 * that receipt. "Amend fields" are the entry form, so the test is that the form
 * is not mounted.
 */

const entryForm = vi.hoisted(() => ({ mounts: 0 }));
vi.mock("../../web/src/routes/create/EntryForm.svelte", () => ({
  default: () => { entryForm.mounts++; },
}));
vi.mock("../../web/src/lib/pocket/Sheet.svelte", () => ({
  default: (/** @type {unknown} */ anchor, /** @type {any} */ props) => { props.children?.(anchor); },
}));

const household = {
  id: "hh-1", name: "Home", currency: "GBP", items: [],
  sections: [{ id: "s-home", name: "Home", accent: "a", visible: true }],
};
const json = (/** @type {unknown} */ body, status = 200) => new Response(JSON.stringify(body), { status });

const PAIR = {
  operationId: "7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a",
  request: {
    source: { kind: "mailbox_draft", receiptId: "r-1", draftVersion: 2 },
    householdId: "hh-1",
    sectionId: "s-home",
    action: "create_separate",
    item: { kind: "service", title: "Amended before the reload", currency: "GBP", status: "active" },
    attachmentIds: [],
  },
};

/** Whether the review read for the receipt reports a pending pair. */
let reported = false;
/** Whether the review read for the receipt fails outright. */
let readFails = false;

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
    const href = String(url);
    if (href.includes("/api/auth/session")) return json({ user: { id: "u1" }, csrfToken: "t1" });
    if (href.includes("/api/imap-inbox/r-1") && (!init?.method || init.method === "GET")) {
      if (readFails) return json({ error: { code: "unavailable", message: "not today" } }, 503);
      return json({
        receipt: { id: "r-1", draftVersion: 2, proposal: { title: "Boiler cover" } },
        sections: household.sections, attachments: [],
        ...(reported ? { approval: PAIR } : {}),
      });
    }
    if (href.includes("/api/settings/reminders")) {
      return json({ reminders: { emailEnabled: true, firstWarningDays: 14, finalWarningDays: 3, firstWarning: "", finalWarning: "", outboundMail: "configured" } });
    }
    if (href.includes("/api/workspace/commands") && init?.method === "POST") return json({});
    return json({ error: { code: "unavailable", message: "not today" } }, 503);
  }));
}

const web = resolve(import.meta.dirname, "../../web");
const svelteSrc = join(web, "node_modules/svelte/src");
/** @type {string} */
let compiledDir;
/** @type {string} */
let compiledSheet;

beforeAll(async () => {
  const { compile } = await import(pathToFileURL(join(svelteSrc, "compiler/index.js")).href);
  const file = join(web, "src/lib/pocket/ReviewSheet.svelte");
  const quoted = (/** @type {string} */ path) => JSON.stringify(path);
  const js = compile(readFileSync(file, "utf8"), { filename: file, generate: "client", dev: false }).js.code
    .replaceAll("'svelte/internal/client'", quoted(join(svelteSrc, "internal/client/index.js")))
    .replaceAll("'svelte/internal/disclose-version'", quoted(join(svelteSrc, "internal/disclose-version.js")))
    .replaceAll('from "svelte"', `from ${quoted(join(svelteSrc, "index-client.js"))}`)
    .replaceAll('"$lib/data/dry-run.js"', quoted(join(web, "src/lib/data/dry-run.js")))
    .replaceAll('"./Sheet.svelte"', quoted(join(web, "src/lib/pocket/Sheet.svelte")))
    .replaceAll('"../../routes/create/EntryForm.svelte"', quoted(join(web, "src/routes/create/EntryForm.svelte")))
    .replaceAll('"../../routes/create/entry.js"', quoted(join(web, "src/routes/create/entry.js")));
  mkdirSync(resolve(import.meta.dirname, "../../tmp"), { recursive: true });
  compiledDir = mkdtempSync(resolve(import.meta.dirname, "../../tmp/review-sheet-pending-approval-"));
  compiledSheet = join(compiledDir, "review-sheet.mjs");
  writeFileSync(compiledSheet, js);
});
afterAll(() => { rmSync(compiledDir, { recursive: true, force: true }); });

/** @type {(() => void) | null} */
let unmountSheet = null;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  reported = false;
  readFails = false;
  entryForm.mounts = 0;
  document.body.innerHTML = "";
  stubFetch();
});
afterEach(() => {
  unmountSheet?.();
  unmountSheet = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settle = async () => { await vi.advanceTimersByTimeAsync(400); };

/** @param {boolean} passProp whether the pair is also given as the `approval` prop (no production caller does). */
async function openSheet(passProp = reported) {
  const { mount, unmount } = await import(pathToFileURL(join(svelteSrc, "index-client.js")).href);
  const { default: ReviewSheet } = await import(/* @vite-ignore */ compiledSheet);
  const component = mount(ReviewSheet, {
    target: document.body,
    props: {
      open: true,
      title: "Boiler cover",
      proposal: { title: "Boiler cover" },
      householdId: "hh-1",
      households: [household],
      receiptId: "r-1",
      ...(passProp ? { approval: PAIR } : {}),
      onsave: async () => true,
    },
  });
  unmountSheet = () => unmount(component);
  await settle();
}

const sheetText = () => (document.body.textContent ?? "").replace(/\s+/gu, " ").toLowerCase();

describe("#1396: the review sheet while an earlier approval is pending", () => {
  it("hides the amend fields and says it is finishing the earlier approval", async () => {
    reported = true;
    await openSheet();
    expect(entryForm.mounts, "the amend fields are not drawn").toBe(0);
    expect(sheetText()).toContain("finishing your earlier approval");
  });

  it("with no pending approval it draws the amend fields and says nothing of the kind", async () => {
    reported = false;
    await openSheet();
    expect(entryForm.mounts, "the amend fields are drawn").toBeGreaterThan(0);
    expect(sheetText()).not.toContain("finishing your earlier approval");
  });
});

describe("#1396: the sheet finds a pending pair by itself (no production caller passes the `approval` prop)", () => {
  it("with no prop, a review read that reports the pair hides the amend fields and shows the message", async () => {
    reported = true;
    await openSheet(false);
    expect(entryForm.mounts, "the amend fields are not drawn").toBe(0);
    expect(sheetText()).toContain("finishing your earlier approval");
  });

  it("with no prop, a review read that reports no pair draws the amend fields (the control for the test above)", async () => {
    reported = false;
    await openSheet(false);
    expect(entryForm.mounts, "the amend fields are drawn").toBeGreaterThan(0);
    expect(sheetText()).not.toContain("finishing your earlier approval");
  });

  it("with no prop, a review read that fails leaves the form drawn and says nothing of an earlier approval", async () => {
    reported = true; // the pair exists, but the read cannot say so
    readFails = true;
    await openSheet(false);
    expect(entryForm.mounts, "the amend fields are drawn").toBeGreaterThan(0);
    expect(sheetText()).not.toContain("finishing your earlier approval");
  });
});
