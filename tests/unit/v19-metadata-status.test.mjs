import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * What a member is told when a Tier 1 field cannot be shown (#941, and the
 * design ruling of 2026-09-10).
 *
 * Two halves. The first pins the vocabulary itself, which is a pure module for
 * exactly this reason: four screens say these two states, and four screens
 * saying them four slightly different ways is the failure the module prevents.
 *
 * The second reads the screens' own source. A Svelte component has no runner
 * in this suite -- web/'s own tests are Playwright -- so the wiring is proved
 * the way v19-belt.test.mjs proves home's belt data: against the file that ships.
 * These are not decorative assertions. "The panel shows the damaged state
 * before a save can clear it" is the entire justification for letting a
 * full-row upsert overwrite a field nobody touched, so if the placeholder ever
 * stops being wired the licence to overwrite goes with it.
 */
import {
  COST_LOCKED, DAMAGED, LOCKED, NOTES_WORDS, PANEL_LOCKED, REFERENCE_WORDS, SAVE_REFUSED,
  evidenceReadable, fieldState, itemLocked, receiptWords, saveProblem,
} from "../../web/src/lib/data/metadata-status.js";

const read = (path) => readFileSync(new URL(`../../web/src/${path}`, import.meta.url), "utf8");
/* #1319: the belt's item page is gone; home's item drawer carries the item. */
const ITEM_DRAWER = read("routes/home/ItemDrawer.svelte");
const EDIT_ROWS = read("routes/home/EditRows.svelte");
const EDIT_SESSION = read("lib/editing/edit-session.svelte.js");
const SUGGESTION = read("routes/home/SuggestionView.svelte");
const INBOX = read("routes/inbox/+page.svelte");
/* #1151 W1-Q11/W1-Q14: the inbox's own READ-mark confidence logic (its old
   local mark()) was retired in favour of review.js's shared readingsOf(),
   which carries the identical evidenceReadable gate — read separately so
   the suppression can still be pinned at its real source. */
const REVIEW = read("lib/pocket/review.js");
const ADMINISTRATION = read("routes/administration/+page.svelte");
const HOME_DETAIL = read("routes/home/ItemView.svelte");

describe("the two states a member learns once", () => {
  it("says damaged is gone and locked is waiting, and never the other way round", () => {
    // Damaged: unrecoverable, and retyping is the repair.
    expect(REFERENCE_WORDS[DAMAGED]).toBe("damaged — can't be recovered");
    expect(NOTES_WORDS[DAMAGED]).toContain("damaged beyond recovery");
    expect(NOTES_WORDS[DAMAGED]).toContain("Typing new notes replaces it.");
    // Locked: intact, reversible, and an administrator is who fixes it.
    expect(REFERENCE_WORDS[LOCKED]).toBe("locked — safe, but unreadable right now");
    expect(NOTES_WORDS[LOCKED]).toContain("They're intact");
    expect(NOTES_WORDS[LOCKED]).toContain("an administrator restores Orbit's encryption key");
    // Neither state ever tells a member to despair about the other's data, and
    // no member-facing string names a key mechanic or a count.
    expect(NOTES_WORDS[LOCKED]).not.toContain("recover");
    for (const words of [...Object.values(REFERENCE_WORDS), ...Object.values(NOTES_WORDS), PANEL_LOCKED, COST_LOCKED, SAVE_REFUSED]) {
      expect(words).not.toMatch(/KEK|DOCUMENT_KEK|key[- ]encryption/i);
    }
  });

  it("reads only the two markers the API sends, and invents no third", () => {
    expect(fieldState({ notes: DAMAGED }, "notes")).toBe(DAMAGED);
    expect(fieldState({ reference: LOCKED }, "reference")).toBe(LOCKED);
    expect(fieldState({ notes: "something_new" }, "notes")).toBeNull();
    expect(fieldState(null, "notes")).toBeNull();
    expect(fieldState(undefined, "reference")).toBeNull();
  });

  it("treats one locked field as the whole item locked, because the write is the whole row", () => {
    expect(itemLocked({ notes: LOCKED })).toBe(true);
    expect(itemLocked({ reference: LOCKED })).toBe(true);
    // Damage does not pause anything: overwriting a damaged value is the repair.
    expect(itemLocked({ notes: DAMAGED, reference: DAMAGED })).toBe(false);
    expect(itemLocked(null)).toBe(false);
  });

  it("drops the from-document marks when their evidence is damaged, and nothing else", () => {
    expect(evidenceReadable({ fieldEvidence: DAMAGED })).toBe(false);
    expect(evidenceReadable({ proposal: DAMAGED })).toBe(true);
    expect(evidenceReadable(null)).toBe(true);
  });

  it("gives a mail-in message the words its state actually earns", () => {
    expect(receiptWords({ proposal: LOCKED })).toContain("This message is locked");
    expect(receiptWords({ proposal: LOCKED })).toContain("an administrator restores the encryption key");
    expect(receiptWords({ proposal: DAMAGED })).toContain("still in your mailbox");
    expect(receiptWords({ proposal: DAMAGED })).toContain("forward it again");
    // fieldEvidence alone loses provenance, not the message.
    expect(receiptWords({ fieldEvidence: DAMAGED })).toBeNull();
    expect(receiptWords(null)).toBeNull();
  });

  it("rewrites only the locked refusal, and keeps the server's words for everything else", () => {
    expect(saveProblem({ code: "metadata_locked", message: "Encrypted details cannot be saved until the encryption key is available" }))
      .toBe(SAVE_REFUSED);
    expect(SAVE_REFUSED).toContain("The stored values are intact.");
    expect(saveProblem({ code: "version_conflict", message: "This item changed on another device; refresh and try again" }))
      .toBe("This item changed on another device; refresh and try again");
  });
});

