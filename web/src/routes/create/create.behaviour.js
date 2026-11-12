import { uuid } from "$lib/uuid.js";
import { goto } from "$app/navigation";
import {
  WorkspaceError, activeHousehold, bindRefused, applyCommand, checkDraftCommand, discardStagedDocument, readReminders, refusesFile, stageDocument, unsavedWords,
  wordsOf, notSavedWords, readDueReckoning,
} from "$lib/data/workspace.js";
import {
  ALREADY_HEAD, NOTHING_READ, RENEW_ADD, YOU_HOLD, addedDay, dueWords, keptWords, renewalDays,
} from "$lib/data/already-held.js";
import {
  CAP_ATTACHED, CAP_READING, CHECKING_HEAD, WHY_CHECKING, FOCUS_REFUSED, FOCUS_SCANNING, undrawnFocus, PAGE_HEAD, READING_HEAD, WHY_READING, WHY_REFUSED,
  WHY_UNDRAWABLE, DOCUMENT_ACCEPT, captionOf, focusAfterScan, readPickedDocument, suggestionsToCarry,
} from "$lib/data/document-read.js";
import { saveProblem } from "$lib/data/metadata-status.js";
import { screenScope } from "$lib/teardown.js";
import { takeHeldDocument } from "$lib/data/held-document.js";
import { addedWords, wireDropFeedback } from "./drop-feedback.js";
import { dryRunner } from "$lib/data/dry-run.js";
import { sectionColourOf } from "$lib/option-colour.js";
import { CHOOSE_IMPORTANCE } from "./entry.js";
import { REMINDER_DEFAULT, createCommandOf, reminderPairOf } from "./entry.js";
import { sizeLabel } from "$lib/format.js";

/**
 * @typedef {{
 *   date: () => string, setDate: (iso: string) => void, months: () => number,
 *   reminders: () => number[], setDefaultReminders: (days: number[]) => void,
 * }} Pickers  the page's own key date, repeat and reminders (#1468)
 */

/**
 * The new-entry form's behaviour, carried across from design/v19/create-v3.html
 * (#474/#475/#476, formerly design/family/create.html) and owned here from
 * that point on.
 *
 * The design's idea is progressive disclosure: the form opens as a name, five
 * type chips and a drop target, and unfolds the rest the moment you start.
 * `reveal()` is one-way — a form that folded back up while you were filling it
 * in would be worse than one that never folded.
 *
 * The owner's five #1058 create decisions, built here under #1069 (the sixth
 * and seventh — search and the second tap on mobile — are the pocket's own,
 * under #1057): no assignee; a section must be picked, with no default; kind
 * maps to a schedule (an inspection recurs, a document's date is optional and
 * never recurs, a suggestion schedules nothing); recurrence adds a fourth,
 * custom choice, 1–120 months; a save failure is loud, beside the button, and
 * nothing typed is lost. The mapping and the refusals are the engine's
 * (ADR-0034, #1325): the form sends what was typed and chosen
 * (`entry.js` createCommandOf, shared with the pocket's own form), and asks
 * the engine's dry run whether it could be saved.
 *
 * Three deliberate departures from the mockup:
 *
 *   1. The mockup's drop target calls `dropDocument()`, which after a 2.6s
 *      timer types "British Gas / BG-88214-HC / 2026-11-02" into the form
 *      and shows a sketched top sheet, to demonstrate what reading looks
 *      like. Here the same walk is real (#1245, the §14 ruling the owner
 *      restated 2026-10-07: "the front page gets scanned and turned into a
 *      preview and then shows whilst orbit simultaneously runs the
 *      extraction"): the drop target takes a real file, opens the form,
 *      splits the lanes (`body.doc`, ruling 3), names the entry after it,
 *      and `readDocument` below starts two requests from the pick at once —
 *      the household's pre-attachment preview route draws page one, and
 *      `body.snap` lands it on the top sheet the moment it arrives; the
 *      inspection route scans and reads the same bytes alongside, and what
 *      it read is typed into the empty fields marked `.sugg` ("◆ from
 *      document"), which `.accept` clears, as the mockup drew. Neither
 *      request keeps anything: the save stages the file, then binds it to
 *      the item in the one command that creates it, so the two are saved
 *      together or not at all (#1406). The mockup's lit
 *      marks went with its sketched page — a real page has no marks to
 *      light, so the fields carry that instead.
 *   2. The mockup's inline `onsubmit="return false"` is a listener here — a
 *      module has no globals for an inline handler to reach.
 *   3. `body.doc` is removed again in this module's teardown: the class lives
 *      on `<body>`, which outlives the screen, so leaving it on would be the
 *      same class of bug satellites.js's own doc warns about ("a blurred
 *      scrim survived a trip to /create").
 */
