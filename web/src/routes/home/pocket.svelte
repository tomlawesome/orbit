<script>
  import "./pocket.css";
  import { tick } from "svelte";
  import { beforeNavigate, goto, onNavigate } from "$app/navigation";
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import { applyCommand, readItemDocuments } from "$lib/data/workspace.js";
  import { completeCommand, nextDateAfter } from "$lib/data/commands.js";
  import { dialBodiesOf, daysUntil, hashId, manifestGroupsOf } from "$lib/data/chart.js";
  import { ago, every, longDate, money } from "$lib/format.js";
  import ArmButton from "$lib/pocket/ArmButton.svelte";
  import Hatch from "$lib/pocket/Hatch.svelte";
  import NorthStar from "$lib/pocket/NorthStar.svelte";
  import Row from "$lib/pocket/Row.svelte";
  import Sheet from "$lib/pocket/Sheet.svelte";
  import TopChrome from "$lib/pocket/TopChrome.svelte";
  import { POCKET_QUERY, isPocket } from "$lib/pocket/media.js";
  import { rowOf } from "$lib/pocket/row.js";
  import { WAKE_HOLD_MS, wake } from "$lib/pocket/wake.js";
  import { markDoor } from "../household/[id]/door.js";
  import { HIT_R, spacedBodies } from "./pocket-dial.js";
  import { searchPocket } from "./pocket-search.js";
  import ItemDrawer from "./ItemDrawer.svelte";
  import SuggestionDrawer from "./SuggestionDrawer.svelte";

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
   * THE ROW IS THE ITEM (review round §2.1, the desk's own grammar, #424):
   * a manifest row opens in place into a drawer holding the item's detail,
   * `open →` onward to its belt, `complete`, and `copy link`; the relay's
   * catch opens the same way with its readings and its two decisions. A
   * search result closes the search and opens its row.
   *
   * One sheet, several faces: the search sheet (#1057), and, for the dial
   * only, the item sheet (#1119) with its documents and the suggestion
   * sheet (#466). What a planet on the dial does is the owner's open
   * question 6 on #1120 (review-round.md §4), so the dial keeps raising
   * those sheets until it is answered; nothing else raises them. One
   * history entry, so Back always closes whatever is up. The hatch is its
   * own sheet, opened from the orb.
   * @typedef {{
   *   view?: import('$lib/data/workspace.js').HomeView | null,
   *   arrive?: boolean,
   *   onapprove?: (suggestion: import('$lib/data/workspace.js').ReceiptSuggestion) => Promise<string | null>,
   *   ondismiss?: (suggestion: import('$lib/data/workspace.js').ReceiptSuggestion) => Promise<string | null>,
   *   onchanged?: () => Promise<unknown>,
   * }} Props
   */
  /** @type {Props} */
  let { view = null, arrive = false, onapprove = undefined, ondismiss = undefined, onchanged = undefined } = $props();
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
  // The kit's mark and value tones (kit.css .p-body, .p-kv) for a band, and
  // the mark's face for a kind, the dial's chart key (chart.js dialBodiesOf).
  /** @type {Record<string, string>} */
  const TONE_CLASS = { overdue: "over", "due-soon": "soon", upcoming: "up", ok: "ok", ended: "ended" };
  /** @type {Record<string, string>} */
  const FACE_CLASS = { inspection: "ter", renewal: "con", expiry: "exp" };
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
  // The desk's spheres (review round §2.1): a body wears its paint's
  // gradient; the ended expiry keeps its quiet flat ink.
  const SPHERES = new Set(["ruby", "jade", "amber", "sky"]);
  /** @type {(b: DialBody) => string} */
  const bodyFill = (b) => (SPHERES.has(b.paint) ? `url(#pk-${b.paint})` : bodyColour(b));
  // The body due soonest (an overdue one is the soonest of all, as the
  // spacing law has it) pings, home.css's perihelion ping.
  const pinging = $derived(pocketBodies.find((b) => !b.suggestion) ?? null);
  // Twelve month ticks on the ring, 6 units long, from the top.
  const TICKS = Array.from({ length: 12 }, (_, k) => {
    const a = (k * Math.PI) / 6 - Math.PI / 2;
    const at = (/** @type {number} */ r) => [190 + Math.cos(a) * r, 190 + Math.sin(a) * r].map((v) => Math.round(v * 10) / 10);
    const [x1, y1] = at(150);
    const [x2, y2] = at(144);
    return { x1, y1, x2, y2 };
  });
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
  const sheetSize = $derived(face === "sugg" ? "callout" : "list");
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

  /**
   * The relay's catch, decided: from the dial's suggestion sheet, or from
   * its row in the signals (where a refusal stays under the row's readings).
   * @param {"approve" | "dismiss"} act
   * @param {import('$lib/data/workspace.js').ReceiptSuggestion | null} [target]
   */
  async function decide(act, target = suggestion) {
    const handler = act === "approve" ? onapprove : ondismiss;
    if (!target || !handler || busy) return;
    busy = true;
    problem = null;
    delete rowProblem[target.id];
    try {
      const failed = await handler(target);
      if (failed) {
        if (sheetOpen) problem = failed;
        else rowProblem[target.id] = failed;
        return;
      }
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
  let papersReady = $state(false);
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
    if (searchDocumentsFor === household) {
      searchDocuments = found.flat();
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

  // ---- the drawers (review round §2.1) ---------------------------------------

  /** What went wrong acting from a row, by the row's id. @type {Record<string, string>} */
  const rowProblem = $state({});

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
    const el = manifestRow(id);
    const control = rowOf(el);
    if (!el || !control) return false;
    control.open();
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
    if (focus) /** @type {HTMLElement | null} */ (el.querySelector("[data-row-face]"))?.focus({ preventScroll: true });
    return true;
  }

  /**
   * A search result closes the search and opens its row (§2.1). An item the
   * manifest does not draw (it lists what needs attention) has no row to
   * open, so it still raises its sheet.
   * @param {string} id
   */
  async function openResult(id) {
    if (!manifestRow(id)) { openItem(id); return; }
    sheetOpen = false;
    await tick();
    await openRow(id, { focus: true });
  }

  /* Arriving on an item's address (`copy link`, the desk's own): its row
     opens, once, as soon as the manifest has drawn it. */
  let addressed = false;
  $effect(() => {
    const id = page.url.searchParams.get("item");
    if (addressed || !id || !rows.length || !isPocket()) return;
    openRow(id).then((opened) => { addressed ||= opened; });
  });

  /* The papers in a drawer ride on the search's own read of them, made the
     first time any row opens rather than on every arrival. */
  /** @param {boolean} open */
  const onRowToggle = (open) => { if (open) loadSearchDocuments(); };
  const papersOf = (/** @type {string} */ id) => searchDocuments.filter((doc) => doc.itemId === id);

  /* `complete` from a drawer, as the belt does it (item/[[id]]/+page.svelte,
     tapComplete): an item with a cost to confirm goes to its belt with the
     record sheet up; one with nothing to record completes on the tap, held
     for the wake's four seconds so `undo` is a real undo, and sent at once
     if the page is left first. */
  /** @typedef {{ send: () => Promise<void>, timer: ReturnType<typeof setTimeout> | undefined, done: boolean }} HeldCompletion */
  /** @type {HeldCompletion | null} */
  let held = null;
  /** @param {{ id: string, title: string }} one */
  function completeRow(one) {
    const raw = rawItems.get(one.id);
    const householdId = view?.primary;
    if (!raw || !householdId || !view) return;
    if (raw.costMinor !== null && raw.costMinor !== undefined) {
      morphing = true;
      goto(resolve("/item/[[id]]", { id: encodeURIComponent(one.id) }), { state: { pocketAct: "complete" } });
      return;
    }
    sendHeld();
    const completedDate = view.today;
    const nextDate = nextDateAfter(completedDate, raw.recurrenceMonths) ?? undefined;
    /** @type {HeldCompletion} */
    const job = {
      done: false,
      timer: undefined,
      send: async () => {
        await applyCommand(completeCommand(/** @type {any} */ ({ ...raw, householdId }), { completedDate, nextDate }));
        await onchanged?.();
      },
    };
    job.timer = setTimeout(() => fireHeld(job), WAKE_HOLD_MS);
    held = job;
    wake(`Completed${nextDate ? ` · next due ${short(nextDate)}` : ""} · ${one.title}`, {
      undo: () => { clearTimeout(job.timer); job.done = true; if (held === job) held = null; },
    });
  }
  /** @param {HeldCompletion} job */
  async function fireHeld(job) {
    if (job.done) return;
    job.done = true;
    if (held === job) held = null;
    try {
      await job.send();
    } catch (error) {
      wake(/** @type {{ message?: string }} */ (error)?.message ?? "couldn't complete it — try again", { failure: true });
    }
  }
  function sendHeld() {
    const job = held;
    if (!job || job.done) return;
    clearTimeout(job.timer);
    job.done = true;
    held = null;
    job.send().catch(() => {});
  }
  beforeNavigate(() => { sendHeld(); });
  $effect(() => {
    addEventListener("pagehide", sendHeld);
    return () => { removeEventListener("pagehide", sendHeld); };
  });

  /* `copy link`: the item's address, the desk's (+page.svelte addressOf),
     the one place the pocket offers it. */
  /** @type {string | null} */
  let copied = $state(null);
  /** @param {string} id */
  async function copyLink(id) {
    try {
      await navigator.clipboard.writeText(new URL(`/home?item=${encodeURIComponent(id)}`, location.origin).href);
      copied = id;
    } catch {
      /* A refused clipboard is no error worth a word: the address still works. */
      copied = null;
    }
  }

  /** The acts in a manifest item's drawer. @param {{ id: string, title: string }} one @returns {import('$lib/pocket/row.js').RowAct[]} */
  const itemActs = (one) => [
    { label: "open →", name: `Open ${one.title}`, tone: "accent", onact: () => { morphing = true; },
      href: resolve("/item/[[id]]", { id: encodeURIComponent(one.id) }) },
    { label: "complete", name: `Complete ${one.title}`, tone: "ok", onact: () => completeRow(one) },
  ];
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
    <div class="burnup">the systems around you are labels until someone lets you in<br><a href={resolve("/")}>— or start your own system →</a></div>
  </div>
  {:else}
  <!-- `arrive` is the desk's own arrival flag (+page.svelte): a forward
       arrival, never a Back, and never under the launch's own landing. -->
  <div class="mdial" class:arrive bind:this={dialEl} style:--fx="{flight.x}px" style:--fy="{flight.y}px">
    <svg viewBox="0 0 380 380">
      <!-- The desk's spheres and danger wash (+page.svelte's dial defs),
           named for the pocket: the desk's own defs share this document. -->
      <defs aria-hidden="true">
        <filter id="pk-sun" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="5"/></filter>
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
      <!-- The sun (the desk's #sun, scaled): a soft glow that breathes under
           the core, and the household's name beneath it. -->
      <circle class="pk-glow" cx="190" cy="190" r="16" style="fill:#fff6e6" fill-opacity=".28" filter="url(#pk-sun)"/>
      <circle cx="190" cy="190" r="8" style="fill:#fff6e6"/>
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
          <g class="pk-body" data-sheet-sugg={b.id} tabindex="0" role="button" aria-label={`caught receipt: ${b.title}`}
             onclick={() => openSuggestion(b.id)} onkeydown={(event) => onKeyActivate(event, () => openSuggestion(b.id))}>
            <circle cx={b.placement.x} cy={b.placement.y} r="8.5" style="fill:none;stroke:var(--accent);stroke-width:1.8"/>
            <circle cx={b.placement.x} cy={b.placement.y} r="6" style="fill:var(--accent)" opacity=".12"/>
            <circle class="hit" cx={b.placement.x} cy={b.placement.y} r={HIT_R}/>
          </g>
        {:else}
          <g class="pk-body" data-sheet-title={b.title} tabindex="0" role="button" aria-label={b.title}
             onclick={() => openItem(b.id)} onkeydown={(event) => onKeyActivate(event, () => openItem(b.id))}>
            <circle cx={b.placement.x} cy={b.placement.y} r={bodyR(b)} style="fill:{bodyFill(b)}"/>
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
    <h2 class="p-caps">Needs attention</h2>
    <div class="pk-list" data-row-group>
      {#each groups.attention as one (one.id)}
        <Row title={one.title} meta={[one.section, cost(one)].filter(Boolean).join(" · ")} key={one.id}
             trail={tlabel(one)} trailSub={one.dueDate ? short(one.dueDate) : ""} trailTone="var({BAND_VAR[one.band]})"
             acts={itemActs(one)} ontoggle={onRowToggle}>
          {#snippet mark()}<span class="pk-dot" style:background="var({BAND_VAR[one.band]})"></span>{/snippet}
          {#snippet detail()}
            <ItemDrawer {one} raw={rawItems.get(one.id)} papers={papersOf(one.id)} problem={rowProblem[one.id] ?? null}
                        reading={!papersReady && (rawItems.get(one.id)?.documentCount ?? 0) > 0} />
          {/snippet}
          {#snippet after()}
            <button class="p-quiet pk-copy" onclick={() => copyLink(one.id)}>{copied === one.id ? "link copied" : "copy link"}</button>
          {/snippet}
        </Row>
      {/each}
    </div>
  {:else if groups?.later.length}
    {@const next = groups.later[0]}
    <h2 class="p-caps">Needs attention</h2>
    <!-- Nothing needs you: the one row is the next item up, and opens as it. -->
    <div class="pk-list" data-row-group>
      <Row title="nothing needs you" meta={`next up ${next.title}${next.days !== null ? `, ${tlabel(next)}` : ""}`} key={next.id}
           acts={itemActs(next)} ontoggle={onRowToggle}>
        {#snippet mark()}<span class="pk-dot quiet"></span>{/snippet}
        {#snippet detail()}
          <ItemDrawer one={next} raw={rawItems.get(next.id)} papers={papersOf(next.id)} problem={rowProblem[next.id] ?? null}
                      reading={!papersReady && (rawItems.get(next.id)?.documentCount ?? 0) > 0} />
        {/snippet}
        {#snippet after()}
          <button class="p-quiet pk-copy" onclick={() => copyLink(next.id)}>{copied === next.id ? "link copied" : "copy link"}</button>
        {/snippet}
      </Row>
    </div>
  {/if}
  <!-- #466: the pocket's signals — what the relay caught. A suggestion row
       opens in place with its readings and its two decisions (§2.1);
       failures speak the server's words. -->
  {#if view?.suggestions?.length || view?.mailReading?.length || view?.mailFailures?.length}
    <h2 class="p-caps">Signals — your relay caught</h2>
    <div class="pk-list" data-row-group>
      {#each view.suggestions as s (s.id)}
        <div class="pk-sugg">
          <Row title={s.title} key={s.id}
               meta={[`from ${s.sourceDocument}`, burnsIn(s) !== null ? `burns up in ${burnsIn(s)}d` : null].filter(Boolean).join(" · ")}
               trail={s.costMinor ? money(s.costMinor, s.currency, true) : ""}
               trailSub={s.renewsOn ? `${dateWord(s)} ${short(s.renewsOn)}` : ""} trailTone="var(--accent-text)"
               acts={suggestionActs(s)}>
            {#snippet mark()}<span class="pk-dot hollow"></span>{/snippet}
            {#snippet detail()}<SuggestionDrawer suggestion={s} problem={rowProblem[s.id] ?? null} />{/snippet}
            {#snippet after()}
              <a class="p-quiet" href={resolve("/item/[[id]]", { id: encodeURIComponent(s.receiptId ?? s.id) })}>review &amp; amend →</a>
            {/snippet}
          </Row>
        </div>
      {/each}
      {#each view.mailReading as r (r.id)}
        <div class="pk-reading">
          <Row title={`A message arrived ${agoShort(r.receivedAt)}`} meta="still reading its document" metaFace="ui">
            {#snippet mark()}<span class="pk-dot breathing"></span>{/snippet}
          </Row>
        </div>
      {/each}
      {#each view.mailFailures as f (f.id)}
        <Row title={`A message from ${short(f.receivedAt.slice(0, 10))}`} meta={f.message} metaFace="ui">
          {#snippet mark()}<span class="pk-dot failed"></span>{/snippet}
        </Row>
      {/each}
    </div>
    <p class="burnup">unreviewed arrivals burn up after 45 days · nothing is added without you</p>
  {/if}
  </div>
  {/if}
</main>
{#if !view?.emptySky}<NorthStar />{/if}
</div>

<Sheet bind:open={sheetOpen} size={sheetSize} title={sheetTitle} hideTitle={face === "search" || face === "item"}>
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
    <!-- The item sheet (#1119, §2.1): a preview of the item's own card
         (item/[[id]]/+page.svelte), which `open` grows it into. The dialog's
         hidden title names it for a screen reader, so the visible name here
         is not read twice. -->
    <div class="pk-item">
      <div class="p-card pk-card">
        <div class="pk-card-head" aria-hidden="true">
          <span class="p-body pk-mark {TONE_CLASS[row.band] ?? ''} {FACE_CLASS[row.kind] ?? ''}"></span>
          <span class="pk-name">{row.title}</span>
        </div>
        <div class="pk-sub">{[row.section, row.kind].filter(Boolean).join(" · ")}</div>
        {#if row.dueDate}
          <div class="p-kv"><span>{row.kind === "expiry" ? "ends" : "due"}</span>
            <b class={TONE_CLASS[row.band] ?? ""}>{tlabel(row)} · {longDate(row.dueDate)}</b></div>
        {/if}
        {#if row.kind === "expiry"}
          <div class="p-kv"><span>orbital period</span><b>one-off — does not come round</b></div>
        {:else if row.recurrenceMonths}
          <div class="p-kv"><span>orbital period</span><b>{every(row.recurrenceMonths)}</b></div>
        {/if}
        <div class="p-kv"><span>cost</span><b>{money(row.costMinor, row.currency, row.costIsEstimate)}</b></div>
        <div class="p-kv"><span>documents</span><b>{documentCount > 0 ? documentCount : "none yet"}</b></div>
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
    <a class="pk-amend" href={resolve("/item/[[id]]", { id: encodeURIComponent(suggestion.receiptId ?? suggestion.id) })}>review &amp; amend →</a>
  {:else if face === "search"}
    <!-- #1057's phone half (§2.4; phone-search round 1, B). -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="pk-results" bind:this={resultList} onkeydown={listKey}>
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
          <Row title={doc.name} meta={`${doc.itemTitle} · ${doc.meta}`} onactivate={() => openPaper(doc)}>
            {#snippet mark()}<span class="pk-paper" aria-hidden="true">◆</span>{/snippet}
          </Row>
        {/each}
      {/if}
      {#if problem}<p class="p-error" role="alert">{problem}</p>{/if}
    </div>
  {/if}
  <!-- Every act in the sheet's pinned foot (review round §1.2). -->
  {#snippet foot()}
    {#if (face === "item" || face === "docs") && row}
      <a class="p-pill filled" href={resolve("/item/[[id]]", { id: encodeURIComponent(row.id) })}
         onclick={() => (morphing = true)}>open</a>
      {#if face === "item" && documentCount > 0}<button class="p-pill" onclick={showDocuments}>documents</button>{/if}
    {:else if face === "sugg" && suggestion}
      <ArmButton label="Add to orbit" armedLabel="tap again to add" danger={false} class="filled"
                 onfire={() => decide("approve")} />
      <ArmButton label="Dismiss" armedLabel="tap again to dismiss" danger={false} onfire={() => decide("dismiss")} />
    {:else if face === "search" && results.query && !results.nothing && results.complete}
      {@const top = results.complete}
      <!-- The one accent action for the top match (§2.4). -->
      <ArmButton label={`→ complete “${top.title}”`} armedLabel="tap again to complete" danger={false} wide
                 class="pk-act" onfire={() => complete(top)} />
    {/if}
  {/snippet}
</Sheet>

<Hatch bind:open={hatchOpen} name={view?.user?.displayName ?? ""} {roleLine} {isAdmin}
       inboxCount={waiting || null} />
