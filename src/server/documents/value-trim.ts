import { comparableText } from "@/server/documents/model-extraction";

/**
 * Value trimming, #965. The model reads the right thing and disagrees about
 * where it stops.
 *
 * Every candidate screened has made the same three mistakes, and none of them
 * is a reading failure. `qwen3.5:0.8b` returned `"Policy number: HI-9284712"`
 * for `HI-9284712`. `qwen3.5:4b` and `nuextract3` both returned
 * `"Kestrel Mutual (administered by Faircross Broking Ltd)"` for
 * `Kestrel Mutual`. `nuextract3` returned
 * `"COUNCIL TAX DEMAND NOTICE 2027/28"` and
 * `"Boiler and heating plan — annual statement"` for their untrailed forms.
 *
 * Three prompt wordings failed to fix it (#965 note 16417): the instruction is
 * present, unambiguous and ignored. So this is deterministic instead --
 * cheaper than a token, testable without a model, and it gives the same answer
 * twice.
 *
 * ## Why this is safe
 *
 * Trimming only ever *narrows*. It cannot introduce text the document does not
 * carry, because it removes characters and never adds them, and because every
 * result is re-checked against the evidence span before it is accepted. A
 * trimmed value that no longer appears in its span is discarded and the
 * untrimmed value stands. So ADR-0025 section 3's grounding rule holds after
 * trimming exactly as it held before.
 *
 * ## Why it is per-field
 *
 * The rules are not interchangeable. A reference legitimately contains dashes
 * and brackets -- `88-2291-KM` must survive untouched -- while a provider name
 * almost never carries a trailing parenthetical that belongs to it. Applying
 * the subtype rules to a reference would corrupt good values to fix bad ones.
 */

/**
 * A label introducing a value: `Policy number:`, `Account No.:`.
 *
 * A colon and nothing else. An earlier version also accepted a dash, which
 * ate the front of every dash-qualified value it met -- `Boiler and heating
 * plan — annual statement` trimmed to `annual statement`, because the rule
 * read the real value as the label. A dash separates as often as it
 * introduces; a colon almost only introduces.
 */
const LEADING_LABEL = /^[A-Za-z][A-Za-z.\s]{0,30}?:\s*/u;

/** A parenthetical or bracketed aside at the end. */
const TRAILING_ASIDE = /\s*[([][^)\]]*[)\]]\s*$/u;

/**
 * A qualifier after a spaced dash. The spaces matter: `Marks-Spencer` and
 * `88-2291-KM` carry unspaced dashes that are part of the value.
 */
const TRAILING_DASH_QUALIFIER = /\s+[–—-]\s+\S.*$/u;

/** A trailing period or year: `2027/28`, `2026-27`, `2027`. */
const TRAILING_PERIOD = /\s+\d{4}(?:\s*[/–—-]\s*\d{2,4})?$/u;

/**
 * How many words inside brackets before it reads as an aside rather than part
 * of the name. `Thameside Water (UK)` is a name; `Kestrel Mutual (administered
 * by Faircross Broking Ltd)` is a name plus an explanation. Two is the line:
 * it keeps `(UK)`, `(Scotland)` and `(NI)`, and drops anything that explains
 * rather than qualifies.
 */
const MAX_ASIDE_WORDS_KEPT = 2;

export type TrimmableField = "provider" | "reference" | "subtype";

function wordCount(value: string): number {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
}

/** Strips a trailing aside only when it explains rather than qualifies. */
function withoutTrailingAside(value: string): string {
  const match = value.match(TRAILING_ASIDE);
  if (!match) return value;
  const inside = match[0].replace(/[\s()[\]]/gu, " ");
  if (wordCount(inside) <= MAX_ASIDE_WORDS_KEPT) return value;
  return value.slice(0, value.length - match[0].length).trim();
}

/**
 * The rules each field gets, in the order they apply. A reference gets the
 * label rule alone: everything else in this module would eat part of a real
 * reference.
 */
const RULES: Record<TrimmableField, ReadonlyArray<(value: string) => string>> = {
  reference: [
    (value) => value.replace(LEADING_LABEL, "").trim(),
  ],
  provider: [
    (value) => value.replace(LEADING_LABEL, "").trim(),
    withoutTrailingAside,
  ],
  subtype: [
    (value) => value.replace(LEADING_LABEL, "").trim(),
    withoutTrailingAside,
    (value) => value.replace(TRAILING_DASH_QUALIFIER, "").trim(),
    (value) => value.replace(TRAILING_PERIOD, "").trim(),
  ],
};

/**
 * The narrowest form of `value` that its own evidence `span` still carries.
 *
 * Returns the original when no rule applies, when a rule would empty the
 * value, or when the trimmed result is no longer quoted by the span. It never
 * returns something the span does not contain, and never returns an empty
 * string.
 *
 * `span` is the already-grounded evidence span -- the caller has established
 * it occurs in the document. Checking the trimmed value against the span
 * rather than against the whole document is deliberate: it keeps the value
 * tied to the statement that was offered as its support, exactly as
 * `quotedBySpan` does before trimming.
 */
export function trimFieldValue(field: TrimmableField, value: string, span: string): string {
  let current = value.trim();
  if (!current) return value;

  for (const rule of RULES[field]) {
    const candidate = rule(current).trim();
    // A rule that empties the value, or takes it outside the span it cited,
    // is a rule that misread this value. Keep what we had and move on.
    if (!candidate || !comparableText(span).includes(comparableText(candidate))) continue;
    current = candidate;
  }

  return current;
}
