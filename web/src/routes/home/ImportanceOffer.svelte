<script>
  /**
   * THE ONE-TIME IMPORTANCE PASS (#1463; round 7 U, ratified 2026-11-05;
   * design/v19/home-sun/round-7/u-pass-one-list.html).
   *
   * Items from before the field arrived have no importance. While any active
   * item is not set, home shows U's quiet pill: "N items have no importance
   * yet · set them now · not now". "set them now" opens the list (a card on
   * desk, the bottom sheet on the phone): one row per item that was unset
   * when it opened, nearest due first, each with a three-disc segment in the
   * section's colour. "Done" and "finish later" both close it and keep every
   * pick made (the mock-up's script, no step to undo); a row not touched stays
   * not set. "not now" is for good: saved on the server, per user.
   *
   * @typedef {{
   *   household: any,
   *   today: string | null | undefined,
   *   dismissed: boolean,
   *   layout: "desk" | "pocket",
   *   onsaved: () => Promise<void> | void,
   * }} Props
   */
  import { tick } from "svelte";
  import { applyCommand } from "$lib/data/workspace.js";
  import { upsertCommand } from "$lib/data/commands.js";
  import { draftOf, editsOf } from "$lib/editing/item-draft.js";
  import { daysUntil } from "$lib/data/chart.js";
  import { importanceOfferOf, passRowsOf } from "$lib/data/importance-offer.js";
  import { IMPORTANCE_CHOICES } from "$lib/editing/importance.js";
  import { sectionColourOf } from "$lib/option-colour.js";
  import { dismissImportanceOffer } from "$lib/pick.js";
  import { money, plural, tminusOf } from "$lib/format.js";
  import { inertPage, trapTab } from "$lib/pocket/focus.js";

  /** @type {Props} */
  let { household, today, dismissed, layout, onsaved } = $props();

  let notNow = $state(false);
  const items = $derived(household?.items ?? []);
  const offer = $derived(importanceOfferOf(items, { dismissed: dismissed || notNow }));

  /** The rows as the pass opened, and the picks made on them so far. */
  let open = $state(false);
  /** @type {any[]} */
  let rows = $state([]);
  /** @type {Record<string, "low" | "normal" | "high">} */
  let picks = $state({});
  /** @type {HTMLElement | null} */
  let seat = $state(null);
  /** @type {HTMLElement | null} */
  let opener = null;

  const picked = $derived(Object.keys(picks).length);

  /** @param {any} item */
  function rowOf(item) {
    const section = (household?.sections ?? []).find((/** @type {any} */ one) => one.id === item.sectionId);
    const days = today ? daysUntil(item.dueDate, today) : null;
    return {
      item,
      id: item.id,
      title: item.title,
      section: section?.name ?? null,
      colour: sectionColourOf(section),
      when: days === null ? "no date" : tminusOf(days),
      cost: item.costMinor == null ? null : money(item.costMinor, item.currency, Boolean(item.costIsEstimate)),
    };
  }

  /** @param {Event} event */
  async function begin(event) {
    opener = /** @type {HTMLElement} */ (event.currentTarget);
    rows = passRowsOf(items).map(rowOf);
    picks = {};
    open = true;
    await tick();
    seat?.querySelector("[role=radio]")?.closest("button")?.focus({ preventScroll: true });
  }

  /** Both ways out keep every pick; a row left alone stays not set. */
  async function close() {
    const made = Object.entries(picks);
    open = false;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    for (const [id, importance] of made) {
      const item = rows.find((row) => row.id === id)?.item;
      if (!item) continue;
      try {
        /* the edit drawer's own save: the draft's edits over the item, so the kind goes with it */
        await applyCommand(upsertCommand({ ...item, householdId: household.id }, editsOf({ ...draftOf(item), importance })));
      } catch {
        /* a refused pick leaves that item not set; the pill still counts it */
      }
    }
    if (made.length) await onsaved();
  }

  async function dismiss() {
    notNow = true;
    try {
      await dismissImportanceOffer();
    } catch {
      /* the choice stays for this page; the next load asks again */
      notNow = false;
    }
  }

  /** @param {KeyboardEvent} event */
  function onkeydown(event) {
    if (event.key === "Escape") { event.stopPropagation(); close(); return; }
    if (seat) trapTab(event, seat);
  }

  /** The page behind the pass takes no tap and no focus while it stands. @param {HTMLElement} node */
  function modal(node) {
    const restore = inertPage(node);
    return { destroy: restore };
  }