describe("the item drawer wires both states where they have to be seen", () => {
  it("says the same two things in home's expanded detail, which shows the same two fields", () => {
    // Not a second vocabulary: the same module, so a member who learns the
    // words on one screen has learned them on the other. The reference row
    // renders on the marker as well as on the value (the failure this
    // replaces: `{#if row.reference}` alone, which showed a field Orbit could
    // not read as one nobody had filled in). The damaged mark is inbox.css's
    // .failed dot; locked carries no degraded colour, because waiting is not
    // failure.
    expect(HOME_DETAIL).toContain('from "$lib/data/metadata-status.js"');
    expect(HOME_DETAIL).toContain("{:else if referenceState === DAMAGED}");
    expect(HOME_DETAIL).toContain("{:else if referenceState === LOCKED}");
    expect(HOME_DETAIL).toContain("REFERENCE_WORDS[DAMAGED]");
    expect(HOME_DETAIL).toContain("REFERENCE_WORDS[LOCKED]");
    expect(HOME_DETAIL).toContain('<b class="failed"><i aria-hidden="true"></i>');
    expect(HOME_DETAIL).toContain('<b class="locked">');
    // The notes paragraph is replaced by the words, not left blank.
    expect(HOME_DETAIL).toContain("{:else if notesState}");
    expect(HOME_DETAIL).toContain("NOTES_WORDS[notesState]");
  });

  it("says them on the phone's drawer too, from the same module", () => {
    expect(ITEM_DRAWER).toContain('from "$lib/data/metadata-status.js"');
    expect(ITEM_DRAWER).toContain("REFERENCE_WORDS[referenceState]");
    expect(ITEM_DRAWER).toContain("NOTES_WORDS[notesState]");
  });

  it("locks only the cost figure in the complete rows, because a no-cost completion needs no key (#972)", () => {
    // item.complete only reaches for the metadata writer when a cost is
    // supplied, so a locked household can still complete without one: the
    // date and notes stay live, and only the cost value and its explanation
    // are gated on `costLocked`. (The belt's edit panel, which also paused
    // every input while locked and showed a damaged placeholder, retired with
    // the belt in #1319; the drawer edits in place with no such panel.)
    const completing = EDIT_ROWS.slice(EDIT_ROWS.indexOf("{:else if completing}"), EDIT_ROWS.indexOf("</div>\n\n<style>"));
    expect(completing).toContain("{#if costLocked}");
    expect(completing).toContain("{COST_LOCKED}");
    expect(completing.match(/costLocked/g)).toHaveLength(2);
    expect(completing).toContain('data-ed="notes"');
    expect(completing).toContain("chooseDone(");
    expect(completing).not.toContain("{PANEL_LOCKED}");
    expect(HOME_DETAIL).toContain("costLocked={itemLocked(detail.metadataStatus)}");
    expect(ITEM_DRAWER).toContain("costLocked={itemLocked(raw?.metadataStatus)}");
  });

  it("surfaces a stale submit in the alert slot the drawer already has", () => {
    expect(HOME_DETAIL).toContain('<div class="ivproblem" role="alert">{acts.problem}</div>');
    expect(ITEM_DRAWER).toContain('role="alert">{problem ?? acts?.problem}</p>');
    expect(EDIT_SESSION).toContain("saveProblem(");
  });
});

