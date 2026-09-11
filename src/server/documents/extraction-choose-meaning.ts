// Stage 3 of ADR-0026 for the two meaning-shaped fields: `provider` and
// `subtype`. Every other field stage 3 decides is a rule over a tag
// (`extraction-choose.ts`); these two go to the model, over the shortlist
// stage 1 found and stage 2 labelled.
//
// The model is the chooser. Rules run first for `provider`, and only where
// they state a fact about the language on the page rather than about where
// something sits on it:
//
//   "X is a trading name of Y"   X is who the household deals with; Y, the
//                                parent, is never the provider.
//   "administered by Y",         Y runs or sold the plan, so Y is who the
//   "arranged by Y", "sold by    household deals with. For insurance that
//   Y", "your broker is Y"       is always the seller: the underwriter
//                                behind it will not deal with them.
//   "provided by Y", "your
//    supplier is Y", "trading
//    as Y"                       the page says so outright.
//   "on behalf of Y"             Y is the principal, whoever signed.
//   "authorised and regulated
//    by Z", "underwritten by Z",
//    "installed by Z"            Z is named for a reason that is not being
//                                the provider, ever.
//
// Nothing here reads where a block sits on the page, how it is capitalised,
// or what a document title usually looks like. The 24 tuning documents are
// samples of what a page could be, not a definition of one (owner,
// 2026-09-11), so a rule that would not hold on a page nobody has seen does
// not belong in this file. Where the page states none of the facts above,
// the field goes to the model with the shortlist and its blocks -- a few
// hundred characters, never the page (ADR-0026 stage 3) -- and the answer
// is taken only if the shortlist carries it.

import { classifyProvider } from "./extraction-scoring";
import type { TaggedCandidate } from "./extraction-stages";
import { trimFieldValue } from "./value-trim";

// ------------------------------------------------------------------ shared

