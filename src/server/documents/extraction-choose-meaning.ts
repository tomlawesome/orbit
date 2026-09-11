// Stage 3 of ADR-0026 with the model available: the model chooses EVERY
// field, from a shortlist the sieves shrank and ranked (owner, 2026-09-11 --
// "everything is supposed to go to the model for final choice"). The rules
// in this file and in `extraction-choose.ts` rank the shortlist and answer
// only where there is no model to ask.
//
// The shortlist is what the sieves kept. Several independent sieves read
// each organisation first (`extraction-provider-sieves.ts`); every name at
// least one of them spoke for is then binned by word run
// (`extraction-provider-runs.ts`), and how often a run is printed across
// those names is the order the model sees it in. The language facts among
// those sieves are these, and they state a fact about the words on the page
// rather than about where something sits on it:
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
// Subtype has no rules at all. It answers "what type of thing is this" --
// insurance, a plan, a membership -- from the generic taxonomy in
// `subtype-taxonomy.json` (owner, 2026-09-11). Its shortlist is the handful
// of taxonomy phrases the page's own words support, so the model chooses
// between eight phrases rather than between 51 kinds and 63 qualifiers.
//
// Nothing here reads where a block sits on the page, how it is capitalised,
// or what a document title usually looks like. The 24 tuning documents are
// samples of what a page could be, not a definition of one (owner,
// 2026-09-11), so a rule that would not hold on a page nobody has seen does
// not belong in this file. Every field goes to the model with its shortlist
// and the blocks -- a few hundred characters, never the page (ADR-0026
// stage 3) -- `none` is always an allowed answer, and an answer the
// shortlist does not carry leaves the field blank.

import {
  providerTaggedOrganisations,
  providerWordRuns,
} from "./extraction-provider-runs";
import { LANGUAGE_FACT } from "./extraction-provider-sieves";
import { classifyProvider } from "./extraction-scoring";
import {
  bestSupported,
  comparable,
  entryChosen,
  replyLines,
  shortlistExcerpt,
  SHORTLIST_LIMIT,
  type EntryMatch,
  type ShortlistEntry,
} from "./extraction-shortlist";
import type { TaggedCandidate } from "./extraction-stages";
import { locateDates, type DocumentDateRole } from "./suggestions";
import subtypeTaxonomyJson from "./subtype-taxonomy.json";
import { trimFieldValue } from "./value-trim";

// ------------------------------------------------------------------ shared

function words(value: string): string[] {
  return value.trim().split(/\s+/u).filter((word) => word.length > 0);
}

// ---------------------------------------------------------------- provider

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
 * A phrase that names a document rather than an organisation: "Annual
 * Multi-Trip Travel Insurance Certificate", "Mobile Plan Summary",
 * "Vaccination & Health Record". Tika hands the sieve every capitalised
 * line, and a document's own title is the line it hands over most.
 *
 * The words are the taxonomy's own kinds (`subtype-taxonomy.json`), which
 * is the project's list of what a household document can be. A company may
 * be named after what it sells -- "Bellward Warranty Administration Ltd" --
 * so a name carrying its legal form is left alone: that form is what says
 * the phrase is a company and not a title.
 */
const DOCUMENT_KINDS = new RegExp(
  `\\b(?:${(subtypeTaxonomyJson as SubtypeTaxonomy).kinds
    .map((group) => group.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|")})\\b`,
  "iu",
);

function namesADocument(value: string): boolean {
  return !endsWithLegalSuffix(value) && DOCUMENT_KINDS.test(value);
}

/**
 * A candidate that cannot be a provider whatever the page says about it: a
 * person rather than an organisation, a single word, a phrase that has
 * plainly not finished, or the document's own title.
 */
function unusableName(value: string): boolean {
  const parts = words(value);
  if (parts.length < 2) return true;
  if (PERSON_TITLE.test(value) || PERSON_INITIALS.test(value)) return true;
  if (LETTER_BY_LETTER.test(value)) return true;
  if (namesADocument(value)) return true;
  return UNFINISHED.test(parts[parts.length - 1]);
}

