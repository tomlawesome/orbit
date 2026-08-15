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
import { galaxyOf } from "./chart.js";

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
 * API yet — #452), the signed-in user, and the date the chart reckons from.
 */
export async function readHome() {
  const [workspace, session] = await Promise.all([readWorkspace(), readSession()]);
  const primary = workspace.activeHouseholdId ?? workspace.households[0]?.id ?? null;
  const today = todayOf(workspace);
  return {
    galaxy: galaxyOf(workspace, today),
    primary,
    household: workspace.households.find((one) => one.id === primary) ?? null,
    suggestions: workspace.suggestions ?? [],
    user: session?.user ?? null,
    today,
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
      section: sections.get(item.sectionId) ?? null,
      documents: (body.documents ?? []).map((doc) => ({
        name: doc.displayName,
        meta: `added ${shortDate(doc.availableAt)} · ${sizeLabel(doc.sizeBytes)}`,
      })),
    };
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
