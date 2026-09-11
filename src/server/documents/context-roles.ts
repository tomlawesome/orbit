import { documentDateRoles, type DocumentDateRole } from "@/server/documents/suggestions";

/**
 * A clean-room implementation of ConText for one narrow job: given a date
 * that has already been found in a document, decide which role it plays.
 *
 * Harkema, H., Dowling, J. N., Scheible, T. and Chapman, W. W. (2009).
 * "ConText: An algorithm for determining negation, experiencer, and temporal
 * status from clinical reports." Journal of Biomedical Informatics 42(5),
 * 839-851. doi:10.1016/j.jbi.2009.05.002.
 *
 * ConText classifies a target (there, a clinical condition; here, a date) by
 * scanning the sentence around it for trigger terms. Each trigger carries a
 * role it asserts, a direction it looks in (forward: "renewal date: 1
 * October" governs what follows; backward: "1 October is your renewal date"
 * governs what precedes), and a scope that runs to the end of the sentence
 * unless a termination term or another trigger's edge cuts it short first.
 * A target outside every trigger's scope gets the algorithm's default.
 *
 * This module does not find dates -- `dates.ts` equivalents elsewhere in
 * `src/server/documents/` already do that (see `extractDates` in
 * `suggestions.ts`, which is not exported because it discards position; this
 * module needs position, so it takes it as input rather than re-deriving it).
 * It reuses `DocumentDateRole`, the closed role vocabulary already defined in
 * `suggestions.ts` for the model-extraction path (ADR-0025 section 3), so a
 * role produced here can be plugged straight into that vocabulary without a
 * translation layer.
 *
 * Design decisions this file makes, since the published algorithm leaves
 * both open:
 *
 * - Overlap: when a date sits inside more than one trigger's scope, the
 *   NEAREST trigger wins -- the one whose scope-opening edge (the end of a
 *   forward trigger's match, or the start of a backward trigger's match) is
 *   closest to the date, measured from whichever end of the date actually
 *   faces that trigger (its start for a forward trigger, its end for a
 *   backward one). This matches the intuition that a label right next
 *   to a date describes it more reliably than one several clauses away. Ties
 *   (equal distance) fall to whichever trigger is declared earlier in
 *   `CONTEXT_ROLE_TRIGGERS`, and after that to whichever trigger occurrence
 *   starts earlier in the text -- both arbitrary but deterministic.
 * - Default role: `"other"`, the same catch-all already in
 *   `DocumentDateRole` for "a date worth keeping with no specific meaning
 *   pinned down" -- exactly the state of a date no trigger governs.
 */

/**
 * A date already located in the document text. `index` is the offset of the
 * date's first character; this module only needs a start position to test
 * scope membership, not the date's length.
 */
export interface LocatedDate {
  /** Opaque to this module -- typically an ISO date string, but never parsed here. */
  value: string;
  /** Offset of the date's first character in the `text` passed alongside it. */
  index: number;
  /**
   * Length, in characters, of the date's own text at that offset (e.g. 14
   * for "1 October 2026"), not the length of `value` -- the two differ
   * whenever `value` has been normalised. Needed so a backward trigger
   * right after the date ("... is your renewal date") measures its distance
   * from the date's END, not its start; without it, a long written date
   * would look farther from a trailing trigger than it really is.
   */
  length: number;
}

export type ContextTriggerDirection = "forward" | "backward";

/**
 * One entry in the trigger table. `pattern` is a regular-expression source
 * (no flags -- it is always compiled case-insensitively and Unicode-aware)
 * matched against the raw document text.
 */
export interface ContextRoleTrigger {
  role: DocumentDateRole;
  direction: ContextTriggerDirection;
  pattern: string;
}

/**
 * Trigger terms as UK household paper actually writes them, grouped by the
 * role they assert. `"other"` has none: it is reached only by default, never
 * asserted -- a document does not have an "other date" section heading.
 * The table is data, not logic, so a new trigger is one more row here.
 */
