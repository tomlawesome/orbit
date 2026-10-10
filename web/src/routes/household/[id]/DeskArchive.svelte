<script>
  import { onMount } from "svelte";
  import { createArm } from "$lib/arm.js";
  import {
    importPortableArchive,
    previewPortableArchive,
    readSignInMethods,
    startStepUp,
    writePortableArchive,
  } from "$lib/data/workspace.js";
  import { archiveFileProblem, passphraseFloor, passphraseLength, passphraseProblem, sizeLabel } from "./archive.js";

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

  /* #1151 W2-R1: set just before the step-up redirect, cleared on the way
     back in. sessionStorage, not a query param — the identity provider owns
     `returnTo` and this reader's own tab is the only place this needs to be
     read. */
  const STEPUP_RETURN_FLAG = "orbit-archive-stepup-return";

  /** @type {{ householdId: string, householdName: string, entries: number, sections: number, limits?: import("$lib/data/engine-limits.js").EngineLimits | null }} */
  let { householdId, householdName, entries, sections, limits = null } = $props();

  /* The engine's numbers (#1336): the passphrase floor the buttons wait for. */
  const passphraseMin = $derived(passphraseFloor(limits));

  let tab = $state(/** @type {"out" | "in"} */ ("out"));

  /* ── take it with you ─────────────────────────────────────────────────── */
  let outPhase = $state(/** @type {"rest" | "form" | "writing" | "written"} */ ("rest"));
  let passOut = $state("");
  let passAgain = $state("");
  let written = $state(/** @type {import('$lib/data/workspace.js').WrittenArchive | null} */ (null));
  /** @type {string | null} */
  let outProblem = $state(null);
  const outRefusal = $derived(passphraseProblem(passOut, passAgain, limits));

  /* ── bring one in ─────────────────────────────────────────────────────── */
  let inPhase = $state(/** @type {"rest" | "chosen" | "looking" | "preview" | "bringing" | "done"} */ ("rest"));
  /** @type {File | null} */
  let file = $state(null);
  /** @type {unknown} */
  let archive = null;
  let passIn = $state("");
  let preview = $state(/** @type {import('$lib/data/workspace.js').ArchivePreview | null} */ (null));
  let brought = $state(0);
  /** @type {string | null} */
  let inProblem = $state(null);
  /** @type {HTMLInputElement | undefined} */
  let picker = $state();

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

  /* ── the recent-authentication challenge (#1132) ──────────────────────── */
  let challengeOpen = $state(false);
  /** @type {boolean | null} */
  let hasPassword = $state(null);
  let currentPassword = $state("");
  let proving = $state(false);
  /** @type {string | null} */
  let challengeProblem = $state(null);
  /** @type {((proof: string) => Promise<void>) | null} */
  let retry = null;
  /** The step-up intent the held act needs: one each way, so a proof for one cannot pay for the other.
      Reactive (unlike the phone's Sheet-based copy of this field): the panels below branch on it to
      show the challenge under whichever act is actually holding it. */
  let retryIntent = $state(/** @type {"archive_export" | "archive_import"} */ ("archive_export"));

  /** @param {unknown} error */
  const wordsOf = (error) => /** @type {{ message?: string }} */ (error)?.message ?? String(error);
  /** @param {unknown} error */
  const needsProof = (error) => /** @type {{ code?: string }} */ (error)?.code === "recent_authentication_required";

  /**
   * Runs an archive act; if the server wants proof first, holds the act and
   * opens the challenge, which runs it again carrying the proof.
   * @param {(proof: string) => Promise<void>} act
   * @param {(words: string) => void} fail
   * @param {"archive_export" | "archive_import"} intent
   */
  async function guarded(act, fail, intent) {
    try {
      await act("");
    } catch (error) {
      if (!needsProof(error)) { fail(wordsOf(error)); return; }
      retry = act;
      retryIntent = intent;
      currentPassword = "";
      challengeProblem = null;
      challengeOpen = true;
      if (hasPassword === null) {
        hasPassword = await readSignInMethods().then((methods) => methods.local.set, () => true);
      }
    }
  }

  function cancelChallenge() {
    challengeOpen = false;
    retry = null;
    currentPassword = "";
    challengeProblem = null;
  }

  async function prove() {
    if (!retry || proving) return;
    proving = true;
    challengeProblem = null;
    try {
      await retry(currentPassword);
      challengeOpen = false;
      retry = null;
    } catch (error) {
      challengeProblem = needsProof(error) ? "that password did not match · try again" : wordsOf(error);
    } finally {
      proving = false;
    }
  }

  async function toProvider() {
    challengeProblem = null;
    try {
      /* The redirect below leaves this page entirely — the chosen file, its
         passphrase and the preview cannot survive that, browser-held state
         has nowhere to live across it. A flag saying only "an archive act
         sent this reader to the provider" can, and sessionStorage is the
         right shelf for it: gone the moment the tab closes, never the
         passphrase itself. */
      try { sessionStorage.setItem(STEPUP_RETURN_FLAG, "1"); } catch { /* storage refused: the redirect still happens, just without the notice on return */ }
      await startStepUp({ intent: retryIntent, returnTo: location.pathname });
    } catch (error) {
      try { sessionStorage.removeItem(STEPUP_RETURN_FLAG); } catch { /* nothing to clear */ }
      challengeProblem = wordsOf(error);
    }
  }

  /** @type {string | null} */
  let stepUpNotice = $state(null);

  onMount(() => {
    let returning = null;
    try { returning = sessionStorage.getItem(STEPUP_RETURN_FLAG); } catch { /* unreadable: treat as not returning */ }
    if (!returning) return;
    try { sessionStorage.removeItem(STEPUP_RETURN_FLAG); } catch { /* already gone, or unreadable */ }
    stepUpNotice = "back from signing in again · choose the file once more to carry on";
  });

  /* ── acts ─────────────────────────────────────────────────────────────── */
  function writeArchiveNow() {
    if (outRefusal) return;
    outProblem = null;
    outPhase = "writing";
    guarded(async (proof) => {
      written = await writePortableArchive(householdId, { passphrase: passOut, currentPassword: proof || undefined });
      passOut = "";
      passAgain = "";
      outPhase = "written";
    }, (words) => {
      outProblem = `not written — ${words}`;
      outPhase = "form";
    }, "archive_export").then(() => { if (outPhase === "writing" && challengeOpen) outPhase = "form"; });
  }

  /** @param {Event} event */
  async function chose(event) {
    const input = /** @type {HTMLInputElement} */ (event.currentTarget);
    const next = input.files?.[0] ?? null;
    input.value = "";
    if (!next) return;
    inProblem = archiveFileProblem(next, limits);
    preview = null;
    archive = null;
    file = next;
    inPhase = inProblem ? "rest" : "chosen";
  }

  async function lookInside() {
    if (!file || passphraseLength(passIn) < passphraseMin) return;
    inProblem = null;
    inPhase = "looking";
    try {
      archive = JSON.parse(await file.text());
    } catch {
      inProblem = "this file is not an Orbit archive";
      inPhase = "chosen";
      return;
    }
    await guarded(async (proof) => {
      preview = await previewPortableArchive(householdId, { archive, passphrase: passIn, currentPassword: proof || undefined });
      inPhase = "preview";
    }, (words) => {
      inProblem = words;
      inPhase = "chosen";
    }, "archive_import");
    if (inPhase === "looking") inPhase = "chosen";
  }

  const bringCount = $derived(preview ? preview.items - preview.conflicts.length : 0);

  function bringInNow() {
    if (!preview) return;
    const skip = preview.conflicts.map((one) => one.id);
    inProblem = null;
    inPhase = "bringing";
    guarded(async (proof) => {
      const result = await importPortableArchive(householdId, { archive, passphrase: passIn, skip, currentPassword: proof || undefined });
      brought = result.importedItems;
      inPhase = "done";
      passIn = "";
    }, (words) => {
      inProblem = `not brought in — ${words}`;
      inPhase = "preview";
    }, "archive_import").then(() => { if (inPhase === "bringing") inPhase = "preview"; });
  }

  function startOver() {
    file = null;
    archive = null;
    preview = null;
    passIn = "";
    inProblem = null;
    inPhase = "rest";
  }

  /* §22's keyboard: one tab in the Tab order, ← → between them. */
  /** @param {KeyboardEvent} event */
  function tabKey(event) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    tab = tab === "out" ? "in" : "out";
    queueMicrotask(() => document.getElementById(`arch-tab-${tab}`)?.focus());
  }

  const readyUntil = $derived(written
    ? new Date(written.expiresAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : "");
</script>

<div class="card c-archive">
  <!-- Nested inside this card (never at the template root): a root-level
       {#snippet} is hoisted above the script by the compiler, and rolldown's
       production build then misparses it against the nearest `@type` cast
       comment above it (#1130, scripts/check-rolldown-jsdoc-trap.mjs). -->
  {#snippet challenge()}
    <div class="challenge">
      <p>The archive carries everything in {householdName}, so Orbit asks you to sign in again first.</p>
      {#if hasPassword !== false}
        <form onsubmit={(event) => { event.preventDefault(); prove(); }}>
          <div class="field">
            <label for="arch-proof">your password</label>
            <input id="arch-proof" class="pw" type="password" autocomplete="current-password" bind:value={currentPassword}>
          </div>
          {#if challengeProblem}<p class="refuse">{challengeProblem}</p>{/if}
          <div class="act">
            <button class="btn" type="submit" disabled={!currentPassword || proving}>
              {proving ? "confirming…" : "confirm and carry on"}</button>
            <button class="ghost" type="button" onclick={cancelChallenge}>cancel</button>
          </div>
        </form>
      {:else}
        {#if challengeProblem}<p class="refuse">{challengeProblem}</p>{/if}
        <div class="act">
          <button class="btn" onclick={toProvider}>confirm with your identity provider →</button>
          <button class="ghost" onclick={cancelChallenge}>cancel</button>
        </div>
      {/if}
    </div>
  {/snippet}

  <div class="cardhead">
    <h2 id="arch-h">The archive</h2>
    <div class="tabs" role="tablist" aria-labelledby="arch-h">
      <button role="tab" id="arch-tab-out" aria-selected={tab === "out"} aria-controls="arch-panel-out"
              tabindex={tab === "out" ? 0 : -1} onclick={() => (tab = "out")} onkeydown={tabKey}>take it with you</button>
      <button role="tab" id="arch-tab-in" aria-selected={tab === "in"} aria-controls="arch-panel-in"
              tabindex={tab === "in" ? 0 : -1} onclick={() => (tab = "in")} onkeydown={tabKey}>bring one in</button>
    </div>
  </div>

  {#if stepUpNotice}<p class="note top">{stepUpNotice}</p>{/if}

  <div class="arch">
    <div id="arch-panel-out" role="tabpanel" aria-labelledby="arch-tab-out" hidden={tab !== "out"}>
      <ul class="man" aria-label="What the file holds">
        <li><b>{entries}</b>{entries === 1 ? "entry" : "entries"}</li>
        <li><b>{sections}</b>{sections === 1 ? "section" : "sections"}</li>
        <li><span class="lab">documents</span><small>travel with it</small></li>
        <li><span class="lab">people</span><small class="zero">never in the file</small></li>
      </ul>

      {#if outPhase === "rest"}
        <div class="act"><button class="ghost" onclick={() => (outPhase = "form")}>write an archive →</button></div>
      {:else if outPhase === "form"}
        <div class="step open">
          <div class="field">
            <label for="arch-pp-out">a passphrase for the file</label>
            <input id="arch-pp-out" class="pw" type="password" autocomplete="new-password" bind:value={passOut}>
          </div>
          <div class="field">
            <label for="arch-pp-out2">the passphrase again</label>
            <input id="arch-pp-out2" class="pw" type="password" autocomplete="new-password" bind:value={passAgain}>
          </div>
          <p class="never"><b>Orbit never keeps this passphrase.</b> Lose it and the file can never be opened — not
            by you, not by anyone, and Orbit holds nothing that changes that.</p>
          {#if outRefusal && (passOut || passAgain)}<p class="refuse">{outRefusal}</p>{/if}
          <div class="act">
            <button class="ghost" class:armed={armed === "arch-out"} disabled={Boolean(outRefusal)}
                    onclick={(event) => twoTap("arch-out", writeArchiveNow, event.currentTarget)}>
              {armed === "arch-out" ? "tap again to write the archive" : "write the archive"}</button>
            <button class="ghost" type="button"
                    onclick={() => { outPhase = "rest"; passOut = ""; passAgain = ""; outProblem = null; }}>cancel</button>
          </div>
        </div>
        {#if outProblem}<p class="refuse">{outProblem}</p>{/if}
        {#if challengeOpen && retryIntent === "archive_export"}{@render challenge()}{/if}
      {:else if outPhase === "writing"}
        <p class="moment" role="status">
          writing the archive · encrypting {entries} {entries === 1 ? "entry" : "entries"} and their documents</p>
        {#if challengeOpen}{@render challenge()}{/if}
      {:else if written}
        <p class="said show">written · orbit-archive.json · ready until {readyUntil} ·
          {written.includesDocuments ? "documents included" : "no documents"}</p>
        <div class="act">
          <!-- The server hands back a one-time storage-scoped address; this only draws it. -->
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
          <a class="btn" href={written.downloadUrl}>download the file</a>
        </div>
        <p class="note top">kept here for a day, then gone · write another whenever you like</p>
      {/if}
    </div>

    <div id="arch-panel-in" role="tabpanel" aria-labelledby="arch-tab-in" hidden={tab !== "in"}>
      <input class="sr-only" type="file" accept=".json,application/json" tabindex="-1" aria-hidden="true"
             bind:this={picker} onchange={chose}>
      {#if inPhase === "done"}
        <p class="said show">brought in {brought} {brought === 1 ? "entry" : "entries"} from {preview?.householdName ?? "the archive"}</p>
        <div class="act"><button class="ghost" onclick={startOver}>bring in another</button></div>
      {:else}
        <p>An archive from another Orbit — or an older one of this — merges into <b>{householdName}</b>. Entries
          and their documents come in; people never do, so nothing in a file can give anyone access here.</p>
        {#if file}
          <p class="fname"><b>{file.name}</b> <small>{sizeLabel(file.size)}</small></p>
        {/if}
        {#if inPhase === "rest"}
          <div class="act"><button class="ghost" onclick={() => picker?.click()}>bring in an archive →</button></div>
          <p class="note top">an Orbit archive{limits ? `, up to ${sizeLabel(limits.archiveFileBytes)}` : ""}</p>
        {:else if inPhase === "chosen" || inPhase === "looking"}
          <div class="step open">
            <div class="field">
              <label for="arch-pp-in">the file's passphrase</label>
              <input id="arch-pp-in" class="pw" type="password" autocomplete="off" bind:value={passIn}
                     onkeydown={(event) => { if (event.key === "Enter") lookInside(); }}>
            </div>
            <div class="act">
              <button class="ghost" onclick={startOver}>another file</button>
              <button class="ghost" disabled={passphraseLength(passIn) < passphraseMin || inPhase === "looking"} onclick={lookInside}>
                {inPhase === "looking" ? "looking…" : "look inside"}</button>
            </div>
          </div>
          {#if challengeOpen && retryIntent === "archive_import"}{@render challenge()}{/if}
        {:else if preview}
          <div class="inside">
            <ul class="man" aria-label="What the file holds">
              <li class="head"><b>{preview.householdName}</b></li>
              <li><b>{preview.items}</b>{preview.items === 1 ? "entry" : "entries"}</li>
              <li><b>{preview.sections}</b>{preview.sections === 1 ? "section" : "sections"}</li>
              <li><span class="lab">documents</span>
                <small class:warm={preview.documentsExcluded}>{preview.documentsExcluded ? `${preview.documents} · stay out for now` : preview.documents}</small></li>
            </ul>
            {#if preview.conflicts.length}
              <ul class="dup" aria-label="Entries already here">
                {#each preview.conflicts as clash (clash.id)}
                  <li>{clash.title}<span>already here · stays out</span></li>
                {/each}
              </ul>
            {/if}
            {#if bringCount > 0}
              <div class="act">
                <button class="ghost" class:armed={armed === "arch-in"}
                        onclick={(event) => twoTap("arch-in", bringInNow, event.currentTarget)}>
                  {armed === "arch-in"
                    ? `tap again to bring in ${bringCount} ${bringCount === 1 ? "entry" : "entries"}`
                    : `bring in ${bringCount} ${bringCount === 1 ? "entry" : "entries"}`}</button>
              </div>
              <p class="moment warn">this can’t be undone as one act — each entry would have to go separately</p>
            {:else}
              <p class="note top">everything in this archive is already here</p>
            {/if}
            <div class="act"><button class="ghost" onclick={startOver}>choose another file</button></div>
          </div>
          {#if challengeOpen && retryIntent === "archive_import"}{@render challenge()}{/if}
        {:else if inPhase === "bringing"}
          <p class="moment" role="status">bringing it in · {bringCount} {bringCount === 1 ? "entry" : "entries"}</p>
          {#if challengeOpen}{@render challenge()}{/if}
        {/if}
        {#if inProblem}<p class="refuse">{inProblem}</p>{/if}
      {/if}
    </div>
  </div>
</div>
