import { isValidPassphrase } from "./recovery-bundle";

// The recovery-bundle/restore machine-prompt protocol (issue #296 slice 4),
// extending docs/engine-events.md's "Machine prompts (v0)" vocabulary —
// today scoped only to configure.sh's guided fields — to the backup/restore
// family's own interactive passphrase/confirmation flows
// (export-recovery-bundle.sh's passphrase + confirmation, import-recovery-
// bundle.sh's passphrase + "Type IMPORT RECOVERY", restore.sh's own "Type
// RESTORE"). Per the plan (docs/adr-notes/296-backup-port-plan.md, Slice 4),
// "extending that vocabulary is this slice's job."
//
// This module is pure protocol logic: field/kind/reason vocabulary,
// acceptance validators, and the line-grammar driver, all decoupled from any
// concrete I/O via injected write/readLine callbacks (a `MachinePromptDriver`)
// — mirroring configure.sh's own separation between `machine_prompt_collect`
// (the driver) and its validator/classifier callbacks. The CLI
// (src/cli/orbit.ts) supplies the real driver: a machine-mode driver bound to
// stdin/stdout when `ORBIT_RECOVERY_PROMPTS=machine` is set (this module's
// own analogue of `ORBIT_CONFIGURE_PROMPTS=machine`), or an interactive
// terminal driver otherwise. No prompt line, for any field, ever carries a
// prompted value — only the fixed field/kind/reason vocabulary below, mirroring
// docs/engine-events.md's existing "Security" contract for OIDC_CLIENT_SECRET.

export type RecoveryPromptField = "RECOVERY_PASSPHRASE" | "RECOVERY_PASSPHRASE_CONFIRM" | "IMPORT_CONFIRMATION" | "RESTORE_CONFIRMATION";

export type RecoveryPromptKind = "secret" | "text";

export type RecoveryPromptReason = "empty" | "too-short" | "mismatch" | "no-match";

/** RECOVERY_PASSPHRASE/RECOVERY_PASSPHRASE_CONFIRM are `kind=secret`; the two literal-phrase confirmations are `kind=text` — never echoed either way, but `secret` additionally signals "mask this on a TTY" to the CLI driver. */
export function recoveryPromptFieldKind(field: RecoveryPromptField): RecoveryPromptKind {
  switch (field) {
    case "RECOVERY_PASSPHRASE":
    case "RECOVERY_PASSPHRASE_CONFIRM":
      return "secret";
    case "IMPORT_CONFIRMATION":
    case "RESTORE_CONFIRMATION":
      return "text";
  }
}

/** import-recovery-bundle.sh:88-94's exact literal confirmation phrase. */
export const IMPORT_CONFIRMATION_PHRASE = "IMPORT RECOVERY";

/** restore.sh:903-909's exact literal confirmation phrase (guarantee #46). */
export const RESTORE_CONFIRMATION_PHRASE = "RESTORE";

// --- validators (accept/reject only; never themselves pick a reason) -------

/** export-recovery-bundle.sh #6 / recovery-crypto.mjs's own defense-in-depth length check. */
export function validateRecoveryPassphrase(input: string): string | undefined {
  return isValidPassphrase(input) ? input : undefined;
}

/** export-recovery-bundle.sh #7: the confirmation entry must match the already-accepted passphrase exactly. */
export function validatePassphraseConfirmation(passphrase: string): (input: string) => string | undefined {
  return (input: string): string | undefined => (input === passphrase ? input : undefined);
}

function validateLiteralConfirmation(expected: string): (input: string) => string | undefined {
  return (input: string): string | undefined => (input === expected ? input : undefined);
}

/** import-recovery-bundle.sh #19: the operator must type the literal phrase exactly. */
export const validateImportConfirmation = validateLiteralConfirmation(IMPORT_CONFIRMATION_PHRASE);

/** restore.sh guarantee #46: the operator must type the literal phrase exactly. */
export const validateRestoreConfirmation = validateLiteralConfirmation(RESTORE_CONFIRMATION_PHRASE);

// --- reason classification (diagnostic-only second pass over an answer
// already known to be rejected — never itself decides acceptance, matching
// configure.sh's own classify_*_rejection contract) -------------------------

export function classifyRecoveryPassphraseRejection(input: string): RecoveryPromptReason {
  return input.length === 0 ? "empty" : "too-short";
}

export function classifyPassphraseConfirmationRejection(input: string): RecoveryPromptReason {
  return input.length === 0 ? "empty" : "mismatch";
}

export function classifyLiteralConfirmationRejection(input: string): RecoveryPromptReason {
  return input.length === 0 ? "empty" : "no-match";
}

