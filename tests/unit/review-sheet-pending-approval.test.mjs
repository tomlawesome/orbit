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
  default: (/** @type {unknown} */ anchor, /** @type {any} */ props) => { props.children?.(anchor); props.foot?.(anchor); },
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
/** When set, answers the review read for the receipt instead of the flags above (W-R9, X-F3).
 *  @type {((init: RequestInit) => Promise<Response>) | null} */
let readOverride = null;

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
    const href = String(url);
    if (href.includes("/api/auth/session")) return json({ user: { id: "u1" }, csrfToken: "t1" });
    if (href.includes("/api/imap-inbox/r-1") && (!init?.method || init.method === "GET")) {
      if (readOverride) return readOverride(init);
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
  readOverride = null;
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

/**
 * @param {boolean} passProp whether the pair is also given as the `approval` prop (no production caller does).
 * @param {() => Promise<boolean>} onsave
 * @param {Record<string, unknown>} [props] the props themselves; pass a reactive proxy to change them after mounting
 */
async function openSheet(passProp = reported, onsave = async () => true, props = { open: true }) {
  const { mount, unmount } = await import(pathToFileURL(join(svelteSrc, "index-client.js")).href);
  const { default: ReviewSheet } = await import(/* @vite-ignore */ compiledSheet);
  Object.assign(props, {
    title: "Boiler cover",
    proposal: { title: "Boiler cover" },
    householdId: "hh-1",
    households: [household],
    receiptId: "r-1",
    ...(passProp ? { approval: PAIR } : {}),
    onsave,
  });
  const component = mount(ReviewSheet, { target: document.body, props });
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

  it("with no prop, a review read that fails does not draw the amend fields (W-R9: fail closed) and says nothing of an earlier approval", async () => {
    reported = true; // the pair exists, but the read cannot say so
    readFails = true;
    await openSheet(false);
    expect(entryForm.mounts, "the amend fields are not drawn").toBe(0);
    expect(sheetText()).not.toContain("finishing your earlier approval");
  });
});

/*
 * W-R9 / X-F3 (design-mailin fix 5): the sheet does not offer the form until
 * the review read has answered. While it is unanswered it says so; when it
 * fails (or times out) it refuses, with a way to try again; it never guesses
 * "no pending approval". Both are reached through the sheet's own `.rv-go`
 * submit in the foot and the form it names.
 */
const go = () => /** @type {HTMLElement | null} */ (document.querySelector(".rv-go"));
const status = () => document.querySelector('[role="status"]');
const alertEl = () => document.querySelector('[role="alert"]');
const againControl = () => /** @type {HTMLElement | undefined} */ (
  [...document.querySelectorAll("button, a, [role=button]")].find((el) => /try again/iu.test(el.textContent ?? "")));
const NEVER = () => new Promise(() => {});
const noPair = () => json({
  receipt: { id: "r-1", draftVersion: 2, proposal: { title: "Boiler cover" } },
  sections: household.sections, attachments: [],
});
const withPair = () => json({
  receipt: { id: "r-1", draftVersion: 2, proposal: { title: "Boiler cover" } },
  sections: household.sections, attachments: [], approval: PAIR,
});
/** The submit event of the form the foot's button names, as pressing it would fire. */
function submitForm() {
  const id = go()?.getAttribute("form");
  const form = id ? document.getElementById(id) : null;
  form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  go()?.click();
}

