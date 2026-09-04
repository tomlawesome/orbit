/**
 * The seam between the v19 front end and the server that already exists.
 *
 * Nothing here is new server work: `GET /api/workspace` returns the signed-in
 * user's whole workspace, `POST /api/workspace/commands` applies a command
 * from `workspaceCommandSchema`, and `GET /api/auth/session` hands out the
 * per-session CSRF token those commands must carry. This module is the only
 * place the front end knows those URLs, so the Next-to-adapter-node cut has
 * one file to touch rather than a screen's worth of scattered fetches.
 *
 * Same-origin throughout: the server asserts it (`assertSameOrigin`), and in
 * production one process serves both the pages and the API.
 */

/* ---------------------------------------------------------------------------
 * The shapes this seam speaks in (#624).
 *
 * Copies of the engine's own schemas in src/lib/workspace.ts, not imports of
 * them: web/ is a separate package that has to build without the server's
 * TypeScript — the same reason the URLs are written out here rather than
 * shared. Where the two can drift the schema is the truth and this is the
 * copy, so a field added there belongs here too.
 *
 * Nullable-and-optional where the schema says only optional: the fixtures
 * write `null` for absent text (`provider: null`), so both reach the screens
 * and a type that admitted only `undefined` would be describing a stricter
 * world than the one the code actually runs in.
 */

/**
 * One entry in a household's manifest — workspaceItemSchema, plus the
 * `documentCount` the workspace route adds on the way out. That last one is
 * not in the schema and is optional here for that reason; the seam reads it
 * only to decide which items are worth asking for documents about.
 *
 * @typedef {object} WorkspaceItem
 * @property {string} id
 * @property {string} sectionId
 * @property {string} title
 * @property {string} currency          ISO-4217, always three letters
 * @property {string} status            itemStatuses
 * @property {?string} [subtype]
 * @property {?string} [provider]
 * @property {?string} [reference]
 * @property {?string} [notes]
 * @property {?number} [costMinor]
 * @property {?string} [dueDate]        calendar date, YYYY-MM-DD
 * @property {?string} [snoozedUntil]   calendar date, YYYY-MM-DD
 * @property {?string} [scheduleKind]   scheduleKinds
 * @property {?number} [recurrenceMonths]
 * @property {?number[]} [reminderDays]
 * @property {number} [version]         rides along for #424's writes
 * @property {string} [updatedAt]       ISO-8601, likewise
 * @property {number} [documentCount]   not a schema field; see above
 */

/**
 * A section of one household — workspaceSectionSchema. `icon` and `accent` are
 * bounded server-side (sectionIcons, sectionAccents); they are plain strings
 * here because this module never branches on either, it passes them through.
 *
 * @typedef {object} WorkspaceSection
 * @property {string} id
 * @property {string} name
 * @property {string} icon
 * @property {string} accent
 * @property {boolean} visible
 */

/**
 * One thing that happened to an item — itemActivitySchema. Carried, never read
 * here: the seam hands activities to the screens whole.
 *
 * @typedef {object} ItemActivity
 * @property {string} id
 * @property {string} itemId
 * @property {string} kind
 * @property {string} occurredAt
 * @property {?string} [effectiveDate]
 * @property {?string} [previousDate]
 * @property {?string} [nextDate]
 * @property {?number} [costMinor]
 * @property {?string} [notes]
 */

/**
 * One household as a member sees it — householdWorkspaceSchema.
 *
 * @typedef {object} Household
 * @property {string} id
 * @property {string} name
 * @property {string} timezone
 * @property {string} currency
 * @property {number} [memberCount]
 * @property {boolean} [canManage]
 * @property {boolean} [onboardingComplete]
 * @property {string} [deletionRequestedAt]
 * @property {string} [deleteAfter]
 * @property {WorkspaceSection[]} sections
 * @property {WorkspaceItem[]} items
 * @property {ItemActivity[]} [activities]
 * @property {string[]} [readNotificationIds]
 * @property {string[]} [dismissedNotificationIds]
 */

/**
 * §11 (#453): the entire surface a non-member sees — an id, a name, and
 * whether they have already asked. visibleHouseholdSchema.
 *
 * @typedef {object} VisibleHousehold
 * @property {string} id
 * @property {string} name
 * @property {boolean} [requested]
 */

/**
 * A household waiting out its deletion countdown — recoverableHouseholdSchema.
 *
 * @typedef {object} RecoverableHousehold
 * @property {string} id
 * @property {string} name
 * @property {string} deleteAfter
 */

/**
 * What `GET /api/workspace` answers — workspaceSchema — plus the two fields
 * the fixture adds that no API response carries. `fixtureToday` pins chart
 * arithmetic to the date the mockups were drawn against so the fidelity gate
 * is deterministic; `suggestions` predates #454 and is empty in the fixture
 * today. Both are optional because live data simply does not have them.
 *
 * @typedef {object} Workspace
 * @property {?string} activeHouseholdId
 * @property {Household[]} households
 * @property {number} [version]
 * @property {string} [householdLanding]        "active" | "choose"
 * @property {RecoverableHousehold[]} [recoverableHouseholds]
 * @property {VisibleHousehold[]} [visibleHouseholds]
 * @property {string} [fixtureToday]            not an API field
 * @property {ReceiptSuggestion[]} [suggestions] not an API field
 */

/**
 * The signed-in user, as `GET /api/auth/session` reports them.
 *
 * @typedef {object} SessionUser
 * @property {string} id
 * @property {string} [displayName]
 * @property {string} [email]
 */

/**
 * A session, with the CSRF token every mutating request must echo back.
 *
 * @typedef {object} Session
 * @property {string} csrfToken
 * @property {boolean} [authenticated]
 * @property {?SessionUser} [user]
 */

/**
 * One piece of mail the relay caught, in the shape `GET /api/imap-inbox`
 * answers. `attachments` is not an API field yet (#467) — the fixture carries
 * it so the ratified design renders, and live data degrades to the count.
 *
 * @typedef {object} Receipt
 * @property {string} id
 * @property {boolean} canApprove
 * @property {string} classification   "ready" | "waiting" | "cleanup" | ...
 * @property {?string} [householdId]
 * @property {string} [status]
 * @property {number} [draftVersion]
 * @property {?string} [receivedAt]
 * @property {?string} [expiresAt]
 * @property {number} [attachmentCount]
 * @property {boolean} [canDiscard]
 * @property {boolean} [cleanupOnly]
 * @property {string} [message]
 * @property {ItemProposal} [proposal]
 * @property {Record<string, { source: string, confidence: string }>} [fieldEvidence]
 * @property {{ displayName?: string, sizeBytes?: number, scannedClean?: boolean }[]} [attachments]
 */

