import { goto } from "$app/navigation";
import { WorkspaceError, activeHousehold, applyCommand, attachItemDocument } from "$lib/data/workspace.js";
import {
  CAP_READING, FOCUS_REFUSED, FOCUS_SCANNING, FOCUS_UNDRAWABLE, PAGE_HEAD, READING_HEAD, WHY_READING, WHY_REFUSED,
  WHY_UNDRAWABLE, captionOf, focusAfterScan, readPickedDocument, suggestionsToCarry,
} from "$lib/data/document-read.js";
import { saveProblem } from "$lib/data/metadata-status.js";
import { screenScope } from "$lib/teardown.js";
import { wireDropFeedback } from "./drop-feedback.js";
import { createCommandOf, kindHasDate, kindRecurs, recurrenceOfChoice, refusalOf } from "./entry.js";

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
 * nothing typed is lost. The mapping, the recurrence bound and the refusal
 * wording are not reimplemented here — `entry.js` is the one place they live,
 * shared with the pocket's own form (`pocket.svelte`, `EntryForm.svelte`),
 * which built the same five decisions first and is this file's reference.
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
 *      request keeps anything: the save attaches the file to the item it
 *      creates through the item's own documents route. The mockup's lit
 *      marks went with its sketched page — a real page has no marks to
 *      light, so the fields carry that instead.
 *   2. The mockup's inline `onsubmit="return false"` is a listener here — a
 *      module has no globals for an inline handler to reach.
 *   3. `body.doc` is removed again in this module's teardown: the class lives
 *      on `<body>`, which outlives the screen, so leaving it on would be the
 *      same class of bug satellites.js's own doc warns about ("a blurred
 *      scrim survived a trip to /create").
 */
