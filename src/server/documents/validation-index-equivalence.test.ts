import { afterEach, describe, expect, it, vi } from "vitest";
import { hasPdfIndexBudgetOracle } from "../../../tests/support/pdf-index-budget-oracle";
import { allBudgetShapes, boundaryCases, fixtureFilePdfs } from "../../../tests/support/pdf-budget-shapes";
import { paddedPdfOfSize } from "../../../tests/support/large-pdf";
import { hasPdfIndexBudget } from "./validation";

/**
 * #1567: the index-budget check reads the Buffer directly instead of a latin1
 * copy of the whole file. The model is frozen (ADR-0038 item 4), so the ported
 * check must answer exactly as today's string-based one does, on every input,
 * and must never make a string the size of the file.
 *
 * The oracle (tests/support/pdf-index-budget-oracle.ts) is today's code,
 * lifted verbatim from fb6b6743. validation-budget.test.ts, which passes
 * unchanged, covers the answers case by case; this file covers equivalence.
 */

/** What a check answers, or the kind of error it throws, so a difference in either is a difference. */
function answerOf(check: (bytes: Buffer) => boolean, bytes: Buffer): string {
  try {
    return String(check(bytes));
  } catch (error) {
    return `threw ${error instanceof Error ? error.constructor.name : typeof error}`;
  }
}

function expectSameAnswer(bytes: Buffer, what: string): void {
  expect(answerOf(hasPdfIndexBudget, bytes), what).toBe(answerOf(hasPdfIndexBudgetOracle, bytes));
}

