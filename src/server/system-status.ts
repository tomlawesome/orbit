import { getPublicReadiness, checkDatabaseReachable } from "@/server/readiness";
import { getBootPhase } from "@/server/boot";
import { getMaintenanceWorkerHealth } from "@/server/maintenance-worker";
import { getDocumentConfig } from "@/server/documents/config";
import { pingClamAv } from "@/server/documents/scanner";
import { getTikaHealth } from "@/server/documents/tika";

/**
 * The system-status drawer's own vocabulary (#863). State words only, never a
 * reason, a version or a path: the drawer sits behind sign-in, not behind the
 * administrator gate (#869's ruling, owner 2026-09-06 -- "per-subsystem truth
 * belongs on this drawer, behind sign-in"), so any signed-in reader can reach
 * it. Naming WHY a dependency is down to that audience is reconnaissance, the
 * same reasoning `/api/health`'s public/private split already follows.
 */
export type ServiceState = "healthy" | "unreachable" | "starting" | "not_enabled";

export type ServiceName = "orbit-app" | "orbit-postgres" | "orbit-clamav" | "orbit-tika" | "scheduler";

export interface ServiceRow {
  service: ServiceName;
  state: ServiceState;
  /** The instant this state was actually observed. Omitted, never guessed, when there is none. */
  observedAt?: string;
}

export type ScanReadiness = "ready" | "failed" | "disabled";

export type ApplicationReadiness = "ready" | "degraded" | "maintenance";

export interface SystemStatus {
  /** The drawer handle's own word -- the same readiness contract `/api/health` answers with. */
  handle: ApplicationReadiness;
  services: ServiceRow[];
  lastCheck: {
    /** Omitted when the scanner's own configuration could not be read at all. */
    scan?: ScanReadiness;
    application: ApplicationReadiness;
  };
}

/**
 * The scanner row and the scan-readiness word share one probe, so they can
 * never disagree about whether ClamAV answered. A document-configuration
 * failure reports neither -- an unreadable configuration is not evidence the
 * scanner is down, so it stays unclaimed rather than asserted either way.
 */
async function scannerStatus(): Promise<{ row: ServiceRow | null; scan: ScanReadiness | null }> {
  let config;
  try {
    config = getDocumentConfig();
  } catch {
    return { row: null, scan: null };
  }
  if (config.scanMode === "disabled") {
    return { row: { service: "orbit-clamav", state: "not_enabled" }, scan: "disabled" };
  }
  const observedAt = new Date().toISOString();
  let reachable = false;
  try {
    reachable = await pingClamAv({ ...config.clamAv, timeoutMs: Math.min(config.clamAv.timeoutMs, 2_000) });
  } catch {
    reachable = false;
  }
  return {
    row: { service: "orbit-clamav", state: reachable ? "healthy" : "unreachable", observedAt },
    scan: reachable ? "ready" : "failed",
  };
}

async function tikaStatus(): Promise<ServiceRow | null> {
  let health;
  try {
    health = await getTikaHealth();
  } catch {
    return null;
  }
  if (health.status === "disabled") return { service: "orbit-tika", state: "not_enabled" };
  return {
    service: "orbit-tika",
    state: health.status === "ready" ? "healthy" : "unreachable",
    observedAt: new Date().toISOString(),
  };
}

/**
 * The maintenance worker's own process-local flags, read as a row rather
 * than the raw shape `getMaintenanceWorkerHealth` answers with. Its
 * timestamp is a real one -- the last tick that actually ran -- not the
 * instant of this request, unlike the live-probed rows above.
 */
function schedulerRow(): ServiceRow {
  const worker = getMaintenanceWorkerHealth();
  if (!worker.started) return { service: "scheduler", state: "starting" };
  if (worker.lastErrorAt && (!worker.lastSuccessAt || worker.lastErrorAt > worker.lastSuccessAt)) {
    return { service: "scheduler", state: "unreachable", observedAt: worker.lastErrorAt };
  }
  if (worker.lastSuccessAt) return { service: "scheduler", state: "healthy", observedAt: worker.lastSuccessAt };
  // Started, but its first tick has not completed yet: a real, transient state.
  return { service: "scheduler", state: "starting" };
}

