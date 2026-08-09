import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { log } from "@/lib/logger";

export type PublicReadiness = { status: "ready" | "degraded" };

export interface ReadinessDependencies {
  checkDatabase?: () => Promise<unknown>;
}

let readinessDependenciesForTests: ReadinessDependencies | undefined;

export function setReadinessDependenciesForTests(dependencies: ReadinessDependencies | undefined): void {
  readinessDependenciesForTests = dependencies;
}

async function checkDatabase(): Promise<unknown> {
  if (readinessDependenciesForTests?.checkDatabase) return readinessDependenciesForTests.checkDatabase();
  return getDb().execute(sql`select 1`);
}

/** Returns only the public, content-free readiness category. */
export async function getPublicReadiness(): Promise<PublicReadiness> {
  try {
    await checkDatabase();
    log.info({ event: "application.startup", state: "ready", action: "none" });
    return { status: "ready" };
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
}