/** mulberry32: a small seeded generator, so a failing mutation is reproducible from its index. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const INSERTIONS: Buffer[] = [
  Buffer.from([0xa0]),
  Buffer.from("endobj"),
  Buffer.from("0 0 obj"),
  Buffer.from("trailer<<"),
  Buffer.from("startxref"),
  Buffer.from("/XRef "),
];
const ANCHORS = ["endobj", "xref", "trailer", "startxref", "obj", "/Type", "<<", ">>", "stream", "/Prev", "/Size"];

function occurrences(bytes: Buffer, needle: string): number[] {
  const found: number[] = [];
  for (let at = bytes.indexOf(needle); at >= 0; at = bytes.indexOf(needle, at + 1)) found.push(at);
  return found;
}

function mutate(random: () => number, base: Buffer, anchorPositions: Map<string, number[]>): Buffer {
  let bytes = Buffer.from(base);
  const below = (limit: number): number => Math.floor(random() * limit);
  const position = (): number => {
    // Around an existing keyword more often than not: that is where a changed byte changes the answer.
    if (random() < 0.65) {
      const anchor = ANCHORS[below(ANCHORS.length)]!;
      const places = anchorPositions.get(anchor) ?? [];
      if (places.length > 0) {
        const at = places[below(places.length)]! + below(anchor.length + 7) - 3;
        return Math.min(Math.max(at, 0), bytes.length);
      }
    }
    return below(bytes.length + 1);
  };
  for (let steps = 1 + below(3); steps > 0; steps -= 1) {
    const at = position();
    const kind = below(4);
    if (kind === 0) {
      if (bytes.length > 0) bytes[Math.min(at, bytes.length - 1)] = below(256);
    } else if (kind === 1) {
      if (bytes.length > 0) bytes[Math.min(at, bytes.length - 1)]! ^= 1 << below(8);
    } else if (kind === 2) {
      bytes = Buffer.concat([bytes.subarray(0, at), INSERTIONS[below(INSERTIONS.length)]!, bytes.subarray(at)]);
    } else {
      const high = Buffer.from(Array.from({ length: 1 + below(3) }, () => 0x80 + below(0x80)));
      bytes = Buffer.concat([bytes.subarray(0, at), high, bytes.subarray(at)]);
    }
  }
  return bytes;
}

describe("the byte-level index-budget check answers as the string-based one does (#1567)", () => {
  it.each(allBudgetShapes().map((shape) => [shape.name, shape.bytes] as const))(
    "gives the same answer on %s",
    (name, bytes) => {
      expectSameAnswer(bytes, name);
    },
  );

  it.each(boundaryCases().map((boundary) => [boundary.name, boundary] as const))(
    "answers %s as the string-based check does, and as pinned",
    (_name, boundary) => {
      expect(String(hasPdfIndexBudgetOracle(boundary.bytes)), "the oracle's own answer").toBe(String(boundary.expected));
      expect(hasPdfIndexBudget(boundary.bytes)).toBe(boundary.expected);
    },
  );

  it("covers both answers across the named shapes, so the comparison is not one-sided", () => {
    const answers = new Set(allBudgetShapes().map((shape) => answerOf(hasPdfIndexBudgetOracle, shape.bytes)));
    expect(answers).toContain("true");
    expect(answers).toContain("false");
  });

  it("gives the same answer on 1,000 seeded mutations of four fixtures (byte flips, and insertions of NBSP, endobj, `0 0 obj`, trailer<<, startxref, /XRef and bytes 0x80-0xff)", () => {
    const fixtures = fixtureFilePdfs();
    expect(fixtures).toHaveLength(4);
    const random = seededRandom(1567);
    const answers = new Map<string, number>();
    for (let index = 0; index < 1_000; index += 1) {
      const fixture = fixtures[index % fixtures.length]!;
      const anchorPositions = new Map(ANCHORS.map((anchor) => [anchor, occurrences(fixture.bytes, anchor)] as const));
      const mutated = mutate(random, fixture.bytes, anchorPositions);
      const expected = answerOf(hasPdfIndexBudgetOracle, mutated);
      answers.set(expected, (answers.get(expected) ?? 0) + 1);
      expect(answerOf(hasPdfIndexBudget, mutated), `mutation ${index} of ${fixture.name}`).toBe(expected);
    }
    // Neither answer dominates, so the mutations are testing the boundary and not one side of it.
    expect(answers.get("true") ?? 0).toBeGreaterThan(50);
    expect(answers.get("false") ?? 0).toBeGreaterThan(50);
  }, 30_000);
});

describe("the check makes no decoded copy of the file (#1567)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const longLine = boundaryCases().find((boundary) => boundary.name.startsWith("4 MiB of"))!.bytes;

  it.each([
    ["a 20 MiB PDF", () => paddedPdfOfSize(20 * 1024 * 1024), true],
    ["4 MiB of `1 0 obj ` on one line", () => longLine, true],
  ] as const)("makes no string longer than 1 KiB while checking %s", (_name, build, expected) => {
    const bytes = build();
    const sliceNames = ["latin1Slice", "utf8Slice", "asciiSlice", "hexSlice", "base64Slice", "base64urlSlice", "ucs2Slice"] as const;
    const proto = Buffer.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
    const spies = [
      vi.spyOn(Buffer.prototype, "toString"),
      ...sliceNames.filter((name) => typeof proto[name] === "function").map((name) => vi.spyOn(proto as never, name)),
    ];

    let answer: boolean;
    let lengths: number[];
    try {
      answer = hasPdfIndexBudget(bytes);
      lengths = spies.flatMap((spy) => spy.mock.results)
        .flatMap((result) => (result.type === "return" && typeof result.value === "string" ? [result.value.length] : []));
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    expect(answer).toBe(expected);
    expect(Math.max(0, ...lengths)).toBeLessThan(1024);
  }, 30_000);
});

/**
 * #1590: the end of an object or trailer is found by jumping between candidate
 * bytes with a native search, not by testing every byte. These cases are the
 * edges a candidate-skipping search can get wrong. findPdfEnd is not exported,
 * so each case is a file whose answer depends on where an object's or trailer's
 * text ends, compared with the oracle's latin1 regexes. `expected` pins the
 * oracle's own answer, so a case cannot quietly stop depending on the end.
 *
 * Rules the cases lean on (recoveryXrefOffsets): an object `N G obj` is a cross-
 * reference stream to read when its text, up to the first end found after its
 * header line, holds `/XRef` followed by a byte below 64. Whatever follows the
 * header's `obj` is not a number-led dictionary here, so reading that object
 * throws and the check answers false. So, with the `/XRef 0` after the end
 * under test: the end found means no object holds the tag (true), the end
 * missed means the object holds it (false). Header and trailer cases invert or
 * reroute that, as noted at each table.
 */