/**
 * Real per-service state for the system-status drawer (#863), assembled
 * entirely from checks the instance already runs for itself: the same
 * {@link getPublicReadiness} contract `/api/health` answers with, the
 * maintenance worker's own health flags, and the document subsystem's
 * scanner and Tika probes. Nothing here is a new check -- it only projects
 * what already exists into the shape the drawer draws, and drops a row
 * entirely rather than asserting a state it never observed.
 */
async function computeSystemStatus(): Promise<SystemStatus> {
  const [readiness, databaseReachable, scanner, tika] = await Promise.all([
    getPublicReadiness(),
    checkDatabaseReachable(),
    scannerStatus(),
    tikaStatus(),
  ]);
  const observedAt = new Date().toISOString();

  const services: ServiceRow[] = [
    { service: "orbit-app", state: getBootPhase() === "running" ? "healthy" : "starting", observedAt },
    { service: "orbit-postgres", state: databaseReachable ? "healthy" : "unreachable", observedAt },
  ];
  if (scanner.row) services.push(scanner.row);
  if (tika) services.push(tika);
  services.push(schedulerRow());

  return {
    handle: readiness.status,
    services,
    lastCheck: {
      ...(scanner.scan ? { scan: scanner.scan } : {}),
      application: readiness.status,
    },
  };
}

/**
 * Every signed-in household member's `/home` render calls this once
 * (+page.server.js), and `/home` is the product's main screen: with no cache
 * a plain page load pings ClamAV and Tika directly, and a burst of loads --
 * several members open at once, one tab regaining focus, a client retry --
 * turns into that many concurrent sidecar probes.
 *
 * 5 seconds, the same interval `src/server/boot.ts`'s own
 * `SCANNER_READINESS_RETRY_INTERVAL_MS` already re-probes ClamAV at during
 * startup -- this reuses that instance's own idea of how often the scanner
 * is worth asking again, rather than inventing a second number. Short enough
 * that an operator watching during a real incident sees it recover within a
 * couple of reloads; long enough to collapse the common case (a burst of
 * `/home` renders within the same few seconds) into one probe.
 */
const STATUS_CACHE_TTL_MS = 5_000;

let cachedStatus: { status: SystemStatus; expiresAt: number } | undefined;
/** The one in-flight computation, so concurrent callers coalesce onto it instead of each starting their own probe. */
let inFlight: Promise<SystemStatus> | undefined;

/**
 * Test-only: clears the module-level cache and any in-flight computation, so
 * one test's answer cannot leak into the next.
 */
export function resetSystemStatusCacheForTests(): void {
  cachedStatus = undefined;
  inFlight = undefined;
}

/**
 * The cached, coalesced entry point the drawer's route calls.
 *
 * A cache hit returns the exact object `computeSystemStatus` built -- every
 * row's `observedAt` stays the instant it was actually probed, never
 * restamped to the instant of the cache hit, which is the whole point of
 * #863 (a timestamp the drawer did not observe is exactly what it must not
 * assert). A miss with no computation already running starts exactly one,
 * and every other caller in that window awaits the same promise rather than
 * starting its own.
 */
export async function getSystemStatus(): Promise<SystemStatus> {
  const now = Date.now();
  if (cachedStatus && cachedStatus.expiresAt > now) return cachedStatus.status;
  if (inFlight) return inFlight;

  inFlight = computeSystemStatus();
  try {
    const status = await inFlight;
    cachedStatus = { status, expiresAt: Date.now() + STATUS_CACHE_TTL_MS };
    return status;
  } finally {
    inFlight = undefined;
  }
}
