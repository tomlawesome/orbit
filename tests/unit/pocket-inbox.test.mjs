// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { fixtureApi } from "../support/fixture-api.mjs";
import { createPageLoader, runtime } from "../support/svelte-page.mjs";
import { readInboxScreen } from "$lib/data/workspace.js";
import { subscribeWake } from "$lib/pocket/wake.js";

/*
 * THE INBOX ON A PHONE (#1120, proposal §2.6), mounted in happy-dom over the
 * fixtures instance's own inbox (web/src/lib/data/fixtures/inbox.js) with the
 * writes an act makes answered here and read back (#1613, ADR-0039). What the
 * review card and the failed rows say and do is proved here; how they look is
 * pocket-measure.spec.js's.
 *
 * Proved lower down, so not repeated on the page (#1584 web-wr9):
 *   · review-sheet-pending-approval.test.mjs: the sheet over a pending pair
 *     says "finishing your earlier approval" and draws no form (wr9-1), and
 *     saves no amendment
 *   · approve-with-operation.test.mjs + receipt-acts-replayed.test.mjs: an
 *     amendment the engine replayed lands with the seam's words, the pair
 *     verbatim, and not as "added" (wr9-3)
 */

const PAGE = "routes/inbox/pocket.svelte";

/** The pair a receipt with an earlier approval still pending reports (#1396). */
const PAIR = {
  operationId: "7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a",
  request: {
    source: { kind: "mailbox_draft", receiptId: "r-insurance", draftVersion: 3 },
    householdId: "hh-harlow-1",
    sectionId: "s-home",
    action: "create_separate",
    item: { kind: "renewal", title: "Home insurance renewal", currency: "GBP" },
    attachmentIds: ["a-1"],
  },
};

