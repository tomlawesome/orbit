// Stage 3 of ADR-0026 with the model available: the model chooses EVERY
// field, from a shortlist the sieves shrank and ranked (owner, 2026-09-11 --
// "everything is supposed to go to the model for final choice"). The rules
// in this file and in `extraction-choose.ts` rank the shortlist and answer
// only where there is no model to ask.
//
// The shortlist is what the sieves kept. Several independent sieves read
// each organisation first (`extraction-provider-sieves.ts`), and how well
// they spoke for a name is the order the model sees it in. The language
// facts among those sieves are these, and they state a fact about the words
// on the page rather than about where something sits on it:
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
  bareName,
  LANGUAGE_FACT,
  PRINCIPAL_TAGS,
  statesTheProvider,
} from "./extraction-provider-sieves";
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
import { STRENGTH_STATED, type Tag, type TaggedCandidate } from "./extraction-stages";
import { locateDates, type DocumentDateRole } from "./suggestions";
import subtypeTaxonomyJson from "./subtype-taxonomy.json";
import { trimFieldValue } from "./value-trim";

// ------------------------------------------------------------------ shared

function words(value: string): string[] {
  return value.trim().split(/\s+/u).filter((word) => word.length > 0);
}

// ---------------------------------------------------------------- provider

/**
 * How many sieves have to agree before the rules answer at all.
 *
 * One sieve is one way of looking, and the hold-out says a single way of
 * looking is wrong about as often as it is right: the rules-only provider
 * scored below blank there on nothing but the words beside the name. Two
 * sieves agreeing is two different reasons -- the page says so AND the
 * household is told to write there, or the name is in the footer of every
 * sheet AND on the web address -- and where the page gives only one reason
 * the field stays blank for the model to answer (owner, 2026-09-11).
 */
const AGREEING_SIEVES = 2;

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
 * One organisation on the page, and every sieve that spoke about it.
 *
 * Candidates are grouped by the organisation they name, not by where they
 * were found: a name printed in the masthead, in the footer and beside "administered
 * by" is one organisation with three sieves behind it, not three names with
 * one each.
 */
interface ProviderClaim {
  name: string;
  /** The sieves that read this as the organisation the household deals
   * with (`Tag.sieves` on its `provider` tag). */
  sieves: Set<string>;
  /** The sieves that read it as something else the page had to name -- the
   * registered legal entity behind a trading name, so far. */
  against: Set<string>;
  /** The best reason any of them had: 2 the page says so in words, 1 a
   * weaker reading. Two weak readings agreeing -- a name repeated twice
   * that is also printed as a heading -- is two guesses, not a fact. */
  strength: number;
  /** Whether the words beside the name said outright who the household
   * deals with. */
  stated: boolean;
  /**
   * How direct that statement was, as a rank in `PRINCIPAL_TAGS`: the page
   * naming the provider outright beats it naming who administers the plan,
   * which beats "on behalf of" -- a phrase every policy prints about its
   * insurer as well as about the firm the household rings. Nothing stated
   * at all ranks last.
   */
  principal: number;
}

/** The sieves behind a tag. A tag with no names is the words beside the
 * candidate, which is what every tag was before the sieves. */
function sievesOf(tag: { sieves?: readonly string[] }): readonly string[] {
  return tag.sieves ?? [LANGUAGE_FACT];
}

/**
 * Every organisation the page could mean, with the sieves for and against
 * it. Built from the same shortlist the model is shown, so the rules and
 * the model are choosing between the same names.
 */
export function providerClaims(candidates: readonly TaggedCandidate[]): ProviderClaim[] {
  // Read once, then counted, then grouped: how often the page printed a
  // name is what says which cut of it to answer with, and that cannot be
  // known until every candidate has been read.
  const readings: Array<{ name: string; tag: Tag; forProvider: boolean }> = [];
  for (const candidate of organisationsWorthAsking(candidates)) {
    for (const tag of candidate.tags) {
      const forProvider = tag.value === "provider" || statesTheProvider(tag.value, tag.trigger);
      const againstProvider = tag.value === "legal-entity";
      if (!forProvider && !againstProvider) continue;
      const name = nameOf(candidate, tag.trigger) ?? nameOf(candidate, "");
      if (name) readings.push({ name, tag, forProvider });
    }
  }

  // How often the page printed each name exactly this way. The sieve cuts a
  // name several ways and the page prints the real one most: "Bellward
  // Warranty Administration Ltd" in every footer against one "Notify
  // Bellward Warranty Administration Ltd" in a sentence.
  const printings = new Map<string, number>();
  for (const reading of readings) {
    printings.set(comparable(reading.name), (printings.get(comparable(reading.name)) ?? 0) + 1);
  }

  const byOrganisation = new Map<string, ProviderClaim>();
  for (const { name, tag, forProvider } of readings) {
    const key = bareName(name);
    const held = byOrganisation.get(key) ??
      {
        name,
        sieves: new Set<string>(),
        against: new Set<string>(),
        strength: 0,
        stated: false,
        principal: PRINCIPAL_TAGS.length,
      };
    held.name = betterPrinting(held.name, name, printings);
    for (const sieve of sievesOf(tag)) (forProvider ? held.sieves : held.against).add(sieve);
    if (forProvider) {
      held.strength = Math.max(held.strength, tag.strength ?? STRENGTH_STATED);
      if (sievesOf(tag).includes(LANGUAGE_FACT)) {
        held.stated = true;
        const rank = PRINCIPAL_TAGS.indexOf(tag.value);
        if (rank !== -1) held.principal = Math.min(held.principal, rank);
      }
    }
    byOrganisation.set(key, held);
  }
  return mergeFragments([...byOrganisation.values()], printings);
}

