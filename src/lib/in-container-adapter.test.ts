import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "../../scripts/process-budget.mjs";
import { createInContainerAdapter, preflightPostgresClient, REPORT_TERMINATOR } from "./in-container-adapter";
import { RecoveryBundleRefusal } from "./recovery-bundle";
import { CORRESPONDENCE_QUERIES, RestoreEngineRefusal, SCAN_RECOVERY_LEASES_STATEMENT } from "./restore-engine";

// The in-container adapter (#1211 build notes E1, step 2): the backup/restore
// engine runs as a `docker compose run` one-off on the orbit-app service, so
// pg_dump/pg_restore/psql reach orbit-db over the project network and the
// document tree is the mounted volume. These tests put fake pg_dump,
// pg_restore and psql (and a logging wrapper around the real tar) on PATH and
// assert the exact argv each operation runs, and that the database password
// reaches the child only through PGPASSWORD, never its argv.

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const PASSWORD = "fixture-db-password-0f3a";
const realTar = spawnSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).stdout.trim();

const sandboxes: string[] = [];
afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

interface Fixture {
  root: string;
  documentsRoot: string;
  log: string;
  env: NodeJS.ProcessEnv;
  calls(): { tool: string; argv: string[]; pgpassword: string; stdinBytes: number }[];
  adapter: ReturnType<typeof createInContainerAdapter>;
  events: string[];
}

/** One fake per tool: logs argv (tab-separated), PGPASSWORD and stdin size, then behaves per FAKE_* env. */
function fakeTool(name: string, behaviour: string): string {
  return [
    "#!/usr/bin/env bash",
    'stdin_bytes=-1; if [[ ! -t 0 ]]; then stdin_bytes="$(wc -c | tr -d " ")"; fi',
    `{ printf '%s' ${JSON.stringify(name)}; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n%s\\n%s\\n' "PGPASSWORD=\${PGPASSWORD-<unset>}" "STDIN=$stdin_bytes"; } >> "$FAKE_LOG"`,
    behaviour,
    "",
  ].join("\n");
}

function newFixture(overrides: NodeJS.ProcessEnv = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "orbit-in-container-adapter-"));
  sandboxes.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const documentsRoot = join(root, "documents");
  mkdirSync(join(documentsRoot, "objects", "ab", "cd"), { recursive: true });
  writeFileSync(join(documentsRoot, "objects", "ab", "cd", `abcd${"0".repeat(60)}.bin`), "ciphertext");
  mkdirSync(join(documentsRoot, "portable-archives"));
  writeFileSync(join(documentsRoot, "portable-archives", "export.zip"), "household export");
  const passwordFile = join(root, "orbit-postgres-password");
  writeFileSync(passwordFile, `${PASSWORD}\n`, { mode: 0o600 });
  const log = join(root, "calls.log");
  writeFileSync(log, "");

  writeFileSync(join(bin, "pg_dump"), fakeTool("pg_dump", 'if [[ "${1:-}" == --version ]]; then printf "pg_dump (PostgreSQL) %s\\n" "${FAKE_PG_DUMP_VERSION:-18.6}"; exit 0; fi\nprintf "PGDMP-fake"\nexit "${FAKE_PG_DUMP_STATUS:-0}"'), { mode: 0o755 });
  writeFileSync(join(bin, "pg_restore"), fakeTool("pg_restore", 'exit "${FAKE_PG_RESTORE_STATUS:-0}"'), { mode: 0o755 });
  writeFileSync(
    join(bin, "psql"),
    fakeTool(
      "psql",
      'if [[ -n "${FAKE_PSQL_ROWS:-}" ]]; then yes "${FAKE_PSQL_ROW}" | head -n "$FAKE_PSQL_ROWS"; printf "%s\\n" "${FAKE_PSQL_TERMINATOR}"; exit 0; fi\nprintf "%b" "${FAKE_PSQL_STDOUT:-}"\nexit "${FAKE_PSQL_STATUS:-0}"',
    ),
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "tar"), fakeTool("tar", `exec ${JSON.stringify(realTar)} "$@"`).replace('stdin_bytes="$(wc -c | tr -d " ")"', "stdin_bytes=stream"), { mode: 0o755 });

  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_LOG: log,
    POSTGRES_USER: "orbit_user",
    POSTGRES_DB: "orbit_db",
    POSTGRES_HOST: "orbit-db",
    ...overrides,
  };
  const events: string[] = [];
  const adapter = createInContainerAdapter({ env, documentsRoot, passwordFile, emitEvent: (line) => events.push(line) });
  return {
    root,
    documentsRoot,
    log,
    env,
    adapter,
    events,
    calls() {
      const lines = readFileSync(log, "utf8").split("\n");
      const calls = [];
      for (let index = 0; index + 2 < lines.length; index += 3) {
        const [tool, ...argv] = lines[index].split("\t");
        calls.push({
          tool,
          argv,
          pgpassword: lines[index + 1].slice("PGPASSWORD=".length),
          stdinBytes: Number(lines[index + 2].slice("STDIN=".length)),
        });
      }
      return calls;
    },
  };
}

