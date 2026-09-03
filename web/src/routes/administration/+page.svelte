<script>
  import { onMount } from "svelte";
  import { resolve } from "$app/paths";
  import { addMember, readAdminScreen } from "$lib/data/workspace.js";
  import { constellationPlanetsOf, galaxyOf } from "$lib/data/chart.js";
  import { rollSeed, seedFromWorkspace } from "$lib/sky.js";
  import { mountStation } from "$lib/backdrops/station.js";
  import Chrome from "$lib/Chrome.svelte";
  import "./administration.css";

  /**
   * Administration — mission control (#465). Built from
   * design/v19/administration.html (ratified §13): the instance from above.
   * Admins see everything by design (§11); admins can place anyone anywhere.
   * People come from the real /api/admin/users route; ownership and
   * membership counts are the #453 epic's admin surface and render from the
   * fixture until it lands. Each system's ring wears its REAL due-state dots
   * — the same truths its constellation shows on home (§12). §15: the relay
   * lives in one place — the helm's card; what stands here is MAIL
   * MACHINERY, joined to operations in a single panel.
   *
   * §15-2g: JOIN REQUESTS DO NOT APPEAR HERE. They live in household
   * management only — admin surfaces are for admin-only functions, and an
   * instance admin who needs owner powers simply sees the owner's household
   * screen for the system chosen on the dial. The /api/join-requests routes
   * and their server code stay put; household-manage will consume them when
   * it is built.
   *
   * The living station backdrop (#472/#475, §14) is $lib/backdrops/station.js,
   * ported from design/v19/administration-iss.html — this file only mounts
   * it and tears it down, the same shape as create/+page.svelte and
   * settings/mail/+page.svelte. Its households come through the same seam
   * home and create draw their own skies from (galaxyOf), and its caption's
   * real facts (collection domain, systems aboard, crew) come off this
   * screen's own data rather than the sheet's hard-coded literals.
   */
  let { data } = $props();
  let view = $state(null);
  /** @type {?HTMLDivElement} */
  let backdropRoot = null;

  const initialsOf = (name) =>
    name.split(/\s+/).map((part) => part[0] ?? "").join("").slice(0, 2).toUpperCase();

  /* §11 (#453): direct placement — it lands on the real route and refreshes
     the screen with the server's answer. Deciding join requests is NOT an
     admin-screen function (§15-2g). */
  let busy = $state(null);
  let problem = $state(null);
  let placing = $state(null); // user id whose system picker is open
  async function place(userId, householdId) {
    busy = userId;
    problem = null;
    try {
      await addMember(householdId, userId);
      placing = null;
      view = await readAdminScreen();
    } catch (error) {
      problem = error?.message ?? String(error);
    } finally {
      busy = null;
    }
  }
  const TONE = { "--warm": "--warm", "--ok": "--ok", "--upcoming": "--upcoming", "--overdue": "--overdue" };
  /* the minisys ring at r40 shrunk to the roster's r13 */
  const ringDots = (household) =>
    constellationPlanetsOf(household.items ?? [], view.today).map(([x, y, r, tone]) => ({
      cx: 17 + x * 0.325,
      cy: 17 + y * 0.325,
      r: Math.max(1.2, r * 0.6),
      tone: TONE[tone] ?? "--ok",
    }));

  onMount(() => {
    let disposed = false;
    let backdropTeardown = () => {};
    /* The backdrop mounts once the screen's own data has loaded — its
       households (galaxyOf) and its caption's real facts both come from the
       same readAdminScreen() answer this screen renders from, so there is no
       second fetch. The one seed follows home's own pattern: pinned to the
       workspace under fixtures, so the fidelity gate can compare one
       deterministic sky against the mockup's; rolled fresh otherwise. */
    readAdminScreen().then((screen) => {
      if (disposed) return;
      view = screen;
      const seed = data?.fixtures ? seedFromWorkspace(view.primary ?? "") : rollSeed();
      const galaxy = galaxyOf({ households: view.households, activeHouseholdId: view.primary }, view.today);
      const domain = view.relay.find(([label]) => label === "collection domain")?.[1] ?? "";
      backdropTeardown = mountStation(/** @type {HTMLDivElement} */ (backdropRoot), {
        seed, galaxy, primary: view.primary,
        facts: { domain, systems: view.households.length, crew: view.users.length },
      });
    });
    return () => {
      disposed = true;
      backdropTeardown();
    };
  });
