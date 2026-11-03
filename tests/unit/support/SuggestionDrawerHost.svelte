<script>
  /*
   * A test host for home's corridor, for tests/unit/home-suggestion-drawer.test.mjs
   * (ADR-0039, #1613). home/+page.svelte is 2,000 lines of desk page that no
   * unit test mounts, but a suggestion's drawer is made of parts that mount
   * fine: CorridorRow -> SuggestionView -> EditRows, with the REAL
   * drawer-acts.svelte.js (createDrawerActs), the REAL inbox/acts.js
   * (createReceiptActs) and the REAL data layer (readHome, approveWithOperation)
   * over a fetch the test controls.
   *
   * What is written out here is only the page's own glue for a suggestion,
   * copied from +page.svelte: the state a row is handed (expanded, armed,
   * busyReceipt, mailProblem), tapReceipt, amendReceipt, the `say` that keys a
   * suggestion's problem to its receipt, and the drawerActs object the row
   * reads. Everything else the page does (the address, Escape, the preview
   * card, the chooser) is browser behaviour and stays on the rig.
   */
  import { tick } from "svelte";
  import CorridorRow from "../../../web/src/routes/home/CorridorRow.svelte";
  import { createDrawerActs } from "../../../web/src/routes/home/drawer-acts.svelte.js";
  import { createReceiptActs } from "../../../web/src/routes/inbox/acts.js";
  import { approveWithOperation, readHome, wordsOf } from "$lib/data/workspace.js";
  import { corridorOf } from "$lib/data/chart.js";

  /** @type {{ first: any }} */
  let { first } = $props();

  // svelte-ignore state_referenced_locally
  let view = $state(first);
  /** @type {string | null} */
  let expanded = $state(null);
  /** @type {{ id: string | null, act: "approve" | "dismiss" | null }} */
  let armed = $state({ id: null, act: null });
  /** @type {string | null} */
  let busyReceipt = $state(null);
  /** @type {string | null} */
  let mailProblem = $state(null);

  const operationIds = new Map();

  /** Focus a control in the open drawer once it is drawn. @param {string} selector */
  async function focusInDrawer(selector) {
    await tick();
    if (!expanded) return;
    const el = /** @type {HTMLElement | null} */ (
      document.getElementById(`${expanded}-view`)?.querySelector(selector) ?? document.getElementById(expanded)?.querySelector(selector));
    el?.focus();
  }

  const acts = createDrawerActs({
    view: () => view,
    reread: async ({ view: home = true }) => { if (home) view = await readHome(); },
    say: (id, words, about = "item") => {
      if (about === "item") return;
      armed = { id: words ? id : null, act: about === "partial" ? "approve" : null };
      mailProblem = words;
    },
    focus: (_id, selector) => focusInDrawer(selector),
    open: () => expanded,
    itemOf: () => null,
    amend: (suggestion, item, sectionId) => amendReceipt(suggestion, item, sectionId),
    leave: () => { expanded = null; },
  });
  const modes = acts.modes;

  /** @param {any} suggestion @param {"approve" | "dismiss"} act */
  async function tapReceipt(suggestion, act) {
    mailProblem = null;
    if (!suggestion.receiptId) return false;
    if (armed.id !== suggestion.id || armed.act !== act) {
      armed = { id: suggestion.id, act };
      return false;
    }
    return createReceiptActs({
      view: () => view,
      operationIds,
      reload: async () => { view = await readHome(); },
      say: (_id, words) => { mailProblem = words; if (words && !armed.id) armed = { id: suggestion.id, act: null }; },
      busy: (id) => { busyReceipt = id ? suggestion.id : null; },
      landed: () => { armed = { id: null, act: null }; },
    }).decide({ id: suggestion.receiptId }, act);
  }

  /** @param {any} suggestion @param {any} item @param {string | null} sectionId */
  async function amendReceipt(suggestion, item, sectionId) {
    if (!suggestion.receiptId) return "not added — try again";
    busyReceipt = suggestion.id;
    try {
      const result = await approveWithOperation(suggestion, operationIds, view.primary, item, sectionId);
      if ("partial" in result) {
        view = await readHome().catch(() => view);
        return result;
      }
      return "replayed" in result ? result : null;
    } catch (error) {
      return wordsOf(error);
    } finally {
      busyReceipt = null;
    }
  }

  const detailSections = $derived.by(() => {
    const suggested = view.suggestions.find((/** @type {any} */ one) => one.id === expanded);
    const householdId = suggested ? (suggested.householdId ?? view.primary) : null;
    return view.households.find((/** @type {any} */ one) => one.id === householdId)?.sections ?? [];
  });

  const drawerActs = $derived({
    busy: acts.busy?.kind ?? (modes.edit.busy ? "save" : null),
    problem: modes.edit.problem ?? modes.edit.refusal ?? null,
    modes,
    sections: detailSections,
    oncancel: () => {
      const editing = Boolean(modes.edit.id);
      if (!modes.cancel()) return;
      focusInDrawer(editing ? ".ivedit, .ivamend" : '[aria-label^="Complete "]');
    },
    onamend: () => {
      const suggestion = view.suggestions.find((/** @type {any} */ one) => one.id === expanded);
      if (suggestion) acts.startAmend(suggestion);
    },
    onaccept: acts.addAmended,
    oncopy: async () => true,
  });

  const corridor = $derived(corridorOf(
    { households: [view.household], activeHouseholdId: view.primary },
    view.today,
    { suggestions: view.suggestions, include: expanded },
  ));
  const rows = $derived([...corridor.overdue, ...corridor.current, ...corridor.months.flatMap((/** @type {any} */ month) => month.rows)]);

  /** @param {MouseEvent} event @param {string} id */
  function onRowClick(event, id) {
    event.preventDefault();
    expanded = expanded === id ? null : id;
  }
</script>

<div class="corridor">
  {#each rows as row (row.id)}
    <CorridorRow {row} suggestions={view.suggestions} {busyReceipt} {armed} {mailProblem} today={view.today} {expanded}
      onReceiptTap={tapReceipt} {onRowClick} detail={null} detailBusy={false} detailProblem={null} copied={false}
      onCopyAddress={() => {}} showingDoc={acts.preview?.id ?? null} onOpenDoc={acts.openPreview} acts={drawerActs} />
  {/each}
</div>
