<script>
  import { beforeNavigate, goto } from "$app/navigation";
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import { applyCommand, readWorkspace } from "$lib/data/workspace.js";
  import { saveProblem } from "$lib/data/metadata-status.js";
  import Sheet from "$lib/pocket/Sheet.svelte";
  import Sky from "$lib/pocket/Sky.svelte";
  import { standOnKeyboard } from "$lib/pocket/sheet.js";
  import { wake } from "$lib/pocket/wake.js";
  import EntryForm from "./EntryForm.svelte";
  import { blankEntry, createCommandOf, entryChanged, refusalOf } from "./entry.js";

  /**
   * NEW ENTRY ON A PHONE (#1120, proposal §2.5). Server-rendered beside the
   * desk's card and chosen by CSS (the switch at the foot), as home's pocket
   * is. One column on the sky: the title, the form (EntryForm.svelte, shared
   * with the belt's edit sheet), and a save bar fixed to the foot that
   * stands on the on-screen keyboard.
   *
   * Every state (§1.13): the form's fields unlit while the households load;
   * the refusal beside save while something is missing (#1058: no section
   * is chosen for you); saving; a failure that is loud and stays until the
   * next attempt, with nothing typed lost (#1058); saved, which raises the
   * wake and approaches the new item on its belt. Leaving with something
   * typed asks first.
   *
   * `?name=` prefills the name (search's `add "x" as an item`, §2.4).
   */

  /** @type {import('./entry.js').FormHousehold[]} */
  let households = $state([]);
  let phase = $state(/** @type {"loading" | "ready" | "none" | "failed"} */ ("loading"));
  const prefill = page.url.searchParams.get("name") ?? "";
  let entry = $state(blankEntry({ name: prefill }));
  /* What "nothing typed" is, for the leave question; re-taken once the
     household is known. */
  let start = $state(blankEntry({ name: prefill }));
  /** @type {File | null} */
  let attachment = $state(null);
  let saving = $state(false);
  let saved = $state(false);
  /** @type {string | null} */
  let problem = $state(null);

  const refusal = $derived(phase === "ready" ? refusalOf(entry) : null);
  const dirty = $derived(!saved && (entryChanged(entry, start) || attachment !== null));

  async function load() {
    phase = "loading";
    try {
      const workspace = await readWorkspace();
      households = (workspace.households ?? []).map((one) => ({
        id: one.id, name: one.name, currency: one.currency, sections: one.sections ?? [],
      }));
      if (!households.length) { phase = "none"; return; }
      const active = workspace.activeHouseholdId ?? households[0].id;
      entry.householdId = households.some((one) => one.id === active) ? active : households[0].id;
      start = $state.snapshot(entry);
      phase = "ready";
    } catch {
      phase = "failed";
    }
  }
  $effect(() => { load(); });

  async function save() {
    if (saving || saved || refusal || phase !== "ready") return;
    const household = households.find((one) => one.id === entry.householdId);
    if (!household) return;
    saving = true;
    problem = null;
    const id = crypto.randomUUID();
    try {
      await applyCommand(createCommandOf(entry, { householdId: household.id, currency: household.currency ?? "GBP", id }));
      saved = true;
      wake(attachment ? `added to your orbit · ${attachment.name} was not kept` : `added to your orbit · ${entry.name.trim()}`);
      /* The approach (§2.5): the new item, seated on its belt. */
      await goto(resolve("/item/[[id]]", { id }));
    } catch (error) {
      /* Loud (#1058): the reason stays above the bar until the next attempt,
         the button comes back, and nothing typed is lost. No wake. */
      const words = saveProblem(/** @type {{ code?: string, message?: string }} */ (error));
      problem = /^not saved/i.test(words) ? words : `not saved — ${words}`;
    } finally {
      saving = false;
    }
  }

  /* ---- leaving with something typed (§2.5) ----------------------------- */
  let leaveOpen = $state(false);
  /** @type {URL | null} */
  let leaveTo = null;
  let leaving = false;
  beforeNavigate(({ cancel, to, type }) => {
    if (!dirty || leaving || type === "leave" || !to) return;
    cancel();
    leaveTo = to.url;
    leaveOpen = true;
  });
  function leave() {
    leaving = true;
    const to = leaveTo;
    leaveOpen = false;
    /* The callout's own history entry comes off first, or the address we go
       to lands on the entry that is about to be popped. */
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      removeEventListener("popstate", go);
      /* `to` is the address the held-back navigation was already going to,
         so it is resolved; only the fallback needs resolve(). */
      const href = to ? `${to.pathname}${to.search}${to.hash}` : resolve("/home");
      // eslint-disable-next-line svelte/no-navigation-without-resolve
      setTimeout(() => goto(href), 0);
    };
    addEventListener("popstate", go);
    setTimeout(go, 350);
  }

  /* ---- the save bar stands on the keyboard (§1.4, §1.11) --------------- */
  /** @type {HTMLElement | undefined} */
  let root = $state();
  let barHeight = $state(0);
  $effect(() => (root ? standOnKeyboard(root) : undefined));
  /* A field the keyboard would cover is brought up to sit 12px above the
     bar once the keyboard has risen (the fields' scroll-margin says how far). */
  $effect(() => {
    const vv = globalThis.visualViewport;
    if (!vv) return;
    const lift = () => {
      const el = document.activeElement;
      if (el instanceof HTMLElement && root?.contains(el) && el.matches("input,textarea"))
        el.scrollIntoView({ block: "nearest" });
    };
    vv.addEventListener("resize", lift);
    return () => vv.removeEventListener("resize", lift);
  });