export const CONTEXT_ROLE_TRIGGERS: readonly ContextRoleTrigger[] = [
  // renewal
  { role: "renewal", direction: "forward", pattern: "renewal date" },
  { role: "renewal", direction: "forward", pattern: "renews? on" },
  { role: "renewal", direction: "forward", pattern: "date of renewal" },
  { role: "renewal", direction: "forward", pattern: "due for renewal(?: on)?" },
  // UK contracts print the end of the tie-in as "minimum term", and the
  // household has to choose again when it arrives.
  { role: "renewal", direction: "forward", pattern: "(?:minimum|initial|fixed)(?: \\d{1,2}[- ]month)? term\\b" },
  { role: "renewal", direction: "backward", pattern: "is your renewal date" },
  { role: "renewal", direction: "backward", pattern: "is when (?:your policy|this) renews" },

  // expiry
  { role: "expiry", direction: "forward", pattern: "expiry date" },
  { role: "expiry", direction: "forward", pattern: "expir(?:es|ing|ed)(?: on)?" },
  // The stated end of a policy or plan that runs to a date years away.
  { role: "expiry", direction: "forward", pattern: "(?:policy|cover|plan|contract) end date" },
  { role: "expiry", direction: "forward", pattern: "valid (?:until|to|through)" },
  // "ends on" says a term stops there; whether that is an expiry or a
  // renewal is settled in `extraction-tags.ts` from the words around it.
  { role: "expiry", direction: "forward", pattern: "(?:cover |policy |plan |contract |licence |membership |tariff |price )?\\b(?:ends?|ending)\\b(?: on)?" },
  { role: "expiry", direction: "backward", pattern: "is the expiry date" },
  { role: "expiry", direction: "backward", pattern: "is when (?:your cover|this) expires" },

  // due
  { role: "due", direction: "forward", pattern: "payment due(?: by| on)?" },
  { role: "due", direction: "forward", pattern: "due date" },
  { role: "due", direction: "forward", pattern: "amount due by" },
  { role: "due", direction: "forward", pattern: "due by" },
  { role: "due", direction: "backward", pattern: "is due" },
  { role: "due", direction: "backward", pattern: "is when payment is due" },

  // service
  { role: "service", direction: "forward", pattern: "service due" },
  { role: "service", direction: "forward", pattern: "next service" },
  { role: "service", direction: "forward", pattern: "next (?:vaccination|booster|check-?up|appointment|visit|test|inspection|examination)(?: recommended)?(?: due| by)?" },
  { role: "service", direction: "forward", pattern: "date\\(?s?\\)? of inspection(?: and testing)?" },
  { role: "service", direction: "forward", pattern: "inspect(?:ed|ion)(?: carried out)?(?: on)?" },
  { role: "service", direction: "forward", pattern: "service date" },
  { role: "service", direction: "forward", pattern: "serviced on" },
  { role: "service", direction: "backward", pattern: "is your next service date" },

  // issued
  { role: "issued", direction: "forward", pattern: "date of issue" },
  { role: "issued", direction: "forward", pattern: "issued on" },
  { role: "issued", direction: "forward", pattern: "issue date" },
  // What a statement, bill or certificate calls its own date.
  { role: "issued", direction: "forward", pattern: "(?:statement|bill|invoice|notice|test|certificate|document|report) (?:date|issued)" },
  { role: "issued", direction: "backward", pattern: "is the date of issue" },
  { role: "issued", direction: "backward", pattern: "is when this was issued" },

  // start
  { role: "start", direction: "forward", pattern: "start date" },
  { role: "start", direction: "forward", pattern: "valid from" },
  { role: "start", direction: "forward", pattern: "starts on" },
  { role: "start", direction: "forward", pattern: "cover starts" },
  { role: "start", direction: "forward", pattern: "policy started" },
  { role: "start", direction: "forward", pattern: "commencing" },
  { role: "start", direction: "forward", pattern: "(?:service|contract|cover|policy|plan|tenancy|membership) start" },
  { role: "start", direction: "forward", pattern: "date of installation" },
  { role: "start", direction: "backward", pattern: "is your start date" },
  { role: "start", direction: "backward", pattern: "is when (?:your cover|this) (?:begins|starts)" },
] as const satisfies readonly ContextRoleTrigger[];

/**
 * Termination terms: conjunctions that end a clause's claim on what follows
 * or precedes it, even mid-sentence. `"renewal date: 1 October, but your
 * policy started 3 January"` must not let "renewal date" reach past the
 * "but" to claim the second date -- this table is what stops it. Sentence
 * punctuation (below) already terminates scope on its own, so it is not
 * repeated here.
 */
export const CONTEXT_TERMINATION_TERMS: readonly string[] = [
  "but",
  "however",
  "although",
  "except",
  "unless",
  "whereas",
];

