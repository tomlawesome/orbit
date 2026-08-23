// Minimal Vitest reporter that prints the moment each test file and each
// test case *starts*, not just when it finishes.
//
// Vitest's built-in reporters only print a file once every test inside it
// has settled, so a genuine stall (a hung test, a subprocess that never
// returns control, fake timers left enabled) produces zero output until an
// external job timeout kills the whole run — the log names nothing (#572,
// run 32650782734: "Static and unit checks" went silent for 7.5 minutes
// after its last visible output, then died on the 10-minute job timeout).
//
// With this reporter, the last "RUNNING" line in a stalled log names the
// exact file that was executing when everything went quiet, so a future
// stall is diagnosable from the log alone instead of requiring a blind
// re-run. It only prints one line per file (not per test) to stay quiet on
// a normal, healthy run.
export default class ProgressReporter {
  onTestModuleStart(testModule) {
    process.stdout.write(`[progress] RUNNING  ${testModule.moduleId}\n`);
  }

  onTestModuleEnd(testModule) {
    const state = testModule.state ? testModule.state() : "unknown";
    process.stdout.write(`[progress] DONE     ${testModule.moduleId} (${state})\n`);
  }
}
