import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

/*
 * #1744: scripts/ci/rig-flaky-report.mjs reads the merged Playwright json
 * report of a rig run and lists the tests that failed and then passed on a
 * retry, as ready-to-paste docs/flakes.md sightings. Written from the
 * specification alone.
 *
 * CLI the builder follows:
 *
 *   node scripts/ci/rig-flaky-report.mjs <report.json> <out.txt>
 *
 *   env  CI_PIPELINE_ID, CI_JOB_NAME, CI_COMMIT_SHA (full; the entry shows its
 *        first 8 characters), CI_COMMIT_REF_NAME, and REPORT_DATE
 *        (YYYY-MM-DD; the clock's UTC date when unset).
 *
 *   stdout  the report. With at least one flaky test it holds the section
 *           "Flaky (passed on retry)" and, under it, one entry per flaky test:
 *
 *             ## <spec file> "<title path>"
 *             - <date> · <ref> <short sha> · pipeline <id> / <job name> · passed on retry; first try: <first error line>
 *
 *           <title path> is the describe titles and the test title joined with
 *           " › ". <first error line> is the first line of the error message of
 *           the first (failed) result. Playwright marks such a test
 *           status "flaky"; a "flaky" test is never listed as passed.
 *   out.txt exactly the same text as stdout (the `flaky.txt` job artifact).
 *   exit    0 when no test failed, flaky ones included; 1 when a test failed
 *           on every try (the job fails, as now); 2 on a missing or unreadable
 *           argument or report.
 */
const script = fileURLToPath(new URL("./rig-flaky-report.mjs", import.meta.url));
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const result = (status, retry, message) => ({
  workerIndex: 0,
  status,
  duration: 10,
  retry,
  ...(message ? { error: { message } } : {}),
});

const FILE = "tests/rig/home.spec.js";
const spec = (title, status, results) => ({
  title,
  ok: status === "expected" || status === "flaky",
  file: FILE,
  tests: [{ projectName: "rig-webkit-phone", status, results }],
});

const PASSED = "renders the sky";
const FLAKY = "opens the door";
const FAILED = "keeps the pocket";

const report = (extra = []) => ({
  config: {},
  suites: [
    {
      title: "home.spec.js",
      file: FILE,
      specs: [spec(PASSED, "expected", [result("passed", 0)])],
      suites: [
        {
          title: "door",
          file: FILE,
          specs: [
            spec(FLAKY, "flaky", [
              result("failed", 0, "Error: expect(locator).toBeVisible()\n\nLocator: #door\nReceived: hidden"),
              result("passed", 1),
            ]),
            ...extra,
          ],
        },
      ],
    },
  ],
  stats: { expected: 1, flaky: 1, unexpected: extra.length, skipped: 0 },
});

const failing = spec(FAILED, "unexpected", [
  result("failed", 0, "Error: first boom"),
  result("failed", 1, "Error: second boom"),
]);

const ENV = {
  CI_PIPELINE_ID: "4321",
  CI_JOB_NAME: "rig_webkit 2/3",
  CI_COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567",
  CI_COMMIT_REF_NAME: "batch-b",
  REPORT_DATE: "2026-11-21",
};

function run(json, env = ENV) {
  const dir = mkdtempSync(join(tmpdir(), "rig-flaky-"));
  dirs.push(dir);
  const input = join(dir, "report.json");
  const out = join(dir, "flaky.txt");
  writeFileSync(input, typeof json === "string" ? json : JSON.stringify(json));
  const r = spawnSync("node", [script, input, out], {
    encoding: "utf8",
    timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
  let file = null;
  try {
    file = readFileSync(out, "utf8");
  } catch {
    // not written
  }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error, file };
}

const HEADING = `## ${FILE} "door › ${FLAKY}"`;
const LINE =
  "- 2026-11-21 · batch-b 01234567 · pipeline 4321 / rig_webkit 2/3 · passed on retry; first try: Error: expect(locator).toBeVisible()";

describe("rig-flaky-report", () => {
  it("has a script to run", () => {
    const r = run(report());
    expect(r.error).toBeUndefined();
    expect(r.stderr).not.toMatch(/Cannot find module/u);
  });

  it("lists only the flaky test under a 'Flaky (passed on retry)' section", () => {
    const r = run(report([failing]));
    expect(r.stdout).toContain("Flaky (passed on retry)");
    expect(r.stdout).toContain(FLAKY);
    expect(r.stdout).not.toContain(PASSED);
    expect(r.stdout).not.toContain(FAILED);
  });

  it("writes each entry as a docs/flakes.md sighting", () => {
    const r = run(report());
    expect(r.stdout.split("\n")).toContain(HEADING);
    expect(r.stdout.split("\n")).toContain(LINE);
  });

  it("puts the heading directly above its sighting line", () => {
    const lines = run(report()).stdout.split("\n");
    expect(lines[lines.indexOf(HEADING) + 1]).toBe(LINE);
  });

  it("takes the first line of the first try's error only", () => {
    const r = run(report());
    expect(r.stdout).not.toContain("Locator: #door");
  });

  it("never prints the flaky test as passed", () => {
    const r = run(report());
    const lines = r.stdout.split("\n").filter((l) => l.includes(FLAKY));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).not.toMatch(/\bpassed\b(?! on retry)/u);
    expect(r.stdout).not.toMatch(/^Passed/mu);
  });

  it("writes flaky.txt with the same text as stdout", () => {
    const r = run(report());
    expect(r.file).not.toBeNull();
    expect(r.file.trim()).toBe(r.stdout.trim());
    expect(r.file).toContain(HEADING);
  });

  it("exits 0 for flaky-only input", () => {
    const r = run(report());
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
  });

  it("exits 1 when a test failed on every try, and still lists the flaky one", () => {
    const r = run(report([failing]));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(HEADING);
    expect(r.file).toContain(HEADING);
  });

  it("exits 0 and lists nothing flaky when every test passed first time", () => {
    const clean = report();
    clean.suites[0].suites = [];
    const r = run(clean);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("## ");
    expect(r.file).not.toBeNull();
    expect(r.file).not.toContain("## ");
  });

  it("exits 2 on a report that is not json", () => {
    const r = run("not json");
    expect(r.status).toBe(2);
  });
});
