import { goto } from "$app/navigation";
import { activeHousehold, applyCommand } from "$lib/data/workspace.js";
import { saveProblem } from "$lib/data/metadata-status.js";
import { screenScope } from "$lib/teardown.js";
import { kindHasDate, kindRecurs, recurrenceOfChoice, refusalOf, scheduleOf } from "./entry.js";

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
 *   1. The mockup's drop target calls `simulateExtraction()`/`dropDocument()`,
 *      which types "British Gas / BG-88214-HC / 2026-11-02" into the form and
 *      (after a timer) shows the top-sheet snapshot, to demonstrate what
 *      extraction looks like. That is demonstration, not product, so it does
 *      not ship. The real path — upload, scan, read, suggest — runs over the
 *      reviewed-intake protocol (operation ids, 202-recoverable polling,
 *      malware states) and is a build of its own. Here the drop target does
 *      the part it can honestly do: it takes a real file, opens the form,
 *      splits the lanes (`body.doc`, §14 ruling 3) and names the entry after
 *      it. The `.sugg`/accept-suggestion markup and the reading lane's
 *      top-sheet snapshot stay, unused, waiting for that build and for a
 *      server-side page-one render (#476) respectively — `body.snap` is never
 *      added, so the sheet's own placeholder markup stays honestly
 *      unreachable rather than shown for a document never actually read.
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
  /** A message from the last save attempt (a loud failure, or "saved, the
      document was not attached"), held until the NEXT attempt — same as the
      pocket's own `problem`, which nothing typed clears early. */
  /** @type {string | null} */
  let sticky = null;
  /** Minted once for this draft, not per save attempt (#1151 W1-R2): a retry
      after a dropped response reuses it, so the server's upsert-by-id
      idempotency absorbs the retry instead of creating a second item. */
  const draftId = crypto.randomUUID();

  /** The recurrence select's value, in months — 0 is once (#1058d). */
  const monthsOf = () => recurrenceOfChoice(recurSelect.value, recurMonths.value);

  /** Why the entry cannot be saved yet, in entry.js's own refusal vocabulary. */
  function currentRefusal() {
    /** @type {import('./entry.js').Entry} */
    const asEntry = {
      kind: chosenType,
      name: nameInput.value,
      householdId: null,
      sectionId: chosenSection,
      provider: "",
      reference: "",
      dueDate: value("f-date"),
      recurrence: monthsOf(),
      cost: value("f-cost"),
      reminderDays: [],
      notes: "",
    };
    return refusalOf(asEntry);
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
      applyKindVisibility();
      reveal();
      updateRefusal();
    });
  }

  on(nameInput, "input", () => {
    if (nameInput.value.trim().length >= 3) reveal();
    updateRefusal();
  });
  /* The heading arrives pre-filled ("New Entry", owner 2026-08-15): first
     focus selects it whole, so typing replaces rather than appends. */
  on(nameInput, "focus", () => nameInput.select());

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
  function takeFile(/** @type {File | null | undefined} */ file) {
    if (!file) return;
    attachment = file;
    reveal();
    document.body.classList.add("doc");
    if (heldName) heldName.textContent = file.name;
    if (heldSize) heldSize.textContent = `${Math.max(1, Math.round(file.size / 1024))} KB`;
    if (!nameInput.value.trim()) {
      nameInput.value = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
    }
  }

  on(dropzone, "click", () => picker.click());
  on(dropzone, "keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      picker.click();
    }
  });
  on(picker, "change", () => takeFile(picker.files?.[0]));
  on(dropzone, "dragover", (event) => event.preventDefault());
  on(dropzone, "drop", (event) => {
    event.preventDefault();
    takeFile(event.dataTransfer?.files?.[0]);
  });

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

    const title = nameInput.value.trim();
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
      const { scheduleKind, subtype } = scheduleOf(chosenType);
      const dueDate = value("f-date");
      const cost = value("f-cost");
      const notes = value("f-notes");
      const months = monthsOf();

      await applyCommand({
        type: "item.upsert",
        householdId: active.id,
        item: {
          id: draftId,
          sectionId: /** @type {string} */ (chosenSection),
          title,
          subtype,
          provider: value("f-provider") || undefined,
          reference: value("f-ref") || undefined,
          costMinor: cost ? Math.round(Number(cost) * 100) : undefined,
          currency: active.currency,
          dueDate: dueDate || undefined,
          scheduleKind: dueDate ? scheduleKind : undefined,
          recurrenceMonths: dueDate && scheduleKind && kindRecurs(chosenType) && months > 0 ? months : undefined,
          reminderDays: [Number(value("f-reminder"))],
          notes: notes || undefined,
          status: "active",
        },
      });

      if (attachment) {
        /* Deliberately not silent: the entry is saved, the document is not,
           because that path is unbuilt. Saying so beats losing the file. */
        sticky = `Saved. ${attachment.name} was not attached — documents are not wired up yet.`;
        note.textContent = sticky;
        save.textContent = label;
        saving = false;
        updateRefusal();
        return;
      }

      await goto("/home");
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
     prefill above included). The `value` ATTRIBUTE is the default the markup
     ships ("New Entry"); `.value` is what is in the field now. They differ
     only once something has written to it, so this reveals for a real edit
     and never for the untouched default — progressive disclosure is
     unchanged. */
  if (nameInput.value.trim().length >= 3 && nameInput.value !== nameInput.getAttribute("value")) reveal();

  /* The section refusal (#1058b) holds the button disabled from the start,
     same as the pocket's own form does the moment it is ready. */
  updateRefusal();

  /* Second, say so out loud. `#card[data-ready]` is the observable moment the
     listeners exist, so a test can wait for the page to be ABLE to answer
     rather than wait for `load` and hope — `load` fired ~122ms into the runs
     that failed, while mount had not landed yet. Set last, after every
     listener above is attached. */
  card.dataset.ready = "true";

  return () => {
    teardown();
    delete card.dataset.ready;
    document.body.classList.remove("doc");
  };
}
