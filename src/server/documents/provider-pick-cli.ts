#!/usr/bin/env node
// "Rules find, model picks" for provider (#994, owner 2026-09-12): the rules
// build a shortlist of at most eight names, and a model is asked which one
// the household deals with -- a few hundred characters, no page text beyond
// the block each name was printed in. Two shortlists, because two rule
// routes exist: the shipped word-run bins (`providerShortlistEntries`) and
// provider's own stage 2 (`readProviders`, #996). Scored with
// `classifyProvider`, so a short form of the name counts.
//
// `--window` is what the model is shown around each name (owner, 2026-09-14):
// `block` is the control, `sentence` the whole sentence the name sits in, and
// `w15`/`w10`/`w5` that many words either side. Every window is centred on the
// name's own printing and marked with « »; `EXCERPT_LIMIT` is unchanged, so a
// wider window pays for itself by dropping entries off the bottom of the list,
// and the run says how often that happened.
//
//   npm run eval:provider-pick                             # NuExtract, both lists
//   npm run eval:provider-pick -- --chooser-model qwen3:4b # another model
//   npm run eval:provider-pick -- --route bins|own         # one list only
//   npm run eval:provider-pick -- --window sentence        # what it is shown
//   npm run eval:provider-pick -- --entries 3              # a shorter list
//   npm run eval:provider-pick -- --limit 6                # first N documents
//   npm run eval:provider-pick -- --from 21 --limit 20     # documents 21 to 40
//   npm run eval:provider-pick -- --holdout3               # the 12 unseen pages
//   npm run eval:provider-pick -- --holdout4               # the other 12
//
// On a hold-out the progress line counts documents rather than naming them:
// a hold-out document's name is as much not ours to read as its text.
//
// Asks the model, so it must run in a container on
// `orbit_orbit-document-processing` (AGENTS.md, "stages-rerun" pattern).
import {
  assertChooserReachable,
  chooseProviderWithModel,
  chooserTransport,
  providerShortlistEntries,
  PROVIDER_QUESTION,
} from "./extraction-choose-meaning";
import { EXTRACTION_CORPUS } from "./extraction-corpus";
import { EXTRACTION_HOLDOUT3_FULLPAGE } from "./extraction-holdout3-fullpage";
import { EXTRACTION_HOLDOUT4_FULLPAGE } from "./extraction-holdout4-fullpage";
import { classifyProvider } from "./extraction-scoring";
import {
  contextWindow,
  shortlistExcerpt,
  CONTEXT_WINDOWS,
  DEFAULT_WINDOW,
  type ContextWindow,
  type ShortlistEntry,
} from "./extraction-shortlist";
import { sieve } from "./extraction-sieve";
import { tagCandidates } from "./extraction-tags";
import { providerCandidates } from "./provider-stage1-sieve";
import { readProviders } from "./provider-stage2-sieves";

const LIST_LIMIT = 8;

/** Whether a reply that chose nothing was the model declining or the model
 * naming something the list does not carry. Both leave the field blank and
 * only one of them is an answer. */
type Refusal = "none" | "off the list";

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const modelNamed = flag("--chooser-model");
const route = flag("--route") ?? "both";
const limit = Number(flag("--limit") ?? Number.MAX_SAFE_INTEGER);
const holdout3 = process.argv.includes("--holdout3");
const holdout4 = process.argv.includes("--holdout4");
const onHoldout = holdout3 || holdout4;
/** How many of the rules' entries the model is asked to choose between.
 * Eight is the shipped list; the owner's comparison of 2026-09-14 is over
 * the best three. */
const entriesOffered = Number(flag("--entries") ?? LIST_LIMIT);
const windowNamed = (flag("--window") ?? DEFAULT_WINDOW) as ContextWindow;
if (!CONTEXT_WINDOWS.includes(windowNamed)) {
  console.error(`--window must be one of: ${CONTEXT_WINDOWS.join(", ")}`);
  process.exit(1);
}

// A whole corpus is more model calls than one sitting affords, so a run can
// take the documents from the Nth on and the tallies be added up afterwards.
const from = Math.max(1, Number(flag("--from") ?? 1));
const heldOut = holdout4 ? EXTRACTION_HOLDOUT4_FULLPAGE : EXTRACTION_HOLDOUT3_FULLPAGE;
const corpus = onHoldout ? heldOut : EXTRACTION_CORPUS;
const documents = corpus.slice(from - 1, from - 1 + limit);
const prefix = holdout4 ? "hold-out 4: " : holdout3 ? "hold-out 3: " : "";

