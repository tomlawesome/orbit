<script>
  import {
    CURRENCIES, TIME_ZONES, NAME_LIMIT,
    sectionNote, sectionNoteTitle,
  } from "./stage.js";

  /**
   * THE CREATE FORM (#410, §15; #1263). Three questions and nothing else
   * (§15, "first-run asks three things only"): a name, a time zone, a
   * currency. The four default sections are applied by the server and
   * admitted to in one quiet mono line, the refusal is one warm line under
   * the name, and the act reads `Create` — one word (#862).
   *
   * Since #1263 it stands in the belong card's "name your own system" drawer
   * (Newcomer.svelte), in that card's own type, and no longer in the login
   * ring: the arrival flies once, and the ring-held card and its reclaim are
   * superseded for the arrival (they stand on the door's own cards).
   *
   * This component is the form and only the form: the host owns the answers,
   * the refusal and the submit.
   */
  /**
   * @type {{
   *   name?: string,
   *   timezone?: string,
   *   currency?: string,
   *   rejected?: { name: string, reason: string, householdId?: string | null } | null,
   *   busy?: boolean,
   *   onsubmit?: () => void,
   *   onask?: (rejected: { name: string, reason: string, householdId?: string | null }) => void,
   *   onnaming?: import('svelte/elements').FormEventHandler<HTMLInputElement>,
   * }}
   */
  let {
    /* the three answers, owned by the host so the launch can read them */
    name = $bindable(""),
    timezone = $bindable(TIME_ZONES[0].value),
    currency = $bindable(CURRENCIES[0]),
    /* the name the server (or the list of systems out there) refused, and the
       household it collided with, if that household can be asked to join */
    rejected = null,
    busy = false,
    onsubmit = () => {},
    onask = () => {},
    onnaming = () => {},
  } = $props();

  const trimmed = $derived(name.trim());
</script>

<!-- THIRD PASS: three fields, a button, air. Everything that was prose is
     either gone or moved to a title attribute — the household screen and
     settings say all of it again, later, where it is actually needed. -->
<form class="create" aria-labelledby="createask"
      onsubmit={(event) => { event.preventDefault(); onsubmit(); }}>
    <!-- Read and not seen (#1263: "heading hidden"): the drawer's handle
         already says it. -->
    <h2 class="asklabel" id="createask">Name your own system</h2>
    <div class="field">
      <label for="hhname">name</label>
      <input id="hhname" placeholder="Your world" maxlength={NAME_LIMIT} autocomplete="off"
             aria-label="System name" bind:value={name} oninput={onnaming}
             title="A house, a flat, a boat, a parent’s place — whatever you keep in orbit. It is the name everyone in it sees." />
      <!-- the refusal, in one line, in the warm tone. The only word the
           browser supplies is the name the reader typed: "nothing was created"
           and "your answers are still here" are not said, because the answers,
           still sitting in the fields, say it. -->
      {#if rejected}
        <p class="err" role="alert"><b>{`“${rejected.name}”`}</b> {rejected.reason}{#if rejected.householdId}
          — <a href="#ask" onclick={(event) => { event.preventDefault(); onask(rejected); }}>ask to join it →</a>{/if}</p>
      {/if}
    </div>

    <div class="pair">
      <div class="row2">
        <div class="field selwrap">
          <label for="tz">time zone</label>
          <select id="tz" aria-label="Time zone" bind:value={timezone}
                  title="Read off your browser. It moves to settings afterwards, and dates read by it.">
            {#each TIME_ZONES as zone (zone.value)}<option value={zone.value}>{zone.label}</option>{/each}
          </select>
        </div>
        <div class="field selwrap">
          <label for="cur">currency</label>
          <select id="cur" aria-label="Currency" bind:value={currency}
                  title="Read off your browser. It moves to settings afterwards, and costs read by it.">
            {#each CURRENCIES as code (code)}<option value={code}>{code}</option>{/each}
          </select>
        </div>
      </div>
    </div>

    <!-- the ONE line that survives the strip: it admits to the four sections
         that were made without being asked for, and says nothing else. The
         count is the real default set's, never a typed number. -->
    <p class="note" title={sectionNoteTitle()}>{sectionNote()}</p>

    <!-- THE ACT (#862): the ratified gate rule verbatim, at its own size,
         reading `Create` — one word. It no longer grows with the typed name
         (§15 already requires the two surfaces to carry the identical
         control; the owner's round-3 word closes the last difference). No
         whitespace inside the button: the label is centred, and a collapsed
         newline either side of it moves the word off the mockup's own pixels. -->
    <button class="btn act" id="gobtn" type="submit" disabled={!trimmed || busy}>Create</button>
</form>
