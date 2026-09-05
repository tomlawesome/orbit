import { deadlineError, processWatchdog } from "./process-budget.mjs";

/*
 * What a pty test says when its child runs out of time (#595).
 *
 * The pty drivers in scripts/*.test.mjs give their child a deadline and kill
 * it with SIGKILL when the deadline passes. A killed child has no exit status:
 * spawnSync returns `status: null` with `error.code === "ETIMEDOUT"`, and a
 * spawn-based driver's close event reports the same null. The test then
 * asserts an exit code and fails with "expected null to be 130", which names
 * the wrong fault entirely -- it reads as "the installer exited wrongly" when
 * what happened is "the installer never finished". On 2026-08-24 that message
 * appeared on a pull request that changed only tests/integration/, and cost a
 * rerun to establish it was not real.
 *
 * So every driver routes its deadline through here, and a deadline says it was
 * a deadline.
 */

/*
 * The deadline for a blocking spawnSync pty child.
 *
 * Nothing else can interrupt one of these: spawnSync holds the event loop, so
 * Vitest's own per-test timeout cannot fire and this deadline is the only
 * thing between a hung child and the job timeout.
 *
 * 180s, from three observations. The slowest of these tests takes ~1.4s on an
 * idle workstation. Under parallel CI load with coverage instrumentation they
 * have been seen past 10s (#368/#372), past 30s (#390) and past 90s (#595), so
 * a deadline set from local durations measures runner contention rather than
 * correctness. And the "Static and unit checks" job allows 10 minutes for a
 * suite that takes ~5, which leaves room for one child to burn 180s and still
 * fail with this message rather than being cut off by the job timeout -- a job
 * timeout names nothing, which is the outcome this whole module exists to
 * avoid.
 */
export const PTY_DEADLINE_MS = 180_000;

/*
 * The deadline for a spawn-based driver, which does its own killing on a timer.
 *
 * Lower than the blocking case because these drivers do not block the event
 * loop: Vitest's per-test timeout is live alongside them, so the tests that use
 * one declare PTY_TEST_TIMEOUT_MS to keep this the deadline that fires first.
 * A test whose whole point is a prompt appearing has nothing to wait 180s for.
 */
export const PTY_ASYNC_DEADLINE_MS = 60_000;

/*
 * The Vitest timeout for a test driving a spawn-based pty child. Above
 * PTY_ASYNC_DEADLINE_MS so the driver reports the stall -- Vitest's own timeout
 * would abandon the child running rather than kill it, and names only the test.
 */
export const PTY_TEST_TIMEOUT_MS = PTY_ASYNC_DEADLINE_MS + 15_000;

/*
 * How long a spawn-based driver's child may go without printing anything.
 *
 * The 60s ceiling above cannot tell a stuck child from a slow one: both reach
 * it. A child that has stopped printing has stopped working -- it is waiting
 * for a key that is not coming (#611's shape) or has hung -- and the longest
 * deliberate silence in the scripts these drivers run is the 0.2s key read in
 * installer-ui.sh; every wait loop prints an event per poll. A child that is
 * merely slow keeps printing and reaches the ceiling instead. 20s is a hundred
 * times the longest deliberate silence and a third of the ceiling, so a stall
 * is named as a stall, 40s sooner (#698).
 */
export const PTY_IDLE_DEADLINE_MS = 20_000;

/*
 * The error every pty deadline fails with, whoever noticed it: spawnSync via
 * failOnPtyDeadline below, or a spawn-based driver's watchdog.
 */
export function ptyDeadlineError({ label, deadlineMs, reason, stdout = "", stderr = "" }) {
  return deadlineError({ label, deadlineMs, reason, subject: "pty child", stdout, stderr });
}

/*
 * Throws when a spawnSync result is a killed-on-deadline child; returns the
 * result untouched otherwise, so a driver can `return failOnPtyDeadline(...)`.
 *
 * Keyed on ETIMEDOUT rather than on `status === null && signal === "SIGKILL"`,
 * because a test that kills its own child deliberately produces that same pair
 * and is not a deadline.
 */
export function failOnPtyDeadline(result, { label, deadlineMs }) {
  if (result?.error?.code !== "ETIMEDOUT") return result;
  throw ptyDeadlineError({ label, deadlineMs, stdout: result.stdout, stderr: result.stderr });
}

/*
 * The two deadlines of a spawn-based driver -- idle and ceiling -- with the
 * pty defaults. Usage and behaviour: processWatchdog in process-budget.mjs.
 */
export function ptyWatchdog({
  label,
  kill,
  idleMs = PTY_IDLE_DEADLINE_MS,
  ceilingMs = PTY_ASYNC_DEADLINE_MS,
}) {
  return processWatchdog({ label, kill, idleMs, ceilingMs, subject: "pty child" });
}
