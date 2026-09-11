// Stage 2 of the three-stage extraction shape (ADR-0026): every candidate
// the sieve kept comes back saying what the page called it. Nothing is
// chosen here and nothing is dropped -- a tag is evidence for stage 3, never
// a decision, so a candidate keeps every tag it earns and the order the
// sieve found them in.
//
// The mechanism is the one `context-roles.ts` already runs for dates
// (ConText, Harkema et al. 2009): a table of trigger terms, each asserting a
// tag, each looking forward ("policy number: MTR-8823") or backward
// ("MTR-8823 is your policy number"), with a scope running to the end of the
// block or sentence unless a termination term cuts it short. Dates keep
// using that module unchanged; the other four kinds run the same engine here
// over their own trigger tables. Where two scopes cover one candidate the
// nearest trigger wins, as it does there.
//
// Two things a trigger table cannot say are recorded as `shape` tags, from
// the candidate's own form rather than the words beside it: an identifier
// whose digits satisfy a published checksum, and a block printed as a
// letterhead. Shape is weaker evidence than a label, so it never asserts a
// strong tag -- a capitalised line says "this is shaped like a name", not
// "this is the provider".

import { assignContextRoleLabels, CONTEXT_TERMINATION_TERMS } from "./context-roles";
import type { Candidate, CandidateKind } from "./extraction-sieve";
import type { Tag, TagForKind, TaggedCandidate, TagStage } from "./extraction-stages";
import { validateChecksumIdentifier } from "./reference-checksums";

/**
 * One row of a kind's trigger table. `pattern` is a regular-expression
 * source (no flags -- always compiled case-insensitively and Unicode-aware)
 * matched against the raw page text, as in `context-roles.ts`. The table is
 * data, not logic: a new label is one more row.
 */
interface LabelTrigger<K extends CandidateKind = CandidateKind> {
  value: TagForKind[K];
  direction: "forward" | "backward";
  pattern: string;
}

/**
 * Amounts, as UK household paper prints them. `rival` is the figure set
 * beside the real one to tempt the reader: the upgrade tier, the do-nothing
 * price, the exit fee. Last year's premium is `previous` rather than
 * `rival`, because the page is comparing and not selling.
 */
const AMOUNT_TRIGGERS: readonly LabelTrigger<"amount">[] = [
  // total
  { value: "total", direction: "forward", pattern: "grand total" },
  { value: "total", direction: "forward", pattern: "total(?: amount| cost| price| charge| payable)?" },
  { value: "total", direction: "forward", pattern: "(?:renewal |annual |yearly )?premium(?: for the year)?" },
  { value: "total", direction: "forward", pattern: "cost for the year" },
  { value: "total", direction: "backward", pattern: "in total" },
  { value: "total", direction: "backward", pattern: "is the total(?: cost| amount)?" },
  { value: "total", direction: "backward", pattern: "is your (?:renewal )?premium" },

  // due
  { value: "due", direction: "forward", pattern: "amount due" },
  { value: "due", direction: "forward", pattern: "to pay" },
  { value: "due", direction: "forward", pattern: "balance (?:due|outstanding)" },
  { value: "due", direction: "forward", pattern: "please pay" },
  { value: "due", direction: "forward", pattern: "payable by" },
  { value: "due", direction: "backward", pattern: "is (?:now )?due" },
  { value: "due", direction: "backward", pattern: "to pay by" },

  // instalment
  { value: "instalment", direction: "forward", pattern: "instalments? of" },
  { value: "instalment", direction: "forward", pattern: "monthly (?:instalment|payment|amount)" },
  { value: "instalment", direction: "forward", pattern: "direct debit of" },
  { value: "instalment", direction: "backward", pattern: "(?:per|a|each) month" },
  { value: "instalment", direction: "backward", pattern: "monthly by direct debit" },

  // previous
  { value: "previous", direction: "forward", pattern: "last year(?: you paid)?" },
  { value: "previous", direction: "forward", pattern: "previous(?:ly)?(?: you paid)?" },
  { value: "previous", direction: "forward", pattern: "previous (?:premium|bill|balance|charge)" },
  { value: "previous", direction: "backward", pattern: "last year" },
  { value: "previous", direction: "backward", pattern: "was your previous (?:premium|price)" },

  // rival
  { value: "rival", direction: "forward", pattern: "if you take no action" },
  { value: "rival", direction: "forward", pattern: "upgrade(?:d)?(?: to)?" },
  { value: "rival", direction: "forward", pattern: "you could pay" },
  { value: "rival", direction: "forward", pattern: "(?:cancellation|exit|early repayment) (?:fee|charge)" },
  { value: "rival", direction: "backward", pattern: "to upgrade" },
  { value: "rival", direction: "backward", pattern: "if you (?:switch|cancel)" },
];

