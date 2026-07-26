import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { AppError } from "@/lib/app-error";

/** Returns the current instance-wide administrator state for an authenticated user. */
export async function isInstanceAdministrator(userId: string): Promise<boolean> {
  const [user] = await getDb()
    .select({ isInstanceAdmin: users.isInstanceAdmin })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return user?.isInstanceAdmin ?? false;
}

export async function requireInstanceAdministrator(userId: string): Promise<void> {
  if (!await isInstanceAdministrator(userId)) {
    throw new AppError("administrator_required", "Orbit administrator access is required", 403);
  }
}