/** The name's words, as the fragment test compares them: the leading
 * article and the trailing legal form off, so one printing of a name can be
 * recognised inside another. */
function claimWords(name: string): string[] {
  return bareName(name).split(" ").filter((word) => word.length > 0);
}

/** Whether `part` is printed inside `whole` as a run of whole words:
 * "Management Ltd" inside "Purbeck & Vane Property Management Ltd". */
function isRunOf(part: readonly string[], whole: readonly string[]): boolean {
  if (part.length === 0 || part.length >= whole.length) return false;
  for (let at = 0; at + part.length <= whole.length; at += 1) {
    if (part.every((word, i) => word === whole[at + i])) return true;
  }
  return false;
}

/**
 * Which of two printings of one name to answer with.
 *
 * How often the page printed it decides: a document repeats the name it is
 * from and cuts it badly once. Where two printings are equally common the
 * fuller one wins -- "Purbeck & Vane Property Management Ltd" over the
 * "Management Ltd" the sieve's pattern started late on -- and then the one
 * carrying a legal form, and then the shorter, which is how "ClearBourne
 * Water" beats the sieve's "ClearBourne Water Water".
 */
function betterPrinting(left: string, right: string, printings: ReadonlyMap<string, number>): string {
  const score = (name: string): number[] => [
    printings.get(comparable(name)) ?? 0,
    new Set(claimWords(name)).size,
    endsWithLegalSuffix(name) ? 1 : 0,
    -name.length,
  ];
  const [leftScore, rightScore] = [score(left), score(right)];
  for (let at = 0; at < leftScore.length; at += 1) {
    if (leftScore[at] !== rightScore[at]) return leftScore[at] > rightScore[at] ? left : right;
  }
  return left;
}

/**
 * The sieve cuts one printed name several ways -- "Hedgerow Home
 * Insurance", "Services Ltd", "Hedgerow Home Insurance Services Ltd" --
 * and every cut arrives here as a rival to the others.
 *
 * A cut printed inside a fuller name that the page prints at least as often
 * is that name, and its sieves belong to it. The other way round it is not
 * a fragment at all: "Bellward Warranty Administration Ltd" in six footers
 * against one "Notify Bellward Warranty Administration Ltd" in a sentence
 * is the name, and the longer printing is the sloppy cut -- so the short
 * name stands, with everything the sieves said about it.
 */
function mergeFragments(
  claims: readonly ProviderClaim[],
  printings: ReadonlyMap<string, number>,
): ProviderClaim[] {
  const timesPrinted = (claim: ProviderClaim) => printings.get(comparable(claim.name)) ?? 0;
  const absorbed = new Set<ProviderClaim>();
  for (const claim of claims) {
    const words = claimWords(claim.name);
    const host = claims
      .filter((other) =>
        other !== claim && !absorbed.has(other) &&
        isRunOf(words, claimWords(other.name)) &&
        timesPrinted(other) >= timesPrinted(claim))
      .sort((left, right) => timesPrinted(right) - timesPrinted(left))[0];
    if (host === undefined) continue;
    absorbed.add(claim);
    host.name = betterPrinting(host.name, claim.name, printings);
    for (const sieve of claim.sieves) host.sieves.add(sieve);
    for (const sieve of claim.against) host.against.add(sieve);
    host.strength = Math.max(host.strength, claim.strength);
    host.stated = host.stated || claim.stated;
    host.principal = Math.min(host.principal, claim.principal);
  }
  return claims.filter((claim) => !absorbed.has(claim));
}

/** How many independent reasons there are to call this the provider: the
 * sieves for it, less one where a sieve read it as the legal entity behind
 * a trading name the page also printed. */
function agreement(claim: ProviderClaim): number {
  return claim.sieves.size - (claim.against.size > 0 ? 1 : 0);
}

