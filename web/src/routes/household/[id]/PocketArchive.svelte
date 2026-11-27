<script>
  import { plural, sizeLabel } from "$lib/format.js";
  import ArmButton from "$lib/pocket/ArmButton.svelte";
  import Row from "$lib/pocket/Row.svelte";
  import Sheet from "$lib/pocket/Sheet.svelte";
  import { wake } from "$lib/pocket/wake.js";
  import { exportFileName, passphraseLength } from "./archive.js";
  import { createArchiveController } from "./archive-controller.svelte.js";

  /*
   * THE ARCHIVE ON A PHONE (#1122, proposal §2.10 item 5; the card ratified
   * in #1002, the tab grammar §22). Owner only; the page does not draw it for
   * anyone else. One card, two tabs as a joined pill pair that wraps under the
   * heading at this width.
   *
   *   take it with you   a sentence, `export this system`, the passphrase
   *                      twice, `write the archive` (arms), a progress row
   *                      while the server writes it, then the download row
   *   bring one in       `choose a file`, the passphrase, `look inside`, the
   *                      preview (what it holds, what is already here and
   *                      stays out), `bring in N entries` (arms)
   *
   * RECENT AUTHENTICATION (§17): when the server answers an archive act with
   * `recent_authentication_required`, the callout asks the reader to prove it
   * is them (their password, or their identity provider) and then runs the
   * same act again. The archive write routes do ask for this (#1132:
   * `archive_export`/`archive_import` in recent-auth.ts) — exporting hands
   * the whole household away decrypted, importing writes into it; the
   * callout answers that real refusal, it never invents one (#1151 W2-Q7).
   */

  /** @type {{ householdId: string, householdName: string, entries: number, sections: number, limits?: import("$lib/data/engine-limits.js").EngineLimits | null }} */
  let { householdId, householdName, entries, sections, limits = null } = $props();

  /* The one state machine (archive-controller.svelte.js), shared with the desk's card. */
  const a = createArchiveController({ householdId: () => householdId, limits: () => limits, tabIdPrefix: "hh-tab-", wake });
</script>

