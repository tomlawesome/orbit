<script>
  import ArmButton from "$lib/pocket/ArmButton.svelte";
  import Row from "$lib/pocket/Row.svelte";
  import Sheet from "$lib/pocket/Sheet.svelte";
  import { wake } from "$lib/pocket/wake.js";
  import {
    importPortableArchive,
    previewPortableArchive,
    readSignInMethods,
    startStepUp,
    writePortableArchive,
  } from "$lib/data/workspace.js";
  import { ARCHIVE_MAX_BYTES, archiveFileProblem, PASSPHRASE_MIN, passphraseProblem, sizeLabel } from "./archive.js";

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

  /** @type {{ householdId: string, householdName: string, entries: number, sections: number }} */
  let { householdId, householdName, entries, sections } = $props();

  let tab = $state(/** @type {"out" | "in"} */ ("out"));

  /* ── take it with you ─────────────────────────────────────────────────── */
  let outPhase = $state(/** @type {"rest" | "form" | "writing" | "written"} */ ("rest"));
  let passOut = $state("");
  let passAgain = $state("");
  let written = $state(/** @type {import('$lib/data/workspace.js').WrittenArchive | null} */ (null));
  /** @type {string | null} */
  let outProblem = $state(null);
  const outRefusal = $derived(passphraseProblem(passOut, passAgain));

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

  /* ── the recent-authentication callout (§17) ──────────────────────────── */
  let challengeOpen = $state(false);
  /** @type {boolean | null} */
  let hasPassword = $state(null);
  let currentPassword = $state("");
  let proving = $state(false);
  /** @type {string | null} */
  let challengeProblem = $state(null);
  /** @type {((proof: string) => Promise<void>) | null} */
  let retry = null;
  /** The step-up intent the held act needs (#1132): one each way, so a proof for one cannot pay for the other. */
  let retryIntent = "archive_export";

  /** @param {unknown} error */
  const wordsOf = (error) => /** @type {{ message?: string }} */ (error)?.message ?? String(error);
  /** @param {unknown} error */
  const needsProof = (error) => /** @type {{ code?: string }} */ (error)?.code === "recent_authentication_required";

  /**
   * Run an archive act; if the server wants proof first, hold the act and
   * raise the callout, which runs it again with the proof.
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
      await startStepUp({ intent: retryIntent, returnTo: location.pathname });
    } catch (error) {
      challengeProblem = wordsOf(error);
    }
  }

  /* ── acts ─────────────────────────────────────────────────────────────── */
  function writeArchive() {
    if (outRefusal) return;
    outProblem = null;
    outPhase = "writing";
    guarded(async (proof) => {
      written = await writePortableArchive(householdId, { passphrase: passOut, currentPassword: proof || undefined });
      passOut = "";
      passAgain = "";
      outPhase = "written";
      wake("the archive is written · download it within a day");
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
    inProblem = archiveFileProblem(next);
    preview = null;
    archive = null;
    file = next;
    inPhase = inProblem ? "rest" : "chosen";
  }

  async function lookInside() {
    if (!file || passIn.length < PASSPHRASE_MIN) return;
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

  function bringIn() {
    if (!preview) return;
    const skip = preview.conflicts.map((one) => one.id);
    inProblem = null;
    inPhase = "bringing";
    guarded(async (proof) => {
      const result = await importPortableArchive(householdId, { archive, passphrase: passIn, skip, currentPassword: proof || undefined });
      brought = result.importedItems;
      inPhase = "done";
      passIn = "";
      wake(`brought in ${brought} ${brought === 1 ? "entry" : "entries"}`);
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
    queueMicrotask(() => document.getElementById(`hh-tab-${tab}`)?.focus());
  }

  const readyUntil = $derived(written
    ? new Date(written.expiresAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : "");
</script>

<section class="p-card hh-archive" aria-labelledby="hh-archive-title" data-hh="archive">
  <div class="hh-archive-head">
    <h2 class="p-caps" id="hh-archive-title">The archive</h2>
    <div class="hh-tabs" role="tablist" aria-labelledby="hh-archive-title">
      <button role="tab" id="hh-tab-out" aria-selected={tab === "out"} aria-controls="hh-panel-out"
              tabindex={tab === "out" ? 0 : -1} onclick={() => (tab = "out")} onkeydown={tabKey}>take it with you</button>
      <button role="tab" id="hh-tab-in" aria-selected={tab === "in"} aria-controls="hh-panel-in"
              tabindex={tab === "in" ? 0 : -1} onclick={() => (tab = "in")} onkeydown={tabKey}>bring one in</button>
    </div>
  </div>

  <div role="tabpanel" id="hh-panel-out" aria-labelledby="hh-tab-out" hidden={tab !== "out"}>
    <div class="hh-manifest">
      <div class="p-kv"><span>entries</span><b>{entries}</b></div>
      <div class="p-kv"><span>sections</span><b>{sections}</b></div>
      <div class="p-kv"><span>documents</span><b>travel with it</b></div>
      <div class="p-kv"><span>people</span><b class="ended">never in the file</b></div>
    </div>

    {#if outPhase === "rest"}
      <button class="p-pill act-accent wide" onclick={() => (outPhase = "form")}>export this system</button>
    {:else if outPhase === "form"}
      <div class="hh-fields">
        <label class="hh-label" for="hh-pass-out">a passphrase for the file</label>
        <input id="hh-pass-out" class="hh-input" type="password" autocomplete="new-password" enterkeyhint="next"
               bind:value={passOut}>
        <label class="hh-label" for="hh-pass-again">the passphrase again</label>
        <input id="hh-pass-again" class="hh-input" type="password" autocomplete="new-password" enterkeyhint="done"
               bind:value={passAgain}>
        <p class="hh-note warm">Orbit never keeps this passphrase · without it the file cannot be opened</p>
        {#if outRefusal && (passOut || passAgain)}<p class="hh-note">{outRefusal}</p>{/if}
      </div>
      {#if outRefusal}
        <button class="p-pill act-accent wide" disabled>write the archive</button>
      {:else}
        <ArmButton label="write the archive" danger={false} wide class="act-accent" onfire={writeArchive} />
      {/if}
      {#if outProblem}<p class="p-error" role="alert">{outProblem}</p>{/if}
    {:else if outPhase === "writing"}
      <div class="hh-progress" role="status">
        <span class="p-body accent breathing" aria-hidden="true"></span>
        <span><b>writing the archive</b><small>encrypting {entries} {entries === 1 ? "entry" : "entries"} and their documents</small></span>
        <i aria-hidden="true"></i>
      </div>
    {:else if written}
      <div class="hh-written">
        <Row title="orbit-archive.json" meta="ready until {readyUntil} · {written.includesDocuments ? 'documents in' : 'no documents'}"
             href={written.downloadUrl} trail="download">
          {#snippet mark()}<span class="p-paper">◆</span>{/snippet}
        </Row>
      </div>
      <p class="hh-note">kept here for a day, then gone · write another whenever you like</p>
    {/if}
  </div>

  <div role="tabpanel" id="hh-panel-in" aria-labelledby="hh-tab-in" hidden={tab !== "in"}>
    <input class="sr-only" type="file" accept=".json,application/json" tabindex="-1" aria-hidden="true"
           bind:this={picker} onchange={chose}>
    {#if inPhase === "done"}
      <p class="hh-done"><span class="p-body ok" aria-hidden="true"></span>brought in {brought} {brought === 1 ? "entry" : "entries"} from {preview?.householdName ?? "the archive"}</p>
      <button class="p-pill wide" onclick={startOver}>bring in another</button>
    {:else}
      {#if file}
        <div class="hh-written">
          <Row title={file.name} meta={sizeLabel(file.size)}>
            {#snippet mark()}<span class="p-paper">◆</span>{/snippet}
          </Row>
        </div>
      {/if}
      {#if inPhase === "rest"}
        <button class="p-pill act-accent wide" onclick={() => picker?.click()}>choose a file</button>
        <p class="hh-note">an Orbit archive, up to {sizeLabel(ARCHIVE_MAX_BYTES)}</p>
      {:else if inPhase === "chosen" || inPhase === "looking"}
        <div class="hh-fields">
          <label class="hh-label" for="hh-pass-in">the file's passphrase</label>
          <input id="hh-pass-in" class="hh-input" type="password" autocomplete="off" enterkeyhint="go"
                 bind:value={passIn} onkeydown={(event) => { if (event.key === "Enter") lookInside(); }}>
        </div>
        <div class="hh-pair">
          <button class="p-pill" onclick={startOver}>another file</button>
          <button class="p-pill filled" disabled={passIn.length < PASSPHRASE_MIN || inPhase === "looking"} onclick={lookInside}>
            {inPhase === "looking" ? "looking…" : "look inside"}</button>
        </div>
      {:else if preview}
        <div class="p-card proposed hh-preview">
          <p class="p-caps">inside · {preview.householdName}</p>
          <div class="p-kv"><span>entries</span><b>{preview.items}</b></div>
          <div class="p-kv"><span>sections</span><b>{preview.sections}</b></div>
          <div class="p-kv"><span>documents</span><b class:ended={preview.documentsExcluded}>{preview.documentsExcluded ? `${preview.documents} · stay out for now` : preview.documents}</b></div>
          {#each preview.conflicts as clash (clash.id)}
            <div class="p-kv hh-clashrow"><span class="hh-clash">{clash.title}</span><b class="soon">already here · stays out</b></div>
          {/each}
        </div>
        {#if bringCount > 0}
          <ArmButton label="bring in {bringCount} {bringCount === 1 ? 'entry' : 'entries'}" wide danger={false}
                     class="act-accent" armedLabel="tap again · it can't be undone as one act" onfire={bringIn} />
        {:else}
          <p class="hh-note">everything in this archive is already here</p>
        {/if}
        <button class="p-pill wide hh-again" onclick={startOver}>choose another file</button>
      {:else if inPhase === "bringing"}
        <div class="hh-progress" role="status">
          <span class="p-body accent breathing" aria-hidden="true"></span>
          <span><b>bringing it in</b><small>{bringCount} {bringCount === 1 ? "entry" : "entries"}</small></span>
          <i aria-hidden="true"></i>
        </div>
      {/if}
      {#if inProblem}<p class="p-error" role="alert">{inProblem}</p>{/if}
    {/if}
  </div>
</section>

<Sheet bind:open={challengeOpen} size="callout" title="Confirm it’s you" onclose={() => { retry = null; }}>
  <p class="p-prose hh-sheet-say">The archive carries everything in {householdName}, so Orbit asks you to sign in again first.</p>
  {#if hasPassword !== false}
    <form id="hh-challenge-form" onsubmit={(event) => { event.preventDefault(); prove(); }}>
      <label class="hh-label" for="hh-proof">your password</label>
      <input id="hh-proof" class="hh-input" type="password" autocomplete="current-password" enterkeyhint="done"
             bind:value={currentPassword}>
    </form>
  {/if}
  {#if challengeProblem}<p class="p-error" role="alert">{challengeProblem}</p>{/if}
  {#snippet foot()}
    {#if hasPassword === false}
      <button class="p-pill filled" onclick={toProvider}>confirm with your identity provider →</button>
    {:else}
      <button class="p-pill filled" type="submit" form="hh-challenge-form" disabled={!currentPassword || proving}>
        {proving ? "confirming…" : "confirm and carry on"}</button>
    {/if}
  {/snippet}
</Sheet>

<style>
  /* §22 under 560px: the pill pair follows the heading, wrapping under it. */
  .hh-archive-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px;margin:0 0 12px}
  .hh-archive-head .p-caps{margin:0}
  .hh-tabs{display:flex;border:1px solid var(--line);border-radius:calc(var(--p-hit) / 2);overflow:hidden;flex:1 1 100%}
  .hh-tabs button{appearance:none;flex:1;min-height:var(--p-hit);padding:0 6px;white-space:nowrap;border:0;background:none;
    font:var(--p-type-meta)/1.2 var(--mono);color:var(--ink-mid);cursor:pointer;
    transition:background-color var(--p-arm),color var(--p-arm)}
  .hh-tabs button + button{border-left:1px solid var(--line)}
  .hh-tabs button[aria-selected=true]{background:var(--accent);color:var(--bg);font-weight:600}
  :global(:is([data-theme=dawn],[data-theme=clouds])) .hh-tabs button[aria-selected=true]{color:#fff}
  :global([data-theme=retrograde]) .hh-tabs button[aria-selected=true]{box-shadow:0 0 12px -2px var(--bloom)}
  .hh-tabs button:focus-visible{outline:2px solid var(--accent);outline-offset:-4px}
  [role=tabpanel]{animation:hh-panel 240ms var(--p-ease) both}
  @keyframes hh-panel{from{opacity:0;transform:translateY(4px)}}

  .hh-manifest{margin:0 0 16px}
  .hh-manifest .p-kv:last-child{border-bottom:0}
  .p-kv .ended{color:var(--ink-quiet)}

  .hh-fields{display:flex;flex-direction:column;margin:0 0 12px}
  .hh-label{font:var(--p-type-caps)/1.4 var(--mono);letter-spacing:var(--p-type-caps-track);text-transform:uppercase;
    color:var(--ink-quiet);margin:12px 0 6px}
  .hh-label:first-child{margin-top:0}
  .hh-input{box-sizing:border-box;width:100%;min-height:48px;padding:0 14px;border-radius:12px;
    border:1px solid var(--line);background:color-mix(in srgb, var(--bg) 55%, transparent);color:var(--ink);
    font:var(--p-type-body)/1.2 var(--ui)}
  .hh-input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
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
