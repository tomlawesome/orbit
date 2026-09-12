// Provider's own stage 1 (#996). Nothing else reads it, and it reads nothing
// belonging to another field: every field owns its own copy of every stage
// (owner, 2026-09-12), so making this greedier cannot move subtype, dates or
// cost by a single candidate.
//
// Why provider needed its own. The shared sieve only cuts a name out where
// it ends in a word from a fixed list of trades and company forms -- Ltd,
// Council, Insurance, Water, Finance and about forty more. That list can
// never be finished. A nursery, a lettings agent and an alarm company are all
// missing from it, and on the twelve unseen pages the right provider was
// never cut out at all on three of them, while the answer offered instead was
// page furniture: "Monitoring", "Report Reference Number", "Assured Shorthold
// Tenancy Agreement".
//
// So this one does not ask what trade a name is in. It cuts every run of
// capitalised words on the page, wherever it sits, and lets the later stages
// throw away what is not a company. Stage 1 is judged on recall alone: losing
// the right name is fatal, keeping fifty wrong ones is cheap.
//
// Six ways of looking, each independent, all of them kept, none of them
// caring about case (owner, 2026-09-12):
//
//   company form      a name ending in a company form or a trade word, the
//                     shared sieve's rule, kept because it finds names inside
//                     a sentence that the capitalised-run rule would cut
//                     short.
//   named in prose    "by Kestrel Broadband", "from Milldown Motoring Club":
//                     the words that follow say who the page is about.
//   capitalised run   any two to eight consecutive capitalised words. This is
//                     the one that finds the names no vocabulary covers, and
//                     the one that produces most of the noise.
//   short line        a line of up to six words with no sentence punctuation:
//                     a heading, masthead, footer or signature, in any case.
//   lone brand        a single word with a digit in it, joined by a dot or a
//                     hyphen, or set in capitals: the shapes one-word brands
//                     take.
//   address           the host half of an e-mail address or a web address,
//                     which is the organisation's name far more often than
//                     not, even where it is one word.
//
// `pageBlocks` is imported rather than copied: splitting Tika's output into
// blocks is reading the page, the same for every field, and is not a knob
// anyone would turn for provider alone.

import { pageBlocks, type Candidate } from "./extraction-sieve";

/**
 * Words that end a company's name or say what trade it is in. Provider's own
 * copy: the shared sieve has the same list today, and the two are free to
 * drift apart as each is tuned.
 */
const COMPANY_FORM_OR_TRADE =
  "Ltd|Ltd\\.|Limited|plc|PLC|Plc|LLP|CIC|Council|Authority|Insurance|Assurance|Society|Bank|Group|" +
  "Trust|Services|Association|Club|Water|Energy|Power|Gas|Practice|Administration|Administrators|" +
  "Company|Partners|Partnership|Solutions|Networks|Mobile|Broadband|Telecom|Warranty|Cover|Direct|" +
  "Mutual|Pensions|Dental|Motoring|Installations|Windows|Electrical|Solar|Finance|Financial|" +
  "Building Society|Health|Healthcare|Fitness|Leisure|Licensing|Agency|Office|Department|Foundation";

/** A word a name can be built from, in any case: a page prints the same
 * name as "Kestrel Broadband", "KESTREL BROADBAND" and "kestrel broadband"
 * and every one of them is the name (owner, 2026-09-12: capitalisation of
 * the first letter, of all letters, or of none is treated the same). */
const WORD = "[A-Za-z][A-Za-z0-9'’.-]*";
const JOINER = "(?:&|of|and|for|the|de)";
const NAME_WORD = `(?:${WORD}|${JOINER})`;
const CAPITALISED_WORD = "[A-Z][A-Za-z0-9'’.-]*";

/** A name ending in a company form or a trade word, built from capitalised
 * words: the shared sieve's rule. */
const BY_COMPANY_FORM = new RegExp(
  `\\b((?:(?:${CAPITALISED_WORD}|${JOINER})\\s+){0,7}(?:${COMPANY_FORM_OR_TRADE})(?:\\s+(?:${COMPANY_FORM_OR_TRADE}))*)(?![A-Za-z])`,
  "gu",
);

/** The same in any case. Lower-case words give no left edge, so a match
 * runs back to the line start, the last punctuation mark, or a word that
 * introduces a name, and every shorter tail of it is kept too: "Sent from
 * kestrel broadband ltd" yields that, "from kestrel broadband ltd",
 * "kestrel broadband ltd" and "broadband ltd". Which of them is the name is
 * stage 2's question; that the name is among them is this stage's job. */
const BY_COMPANY_FORM_ANY_CASE = new RegExp(
  `(?:^|[.,;:()|\\-–—]\\s*|\\b(?:by|from|with|to|of|at)\\s+)((?:${NAME_WORD}\\s+){0,4}(?:${COMPANY_FORM_OR_TRADE})(?:\\s+(?:${COMPANY_FORM_OR_TRADE}))*)(?![A-Za-z])`,
  "giu",
);

/** A name the page introduces in a sentence: up to four words after "by",
 * "from", "with", "to" or "of", stopping at punctuation. Case-blind, so it
 * also finds "from kestrel broadband" in a footer set in lower case; the
 * cost is that it finds "from the date of" too, which is stage 2's problem. */
