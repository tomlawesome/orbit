import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
