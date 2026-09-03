<script>
  import { onMount, tick } from "svelte";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { clearTourSeen, readSettingsScreen, signOutEverywhere, writeReminders } from "$lib/data/workspace.js";
  import { galaxyOf } from "$lib/data/chart.js";
  import { relaunchTour } from "$lib/tour/relaunch.js";
  import { rollSeed, seedFromWorkspace } from "$lib/sky.js";
  import { mountEva } from "$lib/backdrops/eva.js";
  import Chrome from "$lib/Chrome.svelte";
  import "./settings.css";

  /**
   * Settings — EVA, the spacewalk (#472/#464). The ratified CONTENT is
   * unchanged from the helm (#464, §13/§14): identity, sky, reminders, relay
   * and memberships, your own controls and only yours. What changed is the
   * SCREEN: per the owner's §15 ruling ("EVA wins... EVA SHIPS AS IT IS for
   * now", 2026-08-17) and the 2026-09-03 instruction on #472 ("just build it
   * and we'll polish later if necessary"), each card is now an open access
   * panel on a hull — a hatch swung back on its hinges, its name stencilled
   * beside it — built from design/v19/settings-eva.html, the concept
   * (design/v19/settings-concept-eva.html) reconciled against this ratified
   * content. The living backdrop is $lib/backdrops/eva.js, ported from that
   * sheet exactly as station.js and constellations.js were: this file only
   * mounts it and tears it down.
   *
   * NOTE: the composite dispatcher still sends /settings to the old engine —
   * it manages households, which this screen deliberately does not. The flip
   * is a cutover line once those journeys exist v19-side (#453).
   */
  let { data } = $props();
  let view = $state(null);
  /** @type {?HTMLDivElement} */
  let backdropRoot = null;

  /*
   * THE v1.3.0 ROSTER, FINAL (§15, owner): star-chart, after dark, CLOUDS,
   * dawn (which now means the terminator) and retrograde. Atlas, hanami,
   * porcelain, miami and solarium are on the records shelf — packs.css still
   * defines atlas in full and forcing data-theme=atlas still renders it, so the
   * record survives. What goes is the OFFER, and this card is the only place in
   * the product that makes one in words as well as colour.
   *
   * Two rows change with the roster, and both of them because the sheet ruled
   * the picture rather than because a preference was tidied:
   *   · CLOUDS joins, carrying the lighter end of the range (owner: "one of
   *     Orbit's MAIN LIGHTER THEMES"). Its strip shows the cool white of a
   *     cloud crest and its own hazy pastel bodies.
   *   · DAWN's ground moves to the temperature story's own #d2d3d4 and its
   *     line stops saying "first light" — that is the pair's shared light, and
   *     what this pack IS now is the crossing. The words are the sheet's:
   *     design/v19/dawn-terminator.html, "night hands the sky to day".
   * Both strips' bodies are the pastels the refresh gave the light packs, so
   * the swatch is made of the same paint as the screen it promises.
   */
  const PACKS = [
    ["starchart", "star-chart", "the ratified night", "#060b1c",
      ["radial-gradient(circle at 35% 30%,#fff6e6,#ffe9c4 45%,transparent 72%)", "#f0b429", "#4ade80", "#8fb8ff"]],
    ["afterdark", "after dark", "lights out, ink up", "#05070d",
      ["radial-gradient(circle at 35% 30%,#ffffff,#dbe9ff 45%,transparent 72%)", "#f0b429", "#4ade80", "#7dd3fc"]],
    ["clouds", "clouds", "first light, from altitude", "#eef2f9",
      ["radial-gradient(circle at 35% 30%,#9c4a10,#eda253 45%,transparent 72%)", "#f0c076", "#95cfab", "#9dbce6"]],
    ["dawn", "dawn", "night hands the sky to day", "#d2d3d4",
      ["radial-gradient(circle at 35% 30%,#9c4a10,#eda253 45%,transparent 72%)", "#f0c076", "#95cfab", "#9dbce6"]],
    ["retrograde", "retrograde", "the eighties, classy", "#080a14",
      ["radial-gradient(circle at 35% 30%,#fff0fb,#ff4fd8 45%,transparent 72%)", "#ffd23f", "#3ef2a0", "#2de2e6"]],
  ];
  let active = $state("starchart");
  function pickPack(name) {
    active = name;
    document.documentElement.dataset.theme = name;
    try { localStorage.setItem("orbit-theme", name); } catch {}
  }

  /**
   * "Take the walk again" (#753, slice 3 of #477, mockup stop 8 of
   * design/v19/tour.html): clears `tourSeenAt` then goes to /home, where the
   * existing first-run trigger starts the walk at stop 1 because the record
   * now reads null. relaunchTour (relaunch.js) also arms the one-shot flag
   * that gets this SAME-session arrival past Tour.svelte's `started` guard.
   */
  function walkAgain() {
    return relaunchTour({
      clearTourSeen,
      navigateHome: () => goto(resolve("/home")),
    });
  }

  /**
   * Reminders (#468). The ratified card shows the two warning offsets as
   * VALUES — one toggle is the only control §13 draws — so the write below is
   * the flag's alone. A timing editor is undrawn: changing 14/3 has no
   * approved surface, and inventing one here would put UI on this screen the
   * owner has not seen. Awaiting design; the route already accepts the pair,
   * which is why it is read and handed straight back.
   */
  let emailReminders = $state(true);
  let reminderProblem = $state(null);

  async function toggleEmailReminders() {
    if (!view) return;
    const previous = emailReminders;
    /* Optimistic: a toggle that waits for a round trip reads as a dead
       control. The revert below is what makes that honest. */
    emailReminders = !previous;
    reminderProblem = null;
    try {
      const reminders = await writeReminders({
        emailEnabled: emailReminders,
        firstWarningDays: view.reminders.firstWarningDays,
        finalWarningDays: view.reminders.finalWarningDays,
      });
      /* The server's answer wins over the guess, sentences included. */
      view = { ...view, reminders };
      emailReminders = reminders.emailEnabled;
    } catch {
      emailReminders = previous;
      reminderProblem = "not saved — Orbit could not reach your reminder settings";
    }
  }

  /**
   * "Sign out of every device" — armed by a first tap, done by a second, the
   * family protocol the inbox and the item view already use for anything
   * that cannot be undone. This one ends the caller's own session too, so on
   * success there is no page left to return to: the cookie is dead and the
   * sign-in is the only honest destination.
   */
  let armedSignOut = $state(false);
  let signOutProblem = $state(null);

  async function tapSignOutEverywhere() {
    signOutProblem = null;
    if (!armedSignOut) {
      armedSignOut = true;
      return;
    }
    try {
      await signOutEverywhere();
      location.assign("/login");
    } catch {
      armedSignOut = false;
      signOutProblem = "still signed in — try again";
    }
  }

  const initials = $derived(
    (view?.user?.displayName ?? "")
      .split(/\s+/).map((part) => part[0] ?? "").join("").slice(0, 2).toUpperCase() || "·",
  );

  onMount(() => {
    let disposed = false;
    let backdropTeardown = () => {};
    active = document.documentElement.dataset.theme || "starchart";
    /* The backdrop mounts once the screen's own data has loaded — its
       households (galaxyOf) come from the same readSettingsScreen() answer
       this screen renders from, so there is no second fetch. The one seed
       follows home's own pattern: pinned to the workspace under fixtures, so
       the fidelity gate can compare one deterministic hull against the
       mockup's; rolled fresh otherwise. */
    readSettingsScreen().then(async (screen) => {
      if (disposed) return;
      view = screen;
      emailReminders = screen.reminders.emailEnabled;
      /* The panels this backdrop measures (`[data-nomen]`) are the cards the
         `{#if view}` block below renders, so a tick is awaited here — before
         mounting — to be sure they are actually in the document first. */
      await tick();
      if (disposed) return;
      const seed = data?.fixtures ? seedFromWorkspace(screen.primary ?? "") : rollSeed();
      const galaxy = galaxyOf({ households: screen.households, activeHouseholdId: screen.primary }, screen.today);
      backdropTeardown = mountEva(/** @type {HTMLDivElement} */ (backdropRoot), {
        seed, galaxy, primary: screen.primary,
      });
    });
    return () => {
      disposed = true;
      backdropTeardown();
    };
  });
