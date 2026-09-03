<script>
  import {
    CURRENCIES, TIME_ZONES, NAME_LIMIT,
    createButtonLabel, sectionNote, sectionNoteTitle,
  } from "./stage.js";

  /**
   * THE CREATE-SYSTEM CARD (#410, §15 — design/v19/first-run.html, block 2).
   *
   * Three fields, a button and air, standing alone on the dawn with the login
   * screen taken off it entirely (§15, fourth pass). No wordmark, no glyph, no
   * identity-provider button, no footer and no mark on the card — the login's
   * own 420px hero ring is behind it the whole time, which is what the flight
   * lifts off when the card dissolves.
   *
   * The card asks three things and nothing else (§15, "first-run asks three
   * things only"): a name, a time zone, a currency. The four default sections
   * are applied by the server and admitted to in one quiet mono line. The
   * refusal is one warm line under the field it is about.
   *
   * This component is the form and only the form: the host owns the stage, the
   * submit, the reclaim and the launch.
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

<div id="formlayer">
  <!-- THIRD PASS: three fields, a button, air. Everything that was prose is
       either gone or moved to a title attribute — the household screen and
       settings say all of it again, later, where it is actually needed. -->
  <form class="card" aria-label="Name your first system"
        onsubmit={(event) => { event.preventDefault(); onsubmit(); }}>
    <div class="field">
      <label for="hhname">what is it</label>
      <input id="hhname" placeholder="Lawson Home" maxlength={NAME_LIMIT} autocomplete="off"
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

    <!-- No whitespace inside the button: the label is centred, and a collapsed
         newline either side of it moves the words off the mockup's own pixels. -->
    <button class="btn" id="gobtn" type="submit" disabled={!trimmed || busy}>{createButtonLabel(name)}</button>
  </form>
</div>
