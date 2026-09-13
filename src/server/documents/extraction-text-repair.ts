// Repairs one thing Tika does to a page before the sieve reads it.
//
// A letter-spaced heading -- the small capitals a form prints its field
// names in -- comes out of Tika as fragments: "C U R R EN T  T A X  EX P IR
// ES" for CURRENT TAX EXPIRES, "E X PI RY  D ATE" for EXPIRY DATE, "M ON TH
// LY  R E N T" for MONTHLY RENT. Fifteen of the 48 tuning documents carry
// them, on exactly the words a label reader needs: the field names. A
// trigger table cannot match a heading whose letters have spaces in them,
// so this joins the fragments back into words first.
//
// What is joined: a run of capital-letter fragments of at most four letters
// separated by single spaces, at least two of which cannot be words on
// their own -- a single letter other than A or I, or two or three letters
// that are not one of the short words and abbreviations household paper
// actually prints. Real capitalised text also has short words in it ("OF
// BAND D", "IS MADE UP", "IF YOU DO NOT PAY"), and every one of those is a
// word, which is what keeps prose out. Tika puts a double space between the
// words of a letter-spaced heading; inside a repaired run that gap becomes
// one space.
//
// Everything else in the text is left exactly as it was, including the
// double spaces Tika prints between ordinary words.

/** The one-, two- and three-letter strings that are words or the
 * abbreviations a form prints, so a run made of them is prose. */
const SHORT_WORDS = new Set([
  "A", "I",
  "AM", "AN", "AS", "AT", "BE", "BY", "DO", "GO", "HE", "IF", "IN", "IS", "IT",
  "ME", "MY", "NO", "OF", "ON", "OR", "SO", "TO", "UP", "US", "WE",
  "ACC", "AGE", "ALL", "AMT", "AND", "ANY", "APR", "ARE", "AUG", "BED", "BOX",
  "BUT", "CAN", "CAR", "CO2", "COM", "DAY", "DEC", "DID", "DOB", "DUE", "END",
  "EPC", "FAX", "FEB", "FEE", "FOR", "GAS", "GBP", "GET", "HAS", "HER", "HIM",
  "HIS", "HOW", "INC", "ITS", "JAN", "JUL", "JUN", "KWH", "LET", "LLP", "LOW",
  "LTD", "MAN", "MAR", "MAX", "MAY", "MIN", "MOT", "MPG", "MPH", "NET", "NEW",
  "NHS", "NOT", "NOV", "NOW", "OCT", "OFF", "OLD", "ONE", "OUR", "OUT", "PAY",
  "PDF", "PER", "PLC", "PUT", "REF", "SAY", "SEE", "SEP", "SET", "SHE", "SUM",
  "TAX", "TEL", "THE", "TOO", "TOP", "TWO", "USE", "VAN", "VAT", "VIA", "VIN",
  "WAS", "WAY", "WHO", "WWW", "YES", "YOU",
]);

/** A group of capital fragments separated by single spaces. */
const FRAGMENT_RUN = /(?<![A-Za-z])[A-Z]{1,4}(?: [A-Z]{1,4})+(?![A-Za-z])/gu;

function cannotBeAWord(fragment: string): boolean {
  return fragment.length <= 3 && !SHORT_WORDS.has(fragment);
}

function isLetterSpaced(fragments: readonly string[]): boolean {
  return fragments.filter(cannotBeAWord).length >= 2;
}

/**
 * The text with every letter-spaced run joined into words. Positions after
 * a repaired run shift, so this is applied to the page once, before the
 * sieve, and every stage then reads the repaired text.
 */
export function repairLetterSpacing(text: string): string {
  // Pass 1: join the fragments of each run.
  let joined = text.replace(FRAGMENT_RUN, (run) => {
    const fragments = run.split(" ");
    return isLetterSpaced(fragments) ? fragments.join("") : run;
  });
  // Pass 2: the double space Tika put between two words of one heading is
  // one space once both words have been repaired. Only between two joined
  // runs, which is the only place the pass above has been.
  const joinedRuns = new Set<string>();
  for (const match of text.matchAll(FRAGMENT_RUN)) {
    const fragments = match[0].split(" ");
    if (isLetterSpaced(fragments)) joinedRuns.add(fragments.join(""));
  }
  if (joinedRuns.size === 0) return joined;
  joined = joined.replace(/(?<![A-Za-z])([A-Z]{2,})  (?=([A-Z]{2,})(?![A-Za-z]))/gu, (whole, left: string, right: string) =>
    joinedRuns.has(left) && joinedRuns.has(right) ? `${left} ` : whole,
  );
  return joined;
}