/** Case and whitespace runs ignored -- the comparison the scorer makes. */
function comparable(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

function words(value: string): string[] {
  return value.trim().split(/\s+/u).filter((word) => word.length > 0);
}

// ---------------------------------------------------------------- provider

/**
 * The tags that say who the household deals with, best evidence first.
 *
 * - `provider`: the page said so outright, which includes the brand in
 *   front of "is a trading name of".
 * - `administrator`: the body that runs or sold the plan is the one the
 *   household writes to and pays, which is what this field means.
 * - `on-behalf-of`: the principal a signature was given for, heard last
 *   because it also fits an insurer ("underwritten by A on behalf of B"),
 *   which is never who the household deals with.
 *
 * `underwriter`, `regulator`, `installer` and `subsidiary` are absent
 * deliberately: each names a body a page is obliged to mention, none of
 * which the household holds an account with.
 */
const PRINCIPAL_TAGS = ["provider", "administrator", "on-behalf-of"];

/**
 * Which `administrator` trigger is evidence of a provider: the words for
 * running or selling the household's own plan. "Managed by" is not among
 * them -- it says who runs an investment fund inside the plan, which the
 * household has no dealings with.
 */
const SELLS_OR_ADMINISTERS = /administer|arrang|sold by|intermediary|broker/iu;

/**
 * Tags that say why an organisation is on the page, and it is never
 * because the household deals with it -- including `subsidiary`, the
 * parent behind a trading name. A candidate the page labels only these
 * ways is dropped before the model sees the shortlist.
 */
const NEVER_THE_PROVIDER = ["regulator", "underwriter", "installer", "subsidiary"];

const LEGAL_SUFFIXES = ["ltd", "ltd.", "limited", "plc", "plc.", "llp", "cic", "llc", "inc", "inc."];

function endsWithLegalSuffix(value: string): boolean {
  const last = words(value).at(-1);
  return last !== undefined && LEGAL_SUFFIXES.includes(last.toLowerCase());
}

/** The scorer's comparison, with the legal suffix optional on both sides,
 * so "Millbrook Energy" and "Millbrook Energy Ltd" are one name here too. */
function sameOrganisation(left: string, right: string): boolean {
  return classifyProvider(left, right) === "correct";
}

/** Words a page puts in front of a person, never an organisation. */
const PERSON_TITLE = /\b(?:mr|mrs|ms|miss|mx|dr|sir|prof|rev)\b\.?/iu;
/** An initial and a surname -- "A. J. Brindlecombe", "J. Ashworth". */
const PERSON_INITIALS = /\b[A-Z]\.\s*(?:[A-Z]\.\s*)?[A-Z][a-z]/u;
/** A word no name ends on: the phrase carries on somewhere this candidate
 * does not. */
const UNFINISHED = /^(?:and|&|of|the|for|to|with|by|a|an)$/iu;
/**
 * A word that is one letter. Tika reads letter-spaced print as words --
 * "UN DE RWR ITIN G" for a heading set wide -- and whatever those letters
 * spell, they are not a name anyone could ring. `&` is a word of its own in
 * real names, so only letters count.
 */
const LETTER_BY_LETTER = /(?:^|\s)[A-Za-z](?=\s|$)/u;

/**
 * A candidate that cannot be a provider whatever the page says about it: a
 * person rather than an organisation, a single word, or a phrase that has
 * plainly not finished.
 */
function unusableName(value: string): boolean {
  const parts = words(value);
  if (parts.length < 2) return true;
  if (PERSON_TITLE.test(value) || PERSON_INITIALS.test(value)) return true;
  if (LETTER_BY_LETTER.test(value)) return true;
  return UNFINISHED.test(parts[parts.length - 1]);
}

/** The sieve's organisation patterns start at a connective when the name
 * follows one in prose: "on behalf of Fenwick & Vale Gas Services Ltd"
 * yields "of Fenwick & Vale Gas Services Ltd". */
const LEADING_CONNECTIVE = /^(?:of|by|for|with|to|and)\s+/iu;

/**
 * The name a candidate carries: the words that labelled it removed, the
 * connective the sieve started at removed, and the result checked against
 * the block it came from (`trimFieldValue`).
 *
 * A company's name ends at its legal suffix, so where a candidate stops
 * short of one the very next words supply -- "on behalf of Thornleigh
 * Electrical" written in front of "Contractors Ltd" -- the phrase is read
 * on to the suffix. No further: with no suffix within three words the
 * candidate stands as it was.
 */
function nameOf(candidate: TaggedCandidate, trigger: string): string | undefined {
  let value = candidate.value.trim();
  if (trigger) {
    const at = comparable(value).indexOf(comparable(trigger));
    if (at !== -1) value = value.slice(at + trigger.length).trim();
  }
  value = value.replace(LEADING_CONNECTIVE, "").trim();
  if (!value) return undefined;

  if (!endsWithLegalSuffix(value)) {
    const at = comparable(candidate.line).indexOf(comparable(value));
    if (at !== -1) {
      const after = words(candidate.line.slice(at + value.length));
      const extension: string[] = [];
      for (const word of after.slice(0, 3)) {
        // "and" and "&" join the halves of a real name -- "Fenwick & Vale
        // Gas Services Ltd", "Highways and Vehicle Licensing Authority" --
        // so they continue the phrase; a lower-case word of any other kind
        // ends it.
        if (!/^(?:[A-Z][A-Za-z'’&.-]*|&|and)$/u.test(word)) break;
        extension.push(word);
        if (endsWithLegalSuffix(word)) {
          value = `${value} ${extension.join(" ")}`;
          break;
        }
      }
    }
  }

  const trimmed = trimFieldValue("provider", value, candidate.line);
  return unusableName(trimmed) ? undefined : trimmed;
}

/** Whether this tag, with these trigger words, is the page stating who the
 * household deals with. */
function statesTheProvider(tagValue: string, trigger: string): boolean {
  if (!PRINCIPAL_TAGS.includes(tagValue)) return false;
  return tagValue === "administrator" ? SELLS_OR_ADMINISTERS.test(trigger) : true;
}

/**
 * The organisation the household's plan is with, where the page states it,
 * and nothing where it does not.
 *
 * Every statement of one kind is heard together: two of them naming
 * different organisations is the page being ambiguous, and stage 3's answer
 * to ambiguity is silence. A wrong provider costs a point where a blank
 * costs nothing, and the blank is what the model is then asked about.
 */
export function chooseProviderByRules(candidates: readonly TaggedCandidate[]): string | undefined {
  for (const wanted of PRINCIPAL_TAGS) {
    const named: string[] = [];
    for (const candidate of candidates) {
      if (candidate.kind !== "organisation") continue;
      for (const tag of candidate.tags) {
        if (tag.value !== wanted || !statesTheProvider(tag.value, tag.trigger)) continue;
        const name = nameOf(candidate, tag.trigger);
        if (name) named.push(name);
      }
    }
    if (named.length === 0) continue;
    return named.every((name) => sameOrganisation(named[0], name)) ? named[0] : undefined;
  }
  return undefined;
}

// ------------------------------------------------------------------- model

/**
 * How the model is reached: a function rather than a URL, so a test can
 * answer without a container and the endpoint stays in one place. Takes the
 * rendered prompt, returns the model's raw reply.
 */
export type MeaningTransport = (prompt: string) => Promise<string>;

const MODEL = "hf.co/numind/NuExtract3-GGUF:Q4_K_M";
const ENDPOINT = "http://orbit-ollama:11434/api/generate";
/** A shortlist is a few hundred characters, not a document: a call needing
 * longer than this has not understood the question. */
const DEADLINE_MS = 60_000;

/**
 * NuExtract 3's own structured-mode prompt, rendered here because Ollama's
 * template cannot reach the template variable (the same reason
 * `tmp/nuextract-score.ts` renders it). Tag for tag the model's native
 * format, posted with `raw: true`.
 */
export function structuredPrompt(template: Record<string, string>, document: string): string {
  return "<|im_start|>user\n" +
    "【task】structured\n" +
    `【template_start】${JSON.stringify(template)}【template_end】\n` +
    "【document_start】\n" +
    `${document}\n` +
    "【document_end】<|im_end|>\n" +
    "<|im_start|>assistant\n<think>\n\n</think>\n\n";
}

/** The fixed endpoint of ADR-0025, deterministic (`temperature 0`, a fixed
 * seed) so two runs over one shortlist give one answer. */
export const ollamaMeaningTransport: MeaningTransport = async (prompt) => {
  const response = await fetch(ENDPOINT, {
    signal: AbortSignal.timeout(DEADLINE_MS),
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      raw: true,
      stream: false,
      options: { temperature: 0, seed: 20260910, num_ctx: 8192 },
    }),
  });
  const body = await response.json() as { response?: string; error?: string };
  if (body.error) return "";
  return body.response ?? "";
};

/**
 * The organisations worth asking about: the shortlist narrowed by what the
 * page says and what the value looks like, never by where it sits.
 *
 * Out go the bodies a page names for a reason other than being the
 * provider -- the regulator, the underwriter, the installer -- and the
 * candidates that are not an organisation's name at all: a person, a
 * single word, a phrase the sieve cut mid-flow. What is left is a handful
 * of real names, which is the choice the model is asked to make.
 */
function providerShortlist(candidates: readonly TaggedCandidate[]): Array<{
  name: string;
  candidate: TaggedCandidate;
}> {
  const shortlist: Array<{ name: string; candidate: TaggedCandidate }> = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.kind !== "organisation") continue;
    if (candidate.tags.every((tag) => NEVER_THE_PROVIDER.includes(tag.value))) continue;
    const name = nameOf(candidate, "");
    if (!name || seen.has(comparable(name))) continue;
    seen.add(comparable(name));
    shortlist.push({ name, candidate });
  }
  return shortlist;
}