</script>

<div class="pk-create" bind:this={root} style:--pc-bar="{barHeight}px">
  <Sky />
  <div class="pk-genesis" aria-hidden="true"></div>
  <main class="pk-column">
    <header class="pk-head">
      <h1 class="p-title">New entry</h1>
      <p class="pc-sub">add something to your orbit</p>
    </header>

    {#if phase === "loading"}
      <div class="p-card" aria-busy="true" aria-label="Loading your households">
        <p class="p-caps">details</p>
        <div class="p-unlit"></div><div class="p-unlit"></div><div class="p-unlit"></div>
      </div>
    {:else if phase === "failed"}
      <div class="p-card">
        <p class="p-error" role="alert">Orbit could not read your households, so there is nowhere to file this yet.</p>
        <button type="button" class="p-pill act-accent pk-retry" onclick={load}>try again</button>
      </div>
    {:else if phase === "none"}
      <div class="p-card proposed">
        <p class="p-empty">no household yet · an entry needs one</p>
        <a class="p-pill act-accent" href={resolve("/home")}>find a household →</a>
      </div>
    {:else}
      <form id="pocket-entry" aria-label="New entry" onsubmit={(event) => { event.preventDefault(); save(); }}>
        <EntryForm bind:entry bind:attachment {households} disabled={saving || saved} />
      </form>
    {/if}
  </main>

  <div class="pk-bar" bind:clientHeight={barHeight}>
    <div class="pk-bar-in">
      {#if problem}
        <p class="pk-problem" role="alert">{problem}</p>
      {:else if refusal}
        <p class="pk-refusal" id="pk-refusal">{refusal}</p>
      {/if}
      <div class="pk-bar-acts">
        <a class="p-pill pk-never" href={resolve("/home")}>never mind</a>
        <button type="submit" form="pocket-entry" class="p-pill filled pk-save"
                disabled={phase !== "ready" || Boolean(refusal) || saving || saved}
                aria-describedby={refusal ? "pk-refusal" : undefined}>
          {saved ? "Added" : saving ? "Adding…" : "Add to orbit"}
        </button>
      </div>
    </div>
  </div>

  <Sheet bind:open={leaveOpen} size="callout" title="Leave without adding?">
    <p class="pk-leave-why">What you typed here is not kept.</p>
    {#snippet foot()}
      <button type="button" class="p-pill" onclick={() => { leaveOpen = false; }}>stay</button>
      <button type="button" class="p-pill danger" onclick={leave}>leave</button>
    {/snippet}
  </Sheet>
</div>

<style>
  /* THE DIALECT SWITCH: the same query as $lib/pocket/media.js. The desk's
     stage and backdrop go; its chrome stays, because on a phone Chrome.svelte
     draws the kit's top chrome and the hatch. */
  .pk-create{display:none}
  @media (max-width:900px), (max-height:600px){
    .pk-create{display:block;position:relative;min-height:100dvh}
    :global(.create-page > .backdrop),:global(.create-page > .stage),:global(.create-page > .vignette){display:none}
  }

  .pk-column{position:relative;z-index:2;box-sizing:border-box;max-width:var(--p-column);margin:0 auto;
    padding:calc(var(--p-chrome) + env(safe-area-inset-top) + 8px) var(--p-gutter)
      calc(var(--pc-bar, 120px) + var(--p-kb, 0px) + 24px)}
  /* #1083 (owner's fix 2): while the tour's pill stands on this screen's own
     save bar (`.pk-bar`), it raises 76px above the foot (the pill's 64px
     height plus its 12px gap, transport.js's own `.raised`) — pad the column
     by the same amount so the form's last field can still scroll clear of
     it. `data-tour-pocket` is set on `<html>` only while the pocket
     transport is mounted (transport.js). */
  :global(html[data-tour-pocket]) .pk-column{
    padding-bottom:calc(var(--pc-bar, 120px) + var(--p-kb, 0px) + 24px + 76px)}
  .pk-head{margin:0 0 20px;padding:0 2px}
  .pc-sub{margin:6px 0 0;font:var(--p-type-meta)/1.4 var(--mono);color:var(--ink-quiet);letter-spacing:.02em}

  /* Genesis (CON-9): the desk's constellations are cut by a phone's edge, so
     they are hidden (§1.10); a first light behind the title carries the
     personality instead. Static, under the vignette. */
  .pk-genesis{position:fixed;z-index:1;pointer-events:none;top:-90px;left:50%;width:520px;height:340px;
    transform:translateX(-50%);
    background:radial-gradient(ellipse at 50% 55%, color-mix(in srgb, var(--accent) 16%, transparent) 0%,
      color-mix(in srgb, var(--accent) 6%, transparent) 38%, transparent 70%)}
  :global([data-theme=retrograde]) .pk-genesis{
    background:radial-gradient(ellipse at 50% 55%, color-mix(in srgb, var(--bloom) 14%, transparent) 0%, transparent 65%)}

  .pk-retry{margin-top:12px}

  /* THE SAVE BAR (§2.5): fixed, glass, standing on the keyboard. The one
     blurred fixed layer on this screen (§5.3). */
  .pk-bar{position:fixed;z-index:15;left:0;right:0;bottom:var(--p-kb, 0px);
    background:color-mix(in srgb, var(--panel-raised) 88%, transparent);backdrop-filter:blur(16px);
    border-top:1px solid var(--line-soft);box-shadow:0 -12px 32px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,255,255,.05);
    padding:10px var(--p-gutter) calc(10px + env(safe-area-inset-bottom))}
  :global(:is([data-theme=dawn],[data-theme=clouds])) .pk-bar{
    box-shadow:inset 0 1px 0 rgba(255,255,255,.78), 0 -12px 28px rgba(48,66,98,.10)}
  .pk-bar-in{max-width:var(--p-column);margin:0 auto}
  .pk-bar-acts{display:flex;gap:var(--p-pill-gap)}
  .pk-save{flex:1}
  .pk-save:disabled{opacity:.5;cursor:default;box-shadow:none}
  .pk-refusal,.pk-problem{margin:0 0 8px;font:var(--p-type-meta)/1.4 var(--mono)}
  .pk-refusal{color:var(--ink-mid)}
  .pk-problem{color:var(--overdue-text);animation:p-errin 200ms var(--p-ease) both}

  .pk-leave-why{margin:0 0 16px;font:var(--p-type-body)/1.5 var(--ui);color:var(--ink-mid)}

  @media (prefers-reduced-motion:reduce){ .pk-problem{animation:none} }
</style>
