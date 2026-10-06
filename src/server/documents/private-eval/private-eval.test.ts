import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PrivateEvalRefusal,
  formatReport,
  resolveEvalDirectory,
  runPrivateEvaluation,
} from "./run";

// This test file is the evidence for issue #938's two safety "done when"
// items: the repo-path refusal, and the no-document-text-or-identifying-
// detail guarantee. Every fixture below is invented for this test; none of
// it resembles anyone's real paperwork.

const thisDir = dirname(fileURLToPath(import.meta.url));

function makeOutsideDir(): string {
  // `tests/support/temp-root.ts` (a global setup file) redirects TMPDIR to
  // a per-test-file root outside the repository, so os.tmpdir() is already
  // safely external.
  return mkdtempSync(join(tmpdir(), "orbit-private-eval-"));
}

function writeDocument(
  dir: string,
  stem: string,
  text: string,
  expected: { dates: string[]; provider?: string; reference?: string },
): void {
  writeFileSync(join(dir, `${stem}.txt`), text, "utf8");
  writeFileSync(join(dir, `${stem}.json`), JSON.stringify(expected), "utf8");
}

describe("resolveEvalDirectory refuses paths inside the repository (#938)", () => {
  it("refuses this very source directory", () => {
    expect(() => resolveEvalDirectory(thisDir)).toThrow(PrivateEvalRefusal);
    try {
      resolveEvalDirectory(thisDir);
      expect.unreachable("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PrivateEvalRefusal);
      expect((error as PrivateEvalRefusal).reason).toBe("inside_repository");
    }
  });

  it("refuses a deeper path still inside the repository", () => {
    // dirname(thisDir) is src/server/documents — still inside the repo.
    expect(() => resolveEvalDirectory(dirname(thisDir))).toThrow(PrivateEvalRefusal);
  });

  it("refuses a symlink placed outside the repo that resolves back inside it", () => {
    const outside = makeOutsideDir();
    const escape = join(outside, "escape-into-repo");
    symlinkSync(thisDir, escape, "dir");
    expect(() => resolveEvalDirectory(escape)).toThrow(PrivateEvalRefusal);
    try {
      resolveEvalDirectory(escape);
      expect.unreachable("expected a refusal");
    } catch (error) {
      expect((error as PrivateEvalRefusal).reason).toBe("inside_repository");
    }
  });

  it("accepts a directory genuinely outside the repository", () => {
    const outside = makeOutsideDir();
    expect(resolveEvalDirectory(outside)).toBe(realpathSync(outside));
  });

  it("refuses a path that does not exist", () => {
    const outside = makeOutsideDir();
    expect(() => resolveEvalDirectory(join(outside, "nope"))).toThrow(PrivateEvalRefusal);
  });

  it("refuses an empty path", () => {
    expect(() => resolveEvalDirectory("")).toThrow(PrivateEvalRefusal);
  });
});

describe("the harness source never writes to disk (#938)", () => {
  it("run.ts and cli.ts contain no file-write call", () => {
    // The strongest form of "nothing it writes lands in a tracked file" is
    // that it writes nothing at all: only reads the operator's directory
    // and prints numbers to the terminal. Checked statically so a future
    // edit that adds a stray write call fails this test immediately.
    const forbidden = /writeFileSync|appendFileSync|createWriteStream|writeFile\(|fs\.write\(/;
    const runSource = readFileSync(join(thisDir, "run.ts"), "utf8");
    const cliSource = readFileSync(join(thisDir, "cli.ts"), "utf8");
    expect(forbidden.test(runSource)).toBe(false);
    expect(forbidden.test(cliSource)).toBe(false);
  });
});

describe("scoring against a private directory (#938)", () => {
  it("computes per-field and overall scores from hand-written fixtures", async () => {
    const dir = makeOutsideDir();
    // A document the heuristic reads exactly right.
    writeDocument(
      dir,
      "alpha",
      [
        "Dear Test Recipient,",
        "Your travel insurance is due for renewal on January 15, 2027.",
        "Your insurer: Northwind Cover Co",
        "Your reference: NW-TEST-0042",
      ].join("\n"),
      { dates: ["2027-01-15"], provider: "Northwind Cover Co", reference: "NW-TEST-0042" },
    );
    // A document with no expected dates, correctly emitting none.
    writeDocument(dir, "beta", "A short note with no dates or fields of interest.", { dates: [] });

    const report = await runPrivateEvaluation(dir);
    expect(report.documentCount).toBe(2);
    expect(report.fields.dates).toEqual({ earned: 2, possible: 2 });
    expect(report.fields.provider).toEqual({ earned: 1, possible: 1 });
    expect(report.fields.reference).toEqual({ earned: 1, possible: 1 });
    expect(report.overall.earned).toBe(4);
    expect(report.overall.possible).toBe(4);
    expect(report.overall.accuracy).toBe(1);
  });

  it("scores misses without treating them specially (fields stay separable)", async () => {
    const dir = makeOutsideDir();
    writeDocument(dir, "gamma", "Renewal due 2027-03-01. No named insurer here.", {
      dates: ["2027-03-01"],
      provider: "Expected Provider That Will Not Be Found",
    });
    const report = await runPrivateEvaluation(dir);
    expect(report.fields.dates).toEqual({ earned: 1, possible: 1 });
    expect(report.fields.provider).toEqual({ earned: 0, possible: 1 });
    expect(report.overall.accuracy).toBeLessThan(1);
  });
});

describe("ground-truth and directory validation (#938)", () => {
  it("refuses unmatched .txt/.json pairs", async () => {
    const dir = makeOutsideDir();
    writeFileSync(join(dir, "orphan.txt"), "text with no ground truth", "utf8");
    await expect(runPrivateEvaluation(dir)).rejects.toMatchObject({ reason: "unmatched_files" });
  });

  it("refuses an empty directory", async () => {
    const dir = makeOutsideDir();
    await expect(runPrivateEvaluation(dir)).rejects.toMatchObject({ reason: "empty_directory" });
  });

  it("refuses malformed ground-truth JSON without echoing its content", async () => {
    const dir = makeOutsideDir();
    const sentinel = "SENTINEL-MALFORMED-CONTENT-4471";
    writeFileSync(join(dir, "delta.txt"), "some text", "utf8");
    writeFileSync(join(dir, "delta.json"), `{ not valid json ${sentinel}`, "utf8");
    try {
      await runPrivateEvaluation(dir);
      expect.unreachable("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PrivateEvalRefusal);
      expect((error as PrivateEvalRefusal).reason).toBe("invalid_ground_truth");
      expect((error as PrivateEvalRefusal).message).not.toContain(sentinel);
    }
  });

  it("refuses ground truth with a wrongly-shaped dates field", async () => {
    const dir = makeOutsideDir();
    writeFileSync(join(dir, "epsilon.txt"), "some text", "utf8");
    writeFileSync(join(dir, "epsilon.json"), JSON.stringify({ dates: "not-an-array" }), "utf8");
    await expect(runPrivateEvaluation(dir)).rejects.toMatchObject({ reason: "invalid_ground_truth" });
  });
});

describe("no document text, matched value, or identifying file name ever appears in output (#938)", () => {
  it("keeps sentinel document content, ground-truth values, and real file names out of the report", async () => {
    const dir = makeOutsideDir();

    const rawTextSentinel = "RAW-TEXT-SENTINEL-Zx91-do-not-print-this-prose";
    const correctProvider = "Sentinel Assurance Co";
    const correctReference = "SENT-REF-99231-QX";
    const wrongExpectedReference = "WRONG-EXPECTED-REFERENCE-should-never-print";
    const identifyingStem = "definitely-a-real-persons-identifying-filename";

    writeDocument(
      dir,
      identifyingStem,
      [
        rawTextSentinel,
        "Your travel insurance is due for renewal on January 15, 2027.",
        `Your insurer: ${correctProvider}`,
        `Your reference: ${correctReference}`,
      ].join("\n"),
      // Reference deliberately wrong so a mismatch is scored, proving even
      // a miss never surfaces either the expected or the extracted value.
      { dates: ["2027-01-15"], provider: correctProvider, reference: wrongExpectedReference },
    );

    const report = await runPrivateEvaluation(dir);
    // Confirm a real mismatch actually happened, or the negative assertions
    // below would be vacuous.
    expect(report.fields.reference).toEqual({ earned: 0, possible: 1 });

    const output = formatReport(report);
    const wholeReport = JSON.stringify(report);
    const combined = `${output}\n${wholeReport}`;

    for (const banned of [
      rawTextSentinel,
      correctProvider,
      correctReference,
      wrongExpectedReference,
      identifyingStem,
    ]) {
      expect(combined).not.toContain(banned);
    }
    // Only fixed labels and numbers are present.
    expect(output).toMatch(/^Private evaluation: 1 document\(s\)/);
  });

  it("keeps content out of every refusal message across a full run, not just the successful path", async () => {
    const dir = makeOutsideDir();
    const secretStem = "another-identifying-name-should-not-leak";
    writeFileSync(join(dir, `${secretStem}.txt`), "orphaned text, no ground truth pair", "utf8");
    try {
      await runPrivateEvaluation(dir);
      expect.unreachable("expected a refusal");
    } catch (error) {
      const message = (error as PrivateEvalRefusal).message;
      expect(message).not.toContain(secretStem);
    }
  });
});

describe("repository detection is not fooled by a nested directory named like the repo (#938)", () => {
  it("still allows a same-named directory that is genuinely outside the repo", () => {
    const outside = makeOutsideDir();
    const lookalike = join(outside, "orbit");
    mkdirSync(lookalike);
    expect(() => resolveEvalDirectory(lookalike)).not.toThrow();
  });
});
