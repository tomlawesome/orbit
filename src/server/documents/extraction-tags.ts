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

import {
  assignContextRoleLabels,
  CONTEXT_TERMINATION_TERMS,
  type ContextRoleAssignment,
  type DocumentDateRole,
} from "./context-roles";
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
  /** A qualifier: it says what a figure is NOT ("net", "excluding", "if you
   * upgrade", "estimated"), so it beats a plain label describing the same
   * figure however much nearer that label sits. Without this, the label
   * touching the figure always wins, and a qualifier is rarely the nearest
   * words on the page -- it is the words that frame them. */
  overrides?: true;
  /** Only a label when it is the entire block. Tika prints a form label as
   * its own block ("Policy \n\nMTR-8823-0145"), which is the only place a
   * bare word like "Policy" or "Reference" can be trusted to name a value
   * rather than just appear in a sentence. */
  labelBlockOnly?: true;
}

/**
 * Amounts, as UK household paper prints them. `rival` is the figure set
 * beside the real one to tempt the reader: the upgrade tier, the do-nothing
 * price, the exit fee. Last year's premium is `previous` rather than
 * `rival`, because the page is comparing and not selling.
 */
const AMOUNT_TRIGGERS: readonly LabelTrigger<"amount">[] = [
  // Qualified labels come first: a qualifier decides what the number is, and
  // the plain label inside it would otherwise tie and win on declaration
  // order. Several run on towards the figure (`[^£\\n]{0,40}`) so that the
  // qualifier, and not the bare word within it, is its nearest trigger.

  // "including IPT" is the price; "excluding" it, or the tax line itself, is
  // not. The inclusive form is declared first so it wins the tie.
  { value: "total", direction: "forward", overrides: true,
    pattern: "(?:annual |monthly |total )?(?:premium|charge|price|cost),? (?:includ(?:ing|es)|inc\\.?)[^£\\n]{0,40}" },

  // Not a price at all: the tax line, the net-of-tax subtotal, the price of
  // the thing covered, a cover limit, an excess, a deposit, a set-up fee.
  { value: "other", direction: "forward", overrides: true,
    pattern: "(?:insurance )?premium tax(?:,? (?:charged )?at [\\d.]+ ?%)?" },
  { value: "other", direction: "forward", overrides: true,
    pattern: "(?:net|gross)(?: [a-z]+){0,2} (?:premium|price|charge|cost|total|payment|amount)" },
  { value: "other", direction: "forward", overrides: true,
    pattern: "(?:premium|total|charge|cost|price|amount)s? (?:excluding|exc\\.?|before|net of)[^£\\n]{0,40}" },
  { value: "other", direction: "forward", overrides: true,
    pattern: "(?:price|cost|value)(?: paid)? (?:for|of) (?:the |your )?(?:appliance|item|goods|product|vehicle|property|equipment)" },
  { value: "other", direction: "forward", overrides: true, pattern: "(?:up to|maximum of|no more than)" },
  { value: "other", direction: "forward", overrides: true,
    pattern: "(?:cover(?:age)?|limit|sum insured|benefit) (?:of|at|up to)" },
  { value: "other", direction: "forward", overrides: true, pattern: "(?:excess|deposit)(?: of)?" },
  { value: "other", direction: "forward", overrides: true,
    pattern: "(?:joining|arrangement|admin(?:istration)?|set-?up|one-?off|late|missed|returned|non-?return) (?:fee|charge)" },

  // previous: last year's figure, however the page words it
  { value: "previous", direction: "forward", overrides: true,
    pattern: "last year(?:'s|\u2019s)?(?:\\s+[a-z\u2019']+){0,3}\\s+(?:premium|price|charge|cost|bill)" },
  { value: "previous", direction: "forward", pattern: "last year(?: you paid)?" },
  { value: "previous", direction: "forward", pattern: "previous(?:ly)?(?: you paid)?" },
  { value: "previous", direction: "forward", pattern: "previous (?:premium|bill|balance|charge)" },
  { value: "previous", direction: "backward", pattern: "last year" },
  { value: "previous", direction: "backward", pattern: "was your previous (?:premium|price)" },

  // rival: the figure printed beside the real one to be read instead of it
  { value: "rival", direction: "forward", overrides: true, pattern: "estimated[^£\\n]{0,40}" },
  { value: "rival", direction: "forward", overrides: true,
    pattern: "if (?:you |we |it )?(?:pay|paying|paid|choose|chose|select|take no action|switch|cancel|upgrade|purchas)[^£\\n]{0,40}" },
  { value: "rival", direction: "forward", overrides: true,
    pattern: "(?:over|for)\\s+(?:the\\s+)?(?:full\\s+|whole\\s+|entire\\s+)?term[^£\\n]{0,40}" },
  { value: "rival", direction: "forward", overrides: true,
    pattern: "a new (?:fixed )?(?:plan|tariff|deal|policy)[^£\\n]{0,40}" },
  // The add-on offered beside the cover is not the cover.
  { value: "rival", direction: "forward", overrides: true, pattern: "\\badd (?:on |a |the )?[^£\\n]{0,40}" },
  // A price that only starts on a future date is not this year's price.
  { value: "rival", direction: "forward", overrides: true, pattern: "from \\d{1,2} [A-Za-z]+ \\d{4}" },
  { value: "rival", direction: "backward", overrides: true, pattern: "from \\d{1,2} [A-Za-z]+ \\d{4}" },
  { value: "rival", direction: "backward", overrides: true, pattern: "for(?: your)? first \\d{1,2} months?" },
  { value: "rival", direction: "forward", pattern: "if you take no action" },
  { value: "rival", direction: "forward", pattern: "upgrade(?:d)?(?: to)?" },
  { value: "rival", direction: "forward", pattern: "you could pay" },
  { value: "rival", direction: "forward", pattern: "(?:cancellation|exit|early repayment) (?:fee|charge)" },
  { value: "rival", direction: "backward", pattern: "to upgrade" },
  { value: "rival", direction: "backward", pattern: "if you (?:switch|cancel)" },

  // instalment. "Monthly" is itself a qualifier: it says the figure is one
  // of many, so it overrides the plain labels it is printed with.
  { value: "instalment", direction: "forward", overrides: true,
    pattern: "(?:your )?monthly(?: [a-z]+){0,2} (?:instalment|payment|amount|charge|price|cost|fee|contribution)" },
  { value: "instalment", direction: "backward", overrides: true,
    pattern: "(?:standard )?monthly(?: [a-z]+){0,2} (?:charge|fee|price|cost|contribution)" },
  // "Monthly by Direct Debit (£15.75 x 12, total £189.00)": everything in
  // the bracket prices paying monthly, not the thing being paid for.
  { value: "instalment", direction: "forward", overrides: true,
    pattern: "(?:monthly|quarterly|weekly) by direct debit[^£\\n]{0,60}" },
  { value: "instalment", direction: "forward", pattern: "instalments? of" },
  { value: "instalment", direction: "forward", pattern: "direct debit of" },
  { value: "instalment", direction: "backward", pattern: "(?:per|a|each) month" },
  { value: "instalment", direction: "backward", pattern: "(?:by )?(?:monthly|quarterly|weekly) direct debit" },

  // total
  { value: "total", direction: "forward", pattern: "grand total" },
  { value: "total", direction: "forward", pattern: "total(?: amount| cost| price| charge| payable)?" },
  { value: "total", direction: "forward", pattern: "(?:renewal |annual |yearly )?premium(?: for the year)?" },
  { value: "total", direction: "forward", pattern: "(?:total|charge|cost|price) for the year" },
  { value: "total", direction: "forward", pattern: "price paid" },
  // A bare "Fee" heads the figure on a licence or a permit. The set-up and
  // penalty fees are demoted above, so what is left is the price.
  { value: "total", direction: "forward", pattern: "fee\\b" },
  // The pay-in-one-go box on a form, against the pay-monthly box beside it.
  { value: "total", direction: "forward", pattern: "single(?: \\d{1,2}[ -]month)? payment" },
  { value: "total", direction: "forward", pattern: "(?:total|amount) (?:for|covering) the year" },
  { value: "total", direction: "backward", pattern: "(?:per|a|each) (?:year|annum)" },
  { value: "total", direction: "backward", pattern: "is the total(?: cost| amount)?" },
  { value: "total", direction: "backward", pattern: "is your (?:renewal )?premium" },

  // due
  { value: "due", direction: "forward", pattern: "amount (?:due|payable|to pay|outstanding)" },
  { value: "due", direction: "forward", pattern: "to pay" },
  { value: "due", direction: "forward", pattern: "balance (?:due|outstanding)" },
  { value: "due", direction: "forward", pattern: "please pay" },
  { value: "due", direction: "forward", pattern: "payable by" },
  { value: "due", direction: "backward", pattern: "is (?:now )?due" },
  { value: "due", direction: "backward", pattern: "to pay by" },
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
  { value: "policy", direction: "forward", pattern: "plan(?: number| no\\.?)" },
  { value: "policy", direction: "backward", pattern: "is your policy (?:number|reference)" },

  // account
  { value: "account", direction: "forward", pattern: "account(?: number| no\\.?| reference)" },
  { value: "account", direction: "forward", pattern: "a/c (?:number|no\\.?)" },
  // Pages head the number with the bare word as often as with "number":
  // "GENERATION ACCOUNT SEG-4471-0932", "ACCOUNT 8847 2210 55".
  // "My account", and the "myaccount." of a printed web page's address bar,
  // are navigation rather than a label.
  { value: "account", direction: "forward", pattern: "(?<!my )\\baccount\\b" },
  { value: "account", direction: "backward", pattern: "is your account number" },

  // customer
  { value: "customer", direction: "forward", pattern: "customer(?: reference| number| no\\.?| id)" },
  { value: "customer", direction: "backward", pattern: "is your customer (?:reference|number)" },

  // invoice
  { value: "invoice", direction: "forward", pattern: "invoice(?: number| no\\.?)" },
  { value: "invoice", direction: "backward", pattern: "is the invoice number" },

  // certificate -- a document the household holds, numbered as itself: a
  // certificate, a licence, a test record. The number IS their reference.
  { value: "certificate", direction: "forward", pattern: "certificate(?: number| no\\.?)" },
  { value: "certificate", direction: "forward", pattern: "licen[cs]e(?: number| no\\.?)" },
  { value: "certificate", direction: "forward", pattern: "test(?: certificate)? number" },
  { value: "certificate", direction: "backward", pattern: "is the certificate number" },

  // company -- the organisation's own registration, never the household's
  { value: "company", direction: "forward", pattern: "vat(?: registration)?(?: number| no\\.?)?" },
  { value: "company", direction: "forward", pattern: "company(?: registration)? (?:number|no\\.?)" },
  { value: "company", direction: "forward", pattern: "registered in england(?: (?:and|&) wales)?(?: (?:number|no\\.?))?" },
  { value: "company", direction: "forward", pattern: "firm reference(?: number)?" },
  { value: "company", direction: "forward", pattern: "(?:fca|fsa) (?:firm )?ref(?:erence)?(?: number)?" },
  { value: "company", direction: "forward", pattern: "unique taxpayer reference" },
  { value: "company", direction: "backward", pattern: "is our (?:vat|company) (?:registration|number)" },

  // membership
  { value: "customer", direction: "forward", pattern: "membership(?: number| no\\.?)" },

  // A reference with a noun in front of it names that noun, not the
  // household: the issuing body's own file ("Authority reference"), the
  // building ("Property reference"), the agreement between two other
  // parties ("contract reference"), the document this one refers to
  // ("Schedule ref", "booklet reference"), or nothing at all ("prepared
  // with reference to the National Wiring Safety Code"). Only the words a
  // page uses for the household's own file are let through, which is why
  // this is a lookahead over one short list rather than a list of the
  // hundred nouns that can precede "reference".
  {
    value: "other",
    direction: "forward",
    pattern:
      "\\b(?!(?:your|our|payment|account|policy|plan|customer|client|order|membership|invoice|certificate|licen[cs]e|quoting|quote this)\\b)[A-Za-z]+,?\\s+ref(?:erence)?(?: number| no\\.?)?\\b",
  },

  // Single words Tika prints as a block of their own, above the value. They
  // assert nothing in running prose, so they carry `labelBlockOnly`.
  { value: "policy", direction: "forward", pattern: "policy", labelBlockOnly: true },
  { value: "account", direction: "forward", pattern: "account", labelBlockOnly: true },
  { value: "customer", direction: "forward", pattern: "(?:customer|membership)", labelBlockOnly: true },
  { value: "invoice", direction: "forward", pattern: "invoice", labelBlockOnly: true },
  { value: "certificate", direction: "forward", pattern: "certificate", labelBlockOnly: true },

  // reference (generic -- declared last, see the note above)
  { value: "reference", direction: "forward", pattern: "(?:payment|order|your) ref(?:erence)?(?: number| no\\.?)?" },
  { value: "reference", direction: "forward", pattern: "ref(?:erence)?(?: number| no\\.?)?" },
  { value: "reference", direction: "backward", pattern: "is your reference" },
  { value: "reference", direction: "forward", pattern: "reference", labelBlockOnly: true },
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
  return [...findSpans(text, SENTENCE_BREAK), ...findTerminators(text)];
}

