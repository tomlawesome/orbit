/**
 * WHAT HOME'S ITEM DRAWER DOES, WRITTEN ONCE (#1352; #1328 WI-22, M3).
 * The desk (+page.svelte) and the phone (pocket.svelte) each wrote these
 * acts for themselves, and the copies drifted (#1328 web-9). Each screen
 * now makes one `createDrawerActs` and hands it the four things that differ
 * between them:
 *
 *   view    home's view as the screen holds it
 *   reread  read again after an act landed: the desk reads home and the
 *           open drawer's record, the phone asks its host and reads the
 *           papers again when they changed
 *   say     put an act's problem where the screen shows it (the desk's
 *           drawer line or receipt line, the phone's row), or clear it
 *   focus   put focus on a control in an item's drawer once it is drawn
 *
 * and a few smaller ones: which row's drawer is open (`open`), the item as a
 * command addresses it (`itemOf`), the amended approve (`amend`, the desk's
 * amendReceipt), what an item leaving the list does to its drawer (`leave`:
 * the desk puts it away; the phone's asked row stays), and two of the
 * phone's own ways of saying things: it wakes before it reads again
 * (`wakeFirst`), and its attach wake is shorter (`attached`).
 *
 * Built function by function from the phone's versions. Runes, so the
 * busy act, the open preview and the search's papers are state either
 * screen's template reads.
 *
 * The drawer's foot row and rows read the screen's handlers through
 * `DrawerActs` (FootRow.svelte, EditRows.svelte), handed down through the
 * desk's CorridorRow and ItemView and the phone's ItemDrawer.
 *
 * `modes` is the screen's DrawerModes (drawer-modes.svelte.js): what the
 * drawer is doing besides reading, for whichever item it is. `sections` are
 * the item's household's, for the section's name and colour.
 *
 * @typedef {"snooze" | "complete" | "attach" | "retire" | "restore" | "save" | null} DrawerBusy
 * @typedef {{
 *   busy: DrawerBusy,
 *   problem: string | null,
 *   modes: import('./drawer-modes.svelte.js').DrawerModes,
 *   sections: import('./drawer-modes.svelte.js').SectionChoice[],
 *   onsnooze: (from: HTMLElement) => unknown,
 *   oncomplete: (from: HTMLElement) => unknown,
 *   onattach: (file: File) => unknown,
 *   onretire: () => unknown,
 *   oncopy: () => Promise<boolean>,
 *   onedit: () => unknown,
 *   onsave: () => unknown,
 *   onrecord: () => unknown,
 *   oncancel: () => unknown,
 *   onamend?: () => unknown,
 *   onaccept?: () => unknown,
 *   onrestore?: () => unknown,
 * }} DrawerActs
 *
 * `onrestore` brings a retired, cancelled or expired item back (#1319:
 * the drawer opens any item, and offers what fits its state).
 *
 * `onamend` and `onaccept` are a suggestion's (SuggestionView.svelte, #1319):
 * `review & amend →` puts its rows into editing, and `add to orbit` approves
 * what they hold.
 *
 * @typedef {"snooze" | "complete" | "attach" | "retire" | "restore"} FootKind
 * @typedef {{ view?: boolean, papers?: boolean, leaves?: boolean }} Change
 *   what an act changed: home's view (unless `view: false`), the item's
 *   papers, and whether the item has left the list
 * @typedef {"item" | "suggestion" | "partial"} About
 *   whose problem `say` is given: an item's, a suggestion's, or the words of
 *   an amended approval that landed only partly (the item is filed, its
 *   documents need another try)
 * @typedef {import('$lib/data/workspace.js').ReceiptSuggestion} ReceiptSuggestion
 * @typedef {(suggestion: ReceiptSuggestion, item: import('$lib/data/workspace.js').ItemProposal,
 *   sectionId: string | null) => Promise<string | { partial: true, message: string } | null> | null} Amend
 */
import { applyCommand, attachItemDocument, dueDateIn, readItemDocuments, readReminders, removeDocument, restoreDocument, wordsOf } from "$lib/data/workspace.js";
import { completeCommand, snoozeCommand, upsertCommand } from "$lib/data/commands.js";
import { amendedOf, proposedItemOf } from "$lib/editing/item-draft.js";
import { dayMonth } from "$lib/format.js";
import { reviewLockedOf } from "$lib/pocket/review.js";
import { wake } from "$lib/pocket/wake.js";
import { attachIdFor, forget as forgetAttachId } from "./attach-id.js";
import { DrawerModes } from "./drawer-modes.svelte.js";
import { readSearchDocuments } from "./pocket-search.js";