/** At most this much excerpt: the shortlist and its blocks, never the page
 * (ADR-0026 stage 3). */
const EXCERPT_LIMIT = 1_500;
/** Enough of a block to show what labelled a candidate, no more. */
const BLOCK_LIMIT = 140;

function excerptLines(heading: string, lines: readonly string[]): string {
  let excerpt = heading;
  for (const line of lines) {
    if (excerpt.length + line.length + 1 > EXCERPT_LIMIT) break;
    excerpt += `\n${line}`;
  }
  return excerpt;
}

/** The organisations of the shortlist, each with what the page called it
 * and the block it was found in, deduplicated. */
export function providerExcerpt(candidates: readonly TaggedCandidate[]): string {
  const lines: string[] = [];
  for (const { name, candidate } of providerShortlist(candidates)) {
    const labels = candidate.tags
      .map((tag) => tag.trigger.trim())
      .filter((trigger) => trigger.length > 0 && trigger.length < 40);
    const label = labels.length > 0 ? ` (the page says: ${labels.join("; ")})` : "";
    lines.push(`${name}${label}: "${candidate.line.slice(0, BLOCK_LIMIT)}"`);
  }
  return excerptLines("Organisations named on this page:", lines);
}

/** The headings of the shortlist, the one stage 2 called the title first. */
export function subtypeExcerpt(candidates: readonly TaggedCandidate[]): string {
  const headings = candidates.filter((candidate) => candidate.kind === "heading");
  const titleFirst = [
    ...headings.filter((candidate) => candidate.tags.some((tag) => tag.value === "title")),
    ...headings.filter((candidate) => !candidate.tags.some((tag) => tag.value === "title")),
  ];
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const candidate of titleFirst) {
    const value = candidate.value.trim();
    if (!value || seen.has(comparable(value))) continue;
    seen.add(comparable(value));
    lines.push(value.slice(0, BLOCK_LIMIT));
  }
  return excerptLines("Headings printed on this page:", lines);
}