export function mountCreate({
  documentReading = true,
  importance = { get: () => /** @type {import('./entry.js').Entry["importance"]} */ (null), setColour: (/** @type {?string} */ _colour) => {} },
  /* #1468: the key date, the repeat and the reminders are the page's own state
     (pressed values that open the chooser card), read here at save. */
  pickers = /** @type {Pickers} */ ({
    date: () => "",
    setDate: () => {},
    months: () => 12,
    reminders: () => [...REMINDER_DEFAULT],
    setDefaultReminders: () => {},
  }),
} = {}) {
  const { on, teardown } = screenScope();

  const card = /** @type {HTMLElement} */ (document.getElementById("card"));
  const disclose = /** @type {HTMLElement} */ (document.getElementById("disclose"));
  const dropzone = document.getElementById("dropzone");
  const nameInput = /** @type {HTMLInputElement} */ (document.getElementById("f-name"));
  const sections = /** @type {HTMLElement} */ (document.getElementById("sections"));
  const fieldDate = document.getElementById("field-date");
  const costInput = document.getElementById("f-cost");
  const save = /** @type {HTMLButtonElement} */ (card.querySelector(".btn-primary"));
  const note = /** @type {HTMLElement} */ (document.getElementById("save-note"));

  const value = (/** @type {string} */ id) =>
    /** @type {HTMLInputElement} */ (document.getElementById(id)).value.trim();

  /** One-way: the form grows as you commit to it, and never shrinks back. */
  const reveal = () => disclose.classList.add("open");

  /** @type {string | null} */
  let chosenSection = null;
  let saving = false;
  /** Set the moment a save lands, so leaving for /home is never read as
      discarding what was typed. */
  let committed = false;
  /** #1437: set when the person follows the alert's link to the entry that
      already holds the file. Opening it is the alert's "instead of adding
      another", so leaving does not ask about discarding this one. */
  let leavingForHeld = false;
  /* Only until the next edit: after a save that kept the form open
     further typing is unsaved work again, and leaving must ask about it (#1151 W1-S1). Bound on the
     card, so every field's input or change bubbles to it; the type chips,
     the section buttons and a dropped file change the entry without either
     event, so their handlers call `edited` themselves. */
  const edited = () => { committed = false; };
  on(card, "input", edited);
  on(card, "change", edited);
  /** A message from the last save attempt (a loud failure), held until the
      NEXT attempt — same as the
      pocket's own `problem`, which nothing typed clears early. */
  /** @type {string | null} */
  let sticky = null;
  /** Minted once for this draft, not per save attempt (#1151 W1-R2): a retry
      after a dropped response reuses it, so the server's upsert-by-id
      idempotency absorbs the retry instead of creating a second item. */
  const draftId = uuid();

  /* A new entry starts from the member's own pair, which they can still change
     on the reminders' chips: the page keeps the pair until a chip is pressed. */
  readReminders()
    .catch(() => null)
    .then((reminders) => pickers.setDefaultReminders(reminderPairOf(reminders)));

  /** The form's own entry.js-shaped Entry (#1151 W1-Q9), read fresh each
   *  time and used for both the refusal check and the save payload below —
   *  entry.js is the one place the recurrence
   *  bound and the cost parsing live, shared with the pocket's own form
   *  (pocket.svelte's save() already calls createCommandOf this same way);
   *  this used to re-derive all four by hand instead, with its own,
   *  differently-gated recurrence condition. */
  /** @returns {import('./entry.js').Entry} */
  function entryFromForm() {
    return {
      name: nameInput.value,
      householdId: null,
      sectionId: chosenSection,
      provider: value("f-provider"),
      reference: value("f-ref"),
      dueDate: pickers.date(),
      recurrence: pickers.months(),
      cost: value("f-cost"),
      reminderDays: pickers.reminders(),
      notes: value("f-notes"),
      importance: importance.get(),
    };
  }

  /** The command the form would send now; the dry run asks about it and the save sends it. */
  function commandFromForm() {
    return createCommandOf(entryFromForm(), {
      householdId: household?.id ?? "", currency: household?.currency ?? "GBP", id: draftId,
    });
  }

  /** The engine's last word on the entry (ADR-0034): null when it can be
      saved, its refusal otherwise. Held until the first answer, as the
      section refusal (#1058b) held it before. */
  /** @type {string | null} */
  let refusal = "";
  /** Why the server refused the file held now, or null (#1406, owner's
      answer 6a): a refused file stays in the entry, marked with the
      server's words, and holds the save until it is replaced or removed,
      so no item is saved without the paper the member meant to attach. */
  /** @type {string | null} */
  let fileRefusal = null;
  /**
   * #1058b/#1058e: the save button stays held (`aria-disabled`, #1327: it
   * keeps its place in the tab order, and the submit handler ignores it)
   * while the engine has not answered or refuses the entry, its reason
   * beside it — quiet while it is only a refusal, loud
   * (see the `submit` handler's catch) once a save has actually failed.
   */
  /** @param {boolean} held */
  function holdSave(held) {
    if (held) save.setAttribute("aria-disabled", "true");
    else save.removeAttribute("aria-disabled");
  }
  /** The engine's word, else the one thing the form itself holds Add for (#1463). */
  const refusedNow = () => refusal ?? (importance.get() ? null : CHOOSE_IMPORTANCE);
  function showRefusal() {
    if (saving) return;
    holdSave(refusedNow() !== null || fileRefusal !== null);
    /* A sticky message from the last save attempt outranks the live refusal
       note until the next attempt clears it — typing does not erase it. */
    if (sticky) return;
    note.classList.remove("fail");
    note.removeAttribute("role");
    note.textContent = refusedNow() ?? "";
  }
  const dryRun = dryRunner({
    onanswer: (answer) => { refusal = answer; showRefusal(); },
    check: checkDraftCommand,
  });
  /** Something changed: ask the engine again once the member pauses. */
  function updateRefusal() {
    showRefusal();
    dryRun.ask(() => household ? commandFromForm() : null);
  }

  on(nameInput, "input", () => {
    if (nameInput.value.trim().length >= 3) reveal();
    updateRefusal();
  });

  /* ---- section (#1058b): a row of buttons, none pre-selected; the entry
     cannot be saved until one is chosen. Populated once the household loads
     — the same shape the type chips once were, drawn here rather than built as a
     second, Svelte-reactive way of doing the same job. Only the visible
     sections are offered, as the household's own management screen (and the
     pocket's EntryForm) already draw them. */
  /** @type {import('./entry.js').FormHousehold | null} */
  let household = null;
  activeHousehold()
    .then((loaded) => {
      household = loaded;
      sections.replaceChildren();
      for (const section of household.sections.filter((one) => one.visible)) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.section = section.id;
        button.setAttribute("aria-pressed", "false");
        const dot = document.createElement("span");
        dot.className = "sec-dot";
        dot.setAttribute("aria-hidden", "true");
        dot.style.background = `var(--sec-${section.accent})`;
        button.append(dot, section.name);
        on(button, "click", () => {
          for (const other of [...sections.querySelectorAll("button")]) other.setAttribute("aria-pressed", "false");
          button.setAttribute("aria-pressed", "true");
          chosenSection = section.id;
          edited();
          importance.setColour(sectionColourOf(section));
          reveal();
          updateRefusal();
        });
        sections.appendChild(button);
      }
      dryRun.now(commandFromForm);
    })
    .catch(() => {
      sections.textContent = "your sections could not load — reload the page and try again";
    });

  /* ---- the drop target ---- */

  /* Hidden rather than styled: the design draws the drop target itself as the
     control, so the input exists only to open the system file picker. */
  const picker = document.createElement("input");
  picker.type = "file";
  picker.hidden = true;
  picker.accept = DOCUMENT_ACCEPT;
  card.appendChild(picker);

  /* §14/#474: a document splits the screen — the form slides left and the
     reading lane fades in (create.css's `body.doc` rules). Body-level
     because the lanes and the backdrop's own dimming both key off it, same
     as home's launch classes; the mount's teardown below takes it off again,
     so it can never survive a trip to another screen (satellites.js's own
     warning: "a blurred scrim survived a trip to /create"). */
  const heldName = document.getElementById("dz-held-name");
  const heldSize = document.getElementById("dz-held-size");

  /** @type {File | null | undefined} */
  let attachment = null;
  /** Minted once per file picked, the way `draftId` is per draft (#1245):
      a retry after a lost answer re-sends the same id with the same bytes,
      so the documents route hands back the copy it already holds. */
  let attachmentId = "";
  /** #1437: the id the pick's stage stored the file under, so the save does
      not send the same bytes again; "" until a stage at the pick succeeds. */
  let stagedId = "";
  /** #1437: the pick's stage refused the file under this id. Held for the
      save, which answers it where and when a refusal always was (#1406),
      without sending the bytes a second time. */
  /** @type {{ id: string, error: unknown } | null} */
  let pickRefusal = null;
  /** The pick's stage while it is out, so an Add pressed meanwhile waits for
      it rather than sending the same bytes again. */
  /** @type {{ id: string, done: Promise<void> } | null} */
  let pickStaging = null;
  /** #1437: the pick's staged copy is let go -- the file was replaced,
      turned down or the form left unsaved -- so it stops counting toward
      the quotas now rather than when the sweep retires it. Never once the
      save has started: from the press the copy is the save's. */
  function letGoStaged() {
    if (!stagedId || saving || committed) return;
    const id = stagedId;
    stagedId = "";
    discardStagedDocument(id);
  }
  /** A new id for the file already held, once the server has retired its old one. */
  function reissueAttachmentId() {
    attachmentId = uuid();
  }
  function takeFile(/** @type {File | null | undefined} */ file) {
    /* From the press until the server answers, the entry is the server's:
       the file it holds cannot change under the save. */
    if (!file) return;
    /* Taken (or turned away): the input goes back to empty so choosing the
       same file again still fires `change`. */
    picker.value = "";
    if (saving) return;
    /* A new file replaces a refused one, and the refusal goes with it, the
       loud note about the save it refused included. */
    if (fileRefusal !== null) sticky = null;
    fileRefusal = null;
    letGoStaged();
    attachmentId = uuid();
    attachment = file;
    edited();
    reveal();
    document.body.classList.add("doc");
    if (heldName) heldName.textContent = file.name;
    if (heldSize) heldSize.textContent = sizeLabel(file.size);
    if (!nameInput.value.trim()) {
      nameInput.value = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
    }
    /* Through the live region that is never hidden, whatever the lane is doing. */
    dropFeedback.say(addedWords(file.name));
    /* The §14 walk, for real (#1245): page one and the read start together
       from the pick, and neither waits for the other. */
    readDocument(file).catch(() => { /* every outcome is drawn in the lane */ });
    updateRefusal();
  }

  /* ---- the reading lane (§14 ruling 3; design/v19/create-v3.html's `doc`
     and `snap` states) ---- */
  const readcard = /** @type {HTMLElement} */ (document.getElementById("readcard"));
  const readHead = /** @type {HTMLElement} */ (document.getElementById("read-head"));
  const focusline = /** @type {HTMLElement} */ (document.getElementById("focusline"));
  const focusWhy = /** @type {HTMLElement} */ (document.getElementById("focuswhy"));
  const sheetPage = /** @type {HTMLImageElement} */ (document.getElementById("sheet-page"));
  const capline = /** @type {HTMLElement} */ (document.getElementById("rc-capline"));
  const honest = /** @type {HTMLElement} */ (document.getElementById("rc-honest"));
  const rcFile = /** @type {HTMLElement} */ (document.getElementById("rc-file"));
  const rcSize = /** @type {HTMLElement} */ (document.getElementById("rc-size"));
  const rcScan = /** @type {HTMLElement} */ (document.getElementById("rc-scan"));
  const dropFile = /** @type {HTMLButtonElement} */ (document.getElementById("rc-drop"));
  const rcRefused = /** @type {HTMLElement} */ (document.getElementById("rc-refused"));
  const docnote = /** @type {HTMLElement} */ (document.getElementById("docnote"));
  /* #1437's alert block and kept line; a page without them reads as before. */
  const rcDup = document.getElementById("rc-dup");
  const rcKept = document.getElementById("rc-kept");
  const dzLive = document.getElementById("dz-live");

  /* The words for each state (READING_HEAD, FOCUS_*, WHY_*, CAP_*) and the
     two requests behind them live in $lib/data/document-read.js, shared
     with the phone's form (#1279): the mockup's own words, carried
     verbatim, and for the settled states create-v3 never drew (it ended on
     the timer) the words document-card/round-6 ratified for the item page's
     reading card. */

  /** The suggestion fields the form has a slot (and a "◆ from document"
      tag) for; the rest of the inspection's eight stay with the pocket's
      own decisions (the engine decides the schedule, ADR-0044). */
  const SUGGESTION_SLOTS = /** @type {Record<string, { input: string, field: string, read?: () => string, write?: (value: string) => void }>} */ ({
    provider: { input: "f-provider", field: "field-provider" },
    reference: { input: "f-ref", field: "field-ref" },
    dueDate: { input: "f-date", field: "field-date", read: () => pickers.date(), write: (/** @type {string} */ v) => pickers.setDate(v) },
    cost: { input: "f-cost", field: "field-cost" },
  });
  /* Typing in a suggested field makes the value the member's own, as the
     pocket's form does: the mark goes, so clearSuggestions leaves it alone. */
  for (const slot of Object.values(SUGGESTION_SLOTS)) {
    if (slot.write) continue; /* the key date is a pressed value: `pickerChanged` does it */
    const input = document.getElementById(slot.input);
    if (input) on(input, "input", () => document.getElementById(slot.field)?.classList.remove("sugg"));
  }

  /** One read in flight at a time: picking again, "not this one" or leaving
      cancels the last. */
  /** @type {AbortController | null} */
  let reading = null;
  /** The sheet's object URL, revoked when the sheet is cleared. */
  let sheetUrl = "";
  /** @type {"pending" | "up" | "failed"} */
  let pageState = "pending";
  let readDone = false;
  /** How the lane is to settle once the read is done, if the page failed. */
  /** @type {{ line: string, why: string, refused: boolean } | null} */
  let pageProblem = null;
  /** #1437: the alert while it is up -- what the server said is held, and
      the gate that holds the read until the person answers. */
  /** @type {{ held: import("$lib/data/workspace.js").AlreadyHeld, gate: ReturnType<typeof readGate> } | null} */
  let alerting = null;

  /** The read's hold (#1437): opened once the stage has answered and nothing
      is held, or the person keeps the file; closed when the file is dropped. */
  function readGate() {
    /** @type {(value?: unknown) => void} */
    let open = () => {};
    /** @type {(reason?: unknown) => void} */
    let close = () => {};
    const promise = new Promise((resolve, reject) => { open = resolve; close = reject; });
    promise.catch(() => { /* a dropped file is never read */ });
    return { promise, open, close };
  }

  /** The lane leaves the alert: its block and the kept line go from the page. */
  function clearHeld() {
    alerting = null;
    readcard.classList.remove("alert");
    rcDup?.replaceChildren();
    rcKept?.replaceChildren();
    dropFile.hidden = false;
  }

  /** A text paragraph of the alert block. @param {string} className @param {...(string | Node)} parts */
  function para(className, ...parts) {
    const line = document.createElement("p");
    line.className = className;
    line.append(...parts);
    return line;
  }

  /**
   * "Already in your orbit" (design/v19/duplicate-alert/round-1, A): the lane
   * keeps page one and, under it, says which entry holds the file and when it
   * came, with a link to it, and asks: keep it anyway, or not this one. Built
   * here, not left hidden in the page, so its words are in the page only
   * while they are true; the server's names are text, whatever they contain.
   *
   * @param {File} file
   * @param {import("$lib/data/workspace.js").AlreadyHeld} held
   * @param {{ households: { items?: { id: string, dueDate?: string | null }[] }[], today: string } | null} reckoning
   * @param {ReturnType<typeof readGate>} gate
   */
  function showHeld(file, held, reckoning, gate) {
    if (!rcDup) {
      gate.open();
      return;
    }
    alerting = { held, gate };
    readcard.classList.add("alert");
    readHead.textContent = ALREADY_HEAD;
    dropFile.hidden = true;

    const bead = () => {
      const one = document.createElement("span");
      one.className = "bead";
      one.setAttribute("aria-hidden", "true");
      return one;
    };
    const name = document.createElement("b");
    name.textContent = held.displayName;
    const block = document.createElement("div");
    block.className = "dup";
    block.setAttribute("role", "status");
    block.append(
      para("dup-line", bead(), YOU_HOLD),
      para("dup-why", "It is the same file, byte for byte, as ", name,
        held.entry ? ` on ${held.entry.title}, added ${addedDay(held.addedAt)}.` : `, added ${addedDay(held.addedAt)}.`),
    );
    const days = renewalDays(held, reckoning?.households ?? [], reckoning?.today ?? "");
    if (held.entry && days !== null) block.append(para("dup-renew", `${dueWords(held.entry.title, days)} ${RENEW_ADD}`));
    if (held.entry) {
      const open = document.createElement("a");
      open.className = "dup-open";
      open.href = `/home?item=${encodeURIComponent(held.entry.itemId)}`;
      open.textContent = `open ${held.displayName} →`;
      open.addEventListener("click", (event) => {
        /* A click that opens a new tab or window leaves this form where it
           is, so leaving it later still asks (M2). */
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        /* Followed here, as the phone's row is, so the flag lasts exactly as
           long as this navigation: if it does not leave after all, leaving
           asks again. */
        event.preventDefault();
        leavingForHeld = true;
        goto(open.href)
          .catch(() => { /* a refused navigation leaves the form as it was */ })
          .finally(() => { leavingForHeld = false; });
      });
      block.append(open);
    }
    block.append(para("dup-honest", NOTHING_READ));

    const acts = document.createElement("div");
    acts.className = "dup-acts";
    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "keep";
    keep.textContent = "keep it anyway";
    keep.addEventListener("click", () => keepHeld(file));
    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "drop";
    drop.textContent = "not this one";
    drop.addEventListener("click", () => dropFromLane());
    acts.append(keep, drop);
    rcDup.replaceChildren(block, acts);
  }

  /** "keep it anyway": the lane goes back to its usual shape, the read goes
      on, and one quiet line keeps the decision in view until the save. */
  function keepHeld(/** @type {File} */ file) {
    if (!alerting || attachment !== file) return;
    const { held, gate } = alerting;
    clearHeld();
    readHead.textContent = pageState === "up" ? PAGE_HEAD : documentReading ? READING_HEAD : CHECKING_HEAD;
    const bead = document.createElement("span");
    bead.className = "bead";
    bead.setAttribute("aria-hidden", "true");
    rcKept?.replaceChildren(bead, keptWords(held));
    gate.open();
    dropFile.focus({ preventScroll: true });
  }

  /**
   * #1437: stages the file the moment it is picked, under this pick's id and
   * the draft's, to hear whether the household already holds it; the save
   * sends the same ids again and the server hands back the copy it holds.
   * Nothing held, or no verdict, lets the read go on as before. A refusal is
   * kept for the save, which shows it in the words and the place it always
   * has (#1406).
   *
   * @param {string} householdId
   * @param {File} file
   * @param {string} documentId
   * @param {() => boolean} current
   * @param {ReturnType<typeof readGate>} gate
   */
  async function askHeld(householdId, file, documentId, current, gate) {
    let answer;
    try {
      answer = await stageDocument(householdId, file, documentId, draftId);
    } catch (error) {
      if (!current()) return;
      if (refusesFile(error)) pickRefusal = { id: documentId, error };
      gate.open();
      return;
    }
    if (!current()) {
      /* The file was replaced or the form left while the stage was out. */
      if (!saving && !committed) discardStagedDocument(documentId);
      return;
    }
    stagedId = documentId;
    if (!answer?.alreadyHeld) {
      gate.open();
      return;
    }
    const reckoning = await readDueReckoning().catch(() => null);
    if (!current()) return;
    showHeld(file, answer.alreadyHeld, reckoning, gate);
  }

  function clearSheet() {
    if (sheetUrl) URL.revokeObjectURL(sheetUrl);
    sheetUrl = "";
    sheetPage.removeAttribute("src");
    sheetPage.alt = "";
    document.body.classList.remove("snap");
  }

  /** Back to the mockup's `doc` state: the reticle breathing, nothing settled. */
  function resetLane(/** @type {File} */ file, reading = true) {
    clearSheet();
    pageState = "pending";
    readDone = false;
    pageProblem = null;
    readcard.classList.remove("still", "rc-refused");
    delete readcard.dataset.page;
    readcard.dataset.reading = "true";
    readHead.textContent = reading ? READING_HEAD : CHECKING_HEAD;
    focusline.textContent = FOCUS_SCANNING;
    focusWhy.textContent = reading ? "" : WHY_CHECKING;
    if (reading) focusWhy.innerHTML = WHY_READING;
    capline.textContent = reading ? CAP_READING : CAP_ATTACHED;
    honest.textContent = "";
    rcFile.textContent = `◆ ${file.name}`;
    rcSize.textContent = sizeLabel(file.size);
    rcScan.hidden = true;
    rcRefused.replaceChildren();
    rcRefused.hidden = true;
    dropFile.textContent = "not this one";
    clearHeld();
  }

  /** The focus block's settled form (the item page's `still`/`rc-refused`).
      Only this module's own two-line constants are written as markup; a
      server's words are text, whatever they contain. */
  function settleFocus(/** @type {{ line: string, why: string, refused: boolean }} */ state) {
    readcard.classList.add("still");
    readcard.classList.toggle("rc-refused", state.refused);
    focusline.textContent = state.line;
    if (state.why === WHY_UNDRAWABLE || state.why === WHY_REFUSED) focusWhy.innerHTML = state.why;
    else focusWhy.textContent = state.why;
  }

  /** The server would not keep this file (malware, or a type, size or
      structure the upload refuses), whether the read found it or the save's
      stage did. It stays in the entry, marked refused in the server's words,
      and the save is held until it is replaced or removed (#1406, owner's
      answer 6a); the lane says so in the item page's own words. */
  function refuseDocument(/** @type {File} */ file, /** @type {string} */ why) {
    reading?.abort();
    reading = null;
    fileRefusal = why;
    /* The heldName line is text: the lane's own two-line words carry markup. */
    const reason = why.replaceAll("<br>", "; ");
    if (heldName) heldName.textContent = `${file.name} — refused: ${reason}. Replace it, or remove it to save without it.`;
    updateRefusal();
    clearSheet();
    pageState = "failed";
    readcard.dataset.page = "failed";
    readDone = true;
    delete readcard.dataset.reading;
    honest.textContent = "";
    rcScan.hidden = true;
    /* Built here, not left hidden in the page: the word is in the lane only
       while it is true. */
    const word = document.createElement("span");
    word.className = "refusedword";
    word.textContent = "refused";
    rcRefused.replaceChildren(" \u00b7 ", word);
    rcRefused.hidden = false;
    dropFile.textContent = "remove it";
    settleFocus({ line: FOCUS_REFUSED, why, refused: true });
  }

  /** @param {{ input: string, write?: (value: string) => void }} slot @param {string} text */
  function writeSlot(slot, text) {
    if (slot.write) slot.write(text);
    else /** @type {HTMLInputElement} */ (document.getElementById(slot.input)).value = text;
  }

  /** Clears the suggested values nobody accepted, and their marks. */
  function clearSuggestions() {
    for (const slot of Object.values(SUGGESTION_SLOTS)) {
      const field = document.getElementById(slot.field);
      if (!field?.classList.contains("sugg")) continue;
      field.classList.remove("sugg");
      writeSlot(slot, "");
    }
    docnote.classList.remove("show");
  }

  /** The file is out of the entry: "not this one", refused or not. */
  function dropDocument() {
    letGoStaged();
    alerting?.gate.close();
    reading?.abort();
    reading = null;
    attachment = null;
    attachmentId = "";
    fileRefusal = null;
    /* So the same file can be picked again: `change` only fires on a change. */
    picker.value = "";
    clearSuggestions();
    edited();
    updateRefusal();
  }

  /**
   * The read itself. Two requests from one pick, independent of each other:
   * the page lands the moment it is drawn (`body.snap`, head "Page one"),
   * whether or not the read has finished; the read's outcome is written
   * where the lane is by then — under the sheet if the page is up, in the
   * focus block if it never came.
   */
  async function readDocument(/** @type {File} */ file) {
    reading?.abort();
    const controller = new AbortController();
    reading = controller;
    const current = () => reading === controller && attachment === file;
    /* A swapped file takes the first file's suggestions with it, as the
       pocket's readDocument does: carrying only fills empty fields, so stale
       ones would otherwise be saved against the new file. */
    clearSuggestions();
    resetLane(file, documentReading);
    const householdId = (household ?? await activeHousehold()).id;
    if (!current()) return;

    /* ADR-0033 step 5: the focus line moves on from the virus check to the
       preview the moment the scan has passed, before anything opens the file. */
    const onScanned = (/** @type {boolean} */ scanned) => {
      if (!current() || pageState !== "pending") return;
      focusline.textContent = focusAfterScan(scanned);
    };
    const gate = readGate();
    const outcomes = readPickedDocument(householdId, file, { signal: controller.signal, onScanned, documentReading, readAfter: gate.promise });
    const asked = askHeld(householdId, file, attachmentId, current, gate);
    pickStaging = { id: attachmentId, done: asked };

    const page = outcomes.page.then((outcome) => {
      if (!current()) {
        if (outcome.kind === "up") URL.revokeObjectURL(outcome.url);
        return;
      }
      if (outcome.kind === "up") {
        sheetUrl = outcome.url;
        sheetPage.alt = `Page one of ${file.name}`;
        sheetPage.src = outcome.url;
        rcScan.hidden = !outcome.scanned || fileRefusal !== null;
        pageState = "up";
        readcard.dataset.page = "up";
        if (!alerting) readHead.textContent = PAGE_HEAD;
        document.body.classList.add("snap");
        return;
      }
      pageState = "failed";
      readcard.dataset.page = "failed";
      if (outcome.kind === "refused") {
        refuseDocument(file, outcome.why);
        return;
      }
      pageProblem = { ...undrawnFocus(outcome.why), refused: false };
      if (readDone) settleFocus(pageProblem);
    });

    const read = outcomes.read
      .then((outcome) => {
        if (!current()) return;
        if (outcome.kind === "refused") {
          /* The upload would refuse it too, so the save is held now. */
          refuseDocument(file, outcome.why);
          return;
        }
        if (outcome.kind === "attached") {
          /* #1459: reading is off; the file goes with the entry as it is. */
          capline.textContent = captionOf(outcome, 0);
          return;
        }
        if (outcome.kind === "unread") {
          capline.textContent = captionOf(outcome, 0);
          honest.textContent = outcome.message;
          return;
        }
        const valueOf = (/** @type {string} */ field) => {
          const slot = SUGGESTION_SLOTS[field];
          return slot.read ? slot.read() : /** @type {HTMLInputElement} */ (document.getElementById(slot.input)).value;
        };
        const carry = suggestionsToCarry(outcome.suggestions, valueOf);
        for (const suggestion of carry) {
          const slot = SUGGESTION_SLOTS[suggestion.field];
          writeSlot(slot, suggestion.value);
          document.getElementById(slot.field)?.classList.add("sugg");
        }
        if (carry.length) {
          docnote.classList.add("show");
          edited();
          updateRefusal();
        }
        capline.textContent = captionOf(outcome, carry.length);
        honest.textContent = outcome.message;
      })
      .finally(() => {
        if (!current()) return;
        readDone = true;
        delete readcard.dataset.reading;
        if (pageState === "failed" && pageProblem) settleFocus(pageProblem);
      });

    await Promise.allSettled([page, read, asked]);
  }

  /* "not this one": the file leaves the entry, with what it suggested, and
     the drop target is a drop target again. */
  function dropFromLane() {
    if (saving) return; /* the entry is the server's until it answers (see takeFile) */
    /* Removing a refused file also ends the loud note about the save it refused. */
    if (fileRefusal !== null) sticky = null;
    dropDocument();
    clearSheet();
    /* The lane is closed, but its words stay in the page until the next pick:
       the refusal's reason goes with the file it was about. */
    focusWhy.textContent = "";
    document.body.classList.remove("doc");
    if (heldName) heldName.textContent = "";
    if (heldSize) heldSize.textContent = "";
    /* The file's name goes from the lane and the live region with it (#1437). */
    rcFile.textContent = "";
    if (dzLive) dzLive.textContent = "";
    clearHeld();
    /* The button has left the page: focus goes to the control that is usable again. */
    dropzone?.focus({ preventScroll: true });
  }
  on(dropFile, "click", dropFromLane);

  on(dropzone, "click", () => picker.click());
  on(dropzone, "keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      picker.click();
    }
  });
  on(picker, "change", () => takeFile(picker.files?.[0]));
  /* #1244: the zone answers a file in the air (armed over the page, locked
     over the zone, a settle on the drop) and takes what is dropped on it;
     drop-feedback.js holds the drag states and their flicker guard. */
  const dropFeedback = wireDropFeedback({ on, dropzone, live: document.getElementById("dz-live"), takeFile });
  /* #1243: a file the home drawer's quick add was given arrives here, and
     is taken exactly as if it had been dropped on this zone. */
  takeFile(takeHeldDocument());

  /* Accepting a suggestion clears the field's suggested marking. Nothing
     suggests anything yet — see the note above — but the grammar ships with
     the screen it belongs to. */
  for (const button of /** @type {HTMLElement[]} */ ([...document.querySelectorAll(".accept")])) {
    on(button, "click", () =>
      document.getElementById(/** @type {string} */ (button.dataset.accept))?.classList.remove("sugg"));
  }

  /* ---- recurrence (#1058d): the repeat band's periods, once to two years
     (#1468; the page holds the months, entry.js's RECURRENCE_MAX bounds them). */
  if (costInput) on(costInput, "input", updateRefusal);

  /* ---- saving ---- */

  on(card, "submit", async (event) => {
    event.preventDefault();
    if (saving || refusedNow() !== null || fileRefusal !== null) return;
    dryRun.stop();

    saving = true;
    sticky = null;
    holdSave(true);
    note.classList.remove("fail");
    note.removeAttribute("role");
    note.textContent = "";
    const label = save.textContent;
    save.textContent = "Adding…";
    /* The save sends what was held at the press: a read refused while it is
       in flight marks the file in the form, and the stage below still gets
       the server's own verdict on it. */
    const held = { attachment, attachmentId };
    /** Until the stage is answered, a failure is the file's or the send's. */
    let staging = false;

    try {
      const active = household ?? await activeHousehold();
      household ??= active;
      const command = commandFromForm();
      /* #1406: all or nothing. The file is staged first -- stored, scanned
         and sealed under this draft's id, with no item yet -- and the one
         command that creates the item binds it in the same transaction, so
         the server holds both or neither. A retry re-sends both under the
         same ids, and the server hands back what it already holds. */
      const file = held.attachment;
      /* #1437: staged at the pick under this same id; the bind below is the save. */
      const alertAtPress = alerting;
      if (file && pickStaging?.id === held.attachmentId) await pickStaging.done;
      /* The pick's stage answered while Add waited, and the household already
         holds the file: the alert is the answer, as it is when it comes
         before the press. Nothing is sent; Add is there again once the
         person has chosen (M1). */
      if (file && alerting && alerting !== alertAtPress && attachment === file) {
        save.textContent = label;
        saving = false;
        updateRefusal();
        return;
      }
      if (file && pickRefusal?.id === held.attachmentId) {
        staging = true;
        throw pickRefusal.error;
      }
      if (file && held.attachmentId !== stagedId) {
        staging = true;
        await stageDocument(active.id, file, held.attachmentId, draftId).catch(async (error) => {
          /* The sweep retired the file once staged under this id, and the
             server will not take it under that id again: stage the same
             file once more under a fresh id, within this Add. A second
             failure is shown as any other. */
          if (!bindRefused(error) || attachmentId !== held.attachmentId) throw error;
          reissueAttachmentId();
          held.attachmentId = attachmentId;
          await stageDocument(active.id, file, held.attachmentId, draftId);
        });
        staging = false;
      }
      await applyCommand(held.attachment ? { ...command, documentIds: [held.attachmentId] } : command).catch((error) => {
        /* This draft id is new to the server, so "this item changed on another
           device" can only mean the earlier send landed -- the item and the
           same document together -- and its answer was lost (same reading as
           pocket.svelte's save). A changed file is refused in the server's
           own words instead, and shown as not saved. */
        if (error instanceof WorkspaceError && error.code === "version_required") return;
        throw error;
      });

      /* The server holds the entry, and its document, from here, so leaving
         must not ask about discarding them (#1151 W1-S1). */
      committed = true;
      /* #1246: the form closes onto the main screen, landing on the item
         just saved — home's own `?item=` address puts that row on screen
         and opens it, as following a link to it would. */
      await goto(`/home?item=${encodeURIComponent(draftId)}`);
    } catch (error) {
      /* #1058e: loud, not small print — the button goes back to "Add to
         orbit", the reason sits beside it, and nothing typed is lost. No
         toast. Nothing is ever half saved (#1406), so the words say only
         what stopped it: a file the server refused (which stays, marked,
         holding Add), a send that got no verdict, or the engine's refusal
         of the item in its own words, as the pocket's form gives them. */
      if (staging && held.attachment && held.attachment === attachment && refusesFile(error)) {
        refuseDocument(held.attachment, wordsOf(error));
      }
      /* The server no longer holds the staged file (the sweep retired it
         after the stage): the next Add stages the same file under a fresh
         id, as a refused stage does within the Add above. */
      if (!staging && held.attachment && bindRefused(error) && attachmentId === held.attachmentId) {
        reissueAttachmentId();
      }
      sticky = unsavedWords(error)
        ?? (staging ? notSavedWords(error) : saveProblem(/** @type {{ code?: string, message?: string }} */ (error)));
      note.classList.add("fail");
      note.setAttribute("role", "alert");
      note.textContent = sticky;
      save.textContent = label;
      saving = false;
      updateRefusal();
    }
  });

  /* #1437: closing the tab or reloading never reaches the teardown; the
     pick's copy is let go on the way out all the same. A page kept in the
     back/forward cache (`persisted`) comes back with its pick, so it keeps
     the copy. */
  on(window, "pagehide", (/** @type {PageTransitionEvent} */ event) => {
    if (!event.persisted) letGoStaged();
  });

  /* #1162: the desk search's "add "<query>" as an item" act carries the typed
     name the same way the pocket's own create already does (#1120,
     pocket.svelte's `?name=` read) — the one contract, read by both halves of
     this route rather than a second one invented for the desk. */
  const prefillName = new URLSearchParams(location.search).get("name")?.trim();
  if (prefillName) nameInput.value = prefillName;

  /* #856: the panel opens from the `input` listener above, and `input` is
     one-shot — nothing replays it. So anything that writes to the name field
     before this module has mounted leaves the form stuck shut with no second
     chance: a reader typing fast on a slow device, or a test driving the
     keyboard as soon as the page loads. Two things follow.

     First, catch up on what was typed while nobody was listening (the name
     prefill above included). The heading ships empty (#1251), so anything
     in it now was written by someone — progressive disclosure is
     unchanged. */
  if (nameInput.value.trim().length >= 3) reveal();

  /* The section refusal (#1058b) holds the button from the start,
     same as the pocket's own form does the moment it is ready. */
  updateRefusal();

  /* Second, say so out loud. `#card[data-ready]` is the observable moment the
     listeners exist, so a test can wait for the page to be ABLE to answer
     rather than wait for `load` and hope — `load` fired ~122ms into the runs
     that failed, while mount had not landed yet. Set last, after every
     listener above is attached. */
  card.dataset.ready = "true";

  return {
    teardown: () => {
      teardown();
      delete card.dataset.ready;
      dryRun.stop();
      /* A read still in flight is nobody's once the screen has gone; the
         sheet's object URL goes with it, and `body.snap`, like `body.doc`,
         must not outlive the screen. */
      /* #1437: the pick's copy is let go when the form is left unsaved. */
      letGoStaged();
      reading?.abort();
      reading = null;
      clearSheet();
      /* `dragging`, `over` and the zone's `landed` go with `doc` (#1244). */
      dropFeedback.clear();
      document.body.classList.remove("doc");
    },
    /** Whether a misclick or a close would discard something typed
        (#1151 W1-S1). `reveal()`'s own one-way "the form grows as you
        commit to it" is already exactly this signal — a real name, a
        chosen section or a dropped document — so it is read rather than
        tracked twice. */
    isDirty: () => !committed && !leavingForHeld && disclose.classList.contains("open"),
    /** A level was picked in the importance row (#1463): the entry changed, and Add may now go. */
    importanceChanged: () => { edited(); reveal(); updateRefusal(); },
    /** The key date, the repeat or the reminders were picked on the chooser card (#1468). */
    pickerChanged: (/** @type {"date" | "recur" | "reminder"} */ which) => {
      if (which === "date") fieldDate?.classList.remove("sugg");
      edited();
      updateRefusal();
    },
  };
}