/**
 * Identifiers. The generic `reference` rows are declared last on purpose:
 * "customer reference" and "reference" both end at the same character, so
 * they tie on distance, and the tie falls to whichever row is declared
 * first. Specific labels therefore have to come before the generic one.
 */
const IDENTIFIER_TRIGGERS: readonly LabelTrigger<"identifier">[] = [
  // policy
  { value: "policy", direction: "forward", pattern: "policy(?: number| no\\.?| ref(?:erence)?)" },
  { value: "policy", direction: "backward", pattern: "is your policy (?:number|reference)" },

  // account
  { value: "account", direction: "forward", pattern: "account(?: number| no\\.?| reference)" },
  { value: "account", direction: "forward", pattern: "a/c (?:number|no\\.?)" },
  { value: "account", direction: "backward", pattern: "is your account number" },

  // customer
  { value: "customer", direction: "forward", pattern: "customer(?: reference| number| no\\.?| id)" },
  { value: "customer", direction: "backward", pattern: "is your customer (?:reference|number)" },

  // invoice
  { value: "invoice", direction: "forward", pattern: "invoice(?: number| no\\.?)" },
  { value: "invoice", direction: "backward", pattern: "is the invoice number" },

  // certificate
  { value: "certificate", direction: "forward", pattern: "certificate(?: number| no\\.?)" },
  { value: "certificate", direction: "backward", pattern: "is the certificate number" },

  // company -- the organisation's own registration, never the household's
  { value: "company", direction: "forward", pattern: "vat(?: registration)?(?: number| no\\.?)?" },
  { value: "company", direction: "forward", pattern: "company(?: registration)? (?:number|no\\.?)" },
  { value: "company", direction: "forward", pattern: "registered in england(?: (?:and|&) wales)?(?: (?:number|no\\.?))?" },
  { value: "company", direction: "forward", pattern: "firm reference(?: number)?" },
  { value: "company", direction: "forward", pattern: "(?:fca|fsa) (?:firm )?ref(?:erence)?(?: number)?" },
  { value: "company", direction: "forward", pattern: "unique taxpayer reference" },
  { value: "company", direction: "backward", pattern: "is our (?:vat|company) (?:registration|number)" },

  // reference (generic -- declared last, see the note above)
  { value: "reference", direction: "forward", pattern: "(?:payment|quote|your) ref(?:erence)?(?: number| no\\.?)?" },
  { value: "reference", direction: "forward", pattern: "ref(?:erence)?(?: number| no\\.?)?" },
  { value: "reference", direction: "backward", pattern: "is your reference" },
];

/**
 * Organisations. `provider` is the one the household deals with; every other
 * row names a body the page prints beside it -- the broker, the insurer
 * behind the brand, the regulator in the small print.
 */