/** The model may answer with a bare string, a JSON object matching the
 * template, or a one-element array of either. */
function answerFrom(raw: string, field: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const pick = (value: unknown): string | undefined => {
    if (typeof value === "string") return value.trim() || undefined;
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = pick(entry);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (value && typeof value === "object" && field in value) {
      return pick((value as Record<string, unknown>)[field]);
    }
    return undefined;
  };
  return pick(parsed);
}

/**
 * The model's answer, only if the shortlist carries it.
 *
 * A provider must BE one of the organisations the sieve found, compared the
 * way the scorer compares providers; a title must be printed inside one of
 * the heading blocks. Anything else -- a name assembled out of the page, a
 * title rewritten into better English -- is refused and the field stays
 * blank (ADR-0025 section 3).
 */
function groundedProvider(answer: string, candidates: readonly TaggedCandidate[]): string | undefined {
  for (const { name, candidate } of providerShortlist(candidates)) {
    if (sameOrganisation(name, answer)) return trimFieldValue("provider", answer.trim(), candidate.line);
  }
  return undefined;
}

function groundedSubtype(answer: string, candidates: readonly TaggedCandidate[]): string | undefined {
  const wanted = comparable(answer);
  if (!wanted) return undefined;
  for (const candidate of candidates) {
    if (candidate.kind !== "heading" || !comparable(candidate.value).includes(wanted)) continue;
    // `value-trim` (#965) as it stands: the general clean-up of a picked
    // value -- the label in front of it, the aside behind it -- applied to
    // whatever the model chose. Nothing here is written for a title.
    return trimFieldValue("subtype", answer.trim(), candidate.line);
  }
  return undefined;
}

export interface MeaningFields {
  provider?: string;
  subtype?: string;
}

/**
 * Asks the model about the meaning-shaped fields nothing has answered yet,
 * and about nothing else. A provider the page stated outright is not
 * re-asked: a printed label beside a name is better evidence than a model's
 * reading of the same excerpt.
 */
export async function chooseMeaningFieldsWithModel(
  candidates: readonly TaggedCandidate[],
  chosen: MeaningFields,
  transport: MeaningTransport,
): Promise<MeaningFields> {
  const filled: MeaningFields = {};

  if (chosen.provider === undefined) {
    const excerpt = providerExcerpt(candidates);
    const raw = await transport(structuredPrompt({ provider: "" }, excerpt));
    const answer = answerFrom(raw, "provider");
    const grounded = answer === undefined ? undefined : groundedProvider(answer, candidates);
    if (grounded !== undefined) filled.provider = grounded;
  }

  if (chosen.subtype === undefined) {
    const excerpt = subtypeExcerpt(candidates);
    const raw = await transport(structuredPrompt({ document_title: "" }, excerpt));
    const answer = answerFrom(raw, "document_title");
    const grounded = answer === undefined ? undefined : groundedSubtype(answer, candidates);
    if (grounded !== undefined) filled.subtype = grounded;
  }

  return filled;
}
