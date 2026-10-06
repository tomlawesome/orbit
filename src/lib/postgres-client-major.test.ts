import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The backup/restore engine runs pg_dump, pg_restore and psql inside the app
// image against the orbit-db service (#1211 build note E2). pg_dump refuses
// to dump a server newer than itself, and a dump from a newer client may not
// restore into an older server, so the client the image ships must be the
// same major as the server docker-compose.yml runs. This pins the two
// together: bumping one without the other fails here, not in a restore.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The runner stage's instructions, comments dropped (they may name the package too). */
function runnerStage(dockerfile: string): string {
  const start = dockerfile.search(/^FROM\s+\S+\s+AS\s+runner\s*$/m);
  if (start < 0) throw new Error("Dockerfile has no runner stage");
  return dockerfile
    .slice(start)
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

describe("PostgreSQL client in the app image (#1211 E2)", () => {
  const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
  const compose = readFileSync(join(repoRoot, "docker-compose.yml"), "utf8");

  it("the runner stage installs exactly one PostgreSQL client package", () => {
    const clients = [...runnerStage(dockerfile).matchAll(/\bpostgresql(\d+)-client\b/g)].map((match) => match[1]);
    expect(clients).toHaveLength(1);
  });

  it("the client major matches the postgres server major docker-compose.yml runs", () => {
    const clientMajor = /\bpostgresql(\d+)-client\b/.exec(runnerStage(dockerfile))?.[1];
    const serverMajors = [...compose.matchAll(/^\s*image:\s*postgres:(\d+)[-.@]/gm)].map((match) => match[1]);
    expect(serverMajors.length).toBeGreaterThan(0);
    expect(new Set(serverMajors).size).toBe(1);
    expect(clientMajor).toBe(serverMajors[0]);
  });
});
