#!/usr/bin/env node
// The recall experiment behind ADR-0026 (#989): is every expected answer
// among the candidates the sieve collects, and how many candidates does it
// collect to get there?
//
//   node node_modules/tsx/dist/cli.mjs src/server/documents/sieve-recall-cli.ts
//
// This is a measurement, not a gate: there is no floor (owner, 2026-09-11).
// A miss is printed with the value so the sieve can be widened; a candidate
// count is printed so the later stages know the size of the shortlist they
// will be choosing from.

import { EXTRACTION_CORPUS, type CorpusDocument } from "./extraction-corpus";
import { classifyProvider, classifySubtype, formatSubtypeExpected } from "./extraction-scoring";
import { sieve, type Candidate, type CandidateKind } from "./extraction-sieve";

interface Tally {
  expected: number;
  found: number;
  candidates: number;
  /** Candidates with repeated values counted once: the shortlist a chooser
   * would actually see. */
  distinct: number;
  misses: string[];
}

const KIND_BY_FIELD: Record<string, CandidateKind> = {
  dates: "date",
  cost: "amount",
  reference: "identifier",
  provider: "organisation",
  subtype: "heading",
};

function tally(): Record<string, Tally> {
  const totals: Record<string, Tally> = {};
  for (const field of Object.keys(KIND_BY_FIELD)) {
    totals[field] = { expected: 0, found: 0, candidates: 0, distinct: 0, misses: [] };
  }
  return totals;
}

function record(totals: Record<string, Tally>, field: string, doc: CorpusDocument, hit: boolean, value: string): void {
  totals[field].expected += 1;
  if (hit) totals[field].found += 1;
  else totals[field].misses.push(`${doc.filename}: ${value}`);
}

function measure(doc: CorpusDocument, totals: Record<string, Tally>): void {
  const candidates = sieve(doc.text);
  const ofKind = (kind: CandidateKind): Candidate[] => candidates.filter((c) => c.kind === kind);
  for (const [field, kind] of Object.entries(KIND_BY_FIELD)) {
    const found = ofKind(kind);
    totals[field].candidates += found.length;
    totals[field].distinct += new Set(found.map((c) => `${c.value.toLowerCase()}|${c.currency ?? ""}`)).size;
  }

  const { expected } = doc;
  for (const date of expected.dates) {
    record(totals, "dates", doc, ofKind("date").some((c) => c.value === date), date);
  }
  if (expected.provider !== undefined) {
    const hit = ofKind("organisation").some((c) => classifyProvider(expected.provider as string, c.value) === "correct");
    record(totals, "provider", doc, hit, expected.provider);
  }
  if (expected.reference !== undefined) {
    const wanted = expected.reference.replace(/\s+/gu, "").toUpperCase();
    const hit = ofKind("identifier").some((c) => c.value.replace(/\s+/gu, "").toUpperCase() === wanted);
    record(totals, "reference", doc, hit, expected.reference);
  }
  if (expected.subtype !== undefined) {
    const wanted = Array.isArray(expected.subtype) ? expected.subtype : [expected.subtype];
    const hit = ofKind("heading").some(
      (c) => classifySubtype(expected.subtype as string | string[], c.value) === "correct"
        || wanted.some((w) => c.value.toLowerCase().includes(w.toLowerCase())),
    );
    record(totals, "subtype", doc, hit, formatSubtypeExpected(expected.subtype));
  }
  if (expected.costMinor !== undefined) {
    const hit = ofKind("amount").some(
      (c) => c.value === String(expected.costMinor) && (expected.currency === undefined || c.currency === expected.currency),
    );
    record(totals, "cost", doc, hit, `${expected.costMinor} ${expected.currency ?? ""}`);
  }
}

function main(): void {
  const totals = tally();
  for (const doc of EXTRACTION_CORPUS) measure(doc, totals);
  const docs = EXTRACTION_CORPUS.length;
  console.log(`sieve recall over ${docs} documents (no floor; a miss is a sieve to widen)\n`);
  console.log("field       recall        candidates/doc  distinct/doc");
  for (const [field, t] of Object.entries(totals)) {
    const pct = t.expected === 0 ? "n/a" : `${((100 * t.found) / t.expected).toFixed(1)}%`;
    console.log(
      `${field.padEnd(11)} ${`${t.found}/${t.expected}`.padEnd(7)} ${pct.padEnd(6)} ${(t.candidates / docs).toFixed(1).padEnd(15)} ${(t.distinct / docs).toFixed(1)}`,
    );
  }
  const misses = Object.entries(totals).flatMap(([field, t]) => t.misses.map((m) => `  ${field}: ${m}`));
  if (misses.length) console.log(`\nmisses:\n${misses.join("\n")}`);
}

main();
