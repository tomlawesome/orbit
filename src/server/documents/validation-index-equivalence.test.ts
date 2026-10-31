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