describe("W-R9, X-F3: the sheet is closed until the review read answers", () => {
  it("1. while the read is in flight it says it is checking, draws no form and holds the button", async () => {
    readOverride = NEVER;
    await openSheet(false);
    expect(status()?.textContent?.toLowerCase() ?? "", "a status line").toContain("checking for an earlier approval");
    expect(entryForm.mounts, "the entry form is not mounted").toBe(0);
    expect(go()?.getAttribute("aria-disabled")).toBe("true");
  });

  it("2. a read that fails is closed, with an alert and a try-again control", async () => {
    readOverride = async () => json({ error: { code: "unavailable", message: "not today" } }, 503);
    await openSheet(false);
    expect(alertEl()?.textContent?.toLowerCase() ?? "", "an alert").toContain("could not check for an earlier approval");
    expect(againControl(), "a try-again control").toBeTruthy();
    expect(entryForm.mounts, "the entry form is not mounted").toBe(0);
    expect(go()?.getAttribute("aria-disabled")).toBe("true");
  });

  it("3. try again, answered with no pair, draws the form with no alert and an enabled button", async () => {
    readOverride = async () => json({ error: { code: "unavailable", message: "not today" } }, 503);
    await openSheet(false);
    expect(againControl(), "a try-again control to activate").toBeTruthy();
    readOverride = async () => noPair();
    againControl()?.click();
    await settle();
    expect(entryForm.mounts, "the entry form is mounted").toBeGreaterThan(0);
    expect(alertEl(), "no alert").toBeNull();
    expect(go()?.getAttribute("aria-disabled")).toBeNull();
  });

  it("4. try again, answered with a pair, says it is finishing the earlier approval and draws no form", async () => {
    readOverride = async () => json({ error: { code: "unavailable", message: "not today" } }, 503);
    await openSheet(false);
    expect(againControl(), "a try-again control to activate").toBeTruthy();
    readOverride = async () => withPair();
    againControl()?.click();
    await settle();
    expect(sheetText()).toContain("finishing your earlier approval");
    expect(entryForm.mounts, "the entry form is not mounted").toBe(0);
  });

  it("5. a timed-out read is a failed read", async () => {
    readOverride = async () => { throw new DOMException("The operation timed out.", "TimeoutError"); };
    await openSheet(false);
    expect(alertEl()?.textContent?.toLowerCase() ?? "", "an alert").toContain("could not check for an earlier approval");
    expect(againControl(), "a try-again control").toBeTruthy();
    expect(entryForm.mounts, "the entry form is not mounted").toBe(0);
    expect(go()?.getAttribute("aria-disabled")).toBe("true");
  });

  it("6a. save is refused while the read is unanswered", async () => {
    readOverride = NEVER;
    const onsave = vi.fn(async () => true);
    await openSheet(false, onsave);
    submitForm();
    await settle();
    expect(onsave).not.toHaveBeenCalled();
  });

  it("6b. save is refused after the read failed", async () => {
    readOverride = async () => json({ error: { code: "unavailable", message: "not today" } }, 503);
    const onsave = vi.fn(async () => true);
    await openSheet(false, onsave);
    submitForm();
    await settle();
    expect(onsave, "an unchecked sheet saves nothing").not.toHaveBeenCalled();
  });

  it("6c. control: once the read answers with no pair, save goes through", async () => {
    readOverride = async () => noPair();
    const onsave = vi.fn(async () => true);
    await openSheet(false, onsave);
    submitForm();
    await settle();
    expect(onsave).toHaveBeenCalled();
  });

  it("7. a stale answer is ignored: close and reopen before the first read answers", async () => {
    const { proxy } = await import(pathToFileURL(join(svelteSrc, "internal/client/index.js")).href);
    /** @type {Array<(r: Response) => void>} */
    const answers = [];
    readOverride = () => new Promise((resolveRead) => { answers.push(resolveRead); });
    const props = proxy({ open: true });
    await openSheet(false, async () => true, props);
    expect(answers).toHaveLength(1);
    props.open = false;
    await settle();
    props.open = true;
    await settle();
    expect(answers).toHaveLength(2);
    // The first opening's answer reports a pair; it must not touch the second opening.
    answers[0](withPair());
    await settle();
    expect(sheetText(), "the stale answer is dropped").not.toContain("finishing your earlier approval");
    expect(entryForm.mounts, "the second opening is still waiting").toBe(0);
    answers[1](noPair());
    await settle();
    expect(entryForm.mounts, "the second opening's own answer opens the form").toBeGreaterThan(0);
    expect(sheetText()).not.toContain("finishing your earlier approval");
  });
});