// --- line-grammar driver ----------------------------------------------------

/**
 * One line per exchange, `key=value` tokens only, mirroring
 * docs/engine-events.md's existing machine-prompt grammar exactly:
 *
 *   prompt field=<FIELD> kind=<KIND> required=true attempt=<n>
 *   prompt-reject field=<FIELD> reason=<REASON>
 *   prompt-accept field=<FIELD>
 *   prompt-abort field=<FIELD>
 *
 * `write` is called with each line's content, newline-exclusive (the
 * caller's transport adds its own line terminator); `readLine` returns one
 * answer line's content, or `undefined` on end-of-input.
 */
export interface MachinePromptDriver {
  write(line: string): void;
  readLine(): string | undefined;
}

/** Thrown when a field is aborted (three rejected attempts, or end-of-input) — the caller's existing refusal path, matching configure.sh's `machine_prompt_collect` returning failure for its own caller to `fail` on. */
export class RecoveryPromptAbortedError extends Error {
  readonly field: RecoveryPromptField;

  constructor(field: RecoveryPromptField) {
    super(`orbit: no valid answer was given for ${field}`);
    this.name = "RecoveryPromptAbortedError";
    this.field = field;
  }
}

const MAX_ATTEMPTS = 3;

export interface CollectMachinePromptFieldOptions<T> {
  field: RecoveryPromptField;
  driver: MachinePromptDriver;
  validate: (input: string) => T | undefined;
  classifyRejection: (input: string) => RecoveryPromptReason;
}

/**
 * Drives one machine-mode field to completion: emits a `prompt` line, reads
 * exactly one answer line, and emits `prompt-accept`/`prompt-reject` per the
 * grammar above — bounded at three attempts (`attempt` starts at 1), after
 * which (or on end-of-input) it emits `prompt-abort` and throws
 * `RecoveryPromptAbortedError`, exactly mirroring configure.sh's own
 * `machine_prompt_collect` bound and end-of-input handling.
 */
export function collectMachinePromptField<T>(options: CollectMachinePromptFieldOptions<T>): T {
  const kind = recoveryPromptFieldKind(options.field);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    options.driver.write(`prompt field=${options.field} kind=${kind} required=true attempt=${attempt}`);
    const input = options.driver.readLine();
    if (input === undefined) {
      options.driver.write(`prompt-abort field=${options.field}`);
      throw new RecoveryPromptAbortedError(options.field);
    }
    const value = options.validate(input);
    if (value !== undefined) {
      options.driver.write(`prompt-accept field=${options.field}`);
      return value;
    }
    options.driver.write(`prompt-reject field=${options.field} reason=${options.classifyRejection(input)}`);
  }
  options.driver.write(`prompt-abort field=${options.field}`);
  throw new RecoveryPromptAbortedError(options.field);
}

/** Collects RECOVERY_PASSPHRASE then RECOVERY_PASSPHRASE_CONFIRM in machine mode, matching export-recovery-bundle.sh's own read-then-confirm ordering. */
export function collectMachineRecoveryPassphrase(driver: MachinePromptDriver): string {
  const passphrase = collectMachinePromptField({
    field: "RECOVERY_PASSPHRASE",
    driver,
    validate: validateRecoveryPassphrase,
    classifyRejection: classifyRecoveryPassphraseRejection,
  });
  collectMachinePromptField({
    field: "RECOVERY_PASSPHRASE_CONFIRM",
    driver,
    validate: validatePassphraseConfirmation(passphrase),
    classifyRejection: classifyPassphraseConfirmationRejection,
  });
  return passphrase;
}

/** Collects only RECOVERY_PASSPHRASE in machine mode (import-recovery-bundle.sh has no confirmation entry for the passphrase it reads — only for IMPORT_CONFIRMATION). */
export function collectMachineRecoveryPassphraseNoConfirm(driver: MachinePromptDriver): string {
  return collectMachinePromptField({
    field: "RECOVERY_PASSPHRASE",
    driver,
    validate: validateRecoveryPassphrase,
    classifyRejection: classifyRecoveryPassphraseRejection,
  });
}

export function collectMachineImportConfirmation(driver: MachinePromptDriver): void {
  collectMachinePromptField({
    field: "IMPORT_CONFIRMATION",
    driver,
    validate: validateImportConfirmation,
    classifyRejection: classifyLiteralConfirmationRejection,
  });
}

export function collectMachineRestoreConfirmation(driver: MachinePromptDriver): void {
  collectMachinePromptField({
    field: "RESTORE_CONFIRMATION",
    driver,
    validate: validateRestoreConfirmation,
    classifyRejection: classifyLiteralConfirmationRejection,
  });
}
