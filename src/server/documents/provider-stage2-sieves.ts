// Provider's own stage 2 (#996): scores every organisation candidate stage 1
// found, against the five rules in docs/experiments/provider-stage2-rules.md
// (R1-R5). Nothing here removes a candidate -- every rule is a vote, for or
// against, and stage 3 (`chooseProvider`) only sums the votes.
//
// Shares nothing with the other fields' stage 2 files (owner, 2026-09-12):
// every field owns its own copy of every stage. This file imports only
// `Candidate`/`pageBlocks` from the shared sieve.
//
// Weights below were tuned only against `npm run eval:provider-stage2` over
// the 24-document tuning corpus, never against the hold-out (rules doc,
// "What 'trained to the set' would look like"). Final weights:
//   R1  -3 flat
//   R2  +2 * (blocks / the page's highest block count, after R4 transfers)
//   R3a +2 per preceding principal cue, capped at +4
//   R3b -2 per preceding backer cue, capped at -4; a flat further -3 when
//       the name itself is an overseer (ombudsman, regulator, registrar...)
//   R4  0 of its own -- it folds the alias's blocks into the full name's R2
//       count, and R2's own vote already carries the effect
//   R5  +1 each for a nearby address, a contact block, or a shared web/e-mail
//       host, capped at +2

import { pageBlocks, type Candidate } from "./extraction-sieve";

export interface ProviderVote {
  rule: "R1" | "R2" | "R3a" | "R3b" | "R4" | "R5";
  /** Negative means the vote is against the candidate being the provider. */
  weight: number;
  trigger: string;
}

export interface ProviderReading {
  name: string;
  key: string;
  printings: number;
  blocks: number;
  votes: ProviderVote[];
  score: number;
}

type Block = { index: number; line: string };

// ---------------------------------------------------------------------------
// Grouping: every printing of what is plausibly the same organisation is
// folded under one normalised key, so the rules below judge one reading per
// name rather than once per spelling variant.

const LEADING_JOINERS = new Set(["of", "the", "and", "for", "to", "by", "with", "from", "a", "an"]);
const LEGAL_FORMS = new Set(["ltd", "limited", "plc", "llp", "cic", "llc", "inc"]);

/** lowercase, whitespace collapsed, a leading joiner and a trailing legal
 * form stripped, trailing punctuation dropped. */
function normaliseKey(raw: string): string {
  const cleaned = raw.replace(/\s+/gu, " ").trim().replace(/[.,;:]+$/gu, "");
  const words = cleaned.toLowerCase().split(" ").filter(Boolean);
  while (words.length > 1 && LEADING_JOINERS.has(words[0] ?? "")) words.shift();
  while (words.length > 1) {
    const last = (words[words.length - 1] ?? "").replace(/\.$/u, "");
    if (!LEGAL_FORMS.has(last)) break;
    words.pop();
  }
  return words.join(" ");
}

interface Group {
  key: string;
  printingCounts: Map<string, number>;
  occurrences: Candidate[];
}

function buildGroups(candidates: readonly Candidate[]): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const candidate of candidates) {
    if (candidate.kind !== "organisation") continue;
    const key = normaliseKey(candidate.value);
    if (!key) continue;
    let group = groups.get(key);
    if (group === undefined) {
      group = { key, printingCounts: new Map(), occurrences: [] };
      groups.set(key, group);
    }
    group.occurrences.push(candidate);
    group.printingCounts.set(candidate.value, (group.printingCounts.get(candidate.value) ?? 0) + 1);
  }
  return groups;
}

/** The name as most often printed; the longest printing breaks a tie. */
function representativeName(group: Group): string {
  let best: string | undefined;
  let bestCount = -1;
  for (const [printing, count] of group.printingCounts) {
    if (count > bestCount || (count === bestCount && printing.length > (best?.length ?? 0))) {
      best = printing;
      bestCount = count;
    }
  }
  return best ?? group.key;
}

function words(name: string): string[] {
  return name.toLowerCase().replace(/[^a-z0-9\s]/gu, "").split(/\s+/u).filter(Boolean);
}

function lastWord(name: string): string {
  const parts = words(name);
  return parts[parts.length - 1] ?? "";
}