const ORGANISATION_TRIGGERS: readonly LabelTrigger<"organisation">[] = [
  // administrator
  { value: "administrator", direction: "forward", pattern: "(?:policy )?administered by" },
  { value: "administrator", direction: "forward", pattern: "arranged by" },
  { value: "administrator", direction: "forward", pattern: "managed by" },
  { value: "administrator", direction: "backward", pattern: "administers (?:your|this) (?:policy|cover|account)" },
  { value: "administrator", direction: "backward", pattern: "is the administrator" },

  // underwriter
  { value: "underwriter", direction: "forward", pattern: "underwritten by" },
  { value: "underwriter", direction: "forward", pattern: "(?:your )?insurer is" },
  { value: "underwriter", direction: "forward", pattern: "insurance is provided by" },
  { value: "underwriter", direction: "backward", pattern: "underwrites (?:your|this) (?:policy|cover)" },
  { value: "underwriter", direction: "backward", pattern: "is the underwriter" },

  // on-behalf-of
  { value: "on-behalf-of", direction: "forward", pattern: "on behalf of" },
  { value: "on-behalf-of", direction: "forward", pattern: "acting for" },
  { value: "on-behalf-of", direction: "backward", pattern: "act(?:s|ing)? on behalf of" },

  // regulator
  { value: "regulator", direction: "forward", pattern: "(?:authorised and )?regulated by" },
  { value: "regulator", direction: "forward", pattern: "the regulator is" },
  { value: "regulator", direction: "backward", pattern: "regulates (?:this|our)" },
  { value: "regulator", direction: "backward", pattern: "is the regulator" },

  // installer
  { value: "installer", direction: "forward", pattern: "installed by" },
  { value: "installer", direction: "forward", pattern: "fitted by" },
  { value: "installer", direction: "forward", pattern: "installation (?:carried out|completed) by" },
  { value: "installer", direction: "backward", pattern: "(?:installed|fitted) (?:your|the)" },
  { value: "installer", direction: "backward", pattern: "is your installer" },

  // subsidiary
  { value: "subsidiary", direction: "forward", pattern: "(?:is )?a subsidiary of" },
  { value: "subsidiary", direction: "forward", pattern: "(?:is )?part of the" },
  { value: "subsidiary", direction: "forward", pattern: "a trading (?:name|style) of" },
  { value: "subsidiary", direction: "backward", pattern: "is a subsidiary" },

  // provider
  { value: "provider", direction: "forward", pattern: "provided by" },
  { value: "provider", direction: "forward", pattern: "supplied by" },
  { value: "provider", direction: "forward", pattern: "your (?:provider|supplier|energy supplier) is" },
  { value: "provider", direction: "forward", pattern: "your account is with" },
  { value: "provider", direction: "forward", pattern: "trading as" },
  { value: "provider", direction: "backward", pattern: "is your (?:provider|supplier|energy supplier)" },
  { value: "provider", direction: "backward", pattern: "supplies your" },
];

/**
 * Headings. A heading candidate is a whole block and its `index` is the
 * block's first character, so a forward trigger inside the block still
 * governs it: scope membership below is span overlap, not a point test.
 * `title` has no rows -- a document does not print "title:" above its own
 * name, so it is decided by position instead (see `shapeTags`).
 */
const HEADING_TRIGGERS: readonly LabelTrigger<"heading">[] = [
  { value: "section", direction: "forward", pattern: "section(?: \\d+)?" },
  { value: "section", direction: "forward", pattern: "(?:part|schedule|appendix|annex)(?: \\d+| [A-Z]\\b)" },
  { value: "section", direction: "backward", pattern: "continued" },
  { value: "section", direction: "backward", pattern: "\\(cont(?:inued|d|\\.)?\\)" },
];

// The same boundary as `context-roles.ts` uses: terminal punctuation, a run
// of line breaks (so a scope never leaves its Tika block), or a semicolon.
const SENTENCE_BREAK = /[.!?]+(?=\s|$)|[\r\n]+|;/gu;

interface TextSpan {
  start: number;
  end: number;
}

function findSpans(text: string, pattern: RegExp): TextSpan[] {
  const spans: TextSpan[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    spans.push({ start, end: start + match[0].length });
  }
  return spans;
}

// Sentence breaks and termination terms ("but", "however", ...) do the same
// job to a scope -- they end it -- so they are collected into one list of
// cuts. The termination vocabulary is shared with `context-roles.ts` rather
// than restated, so the two stages cannot drift apart.
function findCuts(text: string): TextSpan[] {
  const terminators = CONTEXT_TERMINATION_TERMS.length === 0
    ? []
    : findSpans(text, new RegExp(`\\b(?:${CONTEXT_TERMINATION_TERMS.join("|")})\\b`, "giu"));
  return [...findSpans(text, SENTENCE_BREAK), ...terminators];
}

// The nearest cut at or after `from`, or the end of the text.
function cutAfter(cuts: readonly TextSpan[], from: number): number {
  let end = Number.POSITIVE_INFINITY;
  for (const cut of cuts) {
    if (cut.start >= from && cut.start < end) end = cut.start;
  }
  return end;
}