describe("the inbox on a phone, mounted", () => {
  const loader = createPageLoader("pocket-inbox", { stub: (file) => /\/pocket\/Sky\.svelte$/.test(file) });
  beforeAll(() => loader.setup(PAGE));
  afterAll(() => loader.teardown());
  /** @type {(() => void) | null} */
  let stopWatching = null;
  afterEach(() => { loader.unmount(); stopWatching?.(); stopWatching = null; vi.unstubAllGlobals(); });

  /**
   * Answers what approveReceipt makes: the review read, the approval, the
   * discard; and records them. The fixture API answers reads only.
   * @param {Parameters<typeof fixtureApi>[0]} [overrides]
   */
  async function mountInbox(overrides = {}) {
    /** @type {{ approvals: any[], discards: string[] }} */
    const seen = { approvals: [], discards: [] };
    const api = fixtureApi({
      "GET /api/imap-inbox/*": ({ path }) => ({
        receipt: { id: path.split("/").pop(), draftVersion: 3, proposal: { title: "Home insurance renewal" } },
        sections: [{ id: "s-home" }, { id: "s-dates" }],
        attachments: [{ id: "a-1" }],
      }),
      "PUT /api/imap-inbox/*": () => ({ ok: true }),
      "DELETE /api/imap-inbox/*": ({ path }) => { seen.discards.push(path.split("/").pop() ?? ""); return { ok: true }; },
      "POST /api/reviewed-intake/approve": ({ body }) => { seen.approvals.push(body); return { outcome: "approved", itemId: "i-new" }; },
      ...overrides,
    });
    vi.stubGlobal("fetch", api.fetch);
    vi.stubGlobal("matchMedia", (/** @type {string} */ query) => ({
      matches: true, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
    /** @type {string[]} */
    const wakes = [];
    /* subscribing replays the wake standing now (a previous test's, held 4 s): not this one's */
    let replay = true;
    stopWatching = subscribeWake((entry) => { if (replay) { replay = false; return; } if (entry) wakes.push(entry.message); });
    const view = await readInboxScreen();
    await loader.mount(PAGE, { view });
    const { flushSync } = await runtime();
    /** Lets promises and timers at zero run, then draws what they changed. */
    const settle = async () => { await new Promise((done) => setTimeout(done, 0)); flushSync(); };
    await settle();
    return { api, seen, wakes, settle };
  }

  /** A button by its accessible name (aria-label, else its text). */
  const button = (/** @type {string} */ name) => /** @type {HTMLElement | null} */ (
    [...document.querySelectorAll("button")].find((el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim() === name) ?? null);
  const click = (/** @type {HTMLElement | null} */ el) => { if (!el) throw new Error("no such control"); el.click(); };

  it("Add to orbit arms on the first tap and approves as proposed on the second", async () => {
    const { seen, settle } = await mountInbox();
    click(button("Add Home insurance renewal to your orbit"));
    await settle();
    expect(button("tap again to add Home insurance renewal to your orbit")).not.toBeNull();
    expect(seen.approvals).toHaveLength(0);
    click(button("tap again to add Home insurance renewal to your orbit"));
    await vi.waitFor(() => expect(seen.approvals).toHaveLength(1));
    expect(seen.approvals[0]).toMatchObject({
      sectionId: "s-home", action: "create_separate", attachmentIds: ["a-1"],
      source: { kind: "mailbox_draft", receiptId: "r-insurance", draftVersion: 3 },
    });
  });

  it("review & amend opens create's form pre-filled, and approves the amended values into the chosen section", async () => {
    /* The new item's reminders start at the member's own Settings pair (#1389,
       owner decision 7a on #1316): this member has chosen 30 and 7. The review
       sheet holds its button to the engine's dry run (ADR-0034, #1325), whose
       refusal for the one rule read here is answered as the engine does: a
       200 verdict (decision 3 amendment). */
    const { seen, settle } = await mountInbox({
      "GET /api/settings/reminders": () => ({ reminders: {
        emailEnabled: true, firstWarningDays: 30, finalWarningDays: 7,
        firstWarning: "30 days before closest approach", finalWarning: "7 days before", outboundMail: "configured" } }),
      "POST /api/workspace/commands": ({ body }) => (body?.dryRun && !body.item?.sectionId
        ? { refusal: { code: "item_section_missing", message: "not yet — choose a section" } }
        : {}),
    });
    click(button("review & amend →"));
    const sheet = () => /** @type {HTMLElement} */ (document.querySelector('[role="dialog"]'));
    await vi.waitFor(() => expect(sheet()?.querySelector("input")).not.toBeNull());
    await settle();
    expect(sheet().textContent).toContain("Review & amend");
    const field = (/** @type {string} */ label) => /** @type {HTMLInputElement} */ (
      document.getElementById([...sheet().querySelectorAll("label")].find((el) => el.textContent?.trim().startsWith(label))?.getAttribute("for") ?? ""));
    const chip = (/** @type {string} */ text) => /** @type {HTMLElement} */ (
      [...sheet().querySelectorAll("button")].find((el) => el.textContent?.includes(text)));
    expect(field("name").value).toBe("Home insurance renewal");
    expect(field("provider").value).toBe("Harbour Mutual");
    expect(chip("renewal").getAttribute("aria-pressed")).toBe("true");
    /* The section has no default (#1058): nothing is sent until one is chosen. */
    const go = /** @type {HTMLElement} */ (sheet().querySelector(".rv-go"));
    await vi.waitFor(() => {
      expect(go.getAttribute("aria-disabled")).toBe("true");
      expect(sheet().textContent).toContain("not yet — choose a section");
    });
    click(chip("Dates & renewals"));
    await settle();
    const provider = field("provider");
    provider.value = "Harbour Mutual plc";
    provider.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    await vi.waitFor(() => expect(go.getAttribute("aria-disabled")).not.toBe("true"));
    click(go);
    await vi.waitFor(() => expect(seen.approvals).toHaveLength(1));
    expect(seen.approvals[0].sectionId).toBe("s-dates");
    /* The sheet sends the cost as typed and the item's kind, for the engine
       to read and map (ADR-0034, #1325). */
    expect(seen.approvals[0].item).toMatchObject({
      title: "Home insurance renewal", provider: "Harbour Mutual plc", cost: "400.00", currency: "GBP",
      dueDate: "2026-10-03", scheduleKind: "renewal", recurrenceMonths: 12, kind: "renewal", reminderDays: [30, 7],
    });
  });

  it("a receipt with an earlier approval pending is approved by that pair verbatim, and wakes plainly", async () => {
    const { seen, wakes, settle } = await mountInbox({
      "GET /api/imap-inbox/*": ({ path }) => ({
        receipt: { id: path.split("/").pop(), draftVersion: 3, proposal: { title: "Home insurance renewal" } },
        sections: [{ id: "s-home" }, { id: "s-dates" }],
        attachments: [{ id: "a-1" }],
        approval: PAIR,
      }),
    });
    click(button("Add Home insurance renewal to your orbit"));
    await settle();
    click(button("tap again to add Home insurance renewal to your orbit"));
    await vi.waitFor(() => expect(seen.approvals).toHaveLength(1));
    expect(seen.approvals[0]).toEqual({ ...PAIR.request, operationId: PAIR.operationId });
    await vi.waitFor(() => expect(wakes).toContain("added to your orbit · Home insurance renewal"));
    expect(wakes.join(" ")).not.toContain("earlier approval");
  });

  it("a failed arrival the server lets go opens on a tap to remove; one it keeps has none", async () => {
    const { seen, settle } = await mountInbox({
      "GET /api/imap-inbox": () => ({
        receipts: [
          { id: "r-gone", receivedAt: "2026-08-09T16:02:00.000Z", classification: "retry", canApprove: false,
            canDiscard: true, message: "It carried no document Orbit can read." },
          { id: "r-kept", receivedAt: "2026-08-06T08:41:00.000Z", classification: "unavailable", canApprove: false,
            canDiscard: false, message: "Its document could not be prepared." },
        ],
        filed: [],
      }),
    });
    /* Real buttons in the accessible tree (review round §1.1), out of the
       page until their row opens. */
    const reachable = (/** @type {string} */ name) => {
      const el = button(name);
      return Boolean(el) && !el?.closest("[hidden]");
    };
    expect(reachable("Remove the message from 09 Aug")).toBe(false);
    expect(reachable("Remove the message from 06 Aug")).toBe(false);
    const rowOf = (/** @type {string} */ text) => /** @type {HTMLElement} */ (
      [...document.querySelectorAll(".p-row")].find((el) => el.textContent?.includes(text)));
    const gone = rowOf("A message from 09 Aug");
    click(/** @type {HTMLElement} */ (gone.querySelector("[data-row-face]")));
    await settle();
    expect(gone.hasAttribute("data-open")).toBe(true);
    expect(reachable("Remove the message from 09 Aug")).toBe(true);
    /* the one the server keeps has no act at all */
    expect(button("Remove the message from 06 Aug")).toBeNull();
    click(button("Remove the message from 09 Aug"));
    await settle();
    click(button("tap again to remove the message from 09 Aug"));
    await vi.waitFor(() => expect(seen.discards).toEqual(["r-gone"]));
  });
});