/**
 * What the parser made of one piece of mail: an item, minus everything the
 * reader still has to decide. Every field is optional — a receipt nobody could
 * read proposes nothing at all (`proposal: {}`).
 *
 * @typedef {object} ItemProposal
 * @property {string} [title]
 * @property {string} [provider]
 * @property {string} [reference]
 * @property {string} [subtype]
 * @property {string} [notes]
 * @property {number} [costMinor]
 * @property {string} [currency]
 * @property {string} [dueDate]
 * @property {string} [scheduleKind]
 * @property {number} [recurrenceMonths]
 */

/**
 * An approvable receipt in suggestion shape — what receiptSuggestionsOf makes,
 * and what approveReceipt takes back. Named here rather than in inbox.js
 * because it crosses the seam in both directions.
 *
 * @typedef {object} ReceiptSuggestion
 * @property {string} id
 * @property {string} receiptId
 * @property {?string} householdId
 * @property {string} title
 * @property {string} currency
 * @property {string} sourceDocument
 * @property {number} [draftVersion]
 * @property {?string} [renewsOn]
 * @property {?string} [provider]
 * @property {?string} [expiresAt]
 * @property {?string} [receivedAt]
 * @property {?number} [costMinor]
 * @property {string} [classification]
 * @property {string} [message]
 * @property {Record<string, { source: string, confidence: string }>} [fieldEvidence]
 */

/**
 * What the item screen renders, whichever origin it came from: a real item
 * with its household, section and papers, or (#434) a mail-in suggestion in
 * that same view — amendable, with accept-into-orbit where the item actions
 * would be.
 *
 * One shape rather than two because the screen draws one thing. Everything an
 * origin cannot fill is optional, and `suggestion` is the flag that says which
 * origin this was: readBelt reads exactly that to decide whether the arrival
 * has a seat in the band.
 *
 * @typedef {Partial<WorkspaceItem> & Partial<ReceiptSuggestion> & {
 *   id: string,
 *   today: string,
 *   suggestion?: boolean,
 *   householdId?: ?string,
 *   section?: ?string,
 *   documents?: { name: string, meta: string }[],
 *   proposal?: ItemProposal,
 *   attachmentCount?: number,
 * }} ItemView
 */

/**
 * A row of the Filed lane (§14, #472) — the mail event, not the item. Not an
 * API field yet either: the server forgets the mail-to-item link once a
 * receipt burns up, which #467 asks it to change.
 *
 * @typedef {object} FiledEntry
 * @property {string} itemId
 * @property {string} [title]
 * @property {string} [sourceDocument]
 * @property {string} [filedAt]
 */

/**
 * The mail-in inbox. `households` and `filed` are optional because the
 * degraded read below answers receipts alone — callers already write
 * `inbox.filed ?? []`, and a type that promised the field would make those
 * guards look like dead code they are not.
 *
 * @typedef {object} Inbox
 * @property {Receipt[]} receipts
 * @property {{ id: string, name: string }[]} [households]
 * @property {FiledEntry[]} [filed]
 */

/**
 * One stored file, as the per-item documents route reports it
 * (src/server/document-repository.ts, DocumentSummary).
 *
 * @typedef {object} DocumentSummary
 * @property {string} id
 * @property {string} itemId
 * @property {string} displayName
 * @property {string} availableAt
 * @property {number} sizeBytes
 * @property {string} [mediaType]
 * @property {string} [lifecycle]
 * @property {string} [scanStatus]
 * @property {boolean} [ready]
 * @property {?string} [deleteAfter]
 * @property {?string} [failureCode]
 * @property {boolean} [recoverable]
 */

/**
 * One person on a household's roster, as the members route reports them.
 *
 * @typedef {object} Member
 * @property {string} id
 * @property {string} displayName
 * @property {string} role   "owner" | "member"
 */

/**
 * What the members route answers on every verb it serves: who is in the
 * household, and who could be added. `candidates` comes back empty to anyone
 * who may not add people, so a plain member's screen degrades by contract
 * rather than by a check invented on this side.
 *
 * @typedef {object} Roster
 * @property {Member[]} members
 * @property {Member[]} candidates
 */

/**
 * Someone waiting to be let in — PendingJoinRequest in
 * src/server/join-requests.ts. Requester display name only: deciding needs to
 * know who is asking and nothing more.
 *
 * @typedef {object} JoinRequest
 * @property {string} id
 * @property {string} householdId
 * @property {string} householdName
 * @property {string} userId
 * @property {string} displayName
 * @property {string} createdAt
 */

/**
 * One row of the sections editor — what sectionRowsOf makes. `count` and
 * `removed` are the interface's own arithmetic and state, not the household's:
 * they never travel to the server, they decide what may be sent.
 *
 * @typedef {object} SectionRow
 * @property {string} id
 * @property {string} name
 * @property {string} icon
 * @property {string} accent
 * @property {boolean} visible
 * @property {number} count        entries sitting in this section
 * @property {boolean} [removable] emptiness is the only thing that earns a ×
 * @property {boolean} [removed]   struck out in the editor, not yet saved
 */

/**
 * The reader's own reminder timing (#468). The pair of offsets is null rather
 * than defaulted when the read degrades, which is what makes the toggle refuse
 * to write a timing nobody chose.
 *
 * @typedef {object} Reminders
 * @property {boolean} emailEnabled
 * @property {?number} firstWarningDays
 * @property {?number} finalWarningDays
 * @property {string} firstWarning
 * @property {string} finalWarning
 * @property {string} outboundMail
 */

/**
 * The mail-in relay as the screens say it (#432) — bounded words only, never
 * a host, a port or a credential.
 *
 * @typedef {object} Relay
 * @property {string} address
 * @property {string} status
 * @property {string} lastReceived
 * @property {string} ingest
 */

/** Thrown with the server's own error code so screens can react to specifics. */
export class WorkspaceError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string }} [details]
   */
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "WorkspaceError";
    this.status = status;
    this.code = code;
  }
}

/**
 * The decoded body, or a WorkspaceError carrying the server's own words.
 *
 * Generic because every route answers a different shape, and this module is
 * where each of those shapes is named. Callers annotate the variable they
 * decode into, so the shape is written down next to the URL that produces it
 * and TypeScript infers T from that annotation.
 *
 * @template T
 * @param {Response} response
 * @returns {Promise<T>}
 */
async function json(response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    /* Signed out is not an error state the screens handle — it is a journey:
       into the login flow and back to this exact page (#451). The throw below
       still happens so pending callers settle while the navigation takes over. */
    if (response.status === 401 && typeof window !== "undefined") {
      window.location.assign(
        `/api/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`,
      );
    }
    /* The server explains itself in its own words when it can. When it can't —
       an HTML error page, a proxy, a process that isn't there — say that
       plainly rather than surfacing a bare "Not Found" the reader cannot act
       on. */
    const message =
      body?.error?.message ?? `Orbit could not be reached (${response.status})`;
    throw new WorkspaceError(message, {
      status: response.status,
      code: body?.error?.code,
    });
  }
  return body;
}

