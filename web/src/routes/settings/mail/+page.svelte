<script>
  import "./relay.css";
  import { onMount } from "svelte";
  import { mountSatellites } from "$lib/backdrops/satellites.js";
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
   * mockup's own via the ORBIT_FIXTURES stand-in route. "rotate address" and
   * "pause ingest" are still inert — the machinery exists, the user-facing
   * commands do not, and #432 put both out of scope.
   *
   * The living backdrop (#475, §14) is $lib/backdrops/satellites.js, ported
   * from design/v19/relay-satellites.html — this file only mounts it and
   * tears it down. Its one seed follows home's own pattern: pinned to the
   * relay's own address under ORBIT_FIXTURES, so the fidelity gate can
   * compare one deterministic sky against the mockup's; rolled fresh
   * otherwise, because backdrops are alive and never the same twice.
   */
  let { data } = $props();
  const relay = $derived(data.relay);
  const failures = $derived(data.failures ?? []);
  /** @type {(value: string | number | Date) => string} */
  const shortDate = (value) =>
    new Date(value).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
  /* §14 (#471): back to the opener; a deep link with no history goes home. */
  const dismissRelay = () => {
    if (history.length > 1) history.back();
    else location.href = "/home";
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
<div class="stage" onclick={(event) => { if (event.target === event.currentTarget) dismissRelay(); }}><div class="glass relay-card">
  <div class="dish" id="relaydish"><span></span><span></span><span></span><i></i></div>
  <h2 style="text-align:center">Your relay</h2>
  <div class="sub" style="text-align:center">forward documents to your private address<br>and they arrive in your review queue</div>
  <div class="alias">{relay.address}</div>
  <div class="kv"><span>status</span><b>{relay.status}</b></div>
  <div class="kv"><span>last received</span><span>{relay.lastReceived}</span></div>
  <div class="kv"><span>ingest</span><b>{relay.ingest}</b></div>
  <div class="btns"><button class="pri">rotate address</button><button>pause ingest</button></div>
  {#if failures.length}
    <!-- #434: arrived-but-unreadable mail, in the server's own bounded words. -->
    <div class="failures">
      <h4>arrived, but could not be read</h4>
      {#each failures as failure (failure.id)}
        <div class="kv"><span>{shortDate(failure.receivedAt)}</span><span>{failure.message}</span></div>
      {/each}
    </div>
  {/if}
  <div class="note">every user gets their own relay &middot; nothing is created without your review<br>
  outbound reminder email remains configured by your administrator</div>
</div></div>
<div class="vignette"></div>
