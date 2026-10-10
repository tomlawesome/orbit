<script>
  import { dayMonth } from "$lib/format.js";
  import "./relay.css";
  import { onMount } from "svelte";
  import { mountSatellites } from "$lib/backdrops/satellites.js";
  import Chrome from "$lib/Chrome.svelte";
  import { createArm } from "$lib/arm.js";
  import { rotateRelay } from "$lib/data/workspace.js";
  import { rollSeed, seedFromWorkspace } from "$lib/sky.js";
  import { isPocket } from "$lib/pocket/media.js";
  import { reasonWords } from "$lib/pocket/words.js";
  import Pocket from "./pocket.svelte";

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
   * arrives. "pause ingest" is live since slice 5 (#746): paused, mail
   * addressed to this member is recorded and held — nothing fetched, staged or
   * announced — and resuming stages all of it exactly once. Both act on the
   * signed-in member alone; neither can touch anybody else's relay.
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
  let working = $state(false);
  /* Rotating is destructive — the old address stops collecting new mail —
     so it arms first, the same two-tap protocol the phone layout's own
     ArmButton gives it (pocket.svelte). "pause ingest" beside it is
     reversible and stays a single tap. */
  let armedRotate = $state(false);
  const rotateArm = createArm({ onchange: (next) => (armedRotate = Boolean(next)) });
  /** @type {string | null} */
  let problem = $state(null);
  const relay = $derived(rotated ?? data.relay);
  const failures = $derived(data.failures ?? []);
  const pocket = isPocket();
  /* §14 (#471): back to the opener; a deep link with no history goes home. */
  const dismissRelay = () => {
    if (history.length > 1) history.back();
    else location.href = "/home";
  };

  /* Nothing here can name another member: the endpoint takes the session's
     own user and this sends no user, no generation and no address. */
  /** @param {"rotate" | "pause" | "resume"} action */
  const act = async (action) => {
    if (working) return;
    working = true;
    problem = null;
    try {
      rotated = await rotateRelay(action);
    } catch {
      /* #1151 W2-R6: this used to have no catch at all, so a failure left
         the button back to normal with nothing changed and no word of why.
         Same wording as the phone layout's own copy of this act
         (pocket.svelte's own `problem`), in the same spot below the
         buttons as that layout's own error text. */
      problem = action === "rotate"
        ? "not rotated — your address is unchanged. try again"
        : `not ${action === "pause" ? "paused" : "resumed"} — Orbit could not reach your relay`;
    } finally {
      working = false;
    }
  };
  /* #1151 S7: the two-tap protocol (lib/arm.js) — the first tap arms, the
     second fires, and an unfired arm relaxes after four seconds, on scroll,
     on Escape and on a tap elsewhere, so nothing is left cocked on the desk.
     It once had none of that: a stray tap stayed armed forever, so a later,
     unrelated tap on this same button could fire the rotate with no fresh
     confirmation. */
  /** @param {MouseEvent & { currentTarget: HTMLElement }} event */
  const tapRotate = (event) => {
    if (rotateArm.tap(true, event.currentTarget)) act("rotate");
  };
  const toggleIngest = () => {
    // Any other tap disarms a pending rotate (arm.js: a press elsewhere).
    rotateArm.disarm();
    act(relay.ingest === "paused" ? "resume" : "pause");
  };

  /** @type {?HTMLDivElement} */
  let backdropRoot = null;
  onMount(() => {
    /* #1125: the phone hides the satellites (their labels would be cut at
       the screen's edge), so it does not fly them either. */
    if (isPocket()) return;
    const seed = data.fixtures ? seedFromWorkspace(data.relay.address) : rollSeed();
    return mountSatellites(/** @type {HTMLDivElement} */ (backdropRoot), seed);
  });
</script>

<svelte:head>
  <link rel="stylesheet" href="/screens/family.css" />
  <title>Orbit — your relay</title>
</svelte:head>

<!-- #1125, proposal §2.9: the phone's own relay, chosen by CSS. -->
<Pocket relay={data.relay} bind:rotated {failures} fixtures={Boolean(data.fixtures)} />

<div class="relay-page">
<div class="satellites" bind:this={backdropRoot} aria-hidden="true"></div>

<!-- The shared chrome (#1010, owner 2026-09-16): the way back goes to the
     sky here too, not to /settings -- the owner chose one door for every
     sub-screen. The stage's light-dismiss stays as the other way out. -->
<Chrome user={data.user} current="settings" household={data.household} />
<!-- §14 (#471): clicking off the card returns to wherever the reader came
     from — the inbox, settings, or home as the deep-link fallback. -->
<div class="stage" role={pocket ? undefined : "main"} onclick={(event) => { if (event.target === event.currentTarget) dismissRelay(); }}><div class="glass relay-card">
  <div class="dish" id="relaydish"><span></span><span></span><span></span><i></i></div>
  <h1 style="text-align:center">Your relay</h1>
  <div class="sub" style="text-align:center">forward documents to your private address<br>and they arrive in your review queue</div>
  <div class="alias">{relay.address}</div>
  <div class="kv"><span>status</span><b>{relay.status}</b></div>
  <div class="kv"><span>last received</span><span>{relay.lastReceived}</span></div>
  <div class="kv"><span>ingest</span><b>{relay.ingest}</b></div>
  <div class="btns"><button class="pri" disabled={working} aria-expanded={armedRotate} onclick={tapRotate}>{armedRotate ? "tap again to rotate" : "rotate address"}</button><button disabled={working} onclick={toggleIngest}>{relay.ingest === "paused" ? "resume ingest" : "pause ingest"}</button></div>
  {#if problem}<p class="problem">{problem}</p>{/if}
  {#if failures.length}
    <!-- #434: arrived-but-unreadable mail, in the server's own bounded words. -->
    <div class="failures">
      <h2>arrived, but could not be read</h2>
      {#each failures as failure (failure.id)}
        <div class="kv"><span>{dayMonth(failure.receivedAt)}</span><span>{reasonWords(failure.reason)} · {failure.message}</span></div>
      {/each}
    </div>
  {/if}
  <div class="note">every user gets their own relay &middot; nothing is created without your review<br>
  outbound reminder email remains configured by your administrator</div>
</div></div>
<div class="vignette"></div>
</div>
