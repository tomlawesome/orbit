#!/usr/bin/env node
// ADR-0026 stage 2's measurement: for each expected answer in the corpus,
// find the sieve candidate that carries it and print the tags stage 2 gave
// it. A right candidate with a wrong tag is a stage 2 defect; a right tag
// that still loses is a stage 3 defect. Nothing here is a gate.
//
//   node node_modules/tsx/dist/cli.mjs src/server/documents/tag-accuracy-cli.ts [--verbose]

import { EXTRACTION_CORPUS, type CorpusDocument } from "./extraction-corpus";
import { classifyProvider, formatSubtypeExpected, subtypeCandidatePhrases } from "./extraction-scoring";
import { sieve, type CandidateKind } from "./extraction-sieve";
import type { TaggedCandidate } from "./extraction-stages";
import { tagCandidates } from "./extraction-tags";

const verbose = process.argv.includes("--verbose");

interface Row {
  field: string;
  doc: string;
  expected: string;
  /** Tags on every candidate whose value is the expected one. */
  tags: string[];
  /** Whether at least one of those candidates carries an acceptable tag. */
  ok: boolean;
}

const ACCEPTABLE: Record<string, readonly string[]> = {
  reference: ["reference", "policy", "account", "customer", "invoice", "certificate"],
  cost: ["total", "due"],
  provider: ["provider"],
  subtype: ["title"],
};

function tagsOf(candidates: TaggedCandidate[]): string[] {
  return candidates.flatMap((c) => c.tags.map((t) => `${t.value}${t.trigger ? `<${t.trigger}>` : ""}`));
}

function rows(doc: CorpusDocument): Row[] {
  const tagged = tagCandidates(doc.text, sieve(doc.text));
  const ofKind = (kind: CandidateKind) => tagged.filter((c) => c.kind === kind);
  const out: Row[] = [];
  const { expected } = doc;

  for (const label of expected.dateRoles ?? []) {
    const matching = ofKind("date").filter((c) => c.value === label.date);
    const tags = tagsOf(matching);
    out.push({ field: "dateRoles", doc: doc.filename, expected: `${label.date} ${label.role}`, tags, ok: matching.some((c) => c.tags.some((t) => t.value === label.role)) });
  }
  const scalar = (field: string, kind: CandidateKind, wanted: string | undefined, same: (c: TaggedCandidate) => boolean) => {
    if (wanted === undefined) return;
    const matching = ofKind(kind).filter(same);
    const tags = tagsOf(matching);
    out.push({ field, doc: doc.filename, expected: wanted, tags, ok: matching.some((c) => c.tags.some((t) => ACCEPTABLE[field].includes(t.value))) });
  };
  scalar("reference", "identifier", expected.reference, (c) => c.value.replace(/\s+/gu, "").toUpperCase() === (expected.reference ?? "").replace(/\s+/gu, "").toUpperCase());
  scalar("cost", "amount", expected.costMinor === undefined ? undefined : String(expected.costMinor), (c) => c.value === String(expected.costMinor) && c.currency === expected.currency);
  scalar("provider", "organisation", expected.provider, (c) => classifyProvider(expected.provider as string, c.value) === "correct");
  const subtypeCandidates = expected.subtype === undefined ? [] : subtypeCandidatePhrases(expected.subtype);
  scalar(
    "subtype",
    "heading",
    expected.subtype === undefined ? undefined : formatSubtypeExpected(expected.subtype),
    (c) => subtypeCandidates.some((wanted) => c.value.toLowerCase().includes(wanted.toLowerCase())),
  );
  return out;
}

function main(): void {
  const all = EXTRACTION_CORPUS.flatMap(rows);
  console.log(`tag accuracy over ${EXTRACTION_CORPUS.length} documents: does the right candidate carry an acceptable tag?\n`);
  for (const field of ["dateRoles", "reference", "cost", "provider", "subtype"]) {
    const of = all.filter((r) => r.field === field);
    const ok = of.filter((r) => r.ok).length;
    console.log(`${field.padEnd(10)} ${ok}/${of.length}`);
  }
  const shown = verbose ? all : all.filter((r) => !r.ok);
  console.log(`\n${verbose ? "all" : "misses"}:`);
  for (const r of shown) console.log(`  ${r.field}: ${r.doc}: ${r.expected} -> [${[...new Set(r.tags)].join(", ")}]`);
}

main();
