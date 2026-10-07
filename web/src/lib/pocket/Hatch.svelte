<script>
  import { resolve } from "$app/paths";
  import { signOut } from "$lib/data/workspace.js";
  import { DEFAULT_THEME } from "$lib/theme.js";
  import { SWATCHES, applyTheme } from "$lib/theme-swatches.js";
  import { watchTour } from "$lib/tour/watch.js";
  import Row from "./Row.svelte";
  import Sheet from "./Sheet.svelte";
  /* First, with no comment of its own: Svelte hoists $props.id() and would
     carry a leading doc comment into the compiled declaration (#1120). */
  const uid = $props.id();

  /**
   * THE HATCH (#1120, proposal §2.2): the account menu as a sheet, opened
   * from the orb, on every signed-in screen below the CON-10 switch. Its
   * content's height, not a list sheet's fixed 60%, which hid the swatches
   * behind the foot on an iPhone (#1188).
   * Who you are; the journeys as 56px rows (48px on screens 700px tall or
   * less, #1256), the current page's in the accent text grade; the five theme
   * swatches as 44px rings, now beside their label; sign-out as a ghost
   * pill, one tap (owner, 2026-10-06). Leaves by any of the sheet's dismisses.
   *
   * Differs from §2.2's list in one row, on purpose: "Items" stays, because
   * it is the belt's only way in (#1014). Administration shows to instance
   * admins only; the page's own server gate is unchanged either way.
   * `inboxCount` adds "· N waiting" when a caller has it.
   * @typedef {{
   *   open?: boolean,
   *   name?: string,
   *   roleLine?: string,
   *   current?: string,
   *   isAdmin?: boolean,
   *   inboxCount?: number | null,
   * }} Props
   */
  /** @type {Props} */
  let {
    open = $bindable(false),
    name = "",
    roleLine = "",
    current = "",
    isAdmin = false,
    inboxCount = null,
    /* home's own descent (#1253): given the provider's logout URL once the
       session is ended, it plays the flight out to the dusk. Without it (no
       flight on this page) the hatch walks straight to /logout. */
    onsignedout = undefined,
    /* the menu opened: home readies the descent's world, as its desk orb does */
    onopened = undefined,
  } = $props();

  const initials = $derived(
    name.split(/\s+/).map((part) => part[0] ?? "").join("").slice(0, 2).toUpperCase() || "·",
  );

  let active = $state(DEFAULT_THEME);
  $effect(() => {
    if (open) active = document.documentElement.dataset.theme || DEFAULT_THEME;
    if (open) onopened?.();
  });

  /* Sign-out revokes before it leaves (#410): the session is gone before the
     reader reaches the goodbye screen. */
  /** @type {string | null} */
  let problem = $state(null);
  /* One tap (owner, 2026-10-06): the plain sign-out does not arm first. Set
     while the request is in flight, so a second tap never fires a second,
     concurrent signOut() (#1151 W1-R7, as home has it). */
  let signingOut = $state(false);
  /* "Watch the tour" (#1189). The sheet closes first and its history entry
     comes off before the film navigates, or the back that pops it would
     land after the film's own navigation and undo it. */
  async function watch() {
    const popped = new Promise((done) => {
      addEventListener("popstate", done, { once: true });
      setTimeout(done, 400);
    });
    open = false;
    await popped;
    await watchTour();
  }

  async function leave() {
    if (signingOut) return;
    signingOut = true;
    problem = null;
    /** @type {string | null} */
    let redirectTo = null;
    try {
      redirectTo = await signOut();
    } catch (error) {
      signingOut = false;
      problem = /** @type {{ message?: string }} */ (error)?.message ?? "still signed in — try again";
      return;
    }
    /* #1262: the menu goes as the sign-out goes ahead, never left over the flight */
    open = false;
    if (onsignedout) onsignedout(redirectTo);
    else location.href = "/logout";
  }
</script>

<!-- The head is the account (§5.2): avatar, name, role. The sheet's own
     title carries the name for a screen reader; the drawn one is hidden
     from it so the name is heard once. -->