</script>

<svelte:head><title>Orbit — administration</title></svelte:head>

<div class="mission-page">
<div class="station-backdrop" bind:this={backdropRoot} aria-hidden="true"></div>
<div class="vignette" aria-hidden="true"></div>

<Chrome user={view?.user} current="administration"
        role={view ? `${view.household?.name ?? ""} · ${view.household?.canManage ? "owner" : "member"}` : ""} />

<div class="page">
  <header class="screen">
    <h1>Administration</h1>
    <div class="sub">{view
      ? `the instance from above · admins see everything by design · ${view.users.length} people · ${view.households.length} systems`
      : "the instance from above · admins see everything by design"}</div>
  </header>

  {#if view}
    <div class="grid">

      <div class="card">
        <div class="cardhead"><h3>People</h3><button>invite someone</button></div>
        {#each view.users as person (person.id)}
          <div class="person">
            <span class="avatar">{initialsOf(person.displayName)}</span>
            <div class="who">
              <b>{person.displayName}{person.id === view.user?.id ? " · you" : ""}</b>
              <span>{[person.email, view.peopleMeta[person.id]].filter(Boolean).join(" · ")}</span>
            </div>
            <span class="role" class:admin={person.isInstanceAdmin}>{person.isInstanceAdmin ? "admin" : "user"}</span>
            {#if person.id !== view.user?.id}
              <button class="place" title="Admins can add any user to any system"
                      onclick={() => (placing = placing === person.id ? null : person.id)}>place in a system…</button>
            {/if}
          </div>
          {#if placing === person.id}
            <div class="placerow">
              {#each view.households as household (household.id)}
                <button disabled={busy === person.id} onclick={() => place(person.id, household.id)}>{household.name}</button>
              {/each}
            </div>
          {/if}
        {/each}
        {#if problem}<div class="adminproblem">{problem}</div>{/if}
      </div>

      <div class="card">
        <div class="cardhead"><h3>Systems</h3><button>new system</button></div>
        {#each view.households as household (household.id)}
          <div class="system">
            <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
              <circle cx="17" cy="17" r="13" fill="none" style="stroke:var(--chart-line)"/>
              <circle cx="17" cy="17" r="2.6" style="fill:var({household.id === view.primary ? "--sun" : "--ink-mid"})"/>
              {#each ringDots(household) as dot (dot.cx + "-" + dot.cy)}
                <circle cx={dot.cx} cy={dot.cy} r={dot.r} style="fill:var({dot.tone})" opacity=".8"/>
              {/each}
            </svg>
            <div class="who">
              <b>{household.name}</b>
              <span>{[
                `${household.memberCount} member${household.memberCount === 1 ? "" : "s"}`,
                view.owners[household.id] ? `owner ${view.owners[household.id]}` : null,
                `${(household.items ?? []).length} item${(household.items ?? []).length === 1 ? "" : "s"}`,
              ].filter(Boolean).join(" · ")}</span>
            </div>
          </div>
        {/each}
      </div>

      <!-- §15: mail machinery sits WITH operations — one panel, two halves. -->
      <div class="card wide machinery">
        <div class="half">
          <div class="cardhead"><h3>Mail machinery</h3></div>
          {#each view.relay as [label, value, extra] (label)}
            <div class="kv"><span>{label}</span>
              {#if extra === "on"}<b class="on">{value}</b>
              {:else if extra}<span><b>{value.split(" · ")[0]}</b> · {value.split(" · ")[1]}</span><button>{extra}</button>
              {:else}<b>{value}</b>{/if}
            </div>
          {/each}
        </div>

        <div class="half">
          <div class="cardhead"><h3>Operations</h3><a href={resolve("/admin")}>open operations →</a></div>
          {#each view.services as [tone, name, detail] (name)}
            <div class="svc"><i style="background:var(--{tone})"></i><b>{name}</b><small>{detail}</small></div>
          {/each}
        </div>
      </div>

    </div>

    <div class="strip">{view.instance}</div>
  {/if}
</div>
</div>