/** The sieve's organisation patterns start at a connective when the name
 * follows one in prose: "on behalf of Fenwick & Vale Gas Services Ltd"
 * yields "of Fenwick & Vale Gas Services Ltd". The article goes the same
 * way: a household writes to "Milldown Motoring Club", never to "the
 * Milldown Motoring Club". */
const LEADING_CONNECTIVE = /^(?:of|by|for|with|to|and|the)\s+/iu;

/** A company's name ends at its legal form, so anything printed after it is
 * the next thing on the line -- "Fenwick & Vale Gas Services Ltd BUSINESS
 * REGISTRATION", "Bellward Warranty Administration Ltd of Norwich". */
const THROUGH_LEGAL_SUFFIX = /^(.*?\b(?:ltd|limited|plc|llp|cic|llc|inc)\b\.?)\s+\S/iu;

function cutAtLegalSuffix(value: string): string {
  const match = THROUGH_LEGAL_SUFFIX.exec(value);
  return match ? match[1] : value;
}

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
  value = cutAtLegalSuffix(value.replace(LEADING_CONNECTIVE, "").trim());
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

/**
 * The organisation the household's plan is with, where there is no model to
 * ask, and nothing where the page is not plain about it.
 *
 * The bins rank; this is the only thing the rules do with them. The top run
 * is answered only where the page printed it more often than anything else
 * it printed -- where two runs are level the page is naming two things as
 * loudly as each other, and stage 3's answer to that is silence (owner,
 * 2026-09-11). A wrong provider costs a point where a blank costs nothing.
 */
export function chooseProviderByRules(candidates: readonly TaggedCandidate[]): string | undefined {
  const runs = providerWordRuns(providerTaggedOrganisations(candidates));
  const [top, next] = runs;
  if (top === undefined) return undefined;
  if (next !== undefined && next.count >= top.count) return undefined;
  return top.display;
}

// ------------------------------------------------------------------- model

/**
 * How a model is reached: a function rather than a URL, so a test can answer
 * without a container, and so stage 3 is not tied to one model (owner,
 * 2026-09-11: "let *a* model choose the most likely -- that does NOT have to
 * be the NuExtract one"). Takes the plain-English question, returns the
 * model's raw reply, which `replyLines` reads whatever shape it is in.
 */
export type MeaningTransport = (question: string) => Promise<string>;

/**
 * The model both transports use unless a setting names another. It is the
 * only model pulled on `orbit-ollama` today, so swapping the chooser is a
 * setting and a `docker exec ollama pull`, never a code change.
 */
const DEFAULT_MODEL = "hf.co/numind/NuExtract3-GGUF:Q4_K_M";
const GENERATE_ENDPOINT = "http://orbit-ollama:11434/api/generate";
const CHAT_ENDPOINT = "http://orbit-ollama:11434/api/chat";
/** A shortlist is a few hundred characters, not a document, but a CPU-only
 * host under load takes its time; the unattended budget is five minutes a
 * document over five or six calls. A call past this answers nothing. */
const DEADLINE_MS = 120_000;
/** Deterministic, as ADR-0025 requires: two runs over one shortlist give one
 * answer. */
const MODEL_OPTIONS = { temperature: 0, seed: 20260910, num_ctx: 8192 };

/** Which model the chooser asks. `EXTRACTION_CHOOSER_MODEL` names another
 * one without touching this file. */
export function chooserModel(): string {
  const named = process.env.EXTRACTION_CHOOSER_MODEL?.trim();
  return named ? named : DEFAULT_MODEL;
}

/**
 * NuExtract 3's own structured-mode prompt, rendered here because Ollama's
 * template cannot reach the template variable. Tag for tag the model's
 * native format, posted with `raw: true`. The question goes in as the
 * document and the answer comes back as one field, so the same
 * plain-English question serves both transports.
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

/** NuExtract 3 in its native structured mode, on the fixed endpoint of
 * ADR-0025. */
