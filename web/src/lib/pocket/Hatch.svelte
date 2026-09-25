<script>
  import { resolve } from "$app/paths";
  import { signOut } from "$lib/data/workspace.js";
  import { DEFAULT_THEME } from "$lib/theme.js";
  import { SWATCHES, applyTheme } from "$lib/theme-swatches.js";
  import ArmButton from "./ArmButton.svelte";
  import Row from "./Row.svelte";
  import Sheet from "./Sheet.svelte";

  /**
   * THE HATCH (#1120, proposal §2.2): the account menu as a list sheet,
   * opened from the orb, on every signed-in screen below the CON-10 switch.
   * Who you are; the journeys as 56px rows, the current page's in the accent
   * text grade; the five theme swatches as 44px rings; sign-out as a ghost
   * pill that arms. Leaves by any of the sheet's dismisses.
   *
   * Differs from §2.2's list in one row, on purpose: "Items" stays, because
   * it is the belt's only way in (#1014). Administration shows to instance
   * admins only; the page's own server gate is unchanged either way.
   * `inboxCount` adds "· N waiting" when a caller has it.
   * @type {{
   *   open?: boolean,
   *   name?: string,
   *   roleLine?: string,
   *   current?: string,
   *   isAdmin?: boolean,
   *   inboxCount?: number | null,
   * }}
   */
  let {
    open = $bindable(false),
    name = "",
    roleLine = "",
    current = "",
    isAdmin = false,
    inboxCount = null,
  } = $props();

  const uid = $props.id();
  let active = $state(DEFAULT_THEME);
  $effect(() => {
    if (open) active = document.documentElement.dataset.theme || DEFAULT_THEME;
  });

  /* Sign-out revokes before it leaves (#410): the session is gone before the
     reader reaches the goodbye screen. */
  /** @type {string | null} */
  let problem = $state(null);
  async function leave() {
    problem = null;
    try {
      await signOut();
    } catch (error) {
      problem = /** @type {{ message?: string }} */ (error)?.message ?? "still signed in — try again";
      return;
    }
    location.href = "/logout";
  }
</script>

<Sheet bind:open size="list" title={name || "Account and menu"}>
  {#if roleLine}<p class="role">{roleLine}</p>{/if}
  <nav class="rows" aria-label="Go to">
    <Row title="Add an item" href={resolve("/create")} current={current === "create"} />
    <Row title="Items" href={resolve("/item")} current={current === "item"} />
    <Row title={inboxCount ? `Inbox · ${inboxCount} waiting` : "Inbox"} href={resolve("/inbox")}
         current={current === "inbox"} />
    <Row title="Settings" href={resolve("/settings")} current={current === "settings"} />
    {#if isAdmin}
      <Row title="Administration" href={resolve("/administration")} current={current === "administration"} />
    {/if}
  </nav>
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
  <div class="out">
    <ArmButton label="sign out →" armedLabel="tap again to sign out" onfire={leave} />
    {#if problem}<p class="p-error" role="alert">{problem}</p>{/if}
  </div>
</Sheet>

<style>
  .role{margin:-6px 0 12px;font:var(--p-type-meta)/1.4 var(--ui);color:var(--ink-quiet)}
  .rows{display:flex;flex-direction:column;gap:2px;padding:8px 0;
    border-top:1px solid var(--line-soft);border-bottom:1px solid var(--line-soft)}
  /* Rows in a sheet sit on the sheet's glass, not on a panel of their own. */
  .rows :global(.face){background:transparent;padding-left:4px;padding-right:4px}
  .rows :global(a.face:active){background:var(--panel-raised)}
  .swatches{display:flex;gap:8px}
  .swatch{appearance:none;width:var(--p-hit);height:var(--p-hit);padding:0;border:0;background:none;
    border-radius:50%;display:grid;place-items:center;cursor:pointer}
  .swatch span{width:30px;height:30px;border-radius:50%;border:1px solid var(--line)}
  .swatch[aria-pressed=true] span{outline:2px solid var(--accent);outline-offset:3px}
  .swatch:focus-visible{outline:2px solid var(--accent);outline-offset:0}
  .out{margin-top:20px}
</style>