const CONNECTION = ["--host=orbit-db", "--port=5432", "--username=orbit_user", "--no-password"];

function setFake(fixture: Fixture, values: Record<string, string>): void {
  Object.assign(fixture.env, values);
}

describe("createInContainerAdapter: exact argv, password only in the environment", () => {
  it("dumpDatabase runs pg_dump in custom format against orbit-db and writes its output privately", () => {
    const fixture = newFixture();
    const output = join(fixture.root, "database.dump");
    fixture.adapter.dumpDatabase(output);
    expect(fixture.calls()).toEqual([
      {
        tool: "pg_dump",
        argv: ["--format=custom", "--compress=6", "--no-owner", "--no-acl", ...CONNECTION, "--dbname=orbit_db"],
        pgpassword: PASSWORD,
        stdinBytes: -1,
      },
    ].map((call) => ({ ...call, stdinBytes: expect.any(Number) })));
    expect(readFileSync(output, "utf8")).toBe("PGDMP-fake");
  });

  it("dumpDatabase refuses a failed or empty dump", () => {
    const fixture = newFixture();
    setFake(fixture, { FAKE_PG_DUMP_STATUS: "1" });
    expect(() => fixture.adapter.dumpDatabase(join(fixture.root, "a.dump"))).toThrow(RecoveryBundleRefusal);
  });

  it("pgRestoreListOk feeds the dump on stdin to pg_restore --list, with no database connection", () => {
    const fixture = newFixture();
    const dump = join(fixture.root, "x.dump");
    writeFileSync(dump, "12345");
    expect(fixture.adapter.pgRestoreListOk(dump)).toBe(true);
    const [call] = fixture.calls();
    expect(call.tool).toBe("pg_restore");
    expect(call.argv).toEqual(["--list"]);
    expect(call.stdinBytes).toBe(5);
    setFake(fixture, { FAKE_PG_RESTORE_STATUS: "1" });
    expect(fixture.adapter.pgRestoreListOk(dump)).toBe(false);
  });

  it("creates and drops the private stage database through psql on the postgres maintenance database", () => {
    const fixture = newFixture();
    fixture.adapter.createStageDatabase("orbit_restore_stage_1_2");
    fixture.adapter.dropStageDatabase("orbit_restore_stage_1_2");
    expect(fixture.calls().map((call) => call.argv)).toEqual([
      [...CONNECTION, "--dbname=postgres", "--set=ON_ERROR_STOP=1", '--command=CREATE DATABASE "orbit_restore_stage_1_2";'],
      [...CONNECTION, "--dbname=postgres", "--set=ON_ERROR_STOP=1", '--command=DROP DATABASE IF EXISTS "orbit_restore_stage_1_2";'],
    ]);
  });

  it("refuses a stage database name that is not a plain identifier, before running anything", () => {
    const fixture = newFixture();
    expect(() => fixture.adapter.createStageDatabase('x"; DROP DATABASE orbit; --')).toThrow(RestoreEngineRefusal);
    expect(fixture.calls()).toEqual([]);
  });

  it("restores a dump into a stage database and into the live database with restore.sh's flags", () => {
    const fixture = newFixture();
    const dump = join(fixture.root, "x.dump");
    writeFileSync(dump, "123");
    expect(fixture.adapter.restoreDumpToDatabase("orbit_restore_stage_9", dump)).toBe(true);
    expect(fixture.adapter.restoreActiveDatabase(dump)).toBe(true);
    const calls = fixture.calls();
    expect(calls.map((call) => [call.tool, ...call.argv])).toEqual([
      ["pg_restore", "--single-transaction", "--exit-on-error", "--no-owner", "--no-acl", ...CONNECTION, "--dbname=orbit_restore_stage_9"],
      ["pg_restore", "--single-transaction", "--clean", "--if-exists", "--no-owner", "--no-acl", "--exit-on-error", ...CONNECTION, "--dbname=orbit_db"],
    ]);
    expect(calls.every((call) => call.stdinBytes === 3)).toBe(true);
    setFake(fixture, { FAKE_PG_RESTORE_STATUS: "1" });
    expect(fixture.adapter.restoreActiveDatabase(dump)).toBe(false);
  });

  it("queryReport asks psql for the report and the terminator as two commands, and strips the terminator", () => {
    const fixture = newFixture();
    setFake(fixture, { FAKE_PSQL_STDOUT: `row-a|1\\nrow-b|2\\n${REPORT_TERMINATOR}\\n` });
    expect(fixture.adapter.queryReport("orbit_restore_stage_9", CORRESPONDENCE_QUERIES.crypto)).toBe("row-a|1\nrow-b|2\n");
    expect(fixture.adapter.queryActiveReport(CORRESPONDENCE_QUERIES.visible)).toBe("row-a|1\nrow-b|2\n");
    expect(fixture.calls().map((call) => call.argv)).toEqual([
      [
        ...CONNECTION,
        "--dbname=orbit_restore_stage_9",
        "--tuples-only",
        "--no-align",
        "--field-separator=|",
        "--set=ON_ERROR_STOP=1",
        `--command=${CORRESPONDENCE_QUERIES.crypto}`,
        `--command=SELECT '${REPORT_TERMINATOR}';`,
      ],
      [
        ...CONNECTION,
        "--dbname=orbit_db",
        "--tuples-only",
        "--no-align",
        "--field-separator=|",
        "--set=ON_ERROR_STOP=1",
        `--command=${CORRESPONDENCE_QUERIES.visible}`,
        `--command=SELECT '${REPORT_TERMINATOR}';`,
      ],
    ]);
  });

  it("queryReport accepts a legitimate zero-row report", () => {
    const fixture = newFixture();
    setFake(fixture, { FAKE_PSQL_STDOUT: `${REPORT_TERMINATOR}\\n` });
    expect(fixture.adapter.queryReport("s", CORRESPONDENCE_QUERIES.staging)).toBe("");
  });

  it.each([
    ["a failed query", { FAKE_PSQL_STATUS: "1", FAKE_PSQL_STDOUT: "" }],
    ["a report truncated mid-stream even though psql exited 0", { FAKE_PSQL_STDOUT: "row-a|1\\nrow-b" }],
    ["an empty report that exited 0", { FAKE_PSQL_STDOUT: "" }],
  ])("queryReport refuses %s as a report that did not run to completion (#678)", (_label, values) => {
    const fixture = newFixture();
    setFake(fixture, values);
    expect(() => fixture.adapter.queryReport("s", CORRESPONDENCE_QUERIES.crypto)).toThrow(RestoreEngineRefusal);
    expect(() => fixture.adapter.queryActiveReport(CORRESPONDENCE_QUERIES.crypto)).toThrow(RestoreEngineRefusal);
  });

  // #383: a correspondence report is one ~120-byte row per document, so
  // Node's 1 MiB spawnSync default would cut a household-sized report off
  // and call it a failed query.
  it("returns a report larger than 1 MiB intact", () => {
    const fixture = newFixture();
    const row = `11111111-1111-4111-8111-111111111111|${"ab".repeat(32)}|1234|available`;
    setFake(fixture, { FAKE_PSQL_ROWS: "20000", FAKE_PSQL_ROW: row, FAKE_PSQL_TERMINATOR: REPORT_TERMINATOR });
    const report = fixture.adapter.queryActiveReport(CORRESPONDENCE_QUERIES.crypto);
    expect(report.length).toBeGreaterThan(1024 * 1024);
    expect(report.split("\n").filter(Boolean)).toHaveLength(20000);
  });

  it("resets scan recovery leases with restore.sh's statement against the live database", () => {
    const fixture = newFixture();
    expect(fixture.adapter.resetScanRecoveryLeases()).toBe(true);
    expect(fixture.calls()[0].argv).toEqual([...CONNECTION, "--dbname=orbit_db", "--set=ON_ERROR_STOP=1", `--command=${SCAN_RECOVERY_LEASES_STATEMENT}`]);
  });

  it("records a recovery bundle export as one audit_log row carrying nothing about the bundle", () => {
    const fixture = newFixture();
    fixture.adapter.recordRecoveryBundleExported();
    expect(fixture.calls()[0].argv).toEqual([
      ...CONNECTION,
      "--dbname=orbit_db",
      "--set=ON_ERROR_STOP=1",
      "--command=insert into audit_log (entity_type, entity_id, action, changes) values ('recovery_bundle', gen_random_uuid(), 'recovery_bundle_exported', '{}'::jsonb)",
    ]);
    setFake(fixture, { FAKE_PSQL_STATUS: "1" });
    expect(() => fixture.adapter.recordRecoveryBundleExported()).toThrow(RecoveryBundleRefusal);
  });

  it("measures the live database size through pg_database_size and refuses a non-numeric answer", () => {
    const fixture = newFixture();
    setFake(fixture, { FAKE_PSQL_STDOUT: "123456\\n" });
    expect(fixture.adapter.measureLiveDatabaseSizeBytes()).toBe(123456);
    expect(fixture.calls()[0].argv).toEqual([...CONNECTION, "--dbname=orbit_db", "--tuples-only", "--no-align", "--command=select pg_database_size(current_database());"]);
    setFake(fixture, { FAKE_PSQL_STDOUT: "lots\\n" });
    expect(() => fixture.adapter.measureLiveDatabaseSizeBytes()).toThrow(RestoreEngineRefusal);
  });

  it("collects the document tree with tar from the mounted volume, leaving out the household export", () => {
    const fixture = newFixture();
    const archive = join(fixture.root, "documents.tar");
    fixture.adapter.collectDocumentsArchive(archive);
    expect(fixture.calls()[0].argv).toEqual(["-C", fixture.documentsRoot, "--exclude=./portable-archives", "-cf", "-", "."]);
    const listing = spawnSync(realTar, ["-tf", archive], { encoding: "utf8" }).stdout;
    expect(listing).toContain(`./objects/ab/cd/abcd${"0".repeat(60)}.bin`);
    expect(listing).not.toContain("portable-archives");
  });

  // #1151 SF2-F1: the tree is wherever the app itself resolves DOCUMENTS_ROOT.
  it("reads the container's own DOCUMENTS_ROOT, and falls back to the documented default", () => {
    const fixture = newFixture({ DOCUMENTS_ROOT: "/srv/orbit-documents" });
    const fromEnvironment = createInContainerAdapter({ env: fixture.env, emitEvent: () => undefined });
    expect(() => fromEnvironment.collectDocumentsArchive(join(fixture.root, "a.tar"))).toThrow(RecoveryBundleRefusal);
    const fallback = createInContainerAdapter({ env: { ...fixture.env, DOCUMENTS_ROOT: undefined }, emitEvent: () => undefined });
    expect(() => fallback.collectDocumentsArchive(join(fixture.root, "b.tar"))).toThrow(RecoveryBundleRefusal);
    expect(fixture.calls().map((call) => call.argv[1])).toEqual(["/srv/orbit-documents", "/var/lib/orbit/documents"]);
  });

  it("replaces the document tree: removes what is there, then extracts the archive with tar -xf -", () => {
    const fixture = newFixture();
    const source = join(fixture.root, "source");
    mkdirSync(join(source, "staging"), { recursive: true });
    writeFileSync(join(source, "staging", `${"e".repeat(64)}.bin`), "staged");
    const archive = join(fixture.root, "replacement.tar");
    spawnSync(realTar, ["-C", source, "-cf", archive, "."]);
    expect(fixture.adapter.replaceDocumentsFromArchive(archive)).toBe(true);
    expect(fixture.calls()[0].argv).toEqual(["-C", fixture.documentsRoot, "-xf", "-"]);
    expect(readdirSync(fixture.documentsRoot).sort()).toEqual(["staging"]);
    expect(existsSync(join(fixture.documentsRoot, "staging", `${"e".repeat(64)}.bin`))).toBe(true);
  });

  it("measures the document tree and its volume locally, without spawning anything", () => {
    const fixture = newFixture();
    expect(fixture.adapter.measureLiveDocumentTreeKib()).toBeGreaterThan(0);
    expect(fixture.adapter.measureDocumentVolumeAvailableKib()).toBeGreaterThan(0);
    expect(fixture.calls()).toEqual([]);
  });

  it("never puts the database password on a command line, and always passes it as PGPASSWORD to connecting tools", () => {
    const fixture = newFixture();
    setFake(fixture, { FAKE_PSQL_STDOUT: `1\\n${REPORT_TERMINATOR}\\n` });
    const dump = join(fixture.root, "x.dump");
    writeFileSync(dump, "1");
    fixture.adapter.dumpDatabase(join(fixture.root, "out.dump"));
    fixture.adapter.createStageDatabase("s");
    fixture.adapter.restoreDumpToDatabase("s", dump);
    fixture.adapter.restoreActiveDatabase(dump);
    fixture.adapter.queryReport("s", CORRESPONDENCE_QUERIES.crypto);
    fixture.adapter.queryActiveReport(CORRESPONDENCE_QUERIES.crypto);
    fixture.adapter.resetScanRecoveryLeases();
    setFake(fixture, { FAKE_PSQL_STDOUT: "1\\n" });
    fixture.adapter.measureLiveDatabaseSizeBytes();
    fixture.adapter.recordRecoveryBundleExported();
    fixture.adapter.dropStageDatabase("s");
    const calls = fixture.calls();
    expect(calls).toHaveLength(10);
    for (const call of calls) {
      expect(call.argv.join(" ")).not.toContain(PASSWORD);
      expect(call.pgpassword).toBe(PASSWORD);
    }
  });

  it("refuses with a database category, not a stack trace, when the password secret is missing", () => {
    const fixture = newFixture();
    const adapter = createInContainerAdapter({ env: fixture.env, documentsRoot: fixture.documentsRoot, passwordFile: join(fixture.root, "absent") });
    expect(() => adapter.dumpDatabase(join(fixture.root, "out.dump"))).toThrow(/PostgreSQL password/);
    expect(fixture.calls()).toEqual([]);
  });

  it("leaves stopping, starting and health to the shell: each returns true and says so once, on stderr's event line", () => {
    const fixture = newFixture();
    expect(fixture.adapter.stopApp()).toBe(true);
    expect(fixture.adapter.startApp()).toBe(true);
    expect(fixture.adapter.waitForHealth()).toBe(true);
    expect(fixture.calls()).toEqual([]);
    expect(fixture.events).toEqual(["phase=application component=application state=skipped reason=application-startup action=skip elapsed=0s"]);
  });

  it("defaults the connection to orbit-db:5432 as orbit/orbit when .env-orbit sets nothing", () => {
    const fixture = newFixture({ POSTGRES_USER: undefined, POSTGRES_DB: undefined, POSTGRES_HOST: undefined });
    fixture.adapter.measureDocumentVolumeAvailableKib();
    setFake(fixture, { FAKE_PSQL_STDOUT: "1\\n" });
    fixture.adapter.measureLiveDatabaseSizeBytes();
    expect(fixture.calls()[0].argv.slice(0, 5)).toEqual(["--host=orbit-db", "--port=5432", "--username=orbit", "--no-password", "--dbname=orbit"]);
  });
});