export const nuextractTransport: MeaningTransport = (question) => answering(async () => {
  const response = await fetch(GENERATE_ENDPOINT, {
    signal: AbortSignal.timeout(DEADLINE_MS),
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: chooserModel(),
      prompt: structuredPrompt({ answer: "" }, question),
      raw: true,
      stream: false,
      options: MODEL_OPTIONS,
    }),
  });
  const body = await response.json() as { response?: string; error?: string };
  if (body.error) return "";
  return body.response ?? "";
}, "");

/** A call that fails, times out or is refused answers nothing: blank is an
 * allowed answer for every field, and one slow question must not take the
 * rest of the document with it. */
async function answering(call: () => Promise<string>, fallback: string): Promise<string> {
  try {
    return await call();
  } catch {
    return fallback;
  }
}

/** The shape any chat model is held to: one string per line of its answer,
 * so a model that would rather explain itself cannot -- Ollama's grammar
 * only lets the strings through. `replyLines` reads each as a line. */
const CHAT_ANSWER_SHAPE = {
  type: "object",
  properties: { answer: { type: "array", items: { type: "string" }, minItems: 1 } },
  required: ["answer"],
};

/** Any chat model Ollama is serving, asked the same plain-English question.
 * Nothing in the question is NuExtract-shaped; the answer is pinned to
 * `CHAT_ANSWER_SHAPE`, and thinking aloud is switched off where the model
 * offers it, so what comes back is the number or word and nothing else. */
export const ollamaChatTransport: MeaningTransport = (question) => answering(async () => {
  const response = await fetch(CHAT_ENDPOINT, {
    signal: AbortSignal.timeout(DEADLINE_MS),
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: chooserModel(),
      messages: [
        {
          role: "system",
          content: 'Reply as JSON: {"answer": [...]}, one string per line of your answer, for example {"answer": ["2"]} or {"answer": ["none"]}. No explanation.',
        },
        { role: "user", content: question },
      ],
      think: false,
      format: CHAT_ANSWER_SHAPE,
      stream: false,
      options: MODEL_OPTIONS,
    }),
  });
  const body = await response.json() as { message?: { content?: string }; error?: string };
  if (body.error) return "";
  return body.message?.content ?? "";
}, "");

/**
 * The transport the evaluations use: NuExtract's native mode, unless
 * `EXTRACTION_CHOOSER_MODEL` names another model, in which case the generic
 * chat call carries it. Swapping the chooser is that setting and nothing
 * else.
 */
export function chooserTransport(): MeaningTransport {
  return process.env.EXTRACTION_CHOOSER_MODEL?.trim() ? ollamaChatTransport : nuextractTransport;
}

/**
 * Every printing of every organisation the page could mean -- one entry per
 * place it was found.
 *
 * Out go the bodies a page names for a reason other than being the
 * provider: the regulator, the underwriter, the installer, the parent
 * behind a trading name. One stated reason for being on the page that is
 * not being the provider is enough to drop a name -- the underwriter behind
 * a policy is still the underwriter when three other sieves have noticed
 * how often it is printed.
 */
function organisationsWorthAsking(candidates: readonly TaggedCandidate[]): TaggedCandidate[] {
  return candidates.filter((candidate) =>
    candidate.kind === "organisation" &&
    !candidate.tags.some((tag) => NEVER_THE_PROVIDER.includes(tag.value)));
}

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
function providerNames(candidates: readonly TaggedCandidate[]): Array<{
  name: string;
  candidate: TaggedCandidate;
}> {
  const named: Array<{ name: string; candidate: TaggedCandidate }> = [];
  const seen = new Set<string>();
  for (const candidate of organisationsWorthAsking(candidates)) {
    const name = nameOf(candidate, "");
    if (!name || seen.has(comparable(name))) continue;
    seen.add(comparable(name));
    named.push({ name, candidate });
  }
  return named;
}

