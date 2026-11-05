import { afterEach, describe, expect, it, vi } from "vitest";
import { hasPdfIndexBudgetOracle } from "../../../tests/support/pdf-index-budget-oracle";
import { hasPdfIndexBudget } from "./validation";

/**
 * #1591: the index-budget check finds the next byte that matters with a native
 * search in every long run, not one JavaScript step per byte. Two kinds of test:
 *
 * - Steps, not seconds (the #1590 method): one 4 MiB file per shape, whose
 *   JavaScript steps (indexed byte reads plus regex execs) must stay under
 *   1/64 of its length. The shapes are those measured in the #1590 fix reviews.
 *   A count does not flake on a busy host or under coverage. Each shape is also
 *   built at 1 MiB and compared with the oracle (pdf.js's patterns), so a
 *   cheaper answer cannot be a different one.
 * - Equivalence: keywords placed across offsets 990-1010 of the searched text,
 *   where one search window ends and the next begins (9-byte overlap, window
 *   starting one byte early). The answer must equal the oracle's.
 */

const MIB = 1024 * 1024;
const latin1 = (value: string): Buffer => Buffer.from(value, "latin1");

const TAIL = "\nendobj\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 >>\nstartxref\n0\n%%EOF\n";

/** `%PDF` line, then `head`, then `fill` repeated to `size` bytes in all, then the tail. */
function fileOf(size: number, head: string, unit: string, tail: string = TAIL): Buffer {
  const front = latin1(`%PDF-1.7\n${head}`);
  const back = latin1(tail);
  const fillLength = Math.max(0, size - front.length - back.length);
  const fill = Buffer.alloc(fillLength);
  if (unit.length > 0) fill.fill(unit, "latin1");
  return Buffer.concat([front, fill, back]);
}

/** Every shape as a builder of a file of about `size` bytes. */
const SHAPES: ReadonlyArray<readonly [name: string, build: (size: number) => Buffer]> = [
  ["leading whitespace", (size) => fileOf(size, "", " ", "\n1 0 obj\nendobj\n")],
  ["leading whitespace of tabs and line ends", (size) => fileOf(size, "", " \t\r\n")],
  ["one long comment line", (size) => fileOf(size, "%", "x", "\n1 0 obj\nendobj\n")],
  ["one long line of one token", (size) => fileOf(size, "", "x", "\n1 0 obj\nendobj\n")],
  ["one long line of words", (size) => fileOf(size, "", "ab cd ".slice(0, 6), "\n1 0 obj\nendobj\n")],
  ["digits inside an object", (size) => fileOf(size, "1 0 obj\n", "1 ")],
  ["words inside an object", (size) => fileOf(size, "1 0 obj\n", "ab ")],
  ["dense `obj obj ` inside an object", (size) => fileOf(size, "1 0 obj\n", "obj obj ")],
  ["dense `xobj ` inside an object", (size) => fileOf(size, "1 0 obj\n", "xobj ")],
  ["dense `1 1 objx ` inside an object", (size) => fileOf(size, "1 0 obj\n", "1 1 objx ")],
  ["dense `endobjx ` inside an object", (size) => fileOf(size, "1 0 obj\n", "endobjx ")],
  ["dense `obj obj ` after a trailer", (size) => fileOf(size, "trailer\n", "obj obj ")],
  ["dense `xobj ` after a trailer", (size) => fileOf(size, "trailer\n", "xobj ")],
  ["a long gap of spaces directly before `obj`", (size) => fileOf(size, "1 0 obj\n7", " ", "7 obj\nendobj\n")],
  ["a long number directly before `obj`", (size) => fileOf(size, "1 0 obj\n", "7", " 7 obj\nendobj\n")],
  ["a long gap of spaces directly before `obj`, after a trailer", (size) => fileOf(size, "trailer\n7", " ", "7 obj\nstartxref\n")],
  ["a long number directly before `obj`, after a trailer", (size) => fileOf(size, "trailer\n", "7", " 7 obj\nstartxref\n")],
];

function answerOf(check: (bytes: Buffer) => boolean, bytes: Buffer): string {
  try {
    return String(check(bytes));
  } catch (error) {
    return `threw ${error instanceof Error ? error.constructor.name : typeof error}`;
  }
}

/**
 * Runs the check on a Buffer that counts every indexed byte read, plus every
 * `RegExp.exec` the check makes (the #1590 method). Neither depends on how fast
 * the host is or whether coverage is measured. A loop that visits each byte of a
 * long run costs at least one step per byte; a native search costs a few per
 * run. 4 MiB is used instead of 98 MB: a count shows the same at any size, and
 * a trapped index read is slow.
 */
