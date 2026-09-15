import { checkDatabaseReachable } from "@/server/readiness";
import { getNotificationWorkerHealth } from "@/server/notification-worker";
import { getImapIngestionConfig, getImapIngestionWorkerHealth } from "@/server/mail-in/imap-ingestion";
import { getDocumentConfig } from "@/server/documents/config";
import { pingClamAv } from "@/server/documents/scanner";
import { getTikaHealth } from "@/server/documents/tika";

/**
 * The real answer to "what services is this instance running" (#1000),
 * replacing the five invented rows `web/src/lib/data/fixtures/admin.js` drew
 * for the mockup. Every probe here is bounded the same way
 * `document-health.ts` already bounds itself: states and timestamps only,
 * never a hostname, URL, error string or secret — an administrator's browser
 * is still a browser.
 */

const PROBE_TIMEOUT_MS = 2_000;

/** Races a probe against a hard timeout; the timeout side never rejects. */
function withTimeout<T>(promise: Promise<T>, fallback: T, timeoutMs = PROBE_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export interface AdministratorBuildInfo {
  version: string | null;
  channel: string | null;
  revision: string | null;
}

export type AdministratorServiceState = "ok" | "warn" | "down" | "off";
export type AdministratorServiceId =
  | "database"
  | "notification-worker"
  | "mailbox-ingestion"
  | "virus-scanner"
  | "document-parser";

export interface AdministratorServiceHealth {
  id: AdministratorServiceId;
  state: AdministratorServiceState;
  checkedAt: string;
  lastSuccessAt?: string | null;
  lastErrorAt?: string | null;
}

export interface AdministratorHealth {
  build: AdministratorBuildInfo;
  services: AdministratorServiceHealth[];
}

/** `process.env.ORBIT_VERSION`/`ORBIT_CHANNEL`/`ORBIT_REVISION`, each null when unset or empty. */
function readBuildInfo(): AdministratorBuildInfo {
  return {
    version: process.env.ORBIT_VERSION || null,
    channel: process.env.ORBIT_CHANNEL || null,
    revision: process.env.ORBIT_REVISION || null,
  };
}

/**
 * A background worker's state from its own `started`/`lastSuccessAt`/
 * `lastErrorAt` snapshot (notification-worker.ts, mail-in/imap-ingestion.ts).
 * `running` is deliberately not read here: it flips true only for the
 * duration of an in-flight cycle, so a snapshot catching it false is idle,
 * not unhealthy.
 */
function workerRowState(worker: {
  started: boolean;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
}): AdministratorServiceState {
  if (!worker.started) return "down";
  if (worker.lastErrorAt && (!worker.lastSuccessAt || worker.lastErrorAt > worker.lastSuccessAt)) return "warn";
  return "ok";
}

async function probeDatabase(checkedAt: string): Promise<AdministratorServiceHealth> {
  const reachable = await withTimeout(checkDatabaseReachable(), false);
  return { id: "database", state: reachable ? "ok" : "down", checkedAt };
}

function probeNotificationWorker(checkedAt: string): AdministratorServiceHealth {
  const worker = getNotificationWorkerHealth();
  return {
    id: "notification-worker",
    state: workerRowState(worker),
    checkedAt,
    lastSuccessAt: worker.lastSuccessAt,
    lastErrorAt: worker.lastErrorAt,
  };
}

async function probeMailboxIngestion(checkedAt: string): Promise<AdministratorServiceHealth> {
  const config = await withTimeout(
    getImapIngestionConfig().catch(() => null),
    null,
  );
  if (!config || !config.configured || !config.enabled) {
    return { id: "mailbox-ingestion", state: "off", checkedAt };
  }
  const worker = getImapIngestionWorkerHealth();
  return {
    id: "mailbox-ingestion",
    state: workerRowState(worker),
    checkedAt,
    lastSuccessAt: worker.lastSuccessAt,
    lastErrorAt: worker.lastErrorAt,
  };
}

async function probeVirusScanner(checkedAt: string): Promise<AdministratorServiceHealth> {
  let config;
  try {
    config = getDocumentConfig();
  } catch {
    return { id: "virus-scanner", state: "down", checkedAt };
  }
  if (config.scanMode === "disabled") return { id: "virus-scanner", state: "off", checkedAt };
  const ready = await withTimeout(
    pingClamAv({ ...config.clamAv, timeoutMs: Math.min(config.clamAv.timeoutMs, PROBE_TIMEOUT_MS) }),
    false,
  );
  return { id: "virus-scanner", state: ready ? "ok" : "down", checkedAt };
}

async function probeDocumentParser(checkedAt: string): Promise<AdministratorServiceHealth> {
  let config;
  try {
    config = getDocumentConfig();
  } catch {
    return { id: "document-parser", state: "down", checkedAt };
  }
  if (!config.tika.url) return { id: "document-parser", state: "off", checkedAt };
  const health = await withTimeout(getTikaHealth(), { status: "unavailable" as const });
  const state: AdministratorServiceState =
    health.status === "ready" ? "ok" : health.status === "disabled" ? "off" : "down";
  return { id: "document-parser", state, checkedAt };
}

/**
 * The five service rows the administration screen's Operations panel renders,
 * plus the running build's own version stamp. Never throws: a sidecar that is
 * down or unreachable answers `state: "down"` in its own row rather than
 * failing the whole screen, and the route this backs always answers 200 for
 * an administrator.
 */
export async function getAdministratorHealth(): Promise<AdministratorHealth> {
  const checkedAt = new Date().toISOString();
  try {
    const [database, mailboxIngestion, virusScanner, documentParser] = await Promise.all([
      probeDatabase(checkedAt),
      probeMailboxIngestion(checkedAt),
      probeVirusScanner(checkedAt),
      probeDocumentParser(checkedAt),
    ]);
    return {
      build: readBuildInfo(),
      services: [database, probeNotificationWorker(checkedAt), mailboxIngestion, virusScanner, documentParser],
    };
  } catch {
    // Belt and braces: every probe above already catches its own failure, so
    // this only guards against a mistake introduced later.
    const down = (id: AdministratorServiceId): AdministratorServiceHealth => ({ id, state: "down", checkedAt });
    return {
      build: readBuildInfo(),
      services: [
        down("database"),
        down("notification-worker"),
        down("mailbox-ingestion"),
        down("virus-scanner"),
        down("document-parser"),
      ],
    };
  }
}