// The nearest cut at or before `to`, or the start of the text.
function cutBefore(cuts: readonly TextSpan[], to: number): number {
  let start = 0;
  for (const cut of cuts) {
    if (cut.end <= to && cut.end > start) start = cut.end;
  }
  return start;
}

interface TriggerScope {
  value: TagForKind[CandidateKind];
  direction: "forward" | "backward";
  /** The edge of the trigger's own match facing its scope: the scope's
   * boundary, and the anchor distance is measured from. */
  anchor: number;
  scopeStart: number;
  scopeEnd: number;
  /** Row index in the kind's table, for deterministic tie-breaking. */
  triggerOrder: number;
  /** Start of this occurrence, for the final tie-break (earlier wins). */
  matchStart: number;
  /** The trigger's words as the page printed them, for `Tag.trigger`. */
  matchText: string;
}

function buildScopes(text: string, triggers: readonly LabelTrigger[]): TriggerScope[] {
  const cuts = findCuts(text);
  const scopes: TriggerScope[] = [];

  triggers.forEach((trigger, triggerOrder) => {
    for (const match of text.matchAll(new RegExp(trigger.pattern, "giu"))) {
      const matchStart = match.index ?? 0;
      const matchEnd = matchStart + match[0].length;
      const forward = trigger.direction === "forward";
      const scopeStart = forward ? matchEnd : cutBefore(cuts, matchStart);
      const scopeEnd = forward ? cutAfter(cuts, matchEnd) : matchStart;
      scopes.push({
        value: trigger.value,
        direction: trigger.direction,
        anchor: forward ? matchEnd : matchStart,
        scopeStart,
        scopeEnd,
        triggerOrder,
        matchStart,
        matchText: match[0],
      });
    }
  });

  return scopes;
}

// The sieve stores a normalised `value` -- minor units, an ISO date, spaces
// stripped out of a reference -- so a candidate's printed length has to be
// measured back off the page. It is needed twice: a backward trigger's
// distance runs from the candidate's END, and a heading's span is its whole
// block. Organisations and headings keep their printed text as `value`, so
// only these three kinds need measuring.
const PRINTED_FORM: Partial<Record<CandidateKind, RegExp>> = {
  date: new RegExp(
    "\\d{4}[/.-]\\d{1,2}[/.-]\\d{1,2}" +
      "|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?[A-Za-z]+\\.?\\s+\\d{2,4}" +
      "|[A-Za-z]+\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{2,4}" +
      "|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}",
    "yiu",
  ),
  amount: /(?:[£€$]\s?|(?:GBP|EUR|USD)\s?)?\d{1,3}(?:,\d{3})*(?:\.\d{2})?/yu,
  identifier: /[A-Z0-9/-]+(?:\s\d{2,4})*/yu,
};

function printedLength(text: string, candidate: Candidate): number {
  const pattern = PRINTED_FORM[candidate.kind];
  if (!pattern) return candidate.value.length;
  pattern.lastIndex = candidate.index;
  const match = pattern.exec(text);
  // A form the page printed in a way this regex does not cover falls back to
  // the normalised value's length: wrong by a few characters at worst, and
  // only ever shifts a distance comparison.
  return match ? match[0].length : candidate.value.length;
}

// A candidate is inside a scope when the two spans overlap at all. For a
// point-like candidate this is ConText's ordinary test; for a heading, whose
// span is the whole block, it is what lets a trigger printed inside the
// block ("Section 4 Making a claim") govern it.
function labelTag(start: number, end: number, scopes: readonly TriggerScope[]): Tag | null {
  const covering = scopes.filter((scope) => start < scope.scopeEnd && end > scope.scopeStart);
  if (covering.length === 0) return null;

  const distance = (scope: TriggerScope) =>
    scope.direction === "forward" ? Math.max(0, start - scope.anchor) : Math.max(0, scope.anchor - end);

  covering.sort((a, b) => {
    const distanceA = distance(a);
    const distanceB = distance(b);
    if (distanceA !== distanceB) return distanceA - distanceB;
    if (a.triggerOrder !== b.triggerOrder) return a.triggerOrder - b.triggerOrder;
    return a.matchStart - b.matchStart;
  });

  return { value: covering[0].value, trigger: covering[0].matchText, source: "label" };
}

