#!/usr/bin/env node
// Runs Orbit's document reader over a folder of real documents on the
// owner's own machine and lists what it read from each, so the answers can
// be checked against the paper by hand.
//
//   node orbit-extract.cjs [--docs ./docs] [--out ./out] [--tika http://host:9998] [--keep-text] [--candidates]
//
// --candidates adds, under each document, the shortlist stage 2 handed the
// chooser for provider, reference, subtype, cost and dates -- each
// candidate's text and tags, the chosen one marked with `*`.
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
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { chooseFields } from "../../src/server/documents/extraction-choose";
import { sieve } from "../../src/server/documents/extraction-sieve";
import { subtypeSources } from "../../src/server/documents/extraction-subtype-bins";
import { tagCandidates } from "../../src/server/documents/extraction-tags";
import { repairLetterSpacing } from "../../src/server/documents/extraction-text-repair";
import type { ExtractedFields } from "../../src/server/documents/extraction-scoring";
import type { TaggedCandidate } from "../../src/server/documents/extraction-stages";
import { undoTikaMarkdownEscapes } from "../../src/server/documents/tika";

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

function readFields(text: string): { fields: ExtractedFields; candidates: TaggedCandidate[] } {
  const page = repairLetterSpacing(text);
  const candidates = tagCandidates(page, sieve(page));
  return { fields: chooseFields(candidates, page), candidates };
}

function money(fields: ExtractedFields): string {
  if (fields.costMinor === undefined || fields.currency === undefined) return "";
  const symbol = fields.currency === "GBP" ? "£" : `${fields.currency} `;
  return `${symbol}${(fields.costMinor / 100).toFixed(2)}`;
}

/** As `money`, off a candidate's own minor-units value and currency rather
 * than a chosen field, for the `--candidates` shortlists. */
function amountDisplay(candidate: TaggedCandidate): string {
  const minor = Number(candidate.value);
  const symbol = candidate.currency === "GBP" ? "£" : candidate.currency ? `${candidate.currency} ` : "";
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

const MAX_LISTED_CANDIDATES = 8;

/**
 * `--candidates`: one sub-list per field, showing what stage 2 handed the
 * chooser -- the candidates of the kind that field reads (`extraction-tags.ts`,
 * `extraction-choose.ts`), in the order they arrived, capped at eight, the
 * chosen one (if among them) marked with `*`. A chosen value the list does
 * not carry -- a derived cost, a composed subtype -- gets a line saying so.
 */
function candidateLines(fields: ExtractedFields, candidates: readonly TaggedCandidate[]): string[] {
  const lines: string[] = [];

  const section = (
    name: string,
    pool: readonly TaggedCandidate[],
    display: (candidate: TaggedCandidate) => string,
    chosenValues: readonly string[],
    matches: (candidate: TaggedCandidate, chosen: string) => boolean,
  ) => {
    if (pool.length === 0 && chosenValues.length === 0) return;
    const shown = pool.slice(0, MAX_LISTED_CANDIDATES);
    lines.push(`  candidates: ${name}`);
    const remaining = new Set(chosenValues);
    for (const candidate of shown) {
      const hit = chosenValues.find((chosen) => matches(candidate, chosen));
      if (hit !== undefined) remaining.delete(hit);
      const tags = candidate.tags.map((tag) => tag.value).join(", ");
      lines.push(`    ${hit !== undefined ? "*" : " "} ${display(candidate)} [${tags}]`);
    }
    if (remaining.size > 0) lines.push("    (chosen value not on this list)");
  };

  section(
    "provider",
    candidates.filter((c) => c.kind === "organisation"),
    (c) => c.value,
    fields.provider === undefined ? [] : [fields.provider],
    (c, chosen) => narrows(c.value, chosen),
  );
  section(
    "reference",
    candidates.filter((c) => c.kind === "identifier"),
    (c) => c.value,
    fields.reference === undefined ? [] : [fields.reference],
    (c, chosen) => narrows(c.value, chosen),
  );
  section(
    "subtype",
    subtypeSources(candidates),
    (c) => c.value,
    fields.subtype === undefined ? [] : [fields.subtype],
    (c, chosen) => narrows(c.value, chosen),
  );
  section(
    "cost",
    candidates.filter((c) => c.kind === "amount"),
    amountDisplay,
    fields.costMinor === undefined || fields.currency === undefined
      ? []
      : [`${fields.costMinor} ${fields.currency}`],
    (c, chosen) => `${c.value} ${c.currency ?? ""}` === chosen,
  );
  section(
    "dates",
    candidates.filter((c) => c.kind === "date"),
    (c) => c.value,
    fields.dates,
    (c, chosen) => c.value === chosen,
  );

  return lines;
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
  fields?: ExtractedFields;
  candidates?: TaggedCandidate[];
  problem?: string;
}

const COLUMNS = ["file", "provider", "reference", "subtype", "cost", "dates", "schedule", "recurrence", "text characters", "problem"];

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
  if (row.fields !== undefined && row.candidates !== undefined) {
    lines.push(...candidateLines(row.fields, row.candidates));
  }
  return lines.join("\n");
}

function csv(rows: Row[]): string {
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const header = [...COLUMNS, "right? (fill in)"].map(quote).join(",");
  return [header, ...rows.map((row) => [...cells(row), ""].map(quote).join(","))].join("\r\n") + "\r\n";
}

async function main(): Promise<void> {
  const bundleDir = __dirname;
  const docsDir = resolve(option("--docs") ?? join(bundleDir, "docs"));
  const outDir = resolve(option("--out") ?? join(bundleDir, "out"));
  const keepText = process.argv.includes("--keep-text");
  const showCandidates = process.argv.includes("--candidates");
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
        if (keepText) writeFileSync(join(outDir, "text", `${basename(file)}.txt`), text);
        const { fields, candidates } = readFields(text);
        row.fields = fields;
        if (showCandidates) row.candidates = candidates;
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
  console.log(`\n${rows.length} documents read; results in ${outDir}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