</script>

{#if offer.show && !open}
  <div class="offer {layout}" role="status"><span class="text"><span class="dot" aria-hidden="true"></span><span><span class="n">{plural(offer.count, "item")}</span> {offer.count === 1 ? "has" : "have"} no importance yet</span></span><button class="go" type="button" onclick={begin}>set them now</button><button class="quiet" type="button" onclick={dismiss}>not now</button></div>
{/if}

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="ip-layer {layout}" bind:this={seat} use:modal {onkeydown}>
    <div class="scrim" aria-hidden="true"></div>
    {#snippet list()}
      <p class="eyebrow">set the importance</p>
      <h2>{plural(rows.length, "item")} {rows.length === 1 ? "has" : "have"} no importance yet</h2>
      <p class="sub">{picked} set · {rows.length - picked} to go</p>
      <p class="lead">Small, normal, large: the size each planet draws when size shows importance. Leave one and it stays "not set".</p>
      <div class="plist">
        {#each rows as row (row.id)}
          <div class="pl-row" class:done={Boolean(picks[row.id])}>
            <div><div class="t">{row.title}</div>
              <div class="m">{#if row.section}<span class="opt" data-opt={row.colour ?? undefined}>{row.section}</span> · {/if}{row.when}{#if row.cost} · {row.cost}{/if}</div></div>
            <span class="trio" role="radiogroup" aria-label="Importance">
              {#each IMPORTANCE_CHOICES as level (level.value)}
                <button role="radio" aria-checked={picks[row.id] === level.value} aria-label={level.words} type="button" data-imp={level.value}
                        onclick={() => (picks = { ...picks, [row.id]: level.value })}><span class="disc" style="width:{level.disc * 0.625}px;height:{level.disc * 0.625}px;background:{row.colour ? `var(--c-${row.colour})` : "var(--ink-mid)"}"></span></button>
              {/each}
            </span>
          </div>
        {/each}
      </div>
    {/snippet}
    {#if layout === "pocket"}
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Set the importance">
        <div class="handle"></div>
        <div class="body">{@render list()}</div>
        <div class="sfoot"><button class="quiet" type="button" onclick={close}>finish later</button><button class="btn" type="button" onclick={close}>Done</button></div>
      </div>
    {:else}
      <div class="card" role="dialog" aria-modal="true" aria-label="Set the importance">
        {@render list()}
        <div class="foot"><button class="quiet" type="button" onclick={close}>finish later</button><button class="btn" type="button" onclick={close}>Done</button></div>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* U's rules in the app's tokens (U's --ink-2 is --ink-mid, --ink-3 --ink-faint, --ink-4 --ink-quiet) and rem, so the text-size step reaches them. */
  .offer{position:absolute;left:50%;top:34px;transform:translateX(-50%);z-index:6;display:flex;align-items:center;gap:16px;padding:0 10px 0 16px;border:1px solid var(--line);border-radius:99px;background:var(--panel-raised);backdrop-filter:blur(12px);font:0.75rem var(--mono);color:var(--ink-mid);white-space:nowrap}
  .offer .n{color:var(--ink);font-weight:500}
  .offer .text{display:flex;align-items:center;gap:10px}
  .offer .dot{width:11px;height:11px;border-radius:50%;border:1.5px dotted var(--ink-mid);flex:none}
  .offer .go{min-height:var(--p-hit);padding:0 14px;border-radius:99px;border:1px solid var(--accent);background:none;color:var(--accent-text);font:0.71875rem var(--mono);cursor:pointer}
  .offer .quiet{padding:0 6px}
  .offer.pocket{position:static;transform:none;white-space:normal;flex-wrap:wrap;gap:10px 12px;border-radius:16px;padding:12px 14px;margin:8px 0}
  .offer.pocket .text{flex:1 1 100%;font-size:0.8125rem}
  .offer.pocket .go{flex:1;font-size:0.8125rem}
  .offer.pocket .quiet{flex:1}
  .quiet{min-height:var(--p-hit);font:0.71875rem var(--mono);color:var(--ink-mid);background:none;border:0;padding:0;text-decoration:underline;text-underline-offset:3px;cursor:pointer}
  .pocket .quiet{display:flex;align-items:center;justify-content:center;font-size:0.78125rem}
  .scrim{position:fixed;inset:0;z-index:40;background:rgba(4,7,16,.45)}
  .ip-layer.desk{position:fixed;inset:0;z-index:41;display:grid;place-items:center;pointer-events:none}
  .card{position:relative;pointer-events:auto;width:520px;max-width:calc(100vw - 32px);max-height:calc(100vh - 48px);overflow:auto;padding:22px 28px 24px;background:var(--panel-raised);backdrop-filter:blur(16px);border:1px solid var(--line);border-radius:16px}
  .eyebrow{font:600 0.6875rem/1.4 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-faint)}
  h2{font:600 1.25rem var(--ui);color:var(--ink);margin:8px 0 2px}
  .sub{font:0.71875rem var(--mono);color:var(--ink-mid)}
  .lead{font:0.78125rem var(--ui);color:var(--ink-mid);line-height:1.5;margin-top:10px}
  .plist{margin-top:14px;max-height:420px;overflow:auto}
  .pl-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:14px;padding:9px 2px;border-bottom:1px solid var(--line-soft)}
  .pl-row:last-child{border:0}
  .pl-row .t{font:0.84375rem var(--ui);color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pl-row .m{font:0.65625rem var(--mono);color:var(--ink-faint);margin-top:2px}
  .pl-row .m .opt{color:var(--opt-text)}
  .pl-row.done .t{color:var(--ink-mid)}
  .trio{display:inline-flex;border:1px solid var(--line);border-radius:99px;overflow:hidden;background:var(--panel)}
  .trio button{width:44px;min-height:var(--p-hit);border:0;border-left:1px solid var(--line-soft);background:none;display:grid;place-items:center;cursor:pointer;padding:0}
  .trio button:first-child{border-left:0}
  .trio button[aria-checked=true]{background:color-mix(in srgb,var(--accent) 22%,transparent)}
  .disc{display:block;border-radius:50%}
  .trio button[aria-checked=true] .disc{box-shadow:0 0 0 2px var(--bg),0 0 0 3.5px var(--accent)}
  .foot{display:flex;justify-content:space-between;align-items:center;margin-top:18px}
  .btn{min-height:var(--p-hit);padding:0 20px;border-radius:99px;border:0;background:var(--accent-text);color:var(--bg);font:600 0.78125rem var(--ui);cursor:pointer}
  /* the phone: J's bottom sheet, the body scrolling and fading at the foot, the footer pinned */
  .sheet{position:fixed;left:0;right:0;bottom:0;z-index:41;max-height:80vh;display:flex;flex-direction:column;background:var(--panel-raised);backdrop-filter:blur(16px);border:1px solid var(--line);border-bottom:0;border-radius:18px 18px 0 0;padding:8px 22px 0}
  .sheet .handle{width:68px;height:5px;border-radius:3px;background:var(--ink-quiet);margin:0 auto 12px}
  .sheet .body{overflow:auto;flex:1;min-height:0;mask-image:linear-gradient(#000 calc(100% - 32px),transparent);padding-bottom:12px}
  .sheet .sfoot{flex:none;padding:12px 0 22px;display:flex;flex-direction:column;gap:2px;border-top:1px solid var(--line-soft);margin-top:10px}
  .sheet .btn{width:100%;font-size:0.9375rem;border-radius:24px}
  .sheet .sub{font-size:0.75rem}
  .sheet .plist{max-height:none;overflow:visible}
  .sheet .pl-row{padding:10px 0}
  .sheet .pl-row .t{font-size:0.9375rem;white-space:normal}
  .sheet .trio button{width:46px}
</style>