type EndCase = readonly [name: string, bytes: Buffer, expected: boolean];

const latin1 = (value: string): Buffer => Buffer.from(value, "latin1");
const PDF_LINE = "%PDF-1.7\n";
const TAG = "/XRef 0\n";
const MIB = 1024 * 1024;

/** The two-case table behind a keyword's boundaries: the prefix or suffix, and whether the keyword is found. */
const BEFORE_BYTES: ReadonlyArray<readonly [string, string, boolean]> = [
  ["a letter", "x", false],
  ["an underscore", "_", false],
  ["a digit", "9", false],
  ["a high letter byte 0xe9", "\xe9", true],
  ["a no-break space 0xa0", "\xa0", true],
  ["a hyphen", "-", true],
  ["a slash", "/", true],
  ["an open parenthesis", "(", true],
  ["a space", " ", true],
  ["a greater-than", ">", true],
];

const objectKeywordCases = (): EndCase[] => {
  const cases: EndCase[] = [];
  const file = (body: string): Buffer => latin1(`${PDF_LINE}1 0 obj\n${body}`);
  // A keyword after the header line, which is where the search starts.
  cases.push(
    ["endobj on the first byte after the header line", file(`endobj\n${TAG}`), true],
    ["endobj on the first byte after a CRLF header line", latin1(`${PDF_LINE}1 0 obj\r\nendobj\r\n${TAG}`), true],
    ["endobj on the first byte after a CR header line", latin1(`${PDF_LINE}1 0 obj\rendobj\r${TAG}`), true],
    ["endobj right after a `<` that ends the header token", latin1(`${PDF_LINE}1 0 obj<endobj\n${TAG}`), true],
    ["xref on the first byte after the header line", file(`xref\n${TAG}`), true],
    ["trailer<< on the first byte after the header line", file(`trailer<<A\n${TAG}`), true],
    ["a header on the first byte after the header line", file(`12 0 obj xref ${TAG}`), false],
    ["the same file at offset 0, with no %PDF line: endobj found", latin1(`1 0 obj\nendobj\n${TAG}`), true],
    ["the same file at offset 0, with no %PDF line: no end", latin1(`1 0 obj\n${TAG}`), false],
    // The header line is one token: a keyword on it is before where the search starts.
    ["endobj on the header's own line is not an end", latin1(`${PDF_LINE}1 0 obj endobj\n${TAG}`), false],
    ["xref on the header's own line is not an end", latin1(`${PDF_LINE}1 0 obj xref\n${TAG}`), false],
    ["a header on the header's own line is not an end", latin1(`${PDF_LINE}1 0 obj 12 0 obj\n${TAG}`), false],
    ["trailer on the header's own line is not an end", latin1(`${PDF_LINE}1 0 obj trailer<<A\n${TAG}`), false],
    // A header that starts before the search does and runs across its start is not found; one that starts after it is.
    ["a header that starts on the header's line and ends after it is not an end", latin1(`${PDF_LINE}1 0 obj 7 8\nobj ${TAG}`), false],
    ["a header on the next line is an end", latin1(`${PDF_LINE}1 0 obj\n7 8\nobj ${TAG}`), true],
  );
  // The byte before a keyword: a word byte means no boundary, whatever the keyword; a rejected one is skipped, not the end.
  for (const [what, before, found] of BEFORE_BYTES) {
    cases.push(
      [`endobj after ${what}`, file(`${before}endobj\n${TAG}`), found],
      [`xref after ${what}`, file(`${before}xref\n${TAG}`), found],
      [`trailer<< after ${what}`, file(`${before}trailer<<A\n${TAG}`), found],
    );
  }
  // After a keyword: a word byte means no closing boundary; endobj and xref end on any other byte.
  const after: ReadonlyArray<readonly [string, string, boolean]> = [
    ["a letter", "x", false],
    ["an underscore", "_", false],
    ["a digit", "9", false],
    ["a high letter byte 0xe9", "\xe9", true],
    ["a no-break space 0xa0", "\xa0", true],
    ["a slash", "/", true],
    ["a less-than", "<", true],
    ["an open parenthesis", "(", true],
    ["a percent sign", "%", true],
    ["a newline", "\n", true],
    ["a space", " ", true],
  ];
  for (const [what, following, found] of after) {
    cases.push(
      [`endobj followed by ${what}`, file(` endobj${following}${TAG}`), found],
      [`xref followed by ${what}`, file(` xref${following}${TAG}`), found],
    );
  }
  cases.push(
    // endobj ends the text one byte after itself: a tag right on that byte is already past it.
    ["endobj immediately followed by the tag", file("endobj/XRef 0\n"), true],
    ["xref immediately followed by the tag", file("xref/XRef 0\n"), true],
    // Skipped candidates are not the end, and the real end after them still is.
    ["a rejected endobj, then a real one after the tag", file(`xendobj ${TAG}endobj\n`), false],
    ["a rejected endobj, then a real one before the tag", file(`xendobj endobj\n${TAG}`), true],
    ["endobj twice with no gap", file(`endobjendobj\n${TAG}`), false],
    ["endobj and a rejected endobj with a gap", file(`endobj endobj\n${TAG}`), true],
    ["a keyword that ends in the start of another", file(`endendobj\n${TAG}`), false],
    ["the start of a keyword, then the keyword", file(`end endobj\n${TAG}`), true],
    ["xref twice with no gap", file(`xrefxref\n${TAG}`), false],
    ["xref inside startxref is not an end", file(`startxref\n${TAG}`), false],
    ["xref after startxref and a space is an end", file(`startxref xref\n${TAG}`), true],
    ["startxref inside an object does not end it", file(`startxref 12\n${TAG}`), false],
    ["wrong-case keywords are no end", file(`Endobj ENDOBJ XREF Xref TRAILER<<A Trailer<<A\n${TAG}`), false],
    ["truncated keywords are no end", file(`endob endobk xre xrf trailr<<A trailer<A\n${TAG}`), false],
    // trailer: spaces between, with and without <<, and the byte after the <<.
    ["trailer<<A", file(`trailer<<A\n${TAG}`), true],
    ["trailer << A", file(`trailer <<A\n${TAG}`), true],
    ["trailer with every kind of space before <<", file(`trailer \t\r\n\f\v\xa0<<A\n${TAG}`), true],
    ["trailer<< followed by an underscore", file(`trailer<<_\n${TAG}`), true],
    ["trailer<< followed by a digit", file(`trailer<<9\n${TAG}`), true],
    ["trailer<< followed by a space is no end", file(`trailer<< \n${TAG}`), false],
    ["trailer<< followed by a newline is no end", file(`trailer<<\n${TAG}`), false],
    ["trailer<< followed by a slash is no end", file(`trailer<</Size 1\n${TAG}`), false],
    ["trailer<< followed by 0xe9 is no end", file(`trailer<<\xe9\n${TAG}`), false],
    ["trailer<< followed by a third < is no end", file(`trailer<<<A\n${TAG}`), false],
    ["trailer with one < is no end", file(`trailer<A\n${TAG}`), false],
    ["trailer with a gap in the << is no end", file(`trailer< <A\n${TAG}`), false],
    ["trailer with no << is no end", file(`trailer\n${TAG}`), false],
    ["trailer followed by a letter then << is no end", file(`trailerx<<A\n${TAG}`), false],
    ["trailer with 0x85 before << is no end (not a regex space)", file(`trailer\x85<<A\n${TAG}`), false],
    ["trailer with 0x1c before << is no end (not a regex space)", file(`trailer\x1c<<A\n${TAG}`), false],
    ["a trailer without << then one with it", file(`trailer trailer<<A\n${TAG}`), true],
    ["a trailer with << then the tag then another", file(`trailerx<<A ${TAG}trailer<<A\n`), false],
  );
  return cases;
};

