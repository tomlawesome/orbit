<script>
  import Mark from "$lib/Mark.svelte";
  import Sheet from "$lib/pocket/Sheet.svelte";
  import StagedPage from "$lib/pocket/StagedPage.svelte";
  import { stagedPreviewHref } from "$lib/pocket/review.js";
  import { DAMAGED, DAMAGED_PLACEHOLDER } from "$lib/data/metadata-status.js";
  import { PAGE_HEAD, READING_HEAD, whyLines } from "$lib/data/document-read.js";
  import {
    KINDS, RECURRENCE_MAX, REMINDER_CHOICES, kindHasDate, kindRecurs, recurrenceWords, stepRecurrence, toggleReminder,
  } from "./entry.js";
  const uid = $props.id();

  /**
   * CREATE'S FORM ON A PHONE (#1120, proposal §2.5): one column, label above
   * field, 16px inputs 48px tall, 44px chips. The same form edits an item
   * (the belt's `edit` sheet, §2.3): `mode="edit"` locks the type chips and
   * hides the household and the document row. The save bar is the host's,
   * because on /create it is fixed to the foot and in the edit sheet it is
   * the sheet's last row.
   *
   * `mode="review"` amends what the relay read from a piece of mail (the
   * inbox's `review & amend`, §2.6): the fields arrive pre-filled, the type
   * stays open, and the household is the receipt's, so neither its strip
   * nor the document row shows. The mail's own `papers` and `readings` sit
   * below the fields in the same reading card, each reading with its sure or
   * unsure word and `accept` to put it back after an edit.
   *
   * `nested` says the form is already inside a sheet: the reminders callout
   * then unfolds in place, because a sheet never stacks on a sheet (§1.4).
   *
   * A document picked on /create is read the way the desk reads it (#1279,
   * design/v19/create-phone-reading.html, owner's "14a"): the host starts the
   * shared read ($lib/data/document-read.js) and hands its state in as
   * `picked`. The reading card lands straight under TYPE, in place of the
   * row that picked the file -- not below the fields, where it would be off
   * screen at the moment the page lands -- with the desk's reticle while the
   * file is on its way, then page one on the cream sheet. The empty fields
   * the read filled are named in `marked` and carry "◆ from document" in the
   * label's right-hand slot; typing in one is accepting it, so the mark
   * clears. No accept pill: four of them would push the form down for an act
   * that only clears a mark. The host attaches the paper to the item it saves
   * (#1245, both dialects). `readings` are review mode's own rows (§2.6).
   * @typedef {import('./entry.js').FormHousehold} FormHousehold
   * @typedef {{ label: string, value: string, sure: boolean, field: "provider" | "reference" | "dueDate" | "cost" }} Reading
   * @typedef {{
   *   entry: import('./entry.js').Entry,
   *   households?: FormHousehold[],
   *   mode?: "create" | "edit" | "review",
   *   nested?: boolean,
   *   disabled?: boolean,
   *   referenceState?: string | null,
   *   notesState?: string | null,
   *   attachment?: File | null,
   *   picked?: import('$lib/data/document-read.js').PickedRead | null,
   *   marked?: import('$lib/data/document-read.js').SuggestionField[],
   *   onpick?: (file: File) => void,
   *   ondrop?: () => void,
   *   readings?: Reading[],
   *   papers?: { id?: string | null, name: string, meta: string, drawable?: boolean }[],
   *   receiptId?: string | null,
   * }} Props
   */
  /** @type {Props} */
  let {
    entry = $bindable(),
    households = [],
    mode = "create",
    nested = false,
    disabled = false,
    referenceState = null,
    notesState = null,
    attachment = $bindable(null),
    picked = null,
    marked = $bindable([]),
    onpick,
    ondrop,
    readings = [],
    papers = [],
    receiptId = null,
  } = $props();

  /* #1155: the review row unfolds its page in place -- only one at a time,
     and `reader={false}` on purpose: a reader over a full sheet is a third
     layer, and the belt is one tap away for anyone who needs zoom. */
  /** @type {string | null} */
  let openPaperName = $state(null);

  const household = $derived(households.find((one) => one.id === entry.householdId) ?? households[0] ?? null);
  const sections = $derived((household?.sections ?? []).filter((one) => one.visible || one.id === entry.sectionId));
  const currency = $derived(household?.currency ?? "GBP");
  const symbol = $derived(
    new Intl.NumberFormat("en-GB", { style: "currency", currency }).formatToParts(0)
      .find((part) => part.type === "currency")?.value ?? currency,
  );

  /** @param {string} id */
  function pickHousehold(id) {
    if (entry.householdId === id) return;
    /* Sections belong to a household: a new household is a new choice. */
    entry.householdId = id;
    entry.sectionId = null;
  }

  /* ---- reminders: two chips, editable in a callout (§2.5) -------------- */
  let remindOpen = $state(false);
  const remindWords = $derived(entry.reminderDays.length ? entry.reminderDays.map((d) => `${d}d`) : ["none"]);

  /* ---- the document picker (§2.5, item 3) ------------------------------ */
  /** @type {HTMLInputElement | undefined} */
  let picker = $state();
  /** @param {Event} event */
  function onPick(event) {
    const input = /** @type {HTMLInputElement} */ (event.currentTarget);
    const file = input.files?.[0];
    if (!file) return;
    /* Held here, not in the input: cleared so the same file can be picked
       again after a refusal or "not this one" (`change` only fires on a change). */
    input.value = "";
    attachment = file;
    if (!entry.name.trim()) entry.name = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").slice(0, 100);
    onpick?.(file);
  }
  /** "not this one": the file leaves the entry, with what it suggested. */
  function dropDocument() {
    attachment = null;
    if (picker) picker.value = "";
    ondrop?.();
  }
  /** Typing in a field the read filled is accepting it: its mark clears. */
  /** @param {import('$lib/data/document-read.js').SuggestionField} field */
  function unmark(field) {
    if (marked.includes(field)) marked = marked.filter((one) => one !== field);
  }
  /** A reading accepted is copied into its field; nothing is saved until the form is. */
  /** @param {Reading} reading */
  function accept(reading) {
    if (reading.field === "cost") entry.cost = reading.value.replace(/[^\d.]/g, "");
    else entry[reading.field] = reading.value;
  }
  /** The paper row's separator, as an expression: a block's leading space
      is trimmed, which ran "17 KB· refused" together. */
  const SEP = " · ";
  /** @type {(bytes: number) => string} */
  const size = (bytes) =>
    bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
