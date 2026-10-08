/**
 * WHAT HOME'S ITEM DRAWER IS DOING BESIDES READING (#1319 stage 2;
 * owner-decisions §34; design/v19/belt-purpose/round-8/m-colour-per-option.html).
 * Held by the screen (the desk's +page.svelte, the phone's pocket.svelte),
 * as the EditSession it wraps is, because the chooser card stands where the
 * screen seats it: beside the drawer in the preview's column, or the
 * phone's bottom sheet.
 *
 * Three things, one at a time:
 *   editing     the rows' own values live (EditSession, edit-session.svelte.js)
 *   completing  the rows ask for the completion: the date (today, through
 *               the calendar), the cost entered before and the notes, all
 *               editable (owner, 2026-10-08, on #1319)
 *   snoozing    the calendar beside the drawer, "snooze until" (owner,
 *               2026-10-08: "pick a date should not be removed")
 * and at most one chooser card open for any of them.
 */
import { EditSession } from "$lib/editing/edit-session.svelte.js";
import { chooserAskOf, draftOf } from "$lib/editing/item-draft.js";
import { COST_FORMAT_HINT, minorOf } from "../create/entry.js";

/**
 * @typedef {import('$lib/data/commands.js').CommandItem} CommandItem
 * @typedef {{ id: string, completedDate: string, cost: string, notes: string }} CompleteDraft
 * @typedef {{ key: "snooze" | "done", label: string, from: HTMLElement }} FootChoosing
 * @typedef {Omit<import('$lib/editing/item-draft.js').ChooserAsk, "key"> & {
 *   key: import('$lib/editing/item-draft.js').ChooserAsk["key"] | "done",
 * }} Ask  what the chooser card is asked; "done" is the completion's date
 * @typedef {{ id: string, name: string, icon?: string, visible?: boolean }} SectionChoice
 */

export class DrawerModes {
  /** @type {EditSession} */
  edit;
  /** @type {CompleteDraft | null} */
  completing = $state(null);
  /** @type {string | null} */
  completeProblem = $state(null);
  /** The snooze or completion calendar, when it is the one open. @type {FootChoosing | null} */
  foot = $state.raw(null);
  /** The item snoozing or completing. @type {CommandItem | null} */
  #item = null;
  /** @type {() => void} */
  #onchoose;

  /**
   * @param {{
   *   save: (item: CommandItem, edits: Partial<CommandItem>) => Promise<unknown>,
   *   onchoose?: () => void,
   * }} options  as EditSession's: `onchoose` hears any chooser opening, so
   *   the screen puts the preview away (one card beside at a time)
   */
  constructor({ save, onchoose = () => {} }) {
    this.#onchoose = onchoose;
    this.edit = new EditSession({ save, onchoose });
  }