// The same list without the line breaks. A label-only block reaches across
// the blank line into the block below it (see `buildScopes`), so that reach
// has to be bounded by something a blank line is not: real punctuation, or a
// termination term.
function findHardCuts(text: string): TextSpan[] {
  return [...findSpans(text, /[.!?]+(?=\s|$)|;/gu), ...findTerminators(text)];
}

function findTerminators(text: string): TextSpan[] {
  if (CONTEXT_TERMINATION_TERMS.length === 0) return [];
  return findSpans(text, new RegExp(`\\b(?:${CONTEXT_TERMINATION_TERMS.join("|")})\\b`, "giu"));
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

// Tika's blocks, kept as raw offsets rather than the collapsed lines
// `pageBlocks` returns, because scope arithmetic is done in page offsets.
function blockSpans(text: string): TextSpan[] {
  return findSpans(text, /[^\n]+/gu).filter((span) => text.slice(span.start, span.end).trim().length > 0);
}

function blockAround(blocks: readonly TextSpan[], index: number): TextSpan | null {
  return blocks.find((block) => index >= block.start && index < block.end) ?? null;
}

// Nothing but spacing and punctuation between the trigger and its block's
// edge: the block is the label and the value is somewhere else.
function onlySpacing(text: string): boolean {
  return text.replace(/[\s:.\-–—()£]/gu, "").length === 0;
}

// The block after a label-only block is where Tika put the value: "COUNCIL
// TAX ACCOUNT NUMBER \n\n8845612033". The scope therefore ends at the end of
// the first following block that holds a candidate of this kind, unless a
// hard cut or another trigger stops it sooner.
function blockEndAfter(
  blocks: readonly TextSpan[],
  from: number,
  limit: number,
  targets: readonly number[],
): number | null {
  for (const block of blocks) {
    if (block.start < from) continue;
    if (block.start >= limit) break;
    if (targets.some((target) => target >= block.start && target < block.end && target < limit)) {
      return Math.min(block.end, limit);
    }
  }
  return null;
}

// The mirror: a label-only block sitting under the value it names ("£84.99
// \n\nper year") reaches back to the start of the nearest preceding block
// that holds a candidate of this kind.
function blockStartBefore(
  blocks: readonly TextSpan[],
  to: number,
  limit: number,
  targets: readonly number[],
): number | null {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block.end > to) continue;
    if (block.end <= limit) break;
    if (targets.some((target) => target >= block.start && target < block.end && target >= limit)) {
      return Math.max(block.start, limit);
    }
  }
  return null;
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
  /** See `LabelTrigger.overrides`. */
  overrides: boolean;
}