// A sentence boundary: terminal punctuation followed by space or end of text,
// a run of line breaks (form-style documents put each field on its own
// line), or a semicolon. Known limitation: a period after an abbreviation
// inside a date (e.g. the "." in "1 Jan. 2026") reads as a sentence end too,
// so a trigger's scope will not reach a second date past it in the same
// written sentence -- see the module report for the accepted case this gets
// wrong.
const SENTENCE_BREAK = /[.!?]+(?=\s|$)|[\r\n]+|;/gu;

interface TextSpan {
  start: number;
  end: number;
}

function findSentenceBreaks(text: string): TextSpan[] {
  const breaks: TextSpan[] = [];
  for (const match of text.matchAll(SENTENCE_BREAK)) {
    const start = match.index ?? 0;
    breaks.push({ start, end: start + match[0].length });
  }
  return breaks;
}

function findTerminators(text: string): TextSpan[] {
  if (CONTEXT_TERMINATION_TERMS.length === 0) return [];
  const pattern = new RegExp(`\\b(?:${CONTEXT_TERMINATION_TERMS.join("|")})\\b`, "giu");
  const terminators: TextSpan[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    terminators.push({ start, end: start + match[0].length });
  }
  return terminators;
}

// The nearest sentence-break start at or after `from`, or the end of the text.
function sentenceEndAfter(breaks: readonly TextSpan[], from: number): number {
  let end = Number.POSITIVE_INFINITY;
  for (const brk of breaks) {
    if (brk.start >= from && brk.start < end) end = brk.start;
  }
  return end;
}

// The nearest sentence-break end at or before `to`, or 0.
function sentenceStartBefore(breaks: readonly TextSpan[], to: number): number {
  let start = 0;
  for (const brk of breaks) {
    if (brk.end <= to && brk.end > start) start = brk.end;
  }
  return start;
}

// The nearest termination-term start at or after `from` (exclusive lower
// bound already enforced by the caller), or +Infinity.
function terminatorEndingAfter(terminators: readonly TextSpan[], from: number): number {
  let end = Number.POSITIVE_INFINITY;
  for (const term of terminators) {
    if (term.start >= from && term.start < end) end = term.start;
  }
  return end;
}

// The nearest termination-term end at or before `to`, or -Infinity.
function terminatorEndingBefore(terminators: readonly TextSpan[], to: number): number {
  let start = Number.NEGATIVE_INFINITY;
  for (const term of terminators) {
    if (term.end <= to && term.end > start) start = term.end;
  }
  return start;
}

interface TriggerScope {
  role: DocumentDateRole;
  direction: ContextTriggerDirection;
  /** Position of the edge of the trigger's own match closest to its scope -- used both as the scope's boundary and as the distance anchor for overlap resolution. */
  anchor: number;
  scopeStart: number;
  scopeEnd: number;
  /** Index into `CONTEXT_ROLE_TRIGGERS`, for deterministic tie-breaking. */
  triggerOrder: number;
  /** Start of the trigger's own match, for the final tie-break (earlier occurrence wins). */
  matchStart: number;
  /** The trigger's own words as the document printed them, so a caller can
   * report what justified the role rather than just the role itself. */
  matchText: string;
}

// Distance from a date to a scope's anchor, measured from whichever edge of
// the date actually faces the trigger: a forward trigger sits before the
// date, so its anchor is compared to the date's start; a backward trigger
// sits after the date, so its anchor is compared to the date's end.
function anchorDistance(date: LocatedDate, scope: TriggerScope): number {
  return scope.direction === "forward"
    ? Math.abs(date.index - scope.anchor)
    : Math.abs(scope.anchor - (date.index + date.length));
}

// Punctuation and spacing only: the label is the whole line, so whatever it
// names is printed somewhere else.
function onlySpacing(text: string): boolean {
  return text.replace(/[\s:.\-–—()]/gu, "").length === 0;
}

/**
 * The end of the first non-empty line after `from`, or `null` when there is
 * none. A form label is printed as a line of its own with its value on the
 * line below ("NEXT VACCINATION DUE" / "18 May 2027"), and a scope that
 * stopped dead at the line break could never reach such a date.
 */
function nextLineEndAfter(text: string, from: number): number | null {
  const rest = text.slice(from);
  const match = /[^\S\r\n]*[\r\n]+\s*[^\r\n]+/u.exec(rest);
  return match && match.index === 0 ? from + match[0].length : null;
}

