#!/usr/bin/env node
// CLI entry point for the private local evaluation harness (issue #938).
// Run with tsx, exactly like `src/cli/orbit.ts`:
//
//   node node_modules/tsx/dist/cli.mjs src/server/documents/private-eval/cli.ts <directory>
//
// See docs/private-eval.md for what the directory must contain and what
// the output means. This file writes to nothing but the terminal: no
// report file, no log, nothing that could end up in the repository.

import { PrivateEvalRefusal, formatReport, runPrivateEvaluation } from "./run";

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: private-eval <directory-outside-the-repo>");
    process.exitCode = 1;
    return;
  }
  try {
    const report = await runPrivateEvaluation(inputPath);
    console.log(formatReport(report));
  } catch (error) {
    // PrivateEvalRefusal's message is always a fixed string chosen from
    // code (see run.ts) — never built from document content — so it is
    // safe to print directly. Anything else is an unexpected bug; it is
    // left to Node's default uncaught-error reporting rather than risking
    // a bespoke handler that might interpolate something it shouldn't.
    if (error instanceof PrivateEvalRefusal) {
      console.error(`Refused: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

main();
