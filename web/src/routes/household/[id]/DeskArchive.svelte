<script>
  import { plural, sizeLabel } from "$lib/format.js";
  import { createArm } from "$lib/arm.js";
  import { exportFileName, passphraseLength } from "./archive.js";
  import { createArchiveController } from "./archive-controller.svelte.js";

  /*
   * THE ARCHIVE ON THE DESK (#1002). The phone's own build is #1122's
   * PocketArchive.svelte, which this reuses call for call; only the
   * container is the desk's own — a card in the grid, not a sheet on a
   * phone. Owner-only, like Sections and The danger line (household.css's
   * own grammar): a member never sees this card, and +page.svelte gates it
   * the same way it gates those. One card, two tabs as a joined pill pair
   * in the card head (round 7, ratified 2026-09-20 — "Round 7 approved."),
   * spanning both columns between the ordinary cards and the danger line.
   *
   *   take it with you   the manifest, `write an archive →`, the passphrase
   *                      twice, `write the archive` (two-tap, matching the
   *                      phone's ArmButton), a progress line while the
   *                      server writes it, then the download line
   *   bring one in       `bring in an archive →`, a file, its passphrase,
   *                      `look inside`, the preview (what it holds, what
   *                      stays out), `bring in N entries` (two-tap)
   *
   * RECENT AUTHENTICATION (#1132, closed after round 7 was drawn): the
   * export and import routes now ask for proof of a recent sign-in, so the
   * round-7 mockup's up-front "your password again" field is gone — the
   * phone build dropped it for the same reason. When the server answers
   * `recent_authentication_required`, the card holds the act open and shows
   * an inline challenge: the same "type your password, confirm" shape
   * administration.svelte and settings/+page.svelte already use for their
   * own step-up intents, in place of the phone's Sheet (this route has no
   * modal component).
   */

  /** @type {{ householdId: string, householdName: string, entries: number, sections: number, limits?: import("$lib/data/engine-limits.js").EngineLimits | null }} */
  let { householdId, householdName, entries, sections, limits = null } = $props();

  /* The one state machine (archive-controller.svelte.js), shared with the phone's card. */
  const a = createArchiveController({ householdId: () => householdId, limits: () => limits, tabIdPrefix: "arch-tab-" });

  /* ── two-tap (lib/arm.js): an arm, then a fire, 4s to change your mind ── */
  let armed = $state(/** @type {string | boolean} */ (false));
  const arm = createArm({ onchange: (next) => (armed = next) });
  /**
   * @param {string} key
   * @param {() => void} fire
   * @param {HTMLElement | null} button
   */
  function twoTap(key, fire, button) {
    if (arm.tap(key, button)) fire();
  }
</script>