function buildTriggerScopes(text: string): TriggerScope[] {
  const breaks = findSentenceBreaks(text);
  const terminators = findTerminators(text);
  const scopes: TriggerScope[] = [];
  // The same boundary as `breaks` without the line breaks, for the one case
  // that has to cross one.
  const hardBreaks = breaks.filter((brk) => /[.!?;]/u.test(text.slice(brk.start, brk.end)));

  CONTEXT_ROLE_TRIGGERS.forEach((trigger, triggerOrder) => {
    const regex = new RegExp(trigger.pattern, "giu");
    for (const match of text.matchAll(regex)) {
      const matchStart = match.index ?? 0;
      const matchEnd = matchStart + match[0].length;
      if (trigger.direction === "forward") {
        const scopeStart = matchEnd;
        let scopeEnd = Math.min(
          sentenceEndAfter(breaks, scopeStart),
          terminatorEndingAfter(terminators, scopeStart),
        );
        // A label that ends its own line reaches the line below it, unless
        // real punctuation or a termination term intervenes.
        const lineEnd = text.indexOf("\n", matchEnd);
        if (lineEnd !== -1 && onlySpacing(text.slice(matchEnd, lineEnd))) {
          const reach = nextLineEndAfter(text, matchEnd);
          const limit = Math.min(
            sentenceEndAfter(hardBreaks, scopeStart),
            terminatorEndingAfter(terminators, scopeStart),
          );
          if (reach !== null) scopeEnd = Math.max(scopeEnd, Math.min(reach, limit));
        }
        scopes.push({
          role: trigger.role,
          direction: trigger.direction,
          anchor: scopeStart,
          scopeStart,
          scopeEnd,
          triggerOrder,
          matchStart,
          matchText: match[0],
        });
      } else {
        const scopeEnd = matchStart;
        const scopeStart = Math.max(
          sentenceStartBefore(breaks, scopeEnd),
          terminatorEndingBefore(terminators, scopeEnd),
        );
        scopes.push({
          role: trigger.role,
          direction: trigger.direction,
          anchor: scopeEnd,
          scopeStart,
          scopeEnd,
          triggerOrder,
          matchStart,
          matchText: match[0],
        });
      }
    }
  });

  return scopes;
}

/**
 * A role together with the words that justified it, for callers that have to
 * show their working (the extraction pipeline's stage 2 records the trigger
 * beside every tag, so a tag with no trigger is visibly a guess).
 */
export interface ContextRoleAssignment {
  role: DocumentDateRole;
  /** The trigger's own words, verbatim from the text, or `""` when the date
   * fell outside every scope and took the default role. */
  trigger: string;
  /** How far the winning trigger's anchor sat from the date, in characters,
   * or `Infinity` for the default -- so a caller with evidence of its own
   * can tell whether that evidence sits nearer than this one did. */
  distance: number;
}

/**
 * The same scan as `assignContextRoles`, reporting which trigger won as well
 * as the role it asserted. `assignContextRoles` is the role-only view of
 * this, kept as the narrower contract most callers want.
 */
export function assignContextRoleLabels(
  text: string,
  dates: readonly LocatedDate[],
): ContextRoleAssignment[] {
  const scopes = buildTriggerScopes(text);

  return dates.map((date) => {
    const covering = scopes.filter((scope) => date.index >= scope.scopeStart && date.index < scope.scopeEnd);
    if (covering.length === 0) return { role: "other", trigger: "", distance: Number.POSITIVE_INFINITY };

    covering.sort((a, b) => {
      const distanceA = anchorDistance(date, a);
      const distanceB = anchorDistance(date, b);
      if (distanceA !== distanceB) return distanceA - distanceB;
      if (a.triggerOrder !== b.triggerOrder) return a.triggerOrder - b.triggerOrder;
      return a.matchStart - b.matchStart;
    });

    return {
      role: covering[0].role,
      trigger: covering[0].matchText,
      distance: anchorDistance(date, covering[0]),
    };
  });
}

/**
 * Assigns a `DocumentDateRole` to each of `dates`, in the same order they
 * were given, by running ConText's trigger-and-scope scan over `text`. Pure:
 * no I/O, no mutation of its arguments.
 */
export function assignContextRoles(text: string, dates: readonly LocatedDate[]): DocumentDateRole[] {
  return assignContextRoleLabels(text, dates).map((assignment) => assignment.role);
}

// Re-exported so a caller that only has this module in scope can still name
// the full role vocabulary without importing `suggestions.ts` directly.
export { documentDateRoles, type DocumentDateRole };
