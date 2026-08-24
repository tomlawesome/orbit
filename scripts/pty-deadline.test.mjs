import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { PTY_DEADLINE_MS, failOnPtyDeadline, ptyDeadlineError } from "./pty-deadline.mjs";

/*
 * Every result here comes from a real spawnSync run under `script`, never from
 * a hand-written object. The shape this module keys on is Node's, so a fixture
 * written next to the code that reads it would agree with it by construction
 * and could never catch a wrong reading (#595).
 */
function runUnderPty(command, options = {}) {
  return spawnSync("script", ["-qeE", "never", "-c", command, "/dev/null"], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    ...options,
  });
}

describe("pty deadline reporting", () => {
  it("names the deadline instead of leaving a killed child to fail an exit-code assertion", () => {
    const result = runUnderPty("sleep 30", { timeout: 250 });

    // The raw shape a test would otherwise assert against: `expect(null).toBe(130)`.
    expect(result.status).toBeNull();

    expect(() => failOnPtyDeadline(result, { label: "runUnderPty", deadlineMs: 250 }))
      .toThrow(/runUnderPty: the pty child was killed after its 250ms deadline without exiting/u);
  });

  it("says the failure is a hang or a slow runner, not a wrong exit status", () => {
    const result = runUnderPty("sleep 30", { timeout: 250 });

    expect(() => failOnPtyDeadline(result, { label: "driver", deadlineMs: 250 }))
      .toThrow(/hang or a slow runner, not a wrong exit status/u);
  });

  it("carries the output captured before the kill, so the stall can be located", () => {
    const result = runUnderPty("printf 'reached-the-profile-menu\\n'; sleep 30", { timeout: 500 });

    expect(() => failOnPtyDeadline(result, { label: "driver", deadlineMs: 500 }))
      .toThrow(/reached-the-profile-menu/u);
  });

  it("returns a child that exited on its own untouched", () => {
    const result = runUnderPty("exit 130", { timeout: 30_000 });

    expect(failOnPtyDeadline(result, { label: "driver", deadlineMs: 30_000 })).toBe(result);
    expect(result.status).toBe(130);
  });

  it("does not claim a deadline for a child killed by something else", () => {
    const result = runUnderPty("kill -KILL $$", { timeout: 30_000 });

    expect(result.status).not.toBeNull();
    expect(() => failOnPtyDeadline(result, { label: "driver", deadlineMs: 30_000 })).not.toThrow();
  });

  it("builds the same message for the drivers that kill their own child", () => {
    const error = ptyDeadlineError({
      label: "runPtyTimed",
      deadlineMs: 60_000,
      stdout: "Value: ",
      stderr: "",
    });

    expect(error.message).toMatch(/runPtyTimed: the pty child was killed after its 60000ms deadline/u);
    expect(error.message).toMatch(/Value: /u);
  });

  it("bounds the captured output so a runaway child cannot bury the message", () => {
    const error = ptyDeadlineError({ label: "driver", deadlineMs: 1000, stdout: "x".repeat(20_000) });

    expect(error.message.length).toBeLessThan(4_000);
    expect(error.message).toMatch(/the pty child was killed after its 1000ms deadline/u);
  });

  it("publishes a deadline above the durations that have been observed on CI", () => {
    // #595 was a 90s deadline reached under parallel CI load; anything at or
    // below that is known to be hit by load rather than by a real hang.
    expect(PTY_DEADLINE_MS).toBeGreaterThan(90_000);
  });
});
