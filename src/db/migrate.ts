import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDatabase, getDb } from "@/db";

try {
  await migrate(getDb(), { migrationsFolder: "drizzle" });
  console.log("Database migrations completed.");
} finally {
  await closeDatabase();
}
