import { sql } from "drizzle-orm";
import { getDb } from "@/db";

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
    return { status: "ready" };
  } catch {
    return { status: "degraded" };
  }
}