/**
 * The provider shortlist: the word-run bins over the organisations stage 2
 * spoke for, best first, each with its count, the form the page printed
 * most, and the blocks the mentions behind it came from
 * (`extraction-provider-runs.ts`, the owner's method of 2026-09-11).
 *
 * A run rather than a name, because the sieves cut one printed name a dozen
 * ways and no rule about legal suffixes reliably puts the cuts back
 * together. What the household's own organisation has, and a body named
 * once does not, is its words repeated across every one of those cuts.
 *
 * Ranked by count, so the entries near the top are several readings of the
 * same name -- which is the point: the model is choosing between the two or
 * three organisations the page keeps saying, in the wordings it said them.
 * The sieves and the words the page printed beside each mention ride along
 * as evidence; they no longer order anything.
 */
export function providerShortlistEntries(candidates: readonly TaggedCandidate[]): ShortlistEntry[] {
  const kept = providerTaggedOrganisations(candidates);
  return providerWordRuns(kept).slice(0, SHORTLIST_LIMIT).map((run) => ({
    value: run.display,
    display: run.display,
    line: runBlocks(run.mentions),
    why: [`printed ${run.count} times across the names on this page`, ...runEvidence(run.mentions)],
    support: run.count,
  }));
}

/** At most this many of a run's blocks, so one entry cannot fill the
 * excerpt on its own. */
const BLOCKS_PER_ENTRY = 3;

/** The blocks a run's mentions were printed in, each once. */
function runBlocks(mentions: readonly TaggedCandidate[]): string {
  const blocks: string[] = [];
  for (const mention of mentions) {
    const line = mention.line.trim();
    if (line && !blocks.includes(line)) blocks.push(line);
    if (blocks.length === BLOCKS_PER_ENTRY) break;
  }
  return blocks.join(" | ");
}

/** What stage 2 said about the mentions a run came from: the sieves that
 * kept them, and the words the page printed beside them. Evidence for the
 * model, not a ranking (ADR-0026, amended 2026-09-11). */
function runEvidence(mentions: readonly TaggedCandidate[]): string[] {
  const sieves = new Set<string>();
  const labels = new Set<string>();
  for (const mention of mentions) {
    for (const tag of mention.tags) {
      for (const sieve of tag.sieves ?? [LANGUAGE_FACT]) sieves.add(sieve);
      const trigger = tag.trigger.trim();
      if (trigger.length > 0 && trigger.length < 40) labels.add(trigger);
    }
  }
  return [
    ...(sieves.size > 0 ? [`sieves: ${[...sieves].join(", ")}`] : []),
    ...(labels.size > 0 ? [`the page says: ${[...labels].join("; ")}`] : []),
  ];
}

/** The page's own words, as the subtype question may read them: what the
 * document calls itself, who it is from, and what its labelled figures are
 * for. Never the page -- only the blocks stage 1 kept. */
function subtypeEvidence(candidates: readonly TaggedCandidate[]): Array<{ text: string; line: string }> {
  const evidence: Array<{ text: string; line: string }> = [];
  const headings = candidates.filter((candidate) => candidate.kind === "heading");
  const titleFirst = [
    ...headings.filter((candidate) => candidate.tags.some((tag) => tag.value === "title")),
    ...headings.filter((candidate) => !candidate.tags.some((tag) => tag.value === "title")),
  ];
  for (const heading of titleFirst) evidence.push({ text: heading.value, line: heading.line });
  for (const { name, candidate } of providerNames(candidates)) {
    evidence.push({ text: name, line: candidate.line });
  }
  for (const candidate of candidates) {
    if (candidate.kind !== "amount") continue;
    for (const tag of candidate.tags) {
      const trigger = tag.trigger.trim();
      if (trigger) evidence.push({ text: trigger, line: candidate.line });
    }
  }
  return evidence;
}

/** How many of each taxonomy group survive into the combinations, so a page
 * mentioning four trades does not produce sixty-three phrases. */
const TOP_TAXONOMY_GROUPS = 4;
/** Places kept for a bare kind, so "Insurance" is still on the list when
 * the page also says "home" often enough to fill it with combinations. */
const BARE_KIND_SLOTS = 3;

interface TaxonomyHit {
  group: TaxonomyGroup;
  /** How many of the page's own phrases carried one of the group's words. */
  hits: number;
  /** The first block one was found in. */
  line: string;
  /** The word the page actually printed. */
  printed: string;
}