/**
 * The signed-in session, including the CSRF token every mutating request must
 * echo back. Cached for the life of the page: the token is derived from the
 * session, so it only changes when the session does — at which point the
 * command fails with 403 and the caller refreshes.
 */
/** @type {?Promise<Session>} */
let sessionPromise = null;

/**
 * @param {{ refresh?: boolean }} [options]
 * @returns {Promise<Session>}
 */
export function readSession({ refresh = false } = {}) {
  if (refresh || !sessionPromise) {
    /* The route this chain asks is the one that answers a Session; `json` is
       generic and has nothing to infer that from when it is handed over
       point-free, so the shape is named here instead. */
    sessionPromise = /** @type {Promise<Session>} */ (
      fetch("/api/auth/session", { credentials: "same-origin" })
        .then(json)
        .catch((error) => {
          sessionPromise = null;
          throw error;
        })
    );
  }
  return sessionPromise;
}

/**
 * The whole workspace: households, their sections, items and activity.
 *
 * @returns {Promise<Workspace>}
 */
export async function readWorkspace() {
  /** @type {{ workspace: Workspace }} */
  const body = await json(
    await fetch("/api/workspace", { credentials: "same-origin" }),
  );
  return body.workspace;
}

/**
 * Applies one command and returns the workspace as the server now sees it.
 * A stale CSRF token is retried once against a fresh session rather than
 * surfacing as a failure the user can do nothing about.
 *
 * @param {object} command  one `workspaceCommandSchema` command
 * @param {{ retryCsrf?: boolean }} [options]
 * @returns {Promise<Workspace>}
 */
export async function applyCommand(command, { retryCsrf = true } = {}) {
  const { csrfToken } = await readSession();
  const response = await fetch("/api/workspace/commands", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
    body: JSON.stringify(command),
  });

  if (response.status === 403 && retryCsrf) {
    await readSession({ refresh: true });
    return applyCommand(command, { retryCsrf: false });
  }

  /** @type {{ workspace: Workspace }} */
  const body = await json(response);
  return body.workspace;
}

/**
 * The household the session is currently pointed at, with its sections.
 *
 * @returns {Promise<Household>}
 */
export async function activeHousehold() {
  const workspace = await readWorkspace();
  const household =
    workspace.households.find((one) => one.id === workspace.activeHouseholdId) ??
    workspace.households[0];
  if (!household) {
    throw new WorkspaceError("This account has no household yet", { code: "no_household" });
  }
  return household;
}

/* ---------------------------------------------------------------------------
 * Fixture-backed reads (#446).
 *
 * Every screen reads through these, never through a per-route fixture import,
 * so when the API becomes reachable the switch happens HERE — one module —
 * instead of rewiring nine screens. That is this file's founding promise
 * ("this module is the only place the front end knows those URLs"), which the
 * per-route fixtures had quietly broken.
 *
 * Async on purpose, though the fixtures resolve instantly: the live versions
 * are fetches, and making callers async NOW means flipping a body from
 * fixture to fetch changes no caller's shape later.
 */
import { operationsFixture } from "./fixtures/operations.js";
import { adminFixture } from "./fixtures/admin.js";
import { ago } from "$lib/format.js";
import { bandOf, daysUntil, galaxyOf, labelledSkyOf } from "./chart.js";
import { approvalItemOf, receiptFailuresOf, receiptSuggestionsOf } from "./inbox.js";
import { householdScreenOf, householdUpdateCommandOf, sectionsCommandOf } from "./household.js";

/**
 * A mutating fetch with the session's CSRF token, like applyCommand's.
 *
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [options]
 * @returns {Promise<Response>}
 */
