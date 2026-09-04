/*
 * The budgets a test gets when it drives a real process or does real key
 * derivation (#698).
 *
 * Vitest's global testTimeout is 5s (vitest.config.ts), and it is a verdict,
 * not a guard: Vitest judges a test by elapsed time after it returns, so a
 * spawnSync that blocks for eight seconds is reported as "timed out in 5000ms"
 * once it is already over, and a child that never returns is never reported at
 * all -- the job timeout kills the worker and names nothing. Between
 * 2026-08-31 and 2026-09-04 that verdict failed at least five different test
 * files on pull requests that touched none of them, purely because the runner
 * was busy: a `node tsx orbit.ts` spawn that takes 0.7s on a quiet machine
 * took 4.3s on one starved core and 2.3s on a loaded CI runner, so a test that
 * spawns twice cannot fit in 5s and one that spawns three times fails every
 * time (measured 9.2s and 12.4s, #698).
 *
 * So the guard and the verdict are separated, the way scripts/pty-deadline.mjs
 * already does for pty children:
 *
 *  - PROCESS_DEADLINE_MS is the guard. Every spawn of a real process carries
 *    it as its `timeout`, with SIGKILL, and routes the result through
 *    failOnProcessDeadline so a killed child fails with a message that says
 *    "killed on a deadline" rather than "expected null to be 0".
 *  - PROCESS_TEST_TIMEOUT_MS is the verdict, set per file with
 *    `vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS })`. It sits above
 *    the guard so the guard speaks first, and it is per file rather than global
 *    so the 2,500 tests that spawn nothing keep their 5s.
 *
 * Neither number is a target to nudge. If a test needs more than these, it is
 * either doing something no operator meets (fix the harness) or it has found a
 * hang (fix the subject). The owner's direction is on #698: assert what a person
 * would notice, wait for events rather than durations, and where only a
 * duration will do, take it from the slowest machine anyone runs this on and
 * write the reason beside it.
 */

/*
 * How long a spawned child may run before it is killed and reported.
 *
 * 30s. The slowest single real-process spawn observed is ~4.3s (a tsx-loaded
 * CLI on one fifth of a core), and the busiest tests spawn that CLI three
 * times; bash-driven scripts spawn oftener but each costs tens of
 * milliseconds. Six times the worst observed test, and still five times
 * shorter than the pty deadline, so a hang is named well inside the
 * ten-minute job.
 */
export const PROCESS_DEADLINE_MS = 30_000;

/*
 * The Vitest verdict for a file whose tests drive real processes. Above
 * PROCESS_DEADLINE_MS by the same margin pty-deadline.mjs uses, so a child
 * killed on its deadline is reported by the driver, not by Vitest abandoning
 * the test with the child still running.
 */
export const PROCESS_TEST_TIMEOUT_MS = PROCESS_DEADLINE_MS + 15_000;

/*
 * How long a spawn-based driver's child may go without printing anything.
 *
 * A deadline on total time cannot tell a stuck child from a slow one: both
 * reach it. A child that has stopped printing has stopped working -- waiting
 * for input that is not coming, or hung -- while a slow child keeps printing
 * and reaches the ceiling instead. The longest deliberate silence in the
 * scripts these drivers run is the 0.2s key read in installer-ui.sh, and
 * every wait loop prints an event per poll; 20s is a hundred times that and
 * still short enough that a stall is named well before the ceiling.
 */
export const PROCESS_IDLE_DEADLINE_MS = 20_000;

/*
 * The Vitest verdict for a test that runs the recovery key derivation.
 *
 * scrypt with N=131072 (recovery-crypto.mjs) costs ~0.4s per call on a quiet
 * workstation, by design. The determinism contrast test makes ten calls: ~4s
 * quiet, 5.3s on a machine another session was using, and 21.5s on one fifth
 * of a core -- the same starvation that took the CLI spawns above from 0.7s
 * to 4.3s. 30s is the starved figure with the same margin the process
 * deadline has over its worst case, and replaces the 20s that was declared
 * inline before this module existed and that the starved run went past.
 */
export const KDF_TEST_TIMEOUT_MS = 30_000;

const CAPTURED_OUTPUT_LIMIT = 1_500;

