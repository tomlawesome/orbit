/*
 * Types for pty-deadline.mjs, so the TypeScript tests under src/ can drive a
 * pty child with the same deadlines the scripts/ tests use. The reasoning is
 * in the .mjs.
 */
import type { SpawnSyncReturns } from "node:child_process";

import type { ProcessWatchdog } from "./process-budget.mjs";

export const PTY_DEADLINE_MS: number;
export const PTY_ASYNC_DEADLINE_MS: number;
export const PTY_TEST_TIMEOUT_MS: number;
export const PTY_IDLE_DEADLINE_MS: number;

export function ptyDeadlineError(options: {
  label: string;
  deadlineMs: number;
  reason?: "idle" | "ceiling";
  stdout?: string;
  stderr?: string;
}): Error;

export function failOnPtyDeadline<T extends SpawnSyncReturns<string> | SpawnSyncReturns<Buffer>>(
  result: T,
  options: { label: string; deadlineMs: number },
): T;

export function ptyWatchdog(options: { label: string; kill: () => void; idleMs?: number; ceilingMs?: number }): ProcessWatchdog;
