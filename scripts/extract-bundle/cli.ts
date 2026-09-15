#!/usr/bin/env node
// Runs Orbit's document reader over a folder of real documents on the
// owner's own machine and lists what it read from each, so the answers can
// be checked against the paper by hand.
//
//   node orbit-extract.cjs [--docs ./docs] [--out ./out] [--tika http://host:9998] [--keep-text] [--candidates]
//   node orbit-extract.cjs --score
//
// Under each document's answers come the top three candidates per field,
// in the order the ranking put them, the chosen one marked with `*` -- the
// list the review screen will offer (#1008). The CSV carries the same three
// per field. --candidates lengthens the lists to the whole shortlist (up to
// eight) and adds each candidate's tags.
//
// A plain run also leaves `out\truth.csv`, one row per document, pre-filled
// with what the reader made of it, for the owner to correct by hand. The
// owner's corrections are the truth for these documents and nothing here
// ever overwrites that file. `--score` reads it back and scores the same
// folder against it with the repository's own scorer, so the number means
// what the corpus numbers mean, and prints the shortlist recall beside it.
//
// The reading is the one being tuned in `src/server/documents/`: Tika turns
// the file into text exactly as the deployed stack does (same Tika version,
// same configuration, no OCR), then letter-spacing repair, the sieve, the
// tags and the rule chooser (ADR-0026), with no model. Nothing leaves the
// machine: the documents are sent only to a Tika running locally.
//
// Tika is found in this order: a URL given with `--tika` or `ORBIT_TIKA_URL`;
// one already answering on localhost:9998; the same Docker image the stack
// uses, if `docker` is installed; the bundled Tika server jar, if `java`
// (17 or later) is installed. Whatever this starts, it stops at the end.
//
// The results carry personal data from the documents. They are written next
// to the documents, on the owner's machine, and belong nowhere else.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import {
  chooseFields,
  costShortlistEntries,
  dateShortlistEntries,
  referenceShortlistEntries,
} from "../../src/server/documents/extraction-choose";
import { providerShortlistEntries, subtypeShortlist } from "../../src/server/documents/extraction-choose-meaning";
import type { CorpusDocument } from "../../src/server/documents/extraction-corpus";
import type { ShortlistEntry } from "../../src/server/documents/extraction-shortlist";
import {
  countShortlistRecall,
  emptyRecallTallies,
  formatRecallTable,
  recallMisses,
} from "../../src/server/documents/extraction-shortlist-recall";
import { sieve } from "../../src/server/documents/extraction-sieve";
import { tagCandidates } from "../../src/server/documents/extraction-tags";
import { repairLetterSpacing } from "../../src/server/documents/extraction-text-repair";
import { formatRunScore, scoreCorpus, type ExtractedFields } from "../../src/server/documents/extraction-scoring";
import type { TaggedCandidate } from "../../src/server/documents/extraction-stages";
import { undoTikaMarkdownEscapes } from "../../src/server/documents/tika";
import { readTruthFile, TRUTH_HELP, truthCsv } from "./truth";

/** As the application: what Tika sends past this point is not read. */
const MAX_EXTRACTED_CHARACTERS = 250_000;

const MEDIA_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

const TIKA_IMAGE = "apache/tika:4.0.0-full@sha256:6c244af88e8575ebe8bf0bc5e2da03c49663dd0acc7809cd99c8e9ff8741cbfb";
const TIKA_JAR = "tika-server-standard-4.0.0.jar";
const LOCAL_TIKA = "http://127.0.0.1:9998";
const CONTAINER = "orbit-extract-tika";

const showCandidates = process.argv.includes("--candidates");

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function commandExists(command: string): Promise<boolean> {
  return new Promise((done) => {
    execFile(command, ["--version"], { windowsHide: true }, (error) => done(error === null));
  });
}

async function tikaAnswers(url: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/version", url), { signal: AbortSignal.timeout(3_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForTika(url: string, child: ChildProcess | undefined, seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds; i += 1) {
    if (child !== undefined && child.exitCode !== null) return false;
    if (await tikaAnswers(url)) return true;
    await sleep(1_000);
  }
  return false;
}