function stepsOf(bytes: Buffer): { answer: string; steps: number } {
  let steps = 0;
  const counted = new Proxy(bytes, {
    get(target, key) {
      if (typeof key === "string" && key.length > 0 && key.charCodeAt(0) >= 0x30 && key.charCodeAt(0) <= 0x39) steps += 1;
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  const realExec = RegExp.prototype.exec;
  RegExp.prototype.exec = function (this: RegExp, text: string) {
    steps += 1;
    return realExec.call(this, text);
  } as typeof RegExp.prototype.exec;
  try {
    return { answer: answerOf(hasPdfIndexBudget, counted), steps };
  } finally {
    RegExp.prototype.exec = realExec;
  }
}
const STEP_DIVISOR = 64;

describe("a long run is skipped natively, so the work is a fraction of the file's length (#1591)", () => {
  it.each(SHAPES.map((shape) => [shape[0], shape[1]] as const))("%s: steps are a fraction of the file's length", (name, build) => {
    const size = 4 * MIB;
    const bytes = build(size);
    expect(bytes.length).toBeGreaterThan(size - 64);
    const { steps } = stepsOf(bytes);
    console.log(`#1591 ${name}: ${steps} steps for ${bytes.length} bytes`);
    expect(steps).toBeGreaterThan(0);
    expect(steps).toBeLessThan(bytes.length / STEP_DIVISOR);
  }, 120_000);

  it.each(SHAPES.map((shape) => [shape[0], shape[1]] as const))("%s: answers as the oracle does at 1 MiB", (name, build) => {
    const bytes = build(MIB);
    expect(answerOf(hasPdfIndexBudget, bytes), name).toBe(answerOf(hasPdfIndexBudgetOracle, bytes));
  });
});

describe("no shape makes a decoded copy of the file (#1591)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(SHAPES.map((shape) => [shape[0], shape[1]] as const))("makes no string longer than 1 KiB checking %s (4 MiB)", (_name, build) => {
    const bytes = build(4 * MIB);
    const sliceNames = ["latin1Slice", "utf8Slice", "asciiSlice", "hexSlice", "base64Slice", "base64urlSlice", "ucs2Slice"] as const;
    const proto = Buffer.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
    const spies = [
      vi.spyOn(Buffer.prototype, "toString"),
      ...sliceNames.filter((name) => typeof proto[name] === "function").map((name) => vi.spyOn(proto as never, name)),
    ];
    let lengths: number[];
    try {
      hasPdfIndexBudget(bytes);
      lengths = spies.flatMap((spy) => spy.mock.results)
        .flatMap((result) => (result.type === "return" && typeof result.value === "string" ? [result.value.length] : []));
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(Math.max(0, ...lengths)).toBeLessThan(1024);
  }, 30_000);
});

/**
 * Keywords across the search window's edge. The searched text starts right
 * after the header token `1 0 obj` (or `trailer`), at byte 7, so offset k of the
 * searched text is byte 7 + k. A window is 1000 bytes, begins one byte early and
 * stops 9 short of its end; the first edge is at searched offsets 990-1000 and
 * the keyword starts and ends either side of it. The second edge, a window
 * later, is swept too. `expected` pins the oracle's answer, so a case cannot
 * quietly stop depending on the keyword being found.
 */
const TAG = "/XRef 0\n";
function edgeOffsets(): number[] {
  const offsets: number[] = [];
  for (let k = 985; k <= 1015; k += 1) offsets.push(k);
  for (let k = 1975; k <= 2010; k += 1) offsets.push(k);
  return offsets;
}

/** Spaces for `offset` bytes after the header, then the text. */
const atOffset = (header: string, offset: number, text: string): Buffer => latin1(`${header}${" ".repeat(offset)}${text}`);

/**
 * [name, text after the gap, header, expected answer]. An object's end found
 * means the tag lies outside it (true); a header as the end means the tag lies
 * in the next object, which cannot be read (false). The trailer cases pin the
 * oracle's answer; a missed end there gives the same answer, so they check the
 * two implementations agree and not that the keyword was found.
 */
const EDGE_KEYWORDS: ReadonlyArray<readonly [string, string, string, boolean]> = [
  ["endobj", `endobj\n${TAG}`, "1 0 obj", true],
  ["xref", `xref\n${TAG}`, "1 0 obj", true],
  ["trailer<<", `trailer<<A\n${TAG}`, "1 0 obj", true],
  ["a header `12 0 obj`", `12 0 obj ${TAG}`, "1 0 obj", false],
  ["a header `7 8 obj` split across its digits", `7\n8\nobj ${TAG}`, "1 0 obj", true],
  ["endobj followed by a word byte (rejected)", `endobjx ${TAG}`, "1 0 obj", false],
  ["a word byte then endobj (rejected)", `xendobj ${TAG}`, "1 0 obj", false],
  ["startxref", `startxref\n1 0 obj\n${TAG}`, "trailer", false],
  ["a header `12 0 obj` after a trailer", `12 0 obj\nstartxref\n1 0 obj\n${TAG}`, "trailer", false],
];

describe("keywords across the search window's edge answer as the oracle does (#1591)", () => {
  for (const [name, text, header, expected] of EDGE_KEYWORDS) {
    it(`${name}, started at each searched offset 985-1015 and 1975-2010`, () => {
      const mismatches: string[] = [];
      for (const offset of edgeOffsets()) {
        const file = atOffset(`${header}\n`, offset, text);
        const oracle = answerOf(hasPdfIndexBudgetOracle, file);
        const got = answerOf(hasPdfIndexBudget, file);
        if (oracle !== String(expected)) mismatches.push(`offset ${offset}: oracle answers ${oracle}, pinned ${expected}`);
        if (got !== oracle) mismatches.push(`offset ${offset}: got ${got}, oracle ${oracle}`);
      }
      expect(mismatches).toEqual([]);
    });
  }
});

/**
 * Tokens over the lexer's 400-byte decode limit (longPdfWord) in an
 * xref-stream dictionary, as /Size or /Prev (numbers) or as a name key or
 * value. Each is compared with the oracle, in a file that starts from the last
 * startxref and, as an `Xref` object is in the file, from the recovery scan.
 */
const ZEROS = "0".repeat(500);
const LONG_NAME = "A".repeat(500);
const ESCAPED_NAME = "#41".repeat(167);
const LONG_NUMBERS: ReadonlyArray<readonly [string, string]> = [
  ["500 zeros then 5", `${ZEROS}5`],
  ["500 zeros then 1250001", `${ZEROS}1250001`],
  ["minus, 500 zeros, then 3", `-${ZEROS}3`],
  ["3. then 500 zeros", `3.${ZEROS}`],
  ["500 nines", "9".repeat(500)],
  ["500 zeros then 3e5", `${ZEROS}3e5`],
];

function xrefObject(number: number, dictionary: string): string {
  return `${number} 0 obj << /Type /XRef /W [0 0 0] ${dictionary} /Length 0 >>\nstream\n\nendstream\nendobj\n`;
}

/** Two xref-stream objects, `first` at the offset the second's /Prev names; startxref points at the second. */
function longTokenFile(firstDictionary: string, secondDictionary: (firstOffset: number) => string): Buffer {
  const head = "%PDF-1.7\n";
  const first = xrefObject(4, firstDictionary);
  const secondOffset = head.length + first.length;
  const second = xrefObject(5, secondDictionary(head.length));
  return latin1(`${head}${first}${second}startxref\n${secondOffset}\n%%EOF\n`);
}

describe("tokens over 400 bytes in a cross-reference dictionary answer as the oracle does (#1591)", () => {
  const cases: Array<readonly [string, Buffer]> = [];
  for (const [what, token] of LONG_NUMBERS) {
    cases.push(
      [`/Size ${what}`, longTokenFile(`/Size ${token}`, () => "/Size 3")],
      [`/Size ${what}, in the second object`, longTokenFile("/Size 3", () => `/Size ${token}`)],
      [`/Prev ${what}, zero-padded offset`, longTokenFile("/Size 3", (firstOffset) => `/Size 3 /Prev ${ZEROS}${firstOffset}`)],
      [`/Prev ${what} as the value`, longTokenFile("/Size 3", () => `/Size 3 /Prev ${token}`)],
    );
  }
  for (const [what, name] of [["500 bytes", LONG_NAME], ["500 bytes of #xx escapes", ESCAPED_NAME]] as const) {
    cases.push(
      [`a long name (${what}) as a key`, longTokenFile("/Size 3", () => `/Size 3 /${name} 7`)],
      [`a long name (${what}) as a value`, longTokenFile("/Size 3", () => `/Size 3 /Other /${name}`)],
      [`a long name (${what}) as /Size's neighbour key before /Prev`, longTokenFile("/Size 3", (firstOffset) => `/${name} 1 /Size 3 /Prev ${firstOffset}`)],
      [`a long name (${what}) as the first object's key`, longTokenFile(`/Size 3 /${name} 7`, () => "/Size 3")],
    );
  }

  it.each(cases.map((entry) => [entry[0], entry[1]] as const))("%s", (name, bytes) => {
    expect(answerOf(hasPdfIndexBudget, bytes), name).toBe(answerOf(hasPdfIndexBudgetOracle, bytes));
  });

  it("has both answers among the cases, so the comparison is not one-sided", () => {
    const answers = new Set(cases.map((entry) => answerOf(hasPdfIndexBudgetOracle, entry[1])));
    expect(answers).toContain("true");
    expect(answers).toContain("false");
  });
});
