<script>
  import "./pocket.css";
  import { goto, onNavigate } from "$app/navigation";
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import { applyCommand, readItemDocuments } from "$lib/data/workspace.js";
  import { completeCommand, nextDateAfter } from "$lib/data/commands.js";
  import { dialBodiesOf, daysUntil, hashId, manifestGroupsOf } from "$lib/data/chart.js";
  import { ago, money } from "$lib/format.js";
  import ArmButton from "$lib/pocket/ArmButton.svelte";
  import Hatch from "$lib/pocket/Hatch.svelte";
  import NorthStar from "$lib/pocket/NorthStar.svelte";
  import Row from "$lib/pocket/Row.svelte";
  import Sheet from "$lib/pocket/Sheet.svelte";
  import TopChrome from "$lib/pocket/TopChrome.svelte";
  import { POCKET_QUERY } from "$lib/pocket/media.js";
  import { wake } from "$lib/pocket/wake.js";
  import { markDoor } from "../household/[id]/door.js";
  import { HIT_R, spacedBodies } from "./pocket-dial.js";
  import { searchPocket } from "./pocket-search.js";

  /**
   * HOME ON A PHONE: the pocket sky (CON-10, #430; lifted to the kit in #1120,
   * proposal §2.1). Wordmark and orb, the dial, the other skies, the search
   * line, NEEDS ATTENTION, SIGNALS, and the north star.
   *
   * Both dialects are server-rendered and CSS picks one (pocket.css), so no
   * flash of the wrong one and no-JS still gets a page. This dialect's own
   * controls are Svelte's: the kit's sheets and rows bind their own
   * listeners, and nothing here reaches the desk's markup.
   *
   * One sheet, several faces. The item sheet (#1119), its documents, the
   * suggestion sheet (#466) and the search sheet (#1057) are one kit Sheet
   * whose contents change, because a search result raises the item's sheet
   * and the item's `documents` grows it (§1.4: a sheet that needs another
   * grows rather than stacking). One history entry, so Back always closes
   * whatever is up. The hatch is its own sheet, opened from the orb.
   * @typedef {{
   *   view?: import('$lib/data/workspace.js').HomeView | null,
   *   onapprove?: (suggestion: import('$lib/data/workspace.js').ReceiptSuggestion) => Promise<string | null>,
   *   ondismiss?: (suggestion: import('$lib/data/workspace.js').ReceiptSuggestion) => Promise<string | null>,
   *   onchanged?: () => Promise<unknown>,
   * }} Props
   */
  /** @type {Props} */
  let { view = null, onapprove = undefined, ondismiss = undefined, onchanged = undefined } = $props();
  let sheetOpen = $state(false);
  let hatchOpen = $state(false);

  /* ---- what the page draws ----------------------------------------------
     `DialBody` is the shape dialBodiesOf (chart.js) returns; `closest` is set
     afterwards on at most one entry, so it stays optional. */
  /** @typedef {{ id: string, title: string, days: number, dueDate?: string | null, placement: { angle: number, radius: number, x: number, y: number }, size: number, paint: string, kind: string, suggestion: boolean, costMinor: number | null, costIsEstimate: boolean, currency: string, documentCount: number, trail: boolean, overdue: boolean, closest?: boolean }} DialBody */
  /** @type {DialBody[]} */
  const bodies = $derived(
    view?.household
      ? dialBodiesOf(view.household, { suggestions: /** @type {any} */ (view.suggestions), today: view.today })
      : [],
  );
  // A thumb gets fewer, bigger bodies: the overdue one, the closest approach,
  // the relay's catch, anything carrying documents on a wide orbit; then the
  // spacing law (pocket-dial.js) keeps every 44px target clear of the next.
  const pocketBodies = $derived(
    spacedBodies(bodies.filter((b) => b.suggestion || b.overdue || b.closest || (b.documentCount > 0 && b.paint === "jade"))),
  );
  const groups = $derived(
    view?.household
      ? manifestGroupsOf(view.household, { suggestions: /** @type {any} */ (view.suggestions), today: view.today })
      : null,
  );
  const rows = $derived(groups ? [...groups.attention, ...groups.later] : []);
  const rawItems = $derived(new Map((view?.household?.items ?? []).map((item) => [item.id, item])));
  const others = $derived(
    view
      ? Object.entries(view.galaxy)
          .filter(([id]) => id !== view.primary)
          .map(([id, hh]) => {
            const angle = (hashId(id) / 0xffffffff) * Math.PI * 2;
            return {
              id,
              name: hh.name,
              tone: hh.planets[0]?.[3] ?? "--ok",
              dx: Math.round((10 + Math.cos(angle) * 5.5) * 10) / 10,
              dy: Math.round((10 + Math.sin(angle) * 5.5) * 10) / 10,
            };
          })
      : [],
  );
  const initials = $derived(
    (view?.user?.displayName ?? "")
      .split(/\s+/)
      .map((word) => word[0] ?? "")
      .join("")
      .slice(0, 2)
      .toUpperCase(),
  );
  // #852: the same "household · role" line the desk account panel derives.
  const roleLine = $derived(
    view?.household
      ? `${view.household.name ?? ""} · ${view.galaxy[/** @type {string} */ (view.primary)]?.role ?? "member"}`
      : "",
  );
  // The pocket's inbox orb (§2.1): arrivals from the relay still waiting on
  // the reader wear a ring and a count bead.
  const waiting = $derived((view?.suggestions ?? []).filter((s) => s.receiptId).length);
  const isAdmin = $derived(Boolean(page.data?.isAdmin));

  const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const QUARTER_POS = [[190, 30], [352, 196], [190, 370], [28, 196]];
  const quarters = $derived(
    QUARTER_POS.map(([x, y], k) => ({
      x, y,
      label: MONTHS[((view ? new Date(view.today + "T00:00:00Z").getUTCMonth() : 7) + k * 3) % 12],
    })),
  );
  // `ended` is the expiry past its date (#1005): quiet ink, never the alarm.
  /** @type {Record<string, string>} */
  const BAND_VAR = { overdue: "--overdue", "due-soon": "--warm", upcoming: "--upcoming", ok: "--ok", ended: "--ink-mid" };
  /** @type {(b: { days: number | null }) => string} */
  const tlabel = (b) => (b.days === null ? "" : b.days < 0 ? `T+${-b.days}d` : `T−${b.days}d`);
  /** @type {(iso: string) => string} */
  const short = (iso) =>
    new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
  // #1005: a renewal comes round, a one-off ends.
  /** @type {(s: { scheduleKind?: ?string }) => string} */
  const dateWord = (s) => (s.scheduleKind === "expiry" ? "ends" : "renews");
  /** @type {(b: DialBody) => string} */
  const bodyColour = (b) => `var(${BAND_VAR[b.overdue ? "overdue" : b.paint === "ended" ? "ended" : b.paint === "amber" ? "due-soon" : b.paint === "sky" ? "upcoming" : "ok"]})`;
  /** @type {(b: DialBody) => number} */
  const bodyR = (b) => (b.overdue ? 8 : b.closest ? 7 : 7.5);
  /** @type {(row: { costMinor: number | null, currency: string, costIsEstimate: boolean }) => string | null} */
  const cost = (row) => (row.costMinor ? money(row.costMinor, row.currency, row.costIsEstimate) : null);
  /** @type {(s: import('$lib/data/workspace.js').ReceiptSuggestion) => number | null} */
  const burnsIn = (s) => (s.expiresAt && view ? daysUntil(s.expiresAt.slice(0, 10), view.today) : null);
  /** @type {(iso: string | null | undefined) => string} */
  const agoShort = (iso) => (iso && view ? ago(iso, view.now ?? new Date().toISOString()) : "");

  // ---- the one sheet ------------------------------------------------------

  let face = $state(/** @type {"search" | "item" | "docs" | "sugg"} */ ("item"));
  /** @type {string | null} */
  let itemId = $state(null);
  /** @type {string | null} */
  let suggId = $state(null);
  /** @type {string | null} */
  let problem = $state(null);
  let busy = $state(false);

  const row = $derived(itemId ? rows.find((one) => one.id === itemId) ?? null : null);
  const documentCount = $derived(itemId ? rawItems.get(itemId)?.documentCount ?? 0 : 0);
  const suggestion = $derived(suggId ? view?.suggestions.find((one) => one.id === suggId) ?? null : null);
  const itemMeta = $derived(
    row
      ? [
          tlabel(row),
          row.dueDate ? short(row.dueDate) : null,
          cost(row),
          documentCount > 0 ? `◆ ${documentCount} document${documentCount === 1 ? "" : "s"}` : null,
        ].filter(Boolean).join(" · ")
      : "",
  );
  const sheetSize = $derived(face === "search" || face === "docs" ? "list" : "callout");
  const sheetTitle = $derived(
    face === "search" ? "Search your orbit"
      : face === "sugg" ? suggestion?.title ?? ""
      : row?.title ?? "",
  );

  /** @param {string} id */
  function openItem(id) {
    itemId = id;
    face = "item";
    problem = null;
    sheetOpen = true;
  }
  /** @param {string} id */
  function openSuggestion(id) {
    suggId = id;
    face = "sugg";
    problem = null;
    sheetOpen = true;
  }
  function openSearch() {
    face = "search";
    problem = null;
    query = "";
    sheetOpen = true;
    loadSearchDocuments();
  }

  // The dial's bodies are SVG, so Enter and Space have to be taught (#851).
  /** @type {(event: KeyboardEvent, then: () => void) => void} */
  const onKeyActivate = (event, then) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    then();
  };

  // A sheet that was up when the screen widened past the pocket would float
  // over the desk; put everything away instead.
  $effect(() => {
    const media = matchMedia(POCKET_QUERY);
    const onchange = () => {
      if (!media.matches) { sheetOpen = false; hatchOpen = false; }
    };
    media.addEventListener("change", onchange);
    return () => media.removeEventListener("change", onchange);
  });

  // ---- documents: the sheet grows (#1119) ---------------------------------

  /** @type {{ id: string, itemId: string, name: string, meta: string }[] | null} */
  let documents = $state(null);
  /** @type {string | null} */
  let documentsFor = null;

  async function showDocuments() {
    const id = itemId;
    if (!id || !view?.primary) return;
    face = "docs";
    if (documentsFor === id && documents) return;
    documents = null;
    documentsFor = id;
    problem = null;
    try {
      const found = await readItemDocuments(view.primary, id);
      if (documentsFor === id) documents = found;
    } catch (error) {
      if (documentsFor === id) problem = /** @type {{ message?: string }} */ (error)?.message ?? "couldn't read the documents — try again";
    }
  }

  // The approach (§1.2, §1.9): `open` goes to the item's own screen and the
  // sheet lifts into it. The morph is a view transition; pocket.css names the
  // sheet's card and says how it lifts. Reduced motion, or a browser without
  // view transitions, simply navigates.
  let morphing = false;
  onNavigate((navigation) => {
    if (!morphing) return;
    morphing = false;
    if (!document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    return new Promise((ready) => {
      document.startViewTransition(async () => {
        ready(undefined);
        await navigation.complete;
      });
    });
  });

  // A document has no address of its own yet (item/[[id]]/+page.svelte), so a
  // paper opens its item's belt and says which paper it meant in the
  // navigation's state, where the belt can pick it up (step 3).
  /** @param {{ id: string, itemId: string }} doc */
  function openPaper(doc) {
    morphing = true;
    goto(resolve("/item/[[id]]", { id: encodeURIComponent(doc.itemId) }), {
      replaceState: true,
      state: { pocketPaper: doc.id },
    });
  }

  // ---- the suggestion sheet (#466) ----------------------------------------

  /** @param {"approve" | "dismiss"} act */
  async function decide(act) {
    const target = suggestion;
    const handler = act === "approve" ? onapprove : ondismiss;
    if (!target || !handler || busy) return;
    busy = true;
    problem = null;
    try {
      const failed = await handler(target);
      if (failed) { problem = failed; return; }
      sheetOpen = false;
      wake(act === "approve" ? `${target.title} added to your orbit` : `${target.title} dismissed`);
    } finally {
      busy = false;
    }
  }
  /** @type {Record<string, string>} */
  const EVIDENCE = { provider: "provider", renewsOn: "dueDate", costMinor: "costMinor" };
  /** @type {(s: import('$lib/data/workspace.js').ReceiptSuggestion, field: string) => string} */
  const sureness = (s, field) => {
    const evidence = s.fieldEvidence?.[EVIDENCE[field]];
    return evidence ? (evidence.confidence === "low" ? "unsure" : "sure") : "";
  };

  // ---- the search sheet (#1057, §2.4) -------------------------------------

  let query = $state("");
  /** @type {import('./pocket-search.js').SearchDocument[]} */
  let searchDocuments = $state([]);
  /** @type {object | null} */
  let searchDocumentsFor = null;

  async function loadSearchDocuments() {
    const household = view?.household;
    const householdId = view?.primary;
    if (!household || !householdId || searchDocumentsFor === household) return;
    searchDocumentsFor = household;
    const carrying = (household.items ?? []).filter((item) => item.status === "active" && (item.documentCount ?? 0) > 0);
    // Additive: an item whose papers cannot be read loses its papers from the
    // results, not the search.
    const found = await Promise.all(carrying.map(async (item) => {
      try {
        const papers = await readItemDocuments(householdId, item.id);
        return papers.map((doc) => ({ ...doc, itemTitle: item.title }));
      } catch {
        return [];
      }
    }));
    if (searchDocumentsFor === household) searchDocuments = found.flat();
  }

  const results = $derived(
    searchPocket(query, { items: rows, attention: groups?.attention ?? [], documents: searchDocuments }),
  );

  /** @param {{ id: string, title: string }} target */
  async function complete(target) {
    const raw = rawItems.get(target.id);
    if (!raw || !view?.primary || busy) return;
    busy = true;
    problem = null;
    const completedDate = view.today;
    try {
      await applyCommand(completeCommand(/** @type {any} */ ({ ...raw, householdId: view.primary }), {
        completedDate,
        nextDate: nextDateAfter(completedDate, raw.recurrenceMonths) ?? undefined,
      }));
      sheetOpen = false;
      wake(`${target.title} completed`);
      await onchanged?.();
    } catch (error) {
      problem = /** @type {{ message?: string }} */ (error)?.message ?? "couldn't complete it — try again";
    } finally {
      busy = false;
    }
  }

  // Keyboard (§2.4): ↓ from the field walks into the results, ↑ and ↓ move
  // through them, ↑ from the first goes back to the field, Enter in the field
  // takes the first result. Escape is the sheet's own.
  /** @type {HTMLElement | undefined} */
  let resultList = $state();
  const resultStops = () =>
    /** @type {HTMLElement[]} */ ([...(resultList?.querySelectorAll("[data-row-face], .pk-act") ?? [])]);
  /** @param {KeyboardEvent} event */
  function fieldKey(event) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      resultStops()[0]?.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      resultStops()[0]?.click();
    }
  }
  /** @param {KeyboardEvent} event */
  function listKey(event) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const stops = resultStops();
    const at = stops.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    if (at < 0) return;
    event.preventDefault();
    const next = at + (event.key === "ArrowDown" ? 1 : -1);
    if (next < 0) /** @type {HTMLElement | null} */ (document.querySelector(".pk-field"))?.focus();
    else stops[Math.min(next, stops.length - 1)]?.focus();
  }

  // ---- other skies: a chip flies there (#1118, owner 2026-09-25, 7a) --------

  /** @type {string | null} */
  let flying = $state(null);
  let flight = $state({ x: 0, y: 0 });
  /** @type {HTMLElement | undefined} */
  let dialEl = $state();
  // As the desk does: the sky streams toward the other household and you
  // arrive at it, through the sun's door, so its way back reads "← your sky".
  /**
   * @param {MouseEvent} event
   * @param {string} id
   */
  function fly(event, id) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    markDoor("sky");
    if (flying) { event.preventDefault(); return; }
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || !dialEl) return;
    event.preventDefault();
    const chip = /** @type {HTMLElement} */ (event.currentTarget).getBoundingClientRect();
    const dial = dialEl.getBoundingClientRect();
    flight = {
      x: Math.round(chip.left + chip.width / 2 - (dial.left + dial.width / 2)),
      y: Math.round(chip.top + chip.height / 2 - (dial.top + dial.height / 2)),
    };
    flying = id;
    const href = /** @type {HTMLAnchorElement} */ (event.currentTarget).href;
    setTimeout(() => goto(href).finally(() => { flying = null; }), 620);
  }
