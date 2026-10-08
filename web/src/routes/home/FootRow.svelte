<script>
  import { createArm } from "$lib/pocket/arm.js";

  /**
   * THE DRAWER'S FOOT ROW (#1319; owner-decisions §34; design/v19/
   * belt-purpose/round-3/f-preview-beside-tracked.html, the foot):
   *
   *   [spacer]   snooze · complete · attach a document · retire   ✎ 🔗
   *
   * The four pills centred across the drawer, no "actions" heading; edit
   * (the pencil) and copy link (the chain link) as 32px round glass icons,
   * 44px targets, at the row's right end. Under 560px the pills wrap to two
   * rows of two and the icons take a line of their own beneath them,
   * right-aligned. Desk (ItemView.svelte) and phone (ItemDrawer.svelte)
   * alike; on the phone the pills are the kit's.
   *
   * RETIRE ARMS, as the reader's remove does (#1054): the first press fills
   * the pill and says "press again to retire"; the second retires; four
   * seconds or Escape disarm it.
   *
   * SNOOZE opens the calendar beside the drawer (the phone's bottom sheet),
   * "snooze until"; the screen sends the day picked (owner, 2026-10-08:
   * "pick a date should not be removed"). Pressed again, the calendar goes.
   *
   * COMPLETE puts the rows into their completing mode (EditRows.svelte):
   * the date, the cost and the notes, then record or cancel in the pills'
   * place. EDIT, the pencil, puts them into editing: save and cancel in the
   * pills' place, the pencil lit while it lasts (round 8, `editing`).
   *
   * WHAT FITS THE ITEM'S STATE (#1319; the coordinator's ruling,
   * 2026-10-08: the drawer opens any item). A retired, cancelled or expired
   * item (`standing: "ended"`) offers only RESTORE, the reverse of retire (the
   * status command), and the chain link. A one-off already done (`standing:
   * "done"`) offers nothing that would undo or end it: attach a document,
   * the pencil and the chain link.
   *
   * DISCARD (#1319 stage 3b; the coordinator's ruling, 2026-10-08): rows
   * holding changes are not thrown away by the first cancel, Escape or
   * close; the cancel pill arms as retire does and reads "discard
   * changes?" (`discarding`), and a second press discards
   * (discard-guard.js).
   *
   * ATTACH opens the file picker; the file goes up through the per-item
   * documents route (workspace.js attachItemDocument) and its scan.
   *
   * @typedef {{
   *   title: string,
   *   pocket?: boolean,
   *   busy?: import('./drawer-acts.js').DrawerBusy,
   *   mode?: "read" | "edit" | "complete",
   *   snoozing?: boolean,
   *   held?: boolean,
   *   standing?: "ended" | "done" | null,
   *   discarding?: boolean,
   *   onrestore?: () => unknown,
   *   onsnooze: (from: HTMLElement) => unknown,
   *   oncomplete: (from: HTMLElement) => unknown,
   *   onattach: (file: File) => unknown,
   *   onretire: () => unknown,
   *   oncopy: () => Promise<boolean>,
   *   onedit: () => unknown,
   *   onsave: () => unknown,
   *   onrecord: () => unknown,
   *   oncancel: () => unknown,
   * }} Props
   */
  /** @type {Props} */
  let {
    title, pocket = false, busy = null, mode = "read", snoozing = false, held = false,
    standing = null, discarding = false, onrestore = undefined, onsnooze, oncomplete, onattach, onretire, oncopy, onedit, onsave, onrecord, oncancel,
  } = $props();

  let armed = $state(false);
  let copiedShown = $state(false);
  const arm = createArm({ onchange: (next) => { armed = next; } });
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let copiedTimer;

  /** @type {HTMLInputElement | undefined} */
  let picker = $state();
  const again = $derived(pocket ? "tap again to retire" : "press again to retire");

  /* Escape takes an armed retire before anything else does (home's own
     Escape puts the drawer away). */
  $effect(() => {
    if (!armed) return;
    /** @param {KeyboardEvent} event */
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      arm.disarm();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  $effect(() => () => { arm.disarm(); clearTimeout(copiedTimer); });

  function retire() {
    if (arm.tap()) onretire();
  }

  async function copy() {
    const ok = await oncopy();
    clearTimeout(copiedTimer);
    copiedShown = ok;
    if (ok) copiedTimer = setTimeout(() => { copiedShown = false; }, 2000);
  }

  function pick() {
    arm.disarm();
    picker?.click();
  }
  /** @param {Event} event */
  function picked(event) {
    const input = /** @type {HTMLInputElement} */ (event.currentTarget);
    const file = input.files?.[0];
    input.value = "";
    if (file) onattach(file);
  }
</script>

<div class="ivfootrow" class:pocket>
  <span class="spacer" aria-hidden="true"></span>
  {#if mode === "edit"}
    <div class="ivacts" class:p-pills={pocket} role="group" aria-label="Editing {title}">
      <button type="button" class:p-pill={pocket} class="act-accent" style="--act:var(--accent);--act-text:var(--accent-text)"
              disabled={busy !== null || held} onclick={onsave}>{busy === "save" ? "saving…" : "save"}</button>
      <button type="button" class:p-pill={pocket} class="discard" class:danger={pocket && discarding} class:armed={discarding}
              style={discarding ? "--act:var(--overdue);--act-text:var(--overdue-text)" : undefined}
              disabled={busy !== null} onclick={oncancel}>{discarding ? "discard changes?" : "cancel"}</button>
    </div>
  {:else if mode === "complete"}
    <div class="ivacts" class:p-pills={pocket} role="group" aria-label="Completing {title}">
      <button type="button" class:p-pill={pocket} class="act-ok" style="--act:var(--ok);--act-text:var(--ok-text)"
              disabled={busy !== null} onclick={onrecord}>{busy === "complete" ? "recording…" : "record"}</button>
      <button type="button" class:p-pill={pocket} class="discard" class:danger={pocket && discarding} class:armed={discarding}
              style={discarding ? "--act:var(--overdue);--act-text:var(--overdue-text)" : undefined}
              disabled={busy !== null} onclick={oncancel}>{discarding ? "discard changes?" : "cancel"}</button>
    </div>
  {:else if standing === "ended"}
    <div class="ivacts" class:p-pills={pocket} role="group" aria-label="Actions for {title}">
      <button type="button" class:p-pill={pocket} class="act-ok"
              style="--act:var(--ok);--act-text:var(--ok-text)" disabled={busy !== null}
              aria-label="Restore {title}" onclick={() => onrestore?.()}>{busy === "restore" ? "restoring…" : "restore"}</button>
    </div>
  {:else if standing === "done"}
    <div class="ivacts" class:p-pills={pocket} role="group" aria-label="Actions for {title}">
      <button type="button" class:p-pill={pocket} class="act-up"
              style="--act:var(--upcoming);--act-text:var(--upcoming-text)" disabled={busy !== null}
              aria-label="Attach a document to {title}" onclick={pick}>{busy === "attach" ? "attaching…" : "attach a document"}</button>
    </div>
  {:else}
    <div class="ivacts" class:p-pills={pocket} role="group" aria-label="Actions for {title}">
      <button type="button" class:p-pill={pocket} class="act-warm" class:lit={snoozing} data-pick
              style="--act:var(--warm);--act-text:var(--warm-text)" disabled={busy !== null}
              aria-haspopup="dialog" aria-expanded={snoozing}
              aria-label="Snooze {title}" onclick={(event) => { arm.disarm(); onsnooze(event.currentTarget); }}
              >{busy === "snooze" ? "snoozing…" : "snooze"}</button>
      <button type="button" class:p-pill={pocket} class="act-ok"
              style="--act:var(--ok);--act-text:var(--ok-text)" disabled={busy !== null}
              aria-label="Complete {title}" onclick={(event) => { arm.disarm(); oncomplete(event.currentTarget); }}>complete</button>
      <span class="brk" aria-hidden="true"></span>
      <button type="button" class:p-pill={pocket} class="act-up"
              style="--act:var(--upcoming);--act-text:var(--upcoming-text)" disabled={busy !== null}
              aria-label="Attach a document to {title}" onclick={pick}>{busy === "attach" ? "attaching…" : "attach a document"}</button>
      <button type="button" class:p-pill={pocket} class="retire" class:danger={pocket} class:armed
              style="--act:var(--overdue);--act-text:var(--overdue-text)" disabled={busy !== null}
              aria-label={armed ? `Retire ${title}: ${pocket ? "tap" : "press"} again to confirm` : `Retire ${title}`}
              onclick={retire}>{armed ? again : busy === "retire" ? "retiring…" : "retire"}</button>
    </div>
  {/if}
  <span class="ivtools">
    <span class="copied" class:show={copiedShown} role="status" aria-live="polite">{copiedShown ? "link copied" : ""}</span>
    <!-- the pencil: lit while the rows are being edited (round 8); an
         ended item is restored before it is edited -->
    {#if standing !== "ended"}
    <button type="button" class="ivicon ivedit" class:on={mode === "edit"} aria-label="Edit this item"
            aria-pressed={mode === "edit"} title="edit" disabled={busy !== null && mode !== "edit"}
            onclick={() => { arm.disarm(); if (mode !== "edit") onedit(); }}>
      <i><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.6 2.6 13.4 5.4 5.6 13.2 2.4 13.6 2.8 10.4Z"/><path d="M9.2 4 12 6.8"/></svg></i>
    </button>
    {/if}
    <button type="button" class="ivicon ivlink" aria-label="Copy link" title="copy link" onclick={copy}>
      <i><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.4-2.4a2.6 2.6 0 0 0-3.7-3.7l-1 1"/><path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.1 9.2a2.6 2.6 0 0 0 3.7 3.7l1-1"/></svg></i>
    </button>
  </span>
  <input bind:this={picker} type="file" accept="application/pdf,image/*" hidden onchange={picked}>
</div>

<style>
  /* F: THE FOOT ROW. A spacer, the pills centred in the drawer's width, the
     two icons right-aligned: the outer columns are equal, so the middle one
     is the drawer's centre. */
  .ivfootrow{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;
    column-gap:8px;margin-top:18px}
  .ivfootrow>.ivtools{justify-self:end}

  /* THE PILLS: the belt's item card, verbatim (document-card/round-6's
     .acts); armed, the reader's remove pill */
  .ivacts{display:flex;flex-wrap:wrap;gap:7px;justify-content:center}
  .ivfootrow:not(.pocket) .ivacts button{font:11px var(--mono);color:var(--act-text,var(--act,var(--ink-mid)));
    background:var(--panel);border:1px solid color-mix(in srgb, var(--act,var(--ink-mid)) 40%, transparent);
    border-radius:999px;padding:6px 13px;cursor:pointer;line-height:1.55}
  .ivfootrow:not(.pocket) .ivacts button:hover{border-color:var(--act,var(--ink))}
  .ivfootrow:not(.pocket) .ivacts button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .ivacts button:disabled{opacity:.5;cursor:default}
  .ivacts button.armed{background:var(--act);color:var(--bg);border-color:var(--act)}
  .ivfootrow:not(.pocket) .ivacts button.lit{border-color:var(--act)}
  .ivacts .brk{display:none}

  /* THE TWO ICONS: 32px round glass in the muted ink, accent on hover and
     focus, a 44px target; inline strokes, 16px glyphs */
  .ivtools{display:flex;align-items:center;justify-content:flex-end;gap:0;flex:none;margin-right:-6px}
  .ivicon{position:relative;width:44px;height:44px;padding:0;border:0;background:none;
    display:grid;place-items:center;cursor:pointer;color:var(--ink-mid)}
  .ivicon i{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;
    background:var(--panel);border:1px solid var(--line);backdrop-filter:blur(8px);
    transition:color .15s,border-color .15s}
  .ivicon svg{width:16px;height:16px;display:block;fill:none;stroke:currentColor;stroke-width:1.5;
    stroke-linecap:round;stroke-linejoin:round}
  .ivicon:hover,.ivicon:focus-visible{color:var(--accent-text)}
  .ivicon:hover i,.ivicon:focus-visible i{border-color:var(--accent)}
  .ivicon:focus-visible{outline:none}
  .ivicon:focus-visible i{box-shadow:0 0 0 2px var(--accent)}
  /* editing: the pencil is lit, as round 8 draws it */
  .ivicon.on{color:var(--accent-text)}
  .ivicon.on i{border-color:var(--accent)}
  .ivicon:disabled{opacity:.5;cursor:default}
  /* "link copied", said beside the icon for two seconds */
  .copied{font:11px var(--mono);color:var(--accent-text);letter-spacing:.04em;white-space:nowrap;
    opacity:0;transition:opacity .2s;pointer-events:none;margin-right:2px}
  .copied.show{opacity:1}
  .copied:not(.show){width:0;overflow:hidden;margin:0}

  /* DOES NOT FIT: at phone width the pills wrap to two rows of two and the
     icons take a line of their own under them, right-aligned */
  @media (max-width:560px){
    .ivfootrow{grid-template-columns:minmax(0,1fr);row-gap:4px}
    .ivfootrow>.spacer{display:none}
    .ivfootrow>.ivacts{justify-self:center}
    .ivacts .brk{display:block;flex-basis:100%;height:0}
  }
  /* the pocket's own scale: the kit's pills, its gap */
  .ivfootrow.pocket{margin-top:16px}
  .ivfootrow.pocket .ivacts{gap:var(--p-pill-gap, 8px)}
  @media (prefers-reduced-motion: reduce){ .copied,.ivicon i{transition:none} }
</style>