/** A paper removed or restored: its item's papers, not home's view. @type {Change} */
const PAPERS = { view: false, papers: true };

/**
 * @param {{
 *   view: () => import('$lib/data/workspace.js').HomeView | null,
 *   reread: (change: Change) => Promise<unknown>,
 *   say: (id: string, words: string | null, about?: About) => unknown,
 *   focus: (id: string, selector: string) => unknown,
 *   open: () => string | null,
 *   itemOf: (id: string) => any,
 *   amend: Amend,
 *   leave?: (id: string) => unknown,
 *   wakeFirst?: boolean,
 *   attached?: (file: string, title: string) => string,
 * }} options
 */
export function createDrawerActs({
  view, reread, say, focus, open, itemOf, amend,
  leave = () => {}, wakeFirst = false, attached = (file) => `${file} attached`,
}) {
  /** The act being sent, and whose. @type {{ id: string, kind: FootKind } | null} */
  let busy = $state(null);

  /* ---- #1319: a paper in a drawer opens the preview card ------------------
     design/v19/belt-purpose/round-3 (F): beside the drawer on a wide desk,
     the bottom sheet under 1200px. Escape or a press off it puts it away and
     leaves the drawer open. */
  /** @type {any} */
  let preview = $state(null);
  /** The paper's row that opened the card, for focus to return to. @type {HTMLElement | null} */
  let previewFrom = null;

  /* ---- #1319 stage 2: editing in the rows, and the chooser ---------------
     design/v19/belt-purpose/round-8/m-colour-per-option.html. */
  const modes = new DrawerModes({
    save: async (item, edits) => {
      if (item.status === "suggested") { await addSuggestion(item, edits); return; }
      await applyCommand(upsertCommand(item, edits));
      await reread({});
    },
    /* one card at a time: a chooser puts a paper's preview away */
    onchoose: () => { preview = null; },
  });

  /** An act landed: read again and say so, in the screen's order. @param {Change} change @param {string} words */
  async function landed(change, words) {
    if (wakeFirst) wake(words);
    await reread(change);
    if (!wakeFirst) wake(words);
  }

  /* ---- #1319: A SUGGESTION AMENDED IN ITS DRAWER'S OWN ROWS --------------
     owner-decisions §34; on the phone too (owner, 2026-10-08). `review &
     amend →` puts the suggestion's rows into editing (EditRows), the relay's
     proposal standing in for the item it would become (proposedItemOf); the
     choosers are a filed item's. `add to orbit` sends the rows as the
     amended item on the two-tap decision's own operation id (`amend`), into
     the section the rows chose; `cancel` puts the readings back. */
  /* #1316: the latest review & amend press still waiting on the reminder
     read; an earlier press, or one the screen has moved on from, opens
     nothing when its answer lands. */
  /** @type {object | null} */
  let amendAsk = null;
  /** @param {ReceiptSuggestion} s */
  async function startAmend(s) {
    const current = view();
    if (!s.receiptId || reviewLockedOf(s) || !current) return;
    /* Already amending this one: a second press keeps what was typed rather
       than starting the rows again (#1316). */
    if (modes.id === s.id) return;
    const householdId = s.householdId ?? current.primary;
    if (!householdId) {
      say(s.id, "This account has no household yet", "suggestion");
      return;
    }
    const own = (current.households ?? []).find((one) => one.id === householdId)?.sections
      ?? current.household?.sections ?? [];
    const sectionId = (own.find((one) => one.visible !== false) ?? own[0])?.id ?? null;
    say(s.id, null, "suggestion");
    preview = null;
    /* The rows start the reminders at the member's own pair from Settings,
       read before they open so no late answer has to be reconciled with an
       edit; a failed read, or one past 1.5 s (#1316), falls back to the
       default pair. */
    const ask = {};
    amendAsk = ask;
    const reminders = await readReminders({ within: 1500 }).catch(() => null);
    if (amendAsk !== ask) return;
    amendAsk = null;
    /* #1316: the drawer may have closed, another opened, another item's edit
       begun, or the suggestion been locked or gone while the read was out:
       then the rows stay shut. */
    const still = view()?.suggestions.find((one) => one.id === s.id);
    if (open() !== s.id || (modes.id != null && modes.id !== s.id) || !still || reviewLockedOf(still)) return;
    modes.startEdit(proposedItemOf(s, { householdId, sectionId }, { reminders }));
    focus(s.id, '[data-ed="title"]');
  }
  /**
   * The rows' save for a suggestion: approved as amended, or refused in the
   * rows' own words (EditSession says it under the rows).
   * @param {import('$lib/data/commands.js').CommandItem} item
   * @param {Partial<import('$lib/data/commands.js').CommandItem>} edits
   */
  async function addSuggestion(item, edits) {
    const suggestion = view()?.suggestions.find((one) => one.id === item.id);
    const { item: amended, sectionId } = amendedOf(item, edits);
    const sent = suggestion ? amend(suggestion, amended, sectionId) : null;
    if (!suggestion || !sent) throw new Error("not added — this suggestion has gone");
    const problem = await sent;
    if (problem && typeof problem === "object") {
      /* A partial approval has filed the item: the rows close, or a corrected
         re-send under the same operation id is refused for good. */
      say(suggestion.id, problem.message, "partial");
      landedPartial = true;
      return;
    }
    if (problem) throw new Error(`not added — ${problem}`);
  }
  /* Set by addSuggestion when the add landed partly: addAmended then leaves
     the recorded-but-pending sentence standing instead of "added". */
  let landedPartial = false;
  async function addAmended() {
    landedPartial = false;
    const id = modes.edit.id;
    const title = modes.edit.draft?.title.trim() ?? "";
    if (await modes.edit.commit() && !landedPartial) {
      if (id) leave(id);
      wake(`added to your orbit · ${title}`);
    }
  }

  /* ---- the papers (#1057, #1319) ---------------------------------------- */

  /** @param {any} paper @param {HTMLElement} from */
  function openPreview(paper, from) {
    /* one card at a time: a paper's preview puts a chooser away */
    modes.closeChooser(false);
    previewFrom = from;
    if (preview?.id !== paper.id) preview = paper;
  }
  /** @param {{ refocus: boolean }} how */
  function closePreview({ refocus }) {
    preview = null;
    if (refocus && previewFrom?.isConnected) previewFrom.focus({ preventScroll: true });
  }
  /* The reader's remove (#1054): the paper goes, the card closes onto the
     drawer, and the wake offers it back. */
  /** @param {{ id: string, name: string }} paper */
  async function removePaper(paper) {
    await removeDocument(paper.id);
    preview = null;
    await reread(PAPERS);
    wake(`${paper.name} removed`, {
      // The removed wake is already gone by now, so a refused restore must
      // say so or the paper silently stays removed.
      undo: () => { restoreDocument(paper.id).then(() => reread(PAPERS)).catch(() => wake(`couldn't restore ${paper.name} — try again`, { failure: true })); },
    });
  }
  /** @param {{ id: string }} paper */
  async function restorePaper(paper) {
    await restoreDocument(paper.id);
    preview = null;
    await reread(PAPERS);
  }

  /* The search's own read of every paper home holds (#1057), made once per
     household. On the phone the drawers' papers ride on it too, so the open
     row's item is read whatever its status (`also`), and a retired or
     expired item still shows its papers. */
  /** @type {import('./pocket-search.js').SearchDocument[]} */
  let searchDocuments = $state([]);
  let papersReady = $state(false);
  /** @type {object | null} */
  let searchDocumentsFor = null;

  /** #1151 W1-Q8: pocket-search.js's readSearchDocuments carries the
   *  concurrency cap (#1151 W1-R9). @param {string | null} [also] */
  async function loadSearchDocuments(also = null) {
    const current = view();
    const household = current?.household;
    const householdId = current?.primary;
    if (!household || !householdId || searchDocumentsFor === household) return;
    searchDocumentsFor = household;
    const carrying = (household.items ?? []).filter((item) => (item.status === "active" || item.id === also) && (item.documentCount ?? 0) > 0);
    // Additive: an item whose papers cannot be read loses its papers from the
    // results, not the search.
    const found = await readSearchDocuments(
      carrying, readItemDocuments, householdId, () => searchDocumentsFor !== household,
    );
    if (searchDocumentsFor === household) {
      searchDocuments = found;
      papersReady = true;
    }
  }
  /** The papers again, after one was attached, removed or restored. @param {string | null} [also] */
  async function rereadSearchDocuments(also = null) {
    searchDocumentsFor = null;
    papersReady = false;
    await loadSearchDocuments(also);
  }

  /* ---- #1319: THE DRAWER'S FOOT ROW (FootRow.svelte) ---------------------
     Every act the belt had, from the open drawer, through the belt's own
     commands (commands.js): snooze, complete, attach a document, retire,
     restore, and copy link. */

  /* `copy link`: the item's address, the chain-link icon at the drawer's foot. */
  /** @param {string | null} id @returns {Promise<boolean>} whether the address reached the clipboard */
  async function copyLink(id) {
    try {
      await navigator.clipboard.writeText(new URL(`/home?item=${encodeURIComponent(/** @type {string} */ (id))}`, location.origin).href);
      return true;
    } catch {
      /* A refused clipboard is no error worth a word: the address still works. */
      return false;
    }
  }

  /**
   * One act that changes the item and then reads it again.
   * @param {string} id
   * @param {"snooze" | "retire" | "restore"} kind
   * @param {(item: any) => object} build
   * @param {string} words  what the wake says once it has landed
   * @param {{ leaves?: boolean }} [options]  the item leaves the list
   */
  async function runRowAct(id, kind, build, words, { leaves = false } = {}) {
    const item = itemOf(id);
    if (!item || busy) return;
    busy = { id, kind };
    say(id, null);
    try {
      await applyCommand(build(item));
      if (leaves) leave(id);
      await landed({ leaves }, words);
    } catch (error) {
      say(id, wordsOf(error, `couldn't ${kind} it — try again`));
    } finally {
      busy = null;
    }
  }
  /** @param {string} id @param {File} file */
  async function attach(id, file) {
    const item = itemOf(id);
    if (!item || busy) return;
    busy = { id, kind: "attach" };
    say(id, null);
    try {
      await attachItemDocument(item.householdId, id, file, attachIdFor(id, file));
      forgetAttachId(id, file);
      // The papers are read after the view: the refreshed view lists the
      // item as now carrying one (a first paper was left out).
      await landed({ papers: true }, attached(file.name, item.title));
    } catch (error) {
      say(id, wordsOf(error, "couldn't attach it — try again"));
    } finally {
      busy = null;
    }
  }
  /** The chooser's pick: the rows take it, or the snooze is sent. @param {string} value */
  function pickChoice(value) {
    const snooze = modes.pick(value);
    if (!snooze || !itemOf(snooze.item.id)) return;
    const { item, until } = snooze;
    /* Whether the day will do is the engine's (#1325): its refusal is said
       where the screen says problems, in its words. */
    /* #1319: the pills are disabled while it is sent, which drops the focus
       the chooser handed back; put it back on the pill once they are live. */
    runRowAct(item.id, "snooze", (one) => snoozeCommand(one, until), `${item.title} snoozed until ${dayMonth(until)}`)
      .then(() => { if (open() === item.id) focus(item.id, '[aria-label^="Snooze "]'); });
  }
  /** @param {string} id */
  async function save(id) {
    const title = modes.edit.draft?.title.trim() ?? "";
    if (await modes.edit.commit()) {
      wake(`saved · ${title}`);
      focus(id, ".ivedit");
    }
  }
  /* Complete records what the rows hold: the date, the cost and the notes.
     The next due date is the engine's (#1324), read back from its reply.
     Sent on `record`, not held for an undo: the rows were the chance to
     change it. Answers the next due date once it has landed. */
  /** @param {string} id @returns {Promise<string | null>} */
  async function record(id) {
    const out = modes.completion();
    if ("refusal" in out) { modes.completeProblem = out.refusal; return null; }
    if (busy) return null;
    const { item, fields } = out;
    busy = { id, kind: "complete" };
    modes.completeProblem = null;
    modes.recording = true;
    try {
      const nextDate = dueDateIn(await applyCommand(completeCommand(item, fields)), item.householdId, item.id);
      modes.cancelComplete();
      if (!nextDate) leave(id);
      await landed({ leaves: !nextDate }, `Completed${nextDate ? ` · next due ${dayMonth(nextDate)}` : ""} · ${item.title}`);
      return nextDate;
    } catch (error) {
      modes.completeProblem = wordsOf(error, "couldn't complete it — try again");
      return null;
    } finally {
      busy = null;
      modes.recording = false;
    }
  }

  return {
    modes,
    get busy() { return busy; },
    get preview() { return preview; },
    set preview(paper) { preview = paper; },
    get searchDocuments() { return searchDocuments; },
    get papersReady() { return papersReady; },
    startAmend, addAmended,
    openPreview, closePreview, removePaper, restorePaper,
    loadSearchDocuments, rereadSearchDocuments,
    copyLink, runRowAct, attach, pickChoice, save, record,
  };
}
