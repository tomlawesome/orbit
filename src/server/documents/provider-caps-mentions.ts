// Names read straight off the page by how they are capitalised (owner,
// 2026-09-12): a capital in the middle of a sentence, two or more capitalised
// words in a row, words in front of a company label, and words after
// "trading as" or in front of "is a ... company". No sieve, no tags: the
// mentions go straight to the word bins.

export interface CapsMention {
  value: string;
  line: string;
  index: number;
  rule: "mid-sentence" | "run" | "label" | "trading-as" | "is-a" | "brand" | "domain";
}

/** A capitalised word: starts with a capital letter. Bare numbers and
 * codes that start with a digit are never a name word. */
const CAP = "(?:[A-Z][A-Za-z0-9'’-]*(?:\\.[A-Za-z0-9]+)*)";
const JOIN = "(?:&|of|and|the|for|de)";
const LABEL = "(?:Ltd\\.?|Limited|PLC|Plc|plc|LLP|LLC|CIC|Co\\.?|Company|Group|Holdings|Inc\\.?|Society|Association|Trust|Council|Authority)";

const RUN = new RegExp(`\\b(${CAP}(?:\\s+(?:${CAP}|${JOIN}\\s+${CAP}))+)`, "gu");
const MID_SENTENCE = new RegExp(`(?<=[a-z0-9,;:]\\s+)(${CAP})(?![A-Za-z0-9'’.-])`, "gu");
const BEFORE_LABEL = new RegExp(`\\b((?:${CAP}\\s+|${JOIN}\\s+){1,5}${LABEL})(?![A-Za-z])`, "gu");
/** A brand-shaped token (owner, 2026-09-12): words run together without a
 * space and a capital where the join is (ClearBourne, HomeGuard), or joined
 * by a digit or a symbol (Pass2Drive, Northlight+), or a name with digits on
 * the end (HomeGuard365). Structure, not spelling: nobody prints an ordinary
 * word that way. Two-letter-plus-digit codes (CV2, HF3) are postcodes and
 * are not one. */
const BRAND = new RegExp(
  "(?<![A-Za-z0-9])(" +
  "[A-Z]?[a-z]{2,}[A-Z][a-z][A-Za-z0-9]*" +   // ClearBourne, HomeGuard; not kWh
  "|[A-Za-z]{2,}\\d+[A-Za-z]{2,}[A-Za-z0-9]*" +   // Pass2Drive
  "|[A-Z][A-Za-z]{3,}\\d{2,}" +                    // HomeGuard365
  "|[A-Z][A-Za-z]{2,}\\+" +                        // Northlight+
  ")(?![A-Za-z0-9])",
  "gu",
);
/** The name in an email or web address (pass2drive.co.uk, homeguard365.co.uk):
 * the one place a firm prints its name even when the letterhead is a logo
 * the OCR never saw. The first label only, and only a firm's own kind of
 * address, so a gmail.com customer is not a provider. */
const DOMAIN = /(?<=@|www\.|https?:\/\/)([a-z0-9][a-z0-9-]{2,})\.(?:co\.uk|org\.uk|ac\.uk|gov\.uk|nhs\.uk|com|org|net|uk|io)\b/giu;
const NOT_A_FIRM_DOMAIN = new Set(["gmail", "googlemail", "hotmail", "outlook", "yahoo", "icloud", "live", "btinternet", "sky", "aol", "protonmail", "me"]);
const TRADING_AS = new RegExp(`\\b(?:trading as|t/a|T/A|a trading name of|trading name of)\\s+((?:${CAP}|${JOIN})(?:\\s+(?:${CAP}|${JOIN})){0,5})`, "gu");
const IS_A = new RegExp(`\\b((?:${CAP}|${JOIN})(?:\\s+(?:${CAP}|${JOIN})){0,5})\\s+is\\s+(?:a|an|the)\\b[^.\\n]{0,60}\\b(?:company|subsidiary|brand|trading name|partnership|society|firm)\\b`, "gu");

/** Capitalised words that are never a name on their own: titles, months,
 * days, and the words a form prints in capitals. */
export const NOT_A_NAME = new Set([
  "mr", "mrs", "ms", "miss", "dr", "the", "a", "an", "your", "this", "dear", "re", "page", "yes", "no", "n/a",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);

function clean(value: string): string {
  return value
    .replace(/\s+/gu, " ")
    .replace(/^(?:&|of|and|the|for|de|mr|mrs|ms|miss|dr|dear)\s+/iu, "")
    .replace(/\s+(?:&|of|and|the|for|de)$/iu, "")
    .trim();
}

function push(out: CapsMention[], rule: CapsMention["rule"], raw: string, index: number, line: string): void {
  const value = clean(raw);
  if (value.length < 2) return;
  if (NOT_A_NAME.has(value.toLowerCase())) return;
  if (!/[A-Za-z]{2}/u.test(value)) return;
  out.push({ value, line, index, rule });
}

/** Every mention on the page the four capitalisation rules find. */
export function capsMentions(text: string): CapsMention[] {
  const out: CapsMention[] = [];
  let offset = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const at = offset;
    offset += rawLine.length + 1;
    if (!line) continue;
    for (const match of line.matchAll(RUN)) push(out, "run", match[1] as string, at + (match.index ?? 0), line);
    for (const match of line.matchAll(MID_SENTENCE)) push(out, "mid-sentence", match[1] as string, at + (match.index ?? 0), line);
    for (const match of line.matchAll(BEFORE_LABEL)) push(out, "label", match[1] as string, at + (match.index ?? 0), line);
    for (const match of line.matchAll(TRADING_AS)) push(out, "trading-as", match[1] as string, at + (match.index ?? 0), line);
    for (const match of line.matchAll(IS_A)) push(out, "is-a", match[1] as string, at + (match.index ?? 0), line);
    for (const match of line.matchAll(BRAND)) push(out, "brand", match[1] as string, at + (match.index ?? 0), line);
    for (const match of line.matchAll(DOMAIN)) {
      const label = (match[1] as string).toLowerCase();
      if (!NOT_A_FIRM_DOMAIN.has(label)) push(out, "domain", label, at + (match.index ?? 0), line);
    }
  }
  return out;
}
