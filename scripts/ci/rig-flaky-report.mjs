#!/usr/bin/env node
// Lists the rig tests that failed and then passed on a retry (#1744), as
// ready-to-paste docs/flakes.md sightings.
//
// Usage: node scripts/ci/rig-flaky-report.mjs <report.json> <out.txt> [junit.xml]
// Run from the repository root. With junit.xml, each flaky testcase's name is
// prefixed "[flaky] " in place (junit would otherwise show it as a plain pass).
// The job is named from the project (the merged json has no shard), not from
// CI_JOB_NAME, which in browser_report is browser_report.
// Env: CI_PIPELINE_ID, CI_COMMIT_SHA, CI_COMMIT_REF_NAME,
//      REPORT_DATE (YYYY-MM-DD, default: today UTC).
// Exit: 0 no test failed (flaky ones included); 1 a test failed on every try;
//       2 a missing or unreadable argument or report.
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const [input, output, junit] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: rig-flaky-report.mjs <report.json> <out.txt> [junit.xml]");
  process.exit(2);
}
let report;
try {
  report = JSON.parse(readFileSync(input, "utf8"));
} catch (e) {
  console.error(`rig-flaky-report: cannot read ${input}: ${e.message}`);
  process.exit(2);
}
if (!report || !Array.isArray(report.suites)) {
  console.error(`rig-flaky-report: ${input} is not a Playwright json report`);
  process.exit(2);
}

const env = process.env;
const date = env.REPORT_DATE || new Date().toISOString().slice(0, 10);
const sha = (env.CI_COMMIT_SHA ?? "").slice(0, 8);
const flaky = [];
const testDirs = new Map((report.config?.projects ?? []).map((p) => [p.name, p.testDir]));
// The --project flags of web/package.json's rig:* scripts.
const jobOf = (project) =>
  project === "rig-firefox" ? "rig_firefox" : project?.startsWith("rig-webkit") ? "rig_webkit" : "rig_chromium";
const xmlEscape = (v) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
let failed = 0;

function walk(suite, titles) {
  // The top-level suite is the file; its title is not part of the path.
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests ?? []) {
      if (t.status === "flaky") {
        const first = t.results?.find((r) => r.status !== "passed") ?? t.results?.[0];
        const msg = (first?.error?.message ?? "").split("\n")[0].trim();
        const file = spec.file ?? suite.file;
        const dir = testDirs.get(t.projectName);
        flaky.push({
          file,
          repoPath: dir ? relative(process.cwd(), join(dir, file)) : file,
          project: t.projectName,
          path: [...titles, spec.title].join(" › "),
          msg,
        });
      } else if (t.status === "unexpected") failed += 1;
    }
  }
  for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
}
for (const top of report.suites) walk(top, []);

const lines = ["Flaky (passed on retry)", ""];
if (flaky.length === 0) lines.push("none");
for (const f of flaky) {
  lines.push(`## ${f.repoPath} "${f.path}" [${f.project}]`);
  lines.push(
    `- ${date} · ${env.CI_COMMIT_REF_NAME ?? ""} ${sha} · pipeline ${env.CI_PIPELINE_ID ?? ""} / ${jobOf(f.project)} · passed on retry; first try: ${f.msg}`,
  );
  lines.push("");
}
const text = `${lines.join("\n")}\n`;
try {
  writeFileSync(output, text);
} catch (e) {
  console.error(`rig-flaky-report: cannot write ${output}: ${e.message}`);
  process.exit(2);
}
process.stdout.write(text);
if (junit && flaky.length > 0) {
  try {
    const keys = new Set();
    for (const f of flaky) {
      for (const n of new Set([f.path, xmlEscape(f.path)])) {
        for (const c of new Set([f.file, xmlEscape(f.file)])) keys.add(JSON.stringify([f.project, c, n]));
      }
    }
    let host;
    const xml = readFileSync(junit, "utf8").replace(/<testsuite\b[^>]*>|<testcase\b[^>]*>/g, (tag) => {
      if (tag.startsWith("<testsuite")) {
        host = /\bhostname="([^"]*)"/.exec(tag)?.[1];
        return tag;
      }
      const name = /\bname="([^"]*)"/.exec(tag)?.[1];
      const cls = /\bclassname="([^"]*)"/.exec(tag)?.[1];
      // A function replacement keeps `$&` and `$'` in a title literal.
      return keys.has(JSON.stringify([host, cls, name])) ? tag.replace(`name="${name}"`, () => `name="[flaky] ${name}"`) : tag;
    });
    writeFileSync(junit, xml);
  } catch (e) {
    console.error(`rig-flaky-report: cannot update ${junit}: ${e.message}`);
    process.exit(2);
  }
}
process.exit(failed > 0 ? 1 : 0);