/**
 * Every scope the table's triggers open over `text`. `targets` is where this
 * kind's candidates start, needed only for the cross-block rule: a scope
 * that leaves its own block has to know which block below or above it is the
 * one holding the value.
 */
function buildScopes(
  text: string,
  triggers: readonly LabelTrigger[],
  targets: readonly number[],
): TriggerScope[] {
  const cuts = findCuts(text);
  const hardCuts = findHardCuts(text);
  const blocks = blockSpans(text);
  const scopes: TriggerScope[] = [];

  // Collected first, because a trigger's reach across a block boundary stops
  // at the next trigger, whichever row that came from.
  const matches: Array<{ triggerOrder: number; trigger: LabelTrigger; start: number; end: number; text: string }> = [];
  triggers.forEach((trigger, triggerOrder) => {
    for (const match of text.matchAll(new RegExp(trigger.pattern, "giu"))) {
      const start = match.index ?? 0;
      matches.push({ triggerOrder, trigger, start, end: start + match[0].length, text: match[0] });
    }
  });
  const triggerSpans: TextSpan[] = matches.map((match) => ({ start: match.start, end: match.end }));

  for (const match of matches) {
    const block = blockAround(blocks, match.start);
    const nothingAfter = block !== null && onlySpacing(text.slice(match.end, block.end));
    const nothingBefore = block !== null && onlySpacing(text.slice(block.start, match.start));

    // A single-word label ("Policy", "Reference") is only a label when it is
    // the whole block; in prose it is an ordinary word and asserts nothing.
    if (match.trigger.labelBlockOnly && !(nothingBefore && nothingAfter)) continue;

    // Whether the label can reach into the next block is decided by whether
    // its own block holds a value for it to name, not by whether the label
    // is the last word printed: Tika keeps "ANNUAL PREMIUM, PAID IN FULL" as
    // one block, and the premium is in the block under it. A row that holds
    // its own figure ("Monthly membership fee ... £42.50") is answered where
    // it stands and reaches nowhere.
    //
    // A token left hanging on a hyphen is a value Tika broke over the line
    // ("Reference NDPA-" / "208467"), so the label has already reached its
    // value and must not reach past it into the next one.
    const valueInBlock =
      block !== null &&
      (targets.some((target) => target >= block.start && target < block.end) ||
        /[-/]$/u.test(text.slice(match.end, block.end).trim()));

    const forward = match.trigger.direction === "forward";
    let scopeStart = forward ? match.end : cutBefore(cuts, match.start);
    let scopeEnd = forward ? cutAfter(cuts, match.end) : match.start;

    if (forward && !valueInBlock && block !== null) {
      const limit = Math.min(cutAfter(hardCuts, match.end), cutAfter(triggerSpans, match.end));
      const reach = blockEndAfter(blocks, block.end, limit, targets);
      if (reach !== null) scopeEnd = Math.max(scopeEnd, reach);
    }
    if (!forward && !valueInBlock && block !== null) {
      const limit = Math.max(cutBefore(hardCuts, match.start), cutBefore(triggerSpans, match.start));
      const reach = blockStartBefore(blocks, block.start, limit, targets);
      if (reach !== null) scopeStart = Math.min(scopeStart, reach);
    }

    scopes.push({
      value: match.trigger.value,
      direction: match.trigger.direction,
      anchor: forward ? match.end : match.start,
      scopeStart,
      scopeEnd,
      triggerOrder: match.triggerOrder,
      matchStart: match.start,
      matchText: match.text,
      overrides: match.trigger.overrides === true,
    });
  }

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
interface LabelMatch {
  tag: Tag;
  /** Which occurrence of which trigger won, so that one label can be held
   * to naming one value (see `keepOneValuePerLabel`). */
  scope: TriggerScope;
  distance: number;
}

function labelTag(start: number, end: number, scopes: readonly TriggerScope[]): LabelMatch | null {
  const covering = scopes.filter((scope) => start < scope.scopeEnd && end > scope.scopeStart);
  if (covering.length === 0) return null;

  const distance = (scope: TriggerScope) =>
    scope.direction === "forward" ? Math.max(0, start - scope.anchor) : Math.max(0, scope.anchor - end);

  covering.sort((a, b) => {
    // A qualifier outranks distance: see `LabelTrigger.overrides`.
    if (a.overrides !== b.overrides) return a.overrides ? -1 : 1;
    const distanceA = distance(a);
    const distanceB = distance(b);
    if (distanceA !== distanceB) return distanceA - distanceB;
    if (a.triggerOrder !== b.triggerOrder) return a.triggerOrder - b.triggerOrder;
    return a.matchStart - b.matchStart;
  });

  return {
    tag: { value: covering[0].value, trigger: covering[0].matchText, source: "label" },
    scope: covering[0],
    distance: distance(covering[0]),
  };
}

/**
 * One label names one value. "Account number 7734 2210 91 · Mobile number
 * 07700 900123" prints two numbers inside one label's scope, and a scope
 * that claims both turns a page that said exactly which number is the
 * account into three candidates that all say they are the account -- a tie
 * stage 3 can only answer by saying nothing. So each occurrence of a
 * trigger keeps the candidate nearest it and lets the rest fall back to
 * `other`, which is what they are: values the page did not label.
 */
function keepOneValuePerLabel(labels: Array<LabelMatch | null>): void {
  const nearest = new Map<TriggerScope, number>();
  labels.forEach((label, at) => {
    if (!label) return;
    const held = nearest.get(label.scope);
    if (held === undefined || label.distance < (labels[held] as LabelMatch).distance) nearest.set(label.scope, at);
  });
  labels.forEach((label, at) => {
    if (label && nearest.get(label.scope) !== at) labels[at] = null;
  });
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
 * A printed date range -- "15 October 2025 to 15 October 2026", "from 14
 * June 2026 until 13 June 2031". The connector is treated as one rule over
 * a PAIR of dates rather than as trigger-table rows, because a row asserts
 * one tag and this asserts two different ones: the first date starts the
 * period, the second ends it.
 */
const RANGE_CONNECTOR = /^[\s(]*(?:to|until|till|through|up to|–|—|-)[\s)]*$/iu;

/**
 * Words that say the period a range describes is the household's own term:
 * what they are covered by, signed up to, or charged for. Read from the
 * words the block prints BEFORE the range, which is where UK paper puts the
 * label ("Period of insurance 14 March 2026 to 14 March 2027", "for the
 * service charge year running from 1 April 2026 to 31 March 2027"). A
 * printed duration ("12 months, from ...", "for a period of 5 years") says
 * the same thing without a noun.
 */
const TERM_LEAD =
  /period of (?:insurance|cover)|cover|polic(?:y|ies)|contract|agreement|membership|licen[cs]e|tariff|guarantee|warrant(?:y|ies)|tenancy|term|charge for the year|fixed rate|\d{1,3}\s*-?\s*(?:month|year)s?/iu;

/**
 * Words that say the period is a window the page is REPORTING on rather
 * than a term the household holds: a statement period, a billing period, a
 * quarter, a transaction history, a year already ended. Nothing in such a
 * range is a date the household acts on, so no role is asserted at all --
 * these ranges are the bulk of the date-like strings on a statement, and
 * calling them starts and expiries is how a page of table rows turns into a
 * page of wrong answers. Checked after `TERM_LEAD`, and beats it.
 */
const REPORTING_LEAD = /statement|billing|transaction|quarter|reading|scheme year|year ended|summary|history/iu;

/**
 * The period belongs to the organisation, not the household: an installer's
 * trade-scheme registration, an accreditation. Its dates are facts about the
 * company in the same way its VAT number is.
 */
const ORGANISATION_PERIOD = /scheme registration|registered with|accreditation|accredited by/iu;

/**
 * A term that simply runs out when it ends, so its last date is an `expiry`
 * and not a `renewal`: a guarantee, a warranty, a certificate, or any period
 * the page itself calls an expiry. Everything else the household holds for a
 * term -- cover, a contract, a membership, a tariff, a charge year -- rolls
 * onto something and has to be acted on again, which is `renewal`.
 */
const RUNS_OUT = /\b(?:guarantee|warranty|certificate)\b|expir/iu;

/** Trigger words that only say a date bounds a period, without saying what
 * kind of period: the range connectors and the validity labels. What such a
 * date means depends on the term around it (see `termEndRole`). */
const TERM_END_TRIGGER =
  /^(?:(?:cover |policy |plan |contract |licence |membership |tariff |price )?(?:ends?|ending)(?: on)?|valid (?:to|until|through)|to|until|till|through|up to|–|—|-)$/iu;

interface DateSpan {
  index: number;
  length: number;
}

function blockTextAround(text: string, index: number): { block: string; lead: string } {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return {
    block: text.slice(start, end === -1 ? text.length : end),
    lead: text.slice(start, index),
  };
}

/** `expiry` when the period runs out, `renewal` when it has to be taken
 * again. Decided from the block the date sits in, not from the document, so
 * a certificate that also prints a contract term gets both right. */
function termEndRole(block: string): DocumentDateRole {
  return RUNS_OUT.test(block) ? "expiry" : "renewal";
}

/**
 * Rewrites the ConText assignments of any two adjacent dates joined by a
 * range connector to `start` and the end role its term deserves. A label
 * that sits nearer than the connector keeps the date: "Renewal date: A to B"
 * leaves A alone, because the range is only the weaker reading of what joins
 * two dates.
 *
 * A range asserts nothing unless the words before it say which period it is
 * (`TERM_LEAD`, and not `REPORTING_LEAD`). Two dates side by side are a
 * period on any page that prints a table; only the label says whether the
 * household's cover, or last quarter's meter reads, is what the period is.
 */
function applyDateRanges(
  text: string,
  spans: readonly DateSpan[],
  assignments: ContextRoleAssignment[],
): void {
  for (let i = 0; i + 1 < spans.length; i += 1) {
    const left = spans[i];
    const right = spans[i + 1];
    const gapStart = left.index + left.length;
    const between = text.slice(gapStart, right.index);
    if (!RANGE_CONNECTOR.test(between)) continue;

    const { block, lead } = blockTextAround(text, left.index);
    if (!TERM_LEAD.test(lead)) continue;
    if (REPORTING_LEAD.test(lead)) continue;
    if (ORGANISATION_PERIOD.test(block)) continue;

    const connector = between.trim();
    const connectorStart = gapStart + between.indexOf(connector);
    const connectorEnd = connectorStart + connector.length;
    const claim = (at: number, role: DocumentDateRole, distance: number) => {
      if (assignments[at].distance <= distance) return;
      assignments[at] = { role, trigger: connector, distance };
    };
    claim(i, "start", connectorStart - gapStart);
    claim(i + 1, termEndRole(block), right.index - connectorEnd);
  }
}

/**
 * Two corrections a trigger table cannot make, because both depend on the
 * block around the trigger rather than on the trigger's own words:
 *
 * - "Valid to 31 March 2027" on a licence is a date the household renews;
 *   the same words under a guarantee are a date that simply runs out.
 * - "Scheme registration valid to 30 April 2027" is the contractor's
 *   registration, not the household's anything, so it gets no role.
 */
function applyTermEnds(
  text: string,
  spans: readonly DateSpan[],
  assignments: ContextRoleAssignment[],
): void {
  spans.forEach((span, at) => {
    const assignment = assignments[at];
    if (assignment.role === "other") return;
    const { block } = blockTextAround(text, span.index);
    if (ORGANISATION_PERIOD.test(block)) {
      assignments[at] = { role: "other", trigger: "", distance: Number.POSITIVE_INFINITY };
      return;
    }
    if (assignment.role !== "expiry") return;
    if (!TERM_END_TRIGGER.test(assignment.trigger.trim())) return;
    assignments[at] = { ...assignment, role: termEndRole(block) };
  });
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
  // Where each kind's candidates start, so a label-only block knows which
  // block below or above it holds the value it names.
  const startsOf = (kind: CandidateKind) =>
    candidates.filter((candidate) => candidate.kind === kind).map((candidate) => candidate.index);
  const scopesByKind: Record<Exclude<CandidateKind, "date">, TriggerScope[]> = {
    amount: buildScopes(text, AMOUNT_TRIGGERS, startsOf("amount")),
    identifier: buildScopes(text, IDENTIFIER_TRIGGERS, startsOf("identifier")),
    organisation: buildScopes(text, ORGANISATION_TRIGGERS, startsOf("organisation")),
    heading: buildScopes(text, HEADING_TRIGGERS, startsOf("heading")),
  };

  // One ConText pass over all the dates at once, then consumed in order --
  // the date candidates keep their relative order, so a running cursor lines
  // each assignment up with the candidate it came from.
  const dateSpans = candidates
    .filter((candidate) => candidate.kind === "date")
    .map((candidate) => ({
      value: candidate.value,
      index: candidate.index,
      length: printedLength(text, candidate),
    }));
  const dateAssignments = assignContextRoleLabels(text, dateSpans);
  applyDateRanges(text, dateSpans, dateAssignments);
  applyTermEnds(text, dateSpans, dateAssignments);
  let nextDate = 0;

  const headingIndexes = candidates.filter((c) => c.kind === "heading").map((c) => c.index);
  const firstHeadingIndex = headingIndexes.length === 0 ? -1 : Math.min(...headingIndexes);

  // Labels first, across the whole shortlist, so that a trigger claiming
  // several candidates can be cut back to the one it names.
  const labels = candidates.map((candidate) => {
    if (candidate.kind === "date") return null;
    const start = candidate.index;
    return labelTag(start, start + printedLength(text, candidate), scopesByKind[candidate.kind]);
  });
  keepOneValuePerLabel(labels);

  return candidates.map((candidate, at): TaggedCandidate => {
    const tags: Tag[] = [];

    if (candidate.kind === "date") {
      const assignment = dateAssignments[nextDate];
      nextDate += 1;
      tags.push({ value: assignment.role, trigger: assignment.trigger, source: "label" });
    } else {
      const label = labels[at];
      if (label) tags.push(label.tag);
    }

    tags.push(...shapeTags(candidate, firstHeadingIndex));
    if (tags.length === 0) tags.push({ value: "other", trigger: "", source: "label" });

    return { ...candidate, tags };
  });
};
