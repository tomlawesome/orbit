/*
 * Types for process-budget.mjs, so the TypeScript tests under src/ can import
 * the same budgets the scripts/ tests use. The reasoning is in the .mjs.
 */
import type { SpawnSyncReturns } from "node:child_process";

export const PROCESS_DEADLINE_MS: number;
export const PROCESS_TEST_TIMEOUT_MS: number;
export const PROCESS_IDLE_DEADLINE_MS: number;
export const KDF_TEST_TIMEOUT_MS: number;

export function deadlineError(options: {
  label: string;
  deadlineMs: number;
  reason?: "idle" | "ceiling";
  subject?: string;
  stdout?: string;
  stderr?: string;
}): Error;

export function failOnProcessDeadline<T extends SpawnSyncReturns<string> | SpawnSyncReturns<Buffer>>(
  result: T,
  options: { label: string; deadlineMs?: number },
): T;

export function processGuard(deadlineMs?: number): { timeout: number; killSignal: "SIGKILL" };

export interface ProcessWatchdog {
  touch(): void;
  stop(): void;
  readonly reason: "idle" | "ceiling" | null;
  error(captured?: { stdout?: string; stderr?: string }): Error;
}

export function processWatchdog(options: {
  label: string;
  kill: () => void;
  idleMs?: number;
  ceilingMs?: number;
  subject?: string;
}): ProcessWatchdog;
