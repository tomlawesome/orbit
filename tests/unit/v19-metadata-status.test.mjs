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
 * the way v19-belt.test.mjs proves the belt's: against the file that ships.
 * These are not decorative assertions. "The panel shows the damaged state
 * before a save can clear it" is the entire justification for letting a
 * full-row upsert overwrite a field nobody touched, so if the placeholder ever
 * stops being wired the licence to overwrite goes with it.
 */
import {
  DAMAGED, DAMAGED_PLACEHOLDER, LOCKED, NOTES_WORDS, PANEL_LOCKED, REFERENCE_WORDS, SAVE_REFUSED,
  evidenceReadable, fieldState, itemLocked, receiptWords, saveProblem,
} from "../../web/src/lib/data/metadata-status.js";

const read = (path) => readFileSync(new URL(`../../web/src/${path}`, import.meta.url), "utf8");
const ITEM_PAGE = read("routes/item/[id]/+page.svelte");
const SUGGESTION = read("routes/item/[id]/Suggestion.svelte");
const INBOX = read("routes/inbox/+page.svelte");
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
    for (const words of [...Object.values(REFERENCE_WORDS), ...Object.values(NOTES_WORDS), PANEL_LOCKED, SAVE_REFUSED]) {
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

describe("the item screen wires both states where they have to be seen", () => {
  it("renders the reference row on the marker as well as on the value", () => {
    // The failure this replaces: `{#if row.reference}` alone, which showed a
    // field Orbit could not read as one nobody had filled in.
    expect(ITEM_PAGE).toContain("{:else if referenceState === DAMAGED}");
    expect(ITEM_PAGE).toContain("{:else if referenceState === LOCKED}");
    expect(ITEM_PAGE).toContain("REFERENCE_WORDS[DAMAGED]");
    expect(ITEM_PAGE).toContain("REFERENCE_WORDS[LOCKED]");
    // The damaged mark is inbox.css's .failed dot; locked carries no degraded
    // colour, because waiting is not failure.
    expect(ITEM_PAGE).toContain('<b class="failed"><i aria-hidden="true"></i>');
    expect(ITEM_PAGE).toContain('<b class="locked">');
  });

  it("replaces the notes paragraph rather than leaving it blank", () => {
    expect(ITEM_PAGE).toContain("{:else if notesState}");
    expect(ITEM_PAGE).toContain("NOTES_WORDS[notesState]");
  });

  it("says the same two things in home's expanded detail, which shows the same two fields", () => {
    // Not a second vocabulary: the same module, so a member who learns the
    // words on one screen has learned them on the other.
    expect(HOME_DETAIL).toContain('from "$lib/data/metadata-status.js"');
    expect(HOME_DETAIL).toContain("{:else if referenceState === DAMAGED}");
    expect(HOME_DETAIL).toContain("{:else if referenceState === LOCKED}");
    expect(HOME_DETAIL).toContain("{:else if notesState}");
  });

  it("shows a damaged field's state IN the edit panel, before a save can clear it", () => {
    /* The build rule this pins (ruling, 2026-09-10): a panel whose damaged
       field was not touched still writes it, seeded empty, because item.upsert
       is a full-row write. That is acceptable ONLY because the panel shows the
       damaged state first -- a member saving past a visible placeholder has
       decided. Visibility is the guard, so it is asserted, not assumed. */
    const editPanel = ITEM_PAGE.slice(ITEM_PAGE.indexOf('{#if panel === "edit"}'), ITEM_PAGE.indexOf('{#if panel === "retire"}'));
    expect(editPanel).toContain('placeholder={referenceState === DAMAGED ? DAMAGED_PLACEHOLDER : "optional"}');
    expect(editPanel).toContain('placeholder={notesState === DAMAGED ? DAMAGED_PLACEHOLDER : "optional"}');
    expect(DAMAGED_PLACEHOLDER).toBe("damaged — whatever you save replaces it");
    // Damaged never disables anything: overwriting is the repair.
    expect(editPanel).not.toContain("disabled={busy || referenceState");
    expect(editPanel).not.toContain("disabled={notesState");
  });

  it("pauses the whole panel while the item is locked, not only its encrypted fields", () => {
    const editPanel = ITEM_PAGE.slice(ITEM_PAGE.indexOf('{#if panel === "edit"}'), ITEM_PAGE.indexOf('{#if panel === "retire"}'));
    // Every input, because the refused write is the whole row.
    for (const field of ["e-title", "e-provider", "e-reference", "e-cost", "e-due", "e-recur", "e-notes"]) {
      const input = editPanel.slice(editPanel.indexOf(`id="${field}"`));
      expect(input.slice(0, input.indexOf("</div>"))).toContain("disabled={locked}");
    }
    expect(editPanel).toContain("disabled={busy || locked || !form.title?.trim()}");
    expect(editPanel).toContain("{PANEL_LOCKED}");

    const completePanel = ITEM_PAGE.slice(ITEM_PAGE.indexOf('{#if panel === "complete"}'), ITEM_PAGE.indexOf('{#if panel === "reschedule"}'));
    expect(completePanel).toContain("disabled={busy || locked || !form.completedDate}");
    expect(completePanel).toContain("{PANEL_LOCKED}");
  });

  it("surfaces a stale submit in the alert slot the panel already has", () => {
    expect(ITEM_PAGE).toContain('<div class="problem" role="alert">{problem}</div>');
    expect(ITEM_PAGE).toContain("problem = saveProblem(");
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
    expect(SUGGESTION).toContain("disabled={busy || proposalLocked || !sform.title.trim()}");
  });

  it("suppresses the READ marks when their evidence is damaged", () => {
    expect(INBOX).toContain("if (!evidenceReadable(receipt.metadataStatus)) return null;");
    expect(SUGGESTION).toContain("const marked = (field) => evidenceShown && Boolean(item?.fieldEvidence?.[field]);");
  });
});

describe("the administrator's aggregate", () => {
  it("earns zero pixels when nothing is wrong, and states the remedy when something is", () => {
    expect(ADMINISTRATION).toContain("{#if view.metadata.locked}");
    expect(ADMINISTRATION).toContain("{#if view.metadata.damagedValues > 0}");
    expect(ADMINISTRATION).toContain("<h2>Encrypted details are locked</h2>");
    expect(ADMINISTRATION).toContain("<h2>Damaged encrypted details</h2>");
    // #956's composition, reused rather than reinvented: card wide, no buttons.
    const cards = ADMINISTRATION.slice(ADMINISTRATION.indexOf("{#if view.metadata}"), ADMINISTRATION.indexOf("<h2>People</h2>"));
    expect(cards.match(/class="card wide rotation"/g)).toHaveLength(2);
    expect(cards).not.toContain("<button");
    expect(cards).toContain("in the administrator guide has the steps.");
    // The honest caveat about sightings-based counting survives.
    expect(cards).toContain("Counted as they're encountered");
  });

  it("shows a member no count and no key mechanic", () => {
    for (const screen of [ITEM_PAGE, SUGGESTION, INBOX, HOME_DETAIL]) {
      expect(screen).not.toContain("damagedValues");
      expect(screen).not.toContain("lockedItems");
      expect(screen).not.toMatch(/KEK|key-encryption key/);
    }
  });
});