/** Headers: a recognised `N G obj` starts a new object, which holds the tag after it (false); a skipped one leaves the xref word to end the first object before the tag (true). */
const HEADER_PREFIXES: ReadonlyArray<readonly [string, string, boolean]> = [
  ["nothing before it", "", true],
  ["a space", " ", true],
  ["a hyphen", "-", true],
  ["a high letter byte 0xe9", "\xe9", true],
  ["a no-break space 0xa0", "\xa0", true],
  ["a letter", "a", false],
  ["an underscore", "_", false],
  ["a letter then digits", "x9", false],
  ["a digit, so the number is longer", "9", true],
  ["another number then a space", "3 ", true],
  ["two other numbers", "3 4 ", true],
  ["a letter, a number and a space", "a3 ", true],
  ["a letter and a number", "a1 ", true],
];

const headerCases = (): EndCase[] => {
  const cases: EndCase[] = [];
  for (const [what, prefix, accepted] of HEADER_PREFIXES) {
    // `a1 12 0 obj` is the one the table's last row names: the 1 is skipped, the later numbers are found.
    cases.push([`an object header after ${what}`, latin1(`${PDF_LINE}1 0 obj\n${prefix}12 0 obj xref ${TAG}`), !accepted]);
  }
  cases.push(
    ["a letter, then a number pair and a header", latin1(`${PDF_LINE}1 0 obj\na1 2 3 0 obj xref ${TAG}`), false],
    ["a letter, then a pair that is too short", latin1(`${PDF_LINE}1 0 obj\na1 2 obj xref ${TAG}`), true],
    ["three numbers, the last two form the header", latin1(`${PDF_LINE}1 0 obj\n1 2 3 obj xref ${TAG}`), false],
    ["a number with a letter after it, then a header", latin1(`${PDF_LINE}1 0 obj\n12a 0 obj xref ${TAG}`), true],
    ["no space before obj", latin1(`${PDF_LINE}1 0 obj\n12 0obj xref ${TAG}`), true],
    ["no space between the numbers", latin1(`${PDF_LINE}1 0 obj\n120 obj xref ${TAG}`), true],
    ["obj followed by a letter", latin1(`${PDF_LINE}1 0 obj\n12 0 objx xref ${TAG}`), true],
    ["obj followed by an underscore", latin1(`${PDF_LINE}1 0 obj\n12 0 obj_ xref ${TAG}`), true],
    ["obj followed by a digit", latin1(`${PDF_LINE}1 0 obj\n12 0 obj9 xref ${TAG}`), true],
    ["obj followed by 0xe9", latin1(`${PDF_LINE}1 0 obj\n12 0 obj\xe9 xref ${TAG}`), false],
    ["obj followed by a slash", latin1(`${PDF_LINE}1 0 obj\n12 0 obj/ xref ${TAG}`), false],
    ["capital OBJ", latin1(`${PDF_LINE}1 0 obj\n12 0 OBJ xref ${TAG}`), true],
    ["obj cut short", latin1(`${PDF_LINE}1 0 obj\n12 0 ob xref ${TAG}`), true],
  );
  // Which characters between the numbers count as space: the regex's \s, not the PDF spaces.
  for (const [what, space, spaceFound, viaNewline] of [
    ["a tab", "\t", true, false],
    ["a form feed", "\f", true, false],
    ["a vertical tab", "\v", true, false],
    ["a no-break space", "\xa0", true, false],
    ["a mix of spaces", " \t\xa0\f ", true, false],
    ["a newline", "\n", true, true],
    ["a carriage return", "\r", true, true],
    ["a CRLF", "\r\n", true, true],
    ["0x85", "\x85", false, false],
    ["0x1c", "\x1c", false, false],
    ["a NUL", "\0", false, false],
    ["a comma", ",", false, false],
  ] as const) {
    // A newline in the header is found by the regex, but the scan reads the line's first token, which is not a header: no new object, so no tag held.
    const expected = !spaceFound || viaNewline;
    cases.push([`an object header with ${what} between its parts`, latin1(`${PDF_LINE}1 0 obj\n12${space}0${space}obj xref ${TAG}`), expected]);
  }
  return cases;
};

