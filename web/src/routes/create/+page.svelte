<script>
  import { onMount } from "svelte";
  import { beforeNavigate, goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import "./create.css";
  import { mountCreate } from "./create.behaviour.js";
  import { mountConstellations } from "$lib/backdrops/constellations.js";
  import Chrome from "$lib/Chrome.svelte";
  import PageSky from "$lib/PageSky.svelte";
  import { readHome } from "$lib/data/workspace.js";
  import { rollSeed, seedFromWorkspace } from "$lib/sky.js";
  import { isPocket, watchPocket } from "$lib/pocket/media.js";
  import Reticle from "$lib/reading/Reticle.svelte";
  import Pocket from "./pocket.svelte";
  import ImportanceTiles from "$lib/editing/ImportanceTiles.svelte";
  import ChooserCard from "$lib/editing/ChooserCard.svelte";
  import { periodChoices } from "$lib/editing/item-draft.js";
  import { dayMonthYear, every, todayIso as deviceToday } from "$lib/format.js";
  import { RECURRENCE_DEFAULT, REMINDER_DEFAULT, toggleReminder } from "./entry.js";

  /**
   * New entry — the full form (CON-9: "create = genesis"). Reached from the
   * north-star drawer's "open the full form" link (CON-12), which offers type
   * chips and a drop target for the quick path; this screen is the considered
   * one.
   *
   * The form's own idea is progressive disclosure: it opens as a name, five
   * type chips and a drop target, and only unfolds the rest once you have
   * started. Nothing is assumed and nothing is asked twice.
   *
   * Built from design/v19/create-v3.html (#474/#475/#476) and owned here from
   * that point on. Three rulings: the backdrop carries this instance's own
   * households, the card grows from its centre, and dropping a document
   * splits the screen into the form and a reading lane (create.css has the
   * detail). The living backdrop is $lib/backdrops/constellations.js, ported
   * from the same sheet — this file only mounts it and tears it down, the
   * same shape as settings/mail/+page.svelte's relay.
   */
  let { data } = $props();
  /* #1459: false when the instance has no TIKA_URL; the copy then stops promising a read. */
  const documentReading = data?.documentReading !== false;

  /** @type {?HTMLDivElement} */
  let backdropRoot = null;

  /* #1463: the required importance row (round 6 P). The tiles are Svelte; the
     form's imperative behaviour reads the pick through `importance` and hears
     the section's colour through `setColour`. */
  /** @type {"low" | "normal" | "high" | null} */
  let importance = $state(null);
  /** @type {?string} */
  let importanceColour = $state(null);

  /* #1468 (round 6 Q): the key date, the repeat and the reminders are pressed
     values; pressing one stands the chooser card in the lane, where a dropped
     document is read. The values live here and the form's behaviour reads them
     through `pickers`, as it reads the importance. */
  let dueDate = $state("");
  let recurrence = $state(RECURRENCE_DEFAULT);
  /** Furthest first, as the engine's own pair is. */
  let reminders = $state([...REMINDER_DEFAULT]);
  /** @type {"date" | "recur" | "reminder" | null} */
  let choosing = $state(null);
  /** @type {?HTMLElement} the pressed value, which takes focus back */
  let pressed = null;

  const pickers = {
    date: () => dueDate,
    setDate: (/** @type {string} */ iso) => { dueDate = iso; },
    months: () => recurrence,
    reminders: () => [...reminders],
    /** The member's own pair from Settings, until the reminders are touched. */
    setDefaultReminders: (/** @type {number[]} */ days) => { if (!remindersTouched) reminders = [...days]; },
  };
  let remindersTouched = false;

  /** @param {"date" | "recur" | "reminder"} key @param {Event} event */
  function press(key, event) {
    if (choosing === key) { closeChooser(true); return; }
    pressed = /** @type {HTMLElement} */ (event.currentTarget);
    choosing = key;
  }

  /** @param {boolean} refocus  focus goes back to the pressed value */
  function closeChooser(refocus) {
    choosing = null;
    if (refocus && pressed?.isConnected) pressed.focus({ preventScroll: true });
  }

  /** @param {string} value */
  function pick(value) {
    if (choosing === "date") {
      dueDate = value;
      form?.pickerChanged("date");
      closeChooser(true);
    } else if (choosing === "recur") {
      recurrence = Number(value);
      form?.pickerChanged("recur");
      closeChooser(true);
    } else if (choosing === "reminder") {
      remindersTouched = true;
      reminders = toggleReminder(reminders, Number(value));
      form?.pickerChanged("reminder");
    }
  }

  /* The shared chrome's who-and-where (#1010), off the same readHome the
     backdrop already makes: null until it lands, and Chrome draws without. */
  /** @type {Awaited<ReturnType<typeof readHome>> | null} */
  let chrome = $state(null);

  const todayIso = $derived(/** @type {{ today?: string } | null} */ (chrome)?.today || deviceToday());
  const ask = $derived(
    choosing === "date" ? { key: /** @type {const} */ ("due"), label: "key date", heading: "key date", value: dueDate || null, choices: [], today: todayIso }
      : choosing === "recur" ? { key: /** @type {const} */ ("months"), label: "Repeats every", heading: "repeats every", value: String(recurrence), choices: periodChoices(recurrence), today: todayIso }
      : choosing === "reminder" ? { key: /** @type {const} */ ("reminders"), label: "reminders", heading: "reminders", value: null, choices: [], days: reminders, due: dueDate || null, today: todayIso }
      : null);

  /** What each pressed value shows. */
  const dateWords = $derived(dueDate ? dayMonthYear(dueDate) : "choose a date");
  const repeatWords = $derived(recurrence === 0 ? "one-off" : every(recurrence).replace("every year", "every 12 months"));
  const reminderWords = $derived(reminders.length
    ? `${[...reminders].sort((a, b) => a - b).map((day) => `${day} d`).join(" · ")} before`
    : "none");


  /** The mounted form's own dirty check (#1151 W1-S1), null until onMount —
      which is also the whole of the window a misclick has no guard, since
      nothing can be typed before the form exists either. */
  /** @type {ReturnType<typeof mountCreate> | null} */
  let form = null;

  /* A misclick on the light-dismiss stage below, a chrome link away, or any
     other in-app navigation while the form holds something typed (#1151
     W1-S1): no confirm sheet exists on the desk the way the pocket's own
     form has one, so this is the browser's own confirm() — no new layout,
     same "discard changes" question the pocket's sheet asks. */
  beforeNavigate(({ cancel }) => {
    if (form?.isDirty() && !confirm("Discard this entry? What you've typed will be lost.")) cancel();
  });

  /** Closing the tab or reloading: beforeNavigate never sees this, so the
      browser's own beforeunload prompt is the only honest warning left.
      @param {BeforeUnloadEvent} event */
  function onBeforeUnload(event) {
    if (!form?.isDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  }

  onMount(() => {
    form = mountCreate({
      documentReading,
      importance: { get: () => importance, setColour: (colour) => { importanceColour = colour; } },
      pickers,
    });
    /* #1251: the desk's heading is the form's first control and ships empty,
       so it takes the caret on arrival. Not on a phone: the keyboard must
       not pop over the page. */
    if (!isPocket()) document.getElementById("f-name")?.focus({ preventScroll: true });
    let disposed = false;
    let backdropTeardown = () => {};
    /* The backdrop's households come through the same seam home's sky does
       (readHome → galaxyOf). The one seed follows home's own pattern: pinned
       to the workspace under fixtures, so the fidelity gate can compare one
       deterministic sky against the mockup's; rolled fresh otherwise. */
    readHome().then((view) => {
      if (disposed) return;
      chrome = view;
      /* #1120: the pocket hides the constellations (proposal §1.10), so a
         phone does not run them behind its own sky. */
      if (isPocket()) return;
      const seed = data?.fixtures ? seedFromWorkspace(view.primary ?? "") : rollSeed();
      backdropTeardown = mountConstellations(
        /** @type {HTMLDivElement} */ (backdropRoot),
        { seed, galaxy: view.galaxy, primary: view.primary },
      );
    });
    return () => {
      disposed = true;
      form?.teardown();
      form = null;
      backdropTeardown();
    };
  });

  /* PageSky draws nothing on a phone, which draws its own (#1689) */
  let pocket = $state(isPocket());
  $effect(() => watchPocket((now) => (pocket = now)));
</script>

<svelte:head>
  <link rel="stylesheet" href="/screens/family.css" />
  <title>Orbit — new entry</title>
</svelte:head>

<svelte:window onbeforeunload={onBeforeUnload} />

<div class="create-page">
<div class="backdrop" bind:this={backdropRoot} aria-hidden="true"></div>

<!-- The shared chrome (#1010, owner 2026-09-16): the way back to the sky and
     the account menu, as on every sub-screen. The stage's own light-dismiss
     below is the other way out and stays. -->
<Chrome user={chrome?.user} current="" household={chrome?.household} />

<!-- #1120, proposal §2.5: the pocket's own create, chosen by CSS. -->
<Pocket {documentReading} />

<!-- §14 (#471): clicking off the form returns to the landing page — the same
     light-dismiss the item view has. -->
<div class="stage" role="main" onclick={(event) => { if (event.target === event.currentTarget) goto(resolve("/home")); }}>
  <!-- #843: sr-only -- the card's own name field carries the visible title. -->
  <h1 class="sr-only">Add to your orbit</h1>
  <div class="lanes" class:choosing={ask}>

  <form class="glass card" id="card">
    <input id="f-name" class="name-title" placeholder="Name this entry" aria-label="name" autocomplete="off">
    <div class="sub">add something to your orbit</div>

    <!-- #1058(b)/#1069: a section must be picked, with no default; the save
         button stays disabled until one is chosen, and the reason sits beside
         it (create.behaviour.js's refusal note), in the engine's words from
         its dry run (ADR-0034). Populated from the household's sections once they load —
         mountCreate() draws the buttons, the same pattern the chips once were
         is, rather than a second, Svelte-reactive way of doing the same job. -->
    <div class="field">
      <label id="sections-label">section</label>
      <div class="sections" id="sections" role="group" aria-labelledby="sections-label"></div>
    </div>

    <!-- #1463 (round 6 P): importance is required, no default. Three tiles,
         each the planet its level draws, in the chosen section's colour; Add
         stays held, with "choose an importance" beside it, until one is picked. -->
    <div class="field imp-row">
      <label id="importance-label">importance</label>
      <ImportanceTiles value={importance} colour={importanceColour} required
                       onpick={(level) => { importance = /** @type {"low" | "normal" | "high"} */ (level); form?.importanceChanged(); }} />
    </div>

    <!-- #1244 (design/v19/create-dragover.html): the four brackets are the
         reticle's corners, parked on the zone; the words carry one copy per
         state, stacked in one cell so the zone never changes height. The
         live region below speaks the state a sighted reader sees. -->
    <div class="dropzone" id="dropzone" role="button" tabindex="0" aria-label="drop a document, or press enter to choose one">
      <span class="dz-corner tl" aria-hidden="true"></span><span class="dz-corner tr" aria-hidden="true"></span>
      <span class="dz-corner br" aria-hidden="true"></span><span class="dz-corner bl" aria-hidden="true"></span>
      <div class="dz-main">
        <span data-when="rest">drop a document</span>
        <span data-when="lock">release to add it</span>
        <span data-when="swap">release to swap the document</span>
      </div>
      <div class="dz-hint mono">
        {#if documentReading}
        <span data-when="rest">PDF or photo</span>
        {:else}
        <span data-when="rest">The file is attached to the item as it is.</span>
        {/if}
        <span data-when="arm">PDF or photo</span>
        <span data-when="lock">nothing is saved until you say</span>
      </div>
      <div class="dz-held" id="dz-held">&#9670; <b id="dz-held-name"></b> &middot; <span id="dz-held-size"></span> &middot; held in the lane on the right</div>
    </div>
    <div class="sr-only" id="dz-live" aria-live="polite"></div>

    <div class="disclose" id="disclose">
      <div class="disclose-inner"><div class="disclose-content">

        <div class="docnote mono" id="docnote">suggestions come from the document — nothing is saved until you accept</div>

        <div class="row2">
          <div class="field" id="field-provider">
            <label>provider</label>
            <input id="f-provider" placeholder="e.g. Aviva">
            <div class="tag">&#9670; from document <button type="button" class="accept" data-accept="field-provider">&#10003; accept</button></div>
          </div>
          <div class="field mono" id="field-ref">
            <label>reference / policy no.</label>
            <input id="f-ref" placeholder="e.g. POL-004471">
            <div class="tag">&#9670; from document <button type="button" class="accept" data-accept="field-ref">&#10003; accept</button></div>
          </div>
        </div>

        <div class="daterow">
          <div class="field f-date" id="field-date">
            <label for="f-date">key date</label>
            <button type="button" id="f-date" class="val" aria-haspopup="dialog" aria-expanded={choosing === "date"}
                    onclick={(event) => press("date", event)}>{dateWords}<span class="ch">change</span></button>
            <div class="tag">&#9670; from document <button type="button" class="accept" data-accept="field-date">&#10003; accept</button></div>
          </div>
          <div class="field f-recur">
            <label for="f-recur">recurrence</label>
            <button type="button" id="f-recur" class="val" aria-haspopup="dialog" aria-expanded={choosing === "recur"}
                    onclick={(event) => press("recur", event)}>{repeatWords}<span class="ch">change</span></button>
          </div>
        </div>

        <div class="row2">
          <div class="field" id="field-cost">
            <label>cost</label>
            <div class="prefix-wrap"><span class="prefix">&pound;</span>
              <input id="f-cost" type="number" min="0" step="0.01" placeholder="0.00"></div>
            <div class="tag">&#9670; from document <button type="button" class="accept" data-accept="field-cost">&#10003; accept</button></div>
          </div>
          <div class="field">
            <label for="f-reminder">reminders</label>
            <button type="button" id="f-reminder" class="val" aria-haspopup="dialog" aria-expanded={choosing === "reminder"}
                    onclick={(event) => press("reminder", event)}>{reminderWords}<span class="ch">change</span></button>
          </div>
        </div>

        <div class="field">
          <label>notes</label>
          <textarea id="f-notes" rows="2" placeholder="anything else worth keeping"></textarea>
        </div>

        <!-- #1058(e)/#1069: a failure is loud, not small print — the reason
             sits here, the button goes back to "Add to orbit", nothing typed
             is lost. No toast. create.behaviour.js also parks the refusal
             reason here while the entry cannot yet be saved. -->
        <div class="save-row">
          <div class="save-note" id="save-note" aria-live="polite"></div>
          <div class="save-buttons">
            <button type="submit" class="btn-primary">Add to orbit</button>
            <a href={resolve("/home")} class="cancel-link">cancel</a>
          </div>
        </div>

      </div></div>
    </div>
  </form>

  <!-- ruling 3 (#474), §14: the reading lane, hidden until a document splits
       the screen. create.behaviour.js drives the two ratified states from the
       pick (#1245): "Reading your document" with the reticle breathing while
       the file is on its way, then `body.snap` — the top sheet lands with the
       real page one, drawn by the household's pre-attachment preview route
       (#476's renderer), while the inspection carries on reading alongside.
       The .cap's second line says which of those is still happening; the
       .honest line carries the read's own honest message when it has one. -->
  <aside class="glass readcard" id="readcard" aria-live="polite">
    <h2 id="read-head">Reading your document</h2>

    <div class="focus">
      <Reticle class="reticle" />
      <div class="focusline" id="focusline">Focusing on the anomaly</div>
      <div class="why" id="focuswhy">
        orbit is reading the pages it was given<br>
        nothing is saved, and nothing is assumed
      </div>
    </div>

    <div class="topsheet">
      <div class="sheet">
        <!-- Page one, for real: the picture the preview route drew of the file
             just picked (#1245/#476), in the idiom document-card/round-6
             ratified for a real page. Paper is paper in every theme, so this
             frame does not take theme ink. The src is set, and the object URL
             revoked, by create.behaviour.js; no src means no request. -->
        <img id="sheet-page" alt="">
      </div>
      <div class="cap"><b>Page one of the file you added</b><br>
        <span id="rc-capline">orbit is reading the pages it was given</span></div>
      <div class="honest" id="rc-honest"></div>
    </div>

    <div class="attach">
      <span class="file" id="rc-file"></span>
      <span><span id="rc-size"></span><span id="rc-refused" hidden></span><span id="rc-scan" hidden> &middot; <span class="clean">scanned clean</span></span></span>
      <button type="button" id="rc-drop">not this one</button></div>
  </aside>

  <!-- #1468 (round 6 Q): the chooser card stands in the lane where a dropped
       document is read, and the reading card steps aside while it does. -->
  {#if ask}
    <div class="chooselane" data-chooser-card>
      <ChooserCard {ask} layout="beside" onpick={pick} onclose={() => closeChooser(true)} />
    </div>
  {/if}

  </div>
</div>

<PageSky stars={false} hidden={pocket} />
</div>