describe("preflightPostgresClient (#1211 E2: client major must match the server)", () => {
  it("passes when pg_dump's major matches server_version_num's", () => {
    const fixture = newFixture({ FAKE_PSQL_STDOUT: "180006\\n" });
    expect(() => preflightPostgresClient({ env: fixture.env, passwordFile: join(fixture.root, "orbit-postgres-password") })).not.toThrow();
    const calls = fixture.calls();
    expect(calls.map((call) => [call.tool, ...call.argv])).toEqual([
      ["pg_dump", "--version"],
      ["psql", ...CONNECTION, "--dbname=orbit_db", "--tuples-only", "--no-align", "--command=SELECT current_setting('server_version_num');"],
    ]);
  });

  it("refuses under preflight/tools when the server is a different major", () => {
    const fixture = newFixture({ FAKE_PSQL_STDOUT: "190001\\n" });
    expect(() => preflightPostgresClient({ env: fixture.env, passwordFile: join(fixture.root, "orbit-postgres-password") })).toThrow(
      /^preflight\/tools failed; .*18.*19/,
    );
  });

  it("refuses when the server cannot be reached", () => {
    const fixture = newFixture({ FAKE_PSQL_STATUS: "2" });
    expect(() => preflightPostgresClient({ env: fixture.env, passwordFile: join(fixture.root, "orbit-postgres-password") })).toThrow(/^preflight\/database failed/);
  });
});
