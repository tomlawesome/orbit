import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { databaseConnectionString } from "./index";

const temporaryDirectories: string[] = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => {
    rmSync(directory, { recursive: true, force: true });
  });
});

function passwordFile(value: string): string {
  const directory = mkdtempSync(join(tmpdir(), "orbit-database-secret-"));
  const path = join(directory, "postgres-password");
  temporaryDirectories.push(directory);
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  return path;
}

describe("database connection configuration", () => {
  it("uses an explicitly configured database URL", () => {
    expect(databaseConnectionString({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://example/database",
    })).toBe("postgres://example/database");
  });

  it("constructs a URL from a file-backed PostgreSQL password", () => {
    expect(databaseConnectionString({
      NODE_ENV: "test",
      POSTGRES_PASSWORD_FILE: passwordFile("password/with:symbols"),
      POSTGRES_USER: "orbit user",
      POSTGRES_DB: "orbit data",
      POSTGRES_HOST: "orbit-db",
      POSTGRES_PORT: "5433",
    })).toBe("postgres://orbit%20user:password%2Fwith%3Asymbols@orbit-db:5433/orbit%20data");
  });
});

/*
 * #1583 (L-F1): after the shutdown close a worker cycle still running must be
 * refused, not handed a freshly built pool whose sockets hold the process open.
 * The ordinary close stays reopenable (the CLI, migrations and the integration
 * suites that simulate a restart rely on it).
 */
describe("closing the database", () => {
  const postgresMock = vi.fn();
  const drizzleMock = vi.fn();
  const logMock = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  /** The client object the nth `postgres(...)` call returned. */
  function clientAt(index: number): { end: ReturnType<typeof vi.fn> } {
    return postgresMock.mock.results[index]?.value;
  }

  async function freshModule() {
    return import("./index");
  }

  beforeEach(() => {
    vi.resetModules();
    postgresMock.mockReset().mockImplementation(() => ({ end: vi.fn().mockResolvedValue(undefined) }));
    drizzleMock.mockReset().mockImplementation((client: unknown) => ({ client }));
    for (const fn of Object.values(logMock)) fn.mockReset();
    vi.doMock("postgres", () => ({ default: postgresMock }));
    vi.doMock("drizzle-orm/postgres-js", () => ({ drizzle: drizzleMock }));
    vi.doMock("@/lib/logger", () => ({ log: logMock }));
    vi.stubEnv("DATABASE_URL", "postgres://example/database");
  });

  afterEach(() => {
    vi.doUnmock("postgres");
    vi.doUnmock("drizzle-orm/postgres-js");
    vi.doUnmock("@/lib/logger");
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("refuses a read after the terminal close and builds no new pool", async () => {
    const database = (await freshModule()) as Record<string, any>;
    database.getDb();
    expect(postgresMock).toHaveBeenCalledTimes(1);

    await database.shutDownDatabase();

    expect(clientAt(0).end).toHaveBeenCalledTimes(1);
    expect(clientAt(0).end).toHaveBeenCalledWith({ timeout: 5 });

    let dbError: unknown;
    try {
      database.getDb();
    } catch (error) {
      dbError = error;
    }
    let clientError: unknown;
    try {
      database.getDatabaseClient();
    } catch (error) {
      clientError = error;
    }
    expect(dbError).toBeInstanceOf(Error);
    expect(clientError).toBeInstanceOf(Error);
    expect(postgresMock).toHaveBeenCalledTimes(1);
    // The refusal names no connection detail.
    for (const error of [dbError, clientError]) {
      const message = (error as Error).message;
      expect(message).not.toContain("example");
      expect(message).not.toContain("postgres://");
    }
  });

  it("refuses later reads when the terminal close came before any client existed", async () => {
    const database = (await freshModule()) as Record<string, any>;

    await expect(database.shutDownDatabase()).resolves.toBeUndefined();
    expect(postgresMock).not.toHaveBeenCalled();

    expect(() => database.getDb()).toThrow();
    expect(postgresMock).not.toHaveBeenCalled();
  });

  it("keeps the ordinary close reopenable", async () => {
    const { getDb, closeDatabase } = await freshModule();
    getDb();
    await closeDatabase();
    getDb();

    expect(postgresMock).toHaveBeenCalledTimes(2);
    expect(clientAt(0).end).toHaveBeenCalledTimes(1);
  });

  it("is safe to call the terminal close twice", async () => {
    const database = (await freshModule()) as Record<string, any>;
    database.getDb();

    await database.shutDownDatabase();
    await expect(database.shutDownDatabase()).resolves.toBeUndefined();

    expect(clientAt(0).end).toHaveBeenCalledTimes(1);
  });
});
