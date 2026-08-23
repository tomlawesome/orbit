import { describe, expect, it } from "vitest";
import { ensureMigrationRunsTable, recordMigrationOutcome } from "./migration-outcome";

function fakeClient() {
  const calls: Array<{ query: string; params?: unknown[] }> = [];
  return {
    calls,
    unsafe: async (query: string, params?: unknown[]) => {
      calls.push({ query, params });
      return [];
    },
  };
}

describe("migration outcome bookkeeping", () => {
  it("idempotently creates the schema and table without touching the drizzle journal", async () => {
    const client = fakeClient();
    await ensureMigrationRunsTable(client);

    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]?.query).toMatch(/CREATE SCHEMA IF NOT EXISTS "drizzle"/u);
    expect(client.calls[1]?.query).toMatch(/CREATE TABLE IF NOT EXISTS "drizzle"\."orbit_migration_runs"/u);
    // No interpolation anywhere in the DDL - both statements are fixed literals.
    expect(client.calls.every(({ params }) => params === undefined)).toBe(true);
  });

  it("records a successful run with a null reason, as a single insert", async () => {
    const client = fakeClient();
    const startedAt = new Date("2026-08-23T10:00:00.000Z");
    const finishedAt = new Date("2026-08-23T10:00:01.000Z");

    await recordMigrationOutcome(client, { startedAt, finishedAt, outcome: "succeeded", reason: null });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.query).toMatch(/INSERT INTO "drizzle"\."orbit_migration_runs"/u);
    expect(client.calls[0]?.params).toEqual([startedAt, finishedAt, "succeeded", null]);
  });

  it("records a failed run against a fixed enum reason token", async () => {
    const client = fakeClient();
    const startedAt = new Date("2026-08-23T10:00:00.000Z");
    const finishedAt = new Date("2026-08-23T10:00:01.000Z");

    await recordMigrationOutcome(client, { startedAt, finishedAt, outcome: "failed", reason: "migration_failed" });

    expect(client.calls[0]?.params).toEqual([startedAt, finishedAt, "failed", "migration_failed"]);
  });

  it("passes values as bind parameters rather than interpolating them into SQL", async () => {
    const client = fakeClient();
    const startedAt = new Date("2026-08-23T10:00:00.000Z");

    await recordMigrationOutcome(client, { startedAt, finishedAt: startedAt, outcome: "failed", reason: "migration_failed" });

    expect(client.calls[0]?.query).not.toContain("2026-08-23");
    expect(client.calls[0]?.query).not.toContain("migration_failed");
  });

  it("propagates a write failure to the caller rather than swallowing it", async () => {
    const client = {
      unsafe: async () => {
        throw new Error("connection refused at 10.0.0.5 for user orbit");
      },
    };

    await expect(recordMigrationOutcome(client, {
      startedAt: new Date(),
      finishedAt: new Date(),
      outcome: "failed",
      reason: "migration_failed",
    })).rejects.toThrow();
  });
});