</script>

<div class="pocket" class:pk-flying={flying}>
<div class="sky"><svg viewBox="0 0 400 850" preserveAspectRatio="xMidYMid slice">
<g fill="var(--star-far, #e9edf8)"><circle cx="152.4" cy="196.1" r="0.52" opacity="0.37"/>
      <circle cx="231.2" cy="586.6" r="0.79" opacity="0.22"/>
      <circle cx="292.6" cy="490.0" r="0.95" opacity="0.3"/>
      <circle cx="335.7" cy="373.5" r="0.51" opacity="0.14"/>
      <circle cx="289.3" cy="142.4" r="0.86" opacity="0.29"/>
      <circle cx="23.8" cy="666.7" r="0.42" opacity="0.36"/>
      <circle cx="336.4" cy="183.5" r="0.91" opacity="0.32"/>
      <circle cx="50.0" cy="569.5" r="0.49" opacity="0.37"/>
      <circle cx="275.5" cy="833.0" r="0.44" opacity="0.2"/>
      <circle cx="248.0" cy="517.0" r="0.53" opacity="0.37"/>
      <circle cx="338.6" cy="256.2" r="0.5" opacity="0.3"/>
      <circle cx="162.9" cy="563.8" r="0.75" opacity="0.22"/>
      <circle cx="8.7" cy="114.7" r="0.72" opacity="0.32"/>
      <circle cx="170.3" cy="632.8" r="0.78" opacity="0.36"/>
      <circle cx="262.0" cy="273.6" r="0.5" opacity="0.12"/>
      <circle cx="15.8" cy="733.1" r="1.01" opacity="0.33"/>
      <circle cx="43.7" cy="561.4" r="0.49" opacity="0.37"/>
      <circle cx="262.2" cy="637.2" r="0.83" opacity="0.23"/>
      <circle cx="339.4" cy="817.4" r="0.57" opacity="0.23"/>
      <circle cx="293.4" cy="578.0" r="0.69" opacity="0.24"/>
      <circle cx="387.1" cy="234.6" r="0.55" opacity="0.31"/>
      <circle cx="110.8" cy="762.8" r="0.63" opacity="0.38"/>
      <circle cx="151.9" cy="752.4" r="0.93" opacity="0.32"/>
      <circle cx="85.7" cy="139.6" r="0.42" opacity="0.15"/>
      <circle cx="266.6" cy="54.7" r="0.57" opacity="0.27"/>
      <circle cx="62.1" cy="279.7" r="0.56" opacity="0.3"/>
      <circle cx="47.4" cy="847.9" r="0.82" opacity="0.31"/>
      <circle cx="221.0" cy="423.1" r="1.08" opacity="0.37"/>
      <circle cx="328.8" cy="25.4" r="0.81" opacity="0.38"/>
      <circle cx="255.3" cy="436.0" r="0.85" opacity="0.15"/>
      <circle cx="291.1" cy="666.2" r="0.45" opacity="0.25"/>
      <circle cx="238.1" cy="299.2" r="0.88" opacity="0.38"/>
      <circle cx="362.5" cy="261.6" r="0.51" opacity="0.36"/>
      <circle cx="244.8" cy="705.1" r="1.01" opacity="0.18"/>
      <circle cx="235.0" cy="257.7" r="0.96" opacity="0.31"/>
      <circle cx="95.6" cy="425.1" r="0.82" opacity="0.17"/>
      <circle cx="73.0" cy="403.1" r="0.45" opacity="0.25"/>
      <circle cx="376.0" cy="702.1" r="0.44" opacity="0.35"/>
      <circle cx="286.6" cy="601.9" r="0.42" opacity="0.33"/>
      <circle cx="78.2" cy="682.6" r="0.63" opacity="0.21"/>
      <circle cx="68.9" cy="737.4" r="0.56" opacity="0.36"/>
      <circle cx="205.5" cy="126.2" r="0.86" opacity="0.26"/>
      <circle cx="10.8" cy="700.1" r="0.59" opacity="0.11"/>
      <circle cx="306.5" cy="618.0" r="0.67" opacity="0.16"/>
      <circle cx="210.8" cy="498.5" r="0.88" opacity="0.25"/>
      <circle cx="227.1" cy="612.7" r="0.53" opacity="0.15"/>
      <circle cx="193.8" cy="641.0" r="0.96" opacity="0.36"/>
      <circle cx="175.6" cy="606.6" r="0.47" opacity="0.22"/>
      <circle cx="26.7" cy="710.0" r="1.1" opacity="0.3"/>
      <circle cx="301.0" cy="316.4" r="0.96" opacity="0.13"/>
      <circle cx="148.2" cy="298.2" r="1.0" opacity="0.15"/>
      <circle cx="63.7" cy="76.0" r="0.99" opacity="0.19"/>
      <circle cx="361.2" cy="266.0" r="0.99" opacity="0.16"/>
      <circle cx="361.0" cy="827.6" r="1.01" opacity="0.31"/>
      <circle cx="358.5" cy="777.2" r="1.07" opacity="0.18"/>
      <circle cx="340.0" cy="662.7" r="0.64" opacity="0.15"/>
      <circle cx="359.9" cy="401.5" r="0.77" opacity="0.37"/>
      <circle cx="193.5" cy="214.6" r="0.88" opacity="0.26"/>
      <circle cx="109.0" cy="588.2" r="1.03" opacity="0.17"/>
      <circle cx="325.1" cy="640.6" r="0.77" opacity="0.16"/></g></svg></div>