interface Tika {
  url: string;
  stop: () => Promise<void>;
}

/** The Tika this run will use, starting one if it has to. */
async function findTika(bundleDir: string): Promise<Tika> {
  const given = option("--tika") ?? process.env.ORBIT_TIKA_URL;
  if (given !== undefined) {
    if (!(await tikaAnswers(given))) throw new Error(`no Tika answers at ${given}`);
    return { url: given, stop: async () => {} };
  }
  if (await tikaAnswers(LOCAL_TIKA)) {
    console.error(`using the Tika already running at ${LOCAL_TIKA}`);
    return { url: LOCAL_TIKA, stop: async () => {} };
  }
  const config = join(bundleDir, "tika-config.json");
  if (await commandExists("docker")) {
    console.error("starting Tika in Docker (the stack's own image; the first run downloads it)");
    const child = spawn("docker", [
      "run", "--rm", "-d", "--name", CONTAINER, "-p", "9998:9998",
      "-v", `${config}:/etc/orbit/tika-config.json:ro`,
      TIKA_IMAGE, "-c", "/etc/orbit/tika-config.json",
    ], { stdio: ["ignore", "ignore", "inherit"], windowsHide: true });
    const stop = () => new Promise<void>((done) => {
      execFile("docker", ["stop", CONTAINER], { windowsHide: true }, () => done());
    });
    if (await waitForTika(LOCAL_TIKA, undefined, 120)) return { url: LOCAL_TIKA, stop };
    await stop();
    child.kill();
    throw new Error("Docker started but Tika never answered on port 9998");
  }
  if (await commandExists("java")) {
    console.error("starting the bundled Tika server with Java");
    const child = spawn("java", ["-jar", join(bundleDir, "tika", TIKA_JAR), "-c", config, "-h", "127.0.0.1", "-p", "9998"], {
      cwd: join(bundleDir, "tika"), stdio: ["ignore", "ignore", "inherit"], windowsHide: true,
    });
    const stop = async () => { child.kill(); };
    if (await waitForTika(LOCAL_TIKA, child, 60)) return { url: LOCAL_TIKA, stop };
    await stop();
    throw new Error("Java started but Tika never answered on port 9998 (Tika 4 needs Java 17 or later)");
  }
  throw new Error("no Tika found: install Docker Desktop or Java 17+, or pass --tika <url> (see README.md)");
}

