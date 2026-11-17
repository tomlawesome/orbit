import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../../scripts/process-budget.mjs";
import { CONTRACT_PRECONDITIONS, type ContractPrecondition, runUpdatePreflight } from "../db/contract-preconditions";
import { readExpectedMigrationHashes } from "../db/migration-integrity";

// `orbit update --preflight --dir <deployment>` (#1779, build note 58520 A):
// the new image's engine asks the live database, before the installer
// replaces anything, whether this release's contract migrations would refuse.
// stdout is one line, `update-preflight: ready` (exit 0) or
// `update-preflight: blocked <column> rows=<n>` plus remedy lines (exit 1);
// every other failure is exit 2 with a bounded reason. Nothing is written.
// The CLI process tests below need no database: each refusal happens before a
// query. The line shapes are proven on runUpdatePreflight, the function the
// CLI calls, with a fake query port (SQL in, rows of text cells out).

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cli = fileURLToPath(new URL("./orbit.ts", import.meta.url));
const tsx = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const MIGRATIONS = resolve(repoRoot, "drizzle");

const sandboxes: string[] = [];
afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "orbit-cli-update-preflight-"));
  sandboxes.push(root);
  return root;
}

/** A `psql` that records that it ran and fails; a preflight that reached it wrote its argv to calls.log. */
function fakePsql(root: string): { bin: string; calls: string } {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const calls = join(root, "calls.log");
  writeFileSync(join(bin, "psql"), `#!/bin/sh\necho "$@" >> "${calls}"\nexit 2\n`);
  chmodSync(join(bin, "psql"), 0o755);
  return { bin, calls };
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = failOnProcessDeadline(
    spawnSync("node", [tsx, cli, ...args], {
      encoding: "utf8",
      env: { ...process.env, ORBIT_ENGINE_CONTEXT: "container", ...env },
      ...processGuard(),
    }),
    { label: `orbit ${args[0]}` },
  );
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe("orbit update --preflight, as a command", () => {
  it.each([
    ["an unknown flag", ["--bogus"]],
    ["--outcome", ["--outcome", "result.json"]],
    ["--action", ["--action", "update"]],
    ["--yes", ["--yes"]],
    ["a stray argument", ["backup.tar"]],
  ])("accepts no other flags: %s is a usage refusal, exit 2, nothing on stdout", (_label, extra) => {
    const root = sandbox();
    const { bin, calls } = fakePsql(root);
    const result = runCli(["update", "--preflight", "--dir", root, ...extra], { PATH: `${bin}:${process.env.PATH}` });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/usage: orbit update --preflight --dir/u);
    expect(readdirSync(root).sort(), "no database call, nothing written").toEqual(["bin"]);
    expect(existsSync(calls), "psql was never started").toBe(false);
  });

  it("requires --dir", () => {
    const result = runCli(["update", "--preflight"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/--dir/u);
  });

  it("is only for the engine container, like the other update commands", () => {
    const root = sandbox();
    const result = runCli(["update", "--preflight", "--dir", root], { ORBIT_ENGINE_CONTEXT: "" });
    // The guard's own refusal (exit 1, its text), not the exit 2 the database
    // step gives with no database behind it.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("update runs only inside the Orbit image");
    expect(result.stdout).not.toMatch(/^update-preflight: ready/mu);
  });

  it("exits 2 with a bounded reason when the database cannot be reached: no ready line, no SQL, no connection string", () => {
    const root = sandbox();
    const { bin } = fakePsql(root);
    const result = runCli(["update", "--preflight", "--dir", root], {
      PATH: `${bin}:${process.env.PATH}`,
      POSTGRES_HOST: "database.invalid",
      POSTGRES_PASSWORD_FILE: join(root, "missing"),
    });
    expect(result.status).toBe(2);
    expect(result.stdout).not.toMatch(/update-preflight: (ready|blocked)/u);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).not.toMatch(/\b(SELECT|FROM|WHERE)\b/u);
    expect(output).not.toMatch(/postgres(ql)?:\/\//u);
    expect(output).not.toMatch(/at \S+ \(.*:\d+:\d+\)/u);
    expect(output.length).toBeLessThan(1000);
  });
});

/**
 * A copy of this image's migrations folder that also ships the given tags, as a
 * release carrying those contract migrations would. Never applied by the fake
 * journal below, so each is pending.
 */
function imageCarrying(tags: string[]): string {
  const folder = join(sandbox(), "drizzle");
  cpSync(MIGRATIONS, folder, { recursive: true });
  if (tags.length === 0) return folder;
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<Record<string, unknown>> };
  for (const tag of tags) {
    writeFileSync(join(folder, `${tag}.sql`), `-- ${tag}\n`);
    journal.entries.push({ idx: journal.entries.length, version: "7", when: Date.now(), tag, breakpoints: true });
  }
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

/**
 * The preflight against a database that has applied this image's own
 * migrations (not the extra ones `carrying` adds) and holds `rowsPending`
 * documents with a plain content hash.
 */
async function preflightWith(rowsPending: number, preconditions?: ContractPrecondition[], carrying: string[] = preconditions?.map((entry) => entry.migrationTag) ?? CONTRACT_PRECONDITIONS.map((entry) => entry.migrationTag)) {
  const applied = await readExpectedMigrationHashes(MIGRATIONS);
  const issued: string[] = [];
  const result = await runUpdatePreflight({
    migrationsFolder: imageCarrying(carrying.filter((tag) => !applied.some((entry) => entry.tag === tag))),
    preconditions,
    query: async (sql: string) => {
      issued.push(sql);
      if (sql.includes("__drizzle_migrations")) return applied.map((entry) => [entry.hash]);
      return [[String(rowsPending)]];
    },
  });
  return { result, issued };
}

describe("runUpdatePreflight, the function the command calls", () => {
  const plain: ContractPrecondition = {
    migrationTag: "9999_pending_contract",
    column: "documents.content_sha256",
    description: "plain content hashes",
    pendingSql: "SELECT count(*) FROM documents WHERE content_sha256 IS NOT NULL",
    remedy: ["Orbit is still moving documents under the household key.", "Run the update again later."],
  };

  it("ready: exit 0 and exactly one line", async () => {
    const { result } = await preflightWith(0, [plain]);
    expect(result).toMatchObject({ ready: true, exitCode: 0, lines: ["update-preflight: ready"] });
  });

  it("blocked: exit 1, the blocked line first, then the remedy lines", async () => {
    const { result } = await preflightWith(7, [plain]);
    expect(result.ready).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.lines).toEqual([
      "update-preflight: blocked documents.content_sha256 rows=7",
      "Orbit is still moving documents under the household key.",
      "Run the update again later.",
    ]);
  });

  it("a blocked line carries no SQL and no connection detail", async () => {
    const { result } = await preflightWith(2, [plain]);
    expect(result.lines.join("\n")).not.toMatch(/\bSELECT\b|postgres/iu);
  });

  it("sends only reads", async () => {
    const { issued } = await preflightWith(1, [plain]);
    expect(issued.length).toBeGreaterThan(1);
    for (const sql of issued) expect(sql.trim()).toMatch(/^(SELECT|WITH|SHOW)\b/iu);
  });

  it("does not send a precondition's SQL when its migration tag is already applied", async () => {
    const expected = await readExpectedMigrationHashes(MIGRATIONS);
    const { issued, result } = await preflightWith(5, [{ ...plain, migrationTag: expected[0].tag }]);
    expect(result.lines).toEqual(["update-preflight: ready"]);
    expect(issued.some((sql) => sql.includes("content_sha256"))).toBe(false);
  });

  it("rejects when the database fails, rather than reporting ready", async () => {
    await expect(
      runUpdatePreflight({ migrationsFolder: MIGRATIONS, preconditions: [plain], query: async () => { throw new Error("connection refused"); } }),
    ).rejects.toThrow();
  });

  it("checks the shipped list by default (documents.content_sha256), for an image that ships its migration", async () => {
    const { result } = await preflightWith(3);
    expect(result.lines[0]).toBe("update-preflight: blocked documents.content_sha256 rows=3");
  });

  // A precondition gates only in the release that ships its migration: a tag
  // missing from the target image's own migrations folder is skipped.
  it("A-R1: passes for an install with plain content hashes when this image ships no drop migration (an install from v0.3.7)", async () => {
    const { result, issued } = await preflightWith(4, undefined, []);
    expect(result).toMatchObject({ ready: true, exitCode: 0, lines: ["update-preflight: ready"] });
    expect(issued.some((sql) => sql.includes("content_sha256"))).toBe(false);
  });

  it("A-R1: blocks an undrained install as before when the image carries the tagged migration", async () => {
    const { result } = await preflightWith(4, undefined, ["0017_drop_document_content_sha256"]);
    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toBe("update-preflight: blocked documents.content_sha256 rows=4");
  });
});
