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
 *   node scripts/ci/rig-flaky-report.mjs <report.json> <out.txt> [junit.xml]
 *
 *   Run with the repository root as the working directory.
 *   env  CI_PIPELINE_ID, CI_COMMIT_SHA (first 8 characters shown),
 *        CI_COMMIT_REF_NAME, REPORT_DATE (YYYY-MM-DD; UTC today when unset).
 *        CI_JOB_NAME is ignored: in browser_report it names the wrong job.
 *
 *   Entry, one per flaky test per project (Playwright status "flaky"):
 *     ## <repo-relative spec path> "<describe › title>" [<project>]
 *     - <date> · <ref> <sha8> · pipeline <id> / <job> · passed on retry; first try: <first error line>
 *   The spec path is config.projects[].testDir (absolute) joined with the
 *   spec's `file`, made relative to the working directory.
 *   <job> comes from the project alone: rig-desktop and rig-phone ->
 *   rig_chromium, rig-firefox -> rig_firefox, rig-webkit-* -> rig_webkit (the
 *   --project flags of web/package.json's rig:* scripts). The merged json
 *   carries no shard, so there is no "2/3" and nothing reads `parallel:`.
 *   Stdout and out.txt hold the same text, a "Flaky (passed on retry)"
 *   section; a flaky test is never printed as passed.
 *   junit.xml, when given, is rewritten in place: each flaky test's <testcase>
 *   (matched by classname = spec `file` and name = title path) gets "[flaky] "
 *   at the start of its name; every other byte is left alone.
 *   exit 0 no test failed (flaky included); 1 a test failed on every try;
 *   2 a missing or unreadable argument or report.
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

const ROOT = process.cwd();
const FILE = "home.spec.js";
const REL = "web/tests/rig/home.spec.js";
const TEST_DIR = join(ROOT, "web/tests/rig");
const PROJECT = "rig-webkit-phone";
const spec = (title, status, results) => ({
  title,
  ok: status === "expected" || status === "flaky",
  file: FILE,
  tests: [{ projectName: PROJECT, status, results }],
});

const PASSED = "renders the sky";
const FLAKY = "opens the door";
const FAILED = "keeps the pocket";

const report = (extra = []) => ({
  config: { projects: [{ name: PROJECT, testDir: TEST_DIR }, { name: "rig-desktop", testDir: TEST_DIR }] },
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
  CI_JOB_NAME: "browser_report",
  CI_COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567",
  CI_COMMIT_REF_NAME: "batch-b",
  REPORT_DATE: "2026-11-21",
};

function run(json, env = ENV, junit = undefined) {
  const dir = mkdtempSync(join(tmpdir(), "rig-flaky-"));
  dirs.push(dir);
  const input = join(dir, "report.json");
  const out = join(dir, "flaky.txt");
  writeFileSync(input, typeof json === "string" ? json : JSON.stringify(json));
  const junitPath = join(dir, "junit.xml");
  // junit: a string is written to the file; null passes a path that does not exist.
  if (typeof junit === "string") writeFileSync(junitPath, junit);
  const r = spawnSync("node", [script, input, out, ...(junit !== undefined ? [junitPath] : [])], {
    cwd: ROOT,
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
  let xml = null;
  try {
    xml = readFileSync(junitPath, "utf8");
  } catch {
    // none
  }
  return { xml, status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error, file };
}

const HEADING = `## ${REL} "door › ${FLAKY}" [${PROJECT}]`;
const LINE =
  "- 2026-11-21 · batch-b 01234567 · pipeline 4321 / rig_webkit · passed on retry; first try: Error: expect(locator).toBeVisible()";

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

  it("names the job from the project, not CI_JOB_NAME", () => {
    const r = run(report());
    expect(r.stdout).toContain("pipeline 4321 / rig_webkit ·");
    expect(r.stdout).not.toContain("browser_report");
    expect(r.stdout).not.toMatch(/rig_webkit \d/u);
  });

  it.each([
    ["rig-desktop", "rig_chromium"],
    ["rig-phone", "rig_chromium"],
    ["rig-firefox", "rig_firefox"],
    ["rig-webkit-desktop", "rig_webkit"],
    ["rig-webkit-phone", "rig_webkit"],
  ])("maps %s to the job %s", (project, job) => {
    const json = report();
    const t = json.suites[0].suites[0].specs[0].tests[0];
    t.projectName = project;
    expect(run(json).stdout).toContain(`pipeline 4321 / ${job} ·`);
  });

  it("gives one heading per project for the same test", () => {
    const json = report();
    const specs = json.suites[0].suites[0].specs;
    const other = structuredClone(specs[0]);
    other.tests[0].projectName = "rig-desktop";
    specs.push(other);
    const lines = run(json).stdout.split("\n");
    expect(lines).toContain(HEADING);
    expect(lines).toContain(`## ${REL} "door › ${FLAKY}" [rig-desktop]`);
  });

  describe("junit.xml", () => {
    const tc = (name, body = "") =>
      `<testcase name="${name}" classname="${FILE}" time="0.034">${body}</testcase>`;
    const xml = (cases) =>
      `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites id="" name="" tests="3" failures="1" skipped="0" errors="0" time="1">\n` +
      `<testsuite name="${FILE}" timestamp="2026-11-21T10:00:00.000Z" hostname="${PROJECT}" tests="3" failures="1" skipped="0" time="1" errors="0">\n` +
      cases.join("\n") +
      `\n</testsuite>\n</testsuites>\n`;
    const cases = [
      tc(PASSED),
      tc(`door › ${FLAKY}`),
      tc(`door › ${FAILED}`, '<failure message="boom" type="FAILURE">Error: boom</failure>'),
    ];

    it("prefixes the flaky testcase's name with [flaky] and changes nothing else", () => {
      const before = xml(cases);
      const r = run(report([failing]), ENV, before);
      expect(r.xml).toBe(before.replace(`name="door › ${FLAKY}"`, `name="[flaky] door › ${FLAKY}"`));
    });

    it("leaves the file as it was when nothing is flaky", () => {
      const clean = report();
      clean.suites[0].suites = [];
      const before = xml(cases);
      expect(run(clean, ENV, before).xml).toBe(before);
    });

    it("does not touch a testcase with the same name in another spec file", () => {
      const other = `<testcase name="door › ${FLAKY}" classname="other.spec.js" time="0.1"></testcase>`;
      const before = xml([...cases, other]);
      const r = run(report(), ENV, before);
      expect(r.xml).toContain(other);
      expect(r.xml).toContain(`name="[flaky] door › ${FLAKY}" classname="${FILE}"`);
    });

    it("still exits 0 for flaky-only input", () => {
      expect(run(report(), ENV, xml(cases)).status).toBe(0);
    });

    it("marks only the testcase of the flaky project when two suites share classname and name", () => {
      const name = `door › ${FLAKY}`;
      const suite = (host, body) =>
        `<testsuite name="${FILE}" hostname="${host}" tests="1" failures="0">\n${tc(name)}\n</testsuite>`;
      const phone = suite("rig-phone", "");
      const desktop = suite("rig-desktop", "");
      const before = `<?xml version="1.0"?>\n<testsuites>\n${desktop}\n${phone}\n</testsuites>\n`;
      const json = report();
      json.suites[0].suites[0].specs[0].tests[0].projectName = "rig-phone";
      const r = run(json, ENV, before);
      expect(r.xml).toBe(`<?xml version="1.0"?>\n<testsuites>\n${desktop}\n${phone.replace(`name="${name}"`, `name="[flaky] ${name}"`)}\n</testsuites>\n`);
    });

    it("keeps a title with $& and $' exactly as written", () => {
      const title = "pays $& and $' and $1 back";
      const json = report();
      json.suites[0].suites[0].specs[0].title = title;
      const name = `door › ${title}`;
      const before = xml([tc(PASSED), tc(name)]);
      const r = run(json, ENV, before);
      expect(r.xml).toBe(before.split(`name="${name}"`).join(`name="[flaky] ${name}"`));
    });

    it("writes flaky.txt before the junit step: an unreadable junit path exits 2 and the list is already written", () => {
      const r = run(report(), ENV, null);
      expect(r.status).toBe(2);
      expect(r.file).not.toBeNull();
      expect(r.file).toContain(HEADING);
      expect(r.file).toContain(LINE);
    });
  });

  it("names [junit.xml] in its usage message", () => {
    const r = spawnSync("node", [script], { encoding: "utf8", cwd: ROOT, timeout: 30_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("[junit.xml]");
  });
});