async function extractText(tika: string, bytes: Buffer, mediaType: string): Promise<string> {
  const response = await fetch(new URL("/tika", tika), {
    method: "PUT",
    headers: { Accept: "text/plain", "Content-Type": mediaType },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Tika answered ${response.status}`);
  return undoTikaMarkdownEscapes(await response.text()).slice(0, MAX_EXTRACTED_CHARACTERS);
}

function readFields(text: string): { fields: ExtractedFields; lists: FieldLists } {
  const page = repairLetterSpacing(text);
  const candidates = tagCandidates(page, sieve(page));
  const fields = chooseFields(candidates, page);
  return { fields, lists: fieldLists(fields, candidates, page) };
}

function money(fields: ExtractedFields): string {
  if (fields.costMinor === undefined || fields.currency === undefined) return "";
  const symbol = fields.currency === "GBP" ? "£" : `${fields.currency} `;
  return `${symbol}${(fields.costMinor / 100).toFixed(2)}`;
}

/** As `money`, off a shortlist entry's minor-units value and currency. */
function amountDisplay(entry: ShortlistEntry): string {
  const minor = Number(entry.value);
  const symbol = entry.currency === "GBP" ? "£" : entry.currency ? `${entry.currency} ` : "";
  return `${symbol}${(minor / 100).toFixed(2)}`;
}

// A trimmed field value only ever narrows what a candidate printed (see
// `value-trim.ts`), so "chosen" is read loosely: case- and space-folded
// equality, or the candidate containing the chosen text.
function narrows(candidateValue: string, chosen: string): boolean {
  const fold = (value: string) => value.toLowerCase().replace(/\s+/gu, " ").trim();
  const c = fold(candidateValue);
  const v = fold(chosen);
  return v.length > 0 && (c === v || c.includes(v));
}

/** The review screen offers three (#1008); `--candidates` shows the whole
 * shortlist the chooser saw. */
const OFFERED = 3;
const MAX_LISTED_CANDIDATES = 8;

/** One field's list as the review screen will offer it: the chosen answer
 * first, then the shortlist's next entries in rank order. */
interface FieldList {
  name: string;
  entries: { display: string; chosen: boolean; why: string[] }[];
}

type FieldLists = FieldList[];

/** A chosen value with how it is printed: the value the shortlist is
 * matched on, the display the owner reads. */
interface Chosen {
  value: string;
  display: string;
}

/**
 * The lists under a document, per field: the chosen answer first (#1008
 * pre-selects it), then the shortlist the chooser saw, in its rank order,
 * less the chosen. The shortlist's own order is what
 * `shortlist-recall-cli.ts` measures top-1 / top-3 on; here the chooser's
 * pick leads, because that is what the screen shows.
 */
function fieldLists(fields: ExtractedFields, candidates: readonly TaggedCandidate[], page: string): FieldLists {
  const list = (
    name: string,
    entries: readonly ShortlistEntry[],
    display: (entry: ShortlistEntry) => string,
    chosen: readonly Chosen[],
    matches: (entry: ShortlistEntry, chosen: Chosen) => boolean,
  ): FieldList => {
    const lead = chosen.map((answer) => {
      const hit = entries.find((entry) => matches(entry, answer));
      return { display: answer.display, chosen: true, why: hit?.why ?? ["derived, not printed"] };
    });
    const rest = entries
      .filter((entry) => !chosen.some((answer) => matches(entry, answer)))
      .map((entry) => ({ display: display(entry), chosen: false, why: entry.why }));
    return { name, entries: [...lead, ...rest] };
  };
  const one = (value: string | undefined): Chosen[] => (value === undefined ? [] : [{ value, display: value }]);
  const subtypes = subtypeShortlist(candidates);
  return [
    list("provider", providerShortlistEntries(candidates), (e) => e.display,
      one(fields.provider), (e, c) => narrows(e.value, c.value)),
    list("reference", referenceShortlistEntries(candidates, page), (e) => e.display,
      one(fields.reference), (e, c) => narrows(e.value, c.value)),
    list("subtype", subtypes.entries, (e) => e.display,
      one(fields.subtype), (e, c) => narrows(c.value, e.value)),
    list("cost", costShortlistEntries(candidates, page), amountDisplay,
      fields.costMinor === undefined || fields.currency === undefined
        ? []
        : [{ value: `${fields.costMinor} ${fields.currency}`, display: money(fields) }],
      (e, c) => `${e.value} ${e.currency ?? ""}` === c.value),
    // Dates are many per document, so the list is the shortlist's own
    // order, with the ones the chooser kept starred.
    {
      name: "dates",
      entries: dateShortlistEntries(candidates).map((entry) => ({
        display: entry.display, chosen: fields.dates.includes(entry.value), why: entry.why,
      })),
    },
  ];
}

/** The lines under a document: three per field, or the whole shortlist with
 * its reasons under `--candidates`. */
function candidateLines(lists: FieldLists, all: boolean): string[] {
  const lines: string[] = [];
  for (const field of lists) {
    if (field.entries.length === 0) continue;
    const shown = field.entries.slice(0, all ? MAX_LISTED_CANDIDATES : OFFERED);
    lines.push(`  ${all ? "shortlist" : "top three"}: ${field.name}`);
    shown.forEach((entry, at) => {
      lines.push(`    ${entry.chosen ? "*" : " "} ${at + 1}. ${entry.display}${all ? `  [${entry.why.join("; ")}]` : ""}`);
    });
  }
  return lines;
}

/** The top three as one CSV cell: "a | b | c", the chosen one starred. */
function topThreeCell(lists: FieldLists, name: string): string {
  const field = lists.find((entry) => entry.name === name);
  if (field === undefined) return "";
  return field.entries.slice(0, OFFERED).map((entry) => `${entry.chosen ? "*" : ""}${entry.display}`).join(" | ");
}

function dates(fields: ExtractedFields): string {
  const role = new Map((fields.dateRoles ?? []).map((entry) => [entry.date, entry.role]));
  return fields.dates.map((date) => `${date}${role.has(date) ? ` (${role.get(date)})` : ""}`).join(", ");
}

function recurrence(fields: ExtractedFields): string {
  if (fields.recurrenceMonths === undefined) return "";
  return fields.recurrenceMonths === 1 ? "every month" : `every ${fields.recurrenceMonths} months`;
}

interface Row {
  file: string;
  characters: number;
  /** The text Tika gave back, kept for `--score`. */
  text?: string;
  fields?: ExtractedFields;
  lists?: FieldLists;
  problem?: string;
}

const COLUMNS = ["file", "provider", "reference", "subtype", "cost", "dates", "schedule", "recurrence", "text characters", "problem"];
const TOP_THREE = ["provider", "reference", "subtype", "cost", "dates"];

function cells(row: Row): string[] {
  const f = row.fields;
  return [
    row.file,
    f?.provider ?? "",
    f?.reference ?? "",
    f?.subtype ?? "",
    f === undefined ? "" : money(f),
    f === undefined ? "" : dates(f),
    f?.scheduleKind ?? "",
    f === undefined ? "" : recurrence(f),
    String(row.characters),
    row.problem ?? "",
  ];
}

function block(row: Row): string {
  const lines = [`== ${row.file}`];
  const values = cells(row);
  for (let i = 1; i < COLUMNS.length; i += 1) {
    if (COLUMNS[i] === "problem" && values[i] === "") continue;
    lines.push(`  ${`${COLUMNS[i]}:`.padEnd(17)}${values[i]}`);
  }
  if (row.characters === 0 && row.problem === undefined) {
    lines.push("  (no text came out of this file: a scanned image, perhaps -- Orbit reads no OCR either)");
  }
  if (row.lists !== undefined) lines.push(...candidateLines(row.lists, showCandidates));
  return lines.join("\n");
}

function csv(rows: Row[]): string {
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const header = [...COLUMNS, "right? (fill in)", ...TOP_THREE.map((name) => `${name} top three`)].map(quote).join(",");
  const line = (row: Row) => [
    ...cells(row),
    "",
    ...TOP_THREE.map((name) => (row.lists === undefined ? "" : topThreeCell(row.lists, name))),
  ].map(quote).join(",");
  return [header, ...rows.map(line)].join("\r\n") + "\r\n";
}

/**
 * The score for these documents against the owner's truth: the repository's
 * own scorer over `CorpusDocument`s built from the truth rows, then the
 * shortlist recall the review screen depends on (#1008), then the misses.
 */
async function scoreReport(rows: Row[], truthFile: string): Promise<string> {
  const truth = readTruthFile(readFileSync(truthFile, "utf8"));
  const problems = [...truth.problems];
  const read = new Map(rows.map((row) => [row.file, row]));
  const documents: CorpusDocument[] = [];
  for (const entry of truth.entries) {
    const row = read.get(entry.file);
    if (row === undefined || row.text === undefined || row.fields === undefined) {
      problems.push(`${entry.file}: in truth.csv but not read from the docs folder, so it is not scored`);
      continue;
    }
    if (entry.scorable) {
      documents.push({ name: entry.file, filename: entry.file, text: row.text, expected: entry.expected });
    }
  }
  const known = new Set(truth.entries.map((entry) => entry.file));
  for (const row of rows) {
    if (row.fields !== undefined && !known.has(row.file)) {
      problems.push(`${row.file}: no row in truth.csv, so it is not scored`);
    }
  }
  if (documents.length === 0) throw new Error(`no document in ${truthFile} matches a file in the docs folder`);

  // The fields are the ones already printed above, handed to the scorer as
  // they stand: scoring re-reads nothing, so the number is about what the
  // owner just saw.
  const score = await scoreCorpus(documents, (_text, filename) => read.get(filename)?.fields ?? { dates: [] });

  const tallies = emptyRecallTallies();
  for (const document of documents) {
    countShortlistRecall(tallies, {
      name: document.name,
      text: repairLetterSpacing(document.text),
      expected: document.expected,
    });
  }
  const shortlistMisses = recallMisses(tallies);

  return [
    ...(problems.length > 0 ? [`truth file:\n- ${problems.join("\n- ")}`] : []),
    formatRunScore(`real ${documents.length}: sieve+tag+choose`, score),
    formatRecallTable("", tallies),
    shortlistMisses.length === 0
      ? "every answer was somewhere on its shortlist"
      : `shortlist misses:\n- ${shortlistMisses.join("\n- ")}`,
  ].join("\n\n");
}

async function main(): Promise<void> {
  const bundleDir = __dirname;
  const docsDir = resolve(option("--docs") ?? join(bundleDir, "docs"));
  const outDir = resolve(option("--out") ?? join(bundleDir, "out"));
  const keepText = process.argv.includes("--keep-text");
  const wantsScore = process.argv.includes("--score");
  const truthFile = join(outDir, "truth.csv");
  if (wantsScore && !existsSync(truthFile)) {
    console.error(`no ${truthFile} yet: run it without --score first, then correct the answers in that file`);
    process.exitCode = 1;
    return;
  }
  const files = readdirSync(docsDir)
    .filter((name) => MEDIA_TYPES[extname(name).toLowerCase()] !== undefined)
    .sort((a, b) => a.localeCompare(b));
  if (files.length === 0) {
    console.error(`no .pdf, .jpg or .png files in ${docsDir}`);
    process.exitCode = 1;
    return;
  }
  mkdirSync(outDir, { recursive: true });
  if (keepText) mkdirSync(join(outDir, "text"), { recursive: true });

  const tika = await findTika(bundleDir);
  const rows: Row[] = [];
  try {
    for (const file of files) {
      const row: Row = { file, characters: 0 };
      try {
        const text = await extractText(tika.url, readFileSync(join(docsDir, file)), MEDIA_TYPES[extname(file).toLowerCase()]);
        row.characters = text.length;
        row.text = text;
        if (keepText) writeFileSync(join(outDir, "text", `${basename(file)}.txt`), text);
        const { fields, lists } = readFields(text);
        row.fields = fields;
        row.lists = lists;
      } catch (error) {
        row.problem = error instanceof Error ? error.message : String(error);
      }
      rows.push(row);
      console.log(block(row));
    }
  } finally {
    await tika.stop();
  }
  writeFileSync(join(outDir, "results.txt"), rows.map(block).join("\n\n") + "\n");
  writeFileSync(join(outDir, "results.csv"), csv(rows));
  writeFileSync(join(outDir, "truth-help.txt"), TRUTH_HELP.join("\r\n") + "\r\n");
  console.log(`\n${rows.length} documents read; results in ${outDir}`);

  // Never over a truth file that exists: those are the owner's own answers,
  // and a second run must not quietly replace them with the reader's.
  if (!existsSync(truthFile)) {
    writeFileSync(truthFile, truthCsv(rows));
    console.log(
      `\nwrote ${truthFile}, pre-filled with the answers above.\n` +
      "Correct the cells that are wrong, blank the ones the page does not answer\n" +
      `(truth-help.txt explains the columns), then run  run.cmd --score  to score them.`,
    );
  }

  if (wantsScore) {
    const report = await scoreReport(rows, truthFile);
    console.log(`\n${report}`);
    writeFileSync(join(outDir, "score.txt"), `${report}\n`.replaceAll("\n", "\r\n"));
    console.log(`\nthe same lines are in ${join(outDir, "score.txt")}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