const IN_PROSE = new RegExp(`\\b(?:by|from|with|to|of)\\s+(${WORD}(?:\\s+${NAME_WORD}){0,3})`, "giu");

/** Any run of capitalised words, whatever trade it is in and wherever on the
 * page it sits. Must begin and end on a capitalised word, so a run cannot
 * start on "of" or trail off on "and". Words set in capitals count. */
const CAPITALISED_RUN = new RegExp(
  `\\b(${CAPITALISED_WORD}(?:\\s+(?:${CAPITALISED_WORD}|${JOINER})){1,7})(?![A-Za-z])`,
  "gu",
);

/**
 * A short line on its own: a heading, a masthead, a footer, a signature. Up
 * to six words with no sentence punctuation inside, in any case at all --
 * the only way a name set entirely in lower case ("giffgaff") is found when
 * it is not in a sentence or an address.
 */
const SHORT_LINE = /^\s*([A-Za-z][A-Za-z0-9'’&.-]*(?:\s+[A-Za-z0-9'’&.-]+){0,5})\s*$/u;

/**
 * A name that is one word. A lone word is usually the start of a sentence,
 * but a great many household brands are one word, and a page prints them in
 * shapes a sentence's first word does not take: with a digit in it ("O2"),
 * joined by a dot or a hyphen ("E.ON", "Kwik-Fit"), or all in capitals
 * ("SKY", "EE"). The tuning pages have no one-word provider at all, which is
 * exactly why this rule was missing (hold-out 2, E42).
 */
const LONE_BRAND = /\b([A-Za-z][A-Za-z]*\d[A-Za-z0-9]*|[A-Za-z][A-Za-z]+(?:[.-][A-Za-z]+)+|[A-Z][A-Z0-9]+)(?![A-Za-z0-9])/gu;

/** The host half of an e-mail address or a web address, "www." and the
 * top-level domain dropped: `billing@foxglove-hosting.co.uk` is Foxglove
 * Hosting saying its own name. */
const ADDRESS_HOST = /(?:[A-Za-z0-9._%-]+@|https?:\/\/|\bwww\.)([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/gu;

/** The public-suffix-ish tails to drop off a host, longest first. */
const DOMAIN_TAILS = [".co.uk", ".org.uk", ".ac.uk", ".gov.uk", ".ltd.uk", ".plc.uk", ".com", ".co", ".org", ".net", ".uk", ".io"];

/** A host as a name: the label before the tail, hyphens read as spaces. */
function hostAsName(host: string): string | undefined {
  const lower = host.toLowerCase().replace(/^www\./u, "");
  const tail = DOMAIN_TAILS.find((suffix) => lower.endsWith(suffix));
  const label = (tail === undefined ? lower : lower.slice(0, -tail.length)).split(".").pop() ?? "";
  if (label.length < 3) return undefined;
  return label
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

/** Whether a run ends on a word that carries no meaning on its own, so the
 * run is a fragment rather than a name. */
const TRAILING_JOINER = /\s(?:of|and|for|the|de|&)$/iu;

/**
 * Every place on the page provider's later stages may look for a name.
 *
 * Recall only. Nothing here decides anything, nothing is ranked, and a
 * candidate appearing several times over is expected -- the word-run bins
 * downstream are built on exactly that repetition.
 *
 * Pure: the same text always gives the same candidates.
 */
export function providerCandidates(text: string): Candidate[] {
  const blocks = pageBlocks(text);
  const found: Candidate[] = [];
  const seen = new Set<string>();

  const push = (index: number, raw: string, line: string, loneWordAllowed = false): void => {
    let value = raw.replace(/\s+/gu, " ").trim();
    while (TRAILING_JOINER.test(value)) value = value.replace(TRAILING_JOINER, "");
    if (!loneWordAllowed && value.split(" ").length < 2) return;
    const key = `${index}:${value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ kind: "organisation", value, index, line });
  };

  for (const block of blocks) {
    for (const pattern of [BY_COMPANY_FORM, IN_PROSE, CAPITALISED_RUN]) {
      for (const match of block.line.matchAll(pattern)) {
        const at = block.index + (match.index ?? 0) + match[0].length - (match[1]?.length ?? 0);
        push(at, match[1] ?? "", block.line);
      }
    }
    for (const match of block.line.matchAll(BY_COMPANY_FORM_ANY_CASE)) {
      const words = (match[1] ?? "").split(/\s+/u);
      let at = block.index + (match.index ?? 0) + match[0].length - (match[1]?.length ?? 0);
      for (let drop = 0; drop < words.length - 1; drop += 1) {
        push(at, words.slice(drop).join(" "), block.line);
        at += (words[drop]?.length ?? 0) + 1;
      }
    }
    const shortLine = SHORT_LINE.exec(block.line);
    if (shortLine !== null) push(block.index, shortLine[1] ?? "", block.line, true);
    for (const match of block.line.matchAll(LONE_BRAND)) {
      push(block.index + (match.index ?? 0), match[1] ?? "", block.line, true);
    }
    // A host is a name in its own right, however many words it splits into.
    for (const match of block.line.matchAll(ADDRESS_HOST)) {
      const name = hostAsName(match[1] ?? "");
      if (name !== undefined) push(block.index + (match.index ?? 0), name, block.line, true);
    }
  }

  return found.sort((left, right) => left.index - right.index);
}
