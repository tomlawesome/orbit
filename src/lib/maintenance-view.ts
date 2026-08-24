/* View logic for the maintenance control and the administrator banner
   (#524, reworked for the rolling timeline in #585). Kept framework-free
   and separate from the components so the rules that decide what an
   administrator is shown — which state the control is in, which facts
   describe it, what each confirmation says — are unit-testable without a
   DOM. The components hold only fetching, form state and markup. */

export type MaintenanceWindowStatusView = "scheduled" | "open" | "resolved" | "cancelled" | "absorbed";
export type MaintenanceUpdateKindView = "scheduled" | "started" | "update" | "resolved";

/* The JSON form of the domain types in src/server/maintenance.ts: the Date
   fields arrive as ISO strings over the wire. */
export interface MaintenanceUpdateView {
  id: string;
  windowId: string;
  kind: MaintenanceUpdateKindView;
  body: string;
  publishedAt: string;
  createdAt: string;
  editedAt: string | null;
}

export interface MaintenanceWindowView {
  id: string;
  status: MaintenanceWindowStatusView;
  scheduledStartAt: string | null;
  startedAt: string | null;
  expectedEndAt: string | null;
  endedAt: string | null;
  cancelledAt: string | null;
  absorbedIntoId: string | null;
  createdAt: string;
  updatedAt: string;
  /* Ordered published_at ASC, id ASC, as the API returns it. */
  updates: MaintenanceUpdateView[];
}

export interface MaintenanceStateView {
  id: string;
  active: boolean;
  currentWindowId: string | null;
  expectedEndAt: string | null;
  version: number;
  updatedAt: string;
  effectivelyActive: boolean;
  openWindow: MaintenanceWindowView | null;
  scheduledWindows: MaintenanceWindowView[];
}

/* Mirrors the domain bounds in src/server/maintenance.ts. The domain
   owns them; these only save a round trip. */
export const MAINTENANCE_MESSAGE_MAX_LENGTH = 500;
export const MAINTENANCE_MESSAGE_MAX_LINES = 8;

/* "active": a window is open, so there is a timeline to add to. "scheduled":
   nothing is open but a due scheduled window holds the instance closed, so
   the facts come from that window and there is no timeline to publish into
   until the worker opens it. "open": users can reach Orbit. */
export type MaintenanceControlMode = "open" | "active" | "scheduled";

export interface MaintenanceFacts {
  startedAt: string | null;
  lastPublishedAt: string | null;
  expectedEndAt: string | null;
  /* Newest entry first (ADR-0013 decision 8's presentation constraint). */
  timeline: MaintenanceUpdateView[];
}

/* The scheduled window whose start time has passed — what holds the
   instance closed before the worker claims it (#525). */
export function dueScheduledWindow(state: MaintenanceStateView, now: Date): MaintenanceWindowView | null {
  return state.scheduledWindows.find(
    (window) => window.scheduledStartAt !== null && Date.parse(window.scheduledStartAt) <= now.valueOf(),
  ) ?? null;
}

/* Windows still waiting: everything the API returned as scheduled. */
export function pendingWindows(state: MaintenanceStateView): MaintenanceWindowView[] {
  return state.scheduledWindows;
}

export function controlMode(state: MaintenanceStateView, now: Date): MaintenanceControlMode {
  if (state.active || state.openWindow) return "active";
  if (state.effectivelyActive && dueScheduledWindow(state, now)) return "scheduled";
  return state.effectivelyActive ? "active" : "open";
}

/* Newest first, from an API list that arrives oldest first. The tiebreak is
   already applied server-side (published_at ASC, id ASC), so reversing is
   enough and stays deterministic. */
export function timelineNewestFirst(window: MaintenanceWindowView | null): MaintenanceUpdateView[] {
  return window ? [...window.updates].reverse() : [];
}

/* The facts shown in the closed state, taken from whichever of the open
   window or the due scheduled window is holding the instance closed. */
export function maintenanceFacts(state: MaintenanceStateView, now: Date): MaintenanceFacts {
  const window = state.openWindow ?? (state.active ? null : dueScheduledWindow(state, now));
  const timeline = timelineNewestFirst(window);
  return {
    startedAt: window?.startedAt ?? window?.scheduledStartAt ?? null,
    lastPublishedAt: timeline[0]?.publishedAt ?? null,
    expectedEndAt: window?.expectedEndAt ?? state.expectedEndAt,
    timeline,
  };
}

export function formatWhen(value: string | null): string {
  if (!value) return "Not set";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Unknown time"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/* A native datetime-local value carries no zone, so it is read as the
   viewer's local time and sent as UTC (the ADR-0013 display rule). */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

export function messageProblem(message: string): string | null {
  if (message.trim().length === 0) return "Enter the message people will see on the maintenance screen.";
  if (message.length > MAINTENANCE_MESSAGE_MAX_LENGTH) {
    return `Use ${MAINTENANCE_MESSAGE_MAX_LENGTH} characters or fewer.`;
  }
  if (message.split("\n").length > MAINTENANCE_MESSAGE_MAX_LINES) {
    return `Use ${MAINTENANCE_MESSAGE_MAX_LINES} lines or fewer.`;
  }
  return null;
}

export function characterCountLabel(message: string): string {
  return `${message.length}/${MAINTENANCE_MESSAGE_MAX_LENGTH} characters`;
}

export const CONFIRM_ACTIVATE =
  "Close Orbit to users now? Everyone except administrators will see the maintenance screen until maintenance is ended. Administrators keep full access.";

export const CONFIRM_END = "End maintenance and reopen Orbit to users?";

export function confirmSchedule(startsAtIso: string): string {
  return `Schedule maintenance for ${formatWhen(startsAtIso)}? It will start automatically at that time.`;
}

export function confirmCancelWindow(startsAtIso: string): string {
  return `Cancel this scheduled maintenance? Maintenance will not start at ${formatWhen(startsAtIso)}.`;
}

/* The banner is shown to administrators only, and only while
   maintenance is effectively active — never for a future window. */
export function bannerLines(state: MaintenanceStateView, now: Date): { headline: string; expected: string | null } | null {
  if (!state.effectivelyActive) return null;
  const facts = maintenanceFacts(state, now);
  return {
    headline: "Maintenance is active — Orbit is closed to users.",
    expected: facts.expectedEndAt ? `Expected back by ${formatWhen(facts.expectedEndAt)}.` : null,
  };
}
