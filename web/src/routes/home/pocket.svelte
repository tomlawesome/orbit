<script>
  import "./pocket.css";
  import { tick, untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import { WorkspaceError, applyCommand, attachItemDocument, dueDateIn, householdElsewhereFor, readItemDocuments, removeDocument, restoreDocument } from "$lib/data/workspace.js";
  import PreviewCard from "$lib/reading/PreviewCard.svelte";
  import ChooserCard from "$lib/editing/ChooserCard.svelte";
  import { sectionColourOf } from "$lib/option-colour.js";
  import { DrawerModes, pressKeepsChooser } from "./drawer-modes.svelte.js";
  import { archiveCommand, completeCommand, snoozeCommand, statusCommand, upsertCommand } from "$lib/data/commands.js";
  import { dialBodiesOf, daysUntil, hashId, manifestGroupsOf, manifestRowOf } from "$lib/data/chart.js";
  import { money } from "$lib/format.js";
  import ArmButton from "$lib/pocket/ArmButton.svelte";
  import Hatch from "$lib/pocket/Hatch.svelte";
  import NorthStar from "$lib/pocket/NorthStar.svelte";
  import Sun from "$lib/sun/Sun.svelte";
  import { POCKET_SUN_R } from "$lib/sun/furnace.js";
  import Row from "$lib/pocket/Row.svelte";
  import Sheet from "$lib/pocket/Sheet.svelte";
  import { inertPage } from "$lib/pocket/focus.js";
  import TopChrome from "$lib/pocket/TopChrome.svelte";
  import { POCKET_QUERY, isPocket } from "$lib/pocket/media.js";
  import { reviewLockedOf } from "$lib/pocket/review.js";
  import { amendedOf, proposedItemOf } from "$lib/editing/item-draft.js";
  import { rowOf } from "$lib/pocket/row.js";
  import { wake } from "$lib/pocket/wake.js";
  import { markDoor } from "../household/[id]/door.js";
  import { HIT_R, spacedBodies } from "./pocket-dial.js";
  import { readSearchDocuments, searchPocket } from "./pocket-search.js";
  import { BAND_VAR, tlabel } from "./bands.js";
  import ItemDrawer from "./ItemDrawer.svelte";
  import SuggestionDrawer from "./SuggestionDrawer.svelte";

  /**
   * HOME ON A PHONE: the pocket sky (CON-10, #430; lifted to the kit in #1120,
   * proposal §2.1). Wordmark and orb, the dial, the other skies, the search
   * line, NEEDS ATTENTION, the SIGNALS pen, and the north star.
   *
   * Both dialects are server-rendered and CSS picks one (pocket.css), so no
   * flash of the wrong one and no-JS still gets a page. This dialect's own
   * controls are Svelte's: the kit's sheets and rows bind their own
   * listeners, and nothing here reaches the desk's markup.
   *
   * THE ROW IS THE ITEM (review round §2.1, the desk's own grammar, #424):
   * a manifest row opens in place into a drawer holding the item's detail,
   * its notes and papers, and its foot row (#1319: snooze, complete, attach
   * a document, retire, the pencil and the chain link); the relay's
   * catch opens the same way with its readings and its two decisions. A
   * search result closes the search and opens its row. An item the manifest
   * does not list (more than 30 days out, or undated) is drawn as one more
   * row when it is asked for -- by its address, a search, a paper or its
   * body -- since the belt it used to go to retired (#1319, §34). A planet
   * on the dial does what the desk's does (owner's answer 6a): it opens its
   * row and wears the lit ring while the row is open.
   *
   * Home's sheets are the search sheet (#1057) and the hatch, opened from
   * the orb; the item sheet is gone (§2.1). A suggestion's `review & amend
   * →`, and a second tap on its hollow body, put its row's own lines into
   * editing, as the desk's drawer does (#1319, owner 2026-10-08): the review
   * sheet that used to rise here is gone.
   * @typedef {{
   *   view?: import('$lib/data/workspace.js').HomeView | null,
   *   arrive?: boolean,
   *   onapprove?: (suggestion: import('$lib/data/workspace.js').ReceiptSuggestion) => Promise<string | null>,
   *   ondismiss?: (suggestion: import('$lib/data/workspace.js').ReceiptSuggestion) => Promise<string | null>,
   *   onamend?: (suggestion: import('$lib/data/workspace.js').ReceiptSuggestion,
   *     item: import('$lib/data/workspace.js').ItemProposal, sectionId: string | null) => Promise<string | null>,
   *   onchanged?: () => Promise<unknown>,
   *   onsignedout?: (redirectTo: string | null) => unknown,
   *   onmenu?: () => unknown,
   * }} Props
   */
  /** @type {Props} */
  let {
    view = null, arrive = false, onapprove = undefined, ondismiss = undefined, onamend = undefined, onchanged = undefined,
    onsignedout = undefined, onmenu = undefined,
  } = $props();
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
  // BAND_VAR/tlabel: #1151 W1-Q10, shared with CorridorRow.svelte and
  // +page.svelte's own dial via bands.js, rather than a second, diverging
  // copy (bands.js's own tlabel is now the null-safe version this file's
  // old copy had, per #1151 W1-F3's unscheduled band).
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
  // The desk's spheres (review round §2.1): a body wears its paint's
  // gradient; the ended expiry keeps its quiet flat ink.
  const SPHERES = new Set(["ruby", "jade", "amber", "sky"]);
  /** @type {(b: DialBody) => string} */
  const bodyFill = (b) => (SPHERES.has(b.paint) ? `url(#pk-${b.paint})` : bodyColour(b));
  // The body due soonest (an overdue one is the soonest of all, as the
  // spacing law has it) pings, home.css's perihelion ping.
  const pinging = $derived(pocketBodies.find((b) => !b.suggestion) ?? null);
  // Twelve month ticks on the ring, 6 units long, from the top.
  /** @type {(a: number, r: number) => number[]} */
  const tickAt = (a, r) => [190 + Math.cos(a) * r, 190 + Math.sin(a) * r].map((v) => Math.round(v * 10) / 10);
  const TICKS = Array.from({ length: 12 }, (_, k) => {
    const a = (k * Math.PI) / 6 - Math.PI / 2;
    const [x1, y1] = tickAt(a, 150);
    const [x2, y2] = tickAt(a, 144);
    return { x1, y1, x2, y2 };
  });
  /** @type {(row: { costMinor: number | null, currency: string, costIsEstimate: boolean }) => string | null} */
  const cost = (row) => (row.costMinor ? money(row.costMinor, row.currency, row.costIsEstimate) : null);
  /** @type {(s: import('$lib/data/workspace.js').ReceiptSuggestion) => number | null} */
  const burnsIn = (s) => (s.expiresAt && view ? daysUntil(s.expiresAt.slice(0, 10), view.today) : null);

  /* Reading and failed mail on home: one summary row (round 3 §2, 12a). */
  const mailSummary = $derived.by(() => {
    const reading = view?.mailReading?.length ?? 0;
    const failed = view?.mailFailures?.length ?? 0;
    const unread = `${failed} message${failed === 1 ? "" : "s"} couldn't be read`;
    if (reading && failed) return `reading ${reading} · ${failed} couldn't be read`;
    if (reading) return reading === 1 ? "reading a message" : `reading ${reading} messages`;
    return failed ? unread : "";
  });

  // ---- the search sheet's state ------------------------------------------

  /** @type {string | null} */
  let problem = $state(null);
  let busy = $state(false);

  function openSearch() {
    problem = null;
    query = "";
    sheetOpen = true;
    loadSearchDocuments();
  }

  // The dial's bodies are SVG, so Enter and Space have to be taught (#851).
  // Escape too (#1149, owner-decisions §28): a row opened from a body leaves
  // focus on the body, so the body is where Escape is heard. It puts the lit
  // row away and focus stays where it is, as a sheet's Escape leaves focus on
  // its opener (sheet.js). The row's own Escape (row.js) still serves a
  // reader whose focus is inside the row.
  /** @type {(event: KeyboardEvent, then: () => void) => void} */
  const onKeyActivate = (event, then) => {
    if (event.key === "Escape") {
      if (lit === null) return;
      event.preventDefault();
      rowOf(manifestRow(lit))?.close();
      return;
    }
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

  /* A paper found by the search: its item's row opens, and the paper's
     preview stands as the bottom sheet, as a paper pressed in the drawer
     does (#1319: the belt it used to go to retired). */
  /** @param {any} doc */
  async function openPaper(doc) {
    sheetOpen = false;
    if (!(await openRow(doc.itemId))) return;
    await tick();
    const from = /** @type {HTMLElement | null} */ (manifestRow(doc.itemId)?.querySelector(
      `[data-doc-row][aria-label="Open ${CSS.escape(doc.name)}"]`) ?? null);
    openPaperHere(doc, from ?? /** @type {HTMLElement} */ (document.activeElement));
  }

  // ---- the relay's catch (#466) ---------------------------------------------

  /**
   * The relay's catch, decided from its row in the signals, where a refusal
   * stays under the row's readings.
   * @param {"approve" | "dismiss"} act
   * @param {import('$lib/data/workspace.js').ReceiptSuggestion} target
   */
  async function decide(act, target) {
    const handler = act === "approve" ? onapprove : ondismiss;
    if (!handler || busy) return;
    busy = true;
    delete rowProblem[target.id];
    try {
      const failed = await handler(target);
      /* false: the row stays open with the refusal under it (Row.svelte run) */
      if (failed) { rowProblem[target.id] = failed; return false; }
      wake(act === "approve" ? `${target.title} added to your orbit` : `${target.title} dismissed`);
    } finally {
      busy = false;
    }
  }

  /* ---- #1319: A SUGGESTION AMENDED IN ITS ROW'S OWN LINES ---------------
     owner, 2026-10-08 ("Yeah, ideally"): the phone amends the way the desk
     does since a3f8fa5a (home/+page.svelte's startAmend). `review & amend →`
     puts the row's lines into editing (EditRows), the relay's proposal
     standing in for the item it would become (proposedItemOf); the choosers
     are the bottom sheet, as a filed item's are. `add to orbit` sends the
     rows as the amended item on the two-tap decision's own operation id
     (home's amendReceipt, as `onamend`), into the section the rows chose;
     `cancel` puts the readings back. The review sheet that rose here is
     gone. */
  /** @param {import('$lib/data/workspace.js').ReceiptSuggestion} s */
  function startAmend(s) {
    if (!s.receiptId || reviewLockedOf(s) || !view) return;
    const householdId = s.householdId ?? view.primary;
    if (!householdId) {
      rowProblem[s.id] = "This account has no household yet";
      return;
    }
    const own = (view.households ?? []).find((one) => one.id === householdId)?.sections
      ?? view.household?.sections ?? [];
    const sectionId = (own.find((one) => one.visible !== false) ?? own[0])?.id ?? null;
    delete rowProblem[s.id];
    previewPaper = null;
    modes.startEdit(proposedItemOf(s, { householdId, sectionId }));
    focusInRow(s.id, '[data-ed="title"]');
  }
  /**
   * The rows' save for a suggestion: approved as amended, or refused in the
   * rows' own words (EditSession says it under the rows).
   * @param {import('$lib/data/commands.js').CommandItem} item
   * @param {Partial<import('$lib/data/commands.js').CommandItem>} edits
   */
  async function addSuggestion(item, edits) {
    const suggestion = view?.suggestions.find((one) => one.id === item.id);
    if (!suggestion || !onamend) throw new Error("not added — this suggestion has gone");
    const { item: amended, sectionId } = amendedOf(item, edits);
    const problem = await onamend(suggestion, amended, sectionId);
    if (problem?.startsWith("The item is recorded")) {
      throw new Error("not finished — the item is recorded, but its documents need another try: add it again");
    }
    if (problem) throw new Error(`not added — ${problem}`);
  }
  async function addAmended() {
    const title = modes.edit.draft?.title.trim() ?? "";
    if (await modes.edit.commit()) wake(`added to your orbit · ${title}`);
  }
  /** What a suggestion's lines need while they are amended. @param {{ id: string }} s */
  const amendActsOf = (s) => ({
    modes,
    sections,
    onaccept: addAmended,
    oncancel: () => {
      if (!modes.cancel()) return;
      focusInRow(s.id, "[data-amend]");
    },
  });

  // ---- the search sheet (#1057, §2.4) -------------------------------------

  let query = $state("");
  /** @type {import('./pocket-search.js').SearchDocument[]} */
  let searchDocuments = $state([]);
  let papersReady = $state(false);
  /** @type {object | null} */
  let searchDocumentsFor = null;

  /** #1151 W1-Q8: shared with the desk's own copy (home/+page.svelte) via
   *  pocket-search.js's readSearchDocuments, which also carries the
   *  concurrency cap (#1151 W1-R9). */
  async function loadSearchDocuments() {
    const household = view?.household;
    const householdId = view?.primary;
    if (!household || !householdId || searchDocumentsFor === household) return;
    searchDocumentsFor = household;
    const carrying = (household.items ?? []).filter((item) => item.status === "active" && (item.documentCount ?? 0) > 0);
    // Additive: an item whose papers cannot be read loses its papers from the
    // results, not the search.
    const found = await readSearchDocuments(
      carrying, readItemDocuments, householdId, () => searchDocumentsFor !== household,
    );
    if (searchDocumentsFor === household) {
      searchDocuments = found;
      papersReady = true;
    }
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
      await applyCommand(completeCommand(/** @type {any} */ ({ ...raw, householdId: view.primary }), { completedDate }));
      sheetOpen = false;
      wake(`${target.title} completed`);
      await onchanged?.();
    } catch (error) {
      problem = /** @type {{ message?: string }} */ (error)?.message ?? "couldn't complete it — try again";
    } finally {
      busy = false;
    }
  }

  // ---- the drawers (review round §2.1) ---------------------------------------

  /** What went wrong acting from a row, by the row's id. @type {Record<string, string>} */
  const rowProblem = $state({});

  /* #1319: the belt retired, and the drawer opens any item (the
     coordinator's ruling, 2026-10-08). An item the manifest does not list --
     more than 30 days out, undated, or retired, cancelled or expired -- is
     drawn as one more row once it is asked for (its address, a search
     result, a paper, its body), and the list extends to hold it: in date
     order among the rows, undated at the end, its state in its meta. One at
     a time: the latest ask. */
  /** @type {string | null} */
  let asked = $state(null);
  const listed = $derived(groups ? (groups.attention.length ? groups.attention : groups.later.slice(0, 1)) : []);
  const askedRow = $derived.by(() => {
    if (!asked || !view?.household || listed.some((row) => row.id === asked)) return null;
    const item = view.household.items.find((one) => one.id === asked);
    return item ? manifestRowOf(view.household, item, view.today) : null;
  });
  /** Whether home holds an item by this id at all, whatever its status. @param {string} id */
  const holds = (id) => Boolean(view?.household?.items.some((one) => one.id === id));
  /** Rows in date order, undated last. @param {any[]} list */
  const byDate = (list) => [...list].sort((a, b) => (a.days ?? Infinity) - (b.days ?? Infinity));

  /** The manifest's row for an item, if the manifest draws one. @param {string} id */
  const manifestRow = (id) => document.querySelector(`.pocket .pk-below [data-row-key="${CSS.escape(id)}"]`);

  /**
   * Opens an item's row where it sits in the manifest and brings it to the
   * middle of the screen, as the desk's `#id` does. False when the manifest
   * draws no row for it.
   * @param {string} id
   * @param {{ focus?: boolean }} [options]
   */
  async function openRow(id, { focus = false } = {}) {
    await tick();
    let el = manifestRow(id);
    if (!el && holds(id)) {
      asked = id;
      await tick();
      el = manifestRow(id);
    }
    const control = rowOf(el);
    if (!el || !control) return false;
    control.open();
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
    if (focus) /** @type {HTMLElement | null} */ (el.querySelector("[data-row-face]"))?.focus({ preventScroll: true });
    return true;
  }

  /**
   * A search result closes the search and opens its row (§2.1), drawn for
   * it if the manifest does not list it (openRow).
   * @param {string} id
   */
  async function openResult(id) {
    sheetOpen = false;
    await tick();
    await openRow(id, { focus: true });
  }

  /* Arriving on an item's address (`copy link`, the desk's own, and the
     retired belt's `/item/<id>`, which the server answers with it): its
     row opens, once, as soon as the manifest has drawn it -- drawn for it if
     the manifest does not list it (openRow). A suggestion's address opens
     its row in the signals, where it is reviewed. An item in another of
     the reader's households waits: home switches to that household
     (+page.svelte, #1319) and its row opens there. An id home does not hold
     at all opens nothing. */
  let addressed = false;
  $effect(() => {
    const id = page.url.searchParams.get("item");
    if (addressed || !id || !groups || !isPocket()) return;
    if (!holds(id) && !view?.suggestions.some((one) => one.id === id)) {
      if (householdElsewhereFor(view, id)) return;
      addressed = true;
      return;
    }
    openRow(id).then((opened) => { addressed ||= opened; });
  });

  /* The papers in a drawer ride on the search's own read of them, made the
     first time any row opens rather than on every arrival. The open row's
     id is what lights its body on the dial. */
  /** @type {string | null} */
  let lit = $state(null);
  /* The star hides while a sheet is up and while any row is open (round 3
     §5): it stood over the open suggestion's `Dismiss`. */
  const starHidden = $derived(sheetOpen || hatchOpen || lit !== null);
  /** @param {string} id */
  const onRowToggle = (id) => /** @type {(open: boolean) => void} */ ((open) => {
    /* #1319: an open row is the one asked for, so an edit that moves it out
       of what the manifest lists (a new date past 30 days) keeps it drawn,
       open, in its new place in date order, not folded away (the Q1 rule). */
    if (open) { lit = id; asked = id; loadSearchDocuments(); } else if (lit === id) lit = null;
  });

  /**
   * A planet on the dial (owner's answer 6a, the desk's `.body-link`): a tap
   * scrolls the manifest to its row and opens it, drawn for it if the
   * manifest does not list it (openRow), the body lighting while the row is
   * open; Escape on the dial puts the row away (onKeyActivate). A tap on the
   * lit body brings its row back on screen (#1319: the belt it used to lift
   * into retired). The relay's catch, tapped again, does what its row's
   * `review & amend →` does (round 3 §4).
   * @param {DialBody} b
   */
  async function tapBody(b) {
    const again = lit === b.id;
    if (!(await openRow(b.id)) || !again || !b.suggestion) return;
    const suggested = view?.suggestions.find((one) => one.id === b.id);
    if (suggested) startAmend(suggested);
  }
  /* A press on the lit body must not close its row on the way down (row.js
     closes an open row on any press outside it), or the tap would close the
     drawer it is about to bring back on screen. Registered before any row
     opens, so it hears the press first. */
  $effect(() => {
    /** @param {PointerEvent} event */
    const onpress = (event) => {
      const body = event.target instanceof Element ? event.target.closest(".pocket .mdial [data-body]") : null;
      if (body && lit && body.getAttribute("data-body") === lit) event.stopImmediatePropagation();
    };
    addEventListener("pointerdown", onpress, true);
    return () => removeEventListener("pointerdown", onpress, true);
  });
  /** Between the meta line's parts. */
  const SEP = " · ";
  /** A row's section, for its colour (option-colour.js). @param {string} id */
  const sectionOf = (id) => sections.find((one) => one.id === rawItems.get(id)?.sectionId) ?? null;
  /** @type {(id: string) => typeof searchDocuments} */
  const papersOf = (id) => searchDocuments.filter((doc) => doc.itemId === id);

  /* ---- #1319: a paper in a drawer opens the preview as the bottom sheet ----
     design/v19/belt-purpose/round-3 (F), scene `narrow`: the desk's preview
     card (PreviewCard.svelte), which under 1200px is the phone's bottom
     sheet; its page opens the reader over home. Escape or a press off it
     puts it away and leaves the row open. */
  /** @type {any} */
  let previewPaper = $state(null);
  /** @type {HTMLElement | null} */
  let previewFrom = null;
  /** @param {any} paper @param {HTMLElement} from */
  function openPaperHere(paper, from) {
    /* one sheet at a time: a paper's preview puts a chooser away */
    modes.closeChooser(false);
    previewFrom = from;
    if (previewPaper?.id !== paper.id) previewPaper = paper;
  }
  /** @param {{ refocus: boolean }} how */
  function closePaper({ refocus }) {
    previewPaper = null;
    if (refocus && previewFrom?.isConnected) previewFrom.focus({ preventScroll: true });
  }
  /** The papers again, after one was removed or restored from the sheet. */
  async function rereadPapers() {
    searchDocumentsFor = null;
    papersReady = false;
    await loadSearchDocuments();
  }
  /** @param {{ id: string, name: string }} paper */
  async function removePaper(paper) {
    await removeDocument(paper.id);
    previewPaper = null;
    await rereadPapers();
    wake(`${paper.name} removed`, {
      undo: () => { restoreDocument(paper.id).then(rereadPapers).catch(() => {}); },
    });
  }
  /** @param {{ id: string }} paper */
  async function restorePaper(paper) {
    await restoreDocument(paper.id);
    previewPaper = null;
    await rereadPapers();
  }
  /* A row closing takes its paper's sheet with it. */
  $effect(() => {
    if (previewPaper && lit !== previewPaper.itemId) previewPaper = null;
  });

  /* A completion a previous visit held and never saw confirmed (#1151
     W1-S3): the belt and stage 1's drawer held a completion for the wake's
     four seconds and stashed it first, under the same literal key as the
     belt's own (W1-R5; the belt retired with #1319). #1319 stage 2: the drawer now
     asks for the completion in its rows and records it at once, so nothing
     is held here any more; what an earlier visit stashed is still picked up
     on load and finished. */
  const HELD_COMPLETION_KEY = "orbit:pending-completion";
  /* A list, not one slot: completing a second item inside the first's undo
     window sends the first at once, and its send can still fail or answer
     late. One slot lost the first (overwritten) or the second (cleared by
     the first's late success). Each entry leaves on its own send only. */
  /** @returns {object[]} */
  function readHeldCompletionStash() {
    try {
      const raw = localStorage.getItem(HELD_COMPLETION_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [parsed.command].filter(Boolean);
    } catch {
      return [];
    }
  }
  /** @param {object[]} commands */
  function writeHeldCompletionStash(commands) {
    try {
      if (commands.length === 0) localStorage.removeItem(HELD_COMPLETION_KEY);
      else localStorage.setItem(HELD_COMPLETION_KEY, JSON.stringify(commands));
    } catch { /* best effort */ }
  }
  /** @param {object} command */
  function clearHeldCompletionStash(command) {
    const key = JSON.stringify(command);
    writeHeldCompletionStash(readHeldCompletionStash().filter((one) => JSON.stringify(one) !== key));
  }
  /** A completion stashed by a previous visit that never confirmed it sent
      (#1151 W1-S3): picked up here instead of staying lost with nothing
      said. A version conflict means somebody already holds this change —
      most likely the original send landing after all — so that alone is
      treated as the stash's own success. Runs once, on mount: nothing it
      reads is reactive state. */
  $effect(() => {
    for (const command of readHeldCompletionStash()) applyCommand(command).then(async () => {
      clearHeldCompletionStash(command);
      await onchanged?.();
    }).catch((error) => {
      if (error instanceof WorkspaceError && error.code === "version_conflict") {
        clearHeldCompletionStash(command);
        onchanged?.();
        return;
      }
      wake(/** @type {{ message?: string }} */ (error)?.message ?? "couldn't complete it — try again", { failure: true });
    });
  });

  /* `copy link`: the item's address, the desk's (+page.svelte addressOf),
     the chain-link icon at the drawer's foot (#1319). */
  /** @param {string} id @returns {Promise<boolean>} */
  async function copyLink(id) {
    try {
      await navigator.clipboard.writeText(new URL(`/home?item=${encodeURIComponent(id)}`, location.origin).href);
      return true;
    } catch {
      /* A refused clipboard is no error worth a word: the address still works. */
      return false;
    }
  }

  /* ---- #1319: THE DRAWER'S FOOT ROW (FootRow.svelte), as the desk's ----
     The row's own acts (`open →`, `complete`) and its `copy link` line are
     gone: the drawer is the item, and its foot holds every act the belt had
     -- snooze, complete, attach a document, retire -- with the pencil and
     the chain link at its right end. */
  /** @type {{ id: string, kind: "snooze" | "attach" | "retire" | "restore" | "complete" } | null} */
  let footBusy = $state(null);
  /**
   * @param {{ id: string, title: string }} one
   * @param {"snooze" | "retire" | "restore"} kind
   * @param {(item: any) => object} build
   * @param {string} words
   */
  async function runRowAct(one, kind, build, words) {
    const raw = rawItems.get(one.id);
    const householdId = view?.primary;
    if (!raw || !householdId || footBusy) return;
    footBusy = { id: one.id, kind };
    delete rowProblem[one.id];
    try {
      await applyCommand(build({ ...raw, householdId }));
      wake(words);
      await onchanged?.();
    } catch (error) {
      rowProblem[one.id] = /** @type {{ message?: string }} */ (error)?.message ?? `couldn't ${kind} it — try again`;
    } finally {
      footBusy = null;
    }
  }
  /** @param {{ id: string, title: string }} one @param {File} file */
  async function attachTo(one, file) {
    const householdId = view?.primary;
    if (!householdId || footBusy) return;
    footBusy = { id: one.id, kind: "attach" };
    delete rowProblem[one.id];
    try {
      await attachItemDocument(householdId, one.id, file, crypto.randomUUID());
      wake(`${file.name} attached`);
      await Promise.all([rereadPapers(), onchanged?.()]);
    } catch (error) {
      rowProblem[one.id] = /** @type {{ message?: string }} */ (error)?.message ?? "couldn't attach it — try again";
    } finally {
      footBusy = null;
    }
  }
  /* ---- #1319 stage 2: EDITING IN THE ROWS, AND THE CHOOSER SHEET --------
     design/v19/belt-purpose/round-8/m-colour-per-option.html, the `narrow-`
     scenes: as the desk's drawer (home/+page.svelte), with the chooser card
     as the bottom sheet, where the preview's sheet stands. */
  const modes = new DrawerModes({
    save: async (item, edits) => {
      if (item.status === "suggested") { await addSuggestion(item, edits); return; }
      await applyCommand(upsertCommand(item, edits));
      await onchanged?.();
    },
    onchoose: () => { previewPaper = null; },
  });
  /* The sections of the household the open item is in, or a suggestion
     being amended will file into. */
  const sections = $derived.by(() => {
    const amended = view?.suggestions.find((one) => one.id === modes.id);
    const householdId = amended ? (amended.householdId ?? view?.primary) : null;
    return (householdId ? view?.households?.find((one) => one.id === householdId)?.sections : null)
      ?? view?.household?.sections ?? [];
  });
  /* .by: read at the top level, `view` would be narrowed to its default. */
  const chooserAsk = $derived.by(() => (view ? modes.askOf(sections, view.today) : null));
  /* A row closing, or another opening, ends whatever its drawer was doing. */
  $effect(() => {
    const id = modes.id;
    if (!id || lit === id) return;
    /* #1319: a row closing with changes in its rows opens again, the cancel
       pill armed ("discard changes?"); closed again inside the hold, or
       with nothing changed, it ends. */
    if (untrack(() => modes.cancel())) modes.end();
    else untrack(() => openRow(id));
  });
  /** The item as a command addresses it. @param {string} id @returns {any} */
  const commandItemOf = (id) => {
    const raw = rawItems.get(id);
    return raw && view?.primary ? { ...raw, householdId: view.primary } : null;
  };
  /** Focus a control in a row's drawer, once it is drawn. @param {string} id @param {string} selector */
  async function focusInRow(id, selector) {
    await tick();
    const el = /** @type {HTMLElement | null} */ (manifestRow(id)?.querySelector(selector) ?? null);
    el?.focus({ preventScroll: true });
    if (el?.isContentEditable) getSelection()?.collapse(el, el.childNodes.length);
  }
  /** The chooser's pick: the row takes it, or the snooze is sent. @param {string} value */
  function pickChoice(value) {
    const snooze = modes.pick(value);
    if (!snooze || !view) return;
    const { item, until } = snooze;
    /* Whether the day will do is the engine's (#1325): its refusal lands
       in rowProblem, in its words. */
    /* #1319: the pills are disabled while it is sent, which drops the focus
       the sheet handed back; put it back on the pill once they are live,
       inside the row, so the row's own Escape still closes it. */
    runRowAct(item, "snooze", (one) => snoozeCommand(one, until), `${item.title} snoozed until ${short(until)}`)
      .then(() => { if (lit === item.id) focusInRow(item.id, '[aria-label^="Snooze "]'); });
  }
  /** @param {{ id: string, title: string }} one */
  async function saveRow(one) {
    const title = modes.edit.draft?.title.trim() ?? one.title;
    if (await modes.edit.commit()) {
      wake(`saved · ${title}`);
      focusInRow(one.id, ".ivedit");
    }
  }
  /* Complete records what the rows hold: the date, the cost and the notes.
     The next due date is the engine's (#1324), read back from its reply. */
  /** @param {{ id: string, title: string }} one */
  async function recordRow(one) {
    const out = modes.completion();
    if ("refusal" in out) { modes.completeProblem = out.refusal; return; }
    if (footBusy) return;
    const { item, fields } = out;
    footBusy = { id: one.id, kind: "complete" };
    modes.completeProblem = null;
    try {
      const nextDate = dueDateIn(await applyCommand(completeCommand(item, fields)), item.householdId, item.id);
      modes.cancelComplete();
      wake(`Completed${nextDate ? ` · next due ${short(nextDate)}` : ""} · ${one.title}`);
      await onchanged?.();
    } catch (error) {
      modes.completeProblem = /** @type {{ message?: string }} */ (error)?.message ?? "couldn't complete it — try again";
    } finally {
      footBusy = null;
    }
  }
  /* Escape: the chooser first, then the edit or the completion, ahead of
     the row's own Escape (row.js), which closes the row. */
  $effect(() => {
    const id = modes.id;
    if (!id) return;
    /** @param {KeyboardEvent} event */
    const onKey = (event) => {
      if (event.key !== "Escape" || event.defaultPrevented || previewPaper) return;
      const chooser = modes.choosing;
      const editing = Boolean(modes.edit.id);
      if (!modes.escape()) return;
      event.preventDefault();
      event.stopPropagation();
      if (!chooser && !modes.id) focusInRow(id, editing ? ".ivedit, [data-amend]" : '[aria-label^="Complete "]');
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  /* #1319: the chooser sheet is modal. While it stands, everything behind
     it is inert (focus.js's inertPage, the kit's sheets' own pattern), so
     nothing it covers takes a tap; when it goes, the page comes back first
     and focus goes back to the value that was pressed (the close asked for
     that while the page was still inert, where it could not land). */
  /** @param {HTMLElement} seat @param {HTMLElement | null} from */
  function holdChooserSeat(seat, from) {
    let opener = from;
    const restore = inertPage(seat);
    return {
      /** @param {HTMLElement | null} next */
      update(next) { if (next) opener = next; },
      destroy() {
        const lost = !document.activeElement || document.activeElement === document.body || seat.contains(document.activeElement);
        restore();
        if (lost && opener?.isConnected) opener.focus({ preventScroll: true });
      },
    };
  }
  /* A press off the chooser sheet puts it away: on its scrim (inside the
     seat, so this leaves it to the scrim's own click), or anywhere else
     still live, the wake's undo say. */
  $effect(() => {
    if (!modes.choosing) return;
    /** @param {PointerEvent} event */
    const onPress = (event) => { if (!pressKeepsChooser(event.target)) modes.closeChooser(false); };
    window.addEventListener("pointerdown", onPress, true);
    return () => window.removeEventListener("pointerdown", onPress, true);
  });

  /** @param {{ id: string, title: string }} one @returns {import('./drawer-acts.js').DrawerActs} */
  const drawerActsOf = (one) => ({
    busy: footBusy?.id === one.id ? footBusy.kind : modes.edit.busy && modes.edit.id === one.id ? "save" : null,
    problem: modes.id === one.id ? modes.edit.problem ?? modes.edit.refusal ?? modes.completeProblem : null,
    modes,
    sections,
    onsnooze: (from) => {
      const item = commandItemOf(one.id);
      delete rowProblem[one.id];
      if (item) modes.snooze(item, from);
    },
    oncomplete: () => {
      const item = commandItemOf(one.id);
      if (!item || !view) return;
      delete rowProblem[one.id];
      modes.startComplete(item, view.today);
      focusInRow(one.id, "[data-pick]");
    },
    onedit: () => {
      const item = commandItemOf(one.id);
      if (!item) return;
      delete rowProblem[one.id];
      modes.startEdit(item);
      focusInRow(one.id, '[data-ed="title"]');
    },
    onsave: () => saveRow(one),
    onrecord: () => recordRow(one),
    oncancel: () => {
      const editing = Boolean(modes.edit.id);
      /* rows holding changes: the first press arms "discard changes?" */
      if (!modes.cancel()) return;
      focusInRow(one.id, editing ? ".ivedit" : '[aria-label^="Complete "]');
    },
    onattach: (file) => attachTo(one, file),
    onretire: () => runRowAct(one, "retire", (item) => archiveCommand(item), `${one.title} retired`),
    onrestore: () => runRowAct(one, "restore", (item) => statusCommand(item, "active"), `${one.title} restored`),
    oncopy: () => copyLink(one.id),
  });
  /** The relay's catch, decided from its row. @param {import('$lib/data/workspace.js').ReceiptSuggestion} s @returns {import('$lib/pocket/row.js').RowAct[]} */
  const suggestionActs = (s) => [
    { label: "Add to orbit", name: `Add ${s.title} to your orbit`, tone: "filled", arms: true, onact: () => decide("approve", s) },
    { label: "Dismiss", name: `Dismiss ${s.title}`, danger: true, onact: () => decide("dismiss", s) },
  ];

  // Keyboard (§2.4): ↓ from the field walks into the results, ↑ and ↓ move
  // through them, ↑ from the first goes back to the field, Enter in the field
  // takes the first result. Escape is the sheet's own.
  /** @type {HTMLElement | undefined} */
  let resultList = $state();
  /* The results, then the top match's act in the sheet's foot. */
  const resultStops = () =>
    /** @type {HTMLElement[]} */ ([
      ...(resultList?.querySelectorAll("[data-row-face]") ?? []),
      ...document.querySelectorAll(".p-sheet-layer.open .pk-act"),
    ]);
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
  /** The dial square the north star rests in (round 3 §5). @type {HTMLElement | null} */
  let dialBox = $state(null);
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
    setTimeout(() => goto(resolve("/household/[id]", { id })).finally(() => { flying = null; }), 620);
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
<!-- #1120: the pocket's one main landmark and its one h1, as the desk's
     `.desk` role=main and sr-only h1 are; the section heads under it are h2. -->
<main class="mpage">
  <h1 class="sr-only">Orbit</h1>
  {#if view?.emptySky}
  <!-- §11 (#453): the pocket's labelled sky is a list — each system a ring
       and a name, nothing else. Tapping asks; asking rides data attributes
       that +page.svelte binds, the same ask the desk's labelled sky raises. -->
  <div class="mgroup adrift"><h2 class="p-caps">Systems around you</h2>
    {#each Object.entries(view.galaxy) as [id, hh] (id)}
      <div class="mitem askrow" data-ask={id} data-ask-name={hh.name} data-ask-requested={String(Boolean(hh.requested))}>
        <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="10" fill="none" stroke="var(--line)"/><circle cx="13" cy="13" r="2.4" style="fill:var(--ink-mid)"/></svg>
        <div class="flex"><b>{hh.name}</b><span>{hh.requested ? "asked to join · waiting" : "tap to ask to join"}</span></div>
      </div>
    {/each}
    <!-- #840: the create card this leads to only ever appears at / (the
         arrival), not on /create's full form -- there is no household yet
         for that form to write into while the sky is empty. -->
    <!-- Round 3 §3.1: the rows already say "tap to ask to join". -->
    <div class="pk-own"><a href={resolve("/")}>— or start your own system →</a></div>
  </div>
  {:else}
  <!-- `arrive` is the desk's own arrival flag (+page.svelte): a forward
       arrival, never a Back, and never under the launch's own landing. -->
  <!-- The dial square, and in its bottom-right corner the north star's rest
       station (round 3 §5). A wrapper, so the dial's own arrival and flight
       transforms never carry the star. -->
  <div class="pk-dialbox" bind:this={dialBox}>
  <div class="mdial" class:arrive bind:this={dialEl} style:--fx="{flight.x}px" style:--fy="{flight.y}px">
    <svg viewBox="0 0 380 380">
      <!-- The desk's spheres and danger wash (+page.svelte's dial defs),
           named for the pocket: the desk's own defs share this document. -->
      <defs aria-hidden="true">
        <radialGradient id="pk-ruby" cx="34%" cy="30%" r="72%">
          <stop offset="0%" stop-color="var(--p-ruby-1, #ffb3ab)"/><stop offset="42%" stop-color="var(--p-ruby-2, #e0453e)"/>
          <stop offset="100%" stop-color="var(--p-ruby-3, #7e1a1f)"/>
        </radialGradient>
        <radialGradient id="pk-jade" cx="34%" cy="30%" r="72%">
          <stop offset="0%" stop-color="var(--p-jade-1, #b8f5cf)"/><stop offset="45%" stop-color="var(--p-jade-2, #2fae6a)"/>
          <stop offset="100%" stop-color="var(--p-jade-3, #12603a)"/>
        </radialGradient>
        <radialGradient id="pk-amber" cx="34%" cy="30%" r="72%">
          <stop offset="0%" stop-color="var(--p-amber-1, #ffe1a0)"/><stop offset="45%" stop-color="var(--p-amber-2, #f0a52b)"/>
          <stop offset="100%" stop-color="var(--p-amber-3, #8a5a10)"/>
        </radialGradient>
        <radialGradient id="pk-sky" cx="34%" cy="30%" r="72%">
          <stop offset="0%" stop-color="var(--p-sky-1, #cfe4ff)"/><stop offset="45%" stop-color="var(--p-sky-2, #6fa3ef)"/>
          <stop offset="100%" stop-color="var(--p-sky-3, #2a4f8f)"/>
        </radialGradient>
        <radialGradient id="pk-danger4" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#f87171" stop-opacity=".10"/>
          <stop offset="55%" stop-color="#f87171" stop-opacity=".035"/>
          <stop offset="85%" stop-color="#f87171" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <circle cx="190" cy="190" r="150" fill="none" stroke="var(--line)" stroke-width="1.5"/>
      <g stroke="var(--line)" stroke-width="1.5" aria-hidden="true">
        {#each TICKS as t, k (k)}<line x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}/>{/each}</g>
      <circle cx="190" cy="190" r="62" fill="url(#pk-danger4)"/>
      <circle cx="190" cy="190" r="62" fill="none" stroke="var(--overdue)" stroke-opacity=".3"
              stroke-width="1" stroke-dasharray="3 5"/>
      <!-- Quarter labels at 15 units: 13px at the narrowest dial (§2.1). -->
      <g font-size="15" fill="var(--ink-quiet)" text-anchor="middle" font-family="JetBrains Mono,monospace">
        {#each quarters as q, k (k)}<text x={q.x} y={q.y}>{q.label}</text>{/each}</g>
      <path d="M190 38 l6 10 h-12 Z" style="fill:var(--accent)"/>
      <!-- The sun (#1250): drawn by the layer over the dial (Sun.svelte, the
           Furnace, in the pack's own colours, #1259); this is its disc, which
           the tour marks, and the household's name beneath it. -->
      <circle class="pk-sun" cx="190" cy="190" r={POCKET_SUN_R} fill="transparent"/>
      <text x="190" y="218" font-size="15" text-anchor="middle" style="fill:var(--ink-mid);font-family:var(--ui)">{view?.household?.name ?? ""}</text>
      {#if pinging}
        <circle class="pk-ping" cx={pinging.placement.x} cy={pinging.placement.y} r={bodyR(pinging) + 3} fill="none"
                stroke="currentColor" stroke-opacity=".7" style:color={bodyColour(pinging)} aria-hidden="true"/>
      {/if}
      {#each pocketBodies as b (b.id)}
        <!-- #1129/§1.7: the drawn body keeps its size; an invisible 44px
             circle round it takes the tap, and the spacing law keeps every
             such circle clear of its neighbours. -->
        {#if b.suggestion}
          <!-- #466: the relay's catch is ON the dial at its law position —
               the same hollow accent body the desk shows (§12). -->
          <g class="pk-body" class:lit={lit === b.id} data-body={b.id} data-body-sugg tabindex="0" role="button"
             aria-label={`caught receipt: ${b.title}`}
             onclick={() => tapBody(b)} onkeydown={(event) => onKeyActivate(event, () => tapBody(b))}>
            <circle cx={b.placement.x} cy={b.placement.y} r="8.5" style="fill:none;stroke:var(--accent);stroke-width:1.8"/>
            <circle cx={b.placement.x} cy={b.placement.y} r="6" style="fill:var(--accent)" opacity=".12"/>
            {#if lit === b.id}<circle class="pk-lit" cx={b.placement.x} cy={b.placement.y} r="12.5"/>{/if}
            <circle class="hit" cx={b.placement.x} cy={b.placement.y} r={HIT_R}/>
          </g>
        {:else}
          <!-- data-papers: how many documents ride with this body, for the
               first-run film's belt chapter (#1174), which opens a body that
               carries some; one attribute, no style change (as pk-sun). -->
          <g class="pk-body" class:lit={lit === b.id} data-body={b.id} data-papers={b.documentCount} tabindex="0" role="button" aria-label={b.title}
             onclick={() => tapBody(b)} onkeydown={(event) => onKeyActivate(event, () => tapBody(b))}>
            <circle cx={b.placement.x} cy={b.placement.y} r={bodyR(b)} style="fill:{bodyFill(b)}"/>
            {#if lit === b.id}<circle class="pk-lit" cx={b.placement.x} cy={b.placement.y} r={bodyR(b) + 4}/>{/if}
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
    <Sun r={POCKET_SUN_R} />
  </div>
  <NorthStar docked anchor={dialBox} hidden={starHidden} />
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
  <div class="pk-below" class:pk-busy={busy}>
  <!-- One item's row: the manifest's, or the one asked for (`asked`). -->
  {#snippet itemRow(/** @type {any} */ one)}
    <!-- #1319 stage 2 (round 8): while the item is edited, its title is
         live in the row's head, as on the desk -->
    {#snippet liveTitle()}{#if modes.edit.draft}<b class="ed" contenteditable="plaintext-only" spellcheck="false" role="textbox" tabindex="0"
       aria-label="title" data-ed="title" bind:textContent={modes.edit.draft.title}></b>{/if}{/snippet}
    <Row title={one.title} meta={[one.section, one.state, cost(one)].filter(Boolean).join(" · ")} key={one.id}
         heading={modes.edit.id === one.id ? liveTitle : undefined}
         trail={tlabel(one)} trailSub={one.dueDate ? short(one.dueDate) : ""} trailTone="var({BAND_VAR[one.band]})"
         ontoggle={onRowToggle(one.id)}>
      <!-- round 8 (#1319): the section word in its own colour -->
      {#snippet metaline()}{#if one.section}<i class="opt" data-opt={sectionColourOf(sectionOf(one.id))}>{one.section}</i>{#if one.state || cost(one)}{SEP}{/if}{/if}{#if one.state}{one.state}{#if cost(one)}{SEP}{/if}{/if}{cost(one)}{/snippet}
      {#snippet mark()}<span class="pk-dot" style:background="var({BAND_VAR[one.band]})"></span>{/snippet}
      {#snippet detail()}
        <ItemDrawer {one} raw={rawItems.get(one.id)} papers={papersOf(one.id)} problem={rowProblem[one.id] ?? null}
                    showingPaper={previewPaper?.id ?? null} onopenpaper={openPaperHere}
                    acts={drawerActsOf(one)}
                    reading={!papersReady && (rawItems.get(one.id)?.documentCount ?? 0) > 0} />
      {/snippet}
    </Row>
  {/snippet}
  {#if groups?.attention.length}
    <h2 class="p-caps">Needs attention</h2>
    <div class="pk-list" data-row-group data-row-cards>
      {#each askedRow ? byDate([...groups.attention, askedRow]) : groups.attention as one (one.id)}
        {@render itemRow(one)}
      {/each}
    </div>
  {:else if groups?.later.length}
    {@const next = groups.later[0]}
    {#snippet liveTitle()}{#if modes.edit.draft}<b class="ed" contenteditable="plaintext-only" spellcheck="false" role="textbox" tabindex="0"
           aria-label="title" data-ed="title" bind:textContent={modes.edit.draft.title}></b>{/if}{/snippet}
    <h2 class="p-caps">Needs attention</h2>
    <!-- Nothing needs you: the one row is the next item up, and opens as it. -->
    <div class="pk-list" data-row-group data-row-cards>
      <Row title="nothing needs you" meta={`next up ${next.title}${next.days !== null ? `, ${tlabel(next)}` : ""}`} key={next.id}
           heading={modes.edit.id === next.id ? liveTitle : undefined}
           ontoggle={onRowToggle(next.id)}>
        {#snippet mark()}<span class="pk-dot quiet"></span>{/snippet}
        {#snippet detail()}
          <ItemDrawer one={next} raw={rawItems.get(next.id)} papers={papersOf(next.id)} problem={rowProblem[next.id] ?? null}
                      showingPaper={previewPaper?.id ?? null} onopenpaper={openPaperHere}
                      acts={drawerActsOf(next)}
                      reading={!papersReady && (rawItems.get(next.id)?.documentCount ?? 0) > 0} />
        {/snippet}
      </Row>
      {#if askedRow}{@render itemRow(askedRow)}{/if}
    </div>
  {/if}
  <!-- #466; round 3 §2 and owner-decisions §29 (#1142): 32px of clear sky
       below the manifest, a caps head, then each signal as its own row-card
       as the desk seats a suggestion (#1145): dashed at rest, the thin solid
       accent outline open, no rail. A suggestion row opens in place with
       its readings and its two decisions. Reading and failed mail are the
       inbox's matter: at most one summary row, last, goes there (owner's
       answer 12a). -->
  {#if view && (view.suggestions.length || mailSummary)}
    <section class="pk-signals" aria-labelledby="pk-signals-h">
      <h2 class="p-caps" id="pk-signals-h">Signals{#if view.suggestions.length}<span class="p-count">{view.suggestions.length}</span>{/if}</h2>
      <div class="pk-pen" data-row-group data-row-cards>
        {#each view.suggestions as s (s.id)}
          {@const amending = modes.edit.id === s.id}
          <!-- #1319: while amended, the title is live in the row's head and
               `add to orbit` / `cancel` (SuggestionDrawer) replace the two
               decisions -->
          {#snippet liveTitle()}{#if modes.edit.draft}<b class="ed" contenteditable="plaintext-only" spellcheck="false" role="textbox" tabindex="0"
             aria-label="title" data-ed="title" bind:textContent={modes.edit.draft.title}></b>{/if}{/snippet}
          <Row title={s.title} key={s.id}
               heading={amending ? liveTitle : undefined}
               meta={burnsIn(s) !== null ? `burns up in ${burnsIn(s)}d` : ""}
               trail={s.costMinor ? money(s.costMinor, s.currency, true) : ""}
               trailSub={s.renewsOn ? `${dateWord(s)} ${short(s.renewsOn)}` : ""} trailTone="var(--accent-text)"
               acts={amending ? [] : suggestionActs(s)} ontoggle={onRowToggle(s.id)}>
            {#snippet mark()}<span class="pk-dot hollow"></span>{/snippet}
            {#snippet detail()}<SuggestionDrawer suggestion={s} problem={rowProblem[s.id] ?? null}
                                                  showingPaper={previewPaper?.id ?? null} onopenpaper={openPaperHere}
                                                  acts={amendActsOf(s)} />{/snippet}
            {#snippet after()}
              {#if s.receiptId && !reviewLockedOf(s) && !amending}
                <button class="p-quiet" data-amend onclick={() => startAmend(s)}>review &amp; amend →</button>
              {/if}
            {/snippet}
          </Row>
        {/each}
        {#if mailSummary}
          <Row title={mailSummary} meta="inbox →" href={resolve("/inbox")} key="mail">
            {#snippet mark()}<span class="pk-dot {view.mailReading.length ? 'breathing' : 'failed'}"></span>{/snippet}
          </Row>
        {/if}
      </div>
    </section>
  {/if}
  </div>
  {/if}
</main>
</div>

<Sheet bind:open={sheetOpen} size="list" title="Search your orbit" hideTitle>
  <!-- The search field rides in the sheet's head (§2.4). Declared in here
       rather than at the top of the markup: a top-level snippet trips the
       production bundler (#1130). -->
  {#snippet head()}
    <input class="pk-field" type="search" placeholder="explore your world" aria-label="Search your orbit"
           autocomplete="off" enterkeyhint="go" bind:value={query} onkeydown={fieldKey}>
  {/snippet}
  <!-- #1057's phone half (§2.4; phone-search round 1, B). -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="pk-results" class:pk-busy={busy} bind:this={resultList} onkeydown={listKey}>
    {#if !results.query}
      {#each results.items as one (one.id)}
        <Row title={one.title} meta={[one.section, cost(one)].filter(Boolean).join(" · ")}
             trail={tlabel(one)} trailSub={one.dueDate ? short(one.dueDate) : ""} trailTone="var({BAND_VAR[one.band]})"
             onactivate={() => openResult(one.id)}>
          {#snippet mark()}<span class="pk-dot" style:background="var({BAND_VAR[one.band]})"></span>{/snippet}
        </Row>
      {/each}
      <Row title="→ add an item" href={resolve("/create")} />
    {:else if results.nothing}
      <p class="p-empty">nothing in your orbit is called “{results.query}”</p>
      <!-- #1120: the name rides along; /create's pocket reads ?name= (§2.5). -->
      <Row title={`add “${results.query}” as an item`}
           href={`${resolve("/create")}?${new URLSearchParams({ name: results.query })}`}>
        {#snippet mark()}<span class="pk-plus" aria-hidden="true">+</span>{/snippet}
      </Row>
    {:else}
      {#each results.items as one (one.id)}
        <Row title={one.title} meta={[one.section, cost(one)].filter(Boolean).join(" · ")}
             trail={tlabel(one)} trailSub={one.dueDate ? short(one.dueDate) : ""} trailTone="var({BAND_VAR[one.band]})"
             onactivate={() => openResult(one.id)}>
          {#snippet mark()}<span class="pk-dot" style:background="var({BAND_VAR[one.band]})"></span>{/snippet}
        </Row>
      {/each}
      {#each results.documents as doc (doc.id)}
        <!-- Round 3 §8: the item alone; the paper's date is its own sheet's. -->
        <Row title={doc.name} meta={doc.itemTitle} onactivate={() => openPaper(doc)}>
          {#snippet mark()}<span class="pk-paper" aria-hidden="true">◆</span>{/snippet}
        </Row>
      {/each}
    {/if}
    {#if problem}<p class="p-error" role="alert">{problem}</p>{/if}
  </div>
  <!-- Every act in the sheet's pinned foot (review round §1.2). -->
  {#snippet foot()}
    {#if results.query && !results.nothing && results.complete}
      {@const top = results.complete}
      <!-- The one accent action for the top match (§2.4). Wrapped rather
           than passed a disabled prop ArmButton has no concept of (#1151
           W1-R8): dims and stops taking taps while any row act (or this
           one) is already in flight, sharing the same `busy` flag. -->
      <span class:pk-foot-busy={busy}>
        <ArmButton label={`→ complete “${top.title}”`} armedLabel="tap again to complete" danger={false} wide
                   class="pk-act" onfire={() => complete(top)} />
      </span>
    {/if}
  {/snippet}
</Sheet>

<Hatch bind:open={hatchOpen} name={view?.user?.displayName ?? ""} {roleLine} {isAdmin}
       inboxCount={waiting || null} {onsignedout} onopened={onmenu} />

<PreviewCard doc={previewPaper} itemTitle={previewPaper?.itemTitle ?? ""} onclose={closePaper}
             onremove={removePaper} onrestore={restorePaper} />

<!-- #1319 stage 2 (round 8, `narrow-editing-*`): the chooser card as the
     bottom sheet, where the preview's sheet stands -->
{#if chooserAsk}
  <div class="pk-chseat" data-chooser-card use:holdChooserSeat={modes.choosingFrom}>
    <!-- The scrim is a pointer's dismiss, clear so the page reads through
         it: it takes the press, so the tap that puts the sheet away never
         lands on the page behind as well. Escape and close · esc are the
         keyboard's, so it needs no key handler of its own. -->
    <div class="pk-chscrim" aria-hidden="true" onclick={() => modes.closeChooser(false)}></div>
    <ChooserCard ask={chooserAsk} layout="sheet" onpick={pickChoice} onclose={() => modes.closeChooser(true)} />
  </div>
{/if}


