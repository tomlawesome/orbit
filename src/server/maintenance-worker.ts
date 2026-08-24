import { z } from "zod";
import { activateDueMaintenanceWindow, type MaintenanceTickResult } from "@/server/maintenance";
import { log } from "@/lib/logger";

/**
 * The maintenance tick (ADR-0013 decision 5 as amended, #525 then #585).
 *
 * The tick is not what makes scheduled maintenance take effect: effective
 * state already counts a due scheduled window as active, so the scheduled
 * instant itself closes the instance on every process at once. This worker
 * exists to make that transition durable — opening the due window, or
 * absorbing it into one already open — so the state survives the claim and
 * shows up in the audit log exactly once.
 *
 * Interval is separate from the shared WORKER_POLL_SECONDS, following the
 * IMAP_POLL_SECONDS precedent, because a scheduled window should begin close
 * to its stated minute rather than up to a minute late.
 */
const maintenanceEnvironmentSchema = z.object({
  MAINTENANCE_TICK_SECONDS: z.coerce.number().int().min(5).max(3_600).default(30),
});

export interface MaintenanceWorkerConfig {
  pollMilliseconds: number;
}

export function getMaintenanceWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): MaintenanceWorkerConfig {
  const parsed = maintenanceEnvironmentSchema.parse(environment);
  return { pollMilliseconds: parsed.MAINTENANCE_TICK_SECONDS * 1_000 };
}

export interface MaintenanceWorkerHealth {
  started: boolean;
  running: boolean;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
}

/**
 * One cycle. Claims at most one due window, so a backlog of several drains
 * one tick at a time — bounded work per cycle, and the effective-state read
 * already has the instance closed regardless of how far the backlog has
 * drained.
 */
export async function runMaintenanceCycle(): Promise<MaintenanceTickResult> {
  return activateDueMaintenanceWindow();
}

const workerState = globalThis as typeof globalThis & {
  __orbitMaintenanceWorkerStarted?: boolean;
  __orbitMaintenanceWorkerRunning?: boolean;
  __orbitMaintenanceWorkerLastSuccessAt?: string;
  __orbitMaintenanceWorkerLastErrorAt?: string;
};

/** Returns only bounded, process-local maintenance worker diagnostics. */
export function getMaintenanceWorkerHealth(): MaintenanceWorkerHealth {
  return {
    started: workerState.__orbitMaintenanceWorkerStarted ?? false,
    running: workerState.__orbitMaintenanceWorkerRunning ?? false,
    lastSuccessAt: workerState.__orbitMaintenanceWorkerLastSuccessAt ?? null,
    lastErrorAt: workerState.__orbitMaintenanceWorkerLastErrorAt ?? null,
  };
}

/**
 * Starts one scheduler per application process. Running several is safe: the
 * singleton row lock and the conditional claim in
 * activateDueMaintenanceWindow are what exclude duplicates, not this flag,
 * which only guards against a hot-reload double start within one process.
 */
export function startMaintenanceWorker(config = getMaintenanceWorkerConfig()): void {
  if (workerState.__orbitMaintenanceWorkerStarted) return;
  workerState.__orbitMaintenanceWorkerStarted = true;

  const poll = async () => {
    workerState.__orbitMaintenanceWorkerRunning = true;
    try {
      const { openedWindowId, absorbedWindowId } = await runMaintenanceCycle();
      workerState.__orbitMaintenanceWorkerLastSuccessAt = new Date().toISOString();
      // Only the transition is worth a line. A quiet tick every 30 seconds
      // would be thousands of entries a day saying nothing happened, and the
      // published text is never logged either way.
      if (openedWindowId !== null || absorbedWindowId !== null) {
        log.info({ event: "maintenance.worker", state: "ready", action: "none" });
      }
    } catch {
      workerState.__orbitMaintenanceWorkerLastErrorAt = new Date().toISOString();
      log.error({
        event: "maintenance.worker",
        state: "retrying",
        reason: "worker_cycle_failed",
        action: "inspect_admin_diagnostics",
        impact: "worker_degraded",
      });
    } finally {
      workerState.__orbitMaintenanceWorkerRunning = false;
      setTimeout(poll, config.pollMilliseconds).unref();
    }
  };
  void poll();
}