// ---------------------------------------------------------------------------
// R1: looks like an organisation (against, strong). A property of the name's
// words alone, true on any page -- never keyed on where the name sits.

const DOCUMENT_LABEL_WORDS = new Set([
  "statement", "date", "account", "policy", "number", "reference", "direct", "debit", "po", "box",
  "minimum", "term", "form", "page", "total", "amount", "plan", "invoice", "certificate", "document",
  "summary", "appendix", "section",
]);
const STREET_SUFFIXES = new Set([
  "lane", "road", "street", "terrace", "yard", "court", "avenue", "close", "drive", "way", "house",
]);
const PERSON_TITLES = new Set(["mr", "mrs", "ms", "miss", "dr", "dear"]);
// A name ending in a street suffix is still an organisation if one of its
// other words says so -- a company form, trade word or membership role.
const COMPANY_WORDS = new Set([
  "ltd", "limited", "plc", "llp", "cic", "llc", "inc", "council", "authority", "insurance", "assurance",
  "society", "bank", "group", "trust", "services", "association", "club", "water", "energy", "gas",
  "practice", "company", "partners", "partnership", "solutions", "finance", "financial", "health",
  "healthcare", "fitness", "leisure", "agency", "office", "foundation", "surgery", "school",
  "university", "scheme",
]);
const CODE_PREFIX = /[A-Z]{2,}-$/u;