// A letterhead: a short block set in capitals, or with every word
// capitalised. The sieve already treats such a block as a name; this is the
// same judgement recorded as evidence.
const TITLE_CASE_WORD = /^(?:[A-Z][A-Za-z'’&.-]*|&|of|and|for|the)$/u;

function looksLikeLetterhead(line: string): boolean {
  const words = line.split(" ").filter((word) => word.length > 0);
  if (words.length < 2) return false;
  if (/[A-Za-z]/u.test(line) && line === line.toUpperCase()) return true;
  return words.every((word) => TITLE_CASE_WORD.test(word));
}

function shapeTags(candidate: Candidate, firstHeadingIndex: number): Tag[] {
  if (candidate.kind === "identifier") {
    // Published check arithmetic, not a guess: a number that balances is the
    // organisation's own registration, whatever the page prints beside it.
    const checksum = validateChecksumIdentifier(candidate.value);
    return checksum.valid && checksum.kind
      ? [{ value: "company", trigger: checksum.kind, source: "shape" }]
      : [];
  }
  if (candidate.kind === "organisation" && looksLikeLetterhead(candidate.line)) {
    // Deliberately `other`, never `provider`: a letterhead says the block is
    // shaped like a name, which is a hint for stage 3, not a claim about
    // whose paper this is.
    return [{ value: "other", trigger: candidate.line, source: "shape" }];
  }
  if (candidate.kind === "heading") {
    // Position, not words: the page's first short block is its own title and
    // every later one is a section head. The trigger is empty because no
    // words justified it -- stage 3 must see that this is a guess.
    return [{ value: candidate.index === firstHeadingIndex ? "title" : "section", trigger: "", source: "shape" }];
  }
  return [];
}

/**
 * Stage 2. Tags every candidate with what the page says it is, keeping the
 * order the sieve produced. Pure: no I/O, no mutation of its arguments.
 *
 * Dates go to `assignContextRoles`' sibling in `context-roles.ts`, unchanged
 * apart from asking it which trigger won; the other kinds run the engine
 * above over their own tables. Every candidate leaves with at least one tag:
 * a kind with no label and no shape falls back to its `other` and an empty
 * trigger, which is how a guess admits to being one.
 */
export const tagCandidates: TagStage = (text, candidates) => {
  const scopesByKind: Record<Exclude<CandidateKind, "date">, TriggerScope[]> = {
    amount: buildScopes(text, AMOUNT_TRIGGERS),
    identifier: buildScopes(text, IDENTIFIER_TRIGGERS),
    organisation: buildScopes(text, ORGANISATION_TRIGGERS),
    heading: buildScopes(text, HEADING_TRIGGERS),
  };

  // One ConText pass over all the dates at once, then consumed in order --
  // the date candidates keep their relative order, so a running cursor lines
  // each assignment up with the candidate it came from.
  const dateAssignments = assignContextRoleLabels(
    text,
    candidates
      .filter((candidate) => candidate.kind === "date")
      .map((candidate) => ({
        value: candidate.value,
        index: candidate.index,
        length: printedLength(text, candidate),
      })),
  );
  let nextDate = 0;

  const headingIndexes = candidates.filter((c) => c.kind === "heading").map((c) => c.index);
  const firstHeadingIndex = headingIndexes.length === 0 ? -1 : Math.min(...headingIndexes);

  return candidates.map((candidate): TaggedCandidate => {
    const tags: Tag[] = [];

    if (candidate.kind === "date") {
      const assignment = dateAssignments[nextDate];
      nextDate += 1;
      tags.push({ value: assignment.role, trigger: assignment.trigger, source: "label" });
    } else {
      const start = candidate.index;
      const label = labelTag(start, start + printedLength(text, candidate), scopesByKind[candidate.kind]);
      if (label) tags.push(label);
    }

    tags.push(...shapeTags(candidate, firstHeadingIndex));
    if (tags.length === 0) tags.push({ value: "other", trigger: "", source: "label" });

    return { ...candidate, tags };
  });
};
