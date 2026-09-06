<script>
  import "./relay.css";
  import { onMount } from "svelte";
  import { mountSatellites } from "$lib/backdrops/satellites.js";
  import { rotateRelay } from "$lib/data/workspace.js";
  import { rollSeed, seedFromWorkspace } from "$lib/sky.js";

  /**
   * Your relay — the per-user mail-in address (CON-9: "settings-mail =
   * relay"). Forward a document to your own private address and it lands in
   * your review queue; nothing is created without you seeing it first.
   *
   * The dish is the whole idea: three rings breathing outward on a 3s stagger
   * say "listening" without a word of status copy.
   *
   * Built from design/family/settings-mail.html and owned here from that point
   * on. The four values read through the seam (readRelay in
   * $lib/data/workspace.js) and are live since #432; the gate still renders the
   * mockup's own via the ORBIT_FIXTURES stand-in route. "rotate address" is
   * live since ADR-0017 slice 3 (#744): it asks for a new address, keeping the
   * old one collecting for fourteen days so mail already on its way still
   * arrives. "pause ingest" is still inert — its column exists, its behaviour
   * lands in slice 5 (#746).
   *
   * The living backdrop (#475, §14) is $lib/backdrops/satellites.js, ported
   * from design/v19/relay-satellites.html — this file only mounts it and
   * tears it down. Its one seed follows home's own pattern: pinned to the
   * relay's own address under ORBIT_FIXTURES, so the fidelity gate can
   * compare one deterministic sky against the mockup's; rolled fresh
   * otherwise, because backdrops are alive and never the same twice.
   */
  let { data } = $props();
  /* The rotated relay replaces the loaded one for the rest of this visit: the
     member has to be able to read and save the address they just asked for. */
  let rotated = $state(/** @type {typeof data.relay | null} */ (null));
  let rotating = $state(false);
  const relay = $derived(rotated ?? data.relay);
  const failures = $derived(data.failures ?? []);
  /** @type {(value: string | number | Date) => string} */
  const shortDate = (value) =>
    new Date(value).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
  /* §14 (#471): back to the opener; a deep link with no history goes home. */
  const dismissRelay = () => {
    if (history.length > 1) history.back();
    else location.href = "/home";
  };

  /* Nothing here can name another member: the endpoint takes the session's
     own user and this sends no user, no generation and no address. */
  const rotate = async () => {
    if (rotating) return;
    rotating = true;
    try {
      rotated = await rotateRelay("rotate");
    } finally {
      rotating = false;
    }
  };

  /** @type {?HTMLDivElement} */
  let backdropRoot = null;
  onMount(() => {
    const seed = data.fixtures ? seedFromWorkspace(data.relay.address) : rollSeed();
    return mountSatellites(/** @type {HTMLDivElement} */ (backdropRoot), seed);
  });
</script>

<svelte:head>
  <link rel="stylesheet" href="/screens/family.css" />
  <title>Orbit — your relay</title>
</svelte:head>

<div class="satellites" bind:this={backdropRoot} aria-hidden="true"></div>
<!-- §14 (#471): clicking off the card returns to wherever the reader came
     from — the inbox, settings, or home as the deep-link fallback. -->
<div class="stage" role="main" onclick={(event) => { if (event.target === event.currentTarget) dismissRelay(); }}><div class="glass relay-card">
  <div class="dish" id="relaydish"><span></span><span></span><span></span><i></i></div>
  <h1 style="text-align:center">Your relay</h1>
  <div class="sub" style="text-align:center">forward documents to your private address<br>and they arrive in your review queue</div>
  <div class="alias">{relay.address}</div>
  <div class="kv"><span>status</span><b>{relay.status}</b></div>
  <div class="kv"><span>last received</span><span>{relay.lastReceived}</span></div>
  <div class="kv"><span>ingest</span><b>{relay.ingest}</b></div>
  <div class="btns"><button class="pri" disabled={rotating} onclick={rotate}>rotate address</button><button>pause ingest</button></div>
  {#if failures.length}
    <!-- #434: arrived-but-unreadable mail, in the server's own bounded words. -->
    <div class="failures">
      <h2>arrived, but could not be read</h2>
      {#each failures as failure (failure.id)}
        <div class="kv"><span>{shortDate(failure.receivedAt)}</span><span>{failure.message}</span></div>
      {/each}
    </div>
  {/if}
  <div class="note">every user gets their own relay &middot; nothing is created without your review<br>
  outbound reminder email remains configured by your administrator</div>
</div></div>
<div class="vignette"></div>
