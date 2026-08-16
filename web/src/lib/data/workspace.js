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

/** Thrown with the server's own error code so screens can react to specifics. */
export class WorkspaceError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "WorkspaceError";
    this.status = status;
    this.code = code;
  }
}

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
let sessionPromise = null;

export function readSession({ refresh = false } = {}) {
  if (refresh || !sessionPromise) {
    sessionPromise = fetch("/api/auth/session", { credentials: "same-origin" })
      .then(json)
      .catch((error) => {
        sessionPromise = null;
        throw error;
      });
  }
  return sessionPromise;
}

/** The whole workspace: households, their sections, items and activity. */
export async function readWorkspace() {
  const body = await json(
    await fetch("/api/workspace", { credentials: "same-origin" }),
  );
  return body.workspace;
}

/**
 * Applies one command and returns the workspace as the server now sees it.
 * A stale CSRF token is retried once against a fresh session rather than
 * surfacing as a failure the user can do nothing about.
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

  const body = await json(response);
  return body.workspace;
}

/** The household the session is currently pointed at, with its sections. */
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
import { relayFixture } from "./fixtures/relay.js";
import { settingsFixture } from "./fixtures/settings.js";
import { adminFixture } from "./fixtures/admin.js";
import { galaxyOf, labelledSkyOf } from "./chart.js";
import { approvalItemOf, receiptFailuresOf, receiptSuggestionsOf } from "./inbox.js";

/** A mutating fetch with the session's CSRF token, like applyCommand's. */
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
 */
export async function readInbox() {
  const body = await json(await fetch("/api/imap-inbox", { credentials: "same-origin" }));
  return { receipts: body.receipts ?? [], households: body.households ?? [] };
}

/**
 * Approve a mail-in suggestion as proposed (#434): assign a household if the
 * receipt has none, read the review (fresh draftVersion, first section, the
 * staged attachments), then approve through the reviewed-intake protocol.
 * The operationId makes retries idempotent — a double-tap cannot create two
 * items — so callers keep ONE id per receipt across attempts.
 */
export async function approveReceipt(suggestion, fallbackHouseholdId, operationId, amendedItem = null) {
  const householdId = suggestion.householdId ?? fallbackHouseholdId;
  if (!householdId) throw new WorkspaceError("This account has no household yet", { code: "no_household" });
  if (!suggestion.householdId) {
    await json(await csrfFetch(`/api/imap-inbox/${suggestion.receiptId}`, { method: "PUT", body: { householdId } }));
  }
  const review = await json(
    await fetch(`/api/imap-inbox/${suggestion.receiptId}?householdId=${householdId}`, { credentials: "same-origin" }),
  );
  const section = review.sections?.[0];
  if (!section) throw new WorkspaceError("This household has no section to file into", { code: "no_section" });
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

/** Discard a mail-in receipt; its staged files are purged server-side. */
export async function dismissReceipt(receiptId) {
  await json(await csrfFetch(`/api/imap-inbox/${receiptId}`, { method: "DELETE" }));
}

/** "Request to join X system?" (§11, #453) — idempotent server-side, so a
 * double-tap can never file twice. */
export async function requestToJoin(householdId) {
  return json(await csrfFetch(`/api/households/${householdId}/join-requests`, { body: {} }));
}

/** The pending join requests this user may decide (owners and admins). */
export async function readJoinRequests() {
  const body = await json(await fetch("/api/join-requests", { credentials: "same-origin" }));
  return body.requests ?? [];
}

/** Approve or decline a join request (§11 authority, enforced server-side). */
export async function decideJoinRequest(requestId, action) {
  return json(await csrfFetch(`/api/join-requests/${requestId}`, { body: { action } }));
}

/** Owner/admin direct add: membership without a request (§11). */
export async function addMember(householdId, userId) {
  return json(await csrfFetch(`/api/households/${householdId}/members`, { body: { userId } }));
}

/**
 * "Today" for chart arithmetic. The workspace fixture pins it to the date the
 * designs were drawn against so the fidelity gate is deterministic; the real
 * API carries no such field, so live data uses the real clock.
 */
function todayOf(workspace) {
  return workspace?.fixtureToday ?? new Date().toISOString().slice(0, 10);
}

/**
 * Everything the home screen renders (#451): the fixed sky, the primary
 * household (dial and manifest), any document suggestions (none from the live
 * API yet — #454), the signed-in user, and the date the chart reckons from.
 */
export async function readHome() {
  const [workspace, session, inbox] = await Promise.all([
    readWorkspace(),
    readSession(),
    /* Additive: mail-in suggestions enrich home, they must never sink it. */
    readInbox().catch(() => ({ receipts: [] })),
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
    readInbox().catch(() => ({ receipts: [] })),
    readRelay(),
  ]);
  const receipts = inbox.receipts ?? [];
  const primary = workspace.activeHouseholdId ?? workspace.households[0]?.id ?? null;
  const caught = receipts
    .filter((receipt) => receipt.classification !== "waiting")
    .map((receipt) => receipt.receivedAt)
    .sort()
    .pop() ?? null;
  return {
    user: session?.user ?? null,
    household: workspace.households.find((one) => one.id === primary) ?? null,
    primary,
    today: todayOf(workspace),
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
    readInbox().catch(() => ({ receipts: [] })),
  ]);
  const primary = workspace.activeHouseholdId ?? workspace.households[0]?.id ?? null;
  const documentsByItem = {};
  await Promise.all(
    workspace.households.flatMap((household) =>
      (household.items ?? [])
        .filter((item) => (item.documentCount ?? 0) > 0)
        .map(async (item) => {
          try {
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
 * the last from a fixture until #468 gives it a route.
 */
export async function readSettingsScreen() {
  const [workspace, session, inbox, relay] = await Promise.all([
    readWorkspace(),
    readSession(),
    readInbox().catch(() => ({ receipts: [] })),
    readRelay(),
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
    reminders: settingsFixture.reminders,
  };
}

/**
 * Everything mission control renders (#465): the instance's people (real
 * route), its systems from the workspace (admins see everything, §11), and
 * the parts no route can answer yet — ownership, membership counts, join
 * requests, the relay's levers — from the admin fixture until #453/#432
 * make them real. Live data omits what it cannot know.
 */
export async function readAdminScreen() {
  const [workspace, session, users, joinRequests] = await Promise.all([
    readWorkspace(),
    readSession(),
    json(await fetch("/api/admin/users", { credentials: "same-origin" }))
      .then((body) => body.users ?? [])
      .catch(() => []),
    /* Real since #453: pending requests the caller may decide. Additive. */
    readJoinRequests().catch(() => []),
  ]);
  const primary = workspace.activeHouseholdId ?? workspace.households[0]?.id ?? null;
  return {
    user: session?.user ?? null,
    household: workspace.households.find((one) => one.id === primary) ?? null,
    primary,
    today: todayOf(workspace),
    now: workspace.fixtureToday ? `${workspace.fixtureToday}T12:00:00Z` : new Date().toISOString(),
    users,
    households: workspace.households,
    ...adminFixture,
    joinRequests,
  };
}

const shortDate = (iso) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

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
 */
export async function readItem(id) {
  const workspace = await readWorkspace();
  for (const household of workspace.households) {
    const item = (household.items ?? []).find((one) => one.id === id);
    if (!item) continue;
    const sections = new Map((household.sections ?? []).map((s) => [s.id, s.name]));
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

/** The signed-in user's mail-in relay. Live source: the #432 endpoint. */
export async function readRelay() {
  return relayFixture;
}