/** The first block the name is printed in, as the evidence the model sees. */
function blockPrinting(text: string, name: string): string {
  const wanted = name.toLowerCase();
  for (const line of text.split(/\n+/u)) {
    if (line.toLowerCase().includes(wanted)) return line.trim().slice(0, 160);
  }
  return "";
}

/** Own stage 2's top eight as shortlist entries: the name, where it was
 * printed, and what the rules said about it. */
function ownStage2Entries(text: string): ShortlistEntry[] {
  return readProviders(text, providerCandidates(text)).slice(0, LIST_LIMIT).map((reading) => ({
    value: reading.name,
    display: reading.name,
    line: blockPrinting(text, reading.name),
    why: [
      `printed ${reading.printings} times`,
      ...reading.votes.map((vote) => `${vote.weight > 0 ? "for" : "against"}: ${vote.trigger}`),
    ],
    support: reading.score,
  }));
}

interface Tally {
  hits: number;
  of: number;
  onList: number;
  /** The model declined: it answered none, or it answered nothing at all. */
  saidNone: number;
  /** The model answered, but named something the list does not carry. */
  offList: number;
  /** Documents whose list the excerpt limit cut short. */
  truncated: number;
  /** Characters of window handed over, and entries they were handed for. */
  windowChars: number;
  windowEntries: number;
}

function emptyTally(): Tally {
  return { hits: 0, of: 0, onList: 0, saidNone: 0, offList: 0, truncated: 0, windowChars: 0, windowEntries: 0 };
}

/** Which kind of blank a reply that chose nothing was. A reply with no
 * words in it is the model declining as much as one that says so. */
function refusal(reply: string): Refusal {
  const said = reply.trim().toLowerCase();
  return said === "" || said.includes("none") ? "none" : "off the list";
}

/** How many of a list's entries survived `EXCERPT_LIMIT`: the excerpt is the
 * heading and one line per entry, so its lines are what the model was shown. */
function entriesShown(entries: readonly ShortlistEntry[], window: ContextWindow): number {
  return shortlistExcerpt(PROVIDER_QUESTION.heading, entries, { window }).split("\n").length - 1;
}

async function main(): Promise<void> {
  await assertChooserReachable(modelNamed);
  const transport = chooserTransport(modelNamed);
  const model = modelNamed ?? "NuExtract";
  const routes: Array<{ name: string; entries: (text: string) => ShortlistEntry[]; tally: Tally }> = [];
  if (route !== "own") routes.push({ name: "bins", entries: (text) => providerShortlistEntries(tagCandidates(text, sieve(text))), tally: emptyTally() });
  if (route !== "bins") routes.push({ name: "own stage 2", entries: ownStage2Entries, tally: emptyTally() });

  const started = Date.now();
  let at = 0;
  for (const document of documents) {
    at += 1;
    const wanted = document.expected.provider;
    if (wanted === undefined) continue;
    for (const { entries, tally } of routes) {
      const list = entries(document.text).slice(0, entriesOffered);
      tally.of += 1;
      if (list.some((entry) => classifyProvider(wanted, entry.value) === "correct")) tally.onList += 1;
      const shown = entriesShown(list, windowNamed);
      if (shown < list.length) tally.truncated += 1;
      for (const entry of list) {
        tally.windowChars += contextWindow(entry, windowNamed).length;
        tally.windowEntries += 1;
      }
      let reply = "";
      const chosen = await chooseProviderWithModel(list, transport, {
        window: windowNamed,
        heard: (raw) => { reply = raw; },
      });
      if (chosen === undefined) {
        if (refusal(reply) === "none") tally.saidNone += 1;
        else tally.offList += 1;
      } else if (classifyProvider(wanted, chosen) === "correct") tally.hits += 1;
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(0);
    const named = onHoldout
      ? `document ${from + at - 1} of ${corpus.length}`
      : document.name.split(",")[0];
    process.stderr.write(`${named}: ${seconds}s\n`);
  }

  for (const { name, tally } of routes) {
    const percent = tally.of === 0 ? "0" : ((tally.hits / tally.of) * 100).toFixed(0);
    const perEntry = tally.windowEntries === 0
      ? "0"
      : (tally.windowChars / tally.windowEntries).toFixed(0);
    console.log(`window ${windowNamed}, ${entriesOffered} entries offered: ${perEntry} characters an entry; list cut by the excerpt limit on ${tally.truncated}/${tally.of}`);
    console.log(`right answer on the ${name} list: ${tally.onList}/${tally.of}; model answered none: ${tally.saidNone}/${tally.of}; model named something off the list: ${tally.offList}/${tally.of}`);
    console.log(`${prefix}provider by model pick from ${name} (${model}): ${percent}% (${tally.hits}/${tally.of}) [provider ${tally.hits}/${tally.of}]`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
