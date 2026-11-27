// Syntax-check every GitHub Actions workflow: .github/workflows/*.yml|*.yaml.
//
// Usage: node scripts/check-workflows.mjs [root]   (root defaults to the repo)
//
// What it checks: each file is parsed against GitHub's workflow schema and
// converted to a workflow template, which catches unknown keys, bad `on:`
// values, wrong types and malformed `${{ }}` expressions. Each error is printed
// as `file: message` (the message carries Line/Col). Exit 1 if any file has an
// error, 0 otherwise. It does not run anything and does not check that actions
// exist or that secrets are set.
//
// Why this tool: actionlint is not approved (owner decision, 2026-11-24, #1592).
// @actions/workflow-parser is GitHub's own parser (actions/languageservices).
//
// How to bump: raise the exact pin of @actions/workflow-parser in the root
// package.json devDependencies (no ^ or ~), run `pnpm install`, check the
// release is at least 3 days old, its licence and install scripts and those of
// its dependencies, then run this script and its test.

import { readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";


// The parser 0.3.61 imports its schema JSON without the `with { type: "json" }`
// attribute, which Node rejects. Serve those files as JSON ourselves.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".json") && url.includes("/@actions/workflow-parser/")) {
      return { format: "json", source: readFileSync(fileURLToPath(url), "utf8"), shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { convertWorkflowTemplate, NoOperationTraceWriter, parseWorkflow } = await import("@actions/workflow-parser");

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const dir = join(root, ".github", "workflows");

const files = readdirSync(dir)
  .filter((name) => /\.ya?ml$/u.test(name))
  .sort();

let failed = false;
for (const name of files) {
  const trace = new NoOperationTraceWriter();
  const label = `.github/workflows/${name}`;
  let messages;
  try {
    const result = parseWorkflow({ name: label, content: readFileSync(join(dir, name), "utf8") }, trace);
    if (result.value) await convertWorkflowTemplate(result.context, result.value);
    messages = result.context.errors.getErrors().map((e) => e.message);
  } catch (err) {
    messages = [`parser threw: ${err instanceof Error ? err.message : String(err)}`];
  }
  for (const message of messages) process.stdout.write(`${label}: ${message}\n`);
  if (messages.length > 0) failed = true;
}

process.stdout.write(`check-workflows: ${files.length} file(s), ${failed ? "errors found" : "ok"}\n`);
process.exit(failed ? 1 : 0);