<section class="p-card hh-archive" aria-labelledby="hh-archive-title" data-hh="archive">
  <div class="hh-archive-head">
    <h2 class="p-caps" id="hh-archive-title">The archive</h2>
    <div class="p-tabs" role="tablist" aria-labelledby="hh-archive-title">
      <button role="tab" id="hh-tab-out" aria-selected={a.tab === "out"} aria-controls="hh-panel-out"
              tabindex={a.tab === "out" ? 0 : -1} onclick={() => (a.tab = "out")} onkeydown={a.tabKey}>take it with you</button>
      <button role="tab" id="hh-tab-in" aria-selected={a.tab === "in"} aria-controls="hh-panel-in"
              tabindex={a.tab === "in" ? 0 : -1} onclick={() => (a.tab = "in")} onkeydown={a.tabKey}>bring one in</button>
    </div>
  </div>

  {#if a.stepUpNotice}<p class="hh-note">{a.stepUpNotice}</p>{/if}

  <div role="tabpanel" id="hh-panel-out" aria-labelledby="hh-tab-out" hidden={a.tab !== "out"}>
    <div class="hh-manifest">
      <div class="p-kv"><span>entries</span><b>{entries}</b></div>
      <div class="p-kv"><span>sections</span><b>{sections}</b></div>
      <div class="p-kv"><span>documents</span><b>travel with it</b></div>
      <div class="p-kv"><span>people</span><b class="ended">never in the file</b></div>
    </div>

    {#if a.outPhase === "rest"}
      <button class="p-pill act-accent wide" onclick={a.startExport}>export this system</button>
    {:else if a.outPhase === "form"}
      <div class="hh-fields">
        <label class="hh-label" for="hh-pass-out">a passphrase for the file</label>
        <input id="hh-pass-out" class="p-input" type="password" autocomplete="new-password" enterkeyhint="next"
               bind:value={a.passOut}>
        <label class="hh-label" for="hh-pass-again">the passphrase again</label>
        <input id="hh-pass-again" class="p-input" type="password" autocomplete="new-password" enterkeyhint="done"
               bind:value={a.passAgain}>
        <p class="hh-note warm">Orbit never keeps this passphrase · without it the file cannot be opened</p>
        {#if a.outRefusal && (a.passOut || a.passAgain)}<p class="hh-note">{a.outRefusal}</p>{/if}
      </div>
      {#if a.outRefusal}
        <button class="p-pill act-accent wide" disabled>write the archive</button>
      {:else}
        <ArmButton label="write the archive" danger={false} wide class="act-accent" onfire={a.writeArchive} />
      {/if}
      {#if a.outProblem}<p class="p-error" role="alert">{a.outProblem}</p>{/if}
    {:else if a.outPhase === "writing"}
      <div class="hh-progress" role="status">
        <span class="p-body accent breathing" aria-hidden="true"></span>
        <span><b>writing the archive</b><small>encrypting {plural(entries, "entry", "entries")} and their documents</small></span>
        <i aria-hidden="true"></i>
      </div>
    {:else if a.written}
      <div class="hh-written">
        <Row title={exportFileName(a.written)} meta="ready until {a.readyUntil} · {a.written.includesDocuments ? 'documents in' : 'no documents'}"
             href={a.written.downloadUrl} trail="download">
          {#snippet mark()}<span class="p-paper">◆</span>{/snippet}
        </Row>
      </div>
      <!-- #1792: Orbit keeps a household's last few exports (the export's answer says how many). -->
      {#if a.written.keepPerHousehold === 1}
        <p class="hh-note">kept here until then · Orbit keeps only your latest; writing another replaces it</p>
      {:else}
        <p class="hh-note">kept here until then · Orbit keeps your last {a.written.keepPerHousehold ?? 2}; writing more replaces the oldest</p>
      {/if}
    {/if}
  </div>

  <div role="tabpanel" id="hh-panel-in" aria-labelledby="hh-tab-in" hidden={a.tab !== "in"}>
    <input class="sr-only" type="file" accept=".orbit,.json,application/octet-stream,application/json" tabindex="-1" aria-hidden="true"
           bind:this={a.picker} onchange={a.chose}>
    {#if a.inPhase === "done"}
      <p class="hh-done"><span class="p-body ok" aria-hidden="true"></span>brought in {plural(a.brought, "entry", "entries")} from {a.preview?.householdName ?? "the archive"}</p>
      <button class="p-pill wide" onclick={a.startOver}>bring in another</button>
    {:else}
      {#if a.file}
        <div class="hh-written">
          <Row title={a.file.name} meta={sizeLabel(a.file.size)}>
            {#snippet mark()}<span class="p-paper">◆</span>{/snippet}
          </Row>
        </div>
      {/if}
      {#if a.inPhase === "rest"}
        <button class="p-pill act-accent wide" onclick={() => a.picker?.click()}>choose a file</button>
        <p class="hh-note">an Orbit archive{limits ? `, up to ${sizeLabel(limits.archiveFileBytes)}` : ""}</p>
      {:else if a.inPhase === "chosen" || a.inPhase === "looking"}
        <div class="hh-fields">
          <label class="hh-label" for="hh-pass-in">the file's passphrase</label>
          <input id="hh-pass-in" class="p-input" type="password" autocomplete="off" enterkeyhint="go"
                 bind:value={a.passIn} onkeydown={(event) => { if (event.key === "Enter") a.lookInside(); }}>
        </div>
        <div class="hh-pair">
          <button class="p-pill" onclick={a.startOver}>another file</button>
          <button class="p-pill filled" disabled={passphraseLength(a.passIn) < a.passphraseMin || a.inPhase === "looking"} onclick={a.lookInside}>
            {a.inPhase === "looking" ? "looking…" : "look inside"}</button>
        </div>
      {:else if a.preview && a.inPhase !== "bringing"}
        <div class="p-card proposed hh-preview">
          <p class="p-caps">inside · {a.preview.householdName}</p>
          <div class="p-kv"><span>entries</span><b>{a.preview.items}</b></div>
          <div class="p-kv"><span>sections</span><b>{a.preview.sections}</b></div>
          <div class="p-kv"><span>documents</span><b class:ended={a.preview.documentsExcluded}>{a.preview.documentsExcluded ? `${a.preview.documents} · stay out for now` : a.preview.documents}</b></div>
          {#each a.preview.conflicts as clash (clash.id)}
            <div class="p-kv hh-clashrow"><span class="hh-clash">{clash.title}</span><b class="soon">already here · stays out</b></div>
          {/each}
        </div>
        {#if a.bringCount > 0}
          <ArmButton label="bring in {plural(a.bringCount, 'entry', 'entries')}" wide danger={false}
                     class="act-accent" armedLabel="tap again · it can't be undone as one act" onfire={a.bringIn} />
        {:else}
          <p class="hh-note">everything in this archive is already here</p>
        {/if}
        <button class="p-pill wide hh-again" onclick={a.startOver}>choose another file</button>
      {:else if a.inPhase === "bringing"}
        <div class="hh-progress" role="status">
          <span class="p-body accent breathing" aria-hidden="true"></span>
          <span><b>bringing it in</b><small>{plural(a.bringCount, "entry", "entries")}</small></span>
          <i aria-hidden="true"></i>
        </div>
      {/if}
      {#if a.inProblem}<p class="p-error" role="alert">{a.inProblem}</p>{/if}
    {/if}
  </div>
</section>

<Sheet bind:open={a.challengeOpen} size="callout" title="Confirm it’s you" onclose={a.dropRetry}>
  <p class="p-prose hh-sheet-say">The archive carries everything in {householdName}, so Orbit asks you to sign in again first.</p>
  {#if a.hasPassword !== false}
    <form id="hh-challenge-form" onsubmit={(event) => { event.preventDefault(); a.prove(); }}>
      <label class="hh-label" for="hh-proof">your password</label>
      <input id="hh-proof" class="p-input" type="password" autocomplete="current-password" enterkeyhint="done"
             bind:value={a.currentPassword}>
    </form>
  {/if}
  {#if a.challengeProblem}<p class="p-error" role="alert">{a.challengeProblem}</p>{/if}
  {#snippet foot()}
    {#if a.hasPassword === false}
      <button class="p-pill filled" onclick={a.toProvider}>confirm with your identity provider →</button>
    {:else}
      <button class="p-pill filled" type="submit" form="hh-challenge-form" disabled={!a.currentPassword || a.proving}>
        {a.proving ? "confirming…" : "confirm and carry on"}</button>
    {/if}
  {/snippet}
</Sheet>

<style>
  /* §22 under 560px: the pill pair follows the heading, wrapping under it. */
  .hh-archive-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px;margin:0 0 12px}
  .hh-archive-head .p-caps{margin:0}
  [role=tabpanel]{animation:hh-panel 240ms var(--p-ease) both}
  @keyframes hh-panel{from{opacity:0;transform:translateY(4px)}}

  .hh-manifest{margin:0 0 16px}
  .hh-manifest .p-kv:last-child{border-bottom:0}
  .p-kv .ended{color:var(--ink-quiet)}

  .hh-fields{display:flex;flex-direction:column;margin:0 0 12px}
  .hh-label{font:var(--p-type-caps)/1.4 var(--mono);letter-spacing:var(--p-type-caps-track);text-transform:uppercase;
    color:var(--ink-quiet);margin:12px 0 6px}
  .hh-label:first-child{margin-top:0}
  .hh-note{margin:8px 0 0;font:var(--p-type-meta)/1.5 var(--ui);color:var(--ink-quiet)}
  .hh-note.warm{color:var(--warm-text)}
  .p-pill:disabled{opacity:.45;cursor:default}

  .hh-progress{display:flex;align-items:center;gap:12px;min-height:var(--p-row-min);padding:0 4px;position:relative;overflow:hidden}
  .hh-progress > span:nth-child(2){display:flex;flex-direction:column;gap:2px;font:500 var(--p-type-body)/1.3 var(--ui);color:var(--ink)}
  .hh-progress small{font:var(--p-type-meta)/1.4 var(--mono);color:var(--ink-quiet)}
  .hh-progress .p-body{margin:0 7px}
  /* The desk has no spinner (§5.2); a thin accent comet runs the row's foot
     while the server works. Transform only. */
  .hh-progress i{position:absolute;left:0;bottom:0;height:2px;width:40%;border-radius:1px;
    background:linear-gradient(90deg, transparent, var(--accent), transparent);animation:hh-comet 1.4s var(--p-ease) infinite}
  @keyframes hh-comet{from{transform:translateX(-100%)}to{transform:translateX(250%)}}

  .hh-written{margin:0 calc(var(--p-card-pad) * -1) 4px}
  .hh-done{display:flex;align-items:center;gap:12px;margin:0 0 12px;font:var(--p-type-body)/1.4 var(--ui);color:var(--ink)}
  .hh-preview{margin:4px 0 12px}
  .hh-preview .p-kv:last-child{border-bottom:0}
  .hh-clashrow{flex-direction:column;gap:2px}
  .hh-clash{min-width:0;overflow-wrap:anywhere;color:var(--ink)}
  .hh-pair{display:flex;gap:var(--p-pill-gap)}
  .hh-pair .p-pill{flex:1}
  .hh-again{margin-top:8px}
  .hh-sheet-say{color:var(--ink-mid);margin:4px 0 16px}

  @media (prefers-reduced-motion:reduce){
    [role=tabpanel],.hh-progress i{animation:none}
  }
</style>
