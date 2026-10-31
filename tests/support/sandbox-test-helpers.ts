import { expect, vi } from "vitest";
import { log } from "@/lib/logger";
import {
  lastPdfSandboxChildPidForTests,
  setPdfStructureSandboxLimitsForTests,
} from "@/server/documents/pdf-structure-sandbox";

/**
 * Helpers shared by the PDF structure sandbox tests
 * (src/server/documents/pdf-structure-sandbox.test.ts and
 * pdf-structure-sandbox-file.test.ts).
 */

export const MB = 1024 * 1024;

/** Sandbox limit overrides, including the per-process memory ceilings (#1427). */
export type SandboxLimits = {
  wallMs?: number;
  startupMs?: number;
  pollMs?: number;
  concurrency?: number;
  heapMb?: number;
  structureMemoryMb?: number;
  renderMemoryMb?: number;
  pdfjsUrl?: string;
};

export function setSandboxLimits(limits: SandboxLimits | undefined): void {
  setPdfStructureSandboxLimitsForTests(limits as Parameters<typeof setPdfStructureSandboxLimitsForTests>[0]);
}

/** Everything logged at any level while `run` executes, as one string, plus the run's result. */
export async function withCapturedLogs<T>(run: () => Promise<T>): Promise<{ result: T; logged: string; calls: number }> {
  const spies = (["error", "warn", "info", "debug"] as const).map((level) =>
    vi.spyOn(log, level).mockImplementation(() => undefined));
  try {
    const result = await run();
    const recorded = spies.flatMap((spy) => spy.mock.calls);
    return { result, logged: JSON.stringify(recorded), calls: recorded.length };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

/** Highest process RSS seen while `run` executes, minus the RSS before it started. */
export async function peakRssGrowth<T>(run: () => Promise<T>): Promise<{ result: T; growthBytes: number }> {
  const before = process.memoryUsage().rss;
  let peak = before;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 15);
  try {
    const result = await run();
    peak = Math.max(peak, process.memoryUsage().rss);
    return { result, growthBytes: peak - before };
  } finally {
    clearInterval(sampler);
  }
}

/**
 * Waits up to 2 s for the job's child to be gone: `process.kill(pid, 0)`
 * throwing ESRCH. `before` is the last child pid seen before the job, so the
 * pid checked is this job's own child, not an earlier one.
 */
export async function expectChildGone(before: number | undefined): Promise<void> {
  const pid = lastPdfSandboxChildPidForTests();
  expect(pid).toEqual(expect.any(Number));
  expect(pid).not.toBe(before);
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      process.kill(pid as number, 0);
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
      return;
    }
    if (Date.now() > deadline) throw new Error(`the job's child ${pid} was still running 2 s after the job settled`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