/** Which taxonomy groups the page's own words support, most-supported
 * first. A word counts once per phrase it appears in, so a heading naming
 * the trade twice is one reason and not two. */
function taxonomyHits(
  groups: readonly TaxonomyGroup[],
  evidence: ReadonlyArray<{ text: string; line: string }>,
): TaxonomyHit[] {
  const found: TaxonomyHit[] = [];
  for (const group of groups) {
    let hits = 0;
    let line = "";
    let printed = "";
    for (const phrase of evidence) {
      const synonym = group.synonyms.find((word) =>
        new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "iu").test(phrase.text));
      if (synonym === undefined) continue;
      hits += 1;
      if (!line) {
        line = phrase.line;
        printed = synonym;
      }
    }
    if (hits > 0) found.push({ group, hits, line, printed });
  }
  return found.sort((left, right) => right.hits - left.hits);
}

/**
 * The subtype shortlist: the taxonomy phrases the page's own words support,
 * best-supported first.
 *
 * The taxonomy has 51 kinds and 63 qualifiers, and asking a model to choose
 * between 3,000 phrases is asking it to write one. So the page's own words
 * -- the headings, the names, what the figures are labelled -- pick a
 * handful of groups, the taxonomy's combination rules compose them, and the
 * model chooses between those or answers none.
 */
export function subtypeShortlistEntries(candidates: readonly TaggedCandidate[]): ShortlistEntry[] {
  const evidence = subtypeEvidence(candidates);
  const kinds = taxonomyHits(TAXONOMY.kinds, evidence).slice(0, TOP_TAXONOMY_GROUPS);
  const qualifiers = taxonomyHits(TAXONOMY.qualifiers, evidence).slice(0, TOP_TAXONOMY_GROUPS);

  const entry = (value: string, hit: TaxonomyHit, support: number, why: string[]): ShortlistEntry => ({
    value,
    display: value,
    line: hit.line,
    why,
    support,
  });

  const bare = kinds.map((kind) =>
    entry(kind.group.name, kind, kind.hits, [`the page prints "${kind.printed}"`]));
  const composed: ShortlistEntry[] = [];
  for (const qualifier of qualifiers) {
    for (const kind of kinds) {
      composed.push(entry(
        `${qualifier.group.name} ${kind.group.name}`,
        kind,
        kind.hits + qualifier.hits,
        [`the page prints "${qualifier.printed}" and "${kind.printed}"`],
      ));
    }
    if (!TAXONOMY.combinations.standalone.includes(qualifier.group.name)) continue;
    composed.push(entry(
      qualifier.group.name,
      qualifier,
      qualifier.hits,
      [`the page prints "${qualifier.printed}"`],
    ));
  }

  const reserved = bestSupported(bare, BARE_KIND_SLOTS);
  return bestSupported([...reserved, ...bestSupported(composed, SHORTLIST_LIMIT - reserved.length)]);
}

// ------------------------------------------------------- subtype taxonomy

interface TaxonomyGroup {
  name: string;
  synonyms: string[];
}

interface SubtypeTaxonomy {
  kinds: TaxonomyGroup[];
  qualifiers: TaxonomyGroup[];
  combinations: { patterns: string[]; standalone: string[] };
}

const TAXONOMY = subtypeTaxonomyJson as SubtypeTaxonomy;

// --------------------------------------------------- asking a model to pick

/**
 * What one question says: the field's own name for what is being chosen,
 * and the heading over the list.
 */
interface ShortlistQuestion {
  /** The one thing being chosen, in the household's words. */
  asks: string;
  /** What the list is, printed above it. */
  heading: string;
}

/** Every question ends the same way, because every field may answer none
 * (ADR-0026, amended 2026-09-11). */
const HOW_TO_ANSWER =
  "Answer with the number of one entry from the list, and nothing else. Answer none if none of them is it.";

/**
 * One field's question, put to the model over its shortlist.
 *
 * Plain English and a numbered list, so any model can answer and any
 * transport can carry it: the reply is read leniently (`entryChosen`) and
 * grounded against the list, so an answer that is not on it leaves the
 * field blank.
 */