describe("the mail-in review surfaces", () => {
  it("keeps a locked message queued, with nothing to review and nothing to accept", () => {
    expect(INBOX).toContain("{unreadable(receipt)}");
    // Hidden, not disabled: there is nothing on the amend card to amend.
    expect(INBOX).toContain("{#if !locked(receipt)}");
    expect(INBOX).toContain("disabled={busy === receipt.id || locked(receipt)}");
    // Dismiss is untouched, so a receipt is never trapped.
    expect(INBOX).toContain('<button disabled={busy === receipt.id} onclick={() => tap(receipt, "dismiss")}>');
  });

  it("leaves a damaged message every action, because re-forwarding is a real repair", () => {
    // `locked()` alone gates the two removals above, so damaged keeps them.
    expect(INBOX).toContain('fieldState(receipt.metadataStatus, "proposal") === LOCKED');
    expect(SUGGESTION).toContain("const locked = $derived(reviewLockedOf(suggestion));");
    expect(SUGGESTION).toContain("disabled={busy || locked}");
  });

  it("suppresses the READ marks when their evidence is damaged", () => {
    // #1151 W1-Q11/W1-Q14: the inbox dropped its own copy of this gate and
    // now reads review.js's shared readingsOf() instead — the suppression
    // itself lives there now, so it is pinned there, and the inbox is only
    // checked for actually wiring that shared helper in.
    expect(INBOX).toContain('import { papersOf, readingsOf } from "$lib/pocket/review.js";');
    expect(INBOX).toContain("readingsOf(receipt)");
    expect(REVIEW).toContain("if (!evidenceReadable(mail.metadataStatus)) return null;");
  });
});

describe("the administrator's aggregate", () => {
  it("earns zero pixels when nothing is wrong, and states the remedy when something is", () => {
    expect(ADMINISTRATION).toContain("{#if view.metadata.locked}");
    expect(ADMINISTRATION).toContain("{#if view.metadata.damagedValues > 0}");
    expect(ADMINISTRATION).toContain("<h2>Encrypted details are locked</h2>");
    expect(ADMINISTRATION).toContain("<h2>Damaged encrypted details</h2>");
    // #956's composition, reused rather than reinvented: card wide, no buttons.
    // Three of them in this region since #968: locked, damaged, and the
    // recovery-bundle card, which joined the same family rather than drawing
    // its own. The bundle card's own content is pinned by
    // tests/unit/v19-recovery-bundle-card.test.mjs; what this asserts is that
    // the composition stayed shared.
    const cards = ADMINISTRATION.slice(ADMINISTRATION.indexOf("{#if view.metadata}"), ADMINISTRATION.indexOf("<h2>People</h2>"));
    expect(cards.match(/class="card wide rotation"/g)).toHaveLength(3);
    expect(cards).not.toContain("<button");
    expect(cards).toContain("in the administrator guide has the steps.");
    // The honest caveat about sightings-based counting survives.
    expect(cards).toContain("Counted as they're encountered");
  });

  it("shows a member no count and no key mechanic", () => {
    for (const screen of [ITEM_DRAWER, SUGGESTION, INBOX, HOME_DETAIL]) {
      expect(screen).not.toContain("damagedValues");
      expect(screen).not.toContain("lockedItems");
      expect(screen).not.toMatch(/KEK|key-encryption key/);
    }
  });
});
