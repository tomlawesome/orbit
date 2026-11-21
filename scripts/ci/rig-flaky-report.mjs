#!/usr/bin/env node
// Lists the rig tests that failed and then passed on a retry (#1744), as
// ready-to-paste docs/flakes.md sightings.
//
// Usage: node scripts/ci/rig-flaky-report.mjs <report.json> <out.txt>
// Env: CI_PIPELINE_ID, CI_JOB_NAME, CI_COMMIT_SHA, CI_COMMIT_REF_NAME,
//      REPORT_DATE (YYYY-MM-DD, default: today UTC).
// Exit: 0 no test failed (flaky ones included); 1 a test failed on every try;
//       2 a missing or unreadable argument or report.
import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: rig-flaky-report.mjs <report.json> <out.txt>");
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
let failed = 0;

function walk(suite, titles) {
  // The top-level suite is the file; its title is not part of the path.
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests ?? []) {
      if (t.status === "flaky") {
        const first = t.results?.find((r) => r.status !== "passed") ?? t.results?.[0];
        const msg = (first?.error?.message ?? "").split("\n")[0].trim();
        flaky.push({ file: spec.file ?? suite.file, path: [...titles, spec.title].join(" › "), msg });
      } else if (t.status === "unexpected") failed += 1;
    }
  }
  for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
}
for (const top of report.suites) walk(top, []);

const lines = ["Flaky (passed on retry)", ""];
if (flaky.length === 0) lines.push("none");
for (const f of flaky) {
  lines.push(`## ${f.file} "${f.path}"`);
  lines.push(
    `- ${date} · ${env.CI_COMMIT_REF_NAME ?? ""} ${sha} · pipeline ${env.CI_PIPELINE_ID ?? ""} / ${env.CI_JOB_NAME ?? ""} · passed on retry; first try: ${f.msg}`,
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
process.exit(failed > 0 ? 1 : 0);
