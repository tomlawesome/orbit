import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  KDF_TEST_TIMEOUT_MS,
  PROCESS_DEADLINE_MS,
  PROCESS_TEST_TIMEOUT_MS,
  deadlineError,
  failOnProcessDeadline,
  processGuard,
} from "./process-budget.mjs";

/*
 * As in pty-deadline.test.mjs, every result comes from a real spawnSync, never
 * a hand-written object: the shape this module keys on is Node's.
 */
function run(command, options = {}) {
  return spawnSync("bash", ["-c", command], { encoding: "utf8", ...options });
}

describe("process budgets", () => {
  it("names the deadline for a child killed on it, instead of an exit-code assertion", () => {
    const result = run("sleep 30", processGuard(250));

    expect(result.status).toBeNull();
    expect(() => failOnProcessDeadline(result, { label: "runCli", deadlineMs: 250 }))
      .toThrow(/runCli: the child was killed after its 250ms deadline without exiting/u);
  });

  it("carries the output captured before the kill", () => {
    const result = run("echo reached-configure; sleep 30", processGuard(500));

    expect(() => failOnProcessDeadline(result, { label: "runCli", deadlineMs: 500 }))
      .toThrow(/reached-configure/u);
  });

  it("returns a child that exited on its own untouched, whatever its status", () => {
    const result = run("exit 3", processGuard());

    expect(failOnProcessDeadline(result, { label: "runCli" })).toBe(result);
    expect(result.status).toBe(3);
  });

  it("does not claim a deadline for a child killed by something else", () => {
    const result = run("kill -KILL $$", processGuard());

    expect(() => failOnProcessDeadline(result, { label: "runCli" })).not.toThrow();
  });

  it("guards with SIGKILL, so a child ignoring SIGTERM still dies on the deadline", () => {
    const result = run("trap '' TERM; sleep 30", processGuard(250));

    expect(result.signal).toBe("SIGKILL");
    expect(result.error?.code).toBe("ETIMEDOUT");
  });

  it("tells a silent child from a chatty one when a watchdog says which", () => {
    expect(deadlineError({ label: "d", deadlineMs: 20_000, reason: "idle" }).message)
      .toMatch(/produced no output for 20000ms.*stuck/u);
    expect(deadlineError({ label: "d", deadlineMs: 60_000, reason: "ceiling" }).message)
      .toMatch(/still producing output 60000ms after it started.*retry loop/u);
  });

  it("keeps the guard below the verdict, so the driver speaks first", () => {
    expect(PROCESS_DEADLINE_MS).toBeLessThan(PROCESS_TEST_TIMEOUT_MS);
    // Six times the slowest observed process-driving test (12.4s, #698).
    expect(PROCESS_DEADLINE_MS).toBeGreaterThanOrEqual(6 * 5_000);
    expect(KDF_TEST_TIMEOUT_MS).toBeGreaterThan(5_000);
  });
});