export function mountCreate() {
  const { on, teardown } = screenScope();

  const card = /** @type {HTMLElement} */ (document.getElementById("card"));
  const disclose = /** @type {HTMLElement} */ (document.getElementById("disclose"));
  const dropzone = document.getElementById("dropzone");
  const nameInput = /** @type {HTMLInputElement} */ (document.getElementById("f-name"));
  const typeButtons = /** @type {HTMLElement[]} */ ([...document.querySelectorAll("#types button")]);
  const sections = /** @type {HTMLElement} */ (document.getElementById("sections"));
  const fieldDate = document.getElementById("field-date");
  const fieldRecur = /** @type {HTMLElement} */ (card.querySelector(".f-recur"));
  const recurSelect = /** @type {HTMLSelectElement} */ (document.getElementById("f-recur"));
  const recurMonths = /** @type {HTMLInputElement} */ (document.getElementById("f-recur-months"));
  const costInput = document.getElementById("f-cost");
  const dateInput = document.getElementById("f-date");
  const save = /** @type {HTMLButtonElement} */ (card.querySelector(".btn-primary"));
  const note = /** @type {HTMLElement} */ (document.getElementById("save-note"));

  const value = (/** @type {string} */ id) =>
    /** @type {HTMLInputElement} */ (document.getElementById(id)).value.trim();

  /** One-way: the form grows as you commit to it, and never shrinks back. */
  const reveal = () => disclose.classList.add("open");

  /** @type {import('./entry.js').Kind | null} */
  let chosenType = null;
  /** @type {string | null} */
  let chosenSection = null;
  let saving = false;
  /** Set the moment a save lands, so leaving for /home is never read as
      discarding what was typed. */
  let committed = false;
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
  const draftId = crypto.randomUUID();

  /** The recurrence select's value, in months — 0 is once (#1058d). */
  const monthsOf = () => recurrenceOfChoice(recurSelect.value, recurMonths.value);

  /** The form's own entry.js-shaped Entry (#1151 W1-Q9), read fresh each
   *  time and used for both the refusal check and the save payload below —
   *  entry.js is the one place the kind→fields mapping, the recurrence
   *  bound and the cost parsing live, shared with the pocket's own form
   *  (pocket.svelte's save() already calls createCommandOf this same way);
   *  this used to re-derive all four by hand instead, with its own,
   *  differently-gated recurrence condition. */
  /** @returns {import('./entry.js').Entry} */
  function entryFromForm() {
    return {
      kind: chosenType,
      name: nameInput.value,
      householdId: null,
      sectionId: chosenSection,
      provider: value("f-provider"),
      reference: value("f-ref"),
      dueDate: value("f-date"),
      recurrence: monthsOf(),
      cost: value("f-cost"),
      reminderDays: [Number(value("f-reminder"))],
      notes: value("f-notes"),
    };
  }

  /** Why the entry cannot be saved yet, in entry.js's own refusal vocabulary. */
  function currentRefusal() {
    return refusalOf(entryFromForm());
  }

  /**
   * #1058b/#1058e: the save button stays disabled while the entry cannot be
   * saved, the reason sits beside it — quiet while it is only a refusal,
   * loud (see the `submit` handler's catch) once a save has actually failed.
   */
  function updateRefusal() {
    if (saving) return;
    const refusal = currentRefusal();
    save.disabled = Boolean(refusal);
    /* A sticky message from the last save attempt outranks the live refusal
       note until the next attempt clears it — typing does not erase it. */
    if (sticky) return;
    note.classList.remove("fail");
    note.removeAttribute("role");
    note.textContent = refusal ?? "";
  }

  /* #1058c: what a kind schedules decides what the disclosed fields even
     ask for — a document's date is optional and never recurs, a suggestion
     has neither. kindHasDate/kindRecurs are entry.js's own rule, shared with
     the pocket's form; both read true for no kind chosen yet, so the fields
     stay in their original, always-visible state until a kind says otherwise. */
  function applyKindVisibility() {
    if (fieldDate) fieldDate.hidden = !kindHasDate(chosenType);
    fieldRecur.hidden = !kindRecurs(chosenType);
  }
  applyKindVisibility();

  for (const button of typeButtons) {
    on(button, "click", () => {
      for (const other of typeButtons) other.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-pressed", "true");
      chosenType = /** @type {import('./entry.js').Kind} */ (button.dataset.type);
      edited();
      applyKindVisibility();
      reveal();
      updateRefusal();
    });
  }

  on(nameInput, "input", () => {
    if (nameInput.value.trim().length >= 3) reveal();
    updateRefusal();
  });

  /* ---- section (#1058b): a row of buttons, none pre-selected; the entry
     cannot be saved until one is chosen. Populated once the household loads
     — the same shape #types already is, drawn here rather than built as a
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
          reveal();
          updateRefusal();
        });
        sections.appendChild(button);
      }
      updateRefusal();
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
  picker.accept = ".pdf,.eml,image/*";
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
  const sizeLabel = (/** @type {File} */ file) => `${Math.max(1, Math.round(file.size / 1024))} KB`;
  function takeFile(/** @type {File | null | undefined} */ file) {
    if (!file) return;
    attachmentId = crypto.randomUUID();
    attachment = file;
    edited();
    reveal();
    document.body.classList.add("doc");
    if (heldName) heldName.textContent = file.name;
    if (heldSize) heldSize.textContent = sizeLabel(file);
    if (!nameInput.value.trim()) {
      nameInput.value = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
    }
    /* The §14 walk, for real (#1245): page one and the read start together
       from the pick, and neither waits for the other. */
    readDocument(file).catch(() => { /* every outcome is drawn in the lane */ });
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
  const docnote = /** @type {HTMLElement} */ (document.getElementById("docnote"));

  /* The words for each state (READING_HEAD, FOCUS_*, WHY_*, CAP_*) and the
     two requests behind them live in $lib/data/document-read.js, shared
     with the phone's form (#1279): the mockup's own words, carried
     verbatim, and for the settled states create-v3 never drew (it ended on
     the timer) the words document-card/round-6 ratified for the item page's
     reading card. */

  /** The suggestion fields the form has a slot (and a "◆ from document"
      tag) for; the rest of the inspection's eight stay with the pocket's
      own decisions (#1058c maps kind to schedule here). */
  const SUGGESTION_SLOTS = /** @type {Record<string, { input: string, field: string }>} */ ({
    provider: { input: "f-provider", field: "field-provider" },
    reference: { input: "f-ref", field: "field-ref" },
    dueDate: { input: "f-date", field: "field-date" },
    cost: { input: "f-cost", field: "field-cost" },
  });

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

  function clearSheet() {
    if (sheetUrl) URL.revokeObjectURL(sheetUrl);
    sheetUrl = "";
    sheetPage.removeAttribute("src");
    sheetPage.alt = "";
    document.body.classList.remove("snap");
  }

  /** Back to the mockup's `doc` state: the reticle breathing, nothing settled. */
  function resetLane(/** @type {File} */ file) {
    clearSheet();
    pageState = "pending";
    readDone = false;
    pageProblem = null;
    readcard.classList.remove("still", "rc-refused");
    delete readcard.dataset.page;
    readcard.dataset.reading = "true";
    readHead.textContent = READING_HEAD;
    focusline.textContent = FOCUS_SCANNING;
    focusWhy.innerHTML = WHY_READING;
    capline.textContent = CAP_READING;
    honest.textContent = "";
    rcFile.textContent = `◆ ${file.name}`;
    rcSize.textContent = sizeLabel(file);
    rcScan.hidden = true;
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

  /** The server would not keep this file (malware, or a structure the
      upload refuses), so it leaves the entry now rather than at the save,
      and the lane says so in the item page's own words. */
  function refuseDocument(/** @type {File} */ file, /** @type {string} */ why) {
    dropDocument();
    if (heldName) heldName.textContent = `${file.name} — refused`;
    clearSheet();
    pageState = "failed";
    readcard.dataset.page = "failed";
    readDone = true;
    delete readcard.dataset.reading;
    honest.textContent = "";
    settleFocus({ line: FOCUS_REFUSED, why, refused: true });
  }

  /** Clears the suggested values nobody accepted, and their marks. */
  function clearSuggestions() {
    for (const slot of Object.values(SUGGESTION_SLOTS)) {
      const field = document.getElementById(slot.field);
      if (!field?.classList.contains("sugg")) continue;
      field.classList.remove("sugg");
      /** @type {HTMLInputElement} */ (document.getElementById(slot.input)).value = "";
    }
    docnote.classList.remove("show");
  }

  /** The file is out of the entry — refused by the server, or "not this one". */
  function dropDocument() {
    reading?.abort();
    reading = null;
    attachment = null;
    attachmentId = "";
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
    resetLane(file);
    const householdId = (household ?? await activeHousehold()).id;
    if (!current()) return;

    /* ADR-0033 step 5: the focus line moves on from the virus check to the
       preview the moment the scan has passed, before anything opens the file. */
    const onScanned = (/** @type {boolean} */ scanned) => {
      if (!current() || pageState !== "pending") return;
      focusline.textContent = focusAfterScan(scanned);
    };
    const outcomes = readPickedDocument(householdId, file, { signal: controller.signal, onScanned });

    const page = outcomes.page.then((outcome) => {
      if (!current()) {
        if (outcome.kind === "up") URL.revokeObjectURL(outcome.url);
        return;
      }
      if (outcome.kind === "up") {
        sheetUrl = outcome.url;
        sheetPage.alt = `Page one of ${file.name}`;
        sheetPage.src = outcome.url;
        rcScan.hidden = !outcome.scanned;
        pageState = "up";
        readcard.dataset.page = "up";
        readHead.textContent = PAGE_HEAD;
        document.body.classList.add("snap");
        return;
      }
      pageState = "failed";
      readcard.dataset.page = "failed";
      if (outcome.kind === "refused") {
        refuseDocument(file, outcome.why);
        return;
      }
      pageProblem = { line: FOCUS_UNDRAWABLE, why: outcome.why, refused: false };
      if (readDone) settleFocus(pageProblem);
    });

    const read = outcomes.read
      .then((outcome) => {
        if (!current()) return;
        if (outcome.kind === "refused") {
          /* The upload would refuse it too, so it leaves the entry now. */
          refuseDocument(file, outcome.why);
          return;
        }
        if (outcome.kind === "unread") {
          capline.textContent = captionOf(outcome, 0);
          honest.textContent = outcome.message;
          return;
        }
        const valueOf = (/** @type {string} */ field) =>
          /** @type {HTMLInputElement} */ (document.getElementById(SUGGESTION_SLOTS[field].input)).value;
        const carry = suggestionsToCarry(outcome.suggestions, valueOf);
        for (const suggestion of carry) {
          const slot = SUGGESTION_SLOTS[suggestion.field];
          /** @type {HTMLInputElement} */ (document.getElementById(slot.input)).value = suggestion.value;
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

    await Promise.allSettled([page, read]);
  }

  /* "not this one": the file leaves the entry, with what it suggested, and
     the drop target is a drop target again. */
  on(dropFile, "click", () => {
    dropDocument();
    clearSheet();
    document.body.classList.remove("doc");
    if (heldName) heldName.textContent = "";
    if (heldSize) heldSize.textContent = "";
  });

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

  /* Accepting a suggestion clears the field's suggested marking. Nothing
     suggests anything yet — see the note above — but the grammar ships with
     the screen it belongs to. */
  for (const button of /** @type {HTMLElement[]} */ ([...document.querySelectorAll(".accept")])) {
    on(button, "click", () =>
      document.getElementById(/** @type {string} */ (button.dataset.accept))?.classList.remove("sugg"));
  }

  /* ---- recurrence (#1058d): one-off, monthly and yearly stay; a fourth,
     custom choice takes 1–120 months (entry.js's own RECURRENCE_MAX). */
  on(recurSelect, "change", () => {
    recurMonths.hidden = recurSelect.value !== "custom";
    if (!recurMonths.hidden) recurMonths.focus();
    updateRefusal();
  });
  on(recurMonths, "input", updateRefusal);
  if (costInput) on(costInput, "input", updateRefusal);
  if (dateInput) on(dateInput, "input", updateRefusal);

  /* ---- saving ---- */

  on(card, "submit", async (event) => {
    event.preventDefault();
    if (saving) return;
    if (currentRefusal()) {
      updateRefusal();
      return;
    }

    saving = true;
    sticky = null;
    save.disabled = true;
    note.classList.remove("fail");
    note.removeAttribute("role");
    note.textContent = "";
    const label = save.textContent;
    save.textContent = "Adding…";

    try {
      const active = household ?? await activeHousehold();
      // FormHousehold.currency is optional (entry.js) even though
      // Household.currency is not — active can be either here, so this is
      // really possibly undefined; the same fallback pocket.svelte's own
      // save() already uses for the identical gap (#1151 W1-Q9).
      await applyCommand(createCommandOf(entryFromForm(), {
        householdId: active.id, currency: active.currency ?? "GBP", id: draftId,
      })).catch((error) => {
        /* This draft id is new to the server, so "this item changed on another
           device" can only mean the earlier send landed and its answer was
           lost (same reading as pocket.svelte's save). */
        if (error instanceof WorkspaceError && error.code === "version_required") return;
        throw error;
      });

      /* #1245: the picked document goes onto the item just saved. A refusal
         lands in the catch below like any failed save: the entry is kept,
         and the next attempt re-sends both under the same ids, so neither
         is stored twice. */
      if (attachment) await attachItemDocument(active.id, draftId, attachment, attachmentId);

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
         toast. saveProblem() is the same wording the pocket's form gives. */
      sticky = saveProblem(/** @type {{ code?: string, message?: string }} */ (error));
      note.classList.add("fail");
      note.setAttribute("role", "alert");
      note.textContent = sticky;
      save.textContent = label;
      saving = false;
      updateRefusal();
    }
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

  /* The section refusal (#1058b) holds the button disabled from the start,
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
      /* A read still in flight is nobody's once the screen has gone; the
         sheet's object URL goes with it, and `body.snap`, like `body.doc`,
         must not outlive the screen. */
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
        chosen type or a dropped document — so it is read rather than
        tracked twice. */
    isDirty: () => !committed && disclose.classList.contains("open"),
  };
}
