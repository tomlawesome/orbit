/**
 * ONE ITEM BEING EDITED IN ITS DRAWER (#1319; owner-decisions §34;
 * design/v19/belt-purpose/round-8/m-colour-per-option.html): the item, the
 * rows' draft (item-draft.js), the chooser open beside the drawer if any,
 * and the save. Held by the screen (home's desk page, the pocket) rather
 * than the drawer, because the chooser card stands where the screen seats
 * it — beside the drawer in the preview's column, or the phone's bottom
 * sheet — and the desk's title edits in the row's head, outside the drawer.
 *
 * One at a time: starting another item's edit, or the drawer closing, ends
 * this one (the screens' own effects say when).
 */
import { tick } from "svelte";
import { upsertCommand } from "$lib/data/commands.js";
import { dryRunner } from "$lib/data/dry-run.js";
import { saveProblem } from "$lib/data/metadata-status.js";
import { draftOf, editsOf } from "./item-draft.js";

/**
 * The command a dry run asks about for these edits: the item's own upsert;
 * for a suggestion, which is not an item yet, the upsert of the new item it
 * would become, which meets the same "not yet" rules (ADR-0034, #1325).
 * @param {import('$lib/data/commands.js').CommandItem} item
 * @param {import('$lib/data/commands.js').ItemEdits} edits
 * @param {string} newId  a stand-in id for a suggestion's would-be item
 */
export function checkedCommandOf(item, edits, newId) {
  if (item.status !== "suggested") return upsertCommand(item, edits);
  const { version: _version, updatedAt: _updated, subtype: _subtype, scheduleKind: _schedule, ...fields } = item;
  return upsertCommand({ ...fields, id: newId }, edits);
}

/**
 * @typedef {"due" | "section" | "type" | "months"} ChooserKey
 * @typedef {{ key: ChooserKey, label: string, from: HTMLElement }} Choosing
 * @typedef {import('$lib/data/commands.js').CommandItem} CommandItem
 */

export class EditSession {
  /** The item being edited, by id; null when nothing is. @type {string | null} */
  id = $state(null);
  /** @type {import('./item-draft.js').Draft | null} */
  draft = $state(null);
  /** The value whose chooser stands beside the drawer. @type {Choosing | null} */
  choosing = $state.raw(null);
  busy = $state(false);
  /** A save's failure, said until the next attempt. @type {string | null} */
  problem = $state(null);
  /** The engine's last word on the rows (ADR-0034): null when they can be
      saved, its refusal otherwise. @type {string | null} */
  refusal = $state(null);
  /** Whether the engine has answered for these rows yet. */
  answered = $state(false);
  /** @type {CommandItem | null} */
  #item = null;
  /** @type {(item: CommandItem, edits: Partial<CommandItem>) => Promise<unknown>} */
  #save;
  /** @type {() => void} */
  #onchoose;
  /** The item the dry run last opened on. @type {string | null} */
  #askedFor = null;
  #newId = crypto.randomUUID();
  #dryRun = dryRunner({ onanswer: (answer) => { this.refusal = answer; this.answered = true; } });

  /**
   * @param {{
   *   save: (item: CommandItem, edits: Partial<CommandItem>) => Promise<unknown>,
   *   onchoose?: () => void,
   * }} options  `save` sends the edits and reads the item again; it throws
   *   the server's refusal. `onchoose` hears a chooser opening, so the
   *   screen can put the preview away (one card beside at a time).
   */
  constructor({ save, onchoose = () => {} }) {
    this.#save = save;
    this.#onchoose = onchoose;
    /* Every change to the rows asks the engine again, ~300 ms after the last;
       opening asks at once. */
    $effect(() => {
      const draft = this.draft;
      const id = this.id;
      if (!draft || !id) { this.#askedFor = null; this.#dryRun.stop(); return; }
      JSON.stringify(draft); // every row is the question
      const build = () => this.#checked();
      if (this.#askedFor === id) this.#dryRun.ask(build);
      else { this.#askedFor = id; this.#dryRun.now(build); }
    });
  }

  /** Whether the save waits on the engine: no answer yet, or a refusal. */
  get refused() {
    return !this.answered || this.refusal !== null;
  }

  /** The command the rows would send now, for the dry run. */
  #checked() {
    const item = this.#item;
    const draft = this.draft;
    return item && draft ? checkedCommandOf(item, editsOf($state.snapshot(draft)), this.#newId) : null;
  }

  /** @param {CommandItem} item */
  start(item) {
    this.#item = item;
    this.id = item.id;
    this.draft = draftOf(item);
    this.choosing = null;
    this.problem = null;
    this.refusal = null;
    this.answered = false;
  }

  /** The item again, after a re-read, so a save answers its newest version. @param {CommandItem} item */
  rebase(item) {
    if (this.id === item.id) this.#item = item;
  }

  cancel() {
    this.id = null;
    this.draft = null;
    this.choosing = null;
    this.problem = null;
    this.refusal = null;
    this.answered = false;
    this.#item = null;
  }

  /**
   * A value pressed: its chooser stands beside the drawer; pressed again,
   * it goes.
   * @param {ChooserKey} key @param {string} label @param {HTMLElement} from
   */
  choose(key, label, from) {
    if (this.choosing?.key === key) { this.closeChooser(true); return; }
    this.choosing = { key, label, from };
    this.#onchoose();
  }

  /** @param {boolean} refocus  focus back to the pressed value */
  closeChooser(refocus) {
    const from = this.choosing?.from;
    this.choosing = null;
    if (refocus && from?.isConnected) from.focus({ preventScroll: true });
  }

  /** The chooser's pick: the row takes it, and the chooser goes. @param {string} value */
  pick(value) {
    const draft = this.draft;
    const key = this.choosing?.key;
    if (draft && key === "due") draft.dueDate = value;
    else if (draft && key === "section") draft.sectionId = value;
    else if (draft && key === "type") draft.kind = value;
    else if (draft && key === "months") draft.recurrence = Number(value);
    this.closeChooser(true);
  }

  /**
   * Save: held while the engine refuses the rows (its dry run's words stand
   * under them); the server's refusal at the save said loudly (#1058), the
   * locked one in the member's own words (#941). True when it landed.
   */
  async commit() {
    const item = this.#item;
    const draft = this.draft;
    if (!item || !draft || this.busy) return false;
    if (this.refusal !== null) return false;
    this.#dryRun.stop();
    this.busy = true;
    this.problem = null;
    this.closeChooser(false);
    try {
      await this.#save(item, editsOf($state.snapshot(draft)));
      if (this.id === item.id) this.cancel();
      await tick();
      return true;
    } catch (error) {
      const words = saveProblem(/** @type {{ code?: string, message?: string }} */ (error));
      /* already in the refusal vocabulary ("not saved — …", or a
         suggestion's "not added — …") — said as it is */
      this.problem = /^not [a-z]+ —/i.test(words) ? words : `not saved — ${words}`;
      return false;
    } finally {
      this.busy = false;
    }
  }
}