</script>

<div class="pc-form">
  <section class="p-card pc-card" style:--i="0" aria-labelledby="{uid}-type">
    <h2 class="p-caps" id="{uid}-type">type</h2>
    <div class="pc-kinds" role="group" aria-labelledby="{uid}-type">
      {#each KINDS as kind (kind.id)}
        <button type="button" class="pc-chip" aria-pressed={entry.kind === kind.id}
                disabled={disabled || mode === "edit"}
                onclick={() => { entry.kind = entry.kind === kind.id ? null : kind.id; }}>
          <span class="pc-glyph" aria-hidden="true">{kind.glyph}</span>{kind.word}
        </button>
      {/each}
    </div>
    {#if mode === "edit"}
      <p class="pc-hint">the type is set when the item is made</p>
    {/if}

    {#if mode === "create"}
      <!-- Once a file is held, the row's job is done: the reading card takes
           its place. A refused file is out of the entry, so the row is back. -->
      {#if !attachment}
        <button type="button" class="pc-doc" onclick={() => picker?.click()} disabled={disabled}>
          <span class="p-paper pc-doc-mark" aria-hidden="true">◆</span>
          <span class="pc-doc-words">
            <b>add a document</b>
            <span>photo or file · read for you</span>
          </span>
        </button>
      {/if}
      <input bind:this={picker} type="file" accept="application/pdf,image/*" hidden onchange={onPick}>
    {/if}
  </section>

  {#if mode === "create" && picked}
    <!-- The reading card (#1279): in the TYPE card's wake, where the thumb
         just was. aria-live so the head's change and the caption's are
         announced. Keyed by the pick, so a new file lands a new card. -->
    {#key picked.key}
      <section class="p-card proposed pc-card pc-reading" class:pc-snap={Boolean(picked.page)} class:pc-still={picked.settled}
               class:pc-refused={picked.refused} class:pc-done={picked.read}
               style:--i="1" aria-labelledby="{uid}-reading" aria-live="polite">
        <h2 class="p-caps" id="{uid}-reading">{picked.page ? PAGE_HEAD : READING_HEAD}</h2>

        <div class="pc-paper pc-paper-row">
          <span class="p-paper pc-doc-mark" aria-hidden="true">◆</span>
          <span class="pc-paper-words"><b>{picked.name}</b>
            <span>{size(picked.size)}{#if picked.scanned}{SEP}<span class="clean">scanned clean</span>{/if}{#if picked.refused}{SEP}<span class="refusedword">refused</span>{/if}</span></span>
        </div>

        {#if picked.page}
          <!-- Page one, drawn by the household's pre-attachment preview
               route (#1245/#476), on the cream sheet with the tilted second
               sheet under it. -->
          <div class="pc-topsheet">
            <div class="pc-sheet"><img src={picked.page} alt="Page one of {picked.name}"></div>
            <p class="pc-cap"><b>Page one of the file you added</b>
              <span class="p-body up breathing" aria-hidden="true"></span><span>{picked.caption}</span></p>
          </div>
        {:else}
          <div class="pc-focus">
            <svg class="pc-reticle" viewBox="0 0 96 96" aria-hidden="true">
              <circle cx="48" cy="48" r="43" fill="none" stroke="var(--chart-line)" stroke-width="1"
                      stroke-dasharray="3 7" opacity=".8"/>
              <g class="sweep">
                <line x1="48" y1="5" x2="48" y2="14" stroke="var(--accent)" stroke-width="1.2" opacity=".8"/>
                <line x1="48" y1="82" x2="48" y2="91" stroke="var(--accent)" stroke-width="1.2" opacity=".35"/>
              </g>
              <g class="pull" fill="none" stroke="var(--accent)" stroke-width="1.1" opacity=".7">
                <path d="M 26 18 H 18 V 26"/><path d="M 70 18 H 78 V 26"/>
                <path d="M 26 78 H 18 V 70"/><path d="M 70 78 H 78 V 70"/>
              </g>
              <circle cx="48" cy="48" r="16" fill="none" stroke="var(--chart-line)" stroke-width="1" opacity=".9"/>
              <circle cx="48" cy="48" r="1.8" fill="var(--accent)"/>
            </svg>
            <p class="pc-focusline">{picked.line}</p>
            <p class="pc-why">{#each whyLines(picked.why) as line, index (index)}{#if index}<br>{/if}{line}{/each}</p>
          </div>
        {/if}

        {#if !picked.refused}
          <button type="button" class="p-pill pc-drop" {disabled} onclick={dropDocument}>not this one</button>
        {/if}
      </section>
    {/key}
  {/if}

  <section class="p-card pc-card" style:--i={mode === "create" ? 2 : 1} aria-labelledby="{uid}-details">
    <h2 class="p-caps" id="{uid}-details">details</h2>

    <div class="pc-field">
      <label for="{uid}-name">name</label>
      <input id="{uid}-name" bind:value={entry.name} maxlength="100" autocomplete="off" enterkeyhint="next"
             placeholder="e.g. Car MOT" {disabled}>
    </div>

    <div class="pc-field" role="group" aria-labelledby="{uid}-section">
      <div class="pc-label" id="{uid}-section">section <span class="pc-need">{entry.sectionId ? "tap to swap" : "required · choose one"}</span></div>
      {#if sections.length}
        <div class="pc-strip">
          {#each sections as section (section.id)}
            <button type="button" class="pc-chip pc-sec" aria-pressed={entry.sectionId === section.id} {disabled}
                    onclick={() => { entry.sectionId = section.id; }}>
              <Mark icon={section.icon} accent={section.accent} size={16} class="pc-mark" aria-hidden="true" />
              {section.name}
            </button>
          {/each}
        </div>
      {:else}
        <p class="p-empty">this household has no sections to file into</p>
      {/if}
    </div>

    {#if mode === "create" && households.length > 1}
      <div class="pc-field" role="group" aria-labelledby="{uid}-household">
        <div class="pc-label" id="{uid}-household">household</div>
        <div class="pc-strip">
          {#each households as one (one.id)}
            <button type="button" class="pc-chip" aria-pressed={household?.id === one.id} {disabled}
                    onclick={() => pickHousehold(one.id)}>{one.name}</button>
          {/each}
        </div>
      </div>
    {/if}

    <div class="pc-field" class:sugg={marked.includes("provider")}>
      <label for="{uid}-provider">provider <span class="pc-from">◆ from document</span></label>
      <input id="{uid}-provider" bind:value={entry.provider} maxlength="100" autocomplete="off" enterkeyhint="next"
             placeholder="optional · e.g. Kwik Fit" {disabled} oninput={() => unmark("provider")}>
    </div>

    <div class="pc-field" class:sugg={marked.includes("reference")}>
      <label for="{uid}-reference">reference <span class="pc-from">◆ from document</span></label>
      <input id="{uid}-reference" class="mono" bind:value={entry.reference} maxlength="80" autocomplete="off"
             enterkeyhint="next" {disabled} oninput={() => unmark("reference")}
             placeholder={referenceState === DAMAGED ? DAMAGED_PLACEHOLDER : "optional · policy no."}>
    </div>

    {#if kindHasDate(entry.kind)}
      <div class="pc-field" class:sugg={marked.includes("dueDate")}>
        <label for="{uid}-due">{entry.kind === "document" ? "expires on" : "due date"} <span class="pc-from">◆ from document</span></label>
        <input id="{uid}-due" type="date" class="mono" bind:value={entry.dueDate} {disabled} oninput={() => unmark("dueDate")}>
        {#if entry.kind === "document"}<p class="pc-hint">optional · a document ends once and does not come round</p>{/if}
      </div>
    {/if}

    {#if entry.kind && kindRecurs(entry.kind)}
      <div class="pc-field" role="group" aria-labelledby="{uid}-recur">
        <div class="pc-label" id="{uid}-recur">comes round</div>
        <div class="pc-stepper">
          <button type="button" class="p-pill pc-step" aria-label="Less often"
                  disabled={disabled || entry.recurrence <= 0}
                  onclick={() => { entry.recurrence = stepRecurrence(entry.recurrence, -1); }}>−</button>
          <output class="pc-recur" aria-live="polite">{recurrenceWords(entry.recurrence)}</output>
          <button type="button" class="p-pill pc-step" aria-label="More months between"
                  disabled={disabled || entry.recurrence >= RECURRENCE_MAX}
                  onclick={() => { entry.recurrence = stepRecurrence(entry.recurrence, 1); }}>+</button>
        </div>
        <div class="pc-quick" role="group" aria-label="Common periods">
          {#each [[0, "once"], [1, "monthly"], [6, "6 months"], [12, "yearly"]] as [months, word] (months)}
            <button type="button" class="pc-chip pc-mini" aria-pressed={entry.recurrence === months} {disabled}
                    onclick={() => { entry.recurrence = Number(months); }}>{word}</button>
          {/each}
        </div>
      </div>
    {/if}

    <div class="pc-field" class:sugg={marked.includes("cost")}>
      <label for="{uid}-cost">cost <span class="pc-from">◆ from document</span></label>
      <div class="pc-money">
        <span class="pc-sym" aria-hidden="true">{symbol}</span>
        <input id="{uid}-cost" class="mono" bind:value={entry.cost} inputmode="decimal" autocomplete="off"
               enterkeyhint="next" placeholder="0.00" aria-describedby="{uid}-cur" {disabled} oninput={() => unmark("cost")}>
        <span class="pc-cur" id="{uid}-cur">{currency}</span>
      </div>
    </div>

    <div class="pc-field" role="group" aria-labelledby="{uid}-remind">
      <div class="pc-label" id="{uid}-remind">reminders</div>
      <button type="button" class="pc-remind" aria-expanded={remindOpen} {disabled}
              aria-label="Reminders: {entry.reminderDays.length ? entry.reminderDays.map((d) => `${d} days`).join(', ') + ' before' : 'none'}. Change"
              onclick={() => { remindOpen = !remindOpen; }}>
        {#each remindWords as word (word)}<span class="pc-tag">{word}</span>{/each}
        <span class="pc-before">before</span>
        <span class="pc-change">change</span>
      </button>
      {#if nested && remindOpen}
        <div class="pc-remind-pick">
          {@render remindChoices()}
        </div>
      {/if}
    </div>

    <div class="pc-field">
      <label for="{uid}-notes">notes</label>
      <textarea id="{uid}-notes" rows="3" bind:value={entry.notes} maxlength="2000" {disabled}
                placeholder={notesState === DAMAGED ? DAMAGED_PLACEHOLDER : "anything else worth keeping"}></textarea>
    </div>
  </section>

  {#if mode === "review" && (papers.length || readings.length)}
    <!-- Review mode: what the relay read, below the fields (§2.5, §2.6). -->
    <section class="p-card proposed pc-card pc-reading" style:--i="2" aria-labelledby="{uid}-reading">
      <h2 class="p-caps" id="{uid}-reading">what the relay read</h2>
      {#each papers as paper (paper.name)}
        <button type="button" class="pc-paper" disabled={!paper.id}
                aria-expanded={openPaperName === paper.name}
                onclick={() => { openPaperName = openPaperName === paper.name ? null : paper.name; }}>
          <span class="p-paper pc-doc-mark" aria-hidden="true">◆</span>
          <span class="pc-paper-words"><b>{paper.name}</b><span>{paper.meta}</span></span>
          {#if paper.id}<span class="pc-chev" aria-hidden="true">{openPaperName === paper.name ? "⌄" : "›"}</span>{/if}
        </button>
        {#if openPaperName === paper.name && paper.id}
          <StagedPage href={receiptId ? stagedPreviewHref(receiptId, paper.id) : ""} name={paper.name}
                      drawable={Boolean(paper.drawable)} reader={false} />
        {/if}
      {/each}
      {@render readingRows()}
    </section>
  {/if}

  <!-- Inside the form, not at the top level: a top-level snippet trips the
       production bundler (#1130). -->
  {#snippet readingRows()}
    {#each readings as reading (reading.field)}
      <div class="pc-read">
        <span class="pc-read-label">{reading.label}</span>
        <b class="pc-read-value">{reading.value}</b>
        <span class="pc-read-sure" class:unsure={!reading.sure}>{reading.sure ? "sure" : "unsure"}</span>
        <button type="button" class="p-pill act-ok pc-accept" aria-label="Accept {reading.label}: {reading.value}"
                {disabled} onclick={() => accept(reading)}>accept</button>
      </div>
    {/each}
  {/snippet}
  {#snippet remindChoices()}
    <div class="pc-strip pc-remind-choices" role="group" aria-label="Remind me this many days before">
      {#each REMINDER_CHOICES as day (day)}
        <button type="button" class="pc-chip pc-mini" aria-pressed={entry.reminderDays.includes(day)}
                onclick={() => { entry.reminderDays = toggleReminder(entry.reminderDays, day); }}>{day}d</button>
      {/each}
    </div>
    <p class="pc-hint">days before it is due · as many as you like, or none</p>
  {/snippet}

  {#if !nested}
    <Sheet bind:open={remindOpen} size="callout" title="Reminders">
      {@render remindChoices()}
      {#snippet foot()}
        <button type="button" class="p-pill filled" onclick={() => { remindOpen = false; }}>done</button>
      {/snippet}
    </Sheet>
  {/if}
</div>

<style>
  .pc-form{display:flex;flex-direction:column}
  .pc-card{padding:var(--p-card-pad) var(--p-card-pad) 20px}

  /* CHIPS (§2.5, §1.7): 44px, glyph + word, pressed is the desk's aria-pressed look. */
  .pc-chip{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;
    min-height:var(--p-hit);min-width:var(--p-hit);padding:0 14px;box-sizing:border-box;
    border-radius:calc(var(--p-hit) / 2);border:1px solid var(--line);background:var(--panel);
    color:var(--ink-mid);font:var(--p-type-button)/1.2 var(--ui);cursor:pointer;
    -webkit-tap-highlight-color:transparent;transition:background-color 120ms,border-color 120ms,color 120ms}
  .pc-chip[aria-pressed=true]{border-color:var(--accent);color:var(--ink);
    background:color-mix(in srgb, var(--accent) 16%, var(--panel))}
  :global([data-theme=retrograde]) .pc-chip[aria-pressed=true]{box-shadow:0 0 10px -3px var(--bloom)}
  .pc-chip:disabled{cursor:default}
  .pc-chip:disabled:not([aria-pressed=true]){opacity:.55}
  .pc-chip:focus-visible,.pc-doc:focus-visible,.pc-remind:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .pc-kinds{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:var(--p-pill-gap)}
  /* Two rows, three over two (§2.5), each chip filling its share. */
  .pc-kinds .pc-chip{grid-column:span 2;padding:0 6px;gap:6px;font-size:.875rem}
  .pc-kinds .pc-chip:nth-child(n+4){grid-column:span 3}
  .pc-glyph{color:var(--accent-text);font-size:var(--p-type-body);line-height:1}

  /* The document row: the desk's dashed drop target, as a 56px row. */
  .pc-doc{appearance:none;display:flex;align-items:center;gap:var(--p-row-gap);width:100%;min-height:var(--p-row-min);
    margin-top:12px;padding:8px 12px;box-sizing:border-box;border-radius:12px;text-align:left;cursor:pointer;
    border:1.5px dashed color-mix(in srgb, var(--accent) 45%, var(--line-soft));background:none;color:var(--ink)}
  .pc-doc:active{background:color-mix(in srgb, var(--accent) 10%, transparent)}
  .pc-doc-mark{width:var(--p-row-mark);text-align:center;font-size:var(--p-type-body)}
  .pc-doc-words{display:flex;flex-direction:column;gap:2px;min-width:0}
  .pc-doc-words b{font:500 var(--p-type-body)/1.3 var(--ui)}
  .pc-doc-words span{font:var(--p-type-meta)/1.4 var(--mono);color:var(--ink-quiet)}

  /* FIELDS: label above, 16px inputs 48px tall, full width (§2.5). */
  .pc-field{margin:0 0 18px}
  .pc-field:last-child{margin-bottom:0}
  .pc-field > label,.pc-label{display:flex;justify-content:space-between;align-items:baseline;gap:8px;
    margin:0 0 6px;font:var(--p-type-caps)/1.4 var(--mono);letter-spacing:var(--p-type-caps-track);
    text-transform:uppercase;color:var(--ink-quiet)}
  .pc-need{letter-spacing:.04em;text-transform:none;font-size:var(--p-type-caps);color:var(--accent-text)}
  .pc-field input,.pc-field textarea{box-sizing:border-box;width:100%;min-height:48px;padding:0 14px;
    border-radius:12px;border:1px solid var(--line);background:color-mix(in srgb, var(--bg) 55%, transparent);
    color:var(--ink);font:var(--p-type-body)/1.4 var(--ui);
    scroll-margin-top:calc(var(--p-chrome) + 12px);scroll-margin-bottom:calc(var(--pc-bar, 0px) + var(--p-kb, 0px) + 12px)}
  .pc-field textarea{padding:12px 14px;resize:vertical;min-height:96px}
  .pc-field input.mono{font-family:var(--mono)}
  .pc-field input::placeholder,.pc-field textarea::placeholder{color:var(--ink-quiet);opacity:1}
  .pc-field input:focus,.pc-field textarea:focus{outline:none;border-color:var(--accent);
    box-shadow:0 0 0 1px var(--accent)}
  .pc-field input:disabled,.pc-field textarea:disabled{opacity:.6}
  .pc-hint{margin:6px 0 0;font:var(--p-type-meta)/1.4 var(--mono);color:var(--ink-quiet)}

  /* A chip strip: one line that scrolls sideways, as households are drawn (§1.10). */
  .pc-strip{display:flex;gap:var(--p-pill-gap);overflow-x:auto;scrollbar-width:none;
    margin:0 calc(var(--p-card-pad) * -1);padding:2px var(--p-card-pad);scroll-padding:0 var(--p-card-pad)}
  .pc-strip::-webkit-scrollbar{display:none}
  .pc-strip .pc-chip{flex:none}
  :global(.pc-mark){display:inline-flex;line-height:0}
  :global(.pc-mark svg){fill:none;stroke:var(--sec);stroke-width:1.3;stroke-linecap:round;stroke-linejoin:round}
  :global(.pc-mark circle){fill:var(--sec);stroke:none}
  :global(.pc-mark i){display:none}

  /* The recurrence stepper: − / value / + at 44px, once as its zero. */
  .pc-stepper{display:flex;align-items:center;gap:8px}
  .pc-step{font:500 1.25rem/1 var(--mono);padding:0}
  .pc-step:disabled{opacity:.4;cursor:default}
  .pc-recur{flex:1;text-align:center;min-height:var(--p-hit);display:grid;place-items:center;
    border-radius:12px;border:1px solid var(--line-soft);font:500 var(--p-type-body)/1.2 var(--mono);color:var(--ink)}
  .pc-quick{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-top:8px}
  .pc-quick .pc-mini{padding:0 2px;white-space:nowrap;letter-spacing:-.02em}
  .pc-mini{padding:0 12px;font:var(--p-type-meta)/1.2 var(--mono)}

  .pc-money{display:flex;align-items:center;position:relative}
  .pc-sym{position:absolute;left:14px;font:var(--p-type-body)/1 var(--mono);color:var(--ink-quiet);pointer-events:none}
  .pc-money input{padding-left:34px;padding-right:56px}
  .pc-cur{position:absolute;right:14px;font:var(--p-type-meta)/1 var(--mono);color:var(--ink-quiet);pointer-events:none}

  /* Reminders: the chips as one 44px control; the callout edits them. */
  .pc-remind{appearance:none;display:flex;align-items:center;flex-wrap:wrap;gap:8px;width:100%;min-height:var(--p-hit);
    padding:6px 14px 6px 8px;box-sizing:border-box;border-radius:12px;border:1px solid var(--line-soft);
    background:none;color:var(--ink-mid);cursor:pointer;text-align:left}
  .pc-tag{display:inline-flex;align-items:center;min-height:30px;padding:0 10px;border-radius:15px;
    border:1px solid color-mix(in srgb, var(--upcoming) 40%, transparent);color:var(--upcoming-text);
    font:var(--p-type-meta)/1 var(--mono)}
  .pc-before{font:var(--p-type-meta)/1 var(--mono);color:var(--ink-quiet)}
  .pc-change{margin-left:auto;font:var(--p-type-meta)/1 var(--mono);color:var(--accent-text)}
  .pc-remind-pick{margin-top:10px}
  .pc-remind-choices{flex-wrap:wrap;overflow:visible;margin:0;padding:0}

  /* The reading card: something Orbit proposes, so the desk's dashed pen. In
     review mode each row is a button (#1155) that unfolds its page in place;
     the single-attachment (non-review) row below stays a plain div. */
  .pc-paper{display:flex;align-items:center;gap:var(--p-row-gap);min-height:var(--p-row-min)}
  button.pc-paper{width:100%;text-align:left;appearance:none;background:none;border:0;padding:0;
    cursor:pointer;color:inherit;font:inherit}
  button.pc-paper:disabled{cursor:default}
  button.pc-paper:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:8px}
  .pc-chev{margin-left:auto;color:var(--accent-text)}
  .pc-paper-words{display:flex;flex-direction:column;gap:2px;min-width:0}
  .pc-paper-words b{font:500 var(--p-type-body)/1.3 var(--ui);color:var(--ink);overflow-wrap:anywhere}
  .pc-paper-words span{font:var(--p-type-meta)/1.4 var(--mono);color:var(--ink-quiet)}
  .pc-read{display:grid;grid-template-columns:1fr auto;gap:4px 12px;align-items:center;padding:10px 0;
    border-top:1px solid var(--line-soft)}
  .pc-read-label{font:var(--p-type-meta)/1.4 var(--ui);color:var(--ink-quiet)}
  .pc-read-value{font:500 var(--p-type-body)/1.3 var(--mono);color:var(--ink);grid-column:1}
  .pc-read-sure{font:var(--p-type-caps)/1 var(--mono);letter-spacing:var(--p-type-caps-track);
    text-transform:uppercase;color:var(--ok-text);grid-column:1}
  .pc-read-sure.unsure{color:var(--warm-text)}
  .pc-accept{grid-column:2;grid-row:1 / span 3}
  .pc-drop{--act:var(--overdue);--act-text:var(--overdue-text)}

  /* A FIELD FILLED FROM THE DOCUMENT (#1279): the desk's own mark (create.css
     .field.sugg), the accent rule down the field's left edge, and "◆ from
     document" in the label's right-hand slot -- the slot "required · choose
     one" already uses -- so no field grows taller. Hidden, not absent, while
     unmarked, so it never joins the field's accessible name. */
  .pc-from{display:none;letter-spacing:.04em;text-transform:none;font-size:var(--p-type-caps);color:var(--accent-text)}
  .pc-field.sugg .pc-from{display:inline}
  .pc-field.sugg input{border-left:3px solid var(--accent)}

  /* THE READING CARD (#1279), straight under TYPE: the paper's row, then the
     desk's reading lane -- the reticle and its breathing line while the file
     is on its way, the top sheet once page one is drawn -- then the caption,
     then "not this one". design/v19/create-phone-reading.html, verbatim, its
     state classes prefixed (pc-snap, pc-still, pc-refused, pc-done) so no
     route stylesheet's bare `.refused` or `.read` can reach them. */
  .pc-paper-words .clean{color:var(--ok-text)}
  .pc-paper-row{border-bottom:1px solid var(--line-soft);padding-bottom:4px;margin-bottom:8px}
  .pc-refused .pc-paper-words b{color:var(--ink-mid)}
  .pc-paper-words .refusedword{color:var(--degraded-text)}

  /* the focus block: the desk's reticle (create.css), the phone's line and
     why (StagedPage's bp-line / bp-why) */
  .pc-focus{display:flex;flex-direction:column;align-items:center;text-align:center;padding:14px 0 6px}
  .pc-reticle{width:96px;height:96px;margin-bottom:16px}
  .pc-reticle .sweep{transform-origin:48px 48px;animation:sweep 9s linear infinite}
  .pc-reticle .pull{transform-origin:48px 48px;animation:pull 3.6s ease-in-out infinite}
  @keyframes sweep{to{transform:rotate(360deg)}}
  @keyframes pull{0%,100%{transform:scale(1);opacity:.85}50%{transform:scale(.88);opacity:.5}}
  .pc-focusline{margin:0;font:600 var(--p-type-body)/1.35 var(--display);color:var(--ink);
    animation:breathe 4.2s ease-in-out infinite}
  @keyframes breathe{0%,100%{opacity:.96}50%{opacity:.42}}
  .pc-why{font:var(--p-type-meta)/1.5 var(--ui);color:var(--ink-quiet);margin:8px 0 0;text-wrap:balance}
  .pc-still .pc-focusline{animation:none}
  .pc-refused .pc-focusline{color:var(--degraded-text)}
  .pc-refused .pc-reticle{opacity:.35}

  /* the top sheet: page one whole on the cream sheet, the tilted second
     sheet under it (StagedPage's bp-page, create.css's .sheet -- one idiom).
     Page one at a glance, not the item card's near edge-to-edge preview: the
     form is the job here, so the page stops at 40% of the screen (the belt
     is one tap away for anyone who needs to read it). */
  .pc-topsheet{padding:8px 0 4px;animation:landed .6s cubic-bezier(.3,.7,.2,1) backwards}
  @keyframes landed{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}
  .pc-sheet{position:relative;width:max-content;max-width:100%;margin:0 auto;padding:8px;box-sizing:border-box;
    background:#f6f4ee;border-radius:5px;
    box-shadow:0 18px 44px rgba(0,0,0,.45),0 1px 0 rgba(255,255,255,.4) inset}
  .pc-sheet::before{content:"";position:absolute;inset:0;background:#e7e3d8;border-radius:5px;
    transform:rotate(-1.6deg) translate(-4px,4px);z-index:-1}
  .pc-sheet img{display:block;max-width:100%;height:auto;max-height:min(calc(100dvh * .4), 340px);
    border-radius:2px;background:#fff}

  /* the caption (the desk's .cap, in the phone's prose face) */
  .pc-cap{margin:14px 0 0;text-align:center;font:var(--p-type-meta)/1.5 var(--ui);color:var(--ink-quiet);text-wrap:pretty}
  .pc-cap b{display:block;font-weight:500;color:var(--ink)}
  .pc-cap .p-body{display:inline-block;vertical-align:middle;margin:0 8px 2px 0}
  .pc-done .pc-cap .p-body{display:none}
  .pc-reading .pc-drop{margin-top:14px}

  @media (prefers-reduced-motion:reduce){
    .pc-chip{transition:none}
    .pc-topsheet,.pc-reticle .sweep,.pc-reticle .pull,.pc-focusline{animation:none}
  }
</style>