<TopChrome wordmark>
  {#snippet end()}
    <!-- #852: the avatar opens the account menu; #1120: that menu is the
         kit's hatch. It opens rather than toggles, so a press replayed after
         the screen went live (#1064, +page.svelte) cannot close it again. -->
    <button class="porb" id="morb" class:waiting={waiting > 0} aria-haspopup="dialog" aria-expanded={hatchOpen}
            aria-label={waiting > 0 ? `Account and menu, ${waiting} waiting in your inbox` : "Account and menu"}
            onclick={() => (hatchOpen = true)}>
      <span class="disc">{initials}</span>
      {#if waiting > 0}<span class="bead" aria-hidden="true">{waiting}</span>{/if}
    </button>
  {/snippet}
</TopChrome>
<div class="mpage">
  {#if view?.emptySky}
  <!-- §11 (#453): the pocket's labelled sky is a list — each system a ring
       and a name, nothing else. Tapping asks; asking rides data attributes
       that +page.svelte binds, the same ask the desk's labelled sky raises. -->
  <div class="mgroup adrift"><h3 class="p-caps">Systems around you</h3>
    {#each Object.entries(view.galaxy) as [id, hh] (id)}
      <div class="mitem askrow" data-ask={id} data-ask-name={hh.name} data-ask-requested={String(Boolean(hh.requested))}>
        <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="10" fill="none" stroke="var(--line)"/><circle cx="13" cy="13" r="2.4" style="fill:var(--ink-mid)"/></svg>
        <div class="flex"><b>{hh.name}</b><span>{hh.requested ? "asked to join · waiting" : "tap to ask to join"}</span></div>
      </div>
    {/each}
    <!-- #840: the create card this leads to only ever appears at / (the
         arrival), not on /create's full form -- there is no household yet
         for that form to write into while the sky is empty. -->
    <div class="burnup">the systems around you are labels until someone lets you in<br><a href={resolve("/")}>— or start your own system →</a></div>
  </div>
  {:else}
  <div class="mdial" bind:this={dialEl} style:--fx="{flight.x}px" style:--fy="{flight.y}px">
    <svg viewBox="0 0 380 380">
      <circle cx="190" cy="190" r="150" fill="none" stroke="var(--line)" stroke-width="1.5"/>
      <circle cx="190" cy="190" r="62" fill="none" stroke="var(--overdue)" stroke-opacity=".3"
              stroke-width="1" stroke-dasharray="3 5"/>
      <!-- Quarter labels at 15 units: 13px at the narrowest dial (§2.1). -->
      <g font-size="15" fill="var(--ink-quiet)" text-anchor="middle" font-family="JetBrains Mono,monospace">
        {#each quarters as q, k (k)}<text x={q.x} y={q.y}>{q.label}</text>{/each}</g>
      <path d="M190 38 l6 10 h-12 Z" style="fill:var(--accent)"/>
      <circle cx="190" cy="190" r="8" style="fill:#fff6e6"/>
      {#each pocketBodies as b (b.id)}
        <!-- #1129/§1.7: the drawn body keeps its size; an invisible 44px
             circle round it takes the tap, and the spacing law keeps every
             such circle clear of its neighbours. -->
        {#if b.suggestion}
          <!-- #466: the relay's catch is ON the dial at its law position —
               the same hollow accent body the desk shows (§12). -->
          <g class="pk-body" data-sheet-sugg={b.id} tabindex="0" role="button" aria-label={`caught receipt: ${b.title}`}
             onclick={() => openSuggestion(b.id)} onkeydown={(event) => onKeyActivate(event, () => openSuggestion(b.id))}>
            <circle cx={b.placement.x} cy={b.placement.y} r="8.5" style="fill:none;stroke:var(--accent);stroke-width:1.8"/>
            <circle cx={b.placement.x} cy={b.placement.y} r="6" style="fill:var(--accent)" opacity=".12"/>
            <circle class="hit" cx={b.placement.x} cy={b.placement.y} r={HIT_R}/>
          </g>
        {:else}
          <g class="pk-body" data-sheet-title={b.title} tabindex="0" role="button" aria-label={b.title}
             onclick={() => openItem(b.id)} onkeydown={(event) => onKeyActivate(event, () => openItem(b.id))}>
            <circle cx={b.placement.x} cy={b.placement.y} r={bodyR(b)} style="fill:{bodyColour(b)}"/>
            {#if b.documentCount > 0 && b.paint === "jade"}
              <ellipse cx={b.placement.x} cy={b.placement.y} rx="14" ry="5"
                       transform="rotate(-24 {b.placement.x} {b.placement.y})"
                       fill="none" style="stroke:var(--accent)" stroke-width="1.2" opacity=".8"/>
            {/if}
            <circle class="hit" cx={b.placement.x} cy={b.placement.y} r={HIT_R}/>
          </g>
        {/if}
      {/each}
    </svg>
  </div>
  {#if others.length}
  <!-- #845: the strip scrolls sideways, so it must be reachable to scroll by
       keyboard (WCAG 2.1.1): a focusable, named region. The rule below cannot
       see that it scrolls, so it is silenced deliberately. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="skies" tabindex="0" role="region" aria-label="Other skies">
    {#each others as hh (hh.id)}
      <a class="msys" class:target={flying === hh.id} href={resolve("/household/[id]", { id: hh.id })}
         onclick={(event) => fly(event, hh.id)}>
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="var(--line)"/><circle cx={hh.dx} cy={hh.dy} r="2" style="fill:var({hh.tone === "--warm" ? "--warm" : hh.tone === "--upcoming" ? "--upcoming" : "--ok"})" opacity=".6"/></svg>{hh.name}</a>
    {/each}
  </div>
  {/if}
  <!-- §2.1: a button drawn as the desk's field, never a field on the page,
       so iOS never scrolls to an input that is about to move into the sheet. -->
  <button class="msearch" onclick={openSearch}>explore your world</button>
  <div class="pk-below">
  {#if groups?.attention.length}
    <h3 class="p-caps">Needs attention</h3>
    <div class="pk-list">
      {#each groups.attention as one (one.id)}
        <Row title={one.title} meta={[one.section, cost(one)].filter(Boolean).join(" · ")}
             trail={tlabel(one)} trailSub={one.dueDate ? short(one.dueDate) : ""} trailTone="var({BAND_VAR[one.band]})"
             onactivate={() => openItem(one.id)}>
          {#snippet mark()}<span class="pk-dot" style:background="var({BAND_VAR[one.band]})"></span>{/snippet}
        </Row>
      {/each}
    </div>
  {:else if groups?.later.length}
    <h3 class="p-caps">Needs attention</h3>
    <div class="pk-list">
      <Row title="nothing needs you" meta={`next up ${groups.later[0].title}${groups.later[0].days !== null ? `, ${tlabel(groups.later[0])}` : ""}`}
           onactivate={() => openItem(groups.later[0].id)}>
        {#snippet mark()}<span class="pk-dot quiet"></span>{/snippet}
      </Row>
    </div>
  {/if}
  <!-- #466: the pocket's signals — what the relay caught. A suggestion row
       raises the suggestion sheet; failures speak the server's words. -->
  {#if view?.suggestions?.length || view?.mailReading?.length || view?.mailFailures?.length}
    <h3 class="p-caps">Signals — your relay caught</h3>
    <div class="pk-list">
      {#each view.suggestions as s (s.id)}
        <div class="pk-sugg">
          <Row title={s.title}
               meta={[`from ${s.sourceDocument}`, burnsIn(s) !== null ? `burns up in ${burnsIn(s)}d` : null].filter(Boolean).join(" · ")}
               trail={s.costMinor ? money(s.costMinor, s.currency, true) : ""}
               trailSub={s.renewsOn ? `${dateWord(s)} ${short(s.renewsOn)}` : ""} trailTone="var(--accent-text)"
               onactivate={() => openSuggestion(s.id)}>
            {#snippet mark()}<span class="pk-dot hollow"></span>{/snippet}
          </Row>
        </div>
      {/each}
      {#each view.mailReading as r (r.id)}
        <div class="pk-reading">
          <Row title={`A message arrived ${agoShort(r.receivedAt)}`} meta="still reading its document">
            {#snippet mark()}<span class="pk-dot breathing"></span>{/snippet}
          </Row>
        </div>
      {/each}
      {#each view.mailFailures as f (f.id)}
        <Row title={`A message from ${short(f.receivedAt.slice(0, 10))}`} meta={f.message}>
          {#snippet mark()}<span class="pk-dot failed"></span>{/snippet}
        </Row>
      {/each}
    </div>
    <p class="burnup">unreviewed arrivals burn up after 45 days · nothing is added without you</p>
  {/if}
  </div>
  {/if}
</div>
{#if !view?.emptySky}<NorthStar />{/if}
</div>

<Sheet bind:open={sheetOpen} size={sheetSize} title={sheetTitle} hideTitle={face === "search"}>
  <!-- The search field rides in the sheet's head (§2.4). Declared in here
       rather than at the top of the markup: a top-level snippet trips the
       production bundler (#1130). -->
  {#snippet head()}
    {#if face === "search"}
      <input class="pk-field" type="search" placeholder="explore your world" aria-label="Search your orbit"
             autocomplete="off" enterkeyhint="go" bind:value={query} onkeydown={fieldKey}>
    {/if}
  {/snippet}
  {#if face === "item" && row}
    <!-- The item sheet (#1119, §2.1): the card the approach lifts. -->
    <div class="pk-item">
      <p class="pk-meta">{itemMeta}</p>
      <div class="p-pills pk-acts">
        <a class="p-pill filled" href={resolve("/item/[[id]]", { id: encodeURIComponent(row.id) })}
           onclick={() => (morphing = true)}>open</a>
        {#if documentCount > 0}<button class="p-pill" onclick={showDocuments}>documents</button>{/if}
      </div>
    </div>
  {:else if face === "docs" && row}
    <!-- `documents` grows the sheet into the item's papers (§2.1, #1119). -->
    <div class="pk-item">
      <p class="pk-meta">{itemMeta}</p>
      <div class="pk-list flat">
        {#if documents}
          {#each documents as doc (doc.id)}
            <Row title={doc.name} meta={doc.meta} onactivate={() => openPaper(doc)}>
              {#snippet mark()}<span class="pk-paper" aria-hidden="true">◆</span>{/snippet}
            </Row>
          {:else}
            <p class="p-empty">no documents ride with this item yet</p>
          {/each}
        {:else if !problem}
          <div class="p-unlit"></div><div class="p-unlit"></div>
        {/if}
      </div>
      {#if problem}<p class="p-error" role="alert">{problem}</p>{/if}
      <div class="p-pills pk-acts">
        <a class="p-pill filled" href={resolve("/item/[[id]]", { id: encodeURIComponent(row.id) })}
           onclick={() => (morphing = true)}>open</a>
      </div>
    </div>
  {:else if face === "sugg" && suggestion}
    <!-- The suggestion sheet (#466, §2.1): what the relay read, how sure it
         was, and the two decisions, each arming before it acts. -->
    <p class="pk-meta">{[
      suggestion.receivedAt ? `caught ${short(suggestion.receivedAt.slice(0, 10))}` : null,
      burnsIn(suggestion) !== null ? `burns up in ${burnsIn(suggestion)}d` : null,
    ].filter(Boolean).join(" · ")}</p>
    <div class="pk-list flat">
      {#if suggestion.provider}<Row title={suggestion.provider} meta="provider" trail={sureness(suggestion, "provider")} />{/if}
      {#if suggestion.renewsOn}<Row title={`${short(suggestion.renewsOn)} ${suggestion.renewsOn.slice(0, 4)}`} meta={dateWord(suggestion)}
                                     trail={sureness(suggestion, "renewsOn")} />{/if}
      {#if suggestion.costMinor}<Row title={money(suggestion.costMinor, suggestion.currency, true)} meta="cost"
                                      trail={sureness(suggestion, "costMinor")} />{/if}
      <Row title={suggestion.sourceDocument} meta="scanned clean">
        {#snippet mark()}<span class="pk-paper" aria-hidden="true">◆</span>{/snippet}
      </Row>
    </div>
    {#if problem}<p class="p-error" role="alert">{problem}</p>{/if}
    <div class="p-pills pk-acts">
      <ArmButton label="Add to orbit" armedLabel="tap again to add" danger={false} class="filled"
                 onfire={() => decide("approve")} />
      <ArmButton label="Dismiss" armedLabel="tap again to dismiss" danger={false} onfire={() => decide("dismiss")} />
    </div>
    <a class="pk-amend" href={resolve("/item/[[id]]", { id: encodeURIComponent(suggestion.receiptId ?? suggestion.id) })}>review &amp; amend →</a>
  {:else if face === "search"}
    <!-- #1057's phone half (§2.4; phone-search round 1, B). -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="pk-results" bind:this={resultList} onkeydown={listKey}>
      {#if !results.query}
        {#each results.items as one (one.id)}
          <Row title={one.title} meta={[one.section, cost(one)].filter(Boolean).join(" · ")}
               trail={tlabel(one)} trailSub={one.dueDate ? short(one.dueDate) : ""} trailTone="var({BAND_VAR[one.band]})"
               onactivate={() => openItem(one.id)}>
            {#snippet mark()}<span class="pk-dot" style:background="var({BAND_VAR[one.band]})"></span>{/snippet}
          </Row>
        {/each}
        <Row title="→ add an item" href={resolve("/create")} />
      {:else if results.nothing}
        <p class="p-empty">nothing in your orbit is called “{results.query}”</p>
        <Row title={`add “${results.query}” as an item`} href={resolve("/create")}>
          {#snippet mark()}<span class="pk-plus" aria-hidden="true">+</span>{/snippet}
        </Row>
      {:else}
        {#each results.items as one (one.id)}
          <Row title={one.title} meta={[one.section, cost(one)].filter(Boolean).join(" · ")}
               trail={tlabel(one)} trailSub={one.dueDate ? short(one.dueDate) : ""} trailTone="var({BAND_VAR[one.band]})"
               onactivate={() => openItem(one.id)}>
            {#snippet mark()}<span class="pk-dot" style:background="var({BAND_VAR[one.band]})"></span>{/snippet}
          </Row>
        {/each}
        {#each results.documents as doc (doc.id)}
          <Row title={doc.name} meta={`${doc.itemTitle} · ${doc.meta}`} onactivate={() => openPaper(doc)}>
            {#snippet mark()}<span class="pk-paper" aria-hidden="true">◆</span>{/snippet}
          </Row>
        {/each}
        {#if results.complete}
          {@const top = results.complete}
          <div class="pk-top">
            <ArmButton label={`→ complete “${top.title}”`} armedLabel="tap again to complete" danger={false} wide
                       class="pk-act" onfire={() => complete(top)} />
          </div>
        {/if}
      {/if}
      {#if problem}<p class="p-error" role="alert">{problem}</p>{/if}
    </div>
  {/if}
</Sheet>

<Hatch bind:open={hatchOpen} name={view?.user?.displayName ?? ""} {roleLine} {isAdmin}
       inboxCount={waiting || null} />
