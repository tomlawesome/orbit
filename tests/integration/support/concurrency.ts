/** Shared helpers for tests that hold PostgreSQL locks and race requests against them. */
import { sql } from "drizzle-orm";
import { getDb } from "@/db";

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

/** Resolves once at least `minimum` sessions are queued behind an advisory lock. */
export async function waitForAdvisoryLockWaiters(minimum = 1): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await getDb().execute(sql<{ waiting: number }>`
      select count(*)::int as waiting
      from pg_locks
      where locktype = 'advisory' and granted = false
    `);
    if (Number(rows[0]?.waiting) >= minimum) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Expected ${minimum} advisory-lock waiter(s)`);
}
