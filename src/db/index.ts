import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";

type Database = ReturnType<typeof drizzle<typeof schema>>;

let client: ReturnType<typeof postgres> | undefined;
let database: Database | undefined;

/** Creates the database connection only when a request actually needs it. */
export function getDb(): Database {
  if (database) return database;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  client = postgres(connectionString, { max: 10, prepare: false });
  database = drizzle(client, { schema });
  return database;
}

export async function closeDatabase(): Promise<void> {
  await client?.end({ timeout: 5 });
  client = undefined;
  database = undefined;
}
