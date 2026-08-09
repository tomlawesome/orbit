import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { readRuntimeSecret } from "@/lib/runtime-secret";

type Database = ReturnType<typeof drizzle<typeof schema>>;

let client: ReturnType<typeof postgres> | undefined;
let database: Database | undefined;

export function getDatabaseClient(): ReturnType<typeof postgres> {
  if (!client) client = postgres(databaseConnectionString(), { max: 10, prepare: false });
  return client;
}

export function databaseConnectionString(environment: NodeJS.ProcessEnv = process.env): string {
  const configuredUrl = readRuntimeSecret(environment, "DATABASE_URL");
  if (configuredUrl) return configuredUrl;

  const password = readRuntimeSecret(environment, "POSTGRES_PASSWORD");
  if (!password) throw new Error("DATABASE_URL or POSTGRES_PASSWORD[_FILE] is required");

  const user = environment.POSTGRES_USER || "orbit";
  const databaseName = environment.POSTGRES_DB || "orbit";
  const host = environment.POSTGRES_HOST || "localhost";
  const port = environment.POSTGRES_PORT || "5432";
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(databaseName)}`;
}

/** Creates the database connection only when a request actually needs it. */
export function getDb(): Database {
  if (database) return database;
  database = drizzle(getDatabaseClient(), { schema });
  return database;
}

export async function closeDatabase(): Promise<void> {
  await client?.end({ timeout: 5 });
  client = undefined;
  database = undefined;
}
