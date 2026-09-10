// Private local evaluation harness (issue #938).
//
// This scores Orbit's extraction against the OWNER'S OWN real paperwork,
// which must never leave their machine: never sent anywhere, never pasted
// into a session, never committed. The directory of documents lives outside
// this repository, given by the operator on the command line, and this
// module refuses to run against anything inside the repository (see
// `resolveEvalDirectory`).
//
// The privacy invariant this file exists to hold: every value this module
// returns or lets the CLI print is either a fixed, static string or a
// COUNT / PERCENTAGE derived from document content. Document text, the
// values matched out of it, and the file names the operator chose are never
// read into an Error message, a log call, or the returned report. Documents
// are addressed internally only as `document-1`, `document-2`, ... — real
// file stems never reach `proposalFromText` or any output. There is no log
// call in this module at all: the CLI's own `console.log`/`console.error`
// are the only place anything is written, and only the fixed strings and
// numbers described above ever reach them.
//
// This is a different thing from the synthetic hold-out corpus ADR-0025
// section 6 gates the model path on: that corpus is invented, committable,
// and CI can run it. This harness is the opposite — real, local-only,
// nothing here is ever shared. It CONSUMES `extraction-scoring.ts`'s
// `scoreCorpus` for the headline number rather than reimplementing it, so
// every corpus (tuning, hold-out, private) is measured by the same rule;
// it does not touch that file.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CorpusDocument, CorpusExpectation } from "../extraction-corpus";
import { type CorpusExtractor, type ExtractedFields, scoreCorpus } from "../extraction-scoring";
import { proposalFromText } from "../suggestions";

/**
 * Every refusal this module raises. The message is always a fixed string
 * chosen from code, never built from document content, a ground-truth
 * value, or a file name found inside the operator's directory — so
 * printing `.message` can never leak anything (proven by the "no document
 * text or identifying detail" test).
 */
export class PrivateEvalRefusal extends Error {
  readonly reason:
    | "missing_path"
    | "not_found"
    | "inside_repository"
    | "repo_root_not_found"
    | "unmatched_files"
    | "empty_directory"
    | "invalid_ground_truth";

  constructor(reason: PrivateEvalRefusal["reason"], message: string) {
    super(message);
    this.name = "PrivateEvalRefusal";
    this.reason = reason;
  }
}

/** Walk upward from `startDir` to the nearest directory that is a repo root. */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let depth = 0; depth < 32; depth += 1) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, ".git"))) {
      return realpathSync(dir);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new PrivateEvalRefusal("repo_root_not_found", "Could not locate the Orbit repository root; refusing to run.");
}

function isWithin(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Resolve the operator's directory to a real, on-disk absolute path, and
 * refuse it outright if it is the repository or lives anywhere inside it.
 * Symlinks are resolved before the check on both sides, so a symlink
 * planted on either side of the boundary cannot be used to cross it.
 *
 * `repoRootOverride` exists only for tests, which run from a real checkout
 * and need to point this at a scratch root instead of Orbit itself.
 */
export function resolveEvalDirectory(inputPath: string, repoRootOverride?: string): string {
  if (!inputPath || inputPath.trim() === "") {
    throw new PrivateEvalRefusal("missing_path", "No directory was given.");
  }
  const repoRoot = repoRootOverride ?? findRepoRoot(dirname(fileURLToPath(import.meta.url)));
  const absolute = resolve(process.cwd(), inputPath);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new PrivateEvalRefusal("not_found", "The given path does not exist or is not a directory.");
  }
  const real = realpathSync(absolute);
  if (isWithin(repoRoot, real)) {
    throw new PrivateEvalRefusal(
      "inside_repository",
      "Refusing: that directory is inside the Orbit repository. Real paperwork must live outside the repo, never committed.",
    );
  }
  return real;
}

function isIsoCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Parse and validate one ground-truth file's already-read text. Never
 * echoes the offending content back in an error: a malformed file gets the
 * same fixed message as every other one. */