export async function pickFromShortlist(
  question: ShortlistQuestion,
  entries: readonly ShortlistEntry[],
  transport: MeaningTransport,
  match: EntryMatch = {},
): Promise<ShortlistEntry | undefined> {
  if (entries.length === 0) return undefined;
  const asked = [
    question.asks,
    HOW_TO_ANSWER,
    "",
    shortlistExcerpt(question.heading, entries),
  ].join("\n");
  const raw = await transport(asked);
  for (const line of replyLines(raw)) {
    const chosen = entryChosen(line, entries, match);
    if (chosen) return chosen;
    if (comparable(line).startsWith("none")) return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------- provider

/**
 * Which of the organisations the sieves kept is the one the household deals
 * with. The pick is trimmed against the block it was printed in, as every
 * chosen value is (`value-trim`, #965).
 */
export async function chooseProviderWithModel(
  entries: readonly ShortlistEntry[],
  transport: MeaningTransport,
): Promise<string | undefined> {
  const chosen = await pickFromShortlist(
    {
      asks: "Which of these organisations does this household hold the thing with -- who they pay, " +
        "who writes to them? Not the regulator, the underwriter or the installer.",
      heading: "Organisations named on this page, with the line each was printed on:",
    },
    entries,
    transport,
    { matches: (answer, entry) => sameOrganisation(entry.value, answer) },
  );
  return chosen === undefined ? undefined : trimFieldValue("provider", chosen.value, chosen.line);
}

// ----------------------------------------------------------------- subtype

/** Which of the taxonomy phrases the page's words support is what this
 * document is about. The phrases are the taxonomy's own group names, so the
 * answer reads the same whichever page produced it. */
export async function chooseSubtypeWithModel(
  entries: readonly ShortlistEntry[],
  transport: MeaningTransport,
): Promise<string | undefined> {
  const chosen = await pickFromShortlist(
    {
      asks: "What type of thing is this document about -- an insurance policy, a service plan, " +
        "a membership? Choose the description that fits it best.",
      heading: "Descriptions the words on this page support:",
    },
    entries,
    transport,
  );
  return chosen?.value;
}

// -------------------------------------------------------------- reference

/** Which of the identifiers the page prints is the one the household would
 * quote. Compared without its spaces, because a page prints "7738 2204 91"
 * and a model repeats it "7738220491". */
export async function chooseReferenceWithModel(
  entries: readonly ShortlistEntry[],
  transport: MeaningTransport,
): Promise<string | undefined> {
  const bare = (value: string) => value.replace(/[\s-]/gu, "").toLowerCase();
  const chosen = await pickFromShortlist(
    {
      asks: "Which of these numbers is the reference this household would quote for their own " +
        "account, policy or membership? Not the company's own registration, VAT or regulator number.",
      heading: "Numbers printed on this page, with the line each was printed on:",
    },
    entries,
    transport,
    { matches: (answer, entry) => bare(answer) === bare(entry.value) },
  );
  return chosen === undefined ? undefined : trimFieldValue("reference", chosen.value, chosen.line);
}

// -------------------------------------------------------------------- cost

/** The figure inside an answer, in minor units: "£84.99", "84.99" and
 * "GBP 84.99" are one answer. */
function minorUnits(answer: string): number | undefined {
  const digits = /(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?/u.exec(answer.replace(/\s/gu, ""));
  if (!digits) return undefined;
  return Number(digits[1].replace(/,/gu, "")) * 100 + (digits[2] === undefined ? 0 : Number(digits[2]));
}

/** Which of the figures printed on the page is what the thing costs. */
export async function chooseCostWithModel(
  entries: readonly ShortlistEntry[],
  transport: MeaningTransport,
): Promise<{ costMinor: number; currency?: string } | undefined> {
  const chosen = await pickFromShortlist(
    {
      asks: "Which of these amounts is what the household pays for the thing this document is " +
        "about? Not an excess, a sum insured, a rival price or last year's figure.",
      heading: "Amounts printed on this page, with the line each was printed on:",
    },
    entries,
    transport,
    { matches: (answer, entry) => minorUnits(answer) === Number(entry.value) },
  );
  if (chosen === undefined) return undefined;
  const minor = Number(chosen.value);
  if (!Number.isFinite(minor)) return undefined;
  return { costMinor: minor, ...(chosen.currency === undefined ? {} : { currency: chosen.currency }) };
}

// -------------------------------------------------------------- recurrence

/** Which of the periods the page prints is how long this thing runs for,
 * in months. */
export async function chooseRecurrenceWithModel(
  entries: readonly ShortlistEntry[],
  transport: MeaningTransport,
): Promise<number | undefined> {
  const chosen = await pickFromShortlist(
    {
      asks: "How long does the thing this document is about run for before it comes round again? " +
        "Choose the period the page prints for the thing itself, not how often it is paid for.",
      heading: "Periods printed on this page, with the line each was printed on:",
    },
    entries,
    transport,
    { matches: (answer, entry) => /\d+/u.exec(answer)?.[0] === entry.value },
  );
  if (chosen === undefined) return undefined;
  const months = Number(chosen.value);
  return Number.isInteger(months) && months > 0 ? months : undefined;
}

// --------------------------------------------------------------- dates

/** The jobs a date can have, as the household would say them, plus the
 * answer that says none of them. `other` is left out on purpose: it is what
 * the pipeline records when nothing is known, not something to choose. */
const DATE_ROLE_CHOICES = ["renewal", "expiry", "due", "service", "start", "issued", "none"] as const;

/** The role a line names, or nothing. A word outside the vocabulary is not
 * an answer, and `none` is the model saying this date has no job. */
function roleNamed(line: string): DocumentDateRole | undefined {
  const said = comparable(line);
  const role = DATE_ROLE_CHOICES.find((choice) =>
    choice !== "none" && new RegExp(`\\b${choice}\\b`, "u").test(said));
  return role === undefined || role === "none" ? undefined : role;
}

/** Whether an answer is one of the offered dates written some other way:
 * the model may answer "31 October 2026" where the list says 2026-10-31. */
function saysTheDate(answer: string, entry: ShortlistEntry): boolean {
  if (answer.includes(entry.value)) return true;
  return locateDates(answer).some((found) => found.value === entry.value);
}

/**
 * Every date this document is about and what each is for, chosen from the
 * shortlist in one call.
 *
 * One question, not one per date: the page is one thing, and asking forty
 * times invites forty answers. The reply is a line per date -- its number
 * and its job -- and every line is grounded twice over: the date has to be
 * one of the ones offered and the job one of the words it was given.
 * Anything else is dropped, and a document the model says nothing about
 * comes back with no dates, which is an allowed answer.
 */
export async function chooseDatesWithModel(
  entries: readonly ShortlistEntry[],
  transport: MeaningTransport,
): Promise<Array<{ date: string; role: DocumentDateRole }>> {
  if (entries.length === 0) return [];
  const asked = [
    "Which of these dates does this household need to keep, and what is each one for?",
    `Answer one line per date: the date's number from the list, then what it is for, like "3 renewal".`,
    `What it is for must be one of: ${DATE_ROLE_CHOICES.join(", ")}.`,
    "Leave out every date the household does not need. Answer none if there are none.",
    "",
    shortlistExcerpt("Dates printed on this page, with the line each was printed on:", entries),
  ].join("\n");
  const raw = await transport(asked);

  const chosen: Array<{ date: string; role: DocumentDateRole }> = [];
  for (const line of replyLines(raw)) {
    const role = roleNamed(line);
    if (role === undefined) continue;
    // The role word is read off first and taken out of the way: "3 renewal"
    // and "renewal 3" both mean the third entry, and a role word carrying a
    // digit would otherwise be read as one.
    const entry = entryChosen(line.replace(new RegExp(role, "giu"), " "), entries, {
      matches: saysTheDate,
      matchesFirst: true,
    });
    if (entry === undefined) continue;
    if (chosen.some((held) => held.date === entry.value)) continue;
    chosen.push({ date: entry.value, role });
  }
  return chosen;
}
