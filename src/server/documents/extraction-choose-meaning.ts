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
import {
  composeSubtype,
  louderWherePrinted,
  rankedWherePrinted,
  subtypeGroupBins,
  subtypeSources,
  SUBTYPE_PLACES,
  type GroupBin,
  type PlacedCandidate,
  type SubtypePlace,
} from "./extraction-subtype-bins";
import { classifyProvider } from "./extraction-scoring";
import {
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
import { trimFieldValue } from "./value-trim";

// ---------------------------------------------------------------- provider

/** The scorer's comparison, with the legal suffix optional on both sides,
 * so "Millbrook Energy" and "Millbrook Energy Ltd" are one name here too. */
function sameOrganisation(left: string, right: string): boolean {
  return classifyProvider(left, right) === "correct";
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
      model: DEFAULT_MODEL,
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
export const ollamaChatTransport = (model: string): MeaningTransport =>
  (question) => answering(async () => {
    const response = await fetch(CHAT_ENDPOINT, {
      signal: AbortSignal.timeout(DEADLINE_MS),
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
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
 * The transport the evaluations use: NuExtract's native mode by default,
 * and the generic chat call carrying whatever model an evaluation named on
 * its command line (`--chooser-model`). Swapping the chooser is that flag
 * and nothing else; nothing in this file reads the environment, so the
 * app's configuration contract stays the app's.
 */
export function chooserTransport(modelName?: string): MeaningTransport {
  const named = modelName?.trim();
  return named ? ollamaChatTransport(named) : nuextractTransport;
}

/**
 * Proof, before an evaluation starts, that the chooser can be reached and
 * the model it will ask is pulled. A call that fails answers blank by
 * design (the unattended path must not stall on a model), so an evaluation
 * run from somewhere `orbit-ollama` does not resolve -- the host, rather
 * than a container on `orbit_orbit-document-processing` -- would otherwise
 * score 0% in seconds and look like a result (2026-09-12).
 */
export async function assertChooserReachable(modelName?: string): Promise<void> {
  const wanted = modelName?.trim() || DEFAULT_MODEL;
  const tags = new URL("/api/tags", CHAT_ENDPOINT).toString();
  let pulled: string[];
  try {
    const response = await fetch(tags, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { models?: Array<{ name?: string }> };
    pulled = (body.models ?? []).map((model) => model.name ?? "");
  } catch (error) {
    throw new Error(
      `cannot reach the chooser at ${tags} (${error instanceof Error ? error.message : String(error)}). ` +
        "Model evaluations run inside a container on the orbit_orbit-document-processing network; " +
        "from the host every answer would be blank.",
    );
  }
  if (!pulled.includes(wanted)) {
    throw new Error(`model ${wanted} is not pulled on orbit-ollama (pulled: ${pulled.join(", ") || "none"})`);
  }
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

/**
 * The two questions subtype asks, each over its own short list, numbered as
 * one list for the model: what the document is about, and what type of
 * thing it is.
 */
export interface SubtypeShortlist {
  /** The qualifier groups offered: "Home", "Motor", "Council tax". */
  qualifiers: ShortlistEntry[];
  /** The kind groups offered: "Insurance", "Bill", "Certificate". */
  kinds: ShortlistEntry[];
  /** Both, in the order the model is shown them. */
  entries: ShortlistEntry[];
}

/** How many groups of each sort the model is offered. Two is the owner's
 * (2026-09-11): on the 24 the true qualifier and the true kind are both
 * inside the top two, and a third would be a name the page barely says. */
const GROUPS_OFFERED = 2;

/** What the review screen and the model are told about where a group's words
 * were printed, in the household's words. */
const PLACE_NAMED: Record<SubtypePlace, string> = {
  title: "the title",
  heading: "a heading",
  body: "the text",
};

function wherePrinted(bin: GroupBin<PlacedCandidate>): string {
  return SUBTYPE_PLACES
    .filter((place) => bin.places[place] > 0)
    .map((place) => `${bin.places[place]} in ${PLACE_NAMED[place]}`)
    .join(", ");
}

/**
 * The groups offered, ranked by where the page printed the words rather than
 * by how many times it printed them (`extraction-subtype-bins.ts`, #1015).
 *
 * Which groups are offered is unchanged -- the best-supported `GROUPS_OFFERED`
 * of each sort, as the owner set it. Only their order changes, and with it
 * the group the plain-page rules answer from, which is always the head of the
 * list the review screen shows.
 */
function subtypeBinsWherePrinted(candidates: readonly TaggedCandidate[]): {
  qualifiers: Array<GroupBin<PlacedCandidate>>;
  kinds: Array<GroupBin<PlacedCandidate>>;
} {
  const bins = subtypeGroupBins(subtypeSources(candidates));
  return {
    qualifiers: rankedWherePrinted(bins.qualifiers.slice(0, GROUPS_OFFERED)),
    kinds: rankedWherePrinted(bins.kinds.slice(0, GROUPS_OFFERED)),
  };
}

/**
 * The subtype shortlist: the two best-supported qualifier groups and the
 * two best-supported kind groups from the taxonomy bins
 * (`extraction-subtype-bins.ts`, the owner's method of 2026-09-11), each
 * with how often the page's words landed in it.
 *
 * Four names rather than eight composed phrases. The taxonomy has 51 kinds
 * and 63 qualifiers; the page's own words -- what it calls itself, who it
 * is from -- say which handful it is about, and the model is left with two
 * small questions it can answer from the words in front of it. The answer
 * is composed afterwards by the taxonomy's own rules (`composeSubtype`),
 * not written by the model.
 */
export function subtypeShortlist(candidates: readonly TaggedCandidate[]): SubtypeShortlist {
  const bins = subtypeBinsWherePrinted(candidates);
  const entryOf = (bin: GroupBin<PlacedCandidate>, what: string): ShortlistEntry => ({
    value: bin.group,
    display: bin.group,
    line: bin.sources[0]?.line ?? "",
    why: [`${what}, the page's words land in it ${bin.count} times (${wherePrinted(bin)})`],
    support: bin.count,
  });
  const qualifiers = bins.qualifiers.map((bin) => entryOf(bin, "what it is about"));
  const kinds = bins.kinds.map((bin) => entryOf(bin, "what type of thing it is"));
  return { qualifiers, kinds, entries: [...qualifiers, ...kinds] };
}

/**
 * The subtype the rules fall back on with no model to ask: the top
 * qualifier and the top kind, each taken only where the page spoke it louder
 * than its runner-up (owner, 2026-09-11; louder now means where the words
 * were printed, #1015).
 *
 * Where two groups are level the page is saying both as loudly, and a
 * composed answer would be a guess with a wrong-value penalty behind it;
 * the group drops out and the other one answers alone if it can.
 */
export function chooseSubtypeByRules(candidates: readonly TaggedCandidate[]): string | undefined {
  const bins = subtypeBinsWherePrinted(candidates);
  const clear = (ranked: ReadonlyArray<GroupBin<PlacedCandidate>>): string | undefined => {
    const [best, next] = ranked;
    if (best === undefined) return undefined;
    return next !== undefined && louderWherePrinted(best, next) >= 0 ? undefined : best.group;
  };
  return composeSubtype(clear(bins.qualifiers), clear(bins.kinds));
}


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

/**
 * What this document is about and what type of thing it is, chosen from the
 * four names the bins offered.
 *
 * One question, two numbers: the model picks a qualifier or none and a kind
 * or none, and the answer is composed from them by the taxonomy's own rules
 * (`composeSubtype`). It is never asked to write a phrase -- only to choose
 * between names the page's own words put in front of it -- and a reply
 * naming nothing on the list leaves the field blank.
 */
export async function chooseSubtypeWithModel(
  shortlist: SubtypeShortlist,
  transport: MeaningTransport,
): Promise<string | undefined> {
  const { entries, qualifiers, kinds } = shortlist;
  if (entries.length === 0) return undefined;
  const asked = [
    "What is this document about, and what type of thing is it?",
    'Answer two numbers from the list and nothing else -- what it is about first, ' +
      'then the type, like "1 3". Answer none in place of either if none of them fits.',
    "",
    shortlistExcerpt("What the words on this page say about it:", entries),
  ].join("\n");
  const raw = await transport(asked);

  let qualifier: ShortlistEntry | undefined;
  let kind: ShortlistEntry | undefined;
  // A reply may be "1 3", two lines, or the names written out; each part is
  // grounded against the one numbered list the model was shown, and which
  // list an entry came from is what makes it the qualifier or the kind.
  for (const part of replyLines(raw).flatMap((line) => line.split(/[\s,;]+/u))) {
    const entry = entryChosen(part, entries);
    if (entry === undefined) continue;
    if (qualifier === undefined && qualifiers.includes(entry)) qualifier = entry;
    else if (kind === undefined && kinds.includes(entry)) kind = entry;
  }
  // A model that wrote out a name in words rather than its number.
  const written = comparable(raw);
  qualifier ??= qualifiers.find((entry) => written.includes(comparable(entry.value)));
  kind ??= kinds.find((entry) => written.includes(comparable(entry.value)));

  return composeSubtype(qualifier?.value, kind?.value);
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
