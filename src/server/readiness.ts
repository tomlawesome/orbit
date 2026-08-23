import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { log } from "@/lib/logger";
import { readEffectiveMaintenance } from "@/server/maintenance";

export type PublicReadiness = { status: "ready" | "degraded" | "maintenance" };

export interface ReadinessDependencies {
  checkDatabase?: () => Promise<unknown>;
  readMaintenance?: () => Promise<{ effectivelyActive: boolean }>;
}

let readinessDependenciesForTests: ReadinessDependencies | undefined;

export function setReadinessDependenciesForTests(dependencies: ReadinessDependencies | undefined): void {
  readinessDependenciesForTests = dependencies;
}

async function checkDatabase(): Promise<unknown> {
  if (readinessDependenciesForTests?.checkDatabase) return readinessDependenciesForTests.checkDatabase();
  return getDb().execute(sql`select 1`);
}

async function readMaintenance(): Promise<{ effectivelyActive: boolean }> {
  if (readinessDependenciesForTests?.readMaintenance) return readinessDependenciesForTests.readMaintenance();
  return readEffectiveMaintenance();
}

/**
 * Returns only the public, content-free readiness category. `maintenance`
 * means healthy and deliberately closed (ADR-0013 decision 6): the process
 * must not be restarted and traffic should keep routing to it. Only a real
 * dependency failure answers `degraded` — including an unreadable
 * maintenance state, which health must not paper over.
 */
export async function getPublicReadiness(): Promise<PublicReadiness> {
  try {
    await checkDatabase();
  } catch {
    log.warn({
      event: "application.startup",
      state: "degraded",
      reason: "dependency_unavailable",
      action: "check_database",
      impact: "database_unavailable",
    });
    return { status: "degraded" };
  }
  try {
    if ((await readMaintenance()).effectivelyActive) return { status: "maintenance" };
  } catch {
    log.warn({
      event: "application.startup",
      state: "degraded",
      reason: "dependency_unavailable",
      // An unreadable maintenance state on a reachable database points at
      // the 0028 migration not having run.
      action: "check_migrations",
      impact: "application_degraded",
    });
    return { status: "degraded" };
  }
  log.info({ event: "application.startup", state: "ready", action: "none" });
  return { status: "ready" };
}