function isLetterSpaced(name: string): boolean {
  let run = 0;
  for (const word of name.split(/\s+/u)) {
    const bare = word.replace(/[^A-Za-z]/gu, "");
    if (bare.length === 1) {
      run += 1;
      if (run >= 3) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

function r1Vote(name: string): ProviderVote[] {
  const ws = words(name);
  if (ws.length > 0 && ws.every((word) => DOCUMENT_LABEL_WORDS.has(word))) {
    return [{ rule: "R1", weight: -3, trigger: "every word is a document label" }];
  }
  if (CODE_PREFIX.test(name.trim())) {
    return [{ rule: "R1", weight: -3, trigger: "ends in a reference code prefix" }];
  }
  if (isLetterSpaced(name)) {
    return [{ rule: "R1", weight: -3, trigger: "letter-spaced text" }];
  }
  const first = ws[0];
  if (first !== undefined && PERSON_TITLES.has(first)) {
    return [{ rule: "R1", weight: -3, trigger: "starts with a person's title" }];
  }
  const last = ws[ws.length - 1];
  if (last !== undefined && STREET_SUFFIXES.has(last) && !ws.some((word) => COMPANY_WORDS.has(word))) {
    return [{ rule: "R1", weight: -3, trigger: "ends in a street suffix, no company word" }];
  }
  return [];
}

// ---------------------------------------------------------------------------
// R2: printed throughout (for, proportional). Weight rises with how many
// distinct blocks carry the name, relative to the page's highest count --
// computed after R4 has folded any role alias's blocks in.

function r2Vote(blocks: number, maxBlocks: number): ProviderVote[] {
  if (blocks <= 0 || maxBlocks <= 0) return [];
  const weight = 2 * (blocks / maxBlocks);
  return [{ rule: "R2", weight, trigger: `printed in ${blocks} block(s), the page's highest is ${maxBlocks}` }];
}

// ---------------------------------------------------------------------------
// R3a / R3b: what the page says immediately before the name assigns it a
// role -- principal (for) or backer (against). A phrase property, not a
// position: it is read off the block text the candidate was found in.

const R3A_CUES = [
  "from", "issued by", "provided by", "administered by", "arranged by", "managed by",
  "welcome to", "thank you for choosing",
  "your supplier", "your provider", "your insurer", "your lender", "your landlord",
];
const R3B_CUES = [
  "underwritten by", "a trading name of", "authorised and regulated by", "authorised by",
  "regulated by", "registered with", "a member of", "complain to", "refer to",
];
const OVERSEER_PATTERNS = [
  /ombudsman/iu, /compensation scheme/iu, /conduct authority/iu, /regulation authority/iu,
  /information commissioner/iu, /registrar/iu,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Cues from `cues` whose phrase sits immediately before `name`'s printing
 * within `line`, allowing a little punctuation or space between them. */
function cuesBefore(line: string, name: string, cues: string[]): string[] {
  const idx = line.toLowerCase().indexOf(name.toLowerCase());
  if (idx < 0) return [];
  const before = line.slice(0, idx).toLowerCase();
  const found: string[] = [];
  for (const cue of cues) {
    const pattern = new RegExp(`${escapeRegExp(cue)}\\s*[:,-]?\\s*$`, "u");
    if (pattern.test(before)) found.push(cue);
  }
  return found;
}

function r3aVotes(group: Group): ProviderVote[] {
  const found: string[] = [];
  for (const occurrence of group.occurrences) found.push(...cuesBefore(occurrence.line, occurrence.value, R3A_CUES));
  if (found.length === 0) return [];
  const weight = Math.min(found.length * 2, 4);
  return [{ rule: "R3a", weight, trigger: `stated as principal (${[...new Set(found)].join(", ")})` }];
}

function r3bVotes(name: string, group: Group): ProviderVote[] {
  const votes: ProviderVote[] = [];
  const found: string[] = [];
  for (const occurrence of group.occurrences) found.push(...cuesBefore(occurrence.line, occurrence.value, R3B_CUES));
  if (found.length > 0) {
    const weight = Math.max(found.length * -2, -4);
    votes.push({ rule: "R3b", weight, trigger: `stated as backer (${[...new Set(found)].join(", ")})` });
  }
  const overseer = OVERSEER_PATTERNS.find((pattern) => pattern.test(name));
  if (overseer !== undefined) {
    votes.push({ rule: "R3b", weight: -3, trigger: `name itself is an overseer (matches ${overseer.source})` });
  }
  return votes;
}

// ---------------------------------------------------------------------------
// R4: known by its role (for, transfers R2 weight). A page that keeps saying
// "the Club"/"the Council"/etc is naming one party by its role; those
// mentions count as printings of whichever full name ends in that word (the
// one already printed most, if several do).

const R4_ROLE_WORDS = [
  "club", "council", "authority", "practice", "scheme", "company", "society", "bank",
  "trust", "association", "agency", "group", "surgery", "school", "university",
];

interface AliasTransfer { lines: Set<string>; word: string }

function roleAliasTransfers(
  blocks: readonly Block[],
  groups: Map<string, Group>,
  names: Map<string, string>,
): Map<string, AliasTransfer> {
  const result = new Map<string, AliasTransfer>();
  for (const word of R4_ROLE_WORDS) {
    const phrase = new RegExp(`\\bthe\\s+${word}\\b`, "iu");
    const aliasLines = new Set<string>();
    for (const block of blocks) if (phrase.test(block.line)) aliasLines.add(block.line);
    if (aliasLines.size === 0) continue;

    // A candidate whose whole name (after the leading joiner is stripped) IS
    // the role word is the role phrase itself, not "a full name that ends in
    // it" -- exclude it so the alias cannot fold its own mentions into
    // itself instead of the name it is short for.
    const matches = [...groups.entries()].filter(([key]) => key !== word && lastWord(names.get(key) ?? "") === word);
    if (matches.length === 0) continue;
    matches.sort(([keyA, groupA], [keyB, groupB]) => {
      const linesA = new Set(groupA.occurrences.map((o) => o.line)).size;
      const linesB = new Set(groupB.occurrences.map((o) => o.line)).size;
      return linesB - linesA || keyA.localeCompare(keyB);
    });
    const winnerKey = matches[0]?.[0];
    if (winnerKey === undefined) continue;
    const existing = result.get(winnerKey);
    const combined = existing === undefined ? aliasLines : new Set([...existing.lines, ...aliasLines]);
    result.set(winnerKey, { lines: combined, word });
  }
  return result;
}

// ---------------------------------------------------------------------------
// R5: owns an address, gives contact details, or matches a web host (for,
// weak). The sender tells the household how to reach it; kept weak because a
// regulator's address is printed too.

const POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/u;
const PHONE = /(?:\+44[\s.-]?\d[\d\s.-]{7,}|\b0\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b)/u;
const EMAIL = /[A-Za-z0-9._%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u;
const CONTACT_PHRASE = /contact us/iu;

const HOST_PATTERN = /(?:[A-Za-z0-9._%-]+@|https?:\/\/|\bwww\.)([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/gu;
const DOMAIN_TAILS = [".co.uk", ".org.uk", ".ac.uk", ".gov.uk", ".com", ".co", ".org", ".net", ".uk", ".io"];

function hostLabel(host: string): string {
  const lower = host.toLowerCase().replace(/^www\./u, "");
  const tail = DOMAIN_TAILS.find((suffix) => lower.endsWith(suffix));
  return (tail === undefined ? lower : lower.slice(0, -tail.length)).split(".").pop() ?? "";
}

/** Every word (3+ letters) any e-mail or web host on the page is built from. */
function hostWords(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(HOST_PATTERN)) {
    for (const part of hostLabel(match[1] ?? "").split("-")) {
      if (part.length >= 3) found.add(part);
    }
  }
  return found;
}

function nameSharesHost(name: string, hosts: Set<string>): boolean {
  const ws = words(name);
  if (ws.some((word) => word.length >= 4 && hosts.has(word))) return true;
  const initials = ws.map((word) => word[0]).join("");
  return initials.length >= 2 && hosts.has(initials);
}

function r5Votes(group: Group, blocks: readonly Block[], hosts: Set<string>, name: string): ProviderVote[] {
  let address = false;
  let contact = false;
  for (const occurrence of group.occurrences) {
    if (PHONE.test(occurrence.line) || EMAIL.test(occurrence.line) || CONTACT_PHRASE.test(occurrence.line)) {
      contact = true;
    }
    const at = blocks.findIndex((block) => block.line === occurrence.line);
    if (at < 0) continue;
    const window = blocks.slice(at, at + 4).map((block) => block.line).join(" ");
    if (POSTCODE.test(window)) address = true;
  }
  const host = nameSharesHost(name, hosts);
  const triggers: string[] = [];
  if (address) triggers.push("address");
  if (contact) triggers.push("contact");
  if (host) triggers.push("host");
  if (triggers.length === 0) return [];
  return [{ rule: "R5", weight: Math.min(triggers.length, 2), trigger: triggers.join("+") }];
}

// ---------------------------------------------------------------------------

/**
 * Every organisation candidate, grouped by name and scored by R1-R5.
 *
 * Pure: the same text and candidates always give the same readings.
 */
export function readProviders(text: string, candidates: readonly Candidate[]): ProviderReading[] {
  const blocks = pageBlocks(text);
  const groups = buildGroups(candidates);
  if (groups.size === 0) return [];

  const names = new Map<string, string>();
  for (const [key, group] of groups) names.set(key, representativeName(group));

  const transfers = roleAliasTransfers(blocks, groups, names);
  const hosts = hostWords(text);

  const finalBlocks = new Map<string, number>();
  for (const [key, group] of groups) {
    const own = new Set(group.occurrences.map((o) => o.line));
    const alias = transfers.get(key);
    const combined = alias === undefined ? own : new Set([...own, ...alias.lines]);
    finalBlocks.set(key, combined.size);
  }
  const maxBlocks = Math.max(0, ...finalBlocks.values());

  const readings: ProviderReading[] = [];
  for (const [key, group] of groups) {
    const name = names.get(key) ?? key;
    const votes: ProviderVote[] = [
      ...r1Vote(name),
      ...r2Vote(finalBlocks.get(key) ?? 0, maxBlocks),
      ...r3aVotes(group),
      ...r3bVotes(name, group),
      ...r5Votes(group, blocks, hosts, name),
    ];
    const alias = transfers.get(key);
    if (alias !== undefined) {
      votes.push({
        rule: "R4",
        weight: 0,
        trigger: `"the ${alias.word}" folds ${alias.lines.size} block(s) into R2`,
      });
    }
    const score = votes.reduce((sum, vote) => sum + vote.weight, 0);
    readings.push({ name, key, printings: group.occurrences.length, blocks: finalBlocks.get(key) ?? 0, votes, score });
  }
  return readings.sort((a, b) => b.score - a.score);
}

/**
 * The reading with the highest score, or `undefined` if the top two tie --
 * a tie is not a choice, and nothing here breaks it by guessing.
 */
export function chooseProvider(text: string, candidates: readonly Candidate[]): string | undefined {
  const readings = readProviders(text, candidates);
  const top = readings[0];
  if (top === undefined) return undefined;
  const second = readings[1];
  if (second !== undefined && second.score === top.score) return undefined;
  return top.name;
}