function tail(text, limit = CAPTURED_OUTPUT_LIMIT) {
  const value = typeof text === "string" ? text : "";
  return value.length > limit ? `...${value.slice(-limit)}` : value;
}

function describeKill(reason, deadlineMs) {
  switch (reason) {
    case "idle":
      return `produced no output for ${deadlineMs}ms and was killed. It is stuck -- waiting for `
        + "input it never received, or hung -- not slow: a slow child keeps printing.";
    case "ceiling":
      return `was still producing output ${deadlineMs}ms after it started and was killed. `
        + "That is a retry loop, or a machine slower than any this budget was set from.";
    default:
      return `was killed after its ${deadlineMs}ms deadline without exiting, so there is no `
        + "exit code to assert. This is a hang or a slow runner, not a wrong exit status.";
  }
}

/*
 * The error every process deadline fails with, whoever noticed it: spawnSync
 * via failOnProcessDeadline below, or a spawn-based driver's own watchdog.
 *
 * `reason` is "idle" or "ceiling" from a watchdog that can tell the two apart,
 * or absent for a spawnSync child, which blocks and can only report the total.
 */
export function deadlineError({ label, deadlineMs, reason, subject = "child", stdout = "", stderr = "" }) {
  const captured = [
    tail(stdout) && `--- stdout before the kill ---\n${tail(stdout)}`,
    tail(stderr, 500) && `--- stderr before the kill ---\n${tail(stderr, 500)}`,
  ].filter(Boolean).join("\n");

  return new Error(
    `${label}: the ${subject} ${describeKill(reason, deadlineMs)}\n`
    + (captured || "(nothing was captured before the kill)"),
  );
}

/*
 * Throws when a spawnSync result is a child killed on its deadline; returns
 * the result untouched otherwise, so a helper can `return failOnProcessDeadline(...)`.
 *
 * Keyed on ETIMEDOUT rather than on `status === null && signal === "SIGKILL"`,
 * because a test that kills its own child deliberately produces that same pair
 * and is not a deadline.
 */
export function failOnProcessDeadline(result, { label, deadlineMs = PROCESS_DEADLINE_MS }) {
  if (result?.error?.code !== "ETIMEDOUT") return result;
  throw deadlineError({ label, deadlineMs, stdout: result.stdout, stderr: result.stderr });
}

/*
 * The spawnSync options a real-process helper spreads in so every child
 * carries the guard: `spawnSync(cmd, args, { ...processGuard(), cwd, env })`.
 */
export function processGuard(deadlineMs = PROCESS_DEADLINE_MS) {
  return { timeout: deadlineMs, killSignal: "SIGKILL" };
}

/*
 * The two deadlines of a spawn-based driver, and which one fired.
 *
 *   const watchdog = processWatchdog({ label, kill: () => child.kill("SIGKILL") });
 *   child.stdout.on("data", (chunk) => { stdout += chunk; watchdog.touch(); });
 *   child.on("close", (status) => {
 *     watchdog.stop();
 *     if (watchdog.reason) return reject(watchdog.error({ stdout, stderr }));
 *     ...
 *   });
 *
 * `touch` on every chunk re-arms the idle deadline; the ceiling runs from
 * start regardless. Whichever fires first kills the child once and is
 * recorded as `reason` ("idle" or "ceiling"), which picks the message.
 */
export function processWatchdog({
  label,
  kill,
  idleMs = PROCESS_IDLE_DEADLINE_MS,
  ceilingMs = PROCESS_DEADLINE_MS,
  subject = "child",
}) {
  let idleTimer = null;
  let reason = null;

  const clear = () => {
    clearTimeout(idleTimer);
    clearTimeout(ceilingTimer);
  };
  const fire = (which) => {
    if (reason) return;
    reason = which;
    clear();
    kill();
  };
  const ceilingTimer = setTimeout(() => fire("ceiling"), ceilingMs);
  const touch = () => {
    if (reason) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fire("idle"), idleMs);
  };
  touch();

  return {
    touch,
    stop: clear,
    get reason() { return reason; },
    error({ stdout = "", stderr = "" } = {}) {
      return deadlineError({
        label,
        reason,
        subject,
        deadlineMs: reason === "idle" ? idleMs : ceilingMs,
        stdout,
        stderr,
      });
    },
  };
}
