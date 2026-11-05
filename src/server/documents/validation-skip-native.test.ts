import { afterEach, describe, expect, it, vi } from "vitest";
import { hasPdfIndexBudgetOracle } from "../../../tests/support/pdf-index-budget-oracle";
import { hasPdfIndexBudget } from "./validation";

/**
 * #1591: the index-budget check finds the next byte that matters with a native
 * search in every long run, not one JavaScript step per byte. Two kinds of test:
 *
 * - Timing: one 98 MB file per shape, each under 2 s. The shapes are the ones
 *   measured in the #1590 fix reviews. A wall-clock bound can fail on a busy
 *   runner, so it is wide (2 s against 0.7-2.4 s measured on the code before the
 *   fix and well under 0.3 s expected after) and is relaxed 25-fold when the run
 *   measures coverage, which slows these loops about that much. Each timed file
 *   is also built at 1 MiB and compared with the oracle (pdf.js's patterns), so
 *   a faster answer cannot be a different one.
 * - Equivalence: keywords placed across offsets 990-1010 of the searched text,
 *   where one search window ends and the next begins (9-byte overlap, window
 *   starting one byte early). The answer must equal the oracle's.
 */

const MIB = 1024 * 1024;
const latin1 = (value: string): Buffer => Buffer.from(value, "latin1");

function underCoverage(): boolean {
  const worker = (globalThis as { __vitest_worker__?: { config?: { coverage?: { enabled?: boolean } } } }).__vitest_worker__;
  return worker?.config?.coverage?.enabled === true || process.env.NODE_V8_COVERAGE !== undefined;
}
const LIMIT_MS = 2000 * (underCoverage() ? 25 : 1);

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

describe("a long run is skipped natively, so a 98 MB file is checked in under 2 s (#1591)", () => {
  it.each(SHAPES.map((shape) => [shape[0], shape[1]] as const))("%s: 98 MB", (_name, build) => {
    const bytes = build(98 * MIB);
    expect(bytes.length).toBeGreaterThan(97 * MIB);
    const started = performance.now();
    hasPdfIndexBudget(bytes);
    const elapsed = performance.now() - started;
    console.log(`#1591 ${_name}: ${Math.round(elapsed)} ms (limit ${LIMIT_MS} ms)`);
    expect(elapsed).toBeLessThan(LIMIT_MS);
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

  // A single 4 MiB token (a long number, or one word) is decoded whole by the
  // dictionary reader (PdfLexer.next), which is outside #1591; those two shapes
  // are left out so this test says only what the check's loops do.
  const loopShapes = SHAPES.filter(([name]) => name !== "a long number directly before `obj`" && name !== "one long line of one token");

  it.each(loopShapes.map((shape) => [shape[0], shape[1]] as const))("makes no string longer than 1 KiB checking %s (4 MiB)", (_name, build) => {
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