<Sheet bind:open size="callout" title={name || "Account and menu"} hideTitle={Boolean(name)}>
  {#snippet head()}
    {#if name}
      <span class="who">
        <span class="p-avatar lg" aria-hidden="true">{initials}</span>
        <span class="whotext">
          <span class="name" aria-hidden="true">{name}</span>
          {#if roleLine}<span class="role">{roleLine}</span>{/if}
        </span>
      </span>
    {/if}
  {/snippet}
  {#if !name && roleLine}<p class="role">{roleLine}</p>{/if}
  <nav class="rows" aria-label="Go to">
    <Row title="Add an item" href={resolve("/create")} current={current === "create"}>
      {#snippet mark()}<span class="plus">+</span>{/snippet}
    </Row>
    <Row title="Items" href={resolve("/item")} current={current === "item"}>{#snippet mark()}<span></span>{/snippet}</Row>
    <Row title="Inbox" href={resolve("/inbox")} current={current === "inbox"}
         trail={inboxCount ? String(inboxCount) : ""} trailName={inboxCount ? `${inboxCount} waiting` : ""}
         bead={Boolean(inboxCount)}>{#snippet mark()}<span></span>{/snippet}</Row>
    <Row title="Settings" href={resolve("/settings")} current={current === "settings"}>{#snippet mark()}<span></span>{/snippet}</Row>
    {#if isAdmin}
      <Row title="Administration" href={resolve("/administration")} current={current === "administration"}>
        <!-- The station, in the chart pen: truss, two ruled arrays, a module. -->
        {#snippet mark()}<svg width="22" height="14" viewBox="0 0 22 14" fill="none" stroke="currentColor" stroke-width="1"><path d="M1 7h20"/><rect x="2" y="2" width="5" height="10"/><rect x="15" y="2" width="5" height="10"/><path d="M2 4.5h5M2 9.5h5M15 4.5h5M15 9.5h5"/><rect x="9" y="5" width="4" height="4" fill="currentColor"/></svg>{/snippet}
      </Row>
    {/if}
    <!-- #1256: last, for every member, in the plain mark Items and Inbox use. -->
    <Row title="About" href={resolve("/about")} current={current === "about"}>{#snippet mark()}<span></span>{/snippet}</Row>
  </nav>
  <!-- Label left, swatches right: the settings pocket's st-cardhead pattern (#1256). -->
  <div class="theme">
    <h3 class="p-caps" id="{uid}-theme">Theme</h3>
    <div class="swatches" role="group" aria-labelledby="{uid}-theme">
      {#each SWATCHES as swatch (swatch.id)}
        <button class="swatch" title={swatch.title} aria-label="{swatch.title} theme"
                aria-pressed={active === swatch.id}
                onclick={() => { active = swatch.id; applyTheme(swatch.id); }}>
          <span style:background={swatch.colour} style:box-shadow={swatch.shadow || undefined}></span>
        </button>
      {/each}
    </div>
  </div>
  <!-- The body's quiet last line, which a sheet allows outside its foot. -->
  <button class="watch" onclick={watch}>↻ watch the tour</button>
  {#if problem}<p class="p-error" role="alert">{problem}</p>{/if}
  <!-- The sheet's one act, in its pinned foot (review round §1.2). -->
  {#snippet foot()}
    <button class="p-pill danger" onclick={leave} disabled={signingOut}>sign out →</button>
  {/snippet}
</Sheet>

<style>
  .who{flex:1;min-width:0;display:flex;align-items:center;gap:12px}
  .whotext{min-width:0;display:flex;flex-direction:column;gap:2px}
  .name{font:600 var(--p-type-sheet)/1.25 var(--display);color:var(--ink);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .role{font:var(--p-type-meta)/1.4 var(--mono);color:var(--ink-quiet)}
  p.role{margin:0 0 12px}
  /* Rows sit on the sheet's glass, inset 4px, and their rail follows. */
  .rows{--p-gutter:4px;display:flex;flex-direction:column;padding:0 0 8px;border-bottom:1px solid var(--line-soft)}
  @media (max-height:700px){ .rows{--p-row-min:48px} }
  .plus{font:600 var(--p-type-body)/1 var(--mono);color:var(--accent-text)}
  .theme{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:8px}
  .theme .p-caps{margin:0}
  .swatches{display:flex;gap:8px}
  .swatch{appearance:none;width:var(--p-hit);height:var(--p-hit);padding:0;border:0;background:none;
    border-radius:50%;display:grid;place-items:center;cursor:pointer}
  .swatch span{width:30px;height:30px;border-radius:50%;border:1px solid var(--line)}
  .swatch[aria-pressed=true] span{outline:2px solid var(--accent);outline-offset:3px}
  .swatch:focus-visible{outline:2px solid var(--accent);outline-offset:0}
  .watch{appearance:none;display:flex;align-items:center;min-height:var(--p-hit);margin-top:4px;padding:0;
    border:0;background:none;cursor:pointer;font:var(--p-type-meta)/1.4 var(--mono);color:var(--accent-text)}
</style>
