/* View logic for the maintenance control and the administrator banner
   (#524). Kept framework-free and separate from the components so the
   rules that decide what an administrator is shown — which state the
   control is in, which facts describe it, what each confirmation says —
   are unit-testable without a DOM. The components hold only fetching,
   form state and markup. */

export interface MaintenanceNoticeView {
  id: string;
  message: string;
  startsAt: string;
  expectedEndAt: string | null;
  activatedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
}

/* The JSON form of MaintenanceState in src/server/maintenance.ts: the
   Date fields arrive as ISO strings over the wire. */
export interface MaintenanceStateView {
  id: string;
  active: boolean;
  message: string | null;
  messagePublishedAt: string | null;
  expectedEndAt: string | null;
  activatedAt: string | null;
  version: number;
  updatedAt: string;
  effectivelyActive: boolean;
  notices: MaintenanceNoticeView[];
}

/* Mirrors the domain bounds in src/server/maintenance.ts. The domain
   owns them; these only save a round trip. */
export const MAINTENANCE_MESSAGE_MAX_LENGTH = 500;
export const MAINTENANCE_MESSAGE_MAX_LINES = 8;

/* "active": the singleton is active, so there is a published message to
   edit. "notice": nothing is active but a due notice holds the instance
   closed, so the facts come from the notice and there is no singleton
   message to edit. "open": users can reach Orbit. */
export type MaintenanceControlMode = "open" | "active" | "notice";

export interface MaintenanceFacts {
  message: string | null;
  activatedAt: string | null;
  messagePublishedAt: string | null;
  expectedEndAt: string | null;
}

export function pendingNotices(state: MaintenanceStateView): MaintenanceNoticeView[] {
  return state.notices.filter((notice) => notice.activatedAt === null && notice.cancelledAt === null);
}

/* The pending notice whose start time has passed — what holds the
   instance closed before the worker claims it (#525). */
export function dueNotice(state: MaintenanceStateView, now: Date): MaintenanceNoticeView | null {
  return pendingNotices(state).find((notice) => Date.parse(notice.startsAt) <= now.valueOf()) ?? null;
}

export function controlMode(state: MaintenanceStateView, now: Date): MaintenanceControlMode {
  if (state.active) return "active";
  if (state.effectivelyActive && dueNotice(state, now)) return "notice";
  return state.effectivelyActive ? "active" : "open";
}

/* The facts shown in the active state, taken from whichever of the
   singleton or the due notice is holding the instance closed. */
export function maintenanceFacts(state: MaintenanceStateView, now: Date): MaintenanceFacts {
  if (!state.active) {
    const notice = dueNotice(state, now);
    if (notice) {
      return {
        message: notice.message,
        activatedAt: notice.startsAt,
        messagePublishedAt: notice.createdAt,
        expectedEndAt: notice.expectedEndAt,
      };
    }
  }
  return {
    message: state.message,
    activatedAt: state.activatedAt,
    messagePublishedAt: state.messagePublishedAt,
    expectedEndAt: state.expectedEndAt,
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

export function confirmCancelNotice(startsAtIso: string): string {
  return `Cancel this scheduled maintenance notice? Maintenance will not start at ${formatWhen(startsAtIso)}.`;
}

/* The banner is shown to administrators only, and only while
   maintenance is effectively active — never for a future notice. */
export function bannerLines(state: MaintenanceStateView, now: Date): { headline: string; expected: string | null } | null {
  if (!state.effectivelyActive) return null;
  const facts = maintenanceFacts(state, now);
  return {
    headline: "Maintenance is active — Orbit is closed to users.",
    expected: facts.expectedEndAt ? `Expected back by ${formatWhen(facts.expectedEndAt)}.` : null,
  };
}