/** A cross-reference table hidden after the trailer: a trailer end found at startxref lets the scan skip it (true); one missed lets the scan reach the header inside it (false). */
const HIDDEN = "\nxref\n1 0 obj\n/XRef 0\ntrailer\nstartxref\n";

const trailerCases = (): EndCase[] => {
  const cases: EndCase[] = [];
  const file = (body: string): Buffer => latin1(`${PDF_LINE}trailer\n${body}${HIDDEN}`);
  cases.push(
    ["startxref on the first byte after the trailer line", file("startxref"), true],
    ["startxref after a dictionary", file("<< /Root 1 0 R >>\nstartxref"), true],
    ["startxref on the trailer's own line is not an end", latin1(`${PDF_LINE}trailer startxref${HIDDEN}`), false],
    ["startxref on the first byte after a CRLF trailer line", latin1(`${PDF_LINE}trailer\r\nstartxref${HIDDEN}`), true],
    ["the same at offset 0, with no %PDF line", latin1(`trailer\nstartxref${HIDDEN}`), true],
    ["startxref and an offset", file("startxref\n116\n%%EOF"), true],
    ["endobj is not a trailer's end", file("<<>>\nendobj"), false],
    ["xref is not a trailer's end", file("<<>>\nxref"), false],
    ["trailer<<A is not a trailer's end", file("<<>>\ntrailer<<A"), false],
    ["a header that starts on the trailer's line and ends after it is not an end", latin1(`${PDF_LINE}trailer 7 8\nobj${HIDDEN}`), false],
  );
  for (const [what, before, found] of BEFORE_BYTES) cases.push([`startxref after ${what}`, file(`${before}startxref`), found]);
  for (const [what, following, found] of [
    ["a letter", "x", false],
    ["an underscore", "_", false],
    ["a digit", "9", false],
    ["a high letter byte 0xe9", "\xe9", true],
    ["a no-break space 0xa0", "\xa0", true],
    ["a percent sign", "%", true],
    ["a newline", "\n", true],
    ["a space and an offset", " 12\n", true],
  ] as const) {
    cases.push([`startxref followed by ${what}`, file(` startxref${following}`), found]);
  }
  cases.push(
    ["startxref twice with no gap", file("startxrefstartxref"), false],
    ["the start of startxref, then the word", file("start startxref"), true],
    ["a rejected startxref, then a real one", file("xstartxref startxref"), true],
    ["wrong-case startxref", file("STARTXREF Startxref"), false],
    ["truncated startxref", file("startxre tartxref"), false],
  );
  // A header ends a trailer too: found, the object after it holds the tag (false); skipped, the startxref after it is the end (true).
  for (const [what, prefix, accepted] of HEADER_PREFIXES) {
    cases.push([`a trailer ended by a header after ${what}`, latin1(`${PDF_LINE}trailer\n${prefix}12 0 obj xref ${TAG}startxref\n`), !accepted]);
  }
  return cases;
};