/**
 * The organisation the household's plan is with, where several sieves agree
 * it is, and nothing where they do not.
 *
 * Two sieves have to agree, and no other organisation may have as many:
 * where two names are equally well spoken for the page is ambiguous, and
 * stage 3's answer to ambiguity is silence. A wrong provider costs a point
 * where a blank costs nothing, and the blank is what the model is then
 * asked about.
 */
export function chooseProviderByRules(candidates: readonly TaggedCandidate[]): string | undefined {
  const claims = providerClaims(candidates);
  // Where the page states outright who the household deals with, no other
  // name is in the running: a practice whose name is printed on every sheet
  // does not outrank the administrator the page named, and where the stated
  // name is the only reason there is, the field stays blank rather than
  // taking the repeated one.
  const stated = claims.filter((claim) => claim.stated);
  // Among statements, the most direct is the one heard: "your supplier is",
  // then who runs or sold the plan, then "on behalf of", which a policy
  // prints about its insurer as readily as about the firm the household
  // deals with.
  const directest = Math.min(...stated.map((claim) => claim.principal));
  const heard = stated.length > 0 ? stated.filter((claim) => claim.principal === directest) : claims;
  const ranked = heard
    .map((claim) => ({ claim, agreed: agreement(claim) }))
    .sort((left, right) => right.agreed - left.agreed);
  const best = ranked[0];
  if (best === undefined || best.agreed < AGREEING_SIEVES) return undefined;
  // Two weak readings are two guesses. At least one of the sieves that
  // agreed has to have had the page's own words behind it.
  if (best.claim.strength < STRENGTH_STATED) return undefined;
  if (ranked.length > 1 && ranked[1].agreed >= best.agreed) return undefined;
  return best.claim.name;
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
/** A shortlist is a few hundred characters, not a document: a call needing
 * longer than this has not understood the question. */
const DEADLINE_MS = 60_000;
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
export const nuextractTransport: MeaningTransport = async (question) => {
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
};

/** Any chat model Ollama is serving, asked the same plain-English question.
 * Nothing in the question is NuExtract-shaped, so the answer comes back as
 * a number or a word and `replyLines` reads it the same way. */
export const ollamaChatTransport: MeaningTransport = async (question) => {
  const response = await fetch(CHAT_ENDPOINT, {
    signal: AbortSignal.timeout(DEADLINE_MS),
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: chooserModel(),
      messages: [{ role: "user", content: question }],
      stream: false,
      options: MODEL_OPTIONS,
    }),
  });
  const body = await response.json() as { message?: { content?: string }; error?: string };
  if (body.error) return "";
  return body.message?.content ?? "";
};

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
 * place it was found, because how often a name is printed is evidence
 * (`providerClaims`) and the deduplicated shortlist below cannot see it.
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
 * The provider shortlist: every organisation the sieves kept, best-spoken-for
 * first, each with the block it was printed in and the sieves that kept it.
 *
 * The rules' own ranking is the order (`agreement`, how direct the page's
 * statement was, how good a reason the best sieve had) and that is all the
 * rules do here: the model picks, or answers none.
 */
export function providerShortlistEntries(candidates: readonly TaggedCandidate[]): ShortlistEntry[] {
  const named = providerNames(candidates);
  const blockFor = (name: string) => named.find((entry) => bareName(entry.name) === bareName(name));
  const entries: ShortlistEntry[] = [];
  const seen = new Set<string>();

  for (const claim of providerClaims(candidates)) {
    const key = bareName(claim.name);
    if (seen.has(key)) continue;
    seen.add(key);
    const found = blockFor(claim.name);
    const labels = (found?.candidate.tags ?? [])
      .map((tag) => tag.trigger.trim())
      .filter((trigger) => trigger.length > 0 && trigger.length < 40);
    entries.push({
      value: claim.name,
      display: claim.name,
      line: found?.candidate.line ?? "",
      why: [
        `sieves: ${[...claim.sieves].join(", ")}`,
        ...(labels.length > 0 ? [`the page says: ${labels.join("; ")}`] : []),
        ...(claim.against.size > 0 ? [`read as the company behind the name by: ${[...claim.against].join(", ")}`] : []),
      ],
      support: agreement(claim) * 2 + claim.strength + (PRINCIPAL_TAGS.length - claim.principal),
    });
  }

  // A name no sieve spoke for is still a name on the page, and the model may
  // still be the one to recognise it. It goes last, which on a page with
  // eight better-spoken-for names is off the end of the list.
  for (const { name, candidate } of named) {
    const key = bareName(name);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      value: name,
      display: name,
      line: candidate.line,
      why: ["no sieve spoke for it"],
      support: 0,
    });
  }

  return bestSupported(entries);
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