<div class="card c-archive">
  <!-- Nested inside this card (never at the template root): a root-level
       {#snippet} is hoisted above the script by the compiler, and rolldown's
       production build then misparses it against the nearest `@type` cast
       comment above it (#1130, scripts/check-rolldown-jsdoc-trap.mjs). -->
  {#snippet challenge()}
    <div class="challenge">
      <p>The archive carries everything in {householdName}, so Orbit asks you to sign in again first.</p>
      {#if a.hasPassword !== false}
        <form onsubmit={(event) => { event.preventDefault(); a.prove(); }}>
          <div class="field">
            <label for="arch-proof">your password</label>
            <input id="arch-proof" class="pw" type="password" autocomplete="current-password" bind:value={a.currentPassword}>
          </div>
          {#if a.challengeProblem}<p class="refuse">{a.challengeProblem}</p>{/if}
          <div class="act">
            <button class="btn" type="submit" disabled={!a.currentPassword || a.proving}>
              {a.proving ? "confirming…" : "confirm and carry on"}</button>
            <button class="ghost" type="button" onclick={a.cancelChallenge}>cancel</button>
          </div>
        </form>
      {:else}
        {#if a.challengeProblem}<p class="refuse">{a.challengeProblem}</p>{/if}
        <div class="act">
          <button class="btn" onclick={a.toProvider}>confirm with your identity provider →</button>
          <button class="ghost" onclick={a.cancelChallenge}>cancel</button>
        </div>
      {/if}
    </div>
  {/snippet}

  <div class="cardhead">
    <h2 id="arch-h">The archive</h2>
    <div class="tabs" role="tablist" aria-labelledby="arch-h">
      <button role="tab" id="arch-tab-out" aria-selected={a.tab === "out"} aria-controls="arch-panel-out"
              tabindex={a.tab === "out" ? 0 : -1} onclick={() => (a.tab = "out")} onkeydown={a.tabKey}>take it with you</button>
      <button role="tab" id="arch-tab-in" aria-selected={a.tab === "in"} aria-controls="arch-panel-in"
              tabindex={a.tab === "in" ? 0 : -1} onclick={() => (a.tab = "in")} onkeydown={a.tabKey}>bring one in</button>
    </div>
  </div>

  {#if a.stepUpNotice}<p class="note top">{a.stepUpNotice}</p>{/if}

  <div class="arch">
    <div id="arch-panel-out" role="tabpanel" aria-labelledby="arch-tab-out" hidden={a.tab !== "out"}>
      <ul class="man" aria-label="What the file holds">
        <li><b>{entries}</b>{entries === 1 ? "entry" : "entries"}</li>
        <li><b>{sections}</b>{sections === 1 ? "section" : "sections"}</li>
        <li><span class="lab">documents</span><small>travel with it</small></li>
        <li><span class="lab">people</span><small class="zero">never in the file</small></li>
      </ul>

      {#if a.outPhase === "rest"}
        <div class="act"><button class="ghost" onclick={a.startExport}>write an archive →</button></div>
      {:else if a.outPhase === "form"}
        <div class="step open">
          <div class="field">
            <label for="arch-pp-out">a passphrase for the file</label>
            <input id="arch-pp-out" class="pw" type="password" autocomplete="new-password" bind:value={a.passOut}>
          </div>
          <div class="field">
            <label for="arch-pp-out2">the passphrase again</label>
            <input id="arch-pp-out2" class="pw" type="password" autocomplete="new-password" bind:value={a.passAgain}>
          </div>
          <p class="never"><b>Orbit never keeps this passphrase.</b> Lose it and the file can never be opened — not
            by you, not by anyone, and Orbit holds nothing that changes that.</p>
          {#if a.outRefusal && (a.passOut || a.passAgain)}<p class="refuse">{a.outRefusal}</p>{/if}
          <div class="act">
            <button class="ghost" class:armed={armed === "arch-out"} disabled={Boolean(a.outRefusal)}
                    onclick={(event) => twoTap("arch-out", a.writeArchive, event.currentTarget)}>
              {armed === "arch-out" ? "tap again to write the archive" : "write the archive"}</button>
            <button class="ghost" type="button"
                    onclick={a.cancelExport}>cancel</button>
          </div>
        </div>
        {#if a.outProblem}<p class="refuse">{a.outProblem}</p>{/if}
        {#if a.challengeOpen && a.retryIntent === "archive_export"}{@render challenge()}{/if}
      {:else if a.outPhase === "writing"}
        <p class="moment" role="status">
          writing the archive · encrypting {plural(entries, "entry", "entries")} and their documents</p>
        {#if a.challengeOpen}{@render challenge()}{/if}
      {:else if a.written}
        <p class="said show">written · {exportFileName(a.written)} · ready until {a.readyUntil} ·
          {a.written.includesDocuments ? "documents included" : "no documents"}</p>
        <div class="act">
          <!-- The server hands back a one-time storage-scoped address; this only draws it. -->
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
          <a class="btn" href={a.written.downloadUrl}>download the file</a>
        </div>
        <!-- #1792: Orbit keeps a household's last few exports (the export's answer says how many). -->
        {#if a.written.keepPerHousehold === 1}
          <p class="note top">kept here until then · Orbit keeps only your latest; writing another replaces it</p>
        {:else}
          <p class="note top">kept here until then · Orbit keeps your last {a.written.keepPerHousehold ?? 2}; writing more replaces the oldest</p>
        {/if}
      {/if}
    </div>

    <div id="arch-panel-in" role="tabpanel" aria-labelledby="arch-tab-in" hidden={a.tab !== "in"}>
      <input class="sr-only" type="file" accept=".orbit,.json,application/octet-stream,application/json" tabindex="-1" aria-hidden="true"
             bind:this={a.picker} onchange={a.chose}>
      {#if a.inPhase === "done"}
        <p class="said show">brought in {plural(a.brought, "entry", "entries")} from {a.preview?.householdName ?? "the archive"}</p>
        <div class="act"><button class="ghost" onclick={a.startOver}>bring in another</button></div>
      {:else}
        <p>An archive from another Orbit — or an older one of this — merges into <b>{householdName}</b>. Entries
          and their documents come in; people never do, so nothing in a file can give anyone access here.</p>
        {#if a.file}
          <p class="fname"><b>{a.file.name}</b> <small>{sizeLabel(a.file.size)}</small></p>
        {/if}
        {#if a.inPhase === "rest"}
          <div class="act"><button class="ghost" onclick={() => a.picker?.click()}>bring in an archive →</button></div>
          <p class="note top">an Orbit archive{limits ? `, up to ${sizeLabel(limits.archiveFileBytes)}` : ""}</p>
        {:else if a.inPhase === "chosen" || a.inPhase === "looking"}
          <div class="step open">
            <div class="field">
              <label for="arch-pp-in">the file's passphrase</label>
              <input id="arch-pp-in" class="pw" type="password" autocomplete="off" bind:value={a.passIn}
                     onkeydown={(event) => { if (event.key === "Enter") a.lookInside(); }}>
            </div>
            <div class="act">
              <button class="ghost" onclick={a.startOver}>another file</button>
              <button class="ghost" disabled={passphraseLength(a.passIn) < a.passphraseMin || a.inPhase === "looking"} onclick={a.lookInside}>
                {a.inPhase === "looking" ? "looking…" : "look inside"}</button>
            </div>
          </div>
          {#if a.challengeOpen && a.retryIntent === "archive_import"}{@render challenge()}{/if}
        {:else if a.preview && a.inPhase !== "bringing"}
          <div class="inside">
            <ul class="man" aria-label="What the file holds">
              <li class="head"><b>{a.preview.householdName}</b></li>
              <li><b>{a.preview.items}</b>{a.preview.items === 1 ? "entry" : "entries"}</li>
              <li><b>{a.preview.sections}</b>{a.preview.sections === 1 ? "section" : "sections"}</li>
              <li><span class="lab">documents</span>
                <small class:warm={a.preview.documentsExcluded}>{a.preview.documentsExcluded ? `${a.preview.documents} · stay out for now` : a.preview.documents}</small></li>
            </ul>
            {#if a.preview.conflicts.length}
              <ul class="dup" aria-label="Entries already here">
                {#each a.preview.conflicts as clash (clash.id)}
                  <li>{clash.title}<span>already here · stays out</span></li>
                {/each}
              </ul>
            {/if}
            {#if a.bringCount > 0}
              <div class="act">
                <button class="ghost" class:armed={armed === "arch-in"}
                        onclick={(event) => twoTap("arch-in", a.bringIn, event.currentTarget)}>
                  {armed === "arch-in"
                    ? `tap again to bring in ${plural(a.bringCount, "entry", "entries")}`
                    : `bring in ${plural(a.bringCount, "entry", "entries")}`}</button>
              </div>
              <p class="moment warn">this can’t be undone as one act — each entry would have to go separately</p>
            {:else}
              <p class="note top">everything in this archive is already here</p>
            {/if}
            <div class="act"><button class="ghost" onclick={a.startOver}>choose another file</button></div>
          </div>
          {#if a.challengeOpen && a.retryIntent === "archive_import"}{@render challenge()}{/if}
        {:else if a.inPhase === "bringing"}
          <p class="moment" role="status">bringing it in · {plural(a.bringCount, "entry", "entries")}</p>
          {#if a.challengeOpen}{@render challenge()}{/if}
        {/if}
        {#if a.inProblem}<p class="refuse">{a.inProblem}</p>{/if}
      {/if}
    </div>
  </div>
</div>
