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
// Four ways of looking, each independent, all of them kept:
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
//   address           the host half of an e-mail address or a web address,
//                     which is the organisation's name far more often than
//                     not.
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

/** A word a name can be built from: a capitalised word, or one of the small
 * words a real name joins itself with. */
const NAME_WORD = "(?:[A-Z][A-Za-z'’.-]*|&|of|and|for|the|de)";

/** A name ending in a company form or a trade word. */
const BY_COMPANY_FORM = new RegExp(
  `\\b((?:${NAME_WORD}\\s+){0,7}(?:${COMPANY_FORM_OR_TRADE})(?:\\s+(?:${COMPANY_FORM_OR_TRADE}))*)(?![A-Za-z])`,
  "gu",
);

/** A name the page introduces in a sentence. */
const IN_PROSE = /\b(?:by|from|with|to|of)\s+((?:[A-Z][A-Za-z'’&.-]*)(?:\s+(?:[A-Z][A-Za-z'’&.-]*|&|of|and))*)/gu;

/** Any run of capitalised words, whatever trade it is in and wherever on the
 * page it sits. Must begin and end on a capitalised word, so a run cannot
 * start on "of" or trail off on "and". */
const CAPITALISED_RUN = new RegExp(
  `\\b([A-Z][A-Za-z'’.-]*(?:\\s+${NAME_WORD}){1,7})(?![A-Za-z])`,
  "gu",
);

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

  const push = (index: number, raw: string, line: string): void => {
    let value = raw.replace(/\s+/gu, " ").trim();
    while (TRAILING_JOINER.test(value)) value = value.replace(TRAILING_JOINER, "");
    if (value.split(" ").length < 2) return;
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
    for (const match of block.line.matchAll(ADDRESS_HOST)) {
      const name = hostAsName(match[1] ?? "");
      if (name !== undefined) push(block.index + (match.index ?? 0), name, block.line);
    }
  }

  return found.sort((left, right) => left.index - right.index);
}
