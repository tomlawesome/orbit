import { goto } from "$app/navigation";
import { activeHousehold, applyCommand } from "$lib/data/workspace.js";

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
  const controller = new AbortController();
  const on = (target, type, handler) =>
    target?.addEventListener(type, handler, { signal: controller.signal });

  const card = document.getElementById("card");
  const disclose = document.getElementById("disclose");
  const dropzone = document.getElementById("dropzone");
  const nameInput = document.getElementById("f-name");
  const typeButtons = [...document.querySelectorAll("#types button")];
  const save = card.querySelector(".btn-primary");

  /** One-way: the form grows as you commit to it, and never shrinks back. */
  const reveal = () => disclose.classList.add("open");

  let chosenType = null;
  for (const button of typeButtons) {
    on(button, "click", () => {
      for (const other of typeButtons) other.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-pressed", "true");
      chosenType = button.dataset.type;
      reveal();
    });
  }

  on(nameInput, "input", () => {
    if (nameInput.value.trim().length >= 3) reveal();
  });
  /* The heading arrives pre-filled ("New Entry", owner 2026-08-15): first
     focus selects it whole, so typing replaces rather than appends. */
  on(nameInput, "focus", () => nameInput.select());

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

  let attachment = null;
  function takeFile(file) {
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
  for (const button of document.querySelectorAll(".accept")) {
    on(button, "click", () =>
      document.getElementById(button.dataset.accept)?.classList.remove("sugg"));
  }

  /* ---- saving ---- */

  const value = (id) => document.getElementById(id).value.trim();

  /**
   * The design draws no pending or failure state for the save. Rather than
   * invent one, the button says what is happening and a single line reports a
   * failure; both are interim and recorded as an open design question.
   */
  const note = document.createElement("div");
  note.className = "save-note";
  card.querySelector(".save-row").appendChild(note);

  let saving = false;
  on(card, "submit", async (event) => {
    event.preventDefault();
    if (saving) return;

    const title = nameInput.value.trim();
    if (!title) {
      nameInput.focus();
      return;
    }

    saving = true;
    save.disabled = true;
    note.textContent = "";
    const label = save.textContent;
    save.textContent = "Adding…";

    try {
      const household = await activeHousehold();
      /* No section is drawn on this form, and the data model requires one.
         The household's first visible section is the least surprising home
         for a new entry; where it should really go is an open question. */
      const section =
        household.sections.find((one) => one.visible) ?? household.sections[0];

      const cost = value("f-cost");
      const dueDate = value("f-date");
      const notes = value("f-notes");
      const recurrence = value("f-recur");
      /* The domain schedules two kinds of thing, renewals and services. The
         other three chips describe what an entry *is*, so they are carried as
         the subtype and schedule nothing. */
      const scheduleKind =
        chosenType === "renewal" || chosenType === "service" ? chosenType : undefined;

      await applyCommand({
        type: "item.upsert",
        householdId: household.id,
        item: {
          id: crypto.randomUUID(),
          sectionId: section.id,
          title,
          subtype: chosenType ?? undefined,
          provider: value("f-provider") || undefined,
          reference: value("f-ref") || undefined,
          costMinor: cost ? Math.round(Number(cost) * 100) : undefined,
          currency: household.currency,
          dueDate: dueDate || undefined,
          scheduleKind: dueDate ? scheduleKind : undefined,
          recurrenceMonths:
            dueDate && scheduleKind && recurrence !== "once"
              ? recurrence === "monthly" ? 1 : 12
              : undefined,
          reminderDays: [Number(value("f-reminder"))],
          notes: notes || undefined,
          status: "active",
        },
      });

      if (attachment) {
        /* Deliberately not silent: the entry is saved, the document is not,
           because that path is unbuilt. Saying so beats losing the file. */
        note.textContent = `Saved. ${attachment.name} was not attached — documents are not wired up yet.`;
        save.textContent = label;
        save.disabled = false;
        saving = false;
        return;
      }

      await goto("/home");
    } catch (error) {
      note.textContent = error?.message ?? "That could not be saved";
      save.textContent = label;
      save.disabled = false;
      saving = false;
    }
  });

  return () => {
    controller.abort();
    document.body.classList.remove("doc");
  };
}