</script>

<svelte:head><title>Orbit — settings</title></svelte:head>

<div class="helm-page">
<div class="eva-backdrop" bind:this={backdropRoot} aria-hidden="true"></div>

<Chrome user={view?.user} current="settings"
        role={view ? `${view.household?.name ?? ""} · ${view.household?.canManage ? "owner" : "member"}` : ""} />

<div class="page">
  <header class="screen">
    <h1>Settings</h1>
    <div class="sub">your controls, and only yours · the instance’s levers live on administration</div>
  </header>

  {#if view}
    <div class="cards">
    <section class="card wide" data-nomen="PANEL A-01 · YOU" data-sub="CREW ID · EMU 3005" data-hinge="-1">
      <div class="idrow">
        <span class="avatar" aria-hidden="true">{initials}</span>
        <div class="who"><b>{view.user?.displayName ?? ""}</b><span>{view.user?.email ?? ""} · signed in via your identity provider</span></div>
        <button>edit name</button>
      </div>
    </section>

    <section class="card wide" data-nomen="PANEL A-02 · YOUR SKY" data-sub="OPTICS BAY · TORQUE 12 N·m" data-hinge="-1">
      <div class="packs" role="group" aria-label="Theme pack">
        {#each PACKS as [name, title, line, ground, [sun, warm, ok, upcoming]] (name)}
          <button class="pack" aria-pressed={active === name} onclick={() => pickPack(name)}>
            <span class="strip" style="background:{ground}" aria-hidden="true">
              <i style="left:18px;top:18px;width:26px;height:26px;background:{sun}"></i>
              <i style="left:64px;top:38px;width:7px;height:7px;background:{warm}"></i>
              <i style="left:92px;top:22px;width:5px;height:5px;background:{ok}"></i>
              <i style="left:120px;top:44px;width:4px;height:4px;background:{upcoming}"></i>
            </span>
            <span class="label"><b>{title}</b><span>{line}</span></span>
          </button>
        {/each}
      </div>
      <button class="relaunch" onclick={walkAgain}>↻ take the walk again</button>
    </section>

    <section class="card" data-nomen="PANEL B-01 · REMINDERS" data-sub="CAUTION &amp; WARNING" data-hinge="-1">
      <div class="kv"><span>email reminders</span><button class="toggle" aria-pressed={emailReminders} aria-label="Email reminders" onclick={toggleEmailReminders}><i></i></button></div>
      <div class="kv"><span>first warning</span><b>{view.reminders.firstWarning}</b></div>
      <div class="kv"><span>final warning</span><b>{view.reminders.finalWarning}</b></div>
      <div class="kv"><span>outbound mail</span><span><b class="on">{view.reminders.outboundMail}</b> · by your administrator</span></div>
      {#if reminderProblem}<div class="note">{reminderProblem}</div>{/if}
    </section>

    <section class="card" data-nomen="PANEL B-02 · YOUR RELAY" data-sub="S-BAND · TDRS" data-hinge="1">
      <div class="kv"><span>address</span><b style="color:var(--accent-text)">{view.relay.address}</b></div>
      <div class="kv"><span>status</span><b class="on">{view.relay.status}</b></div>
      <div class="kv"><span>waiting for review</span><a href={resolve("/inbox")}>{view.waiting} arrival{view.waiting === 1 ? "" : "s"} — open your inbox →</a></div>
      <div class="kv"><span>rotate · pause · details</span><a href={resolve("/settings/mail")}>open the relay →</a></div>
    </section>

    <section class="card wide" data-nomen="PANEL C-01 · YOUR SYSTEMS" data-sub={`DOCKED ELEMENTS · ${view.memberships.length}`} data-hinge="-1">
      <!-- §15-2k: this card is the door to household management. Each row is
           the way into one system — /household/{id}, the owner's screen or the
           member's depending on who is reading it. A link, not a button with a
           handler: it is a place, so it wants an address the browser can open
           in its own way. Drawn exactly as the ratified row, because a row
           becoming reachable must not become a different row. -->
      {#each view.memberships as membership (membership.id)}
        <a class="memb" href={resolve("/household/[id]", { id: membership.id })}>
          <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="10" fill="none" style="stroke:var(--chart-line)"/><circle cx="13" cy="13" r="2.4" style="fill:var({membership.primary ? "--sun" : "--ink-mid"})"/></svg>
          <b>{membership.name}</b><small>{membership.memberCount} member{membership.memberCount === 1 ? "" : "s"} · {membership.itemCount} item{membership.itemCount === 1 ? "" : "s"}</small><span class="role" class:owner={membership.role === "owner"}>{membership.role}</span>
        </a>
      {/each}
    </section>

    </div><!-- /cards -->

    <!-- THE AIRLOCK: the last panel on the hull is not an access panel — it is
         the round hatch you came out of, and going back through it is signing
         out of every device (§15, the Quest · Joint Airlock name-drop). -->
    <div class="airlock" id="airlock" data-nomen="QUEST · JOINT AIRLOCK" data-sub="CREW LOCK · HATCH A/L 1">
      <button class="alk-btn" onclick={tapSignOutEverywhere}>{armedSignOut ? "tap again to sign out everywhere" : "sign out of every device →"}</button>
      {#if signOutProblem}<div class="note">{signOutProblem}</div>{:else}<div class="alk-note">the way back inside · every session, everywhere</div>{/if}
    </div>
  {/if}
</div>
</div>
