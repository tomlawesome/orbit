// The engine event stream v0 plain-mode line format (docs/engine-events.md),
// ported from scripts/installer-ui.sh's `installer_ui_emit`
// (docs/installer-guarantees.md, installer-ui.sh guarantee #1: "Only
// fixed-vocabulary values for phase/component/state/reason/action pass
// through to operator-visible output; any unrecognised value is rendered as
// the literal string `unknown`"). issue #295 slice 5's install-orchestrator.ts
// emits progress purely as `{phase, component, state, reason, action}`
// records; this module is the single place that vocabulary-validates and
// formats them into the documented `phase=... component=... state=...
// reason=... action=... elapsed=Ns` line — the same stream orbit-launcher's
// mission console already consumes from install.sh, per issue #295's own
// acceptance criteria ("Uses the #260 semantic-event vocabulary for all
// user-facing progress").

export interface EngineEvent {
  phase: string;
  component: string;
  state: string;
  reason: string;
  action: string;
}

// Transcribed verbatim from docs/engine-events.md's "## Vocabulary" section;
// engine-event.test.ts asserts these lists stay byte-identical to that
// document so a future vocabulary addition there is caught here too.
export const PHASE_VOCABULARY = [
  "bootstrap",
  "host",
  "identity",
  "assets",
  "configuration",
  "oidc",
  "compose",
  "preparation",
  "database",
  "application",
  "optional",
  "complete",
  "rollback",
] as const;

export const COMPONENT_VOCABULARY = [
  "installer",
  "host",
  "image",
  "assets",
  "configuration",
  "oidc",
  "compose",
  "database",
  "application",
  "clamav",
  "tika",
  "ollama",
] as const;

export const STATE_VOCABULARY = ["waiting", "starting", "running", "healthy", "skipped", "completed", "blocked", "failed"] as const;

export const REASON_VOCABULARY = [
  "initial",
  "target",
  "channel",
  "digest",
  "source-revision",
  "semantic-version",
  "revision",
  "configuration",
  "configuration-required",
  "discovery",
  "compose-config",
  "database-image",
  "service-start",
  "status-verified",
  "installed",
  "host-tools",
  "image-identity",
  "assets-verified",
  "configuration-migration",
  "provider-discovery",
  "compose-validation",
  "service-preparation",
  "database-health",
  "application-health",
  "optional-status",
  "deployment-ready",
  "docker-host",
  "image-registry",
  "configuration-failure",
  "provider-unavailable",
  "database-auth-migration",
  "application-startup",
  "health-timeout",
  "optional-unavailable",
  "failure",
  "rollback",
  "repair-unavailable",
  "unknown",
] as const;

export const ACTION_VOCABULARY = [
  "begin",
  "validate",
  "pull",
  "inspect",
  "fetch",
  "configure",
  "verify",
  "check",
  "start",
  "wait",
  "health",
  "skip",
  "status",
  "complete",
  "retry",
  "rollback",
  "repair",
  "continue",
  "display",
] as const;

function normalize(value: string, vocabulary: readonly string[]): string {
  return vocabulary.includes(value) ? value : "unknown";
}

/** installer_ui_elapsed (installer-ui.sh guarantee #2): non-negative integer seconds, else "0s". */
function formatElapsed(elapsedSeconds: number): string {
  return Number.isInteger(elapsedSeconds) && elapsedSeconds >= 0 ? `${elapsedSeconds}s` : "0s";
}

/**
 * Formats one plain-mode engine event line (docs/engine-events.md's "## Line
 * format"), vocabulary-validating every field first (guarantee #1) — an
 * unrecognised value is rendered as the literal `unknown`, never echoed
 * verbatim.
 */
export function formatEngineEventLine(event: EngineEvent, elapsedSeconds: number): string {
  const phase = normalize(event.phase, PHASE_VOCABULARY);
  const component = normalize(event.component, COMPONENT_VOCABULARY);
  const state = normalize(event.state, STATE_VOCABULARY);
  const reason = normalize(event.reason, REASON_VOCABULARY);
  const action = normalize(event.action, ACTION_VOCABULARY);
  return `phase=${phase} component=${component} state=${state} reason=${reason} action=${action} elapsed=${formatElapsed(elapsedSeconds)}`;
}

/** install.sh's default_failure_reason (install.sh:211-223). */
export function defaultFailureReason(phase: string): string {
  switch (phase) {
    case "host":
      return "docker-host";
    case "identity":
    case "assets":
    case "preparation":
      return "image-registry";
    case "configuration":
    case "compose":
      return "configuration-failure";
    case "oidc":
      return "provider-unavailable";
    case "database":
      return "database-auth-migration";
    case "application":
      return "health-timeout";
    case "optional":
      return "optional-unavailable";
    default:
      return "failure";
  }
}

/** install.sh's default_failure_action (install.sh:224-229). */
export function defaultFailureAction(phase: string): "repair" | "retry" {
  return phase === "database" || phase === "application" || phase === "optional" ? "repair" : "retry";
}
