// A demonstration schema-blind consumer of the "Machine prompts (v0)" line
// grammar documented in docs/engine-events.md. This is a test fixture, not a
// product: it exists to prove that a consumer with no baked-in knowledge of
// individual field names (APP_URL, OIDC_ISSUER, ...) can drive
// `scripts/configure.sh` with `ORBIT_CONFIGURE_PROMPTS=machine` to a
// completed guided configuration using only the documented grammar
// (`prompt` / `prompt-reject` / `prompt-accept` / `prompt-abort`) plus an
// answers table supplied by the caller and keyed by field name.
//
// Rendering below only ever interpolates the generic field/kind/attempt
// values the protocol carries into a fixed template; it never branches on
// what a specific field name *means*.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const PROMPT_LINE = /^prompt field=(\S+) kind=(\S+) required=(\S+) attempt=(\d+)$/;
const REJECT_LINE = /^prompt-reject field=(\S+) reason=(\S+)$/;
const ACCEPT_LINE = /^prompt-accept field=(\S+)$/;
const ABORT_LINE = /^prompt-abort field=(\S+)$/;

/**
 * @param {string[]|string} queue An answer, or queue of successive answers
 *   (one per attempt) for a field.
 * @returns {string|undefined}
 */
function nextAnswer(queue) {
  if (Array.isArray(queue)) {
    return queue.length > 1 ? queue.shift() : queue[0];
  }
  return queue;
}

/**
 * Renders one prompt line as operator-facing text. Deliberately generic: it
 * only ever reads the four documented tokens off the line, never a field
 * name special case.
 */
function renderPromptText({ field, kind, required, attempt }) {
  const requirement = required === "true" ? "required" : "optional";
  const retry = attempt > 1 ? ` (attempt ${attempt})` : "";
  return `Enter a value for ${field} [${kind}, ${requirement}]${retry}:`;
}

/**
 * Drives a guided-configuration child process (configure.sh --init or
 * --set-oidc-secret, run with ORBIT_CONFIGURE_PROMPTS=machine) to
 * completion, answering each documented `prompt` line from `answers`.
 *
 * @param {object} options
 * @param {string} options.command
 * @param {string[]} options.args
 * @param {string} options.cwd
 * @param {NodeJS.ProcessEnv} options.env
 * @param {Record<string, string|string[]>} options.answers Answers keyed by
 *   field name, as they would be loaded from an answers file.
 * @returns {Promise<{
 *   exitCode: number|null,
 *   events: Array<{type: string, field: string, [key: string]: unknown}>,
 *   renderedLog: string[],
 *   stdout: string,
 *   stderr: string,
 * }>}
 */
export function runGuidedFlow({ command, args, cwd, env, answers }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });

    const events = [];
    const renderedLog = [];
    let stdout = "";
    let stderr = "";

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      stdout += `${line}\n`;

      let match = PROMPT_LINE.exec(line);
      if (match) {
        const [, field, kind, required, attemptText] = match;
        const attempt = Number(attemptText);
        events.push({ type: "prompt", field, kind, required, attempt });
        renderedLog.push(renderPromptText({ field, kind, required, attempt }));

        const answerQueue = answers[field];
        const answer = answerQueue === undefined ? "" : nextAnswer(answerQueue);
        child.stdin.write(`${answer}\n`);
        return;
      }

      match = REJECT_LINE.exec(line);
      if (match) {
        const [, field, reason] = match;
        events.push({ type: "prompt-reject", field, reason });
        renderedLog.push(`${field} was rejected: ${reason}.`);
        return;
      }

      match = ACCEPT_LINE.exec(line);
      if (match) {
        const [, field] = match;
        events.push({ type: "prompt-accept", field });
        renderedLog.push(`${field} accepted.`);
        return;
      }

      match = ABORT_LINE.exec(line);
      if (match) {
        const [, field] = match;
        events.push({ type: "prompt-abort", field });
        renderedLog.push(`${field} aborted after too many rejected answers.`);
      }
      // Unrecognised lines (e.g. the closing "Orbit guided configuration
      // saved ..." message) are ignored: a schema-blind renderer only acts
      // on the documented grammar.
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode, events, renderedLog, stdout, stderr });
    });
  });
}
