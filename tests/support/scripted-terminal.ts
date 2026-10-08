import { type InstallTerminal, InstallPromptStop } from "../../src/lib/install-terminal";

// A stand-in for the operator's terminal in the install engine's tests
// (#1212): answers come from a script, and everything shown is recorded.

/** A terminal that answers from a script and records everything shown. undefined in the script is end of input; "^C" is Ctrl-C. */
export function scriptedTerminal(answers: Array<string | undefined>): InstallTerminal & { output: () => string; remaining: () => number } {
  let shown = "";
  const queue = [...answers];
  const next = (prompt: string): string | undefined => {
    shown += prompt;
    if (queue.length === 0) return undefined;
    const answer = queue.shift();
    if (answer === "^C") throw new InstallPromptStop(130, "interrupted");
    return answer;
  };
  return {
    write: (text) => {
      shown += text;
    },
    readLine: next,
    readSecret: next,
    output: () => shown,
    remaining: () => queue.length,
  };
}

