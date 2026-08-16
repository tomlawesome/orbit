<script>
  import { onMount } from "svelte";
  import { addMember, decideJoinRequest, readAdminScreen } from "$lib/data/workspace.js";
  import { constellationPlanetsOf } from "$lib/data/chart.js";
  import { ago } from "$lib/format.js";
  import { fillStarTiles } from "$lib/sky.js";
  import Chrome from "$lib/Chrome.svelte";
  import "./administration.css";

  /**
   * Administration — mission control (#465). Built from
   * design/v19/administration.html (ratified §13): the instance from above.
   * Admins see everything by design (§11); owners approve their own joiners,
   * admins can place anyone anywhere. People come from the real
   * /api/admin/users route; ownership, membership counts and join requests
   * are the #453 epic's admin surface and render from the fixture until it
   * lands. Each system's ring wears its REAL due-state dots — the same
   * truths its constellation shows on home (§12).
   */
  let view = $state(null);

  const initialsOf = (name) =>
    name.split(/\s+/).map((part) => part[0] ?? "").join("").slice(0, 2).toUpperCase();

  /* §11 (#453): decisions and direct placement — both land on the real
     routes, both refresh the screen with the server's answer. */
  let busy = $state(null);
  let problem = $state(null);
  let placing = $state(null); // user id whose system picker is open
  async function decide(requestId, action) {
    busy = requestId;
    problem = null;
    try {
      await decideJoinRequest(requestId, action);
      view = await readAdminScreen();
    } catch (error) {
      problem = error?.message ?? String(error);
    } finally {
      busy = null;
    }
  }
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

  onMount(async () => {
    fillStarTiles(document.getElementById("fartile"), document.getElementById("neartile"));
    view = await readAdminScreen();
  });
</script>

<svelte:head><title>Orbit — administration</title></svelte:head>

<div class="mission-page">
<div class="sky" aria-hidden="true">
  <svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <g class="far" fill="var(--star-far)"><g id="fartile"></g><use href="#fartile" x="1600"/></g>
    <g class="near" fill="var(--star-near)"><g id="neartile"></g><use href="#neartile" x="1600"/></g>
  </svg>
</div>
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
            {#if view.joinRequests.some((request) => request.householdId === household.id)}
              <span class="joinbadge">{view.joinRequests.filter((request) => request.householdId === household.id).length} want{view.joinRequests.filter((request) => request.householdId === household.id).length === 1 ? "s" : ""} in</span>
            {/if}
          </div>
        {/each}

        {#each view.joinRequests as request (request.id)}
          <div class="joinreq">
            <span class="avatar">{initialsOf(request.displayName)}</span>
            <p><b>{request.displayName}</b> asks to join <b>{request.householdName}</b> · {ago(request.createdAt, view.now)}</p>
            <button class="yes" disabled={busy === request.id} onclick={() => decide(request.id, "approve")}>approve</button>
            <button disabled={busy === request.id} onclick={() => decide(request.id, "decline")}>decline</button>
          </div>
        {/each}
      </div>

      <div class="card">
        <div class="cardhead"><h3>The relay · instance</h3></div>
        {#each view.relay as [label, value, extra] (label)}
          <div class="kv"><span>{label}</span>
            {#if extra === "on"}<b class="on">{value}</b>
            {:else if extra}<span><b>{value.split(" · ")[0]}</b> · {value.split(" · ")[1]}</span><button>{extra}</button>
            {:else}<b>{value}</b>{/if}
          </div>
        {/each}
      </div>

      <div class="card">
        <div class="cardhead"><h3>Operations</h3><a href="/admin">open operations →</a></div>
        {#each view.services as [tone, name, detail] (name)}
          <div class="svc"><i style="background:var(--{tone})"></i><b>{name}</b><small>{detail}</small></div>
        {/each}
      </div>

    </div>

    <div class="strip">{view.instance}</div>
  {/if}
</div>
</div>
