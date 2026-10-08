<script>
  import { onMount, tick } from "svelte";
  import { beforeNavigate, goto, invalidateAll, replaceState } from "$app/navigation";
  import { navigating, page } from "$app/state";
  import { resolve } from "$app/paths";
  import { mountTiledSky } from "$lib/sky.js";
  import { every, longDate, money, shortDate } from "$lib/format.js";
  import Chrome from "$lib/Chrome.svelte";
  import {
    WorkspaceError, applyCommand, approveReceipt, dismissReceipt, removeDocument, restoreDocument,
  } from "$lib/data/workspace.js";
  import ArmButton from "$lib/pocket/ArmButton.svelte";
  import Row from "$lib/pocket/Row.svelte";
  import Sheet from "$lib/pocket/Sheet.svelte";
  import ReviewSheet from "$lib/pocket/ReviewSheet.svelte";
  import { burnsInOf, formReadingsOf, papersOf, readingsOf } from "$lib/pocket/review.js";
  import { POCKET_QUERY, isPocket } from "$lib/pocket/media.js";
  import { WAKE_HOLD_MS, wake } from "$lib/pocket/wake.js";
  import Reader from "./Reader.svelte";
  import Pager from "./Pager.svelte";
  import StagedPage from "$lib/pocket/StagedPage.svelte";
  import EntryForm from "../../create/EntryForm.svelte";
  import { COST_FORMAT_HINT, entryChanged, entryOf, fieldsOf, minorOf, refusalOf } from "../../create/entry.js";
  import { beltManifestOf, documentPreviewStateOf } from "$lib/data/belt.js";
  import { loadStagedPage, previewPageHref } from "$lib/data/staged-page.js";
  import { pageKeyTarget } from "$lib/data/page-turn.js";
  import {
    archiveCommand, completeCommand, nextDateAfter, rescheduleCommand,
    snoozeCommand, statusCommand, upsertCommand,
  } from "$lib/data/commands.js";
  import {
    COST_LOCKED, DAMAGED, DAMAGED_PLACEHOLDER, LOCKED, NOTES_WORDS, PANEL_LOCKED, REFERENCE_WORDS,
    evidenceReadable, fieldState, itemLocked, receiptWords, saveProblem,
  } from "$lib/data/metadata-status.js";
  import { litItemCountOf, matchesOf, nearestMatchOf, reachableAt, stepFrom } from "./band.js";
  import { searchBelt } from "./pocket-find.js";
  import { mountBelt } from "./belt.behaviour.js";
  import "./belt.css";

  /**
   * THE ITEM BELT (#458) — and, by the owner's ruling of 2026-08-16, the item
   * screen itself: "this surface IS the item screen. Arriving at an item from
   * anywhere else — a manifest row on home, a filed lane in the inbox, a link
   * in a reminder — lands you HERE with that item already seated at the apex
   * and its neighbours in time already around it."
   *
   * Built from design/v19/item-belt.html, which is sealed and is the law for
   * every pixel of it. Every item in the household rides one tilted ring in
   * strict order of when it comes due — sooner left, later right — jumbled
   * through the band's thickness but never out of order; the centred body is
   * its own card, seated at the apex; and the centred item's documents ride in
   * the belt beside it, ringed, glowing and slowly breathing.
   *
   * What lives where: the arithmetic is band.js (pure, unit-tested), the
   * canvas and the roll are belt.behaviour.js, the manifest transform is
   * $lib/data/belt.js and the reads are the seam's readBelt(). This file is
   * the markup, the card, the search and the commands.
   *
   * The commands are #455's, unchanged: the same builders, the same
   * optimistic-concurrency contract, the same words. The retired item view's
   * rendering is gone — the belt is what /item/<id> draws now — but its
   * writes were never the thing being replaced.
   */

  /**
   * The belt's vocabulary, taken from the two modules that own it (#624).
   *
   * @typedef {import("./band.js").Body}       Body
   * @typedef {import("./band.js").BeltRow}    BeltRow
   * @typedef {import("./band.js").ItemRecord} ItemRecord
   * @typedef {import("./belt.behaviour.js").BeltController} BeltController
   */

  /** @typedef {"complete" | "reschedule" | "snooze" | "edit" | "retire"} PanelName */

  /**
   * The command panels' fields, as the inputs bind them: strings, one panel's
   * worth at a time. Each panel fills what it needs and leaves the rest
   * unset, which is why every field is optional rather than blank.
   *
   * @typedef  {object} PanelForm
   * @property {string} [completedDate]
   * @property {string} [nextDate]
   * @property {string} [cost]
   * @property {string} [notes]
   * @property {string} [dueDate]
   * @property {string} [until]
   * @property {string} [title]
   * @property {string} [provider]
   * @property {string} [reference]
   * @property {string | number} [recurrenceMonths]
   */

  let { data } = $props();

  /* #1145: the suggestion the belt is seating, if this arrival was a mail-in
     receipt (workspace.js readBelt). `households` and `primary` ride beside
     it for the phone's review sheet. Derived, not read once: this route's
     component is reused across /item addresses, so an acceptance that lands
     on the new item's address must find the visitor gone from the data, or
     the belt would seat the accepted item beside its own ghost. */
  const seatedSuggestion = $derived(
    /** @type {import('$lib/data/workspace.js').ItemView | null} */ (data.suggestion ?? null));
  const suggestionHouseholds = $derived(
    /** @type {import('../../create/entry.js').FormHousehold[]} */ (data.households ?? []));
  const primaryHousehold = $derived(/** @type {string | null} */ (data.primary ?? null));

  /** @type {HTMLDivElement | null} */
  let root = $state(null);
  /** @type {HTMLDivElement | null} */
  let sky = $state(null);
  /** @type {BeltController | null} */
  let belt = null;

  /* What the screen shows. `bodies` and `bloom` are copies taken from the
     controller at each settle: the band owns them, the markup only reads. */
  /** @type {Body[]} */
  let bodies = $state.raw([]);
  /** @type {number[]} */
  let bloom = $state.raw([]);
  let selected = $state(0);
  /* The type rides on the initial value, not on a declaration comment: the
     band writes this from its own callbacks, so a plain `null` would have
     the derivations below reading a variable narrowed to null for ever. */
  let cardBody = $state(/** @type {Body | null} */ (null));
  let query = $state("");
  /** @type {Set<number>} */
  let matches = $state.raw(new Set());

  /* The command surface, the item view's own (#455). */
  /** @type {PanelName | null} */
  let panel = $state(null);
  /** @type {"archive" | "cancel" | null} */
  let armed = $state(null);
  let busy = $state(false);
  /** @type {string | null} */
  let problem = $state(null);
  /** @type {PanelForm} */
  let form = $state({});
  /** What the open panel's own form started as (#1151 W1-S5), captured by
      open() the same moment it builds a fresh one. Null while no panel is
      open, which is what lets panelDirty() read "nothing to lose" from it
      alone. */
  /** @type {string | null} */
  let formStart = null;
  /** The phone edit sheet's own baseline (#1151 W1-S5): the "edit" panel's
      desktop inputs bind `form`, but its phone face binds `editEntry`
      (EntryForm.svelte) instead, so it needs the same before-and-after
      capture entry.js's own entryChanged compares. */
  /** @type {import('../../create/entry.js').Entry | null} */
  let editStart = null;
  /** Typed but not a sum of money (#1151 W1-F1/W1-S4): the complete and edit
      panels' own cost field, desktop and phone alike. */
  const formCostInvalid = $derived(Number.isNaN(minorOf(form.cost)));

  /* ---- THE POCKET (#1072, proposal §2.3) ---------------------------------
     Below the CON-10 switch the same belt is drawn closer — a low arc across
     the top with the card hanging beneath it (band.js, THE POCKET'S BELT) —
     and everything the desk unfolds inside the card or beside it is a kit
     Sheet instead: the five acts' panels, the document list, the preview,
     the search. One sheet at a time; a sheet that needs another grows into
     it (the list into a paper's preview) rather than stacking. The reader
     is the one full-screen window, over the belt (Reader.svelte). This
     route renders in the browser only (+page.js), so the dialect is known
     from the first frame and follows the switch if the window crosses it. */
  let pocket = $state(isPocket());
  $effect(() => {
    const query = matchMedia(POCKET_QUERY);
    const follow = () => { pocket = query.matches; };
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  });
  /* #1248: editing on the desk widens the card to 720px and drops the detail
     rows the form repeats. The phone also sets `panel` while its full-height
     edit sheet is up, so the card there is left alone. */
  const editingInCard = $derived(panel === "edit" && !pocket);

  /* ---- THE SUGGESTION IN THE BELT (#1145, owner 2026-09-27: "the same
     familiar item belt just with a similar card to the suggested item screen,
     but on the belt instead") --------------------------------------------
     A mail-in receipt arrived at by its own address (#434) is seated in the
     band, hollow, at the date the relay read, and its card is the
     amend-then-accept card in the belt's own card position: on the desk the
     proposed fields are editable in the card and `accept into orbit` is the
     only path into the household; on a phone the card holds the readings and
     the two decisions, and `review & amend →` raises the review sheet the
     inbox and home raise (ReviewSheet.svelte). On acceptance it becomes an
     ordinary seat, in place: the belt re-reads with the new item at the
     apex. On dismissal it leaves the belt and the apex moves to the
     neighbour it sat beside. The separate suggestion page is gone. */
  const proposal = $derived(seatedSuggestion?.proposal ?? {});
  /** The desk card's form, from what the relay read.
      @param {import('$lib/data/workspace.js').ItemView | null} one */
  const formOf = (one) => {
    const p = one?.proposal ?? {};
    return {
      title: p.title ?? one?.title ?? "Forwarded email",
      provider: p.provider ?? "",
      reference: p.reference ?? "",
      cost: p.costMinor != null ? (p.costMinor / 100).toFixed(2) : "",
      dueDate: p.dueDate ?? "",
      recurrenceMonths: p.recurrenceMonths ?? "",
    };
  };
  /* Initialised synchronously: the first render must already know its
     values — an effect lands after render. */
  let sform = $state(formOf(/** @type {import('$lib/data/workspace.js').ItemView | null} */ (data.suggestion ?? null)));
  let acceptBusy = $state(false);
  let acceptArmedDismiss = $state(false);
  /** @type {string | null} */
  let acceptProblem = $state(null);
  /** One operation id across retries (approveReceipt's contract): a
      double-tap can never create two items. */
  /** @type {string | null} */
  let acceptOpId = null;
  /* A different receipt at this reused component (a link from one
     suggestion's belt to another's) starts a fresh form and a fresh
     decision; the same receipt across a re-read keeps what was typed. */
  let formFor = seatedSuggestion?.id ?? null;
  $effect(() => {
    const id = seatedSuggestion?.id ?? null;
    if (id === formFor) return;
    formFor = id;
    sform = formOf(seatedSuggestion);
    acceptOpId = null;
    acceptArmedDismiss = false;
    acceptProblem = null;
  });
  /* #941: what Orbit cannot read about this message, if anything. A locked
     proposal cannot be amended or accepted -- the whole card is a read of an
     unreadable value -- while a damaged one has a real recovery path nothing
     else on this screen has: the original is still in the member's mailbox. */
  const unreadable = $derived(receiptWords(seatedSuggestion?.metadataStatus));
  const proposalLocked = $derived(fieldState(seatedSuggestion?.metadataStatus, "proposal") === LOCKED);
  /* fieldEvidence damaged on its own loses the provenance, not the values, so
     the from-document accents go and nothing else does. */
  const evidenceShown = $derived(evidenceReadable(seatedSuggestion?.metadataStatus));
  /** @param {string} field */
  const marked = (field) => evidenceShown && Boolean(seatedSuggestion?.fieldEvidence?.[field]);
  /* The suggestion as approveReceipt takes it: readItem hands the receipt's
     view, which carries every ReceiptSuggestion field. */
  const receipt = /** @type {import('$lib/data/workspace.js').ReceiptSuggestion | null} */ (
    /** @type {unknown} */ (seatedSuggestion));
  const burnsIn = $derived(seatedSuggestion ? burnsInOf(seatedSuggestion, seatedSuggestion.today) : null);
  const suggestedFrom = $derived(
    [seatedSuggestion?.sourceDocument, burnsIn !== null ? `burns up in ${burnsIn}d` : null].filter(Boolean).join(" · "));

  /**
   * Accept, amended or as proposed. Accepted, it is an item now and has a
   * seat of its own at the same date: the belt re-reads with that item at
   * the apex -- the body simply stops being hollow.
   * @param {import('$lib/data/workspace.js').ItemProposal | null} [amended]
   * @param {string | null} [sectionId]
   * @returns {Promise<boolean>} whether it entered the orbit
   */
  async function acceptSuggestion(amended = null, sectionId = null) {
    if (!receipt || acceptBusy) return false;
    acceptBusy = true;
    acceptProblem = null;
    try {
      acceptOpId ??= crypto.randomUUID();
      const result = await approveReceipt(receipt, primaryHousehold, acceptOpId, amended, sectionId);
      if (result.outcome === "partial_success") {
        acceptProblem = "The item is recorded, but its documents need another try — accept again to finish.";
        return false;
      }
      acceptOpId = null;
      const title = amended?.title ?? (sform.title.trim() || receipt.title);
      if (pocket) wake(`added to your orbit · ${title}`);
      await goto(result.itemId ? resolve("/item/[[id]]", { id: result.itemId }) : resolve("/home"),
        { invalidateAll: true });
      return true;
    } catch (error) {
      acceptProblem = saveProblem(/** @type {{ code?: string, message?: string }} */ (error));
      return false;
    } finally {
      acceptBusy = false;
    }
  }
  /** The desk card's own form, sent as the amended item. */
  function acceptAmendedOnDesk() {
    if (!receipt) return;
    const cost = minorOf(sform.cost);
    if (Number.isNaN(cost)) { acceptProblem = COST_FORMAT_HINT; return; }
    /** @type {import('$lib/data/workspace.js').ItemProposal} */
    const amended = { title: sform.title.trim() || "Forwarded email", currency: receipt.currency };
    if (proposal.subtype) amended.subtype = proposal.subtype;
    if (sform.provider.trim()) amended.provider = sform.provider.trim();
    if (sform.reference.trim()) amended.reference = sform.reference.trim();
    if (cost !== undefined) amended.costMinor = cost;
    if (sform.dueDate) {
      amended.dueDate = sform.dueDate;
      if (proposal.scheduleKind) {
        amended.scheduleKind = proposal.scheduleKind;
        const months = Number(sform.recurrenceMonths);
        if (months) amended.recurrenceMonths = months;
      }
    }
    acceptSuggestion(amended);
  }
  /**
   * Dismissed, it leaves the belt. The apex goes to the neighbour it sat
   * beside -- the later one, else the sooner one -- so the reader stays
   * where in time they were looking; a belt with nothing else on it goes
   * home. On the desk the first press arms and the second fires, the
   * protocol every irreversible act on this screen uses.
   */
  async function dismissSuggestion() {
    if (!receipt || acceptBusy) return;
    if (!pocket && !acceptArmedDismiss) { acceptArmedDismiss = true; return; }
    acceptBusy = true;
    acceptProblem = null;
    try {
      await dismissReceipt(receipt.receiptId);
      const neighbour = [1, -1]
        .map((d) => stepFrom(bodies, selected, bloom, d))
        .map((i) => (i >= 0 ? bodies[i] : null))
        .find((b) => b && !b.item.suggestion);
      if (pocket) wake(`dismissed · ${receipt.title}`);
      await goto(neighbour ? resolve("/item/[[id]]", { id: neighbour.item.id }) : resolve("/home"),
        { invalidateAll: true });
    } catch (error) {
      acceptProblem = /** @type {{ message?: string }} */ (error)?.message ?? String(error);
      acceptArmedDismiss = false;
    } finally {
      acceptBusy = false;
    }
  }
  /* ---- review & amend on a phone: the sheet the inbox and home raise ---- */
  let reviewOpen = $state(false);
  /** @type {string | null} */
  let reviewProblem = $state(null);
  /**
   * @param {import('$lib/data/workspace.js').ItemProposal} amended
   * @param {string | null} sectionId
   */
  async function saveReview(amended, sectionId) {
    reviewProblem = null;
    const ok = await acceptSuggestion(amended, sectionId);
    if (!ok) reviewProblem = acceptProblem ?? "not added — try again";
    return ok;
  }

  /** @typedef {PanelName | "docs" | "preview" | "search"} Face */
  /** @type {Record<Face, "callout" | "list" | "full">} */
  const SHEET_SIZE = {
    complete: "callout", reschedule: "callout", snooze: "callout", retire: "callout",
    edit: "full", docs: "list", preview: "list", search: "list",
  };
  let sheetOpen = $state(false);
  /** @type {Face | null} */
  let face = $state(null);
  let readerOpen = $state(false);
  /** @param {Face} next */
  function raise(next) {
    face = next;
    sheetOpen = true;
  }
  /* Whatever closed the sheet (scrim, drag, the close word, Escape, back),
     what it was holding goes with it. */
  function sheetClosed() {
    const was = face;
    face = null;
    panel = null;
    armed = null;
    readerOpen = false;
    if (was === "preview") { belt?.closeDoc(); closePreview(); }
    if (was === "search") pocketQuery = "";
  }
  /* A step taken the moment a sheet closes has to wait for the sheet's own
     history entry to come off, or the address it writes lands on the entry
     that is about to be popped. */
  /** @param {() => void} then */
  function afterSheet(then) {
    if (!sheetOpen) { then(); return; }
    sheetOpen = false;
    let done = false;
    const go = () => { if (done) return; done = true; removeEventListener("popstate", go); setTimeout(then, 0); };
    addEventListener("popstate", go);
    setTimeout(go, 350);
  }

  /** The act pressed on the card: on the desk its panel unfolds in the card;
      on a phone it rises as a sheet.
      @param {PanelName} name
      @param {ItemRecord} item */
  function act(name, item) {
    if (!pocket) { open(name, item); return; }
    // Asked here, not left to open(): the sheet is reopened rather than
    // toggled, so the panel is cleared first, and open()'s own question
    // would then find nothing to ask about (#1151 W1-S5).
    if (panel !== null && panelDirty() && !confirm("Discard changes to this panel?")) return;
    panel = null;
    open(name, item);
    raise(name);
  }

  /* ---- complete, with an undo wake (§2.3, §1.13) --------------------------
     An item with nothing to record — no cost to confirm — completes on the
     tap; one with a cost raises the record sheet first. Either way the
     completion is HELD for the wake's four seconds and only then sent, so
     `undo` is a real undo: there is no command that takes a completion back,
     and a reschedule would leave the completion in the item's history.
     Leaving the page sends it at once. */
  /** @typedef {{ command: object, leave: boolean, timer: ReturnType<typeof setTimeout> | undefined, done: boolean }} HeldCompletion */
  /** @type {HeldCompletion | null} */
  let pending = null;
  /** The key a held completion is stashed under (#1151 W1-R5) so a flush cut
      off by the page actually unloading — not merely refused — is picked up
      on the next load instead of vanishing with no trace. One slot: this
      screen only ever holds one completion at a time. */
  const HELD_COMPLETION_KEY = "orbit:pending-completion";
  /* The same list the home pocket keeps under this key, in the same shape:
     one entry per held completion, each leaving on its own send. One slot
     here overwrote whatever the pocket had left waiting, and read the
     pocket's list as nothing at all (#1151 W1-R5). */
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
  function stashHeldCompletion(command) {
    writeHeldCompletionStash([...readHeldCompletionStash(), command]);
  }
  /** @param {object} command */
  function clearHeldCompletionStash(command) {
    const key = JSON.stringify(command);
    writeHeldCompletionStash(readHeldCompletionStash().filter((one) => JSON.stringify(one) !== key));
  }
  /** @param {ItemRecord} item */
  function tapComplete(item) {
    if (item.costMinor !== null && item.costMinor !== undefined) { act("complete", item); return; }
    const done = todayISO();
    holdCompletion(item, { completedDate: done, nextDate: nextDateAfter(done, item.recurrenceMonths) ?? undefined });
  }
  /**
   * @param {ItemRecord} item
   * @param {{ completedDate: string, nextDate?: string, costMinor?: number, notes?: string }} fields
   */
  function holdCompletion(item, fields) {
    sendPending();
    /* Built once, not per send (same reasoning as the create draft's id,
       #1151 W1-R2/W1-R3): a retry reuses the exact command, version guard
       included, rather than minting a new activity id each time it is
       resent. */
    const command = completeCommand(item, fields);
    stashHeldCompletion(command);
    /** @type {HeldCompletion} */
    const job = { command, leave: !fields.nextDate, timer: undefined, done: false };
    job.timer = setTimeout(() => firePending(job), WAKE_HOLD_MS);
    pending = job;
    /* The date first: the wake is one line and ellipsises, and the card above
       already names the item; the live region still reads the whole line. */
    wake(`Completed${fields.nextDate ? ` · next due ${shortDate(fields.nextDate)}` : ""} · ${item.title}`, {
      undo: () => {
        clearTimeout(job.timer);
        job.done = true;
        if (pending === job) pending = null;
        clearHeldCompletionStash(job.command);
      },
    });
  }
  /** @param {HeldCompletion} job */
  async function firePending(job) {
    if (job.done) return;
    job.done = true;
    if (pending === job) pending = null;
    await run(() => job.command, { leave: job.leave });
    if (problem) wake(problem, { failure: true });
    else clearHeldCompletionStash(job.command);
  }
  /* Leaving before the wake has gone: the completion is sent now, not lost
     — and stashed before it is sent (above), so even a send this page never
     lives to see the answer to is picked up on the next load (#1151 W1-R5). */
  function sendPending() {
    const job = pending;
    if (!job || job.done) return;
    clearTimeout(job.timer);
    job.done = true;
    pending = null;
    applyCommand(job.command).then(() => clearHeldCompletionStash(job.command)).catch(() => {});
  }
  beforeNavigate(() => { sendPending(); });
  $effect(() => {
    addEventListener("pagehide", sendPending);
    return () => { removeEventListener("pagehide", sendPending); };
  });
  /** A completion stashed by a previous visit that never confirmed it sent
      (#1151 W1-R5): picked up here instead of the item just quietly staying
      "not completed" with nothing said. A version conflict means somebody
      already holds this change — most likely the original send landing
      after all — so that alone is treated as the stash's own success. */
  function retryHeldCompletionStash() {
    for (const command of readHeldCompletionStash()) applyCommand(command).then(async () => {
      clearHeldCompletionStash(command);
      await rereadUnlessLeaving();
    }).catch(async (error) => {
      if (error instanceof WorkspaceError && error.code === "version_conflict") {
        clearHeldCompletionStash(command);
        await rereadUnlessLeaving();
        return;
      }
      problem = saveProblem(/** @type {{ code?: string, message?: string }} */ (error));
    });
  }

  /* ---- the papers on a phone ---------------------------------------------
     A paper opens the preview sheet (§18: "on a phone it is the bottom
     sheet"); the page in it is a button that opens the reader. A paper
     tapped on home arrives in the navigation's state (home's pocket.svelte,
     openPaper) and opens here as soon as the belt has seated its item. */
  let arrivalPaper = /** @type {string | null} */ (
    (/** @type {Record<string, unknown>} */ (page.state ?? {})).pocketPaper ?? null);
  /* Home's drawer `complete` on an item with a cost to confirm arrives here
     asking for the record sheet (home's pocket.svelte, completeRow; review
     round §2.1): it rises as soon as the belt has seated the item. */
  let arrivalAct = /** @type {string | null} */ (
    (/** @type {Record<string, unknown>} */ (page.state ?? {})).pocketAct ?? null);
  /** @param {import("./band.js").BeltDoc} doc */
  function showPaper(doc) {
    const i = bodies.findIndex((b) => b.kind === "doc" && b.id === doc.id);
    if (i >= 0 && belt) { belt.openDoc(i); return; }
    openPreview(doc, "right");
    raise("preview");
  }
  /** @param {string} id */
  function showPaperById(id) {
    // The inbox sends a staged attachment's own id; home's pocket sends the
    // belt doc id (#1155) -- either one can name the paper being asked for.
    const doc = row?.docs.find((one) => one.attachmentId === id || one.id === id);
    if (doc) showPaper(doc);
  }
  async function removePreviewDoc() {
    const doc = previewDoc;
    if (!doc) return;
    await removeDocument(doc.id);
    readerOpen = false;
    sheetOpen = false;
    await invalidateAll();
    wake(`${doc.name} removed`, {
      undo: () => { restoreDocument(doc.id).then(() => invalidateAll()).catch(() => {}); },
    });
  }

  /* ---- the find line (§2.3, §2.4): the search sheet, over the belt -------
     Results approach directly — the belt is already the item screen. */
  let pocketQuery = $state("");
  const found = $derived(searchBelt(pocketQuery, bodies));
  /** @param {number} i */
  function approach(i) {
    afterSheet(() => { if (i !== selected) belt?.centre(i); });
  }
  /** @param {{ doc: import("./band.js").BeltDoc, itemIdx: number }} hit */
  function approachPaper({ doc, itemIdx }) {
    const at = bodies.findIndex((b) => b.kind === "item" && b.itemIdx === itemIdx);
    afterSheet(() => {
      if (at === selected) { showPaper(doc); return; }
      arrivalPaper = doc.id;
      belt?.centre(at);
    });
  }
  /** @param {KeyboardEvent} event */
  function findKey(event) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const top = found.items[0];
    if (top) approach(top.index);
    else if (found.documents[0]) approachPaper(found.documents[0]);
  }
  /* The sheet titles, for the dialog's name. */
  const sheetTitle = $derived.by(() => {
    if (face === "complete") return "Record a completion";
    if (face === "reschedule") return "Reschedule";
    if (face === "snooze") return "Snooze";
    if (face === "edit") return `Edit ${row?.title ?? "item"}`;
    if (face === "retire") return `Retire ${row?.title ?? "this item"}?`;
    if (face === "docs") return `${row?.docs.length ?? 0} documents · ${row?.title ?? ""}`;
    if (face === "preview") return previewDoc?.name ?? "Document";
    return "Find an item";
  });
  /** A date `months` on from `from`, for the quick pills. @param {string} from @param {number} months */
  const monthsOn = (from, months) => nextDateAfter(from, months) ?? from;
  /** @param {string} from @param {number} days */
  const daysOn = (from, days) =>
    new Date(Date.parse(`${from}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

  /* ---- the document preview (#1088) --------------------------------------
     create-v3's reading card (design/v19/create-v3.html's `.readcard`,
     `.topsheet`, `.focus`), reused for its two everyday states — focus while
     the page is on its way, snap once it has landed — plus the four honest
     ones owner-decisions.md §18 draws when there is none to show. A document
     is never the centred body: this rides entirely beside `selected`, opened
     and closed by the belt's own openDoc/closeDoc (a paper's own press)
     rather than by centring anything. The belt owns WHICH paper and WHICH
     side; this screen owns what the card says about it, same division as
     the item card and its panels. */
  /** @type {import("./band.js").BeltDoc | null} */
  let previewDoc = $state(null);
  let previewSide = $state(/** @type {"left" | "right"} */ ("right"));
  /** Drives the reading card's own fade — true one tick after it is asked to
     open, and false the instant it is asked to close, so both ends of the
     opacity/transform transition actually run rather than snapping. */
  let previewOpen = $state(false);
  let previewImgLoaded = $state(false);
  let previewImgFailed = $state(false);
  /* #1155: a staged paper's bytes come from loadStagedPage, not a bare `<img
     src>` — only that loader can tell "gone" (404/410) apart from "could not
     draw" (a status an <img> error event never carries). #1300: an accepted
     document's come the same way, because the pager needs the response's
     X-Orbit-Page-Count and an <img> never sees a header. Both img tags read
     previewSrc, an object URL, whatever the paper's origin. */
  let previewSrc = $state("");
  /* #1300: the page the pager asks for (the reader binds it too), the page
     previewSrc holds, and how many there are -- null until a response says. */
  let previewPage = $state(1);
  let previewShownPage = $state(1);
  /** @type {number | null} */
  let previewPageCount = $state(null);
  let previewGone = $state(false);
  /** @type {AbortController | null} */
  let previewAbort = null;
  /* Discards a loadStagedPage result that lands after the card has moved on
     to a different paper (or closed and reopened the same one). */
  let previewToken = 0;
  /* create-v3's own walk: the page does not appear the instant it has
     loaded — it waits for a minimum beat so a fast load never flickers. */
  let previewBeatDone = $state(false);
  let previewRestoring = $state(false);
  /** @type {string | null} */
  let previewProblem = $state(null);
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let previewCloseTimer;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let previewBeatTimer;
  /** #1151 W1-R10: an accepted document's preview is a bare `<img src>`
   *  with only onload/onerror — unlike the staged path, which has its own
   *  AbortController (loadStagedPage) — so a hung preview request left
   *  previewImgLoaded/Failed never set and the reticle/"drawing" line
   *  spinning forever, with no way to tell stuck from still loading.
   *  Cleared the instant either handler actually fires. */
  const PREVIEW_LOAD_TIMEOUT_MS = 15_000;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let previewLoadTimer;

  const previewDocState = $derived(previewDoc ? documentPreviewStateOf(previewDoc) : null);
  /* A document Orbit believed showable but whose actual page failed to load
     (the preview endpoint refused it for a reason the summary could not
     predict, e.g. a structurally invalid PDF) reads exactly as "a kind
     Orbit cannot draw" — the same honest line, never a stuck loading state.
     A staged paper whose mail has gone (#1155) takes priority over both:
     there is no page and nothing to call "could not draw" either. */
  const previewState = $derived(previewGone ? "gone" : previewImgFailed ? "undrawable" : previewDocState);
  const previewShowing = $derived(
    previewDocState === "available" && previewImgLoaded && previewBeatDone && !previewImgFailed && !previewGone,
  );
  /* #1300: page one keeps the words it always had. */
  const previewAlt = $derived.by(() =>
    previewDoc ? `Page ${previewShownPage === 1 ? "one" : previewShownPage} of ${previewDoc.name}` : "",
  );
  /* #1300: the pager stands under an accepted paper's page once it has
     drawn and a response has said how many pages there are. A staged
     paper's foot keeps its one note (#1155). */
  const previewPaged = $derived.by(() =>
    previewShowing && previewPageCount !== null && Boolean(previewDoc && !previewDoc.staged),
  );
  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function revokePreviewSrc() {
    if (previewSrc.startsWith("blob:")) URL.revokeObjectURL(previewSrc);
  }

  /** @param {import("./band.js").BeltDoc} doc
      @param {"left" | "right"} side */
  function openPreview(doc, side) {
    clearTimeout(previewCloseTimer);
    clearTimeout(previewBeatTimer);
    clearTimeout(previewLoadTimer);
    previewAbort?.abort();
    previewAbort = null;
    revokePreviewSrc();
    const token = ++previewToken;
    previewDoc = doc;
    previewSide = side;
    previewImgLoaded = false;
    previewImgFailed = false;
    previewGone = false;
    previewRestoring = false;
    previewProblem = null;
    previewSrc = "";
    previewPage = 1;
    previewShownPage = 1;
    previewPageCount = null;
    previewBeatDone = documentPreviewStateOf(doc) !== "available";
    if (!previewBeatDone) {
      previewBeatTimer = setTimeout(() => { previewBeatDone = true; }, reducedMotion() ? 0 : 900);
    }
    if (!previewOpen) tick().then(() => { previewOpen = true; });

    /* Only a page Orbit can draw is asked for: a scanning, removed or
       refused paper has none, and must not be timed out into "could not
       draw" while it says so. */
    if (documentPreviewStateOf(doc) !== "available" || !doc.previewHref) return;
    if (!doc.staged) {
      previewLoadTimer = setTimeout(() => {
        if (token === previewToken) previewFailed();
      }, PREVIEW_LOAD_TIMEOUT_MS);
    }
    loadPreviewPage(doc, 1, token);
  }
  const UNDRAWN_PAGE = "this page could not be drawn — try again";
  /** #1300: page `n` of the open paper, through loadStagedPage. The page on
      show stays up until the next has arrived; a turn made before it
      arrives abandons it. Page one failing is the paper failing (gone, or
      could not draw); a later page failing says so under the pager and
      leaves the page that drew.
      @param {import("./band.js").BeltDoc} doc
      @param {number} n
      @param {number} token */
  function loadPreviewPage(doc, n, token) {
    previewAbort?.abort();
    const controller = new AbortController();
    previewAbort = controller;
    loadStagedPage(previewPageHref(doc.previewHref, n), controller.signal).then((result) => {
      if (token !== previewToken || controller.signal.aborted) {
        if (result.kind === "page") URL.revokeObjectURL(result.url);
        return;
      }
      if (result.kind === "page") {
        revokePreviewSrc();
        previewSrc = result.url;
        previewShownPage = n;
        if (result.pageCount !== null) previewPageCount = result.pageCount;
      } else if (n > 1) previewProblem = UNDRAWN_PAGE;
      else if (result.kind === "gone" && doc.staged) previewGone = true;
      else previewFailed();
    }).catch((error) => {
      if (token !== previewToken || (error instanceof DOMException && error.name === "AbortError")) return;
      if (n > 1) previewProblem = UNDRAWN_PAGE;
      else previewFailed();
    });
  }
  /** #1300: the pager's arrows and keys, and the reader's turns (bound to
      its pageNo), all land here, so the preview and the reader are always
      on the same page.
      @param {number} n */
  function turnPreview(n) {
    const doc = previewDoc;
    if (!doc || n === previewPage) return;
    previewPage = n;
    previewProblem = null;
    loadPreviewPage(doc, n, previewToken);
  }
  /** Shared by both the desk reticle's and the pocket sheet's own <img>
   *  (#1151 W1-R10): clears the stuck-preview deadline the instant a real
   *  answer arrives. */
  function previewLoaded() {
    clearTimeout(previewLoadTimer);
    previewImgLoaded = true;
    previewImgFailed = false; // a slow load that arrives is not a failed one
    /* #1300: each page is its own size, so a turned page asks again. */
    tick().then(() => belt?.remeasure());
  }
  function previewFailed() {
    clearTimeout(previewLoadTimer);
    previewImgLoaded = true;
    previewImgFailed = true;
  }
  function closePreview() {
    if (!previewDoc) return;
    previewOpen = false;
    /* #1301: the reader goes with the card. It unmounts when previewDoc
       clears, and an `open` left true would mount the next paper's reader
       already open. Closing it here, while it is still mounted, also lets
       it take its own history entry back off. */
    readerOpen = false;
    clearTimeout(previewBeatTimer);
    clearTimeout(previewLoadTimer);
    previewAbort?.abort();
    previewAbort = null;
    /* The card stays mounted through its own fade-out, same choreography as
       the belt's cardwrap swap and create-v3's own topsheet. */
    previewCloseTimer = setTimeout(() => {
      previewDoc = null;
      revokePreviewSrc();
      previewSrc = "";
      previewGone = false;
    }, reducedMotion() ? 0 : 800);
  }
  /* The reading card sits level with the item card's own middle (create-v3's
     levelWithCard, belt.behaviour.js's port of it) — a figure only the belt
     can answer, because it is measured off the item card's real footprint.
     Every visual change to the reading card's own height (opening, the page
     landing, an honest state replacing the loading block) has to ask again. */
  $effect(() => {
    void previewDoc; void previewShowing; void previewState; void previewPageCount; void previewProblem;
    if (previewDoc) tick().then(() => belt?.remeasure());
  });
  /** The removed state's one foot action (#1054's restore, reached here
     rather than through the reader this issue does not build). */
  async function restorePreviewDoc() {
    if (!previewDoc || previewRestoring) return;
    /* #1151 W1-R12: the target, and the preview's own generation, taken
       now — openPreview's `previewToken` already says when the reader has
       moved on to a different document while something async for the old
       one is still in flight. Without this, closing or blaming the wrong
       document was always possible, not merely likely: `await
       restoreDocument(...)` has no deadline of its own. */
    const target = previewDoc;
    const token = previewToken;
    previewRestoring = true;
    previewProblem = null;
    try {
      await restoreDocument(target.id);
      if (token === previewToken) belt?.closeDoc();
      await invalidateAll();
    } catch (error) {
      if (token === previewToken) {
        previewProblem = saveProblem(/** @type {{ code?: string, message?: string }} */ (error));
      }
    } finally {
      previewRestoring = false;
    }
  }

  /** @type {HTMLInputElement | null} */
  let findEl = $state(null);
  /* Deliberately NOT reactive, all three: the mounting effect reads them and
     the band's callbacks write them, so making them state would make the
     effect depend on its own output and rebuild the belt for ever. */
  /** @type {string | null} */
  let centredId = null;
  /** @type {string | null} */
  let cardId = null;
  /** @type {string | null} */
  let addressId = data.selectedId ?? null;
  let routerReady = false;

  const row = $derived(cardBody?.item ?? null);              /* the manifest row  */

  /* #941: why a Tier 1 field is absent, when it is. Damaged means the stored
     value is gone and retyping replaces it; locked means it is intact and
     waiting for an administrator. `locked` is read at PANEL level, not field
     level, because item.upsert is a full-row write: while the key is away
     every edit to this item is refused, not just the two encrypted fields.
     The complete panel is the one exception (#972): item.complete only
     reaches for the key when a cost is given, so there `locked` gates the
     cost input alone and the rest of the panel — including the save button
     for a no-cost completion — stays live. */
  const referenceState = $derived(fieldState(row?.metadataStatus, "reference"));
  const notesState = $derived(fieldState(row?.metadataStatus, "notes"));
  const locked = $derived(itemLocked(row?.metadataStatus));
  const record = $derived(cardBody?.kind === "item" ? cardBody.item.item : null); /* the raw item */
  /** @type {(days: number[]) => string} */
  const remindOf = (days) => days.map((d) => `${d}d`).join(" and ") + " before";

  /* ---- mounting the band ------------------------------------------------
     The belt is rebuilt whenever the data changes, which is what a command's
     re-read is: completing an item moves it in time, so the band it rides in
     has to be laid out again — with the same body still centred. */
  $effect(() => {
    if (data.kind !== "belt" || !root) return;
    const rows = beltManifestOf({
      household: data.household,
      documentsByItem: data.documentsByItem,
      /* Same cast as suggestionItem above and for the same reason: data.kind
         comes back as plain `string`, so the data.kind === "belt" guard this
         effect already made does not narrow `today` into existence at the
         type level even though it always does at runtime. */
      today: /** @type {string} */ (data.today),
      keepId: data.selectedId,
      /* #1145: the visitor, seated only on this arrival. */
      suggestion: seatedSuggestion,
    });
    const focus = centredId ?? data.selectedId;
    const controller = mountBelt(root, {
      manifest: rows,
      selectedId: rows.some((/** @type {BeltRow} */ one) => one.id === focus) ? focus : data.selectedId,
      /* The band hands itself to every callback, because the first layout runs
         inside mountBelt — before `controller` below has been assigned. */
      onSelect(i, band) {
        selected = i;
        bodies = band.bodies;
        const body = band.bodies[i];
        if (!body) return;
        centredId = body.id;
        address(body.kind === "doc" ? body.item.id : body.id);
      },
      onSwap(i, band) {
        const body = band.bodies[i];
        /* A different body at the apex is a different subject: its panels,
           its arming and its failure line all belong to what left. A re-read
           that lands on the SAME body keeps them, which is what makes a
           refused command's message survive the invalidation it triggers. */
        if ((body?.id ?? null) !== cardId) { panel = null; armed = null; problem = null; }
        cardId = body?.id ?? null;
        cardBody = body;
      },
      /* #1062: the end-caps' press. The same function the arrow keys call —
         the band draws the controls, the screen owns the step. */
      onStep: step,
      /* #1088: a paper was pressed. The apex does not move — see openPreview. */
      onOpenPreview(doc, side) {
        openPreview(doc, side);
        if (pocket) raise("preview");
      },
      onClosePreview() {
        closePreview();
        if (pocket && face === "preview" && sheetOpen) sheetOpen = false;
      },
      /* #1072: the pocket's "+N" clump lists every paper. */
      onOpenList() { raise("docs"); },
      async onSettle(_i, band) {
        bloom = band.bloom.slice();
        bodies = band.bodies;
        /* The card is Svelte's, so it exists one tick after it is asked for:
           the band measures its footprint once it is really there, then lays
           the rubble down around it. */
        await tick();
        band.remeasure?.();
        /* A paper asked for on arrival, or by the search, opens once its item
           is seated (#1072). The desk opens it too (#1155): `showPaperById`
           already routes through `belt.openDoc`. */
        if (arrivalPaper) {
          const id = arrivalPaper;
          arrivalPaper = null;
          showPaperById(id);
        }
        if (arrivalAct === "complete" && pocket && record) {
          arrivalAct = null;
          act("complete", record);
        }
      },
    });
    belt = controller;
    return () => { controller.destroy(); if (belt === controller) belt = null; };
  });

  onMount(() => {
    if (sky) mountTiledSky(sky, "belt");
    /* Shallow routing is only legal once the router is up. */
    routerReady = true;
    retryHeldCompletionStash();
  });

  /** The address follows the apex: centring another item makes the one in the
     browser's bar a lie. REPLACE, never push — ← and → are reading, not
     navigating, and Back must still leave the way you came in (#424's rule
     for the expanded row, in the belt's grammar). A document has no address
     of its own yet, so it keeps its item's.
     @param {string} itemId */
  function address(itemId) {
    if (!routerReady || !itemId || itemId === addressId) return;
    addressId = itemId;
    try {
      replaceState(resolve("/item/[[id]]", { id: encodeURIComponent(itemId) }), {});
    } catch {
      /* No router (a direct render, a test harness): the belt still works. */
    }
  }

  /* ---- the search box ---------------------------------------------------
     Typing LIGHTS the matches and DIMS the rest; nothing vanishes, because
     the belt keeps its shape and you are meant to see where in time your hit
     sits. Enter centres the nearest match along the belt. */
  /** @param {Event & { currentTarget: EventTarget & HTMLInputElement }} event */
  function onFind(event) {
    query = event.currentTarget.value;
    matches = matchesOf(bodies, query);
    /* #1302: a search closes an open paper on the desk, the way dead space
       and Esc do. With the reader out, the card and the page together fill
       the sky to within 24px of each side, so there is no sky left for the
       hit list beside them; and the search ends by moving the apex or
       opening another paper, either of which closes the reader anyway. */
    if (query.trim() && previewDoc && !pocket) belt?.closeDoc();
    belt?.setQuery(query, matches);
  }
  const hitList = $derived(
    query.trim() ? [...matches].filter((i) => reachableAt(bodies, i, bloom)) : [],
  );
  const nearest = $derived(
    query.trim() && bodies.length ? nearestMatchOf(bodies, matches, selected, bloom) : -1,
  );
  /* #1145: a seated suggestion is counted apart -- it is in the belt, not in
     the orbit -- so the note never claims one more item than the household has. */
  const itemCount = $derived(bodies.filter((b) => b.kind === "item" && !b.item.suggestion).length);
  const suggestedCount = $derived(bodies.filter((b) => b.kind === "item" && b.item.suggestion).length);
  const suggestedNote = $derived(suggestedCount ? ` · ${suggestedCount} suggested` : "");
  /** #1151 W1-Q17: the one place both find-notes' shared selection formula
   *  (empty belt / no query / hit count / no match) lives — only the
   *  no-query branch's wording actually differs between desk and phone
   *  (round-3 §3.2: the phone's caps head drops "in date order" — the
   *  belt's own shape says the order, and the cap is 40 characters at
   *  rest), taken here as the one parameter that does.
   *  @param {string} noQuerySuffix */
  function findnoteFor(noQuerySuffix) {
    if (!bodies.length) return "the belt is empty";
    /* #1062: the note says what ORDER the belt is in, not which keys move
       it. The end-caps are the visible way along it now, and the arrow
       keys keep working as the shortcut they always were. */
    if (!query.trim()) return `${itemCount} items${suggestedNote} · ${noQuerySuffix}`;
    return hitList.length
      ? `${litItemCountOf(bodies, hitList)} of ${itemCount} lit · enter centres the nearest`
      : "nothing matches · the belt keeps its shape";
  }
  const findnote = $derived(findnoteFor("in date order, sooner to later"));
  const pocketFindnote = $derived(findnoteFor("sooner to later"));

  /** @param {KeyboardEvent} event */
  function onFindKey(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (nearest >= 0) goTo(nearest);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (findEl?.value) {
        findEl.value = "";
        query = "";
        matches = new Set();
        belt?.setQuery("", matches);
      } else findEl?.blur();
    }
  }

  /* ---- keyboard ---------------------------------------------------------
     ← and → step through the belt in date order, which is its whole grammar
     — over the papers too, when they are out. Inside the search field the
     arrows belong to the caret; inside a command panel they belong to the
     field being typed into, which the mockup never had to think about
     because its pills were inert. */
  /** @param {EventTarget | null} target */
  function typing(target) {
    return target instanceof Element
      && (target === findEl || Boolean(target.closest("input, textarea, select")));
  }
  /**
   * Go to a seat, whichever kind it is: a rock rolls to the apex; a paper
   * opens its reading card in place (#1088 — a document is never the
   * centred body). Every way this screen can be told "go to seat i" — the
   * end-caps, the arrow keys, Enter in the search field, a hit list row —
   * goes through this one function rather than three that have to agree.
   *
   * @param {number} i
   */
  function goTo(i) {
    const body = bodies[i];
    if (!body) return;
    if (body.kind === "doc") belt?.openDoc(i);
    else belt?.centre(i);
  }

  /**
   * One step along the belt. The whole of what ← and → do — and, since
   * #1062, the whole of what the two end-caps do as well: they are handed
   * this function, so a press and a key press are one code path and land the
   * same way rather than two that have to be kept agreeing.
   *
   * @param {number} d  -1 for sooner, +1 for later
   */
  function step(d) {
    const next = stepFrom(bodies, selected, bloom, d);
    if (next >= 0) goTo(next);
  }

  /** @param {KeyboardEvent} event */
  function onKeydown(event) {
    /* #1072: on a phone the sheets hold their own keys; the belt behind one
       must not step while it is up. #1145: the review sheet is one of them. */
    if (pocket && (sheetOpen || readerOpen || reviewOpen)) return;
    if (pocket && (event.key === "/" || ((event.metaKey || event.ctrlKey) && event.key === "k")) && !typing(event.target)) {
      event.preventDefault();
      raise("search");
      return;
    }
    /* #1088: Esc closes the reading card first — the belt's own dead-space
       law (owner-decisions.md §18) — and only then a command panel. */
    if (event.key === "Escape" && previewDoc) { event.preventDefault(); belt?.closeDoc(); return; }
    if (event.key === "Escape" && panel) { closePanel(); return; }
    if (typing(event.target)) return;
    /* #1300, round 6: while the preview is open its page has ← → PageUp
       PageDown Home End -- the belt does not step under it. */
    if (previewDoc && !pocket) {
      const target = pageKeyTarget(event.key, previewPage, previewPaged ? previewPageCount : null);
      if (target !== undefined) { event.preventDefault(); if (target !== null) turnPreview(target); return; }
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      step(-1);
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      step(1);
    }
    if (event.key === "/" || ((event.metaKey || event.ctrlKey) && event.key === "k")) {
      event.preventDefault();
      findEl?.focus();
      findEl?.select();
    }
  }

  /* ---- the commands (#455) ---------------------------------------------- */
  const todayISO = () => data.today ?? new Date().toISOString().slice(0, 10);
  /** @type {(minor?: number | null) => string} */
  const pounds = (minor) => (minor === null || minor === undefined ? "" : (minor / 100).toFixed(2));

  /**
   * A panel is always about the record at the apex, so it is handed the one
   * it is opening on rather than reaching for it: only the item card renders
   * these buttons, which is where the record is known to be there.
   *
   * @param {PanelName}  name
   * @param {ItemRecord} item
   */
  function open(name, item) {
    // Leaving an open panel, for another one or to close it, discards what
    // was typed there exactly as closePanel would: ask the same question.
    if (panel !== null && panelDirty() && !confirm("Discard changes to this panel?")) return;
    problem = null;
    armed = null;
    panel = panel === name ? null : name;
    if (panel === "complete") {
      const done = todayISO();
      form = {
        completedDate: done,
        nextDate: nextDateAfter(done, item.recurrenceMonths) ?? "",
        cost: pounds(item.costMinor),
        notes: "",
      };
    }
    if (panel === "reschedule") form = { dueDate: item.dueDate ?? todayISO() };
    if (panel === "snooze") form = { until: item.snoozedUntil ?? todayISO() };
    if (panel === "edit") {
      editEntry = entryOf(item);
      editStart = $state.snapshot(editEntry);
      form = {
        title: item.title,
        provider: item.provider ?? "",
        reference: item.reference ?? "",
        cost: pounds(item.costMinor),
        dueDate: item.dueDate ?? "",
        recurrenceMonths: item.recurrenceMonths ?? "",
        notes: item.notes ?? "",
      };
    } else {
      editStart = null;
    }
    formStart = panel ? JSON.stringify(form) : null;
  }

  /** Whether the open panel's own form differs from what it opened with
      (#1151 W1-S5) — the same comparison entry.js's own entryChanged
      makes for the create form. Checks both halves of the "edit" panel:
      the desktop inputs (`form`) and the phone sheet's own EntryForm
      (`editEntry`) — only one of the two is ever actually touched for a
      given dialect, so checking both costs nothing on the other. */
  function panelDirty() {
    if (panel === null) return false;
    if (editEntry && editStart && entryChanged(editEntry, editStart)) return true;
    return formStart !== null && JSON.stringify(form) !== formStart;
  }

  /** Closes whatever panel is open, asking first if it would discard
      something typed — the dirty-check-and-confirm W1-S1 built for the
      desktop create form, reused here for the same reason: no desktop
      confirm pattern already existed either. A decline leaves the panel
      open and typed. */
  function closePanel() {
    if (panelDirty() && !confirm("Discard changes to this panel?")) return;
    panel = null;
    armed = null;
  }

  /** One writer. Success re-reads the belt — the item may have moved in time,
     so the band it rides in is laid out again around it. Completing something
     that does not come round again leaves for the orbit, because this address
     no longer has a body to centre. A 409 surfaces in the server's own words
     and the re-read shows the truth that beat us; nothing is silently
     overwritten.
   *
   * @param {() => object} build  the command to send
   * @param {{ leave?: boolean }} [options] */
  async function run(build, { leave = false } = {}) {
    busy = true;
    problem = null;
    try {
      await applyCommand(build());
      panel = null;
      armed = null;
      if (leave) await goto(resolve("/home"));
      else await rereadUnlessLeaving();
    } catch (error) {
      /* The seam throws WorkspaceError and nothing else carries a `code`,
         so this is the same two readings the line always made. */
      /* #941: the one refusal that gets the member's own words rather than
         the server's is the locked 503 -- a panel opened before the key went
         away and sent after it. Everything else keeps what the server said. */
      problem = saveProblem(/** @type {{ code?: string, message?: string }} */ (error));
      if (error instanceof WorkspaceError && error.code === "version_conflict") await rereadUnlessLeaving();
    } finally {
      busy = false;
    }
  }
  /* The view re-reads once a command has landed, unless the reader has
     already set off somewhere else: a re-read is itself a navigation, and
     one begun after theirs superseded it and held them on this page (#1120:
     reschedule, then the way back at once, stayed on the item). The page
     they are leaving has no need of it. */
  async function rereadUnlessLeaving() {
    if (!navigating.to) await invalidateAll();
  }

  /** Two taps for what cannot be undone, the protocol home and the inbox use
     for exactly the same reason (#434): the first tap arms, the second acts.
   *
   * @param {"archive" | "cancel"} act
   * @param {() => unknown} go */
  function tap(act, go) {
    if (armed !== act) { armed = act; return; }
    go();
  }

  /** #1088: dead space closes the reading card (owner-decisions.md §18) —
     everything on the belt except the paper itself, the item card, the
     reading card, the search field and the chrome. */
  /** @param {PointerEvent} event */
  function onDeadSpace(event) {
    /* On a phone the preview is a sheet, which closes itself (#1072). */
    if (!previewDoc || pocket) return;
    const target = /** @type {Element | null} */ (event.target instanceof Element ? event.target : null);
    if (target?.closest?.(".readcard, .cardwrap, .hit, .find, .back, .orb, .account")) return;
    /* #1301: the reader is portalled out of everything above, so its own
       controls and its page have to be named; its backdrop stays dead space. */
    if (target?.closest?.(".rd-panel :is(button, a, output, img), .rd-zoom")) return;
    belt?.closeDoc();
  }

  /* ---- edit on a phone: create's form (§2.3, §2.5) -------------------- */
  /** @type {import("../../create/entry.js").Entry | null} */
  let editEntry = $state(null);
  const editRefusal = $derived(editEntry ? refusalOf(editEntry) : null);
  async function saveEdit() {
    if (!record || !editEntry || editRefusal) return;
    const item = record;
    const edits = fieldsOf(editEntry, { scheduleKind: item.scheduleKind ?? undefined });
    await run(() => upsertCommand(item, edits));
    if (problem) {
      /* Loud (#1058): the server's reason, in the refusal vocabulary. */
      if (!/^not saved/i.test(problem)) problem = `not saved — ${problem}`;
      return;
    }
    sheetOpen = false;
    wake(`saved · ${edits.title}`);
  }

  const editsOf = () => ({
    title: (form.title ?? "").trim(),
    provider: (form.provider ?? "").trim() || undefined,
    reference: (form.reference ?? "").trim() || undefined,
    costMinor: minorOf(form.cost),
    dueDate: form.dueDate || undefined,
    recurrenceMonths: form.recurrenceMonths ? Number(form.recurrenceMonths) : undefined,
    notes: (form.notes ?? "").trim() || undefined,
  });
</script>

<svelte:window onkeydown={onKeydown} onpointerdown={onDeadSpace} />

<svelte:head>
  <title>{row?.title ?? "Item"} — Orbit</title>
</svelte:head>

<!-- The shared chrome (#1010): the way back to the sky and the account menu.
     A sibling of the belt, not a child, so belt.css's own `.belt-page .back`
     (the in-card links) never reaches the chrome's link of the same name. -->
<Chrome user={data.kind === "belt" ? data.user : null} current="item"
        role={data.kind === "belt" && data.household
          ? `${data.household.name ?? ""} · ${data.household.canManage ? "owner" : "member"}` : ""} />

<div class="belt-page" bind:this={root} role="main">
  <!-- #843: sr-only -- the visible title is the centred card's own h2. -->
  <h1 class="sr-only">Item</h1>
  <div class="sky" aria-hidden="true" bind:this={sky}></div>
  <div class="vignette" aria-hidden="true"></div>

  <!-- #1072, §2.3: on a phone the find line is the search sheet's button,
       and the count line says what order the belt is in. -->
  <button class="ip-find" aria-haspopup="dialog" onclick={() => raise("search")}>find an item</button>
  <p class="ip-count">{pocketFindnote}</p>

  <!-- the band: everything at or behind the ring plane -->
  <canvas id="band" aria-hidden="true"></canvas>

  <!-- the members: every item in the household in date order along the band,
       plus the centred item's documents in the berth beside it -->
  <svg id="members" aria-label="The item belt: every item in this household, placed in order of when it comes due — sooner to the left, later to the right. The body at the apex of the band is shown as its card, and its documents ride in the belt beside it.">
    <defs>
      <!-- The rock's shading, lit from the same quarter as home's planets, so
           every body in the sky shares one light. -->
      <radialGradient id="rockshade" cx="32%" cy="26%" r="82%">
        <stop offset="0%" stop-color="#000" stop-opacity="0"/>
        <stop offset="55%" stop-color="#000" stop-opacity=".16"/>
        <stop offset="100%" stop-color="#000" stop-opacity=".46"/>
      </radialGradient>
      <!-- the documents' glow: the perimeter line, blurred twice under itself -->
      <filter id="docglow" x="-120%" y="-120%" width="340%" height="340%">
        <feGaussianBlur stdDeviation="5" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <!-- #1062: the end-caps are controls, so this group is no longer hidden
         from a screen reader — it holds the two buttons that step the belt. -->
    <g id="ends"></g>
    <g id="seats"></g>
    <g id="caps"></g>
    <!-- #1072: the pocket's "+N" clump, drawn by belt.behaviour.js on a phone -->
    <g id="clump"></g>
  </svg>

  <!-- #1088: create-v3's lanes — the grid the reading card grows beside.
       The card's own column stays put; the second widens on the paper's own
       side when a preview is open, sliding the item card off centre and the
       pair together (owner-decisions.md §18, design/v19/create-v3.html). -->
  <div class="lanes" id="lanes"
       class:left={previewSide === "left"} class:right={previewSide === "right"}
       class:open={previewOpen} class:editing={editingInCard}>
  <!-- the card, riding at the apex -->
  <div class="cardwrap" id="cardwrap">
    {#if !bodies.length && pocket}
      <!-- The empty household on a phone (§2.3, §1.13): one quiet sentence
           and the two ways in. -->
      <article class="glass item-card ip ip-emptycard">
        <h2>Nothing in orbit yet.</h2>
        <p class="ip-sentence">{data.household?.name ?? "your system"} has nothing on its belt.
          Every item you add takes a seat here in the order it comes due.</p>
        <div class="ip-acts">
          <a class="p-pill wide ip-lead" href={resolve("/create")}>add an item</a>
          <a class="p-pill wide" style="--act:var(--upcoming);--act-text:var(--upcoming-text)"
             href={resolve("/settings/mail")}>set up your relay →</a>
        </div>
      </article>
    {:else if !bodies.length}
      <!-- The empty household. The band is still a belt — ambient rock and
           dust, thinner, because nothing here has swept anything yet. -->
      <article class="glass item-card">
        <h2>Nothing in orbit yet.</h2>
        <a class="back" href={resolve("/inbox")}>open inbox</a>
        <div class="sub">{data.household?.name ?? "your system"} · an empty manifest</div>
        <div class="note">the belt IS the manifest. every item you add takes a seat in it,
          in the order it comes due — sooner to the left, later to the right — and the one
          you are looking at rides at the apex as this card. add the first and the band has
          something to carry.</div>
        <h3>start</h3>
        <div class="acts" role="group" aria-label="Actions">
          <button style="--act:var(--accent);--act-text:var(--accent-text)" onclick={() => goto(resolve("/create"))}>add an item</button>
          <button style="--act:var(--upcoming);--act-text:var(--upcoming-text)" onclick={() => goto(resolve("/inbox"))}>mail something in</button>
        </div>
      </article>
    {:else if cardBody && row && row.suggestion && seatedSuggestion}
      <!-- #1145: THE SUGGESTION'S CARD, in the belt's card position. The
           amend-then-accept card (#434) as it stood on its own page, now
           riding at the apex like any other card: the name is the heading
           and is editable, the proposed fields are the form, fields the
           relay read from the document carry the from-document mark, and
           acceptance is the only path into the household. The old promise
           line is gone on the desk too (owner's 10b): the sub line says when
           the suggestion burns up, and `accept into orbit` is the promise.
           On a phone (round 3 §4) the card holds the readings and the two
           decisions, and `review & amend →` raises the review sheet. -->
      <article class="glass item-card sug-card" class:ip={pocket}
               style="--act:var(--ok);--act-text:var(--ok-text)" aria-label="{row.title} — suggested, not yet in orbit">
        {#if pocket}
          <h2>{row.title}</h2>
          <div class="sub">suggested from your documents · {suggestedFrom}</div>
          {#each readingsOf(seatedSuggestion) as reading (reading.field)}
            <div class="kv"><span>{reading.label}</span>
              <b>{reading.value}{#if reading.sure !== null}<i class="sure" class:unsure={!reading.sure}>{reading.sure ? "sure" : "unsure"}</i>{/if}</b></div>
          {/each}
          {#if unreadable}<p class="ip-sentence">{unreadable}</p>{/if}
          <h3>decide</h3>
          <div class="ip-acts" role="group" aria-label="Suggestion decisions">
            {#if acceptBusy}
              <button class="p-pill wide ip-lead" disabled aria-busy="true">adding…</button>
              <button class="p-pill wide" disabled>Dismiss</button>
            {:else}
              {#if proposalLocked}
                <button class="p-pill wide ip-lead" disabled>Add to orbit</button>
              {:else}
                <ArmButton label="Add to orbit" armedLabel="tap again to add" danger={false} wide class="ip-lead"
                           name="Add {row.title} to your orbit" onfire={() => acceptSuggestion()} />
              {/if}
              <ArmButton label="Dismiss" armedLabel="tap again to dismiss" wide name="Dismiss {row.title}"
                         onfire={dismissSuggestion} />
            {/if}
          </div>
          {#if acceptProblem}<div class="problem" role="alert">{acceptProblem}</div>{/if}
          {#if !proposalLocked}
            <button class="ip-amend" disabled={acceptBusy} aria-haspopup="dialog"
                    onclick={() => { reviewProblem = null; reviewOpen = true; }}>review &amp; amend →</button>
          {/if}
          {#if row.docs.length}
            <!-- The forwarded papers ride staged beside this card; the sheet
                 lists them, and each opens the reading card's staged state. -->
            <button class="ip-docs" onclick={() => raise("docs")}>
              <span class="ip-paper" aria-hidden="true">◆</span>
              <span class="ip-docs-title">{row.docs.length === 1 ? "1 forwarded document" : `${row.docs.length} forwarded documents`}</span>
              <span class="ip-chev">attached on acceptance ›</span>
            </button>
          {/if}
        {:else}
          <input class="name-title" bind:value={sform.title} aria-label="name" class:sugg={marked("title")}
                 disabled={proposalLocked}>
          <div class="sub">suggested from your documents · {suggestedFrom}</div>
          <div class="panel">
            <div class="row2">
              <div class="field" class:sugg={marked("dueDate")}>
                <!-- #1005: a one-off ends; it does not renew and it is not owed. -->
                <label for="s-due">{proposal.scheduleKind === "expiry" ? "ends" : "renews / due"}</label>
                <input id="s-due" type="date" bind:value={sform.dueDate} disabled={proposalLocked}></div>
              <div class="field" class:sugg={marked("recurrenceMonths")}>
                <label for="s-recur">orbital period (months)</label>
                <input id="s-recur" inputmode="numeric" bind:value={sform.recurrenceMonths} disabled={proposalLocked}></div>
            </div>
            <div class="row2">
              <div class="field" class:sugg={marked("provider")}>
                <label for="s-provider">provider</label>
                <input id="s-provider" bind:value={sform.provider} placeholder="optional" disabled={proposalLocked}></div>
              <div class="field" class:sugg={marked("reference")}>
                <label for="s-reference">reference</label>
                <input id="s-reference" bind:value={sform.reference} placeholder="optional" disabled={proposalLocked}></div>
            </div>
            <div class="field mono" class:sugg={marked("costMinor")}>
              <label for="s-cost">cost</label>
              <input id="s-cost" inputmode="decimal" bind:value={sform.cost} placeholder="optional" disabled={proposalLocked}></div>
            {#if row.docs.length}
              <!-- The forwarded paper rides in the belt beside this card, as an
                   item's papers do -- ringed, staged, attached on acceptance;
                   its own name presses through to it (#1155). -->
              <div class="note">{#each row.docs as doc, i (doc.id)}{i > 0 ? " · " : ""}<button
                  type="button" class="ip-paperlink" onclick={() => showPaperById(doc.id)}>◆ {doc.name}</button>{/each}
                {row.docs.length === 1 ? "rides" : "ride"} in the belt beside this card — press it to read it · attached on acceptance.</div>
            {/if}
            {#if unreadable}
              <div class="note">{unreadable}</div>
            {/if}
            <div class="save-row">
              <button class="btn-primary" disabled={acceptBusy || proposalLocked || !sform.title.trim()}
                      onclick={acceptAmendedOnDesk}>accept into orbit</button>
              <button class="btn-quiet" style="--act:var(--overdue);--act-text:var(--overdue-text)"
                      disabled={acceptBusy} onclick={dismissSuggestion}>
                {acceptArmedDismiss ? "tap again to dismiss" : "dismiss"}
              </button>
            </div>
            {#if acceptProblem}
              <div class="problem" role="alert">{acceptProblem}</div>
            {/if}
          </div>
        {/if}
      </article>
    {:else if cardBody && row && record}
      <!-- An item shows the item screen as #424/#455 render it: what it is,
           when it is due, how often it comes round, what it costs, who does
           it, when you will be warned, every command reachable. It does NOT
           list its documents any more — they are out in the band beside it,
           which is the owner's ruling; the card only says so, and how many. -->
      <article class="glass item-card" class:ip={pocket}>
        <h2>{row.title}</h2>
        <div class="sub">{[row.section, row.kind].filter(Boolean).join(" · ")}</div>
        {#if !editingInCard}
        <!-- #1005: a one-off ends on its day; nothing is due on it. -->
        <div class="kv"><span>{row.kind === "expiry" ? "ends" : "due"}</span><b class={row.urg}>{row.t} · {row.longWhen}</b></div>
        {#if row.snoozedUntil}
          <div class="kv"><span>snoozed until</span><b>{longDate(row.snoozedUntil)}</b></div>
        {/if}
        {#if row.status !== "active"}
          <div class="kv"><span>status</span><b>{row.status}</b></div>
        {/if}
        {#if row.kind === "expiry"}
          <div class="kv"><span>orbital period</span><b>one-off — does not come round</b></div>
        {:else if row.months}
          <div class="kv"><span>orbital period</span><b>{every(row.months)}</b></div>
        {/if}
        <div class="kv"><span>cost</span><b>{money(row.cost, row.currency, row.costIsEstimate)}</b></div>
        {#if row.provider}
          <div class="kv"><span>provider</span><b>{row.provider}</b></div>
        {/if}
        <!-- #941: the row renders on the marker as well as on the value. Both
             states used to vanish behind a truthiness test, so a reference
             Orbit could not read looked exactly like one nobody had entered. -->
        {#if row.reference}
          <div class="kv"><span>reference</span><b>{row.reference}</b></div>
        {:else if referenceState === DAMAGED}
          <div class="kv"><span>reference</span>
            <b class="failed"><i aria-hidden="true"></i>{REFERENCE_WORDS[DAMAGED]}</b></div>
        {:else if referenceState === LOCKED}
          <div class="kv"><span>reference</span><b class="locked">{REFERENCE_WORDS[LOCKED]}</b></div>
        {/if}
        {#if row.remind.length}
          <div class="kv"><span>reminders</span><b>{remindOf(row.remind)}</b></div>
        {/if}
        {/if}

        <h3>actions</h3>
        {#if pocket}
          <!-- §2.3: complete first and full width; then reschedule · snooze;
               then edit · retire. Every panel is a sheet; retire arms here
               and asks in its own callout. -->
          <div class="ip-acts" role="group" aria-label="Item actions">
            {#if row.status === "active"}
              <button class="p-pill wide ip-lead ip-complete" disabled={busy}
                      onclick={() => tapComplete(record)}>complete</button>
              <div class="ip-pair">
                <button class="p-pill" style="--act:var(--upcoming);--act-text:var(--upcoming-text)"
                        onclick={() => act("reschedule", record)}>reschedule</button>
                <button class="p-pill" style="--act:var(--warm);--act-text:var(--warm-text)"
                        onclick={() => act("snooze", record)}>snooze</button>
              </div>
              <div class="ip-pair">
                <button class="p-pill" style="--act:var(--accent);--act-text:var(--accent-text)"
                        onclick={() => act("edit", record)}>edit</button>
                <ArmButton label="retire" name="Retire {row.title}" onfire={() => act("retire", record)} />
              </div>
            {:else}
              <button class="p-pill wide ip-lead ip-complete" disabled={busy}
                      onclick={() => run(() => statusCommand(record, "active"))}>restore</button>
              {#if row.status !== "archived"}
                <ArmButton label="retire" name="Retire {row.title}" wide onfire={() => act("retire", record)} />
              {/if}
            {/if}
          </div>
        {:else}
        <div class="acts" role="group" aria-label="Item actions">
          {#if row.status === "active"}
            <button style="--act:var(--ok);--act-text:var(--ok-text)" aria-pressed={panel === "complete"}
                    onclick={() => open("complete", record)}>complete</button>
            <button style="--act:var(--upcoming);--act-text:var(--upcoming-text)" aria-pressed={panel === "reschedule"}
                    onclick={() => open("reschedule", record)}>reschedule</button>
            <button style="--act:var(--warm);--act-text:var(--warm-text)" aria-pressed={panel === "snooze"}
                    onclick={() => open("snooze", record)}>snooze</button>
            <button style="--act:var(--accent);--act-text:var(--accent-text)" aria-pressed={panel === "edit"}
                    onclick={() => open("edit", record)}>edit</button>
            <button style="--act:var(--overdue);--act-text:var(--overdue-text)" aria-pressed={panel === "retire"}
                    onclick={() => open("retire", record)}>retire</button>
          {:else}
            <button style="--act:var(--ok);--act-text:var(--ok-text)" disabled={busy}
                    onclick={() => run(() => statusCommand(record, "active"))}>restore</button>
            {#if row.status !== "archived"}
              <button style="--act:var(--overdue);--act-text:var(--overdue-text)" aria-pressed={panel === "retire"}
                      onclick={() => open("retire", record)}>retire</button>
            {/if}
          {/if}
        </div>

        {#if panel === "complete"}
          <div class="panel" style="--act:var(--ok);--act-text:var(--ok-text)">
            <div class="row2">
              <div class="field"><label for="a-done">completed on</label>
                <input id="a-done" type="date" bind:value={form.completedDate}></div>
              {#if record.recurrenceMonths}
                <div class="field"><label for="a-next">next orbit</label>
                  <input id="a-next" type="date" bind:value={form.nextDate}></div>
              {/if}
            </div>
            <div class="row2">
              <div class="field mono"><label for="a-cost">actual cost</label>
                <input id="a-cost" inputmode="decimal" bind:value={form.cost} placeholder="optional"
                       disabled={locked}></div>
            </div>
            <div class="field"><label for="a-cnotes">notes</label>
              <input id="a-cnotes" bind:value={form.notes} placeholder="optional"></div>
            {#if locked}
              <div class="note">{COST_LOCKED}</div>
            {:else if formCostInvalid}
              <div class="note">{COST_FORMAT_HINT}</div>
            {/if}
            <div class="save-row">
              <button class="btn-primary" disabled={busy || !form.completedDate || formCostInvalid}
                onclick={() => run(() => completeCommand(record, {
                  completedDate: form.completedDate,
                  nextDate: form.nextDate || undefined,
                  costMinor: minorOf(form.cost),
                  notes: (form.notes ?? "").trim() || undefined,
                }), { leave: !form.nextDate })}>complete</button>
              <button class="cancel-link" onclick={closePanel}>never mind</button>
            </div>
          </div>
        {/if}

        {#if panel === "reschedule"}
          <div class="panel" style="--act:var(--upcoming);--act-text:var(--upcoming-text)">
            <div class="field"><label for="a-due">new due date</label>
              <input id="a-due" type="date" bind:value={form.dueDate}></div>
            <div class="save-row">
              <button class="btn-primary" disabled={busy || !form.dueDate}
                onclick={() => run(() => rescheduleCommand(record, form.dueDate))}>reschedule</button>
              <button class="cancel-link" onclick={closePanel}>never mind</button>
            </div>
          </div>
        {/if}

        {#if panel === "snooze"}
          <div class="panel" style="--act:var(--warm);--act-text:var(--warm-text)">
            <div class="field"><label for="a-until">snooze until</label>
              <input id="a-until" type="date" bind:value={form.until}></div>
            <div class="save-row">
              <button class="btn-primary" disabled={busy || !form.until}
                onclick={() => run(() => snoozeCommand(record, form.until))}>snooze</button>
              <button class="cancel-link" onclick={closePanel}>never mind</button>
            </div>
          </div>
        {/if}

        {#if panel === "edit"}
          <!-- #941. Damaged: the input stays enabled and seeded empty, and its
               placeholder says what saving will do -- the panel is where that
               has to be visible, because a full-row upsert writes the field
               whether or not it was touched, so a member saving past the
               placeholder has decided. Locked: every input, not only the two
               encrypted ones, because item.upsert is refused whole. -->
          <div class="panel" style="--act:var(--accent);--act-text:var(--accent-text)">
            <div class="field"><label for="e-title">title</label>
              <input id="e-title" bind:value={form.title} disabled={locked}></div>
            <div class="row2">
              <div class="field"><label for="e-provider">provider</label>
                <input id="e-provider" bind:value={form.provider} placeholder="optional" disabled={locked}></div>
              <div class="field"><label for="e-reference">reference</label>
                <input id="e-reference" bind:value={form.reference} disabled={locked}
                       placeholder={referenceState === DAMAGED ? DAMAGED_PLACEHOLDER : "optional"}></div>
            </div>
            <div class="row2">
              <div class="field mono"><label for="e-cost">cost</label>
                <input id="e-cost" inputmode="decimal" bind:value={form.cost} placeholder="optional" disabled={locked}></div>
              <div class="field"><label for="e-due">due date</label>
                <input id="e-due" type="date" bind:value={form.dueDate} disabled={locked}></div>
            </div>
            <div class="field"><label for="e-recur">orbital period (months)</label>
              <input id="e-recur" inputmode="numeric" bind:value={form.recurrenceMonths} placeholder="optional"
                     disabled={locked}></div>
            <div class="field"><label for="e-notes">notes</label>
              <textarea id="e-notes" rows="3" bind:value={form.notes} disabled={locked}
                        placeholder={notesState === DAMAGED ? DAMAGED_PLACEHOLDER : "optional"}></textarea></div>
            {#if locked}
              <div class="note">{PANEL_LOCKED}</div>
            {:else if formCostInvalid}
              <div class="note">{COST_FORMAT_HINT}</div>
            {/if}
            <div class="save-row">
              <button class="btn-primary" disabled={busy || locked || !form.title?.trim() || formCostInvalid}
                onclick={() => run(() => upsertCommand(record, editsOf()))}>save changes</button>
              <button class="cancel-link" onclick={closePanel}>never mind</button>
            </div>
          </div>
        {/if}

        {#if panel === "retire"}
          <div class="panel" style="--act:var(--overdue);--act-text:var(--overdue-text)">
            <div class="note">
              retiring takes this item off the belt — archive keeps its history;
              cancel marks it stood down and it can be restored later
            </div>
            <div class="save-row">
              <button class="btn-primary" disabled={busy}
                onclick={() => tap("archive", () => run(() => archiveCommand(record), { leave: true }))}>
                {armed === "archive" ? "tap again to archive" : "archive"}</button>
              {#if row.status === "active"}
                <button class="btn-quiet" disabled={busy}
                  onclick={() => tap("cancel", () => run(() => statusCommand(record, "cancelled")))}>
                  {armed === "cancel" ? "tap again to cancel" : "cancel item"}</button>
              {/if}
              <button class="cancel-link" onclick={closePanel}>never mind</button>
            </div>
          </div>
        {/if}

        {/if}

        {#if problem}
          <div class="problem" role="alert">{problem}</div>
        {/if}

        {#if !editingInCard}
        {#if row.notes}
          <h3>notes</h3>
          <p>{row.notes}</p>
        {:else if notesState}
          <h3>notes</h3>
          <p class={notesState === DAMAGED ? "failed" : "locked"}>{NOTES_WORDS[notesState]}</p>
        {/if}

        {#if pocket && row.docs.length}
          <!-- §2.3: the documents ride in the belt; this row lists them all. -->
          <button class="ip-docs" onclick={() => raise("docs")}>
            <span class="ip-paper" aria-hidden="true">◆</span>
            <span class="ip-docs-title">{row.docs.length === 1 ? "1 document" : `${row.docs.length} documents`}</span>
            <span class="ip-chev">see {row.docs.length === 1 ? "it" : "them"} ›</span>
          </button>
        {:else if pocket}
          <p class="ip-sentence">No documents yet. Anything you attach, or mail in to your relay,
            rides in the belt beside this item.</p>
        {:else if row.docs.length}
          <div class="note"><b>{row.docs.length === 1
            ? "one document rides"
            : `${row.docs.length} documents ride`}</b>
            in the belt beside this item — the ringed bodies either side. click one to bring
            it in.</div>
        {:else}
          <div class="note">no documents yet — anything you attach, or mail in to your
            relay, takes a seat in the belt beside this item.</div>
        {/if}
        {/if}
      </article>
    {/if}
  </div>

  <!-- #1088: the reading card. Mounted only while a preview is on its way in
       or out — the fade needs the element there to fade, and mounting it
       unconditionally would hand a screen reader a dialog with nothing in
       it. `hidden` is never set while mounted: `previewOpen` alone drives
       the CSS transition (belt.css's `.readcard.open`), same law as
       create-v3's own `body.doc .readcard`. -->
  {#if previewDoc && !pocket}
    {@const state = previewState}
    <aside class="glass readcard" id="readcard" class:open={previewOpen}
           class:snap={previewShowing} class:still={state !== "available"}
           class:rc-refused={state === "refused"}
           role="dialog" aria-label={previewDoc.name} tabindex="-1">
      <div class="pagebox">
        {#if state === "available" && !previewShowing}
          <!-- create-v3's focus block, verbatim: the reticle, the owner's
               words breathing while the page is on its way. -->
          <div class="focus">
            <svg class="reticle" viewBox="0 0 96 96" aria-hidden="true">
              <circle cx="48" cy="48" r="43" fill="none" stroke="var(--chart-line)" stroke-width="1"
                      stroke-dasharray="3 7" opacity=".8"/>
              <g class="sweep">
                <line x1="48" y1="5" x2="48" y2="14" stroke="var(--accent)" stroke-width="1.2" opacity=".8"/>
                <line x1="48" y1="82" x2="48" y2="91" stroke="var(--accent)" stroke-width="1.2" opacity=".35"/>
              </g>
              <g class="pull" fill="none" stroke="var(--accent)" stroke-width="1.1" opacity=".7">
                <path d="M 26 18 H 18 V 26"/><path d="M 70 18 H 78 V 26"/>
                <path d="M 26 78 H 18 V 70"/><path d="M 70 78 H 78 V 70"/>
              </g>
              <circle cx="48" cy="48" r="16" fill="none" stroke="var(--chart-line)" stroke-width="1" opacity=".9"/>
              <circle cx="48" cy="48" r="1.8" fill="var(--accent)"/>
            </svg>
            <div class="focusline">Focusing on the anomaly</div>
            <div class="why">orbit is drawing the page it holds<br>nothing is changed, and nothing is assumed</div>
          </div>
        {:else if state === "scanning"}
          <div class="focus">
            <div class="plate scanning" aria-hidden="true">still scanning</div>
            <div class="focusline">Still scanning this file</div>
            <div class="why">the page comes once it scans clean<br>nothing is assumed</div>
          </div>
        {:else if state === "removed"}
          <div class="focus">
            <div class="plate removed" aria-hidden="true">being removed</div>
            <div class="focusline">Removed</div>
            <div class="why">orbit keeps it {previewDoc.deleteAfter ? `until ${previewDoc.deleteAfter}` : "for 30 days"}, then it is gone for good<br>restore puts it back exactly as it was</div>
          </div>
        {:else if state === "refused"}
          <div class="focus">
            <div class="plate" aria-hidden="true">refused</div>
            <div class="focusline">Orbit refused this file.</div>
            <div class="why">it did not pass what orbit checks before keeping a file<br>nothing here can be undone</div>
          </div>
        {:else if state === "undrawable"}
          <div class="focus">
            <div class="plate" aria-hidden="true">{previewDoc.plate}</div>
            <div class="focusline">Orbit could not draw a picture of this document.</div>
            {#if previewDoc.staged}
              <div class="why">it scanned clean, and is still attached on acceptance<br>orbit just could not turn it into a page to read here</div>
            {:else}
              <div class="why">the file is fine — scanned clean, and yours to download<br>orbit just could not turn it into a page to read here</div>
            {/if}
          </div>
        {:else if state === "staged"}
          <!-- #1155: the one paper Orbit genuinely cannot draw a page for --
               named, but not a PDF (or the count-only fallback). The plate
               held still, the line says what is happening, and the foot
               holds nothing, because nothing can be done with it here. -->
          <div class="focus">
            <div class="plate" aria-hidden="true">{previewDoc.plate}</div>
            <div class="focusline">Not yet in orbit.</div>
            <div class="why">this paper came with the mail and is attached on acceptance<br>orbit has no page to show for it</div>
          </div>
        {:else if state === "gone"}
          <!-- #1155: the mail was decided or burned up between the belt
               listing it and the preview answering -- never a guess, and
               never conflated with "could not draw". No foot: there is
               nothing left to act on from here. -->
          <div class="focus">
            <div class="plate" aria-hidden="true">{previewDoc.plate}</div>
            <div class="focusline">This mail has gone.</div>
            <div class="why">it burned up, or was decided from another screen<br>orbit keeps nothing of it</div>
          </div>
        {/if}

        {#if state === "available"}
          <div class="topsheet">
            <!-- §18 on the desk too (#1298): the page is a button, and pressing
                 it opens the reader over the belt, as the phone's does. -->
            <button type="button" class="sheet" aria-label="Read {previewDoc.name}"
                    disabled={!previewShowing || previewDoc.staged} onclick={() => { readerOpen = true; }}>
              <!-- previewSrc starts "" for a staged paper, while loadStagedPage's
                   fetch is still in flight (#1155's own build, fixed here): an
                   `<img src="">` is not "no image" to a browser, it is a request
                   for the current page, which then fails to decode and fires
                   onerror immediately -- wrongly and permanently locking the
                   card into "could not draw". `|| undefined` omits the
                   attribute instead of setting it empty, so no such request is
                   ever made; a non-staged document's previewSrc is never empty,
                   so this changes nothing for it. -->
              <img src={previewSrc || undefined} alt={previewAlt}
                   onload={previewLoaded} onerror={previewFailed} />
            </button>
          </div>
        {/if}
      </div>

      {#if previewPaged}
        <!-- #1300, round 6: under the page, its number, and an arrow each way
             only where there is a page that way. -->
        <Pager page={previewPage} count={previewPageCount} onturn={turnPreview} />
        {#if previewProblem}
          <div class="problem" role="alert">{previewProblem}</div>
        {/if}
      {:else if state === "available" && previewDoc.staged}
        <!-- #1155: the one deliberate extension of §18's foot rule -- nothing
             can be done with a staged paper here, and the foot says why in
             one line rather than staying empty. -->
        <div class="rcfoot"><span class="rcnote">not yet in orbit · attached on acceptance</span></div>
      {:else if state === "removed"}
        <div class="rcfoot">
          <button type="button" class="quiet" disabled={previewRestoring}
                  onclick={restorePreviewDoc}>restore</button>
        </div>
        {#if previewProblem}
          <div class="problem" role="alert">{previewProblem}</div>
        {/if}
      {:else if state === "undrawable" && !previewDoc.staged}
        <div class="rcfoot">
          <!-- Same cast the old docview card used: doc.href is a download
               endpoint, not a page route -- outside resolve()'s typed route
               union, but still the right runtime value. -->
          <a class="quiet" href={resolve(/** @type {"/home"} */ (previewDoc.href))} download>download</a>
        </div>
      {/if}
    </aside>
  {/if}
  </div>

  <!-- the nearest few per cent of the band: rubble that passes in FRONT -->
  <canvas id="fore" aria-hidden="true"></canvas>

  <!-- §14's "well-placed search box": the belt's way into the manifest -->
  <div class="find">
    <input id="find" type="search" placeholder="find an item — name, section, provider, document"
           aria-label="Find an item in the belt" autocomplete="off" spellcheck="false"
           aria-describedby="findnote" bind:this={findEl} oninput={onFind} onkeydown={onFindKey}>
    <div class="findnote" id="findnote">{findnote}</div>
    <!-- The hit list drops BESIDE the field, not beneath it: beneath it is
         where the card is, and the search must never cover the thing you are
         looking at. -->
    <div class="hits" class:open={Boolean(query.trim()) && bodies.length > 0}
         id="hits" role="listbox" aria-label="Matching items">
      {#if query.trim() && !hitList.length}
        <div class="none">no item, section, provider or document by that name</div>
      {:else}
        {#each hitList.slice(0, 7) as i (bodies[i].id)}
          <button type="button" class:pick={i === nearest}
                  onmousedown={(event) => event.preventDefault()}
                  onclick={() => goTo(i)}>
            <b>{bodies[i].kind === "doc" ? bodies[i].doc.name : bodies[i].label}</b>
            <small style="color:{bodies[i].tone}">{bodies[i].kind === "doc" ? "document" : bodies[i].t}</small>
            <small>{bodies[i].kind === "doc" ? bodies[i].sub : bodies[i].when}</small>
          </button>
        {/each}
      {/if}
    </div>
  </div>
</div>

<!-- #1072: every panel, list and preview on a phone is this one kit Sheet;
     `face` says which. On a desk it is never raised. -->
<Sheet bind:open={sheetOpen} size={face ? SHEET_SIZE[face] : "callout"} title={sheetTitle}
       hideTitle={face === "search" || face === "preview"} onclose={sheetClosed}
       confirmDiscard={panelDirty}>
  <!-- The search field rides in the sheet's head (§2.4). Declared in here
       rather than at the top of the markup: a top-level snippet trips the
       production bundler (#1130). -->
  {#snippet head()}
    {#if face === "preview"}
      <!-- the title is for the dialog's name only (§18: no head); this keeps
           `close` at the head's far end where it always is -->
      <span class="bp-spacer" aria-hidden="true"></span>
    {/if}
    {#if face === "search"}
      <input class="bp-field-find" type="search" placeholder="find an item" aria-label="Find an item in the belt"
             autocomplete="off" spellcheck="false" enterkeyhint="go" bind:value={pocketQuery} onkeydown={findKey}>
    {/if}
  {/snippet}
  <div class="bp-sheet">
  {#if face === "complete" && record}
    <p class="bp-lede">{row?.title}</p>
    <div class="bp-row2">
      <div class="bp-field"><label for="p-done">completed on</label>
        <input id="p-done" type="date" bind:value={form.completedDate}></div>
      {#if record.recurrenceMonths}
        <div class="bp-field"><label for="p-next">next orbit</label>
          <input id="p-next" type="date" bind:value={form.nextDate}></div>
      {/if}
    </div>
    <div class="bp-field"><label for="p-cost">actual cost</label>
      <input id="p-cost" class="mono" inputmode="decimal" enterkeyhint="next" bind:value={form.cost}
             placeholder="optional" disabled={locked}></div>
    <div class="bp-field"><label for="p-cnotes">note</label>
      <input id="p-cnotes" bind:value={form.notes} placeholder="optional" enterkeyhint="done"></div>
    {#if locked}<p class="bp-note">{COST_LOCKED}</p>
    {:else if formCostInvalid}<p class="bp-note">{COST_FORMAT_HINT}</p>{/if}
  {:else if face === "reschedule" && record}
    <p class="bp-lede">{row?.title} · due {row?.longWhen}</p>
    <div class="bp-field"><label for="p-due">new due date</label>
      <input id="p-due" type="date" bind:value={form.dueDate}></div>
    <div class="p-pills bp-quick" role="group" aria-label="Move it on by">
      {#each [[1, "+1 month"], [3, "+3 months"], [12, "+1 year"]] as [months, word] (months)}
        <button class="p-pill" aria-pressed={form.dueDate === monthsOn(record.dueDate ?? todayISO(), Number(months))}
                onclick={() => { form.dueDate = monthsOn(record.dueDate ?? todayISO(), Number(months)); }}>{word}</button>
      {/each}
    </div>
  {:else if face === "snooze" && record}
    <p class="bp-lede">{row?.title} · due {row?.longWhen}</p>
    <div class="p-pills bp-quick" role="group" aria-label="Snooze for">
      <button class="p-pill" aria-pressed={form.until === daysOn(todayISO(), 7)}
              onclick={() => { form.until = daysOn(todayISO(), 7); }}>1 week</button>
      <button class="p-pill" aria-pressed={form.until === monthsOn(todayISO(), 1)}
              onclick={() => { form.until = monthsOn(todayISO(), 1); }}>1 month</button>
    </div>
    <div class="bp-field"><label for="p-until">or until</label>
      <input id="p-until" type="date" bind:value={form.until}></div>
  {:else if face === "edit" && record && editEntry}
    <!-- §2.3/§2.5: edit is create's form in edit mode (EntryForm.svelte):
         type locked, no household or document row, `save` at the sheet's
         foot. #941 carries over: damaged fields stay open and say what saving
         does; locked locks every field, because item.upsert is refused whole.
         A failure is loud and keeps the sheet up with what was typed. -->
    <EntryForm bind:entry={editEntry} households={data.household ? [data.household] : []} mode="edit" nested
               disabled={locked || busy} {referenceState} {notesState} />
    {#if locked}<p class="bp-note">{PANEL_LOCKED}</p>{/if}
    {#if problem}<p class="p-error" role="alert">{problem}</p>
    {:else if editRefusal}<p class="bp-note" id="pe-refusal">{editRefusal}</p>{/if}
  {:else if face === "retire" && record}
    <p class="bp-lede prose">It leaves the belt and the dial. Its history and its documents are kept.</p>
  {:else if face === "docs" && row}
    <div class="bp-list">
      {#each row.docs as doc (doc.id)}
        <Row title={doc.name} meta={[doc.size, doc.plate, doc.staged ? "attached on acceptance" : (doc.added === "unknown" ? null : `added ${doc.added}`)].filter(Boolean).join(" · ")}
             onactivate={() => showPaper(doc)}>
          {#snippet mark()}<span class="bp-paper" aria-hidden="true">◆</span>{/snippet}
        </Row>
      {/each}
    </div>
  {:else if face === "preview" && previewDoc}
    {@const state = previewState}
    <!-- §18 on a phone: the page nearly edge to edge on the cream sheet with
         the tilted second sheet under it, and nothing else. The page is a
         button: it opens the reader. The honest states hold the plate still:
         the line says what is happening; the foot holds only what can be
         done. -->
    {#if previewDoc.staged}
      <!-- #1155: a staged paper draws through StagedPage, which owns its own
           fetch (loadStagedPage), its own loading/page/gone/undrawable states
           and its own Reader. The accepted-document face below is untouched. -->
      <StagedPage href={previewDoc.previewHref} name={previewDoc.name}
                  drawable={Boolean(previewDoc.previewHref)} reader itemTitle={row?.title ?? ""} />
    {:else if state === "available"}
      <button class="bp-page" class:shown={previewShowing} class:paged={previewPaged} disabled={!previewShowing}
              aria-label="Read {previewDoc.name}" onclick={() => { readerOpen = true; }}>
        <span class="bp-under" aria-hidden="true"></span>
        <img src={previewSrc || undefined} alt={previewAlt}
             onload={previewLoaded} onerror={previewFailed} />
      </button>
      {#if !previewShowing}<p class="bp-line quiet" aria-live="polite">Orbit is drawing the page</p>{/if}
      <!-- #1300: the same pager as the desk's, under the page. -->
      {#if previewPaged}<Pager page={previewPage} count={previewPageCount} onturn={turnPreview} />{/if}
      {#if previewPaged && previewProblem}<p class="p-error" role="alert">{previewProblem}</p>{/if}
    {:else}
      <div class="bp-honest">
        <div class="bp-plate" class:scanning={state === "scanning"} aria-hidden="true">
          {state === "scanning" ? "still scanning" : state === "removed" ? "removed" : state === "refused" ? "refused" : previewDoc.plate}
        </div>
        {#if state === "scanning"}
          <p class="bp-line">Still checking this file</p>
          <p class="bp-why">the page comes once it scans clean</p>
        {:else if state === "removed"}
          <p class="bp-line">Removed</p>
          <p class="bp-why">kept {previewDoc.deleteAfter ? `until ${previewDoc.deleteAfter}` : "for 30 days"}, then gone for good</p>
          {#if previewProblem}<p class="p-error" role="alert">{previewProblem}</p>{/if}
        {:else if state === "refused"}
          <p class="bp-line">Orbit refused this file.</p>
          <p class="bp-why">it did not pass what Orbit checks before keeping a file</p>
        {:else}
          <p class="bp-line">Orbit could not draw a picture of this document.</p>
          <p class="bp-why">the file is fine and yours to download</p>
        {/if}
      </div>
    {/if}
  {:else if face === "search"}
    <div class="bp-list">
      {#if found.nothing}
        <p class="p-empty">nothing in your orbit is called “{found.query}”</p>
        <Row title={`add “${found.query}” as an item`} href={resolve("/create")}>
          {#snippet mark()}<span class="bp-plus" aria-hidden="true">+</span>{/snippet}
        </Row>
      {:else}
        {#each found.items as hit (hit.body.id)}
          <Row title={hit.body.label} meta={hit.body.kind === "item" ? [hit.body.item.section, hit.body.when].filter(Boolean).join(" · ") : ""}
               trail={hit.body.kind === "item" ? hit.body.t : ""} trailTone={hit.body.tone}
               current={hit.index === selected} onactivate={() => approach(hit.index)}>
            {#snippet mark()}<span class="bp-dot" style:background={hit.body.tone}></span>{/snippet}
          </Row>
        {/each}
        {#each found.documents as hit (hit.doc.id)}
          <Row title={hit.doc.name} meta={`${hit.itemTitle} · ${hit.doc.size}`} onactivate={() => approachPaper(hit)}>
            {#snippet mark()}<span class="bp-paper" aria-hidden="true">◆</span>{/snippet}
          </Row>
        {/each}
        {#if !found.query}<Row title="→ add an item" href={resolve("/create")} />{/if}
      {/if}
    </div>
  {/if}
  </div>
  {#snippet foot()}
    {#if face === "complete" && record}
      <button class="p-pill filled bp-go" style="--act:var(--ok);--act-text:var(--ok-text)"
              disabled={busy || !form.completedDate || formCostInvalid}
              onclick={() => {
                const fields = {
                  completedDate: /** @type {string} */ (form.completedDate),
                  nextDate: form.nextDate || undefined,
                  costMinor: minorOf(form.cost),
                  notes: (form.notes ?? "").trim() || undefined,
                };
                const item = record;
                sheetOpen = false;
                holdCompletion(item, fields);
              }}>record</button>
    {:else if face === "reschedule" && record}
      <button class="p-pill filled bp-go" style="--act:var(--upcoming)" disabled={busy || !form.dueDate}
              onclick={() => { const item = record, due = form.dueDate; sheetOpen = false; run(() => rescheduleCommand(item, due)); }}>reschedule</button>
    {:else if face === "snooze" && record}
      <button class="p-pill filled bp-go" style="--act:var(--warm)" disabled={busy || !form.until}
              onclick={() => { const item = record, until = form.until; sheetOpen = false; run(() => snoozeCommand(item, until)); }}>snooze</button>
    {:else if face === "edit" && record && editEntry}
      <button class="p-pill filled bp-go" disabled={busy || locked || Boolean(editRefusal)}
              aria-describedby={editRefusal ? "pe-refusal" : undefined}
              onclick={saveEdit}>{busy ? "saving…" : "save"}</button>
    {:else if face === "retire" && record}
      <button class="p-pill" onclick={() => { sheetOpen = false; }}>keep</button>
      <button class="p-pill bp-danger" disabled={busy}
              onclick={() => { const item = record; sheetOpen = false; run(() => archiveCommand(item), { leave: true }); }}>retire</button>
    {:else if face === "preview" && previewDoc && !previewDoc.staged}
      {#if previewState === "removed"}
        <button class="p-pill bp-restore" disabled={previewRestoring} onclick={restorePreviewDoc}>restore</button>
      {:else if previewState === "undrawable"}
        <a class="p-pill bp-restore" href={resolve(/** @type {"/home"} */ (previewDoc.href))} download>download</a>
      {/if}
    {/if}
  {/snippet}
</Sheet>

{#if previewDoc && previewShowing && row && !previewDoc.staged}
  <Reader bind:open={readerOpen} doc={previewDoc} itemTitle={row.title} onremove={removePreviewDoc}
          bind:pageNo={() => previewPage, turnPreview} />
{/if}

<!-- #1145, round 3 §4: on a phone the suggestion's `review & amend →` raises
     the one review sheet the inbox and home raise too. Mounted only while a
     suggestion is seated, so an ordinary belt carries no second dialog. -->
{#if pocket && seatedSuggestion}
  <ReviewSheet bind:open={reviewOpen} title={seatedSuggestion.proposal?.title ?? seatedSuggestion.title ?? ""}
               proposal={seatedSuggestion.proposal} householdId={seatedSuggestion.householdId ?? primaryHousehold}
               households={suggestionHouseholds} readings={formReadingsOf(seatedSuggestion)}
               papers={papersOf(seatedSuggestion)} receiptId={seatedSuggestion.receiptId ?? null}
               busy={acceptBusy} problem={reviewProblem} onsave={saveReview} />
{/if}