function parseGroundTruth(raw: string): CorpusExpectation {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new PrivateEvalRefusal("invalid_ground_truth", "A ground-truth file is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PrivateEvalRefusal("invalid_ground_truth", "A ground-truth file must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  const rawDates = record.dates ?? [];
  if (!Array.isArray(rawDates) || !rawDates.every(isIsoCalendarDate)) {
    throw new PrivateEvalRefusal(
      "invalid_ground_truth",
      'A ground-truth file\'s "dates" must be an array of YYYY-MM-DD strings.',
    );
  }
  for (const key of ["provider", "reference"] as const) {
    if (record[key] !== undefined && typeof record[key] !== "string") {
      throw new PrivateEvalRefusal("invalid_ground_truth", `A ground-truth file's "${key}" must be a string.`);
    }
  }
  return {
    dates: [...rawDates],
    provider: record.provider as string | undefined,
    reference: record.reference as string | undefined,
  };
}

/**
 * Load the operator's directory: every document is a `<stem>.txt` (the
 * text layer, exactly what the parser would emit) paired with a
 * `<stem>.json` ground truth in the `CorpusExpectation` shape. Real stems
 * never leave this function — every document is relabelled `document-N`
 * before anything else touches it, so a real file name can never reach the
 * extractor, an error message, or the report.
 */
function loadPrivateCorpus(directory: string): CorpusDocument[] {
  const entries = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile());
  const stems = new Map<string, { text: boolean; truth: boolean }>();
  for (const entry of entries) {
    if (entry.name.endsWith(".txt")) {
      const stem = entry.name.slice(0, -".txt".length);
      stems.set(stem, { text: true, truth: stems.get(stem)?.truth ?? false });
    } else if (entry.name.endsWith(".json")) {
      const stem = entry.name.slice(0, -".json".length);
      stems.set(stem, { text: stems.get(stem)?.text ?? false, truth: true });
    }
  }
  const unmatched = [...stems.values()].filter((pair) => pair.text !== pair.truth).length;
  if (unmatched > 0) {
    throw new PrivateEvalRefusal(
      "unmatched_files",
      `${unmatched} file(s) have no matching pair (every ".txt" needs a same-named ".json" and vice versa). Fix the directory and rerun.`,
    );
  }
  const stemList = [...stems.keys()];
  if (stemList.length === 0) {
    throw new PrivateEvalRefusal("empty_directory", "No document/ground-truth pairs were found in that directory.");
  }
  return stemList.map((stem, index) => {
    const text = readFileSync(join(directory, `${stem}.txt`), "utf8");
    const expected = parseGroundTruth(readFileSync(join(directory, `${stem}.json`), "utf8"));
    const label = `document-${index + 1}`;
    return { name: label, filename: `${label}.txt`, text, expected };
  });
}

export interface FieldTally {
  earned: number;
  possible: number;
}

export interface PrivateEvalReport {
  documentCount: number;
  overall: { earned: number; possible: number; accuracy: number };
  fields: {
    dates: FieldTally;
    provider: FieldTally;
    reference: FieldTally;
  };
}

/** Same per-field rule `extraction-scoring.ts`'s (unexported) per-document
 * scorer applies, broken out by field instead of summed, so the report can
 * show "per field and overall" as the issue asks. Only counts are kept —
 * never the expected value, the extracted value, or which document they
 * came from. */
async function tallyFields(
  documents: readonly CorpusDocument[],
  extractor: CorpusExtractor,
): Promise<PrivateEvalReport["fields"]> {
  const dates: FieldTally = { earned: 0, possible: 0 };
  const provider: FieldTally = { earned: 0, possible: 0 };
  const reference: FieldTally = { earned: 0, possible: 0 };
  for (const document of documents) {
    const extracted: ExtractedFields = await extractor(document.text, document.filename);
    const { expected } = document;
    for (const date of expected.dates) {
      dates.possible += 1;
      if (extracted.dates.includes(date)) dates.earned += 1;
    }
    if (expected.dates.length === 0) {
      dates.possible += 1;
      if (extracted.dates.length === 0) dates.earned += 1;
    }
    if (expected.provider !== undefined) {
      provider.possible += 1;
      if (extracted.provider === expected.provider) provider.earned += 1;
    }
    if (expected.reference !== undefined) {
      reference.possible += 1;
      if (extracted.reference === expected.reference) reference.earned += 1;
    }
  }
  return { dates, provider, reference };
}

export interface PrivateEvalOptions {
  /** Defaults to the production heuristic, `proposalFromText`. */
  extractor?: CorpusExtractor;
  /** Test-only: overrides the detected repository root. */
  repoRootOverride?: string;
}

/**
 * Run the private evaluation. Throws `PrivateEvalRefusal` for every
 * expected failure (bad path, path inside the repo, malformed directory);
 * anything else is a genuine bug and is left to propagate rather than
 * risk laundering document content through a caught error's message.
 */
export async function runPrivateEvaluation(
  inputPath: string,
  options: PrivateEvalOptions = {},
): Promise<PrivateEvalReport> {
  const directory = resolveEvalDirectory(inputPath, options.repoRootOverride);
  const documents = loadPrivateCorpus(directory);
  const extractor: CorpusExtractor = options.extractor ?? ((text, filename) => proposalFromText(text, filename));
  const overallRun = await scoreCorpus(documents, extractor);
  const fields = await tallyFields(documents, extractor);
  return {
    documentCount: documents.length,
    overall: { earned: overallRun.earned, possible: overallRun.possible, accuracy: overallRun.accuracy },
    fields,
  };
}

function formatField(label: string, tally: FieldTally): string {
  const pct = tally.possible === 0 ? "n/a" : `${((tally.earned / tally.possible) * 100).toFixed(1)}%`;
  return `  ${label}: ${pct} (${tally.earned}/${tally.possible})`;
}

/** Renders only counts and percentages: no document text, matched value,
 * or file name is ever a candidate for this string. */
export function formatReport(report: PrivateEvalReport): string {
  return [
    `Private evaluation: ${report.documentCount} document(s)`,
    formatField("dates    ", report.fields.dates),
    formatField("provider ", report.fields.provider),
    formatField("reference", report.fields.reference),
    `  overall  : ${(report.overall.accuracy * 100).toFixed(1)}% (${report.overall.earned}/${report.overall.possible})`,
  ].join("\n");
}
