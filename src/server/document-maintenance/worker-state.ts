/**
 * The document worker's process-local health state (#299).
 *
 * It lives on `globalThis` so a hot-reloaded module and the health endpoint
 * observe the same worker, and it is deliberately content-free: bounded flags,
 * timestamps and one failure code, never a path, filename or provider message.
 */

export interface DocumentWorkerHealth {
  started: boolean;
  running: boolean;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
  lastReconciliationAt: string | null;
}

export const workerState = globalThis as typeof globalThis & {
  __orbitDocumentWorkerStarted?: boolean;
  __orbitDocumentWorkerRunning?: boolean;
  __orbitDocumentWorkerLastSuccessAt?: string;
  __orbitDocumentWorkerLastErrorAt?: string;
  __orbitDocumentWorkerLastErrorCode?: string;
  __orbitDocumentWorkerLastReconciliationAt?: string;
};

export function getDocumentWorkerHealth(): DocumentWorkerHealth {
  return {
    started: workerState.__orbitDocumentWorkerStarted ?? false,
    running: workerState.__orbitDocumentWorkerRunning ?? false,
    lastSuccessAt: workerState.__orbitDocumentWorkerLastSuccessAt ?? null,
    lastErrorAt: workerState.__orbitDocumentWorkerLastErrorAt ?? null,
    lastErrorCode: workerState.__orbitDocumentWorkerLastErrorCode ?? null,
    lastReconciliationAt: workerState.__orbitDocumentWorkerLastReconciliationAt ?? null,
  };
}