async function csrfFetch(path, { method = "POST", body } = {}) {
  const { csrfToken } = await readSession();
  return fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      "x-csrf-token": csrfToken,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/**
 * The signed-in user's private mail-in inbox (#434). Instance admins have no
 * private mailbox (the route answers empty for them), and a broken inbox must
 * never take home down with it — the caller treats this as additive.
 *
 * @returns {Promise<Inbox>}
 */
export async function readInbox() {
  /** @type {Partial<Inbox>} */
  const body = await json(await fetch("/api/imap-inbox", { credentials: "same-origin" }));
  return { receipts: body.receipts ?? [], households: body.households ?? [], filed: body.filed ?? [] };
}

/**
 * Approve a mail-in suggestion as proposed (#434): assign a household if the
 * receipt has none, read the review (fresh draftVersion, first section, the
 * staged attachments), then approve through the reviewed-intake protocol.
 * The operationId makes retries idempotent — a double-tap cannot create two
 * items — so callers keep ONE id per receipt across attempts.
 *
 * @param {ReceiptSuggestion} suggestion
 * @param {?string} fallbackHouseholdId  used when the receipt names no household
 * @param {string} operationId           kept across retries; that is the point
 * @param {?ItemProposal} [amendedItem]  what the reader edited, if they did
 * @returns {Promise<{ outcome: string, itemId?: string }>}
 */
export async function approveReceipt(suggestion, fallbackHouseholdId, operationId, amendedItem = null) {
  const householdId = suggestion.householdId ?? fallbackHouseholdId;
  if (!householdId) throw new WorkspaceError("This account has no household yet", { code: "no_household" });
  if (!suggestion.householdId) {
    await json(await csrfFetch(`/api/imap-inbox/${suggestion.receiptId}`, { method: "PUT", body: { householdId } }));
  }
  /** @type {{ sections?: WorkspaceSection[], receipt?: Receipt, attachments?: { id: string }[] }} */
  const review = await json(
    await fetch(`/api/imap-inbox/${suggestion.receiptId}?householdId=${householdId}`, { credentials: "same-origin" }),
  );
  const section = review.sections?.[0];
  if (!section) throw new WorkspaceError("This household has no section to file into", { code: "no_section" });
  /** @type {{ outcome: string, itemId?: string }} */
  const body = await json(await csrfFetch("/api/reviewed-intake/approve", {
    body: {
      operationId,
      source: {
        kind: "mailbox_draft",
        receiptId: suggestion.receiptId,
        draftVersion: review.receipt?.draftVersion ?? suggestion.draftVersion,
      },
      householdId,
      sectionId: section.id,
      action: "create_separate",
      item: amendedItem ?? approvalItemOf(review.receipt?.proposal ?? {}, suggestion.currency),
      attachmentIds: (review.attachments ?? []).map((attachment) => attachment.id),
    },
  }));
  return body; // { outcome: "approved" | "partial_success", itemId }
}

/**
 * Discard a mail-in receipt; its staged files are purged server-side.
 *
 * @param {string} receiptId
 * @returns {Promise<void>}
 */
export async function dismissReceipt(receiptId) {
  await json(await csrfFetch(`/api/imap-inbox/${receiptId}`, { method: "DELETE" }));
}

/** "Request to join X system?" (§11, #453) — idempotent server-side, so a
 * double-tap can never file twice.
 *
 * @param {string} householdId
 * @returns {Promise<{ request: JoinRequest }>}
 */
export async function requestToJoin(householdId) {
  return json(await csrfFetch(`/api/households/${householdId}/join-requests`, { body: {} }));
}

/* §15-2g: join requests live in HOUSEHOLD MANAGEMENT only — administration
   dropped its block, so this seam has no reader/decider today and the two
   helpers that served it (readJoinRequests, decideJoinRequest) are gone with
   it rather than left dangling. The server side is untouched and stays:
   GET /api/join-requests and POST /api/join-requests/{id} are live routes,
   and the household-management screen will call them when it is built. */

/**
 * Owner/admin direct add: membership without a request (§11).
 *
 * @param {string} householdId
 * @param {string} userId
 * @returns {Promise<Roster>}
 */
export async function addMember(householdId, userId) {
  return json(await csrfFetch(`/api/households/${householdId}/members`, { body: { userId } }));
}

/**
 * "Today" for chart arithmetic. The workspace fixture pins it to the date the
 * designs were drawn against so the fidelity gate is deterministic; the real
 * API carries no such field, so live data uses the real clock.
 *
 * @param {?Workspace} [workspace]
 * @returns {string} a calendar date, YYYY-MM-DD
 */
function todayOf(workspace) {
  return workspace?.fixtureToday ?? new Date().toISOString().slice(0, 10);
}

/**
 * Everything the home screen renders (#451): the fixed sky, the primary
 * household (dial and manifest), any document suggestions (none from the live
 * API yet — #454), the signed-in user, and the date the chart reckons from.
 */
/**
 * A piece of mail that arrived but cannot be acted on, as the relay shows it.
 *
 * @typedef {object} MailFailure
 * @property {string} id
 * @property {string} receivedAt
 * @property {string} classification
 * @property {string} message
 * @property {boolean} canDiscard
 */

/**
 * Everything the home screen reads in one go.
 *
 * Two shapes, one type. When the viewer belongs to nothing (§11, #453) the
 * labelled sky is all there is: `emptySky` is set, `galaxy` carries names and
 * bearings only, and `primary` and `household` are null. Otherwise the dial,
 * manifest and mail surfaces all have something to draw.
 *
 * #624: this typedef exists so `home/+page.svelte` can annotate the state it
 * keeps this in. Without it that state infers as `null`, every property access
 * on it is an error, and everything derived from it becomes `never` -- one
 * missing annotation was costing 41 of the ledger's errors.
 *
 * @typedef {object} HomeView
 * @property {true} [emptySky]                 set only in the labelled sky
 * @property {Record<string, import('./chart.js').GalaxyEntry>} galaxy
 * @property {string | null} primary           the household in the middle
 * @property {Household | null} household
 * @property {ReceiptSuggestion[]} suggestions
 * @property {MailFailure[]} mailFailures
 * @property {Receipt[]} mailReading           arrived, not yet readable
 * @property {SessionUser | null} user
 * @property {string} today                    YYYY-MM-DD
 * @property {string} now                      ISO instant, pinned under fixtures
 */

/**
 * @returns {Promise<HomeView>}
 */
export async function readHome() {
  const [workspace, session, inbox] = await Promise.all([
    readWorkspace(),
    readSession(),
    /* Additive: mail-in suggestions enrich home, they must never sink it. */
    readInbox().catch(() => /** @type {Inbox} */ ({ receipts: [] })),
  ]);
  const primary = workspace.activeHouseholdId ?? workspace.households[0]?.id ?? null;
  const today = todayOf(workspace);
  /* §11 (#453): no membership means the labelled sky — every visible
     household as a bearing and a name, nothing else. The dial, manifest and
     mail surfaces simply do not exist yet for this viewer. */
  if (workspace.householdLanding === "choose" || !workspace.households.length) {
    return {
      emptySky: true,
      galaxy: labelledSkyOf(workspace.visibleHouseholds),
      primary: null,
      household: null,
      suggestions: [],
      mailFailures: [],
      mailReading: [],
      user: session?.user ?? null,
      today,
      now: workspace.fixtureToday ? `${workspace.fixtureToday}T12:00:00Z` : new Date().toISOString(),
    };
  }
  return {
    galaxy: galaxyOf(workspace, today),
    primary,
    household: workspace.households.find((one) => one.id === primary) ?? null,
    suggestions: [
      ...(workspace.suggestions ?? []),
      ...receiptSuggestionsOf(inbox.receipts),
    ],
    mailFailures: receiptFailuresOf(inbox.receipts),
    mailReading: (inbox.receipts ?? []).filter(
      (receipt) => !receipt.canApprove && receipt.classification === "waiting",
    ),
    user: session?.user ?? null,
    today,
    /* Pinned "now" for elapsed-time lines (the pocket's signals): fixture
       noon under the gate, the clock in production. */
    now: workspace.fixtureToday ? `${workspace.fixtureToday}T12:00:00Z` : new Date().toISOString(),
  };
}

/**
 * Everything the corridor renders (#461): the whole workspace (the corridor
 * spans every system), the signed-in user for the chrome, and the reckoning
 * date. The transform itself (corridorOf) is pure and lives in chart.js.
 */
export async function readDueNext() {
  const [workspace, session] = await Promise.all([readWorkspace(), readSession()]);
  const primary = workspace.activeHouseholdId ?? workspace.households[0]?.id ?? null;
  return {
    workspace,
    primary,
    household: workspace.households.find((one) => one.id === primary) ?? null,
    user: session?.user ?? null,
    today: todayOf(workspace),
  };
}

/**
 * Everything the inbox screen renders (#463): the raw receipts in their
 * bounded groups, the approvable ones ALSO in suggestion shape (the approve
 * protocol's input), the relay summary, and a pinned "now" so elapsed-time
 * lines hold still under the gate (fixture noon) yet stay live in production.
 */
export async function readInboxScreen() {
  const [workspace, session, inbox, relay] = await Promise.all([
    readWorkspace(),
    readSession(),
    readInbox().catch(() => /** @type {Inbox} */ ({ receipts: [] })),
    /* Additive: the relaybar is a summary line, not the screen's subject. */
    readRelay().catch(() => UNAVAILABLE_RELAY),
  ]);
  const receipts = inbox.receipts ?? [];
  const primary = workspace.activeHouseholdId ?? workspace.households[0]?.id ?? null;
  const caught = receipts
    .filter((receipt) => receipt.classification !== "waiting")
    .map((receipt) => receipt.receivedAt)
    .sort()
    .pop() ?? null;
  /* The Filed lane (§14, #472): the server forgets the mail→item link once a
     receipt burns up, so `filed` only exists in the fixture until #467 gives
     it a route — live data degrades to the lane's honest empty words. The dot
     tells today's truth: it takes the item's CURRENT urgency band, not the
     band on the day it was filed. */
  const today = todayOf(workspace);
  const itemsById = new Map(
    workspace.households.flatMap((household) => (household.items ?? []).map((item) => [item.id, item])),
  );
  const filed = (inbox.filed ?? []).map((/** @type {FiledEntry} */ entry) => {
    const item = itemsById.get(entry.itemId);
    return { ...entry, band: bandOf(item?.dueDate ? daysUntil(item.dueDate, today) : null) };
  });
  return {
    filed,
    user: session?.user ?? null,
    household: workspace.households.find((one) => one.id === primary) ?? null,
    primary,
    today,
    now: workspace.fixtureToday ? `${workspace.fixtureToday}T12:00:00Z` : new Date().toISOString(),
    relay,
    lastCaught: caught,
    review: receipts.filter((receipt) => receipt.canApprove),
    reading: receipts.filter((receipt) => !receipt.canApprove && receipt.classification === "waiting"),
    failed: receiptFailuresOf(receipts),
    suggestions: receiptSuggestionsOf(receipts),
  };
}

/**
 * Everything the archive renders (#462): the workspace, every attached
 * document (the API only speaks per-item, so the seam fans out over items
 * that report documents), and the relay's approvable catches. Per-item
 * failures are additive — a household that can't answer loses its rows, not
 * the screen.
 */
export async function readDocumentsScreen() {
  const [workspace, session, inbox] = await Promise.all([
    readWorkspace(),
    readSession(),
    readInbox().catch(() => /** @type {Inbox} */ ({ receipts: [] })),
  ]);
  const primary = workspace.activeHouseholdId ?? workspace.households[0]?.id ?? null;
  /** @type {Record<string, DocumentSummary[]>} */
  const documentsByItem = {};
  await Promise.all(
    workspace.households.flatMap((household) =>
      (household.items ?? [])
        .filter((item) => (item.documentCount ?? 0) > 0)
        .map(async (item) => {
          try {
            /** @type {{ documents?: DocumentSummary[] }} */
            const body = await json(
              await fetch(`/api/households/${household.id}/items/${item.id}/documents`, {
                credentials: "same-origin",
              }),
            );
            documentsByItem[item.id] = body.documents ?? [];
          } catch {
            documentsByItem[item.id] = [];
          }
        }),
    ),
  );
  return {
    workspace,
    primary,
    household: workspace.households.find((one) => one.id === primary) ?? null,
    user: session?.user ?? null,
    today: todayOf(workspace),
    receipts: inbox.receipts ?? [],
    documentsByItem,
  };
}

/**
 * Everything the helm renders (#464): who you are, your systems and roles,
 * the relay summary with how many arrivals wait, and the reminder timing —
 * the last live from #468's route.
 */
export async function readSettingsScreen() {
  const [workspace, session, inbox, relay, reminders] = await Promise.all([
    readWorkspace(),
    readSession(),
    readInbox().catch(() => /** @type {Inbox} */ ({ receipts: [] })),
    /* Additive: the helm's relay card is a summary, not the screen's subject. */
    readRelay().catch(() => UNAVAILABLE_RELAY),
    /* Additive too: reminder timing is one card of five. An endpoint that
       cannot answer costs the reader those four lines' values, not the helm. */
    readReminders().catch(() => UNAVAILABLE_REMINDERS),
  ]);
  const primary = workspace.activeHouseholdId ?? workspace.households[0]?.id ?? null;
  return {
    user: session?.user ?? null,
    household: workspace.households.find((one) => one.id === primary) ?? null,
    primary,
    memberships: workspace.households.map((household) => ({
      id: household.id,
      name: household.name,
      memberCount: household.memberCount ?? null,
      itemCount: (household.items ?? []).length,
      role: household.canManage ? "owner" : "member",
      primary: household.id === primary,
    })),
    relay,
    waiting: (inbox.receipts ?? []).filter((receipt) => receipt.canApprove).length,
    reminders,
  };
}

/**
 * Everything mission control renders (#465): the instance's people (real
 * route), its systems from the workspace (admins see everything, §11), and
 * the parts no route can answer yet — ownership, membership counts, the
 * relay's levers — from the admin fixture until #453/#432 make them real.
 * Live data omits what it cannot know. No join requests: §15-2g moved them
 * to household management, so this screen never asks for them.
 */
export async function readAdminScreen() {
  const [workspace, session, users] = await Promise.all([
    readWorkspace(),
    readSession(),
    json(await fetch("/api/admin/users", { credentials: "same-origin" }))
      .then(
        (/** @type {{ users?: { id: string, displayName: string, email?: string, isInstanceAdmin?: boolean }[] }} */ body) =>
          body.users ?? [],
      )
      .catch(() => []),
  ]);
  const primary = workspace.activeHouseholdId ?? workspace.households[0]?.id ?? null;
  /* Real owner names where the members route answers (#453); the fixture's
     stay as the gate's fallback where it doesn't. */
  /** @type {Record<string, string>} */
  const owners = { ...adminFixture.owners };
  await Promise.all(
    workspace.households.map(async (household) => {
      try {
        /** @type {Partial<Roster>} */
        const body = await json(
          await fetch(`/api/households/${household.id}/members`, { credentials: "same-origin" }),
        );
        const owner = (body.members ?? []).find((member) => member.role === "owner");
        if (owner?.displayName) owners[household.id] = owner.displayName;
      } catch { /* additive: a household that cannot answer keeps its label */ }
    }),
  );
  return {
    user: session?.user ?? null,
    household: workspace.households.find((one) => one.id === primary) ?? null,
    primary,
    today: todayOf(workspace),
    users,
    households: workspace.households,
    ...adminFixture,
    owners,
  };
}

/** @param {string} iso */
const shortDate = (iso) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** @param {number} bytes */
const sizeLabel = (bytes) =>
  bytes >= 1024 * 1024
    ? `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
    : `${Math.round(bytes / 1024)} KB`;

/**
 * One item, or null. A membership test against data the session already sees
 * — never a request built from the URL — so an unknown id is a 404, not a
 * probe: there deliberately is no item-by-id route to widen (#451). The
 * documents join uses the household id the membership test just proved.
 * `version`/`updatedAt`/`snoozedUntil` ride along for #424's writes.
 *
 * @param {string} id  an item id, or (#434) a mail-in receipt id
 * @returns {Promise<?ItemView>}
 */
export async function readItem(id) {
  const workspace = await readWorkspace();
  for (const household of workspace.households) {
    const item = (household.items ?? []).find((one) => one.id === id);
    if (!item) continue;
    const sections = new Map((household.sections ?? []).map((s) => [s.id, s.name]));
    /** @type {{ documents?: DocumentSummary[] }} */
    const body = await json(
      await fetch(`/api/households/${household.id}/items/${item.id}/documents`, {
        credentials: "same-origin",
      }),
    );
    return {
      ...item,
      householdId: household.id,
      today: todayOf(workspace),
      section: sections.get(item.sectionId) ?? null,
      documents: (body.documents ?? []).map((doc) => ({
        name: doc.displayName,
        meta: `added ${shortDate(doc.availableAt)} · ${sizeLabel(doc.sizeBytes)}`,
      })),
    };
  }
  /* #434: the id may be a mail-in receipt — a suggestion opens in the same
     view, amendable, with accept-into-orbit instead of the item actions. */
  try {
    const inbox = await readInbox();
    const suggestion = receiptSuggestionsOf(inbox.receipts).find((one) => one.receiptId === id);
    if (suggestion) {
      const receipt = inbox.receipts.find((one) => one.id === id);
      return {
        ...suggestion,
        suggestion: true,
        proposal: receipt?.proposal ?? {},
        attachmentCount: receipt?.attachmentCount ?? 0,
        today: new Date().toISOString().slice(0, 10),
      };
    }
  } catch {
    /* the inbox being unreachable must read as "no such item", not a crash */
  }
  return null;
}

/** Operational state and recent deliveries. Live source: GET /api/admin/operations. */
export async function readOperations() {
  return operationsFixture;
}

/**
 * The signed-in user's mail-in relay (#432), live from
 * `GET /api/settings/mail-relay`.
 *
 * The server speaks in bounded words — a fixed `listening` phrase, a bare
 * timestamp, an "enabled"/"paused" ingest flag — and never in hosts, ports,
 * mailboxes or config values. This maps that to the three sentences the
 * screens render, degrading honestly where the server cannot yet answer:
 * an arrival has no document name until #467, so live data shows the elapsed
 * time alone where the mockup showed "policy-schedule.pdf · 2d ago".
 *
 * The address is capability-bearing — anyone holding it can post into this
 * user's review queue — so it is never cached here, only rendered.
 *
 * @returns {Promise<Relay>}
 */
export async function readRelay() {
  /** @type {{ relay?: { address?: string, listening?: string, lastReceivedLabel?: string, lastReceived?: string, ingest?: string } }} */
  const body = await json(
    await fetch("/api/settings/mail-relay", { credentials: "same-origin" }),
  );
  const relay = body.relay ?? {};
  return {
    /* No address is a real answer, not a gap: mail-in may be off, and an
       instance admin has no private mailbox at all. */
    address: relay.address ?? NO_ADDRESS,
    status: relay.listening ?? UNAVAILABLE_RELAY.status,
    lastReceived:
      relay.lastReceivedLabel
      ?? (relay.lastReceived ? ago(relay.lastReceived, new Date().toISOString()) : "nothing yet"),
    ingest: relay.ingest ?? UNAVAILABLE_RELAY.ingest,
  };
}

const NO_ADDRESS = "no address yet";

/**
 * What the relay's CHROME says when the endpoint cannot be reached. The relay
 * screen itself lets the failure surface — its whole subject is the relay —
 * but the inbox's relaybar and the helm's card are summaries, and an
 * unreachable summary must not sink the screen around it (the readInbox
 * precedent). It says it does not know, which is deliberately not the same
 * word as "not listening".
 */
/** @type {Relay} */
const UNAVAILABLE_RELAY = {
  address: NO_ADDRESS,
  status: "relay unavailable",
  lastReceived: "unknown",
  ingest: "unknown",
};

/**
 * The signed-in user's own reminder timing (#468), live from
 * `GET /api/settings/reminders`.
 *
 * The server already speaks the screen's language: it renders the pair of
 * offsets into the two sentences the helm shows ("14 days before closest
 * approach", "3 days before"), so the port needs no phrasing of its own and
 * cannot drift from the numbers actually stored. It also carries the pair
 * itself, which is not decoration — `PUT` takes the whole preference, so the
 * toggle can only write by handing back the offsets it was given.
 *
 * `outboundMail` is the operator's state reported in bounded words
 * ("configured"/"not configured"), never a host, a port or a credential —
 * the same rule the relay follows.
 *
 * @returns {Promise<Reminders>}
 */
export async function readReminders() {
  /** @type {{ reminders?: Partial<Reminders> }} */
  const body = await json(
    await fetch("/api/settings/reminders", { credentials: "same-origin" }),
  );
  return remindersOf(body.reminders);
}

/**
 * Saves the reader's own reminder timing and answers what is now stored.
 *
 * The whole preference goes over, not a patch: `reminderPreferenceSchema`
 * requires both offsets alongside the flag so a half-sent pair can never
 * cross over. A caller that never learned the pair — the degraded read below
 * — therefore has nothing to write, and is refused HERE rather than being
 * bounced by the schema with a message written for a form that does not
 * exist on this screen.
 *
 * @param {{ emailEnabled: boolean, firstWarningDays: ?number, finalWarningDays: ?number }} preference
 * @returns {Promise<Reminders>}
 */
export async function writeReminders({ emailEnabled, firstWarningDays, finalWarningDays }) {
  if (!Number.isInteger(firstWarningDays) || !Number.isInteger(finalWarningDays)) {
    throw new WorkspaceError("Orbit does not know your reminder timing yet", {
      code: "reminders_unknown",
    });
  }
  /** @type {{ reminders?: Partial<Reminders> }} */
  const body = await json(
    await csrfFetch("/api/settings/reminders", {
      method: "PUT",
      body: { emailEnabled, firstWarningDays, finalWarningDays },
    }),
  );
  return remindersOf(body.reminders);
}

/**
 * The signed-in reader's own first-run tour record (#751/#752), through
 * `GET /api/settings/tour` — the reminders pair above, for the walk.
 *
 * The route takes no user: the session is the only input on both verbs, so
 * there is nothing here to name and no way to read or rewrite somebody else's
 * record. Null means the walk has never been taken.
 *
 * @returns {Promise<{ tourSeenAt: string | null }>}
 */
export async function readTour() {
  const body = await json(
    await fetch("/api/settings/tour", { credentials: "same-origin" }),
  );
  return { tourSeenAt: body?.tour?.tourSeenAt ?? null };
}

/**
 * Records that the walk is over — the ONE write the tour makes, on skip and
 * on finish alike (#477: remembered on the server, so skipping on a phone
 * holds on the desk). Nothing else about the walk is sent anywhere: the
 * example body on stops 3-5 is drawn in the document and taken away again.
 *
 * @param {string} [seenAt] ISO timestamp; now, unless a caller says otherwise
 * @returns {Promise<{ tourSeenAt: string | null }>}
 */
export async function writeTourSeen(seenAt = new Date().toISOString()) {
  const body = await json(
    await csrfFetch("/api/settings/tour", { method: "PUT", body: { tourSeenAt: seenAt } }),
  );
  return { tourSeenAt: body?.tour?.tourSeenAt ?? null };
}

/**
 * "Take the walk again" (#753): puts the record back to null, on the same
 * route writeTourSeen uses, so the next arrival on `/home` reads no walk
 * ever taken and starts it at stop 1. The server already accepts this —
 * `tourPreferenceSchema` allows `tourSeenAt: null` and `writeTourSettings`
 * stores it as such (#751) — so there is no new route to add, only this
 * mirror of writeTourSeen's shape.
 *
 * @returns {Promise<{ tourSeenAt: string | null }>}
 */
export async function clearTourSeen() {
  const body = await json(
    await csrfFetch("/api/settings/tour", { method: "PUT", body: { tourSeenAt: null } }),
  );
  return { tourSeenAt: body?.tour?.tourSeenAt ?? null };
}

/**
 * One mapping for both verbs: the route answers the same shape on each.
 *
 * @param {Partial<Reminders>} [reminders]
 * @returns {Reminders}
 */
function remindersOf(reminders) {
  const firstWarningDays = reminders?.firstWarningDays;
  const finalWarningDays = reminders?.finalWarningDays;
  return {
    emailEnabled: reminders?.emailEnabled ?? UNAVAILABLE_REMINDERS.emailEnabled,
    /* Null, not a guessed default: a number invented here would be written
       back as the reader's own choice the first time the toggle is tapped. */
    firstWarningDays: typeof firstWarningDays === "number" && Number.isInteger(firstWarningDays) ? firstWarningDays : null,
    finalWarningDays: typeof finalWarningDays === "number" && Number.isInteger(finalWarningDays) ? finalWarningDays : null,
    firstWarning: reminders?.firstWarning ?? UNAVAILABLE_REMINDERS.firstWarning,
    finalWarning: reminders?.finalWarning ?? UNAVAILABLE_REMINDERS.finalWarning,
    outboundMail: reminders?.outboundMail ?? UNAVAILABLE_REMINDERS.outboundMail,
  };
}

/**
 * What the Reminders card says when the endpoint cannot be reached — the
 * UNAVAILABLE_RELAY precedent, and additive for the same reason: reminder
 * timing is one card on a screen that is mostly about other things.
 *
 * "unknown" everywhere, deliberately: it is not "off", not "on the day" and
 * not "not configured", each of which would be a claim about state this
 * front end has not been told. The pair is null so the toggle refuses to
 * write rather than saving a timing nobody chose, and `emailEnabled` is
 * false only because the control has two positions — the null pair, not the
 * flag, is what makes the card inert until the read succeeds.
 */
/** @type {Reminders} */
const UNAVAILABLE_REMINDERS = {
  emailEnabled: false,
  firstWarningDays: null,
  finalWarningDays: null,
  firstWarning: "unknown",
  finalWarning: "unknown",
  outboundMail: "unknown",
};

/**
 * "Sign out of every device" (#468): ends every session this user holds and
 * answers how many that was.
 *
 * The caller's own session goes with them — that is the point, not a side
 * effect: a device the reader no longer trusts must lose access, and there is
 * no way to say which device that was. The route clears this browser's cookie
 * on the way out, so the only honest next page is the sign-in.
 *
 * CSRF-carrying, like every other mutation here: an action this destructive
 * must not be reachable from another origin's form post.
 *
 * @returns {Promise<number>}  how many sessions were ended
 */
export async function signOutEverywhere() {
  /** @type {?{ revoked?: number }} */
  const body = await json(await csrfFetch("/api/auth/sessions/revoke"));
  return body?.revoked ?? 0;
}

/**
 * Sign out of THIS device (#410, §15) — the ordinary end of a session, and
 * the thing the ratified descent is a farewell to.
 *
 * `Accept: application/json` matters: without it the engine's route answers a
 * 303 to the identity provider's end-session endpoint, which a fetch would
 * follow across origins for no one's benefit. With it, the session row is
 * deleted, this browser's cookie is cleared, and the provider's own logout URL
 * comes back as a string for the caller to use when it suits the journey.
 *
 * It resolves only once the server has actually ended the session, so a caller
 * can safely treat "this returned" as "there is nothing left to revoke".
 *
 * @returns {Promise<?string>}  the provider's own logout URL, when it has one
 */
export async function signOut() {
  const { csrfToken } = await readSession();
  const response = await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json", "x-csrf-token": csrfToken },
  });
  if (!response.ok) {
    throw new WorkspaceError("The session could not be ended", { status: response.status });
  }
  const body = await response.json().catch(() => null);
  sessionPromise = null;              /* the cached session is a dead letter now */
  return body?.redirectTo ?? null;
}

/* ---------------------------------------------------------------------------
 * Household management (#410, §15) — ONE system, seen from inside.
 *
 * Every route below already exists in the engine; nothing here is new server
 * work. The screen is reached from the helm's memberships card, and an
 * instance admin needing owner powers over some household is handed this same
 * screen for it (§15-2i) — there is no admin variant.
 */

/**
 * Everything household management renders: the household and its sections
 * from the workspace, who is in it and who could be added from the members
 * route, and who is waiting from the join-requests route.
 *
 * The two extra reads are ADDITIVE in different ways, deliberately:
 *
 *  - the roster is the screen's subject, so a members route that cannot
 *    answer costs the reader the roster (and the workspace's own
 *    `memberCount` stands in for the header's count) rather than the screen;
 *  - joiners are one block of one card, and §15-2g made this the only place
 *    they are answered, so an unreachable list must not take the editor down
 *    with it.
 *
 * `candidates` rides along on the members payload — that is where the engine
 * serves listRegisteredUserCandidates from, and it answers an empty list to
 * anyone who may not add people, so a member's screen degrades by contract
 * rather than by a check invented here.
 *
 * @param {string} householdId
 */
export async function readHouseholdScreen(householdId) {
  const [workspace, session] = await Promise.all([readWorkspace(), readSession()]);
  const [roster, joinRequests] = await Promise.all([
    /** @type {Promise<Partial<Roster>>} */ (
      json(await fetch(`/api/households/${householdId}/members`, { credentials: "same-origin" }))
    ).catch(() => ({ members: [], candidates: [] })),
    /* Owners and instance admins only; anyone else gets a 403 the screen has
       no use for, and the block simply has nothing to show. */
    json(await fetch("/api/join-requests", { credentials: "same-origin" }))
      .then((/** @type {{ requests?: JoinRequest[] }} */ body) => body.requests ?? [])
      .catch(() => []),
  ]);
  /* household.js's householdScreenOf infers its parameter shape from its own
     defaults (e.g. `members = []` reads as `never[]`), so this call is cast
     rather than fought from the caller's side — the fix belongs with that
     function's own JSDoc, out of scope here. */
  return householdScreenOf(/** @type {any} */ ({
    workspace,
    householdId,
    user: session?.user ?? null,
    members: roster.members ?? [],
    candidates: roster.candidates ?? [],
    joinRequests,
    today: todayOf(workspace),
    /* Pinned "now" so "2d ago" on a waiting joiner holds still under the gate
       and stays live in production — readHome's rule. */
    now: workspace.fixtureToday ? `${workspace.fixtureToday}T12:00:00Z` : new Date().toISOString(),
  }));
}

/**
 * Rename / re-zone / re-currency (2c). ONE bundled `household.update`, always:
 * the route accepts nothing smaller, so a per-field save submits the whole
 * bundle with the other two values as they stand.
 *
 * @param {string} householdId
 * @param {{ name: string, timezone: string, currency: string }} identity
 * @returns {Promise<Workspace>}
 */
export async function writeHouseholdIdentity(householdId, identity) {
  return applyCommand(householdUpdateCommandOf(householdId, identity));
}

/**
 * The sections editor, saved whole — `sections.replace` replaces the list.
 *
 * The hidden-not-removed law is enforced HERE as well as in the interface,
 * because it is a data law and not a style: dropping a section that still
 * holds entries would have the engine re-file them under whichever section
 * happens to be first, which is a silent edit nobody asked for.
 *
 * @param {string} householdId
 * @param {SectionRow[]} rows  the editor's rows, in sectionRowsOf's shape
 * @returns {Promise<Workspace>}
 */
export async function writeSections(householdId, rows) {
  const dropped = rows.filter((row) => row.count > 0 && row.removed);
  if (dropped.length) {
    throw new WorkspaceError("A section holding entries can be hidden, never removed", {
      code: "section_in_use",
    });
  }
  return applyCommand(sectionsCommandOf(householdId, rows.filter((row) => !row.removed)));
}

/**
 * Owner/admin removal, and — with the caller's own id — leaving (§11).
 *
 * @param {string} householdId
 * @param {string} userId
 * @returns {Promise<Roster>}
 */
export async function removeMember(householdId, userId) {
  return json(await csrfFetch(`/api/households/${householdId}/members`, {
    method: "DELETE",
    body: { userId },
  }));
}

/**
 * Hand the system over. An owner can never leave a system, so this is the way
 * out — and the route swaps the two roles in one transaction, which is why
 * there is no "demote yourself" call to make first.
 *
 * @param {string} householdId
 * @param {string} userId  the member who becomes owner
 * @returns {Promise<Roster>}
 */
export async function transferOwnership(householdId, userId) {
  return json(await csrfFetch(`/api/households/${householdId}/members`, {
    method: "PATCH",
    body: { userId },
  }));
}

/**
 * Approve or decline a joiner (§11, §15-2g — here and nowhere else).
 *
 * @param {string} requestId
 * @param {string} action  "approve" or "decline"
 * @returns {Promise<{ request: JoinRequest }>}
 */
export async function decideJoinRequest(requestId, action) {
  return json(await csrfFetch(`/api/join-requests/${requestId}`, { body: { action } }));
}

/**
 * Ask for the system to be deleted (2f).
 *
 * The typed name goes over as `confirmation` and the SERVER compares it
 * against the stored name — the client's own check only decides when to wake
 * the button. Asking is the whole of this screen's involvement: the countdown,
 * the restore and the final hard delete are instance-admin acts drawn on the
 * admin panel.
 *
 * @param {string} householdId
 * @param {string} confirmation  the name as typed; the SERVER compares it
 * @returns {Promise<{ deleteAfter: string }>}
 */
export async function requestHouseholdDeletion(householdId, confirmation) {
  return json(await csrfFetch(`/api/households/${householdId}/lifecycle`, {
    body: { action: "delete", confirmation },
  }));
}

/* ---------------------------------------------------------------------------
 * The item belt (#458) — the item screen, and the document surface with it.
 */

/**
 * Everything the belt renders for one arrival: the WHOLE household the item
 * belongs to, because the belt is that household's manifest bent round a ring
 * and an item without its date-neighbours is not an arrival, it is a card on
 * its own.
 *
 * The membership test is readItem's, deliberately: the household is found by
 * looking for the id in data the session already sees, never by building a
 * request out of the URL, so an unknown id is a 404 and not a probe (#451).
 *
 * Documents come from the per-item route, fanned out over the items that
 * report carrying any — readDocumentsScreen's pattern, and additive in the
 * same way: an item whose papers cannot be read loses its papers, not the
 * screen. They are read for the whole household rather than for the centred
 * item alone because every item's rock wears CON-1's belt ellipse when it has
 * papers, and because centring a neighbour must not go back to the server.
 *
 * #434 rides along: an id that is a mail-in receipt rather than an item is
 * still the amend-then-accept view, which has no seat in the band — a
 * suggestion is not in the manifest until it is accepted into it.
 *
 * @param {string} id  the centred item, or (#434) a mail-in receipt
 */
export async function readBelt(id) {
  const [workspace, session] = await Promise.all([readWorkspace(), readSession()]);
  const today = todayOf(workspace);
  const household = workspace.households.find((one) =>
    (one.items ?? []).some((item) => item.id === id),
  );
  if (!household) {
    const suggestion = await readItem(id);
    return suggestion?.suggestion ? { kind: "suggestion", item: suggestion } : null;
  }

  /** @type {Record<string, DocumentSummary[]>} */
  const documentsByItem = {};
  await Promise.all(
    (household.items ?? [])
      .filter((item) => (item.documentCount ?? 0) > 0)
      .map(async (item) => {
        try {
          /** @type {{ documents?: DocumentSummary[] }} */
          const body = await json(
            await fetch(`/api/households/${household.id}/items/${item.id}/documents`, {
              credentials: "same-origin",
            }),
          );
          documentsByItem[item.id] = body.documents ?? [];
        } catch {
          documentsByItem[item.id] = [];
        }
      }),
  );

  return {
    kind: "belt",
    selectedId: id,
    today,
    user: session?.user ?? null,
    household: {
      ...household,
      /* The command builders write against the raw item plus the household it
         proved membership of (#455, commands.js base()). */
      items: (household.items ?? []).map((item) => ({ ...item, householdId: household.id })),
    },
    documentsByItem,
  };
}