const longRunCases = (): EndCase[] => {
  const file = (body: string): Buffer => latin1(`${PDF_LINE}1 0 obj\n${body}`);
  const trailer = (body: string): Buffer => latin1(`${PDF_LINE}trailer\n${body}${HIDDEN}`);
  const spaces = " ".repeat(3 * MIB);
  const letters = "q".repeat(3 * MIB);
  const startLetters = "e".repeat(3 * MIB);
  return [
    ["3 MiB of spaces, then endobj", file(`${spaces}endobj\n${TAG}`), true],
    ["3 MiB of spaces, then xref", file(`${spaces}xref\n${TAG}`), true],
    ["3 MiB of spaces, then trailer<<", file(`${spaces}trailer<<A\n${TAG}`), true],
    ["3 MiB of spaces, then a header", file(`${spaces}12 0 obj xref ${TAG}`), false],
    ["3 MiB of spaces and no end at all", file(`${spaces}\n${TAG}`), false],
    ["3 MiB of q, a space, then endobj", file(`${letters} endobj\n${TAG}`), true],
    ["3 MiB of q, then endobj with no gap (a word byte before it)", file(`${letters}endobj\n${TAG}`), false],
    ["3 MiB of q, a space, then xref", file(`${letters} xref\n${TAG}`), true],
    ["3 MiB of q, then xref with no gap", file(`${letters}xref\n${TAG}`), false],
    ["3 MiB of q, a space, then trailer<<", file(`${letters} trailer<<A\n${TAG}`), true],
    ["3 MiB of q and no end at all", file(`${letters}\n${TAG}`), false],
    ["3 MiB of e, a space, then endobj", file(`${startLetters} endobj\n${TAG}`), true],
    ["3 MiB of e and no end at all", file(`${startLetters}\n${TAG}`), false],
    ["3 MiB of newlines, then endobj", file(`${"\n".repeat(3 * MIB)}endobj\n${TAG}`), true],
    ["3 MiB of high bytes, then endobj", file(`${"\xe9".repeat(3 * MIB)}endobj\n${TAG}`), true],
    ["200,000 truncated endobj words, then endobj", file(`${"endob ".repeat(200_000)}endobj\n${TAG}`), true],
    ["200,000 truncated xref words, then xref", file(`${"xre ".repeat(200_000)}xref\n${TAG}`), true],
    ["100,000 trailer words with no <<, then trailer<<", file(`${"trailer ".repeat(100_000)}trailer<<A\n${TAG}`), true],
    ["100,000 `1 0 ob ` words, then a header", file(`${"1 0 ob ".repeat(100_000)}12 0 obj xref ${TAG}`), false],
    ["100,000 `1 0 obj` words glued with a letter, then endobj", file(`${"x1 0 obj".repeat(100_000)} endobj\n${TAG}`), true],
    ["1 MiB of one digit, then a header", file(`\n${"1".repeat(MIB)} 0 obj xref ${TAG}`), false],
    ["a letter, 1 MiB of one digit, then a header", file(`\na${"1".repeat(MIB)} 0 obj xref ${TAG}`), true],
    ["a header with 3 MiB of spaces between its numbers", file(`12${spaces}0 obj xref ${TAG}`), false],
    ["a header with 3 MiB of spaces before obj", file(`12 0${spaces}obj xref ${TAG}`), false],
    ["a header whose second number is 1 MiB of digits", file(`12 ${"0".repeat(MIB)} obj xref ${TAG}`), false],
    ["trailer with 3 MiB of spaces before <<", file(`trailer${spaces}<<A\n${TAG}`), true],
    ["a trailer, 3 MiB of spaces, then startxref", trailer(`${spaces}startxref`), true],
    ["a trailer, 3 MiB of q, a space, then startxref", trailer(`${letters} startxref`), true],
    ["a trailer, 3 MiB of q, then startxref with no gap", trailer(`${letters}startxref`), false],
    ["a trailer, 3 MiB of spaces and no end", trailer(spaces), false],
    ["a trailer, 3 MiB of e, a space, then startxref", trailer(`${startLetters} startxref`), true],
    ["a trailer, 3 MiB of spaces, then a header", latin1(`${PDF_LINE}trailer\n${spaces}12 0 obj xref ${TAG}startxref\n`), false],
  ];
};