  /** The item the drawer is editing, completing or snoozing, by id. */
  get id() {
    return this.edit.id ?? this.completing?.id ?? (this.foot ? this.#item?.id ?? null : null);
  }
  /** Whether a chooser card stands beside the drawer. */
  get choosing() {
    return Boolean(this.edit.choosing || this.foot);
  }
  /** The open chooser's key, for the row that is lit. */
  get choosingKey() {
    return this.edit.choosing?.key ?? this.foot?.key ?? null;
  }

  /**
   * What the chooser card is asked, or null when none is open.
   * @param {SectionChoice[]} sections  the item's household's
   * @param {string} today
   * @returns {Ask | null}
   */
  askOf(sections, today) {
    const { choosing, draft } = this.edit;
    if (choosing && draft) return chooserAskOf(choosing, draft, sections, today);
    const foot = this.foot;
    if (!foot) return null;
    if (foot.key === "done") {
      return { key: "done", label: foot.label, heading: "completed on", today, choices: [],
        value: this.completing?.completedDate ?? today };
    }
    const until = this.#item?.snoozedUntil;
    return { key: "snooze", label: foot.label, heading: "snooze until", today, choices: [],
      value: until && until > today ? until : null };
  }

  /** The pencil: the rows go live. @param {CommandItem} item */
  startEdit(item) {
    this.cancelComplete();
    this.foot = null;
    this.edit.start(item);
  }

  /**
   * Complete: the rows ask for the date (today), the cost entered before
   * and the notes, all editable, until it is recorded or cancelled.
   * @param {CommandItem} item @param {string} today
   */
  startComplete(item, today) {
    this.edit.cancel();
    this.foot = null;
    this.#item = item;
    const { cost, notes } = draftOf(item);
    this.completing = { id: item.id, completedDate: today, cost, notes };
    this.completeProblem = null;
  }

  /**
   * Snooze: the calendar beside the drawer; pressed again, it goes.
   * @param {CommandItem} item @param {HTMLElement} from
   */
  snooze(item, from) {
    if (this.foot?.key === "snooze" && this.#item?.id === item.id) { this.closeChooser(true); return; }
    this.edit.cancel();
    this.cancelComplete();
    this.#item = item;
    this.foot = { key: "snooze", label: "snooze until", from };
    this.#onchoose();
  }

  /** The completion's date pressed: the calendar beside. @param {HTMLElement} from */
  chooseDone(from) {
    if (!this.completing) return;
    if (this.foot?.key === "done") { this.closeChooser(true); return; }
    this.foot = { key: "done", label: "completed on", from };
    this.#onchoose();
  }

  /** @param {boolean} refocus  focus back to the pressed value */
  closeChooser(refocus) {
    if (this.edit.choosing) this.edit.closeChooser(refocus);
    const foot = this.foot;
    if (!foot) return;
    this.foot = null;
    if (refocus && foot.from.isConnected) foot.from.focus({ preventScroll: true });
  }

  /**
   * The card's pick. The row takes it; a snooze's day is handed back for
   * the screen to send.
   * @param {string} value
   * @returns {{ item: CommandItem, until: string } | null}
   */
  pick(value) {
    const foot = this.foot;
    if (foot?.key === "snooze") {
      const item = this.#item;
      this.closeChooser(true);
      return item ? { item, until: value } : null;
    }
    if (foot?.key === "done") {
      if (this.completing) this.completing.completedDate = value;
      this.closeChooser(true);
      return null;
    }
    this.edit.pick(value);
    return null;
  }

  /**
   * The completion as completeCommand takes it -- what happened, never the
   * next date, which the engine works out (#1324); or why it cannot be
   * recorded yet.
   * @returns {{ refusal: string } | { item: CommandItem, fields: { completedDate: string, costMinor?: number, notes?: string } }}
   */
  completion() {
    const draft = this.completing;
    const item = this.#item;
    if (!draft || !item) return { refusal: "not yet — nothing to record" };
    const costMinor = minorOf(draft.cost);
    if (costMinor !== undefined && Number.isNaN(costMinor)) return { refusal: `not yet — ${COST_FORMAT_HINT.toLowerCase()}` };
    if (!draft.completedDate) return { refusal: "not yet — choose the day it was done" };
    return { item, fields: { completedDate: draft.completedDate, costMinor, notes: draft.notes.trim() || undefined } };
  }

  cancelComplete() {
    if (this.foot?.key === "done") this.foot = null;
    this.completing = null;
    this.completeProblem = null;
  }

  /**
   * Escape: the chooser first, then the edit or the completion. True when
   * it took the key.
   */
  escape() {
    if (this.choosing) { this.closeChooser(true); return true; }
    if (this.edit.id) { this.edit.cancel(); return true; }
    if (this.completing) { this.cancelComplete(); return true; }
    return false;
  }

  /** The drawer closed, or another opened: everything ends. */
  end() {
    this.edit.cancel();
    this.cancelComplete();
    this.foot = null;
    this.#item = null;
  }
}

/**
 * Whether a press is on the chooser card, or on a value that opens one
 * (which toggles or switches it itself): any other press puts the card away.
 * @param {EventTarget | null} target
 */
export const pressKeepsChooser = (target) =>
  target instanceof Element && Boolean(target.closest("[data-chooser-card], [data-pick]"));