const bufferEndCases = (): EndCase[] => {
  const object = (body: string): Buffer => latin1(`${PDF_LINE}1 0 obj\n${body}`);
  const objectWithTag = (body: string): Buffer => latin1(`${PDF_LINE}1 0 obj\n${TAG}${body}`);
  const trailer = (body: string): Buffer => latin1(`${PDF_LINE}trailer\n${body}`);
  const cases: EndCase[] = [];
  // Last bytes of the buffer: found keywords there, rejected ones, and keywords cut short by the end. With no tag anywhere the answer is true whichever; with the tag before, false whichever: these guard the search against reading past the end or stopping short of it.
  for (const tail of [
    "endobj", "xref", "trailer<<A", "12 0 obj", "12 0 obj\n", "startxref", "xendobj", "xxref", "xtrailer<<A", "x12 0 obj",
    "endob", "xre", "trailer<<", "trailer<", "trailer", "12 0 ob", "12 0 o", "12 0 ", "12 0", "12", "1",
    "endobj ", "endobj\n", "xref ", "trailer<<A ", "e", "t", "x", "s", "9", "<", "<<",
  ]) {
    cases.push(
      [`object text ending in ${JSON.stringify(tail)}`, object(tail), true],
      [`object text with the tag before it, ending in ${JSON.stringify(tail)}`, objectWithTag(tail), false],
    );
  }
  for (const tail of ["startxref", "xstartxref", "startxre", "12 0 obj", "12 0 ob", "x12 0 obj", "endobj", "xref", "trailer<<A", "startxref\n", "startxref 1"]) {
    cases.push([`trailer text ending in ${JSON.stringify(tail)}`, trailer(tail), true]);
  }
  cases.push(
    ["the file ends right after the header", latin1(`${PDF_LINE}1 0 obj`), true],
    ["the file ends right after the header's newline", latin1(`${PDF_LINE}1 0 obj\n`), true],
    ["the file ends right after the header's CR", latin1(`${PDF_LINE}1 0 obj\r`), true],
    ["the file ends one byte after the header", latin1(`${PDF_LINE}1 0 obj1`), true],
    ["the file ends right after the trailer word", latin1(`${PDF_LINE}trailer`), true],
    ["the file ends right after the trailer line", latin1(`${PDF_LINE}trailer\n`), true],
    ["the tag is the last thing in the file", latin1(`${PDF_LINE}1 0 obj\n/XRef`), true],
    ["the tag and one byte are the last thing in the file", latin1(`${PDF_LINE}1 0 obj\n/XRef `), false],
    ["the tag and two bytes are the last thing in the file", latin1(`${PDF_LINE}1 0 obj\n/XRef 0`), false],
    ["a header at offset 0 and nothing else", latin1("1 0 obj\n"), true],
    ["a header at offset 0 with no end, holding the tag", latin1(`1 0 obj\n${TAG}`), false],
    ["no keyword at all, in a file of near misses", latin1(`${PDF_LINE}1 0 obj\nendob xre trailer< 12 0 ob startxre 1 2 3\n${TAG}`), false],
    ["no keyword at all and no tag", latin1(`${PDF_LINE}1 0 obj\nendob xre trailer< 12 0 ob startxre 1 2 3\n`), true],
    ["a one-byte file", latin1("1"), true],
    ["an empty file", Buffer.alloc(0), true],
  );
  return cases;
};

describe("a candidate-skipping search for the end of an object or trailer answers as the regexes did (#1590)", () => {
  const groups: ReadonlyArray<readonly [string, () => EndCase[]]> = [
    ["object keywords", objectKeywordCases],
    ["object headers", headerCases],
    ["trailers", trailerCases],
    ["long runs", longRunCases],
    ["the end of the buffer", bufferEndCases],
  ];
  for (const [group, build] of groups) {
    describe(group, () => {
      it.each(build().map((entry) => [entry[0], entry] as const))("%s", (_name, [name, bytes, expected]) => {
        expect(answerOf(hasPdfIndexBudgetOracle, bytes), `the oracle's own answer on ${name}`).toBe(String(expected));
        expectSameAnswer(bytes, name);
      });
    });
  }

  it("has both answers among the cases of every group, so no group is one-sided", () => {
    for (const [group, build] of groups) {
      const answers = new Set(build().map((entry) => entry[2]));
      expect(answers, group).toEqual(new Set([true, false]));
    }
  });
});
