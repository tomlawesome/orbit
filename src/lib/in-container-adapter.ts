import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import { closeSync, constants, fchmodSync, fstatSync, openSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { formatEngineEventLine } from "./engine-event";
import { applyHostOwnership } from "./host-ownership";
import { type BackupDockerAdapter, RecoveryBundleRefusal, SECURE_FILE_MODE } from "./recovery-bundle";
import {
  type RestoreDockerAdapter,
  RestoreEngineRefusal,
  SCAN_RECOVERY_LEASES_STATEMENT,
  directoryUsageKib,
  filesystemAvailableKib,
} from "./restore-engine";

// The backup/restore engine's adapter when it runs inside the deployment
// (#1211 build note E1). scripts/backup.sh, restore.sh and the recovery-
// bundle scripts run `orbit` as a `docker compose run --rm --no-deps` one-off
// on the orbit-app service, so this process already sits on the project
// network (orbit-db is reachable over TCP), has the compose secrets mounted
// under /run/secrets, and has the document volume mounted at DOCUMENTS_ROOT.
// Every Postgres and document-tree step therefore runs here, locally — the
// sidecar-job pattern: run the tool where the data is, rather than remote-
// exec into other containers from the host. Nothing here touches Docker;
// stopping and starting orbit-app is the shell's job (E3), so those three
// methods only report that.
//
// The database password is read from the mounted secret and handed to each
// child through PGPASSWORD in its own environment only, never its argv
// (where `ps` and /proc/<pid>/cmdline would show it).

/** The last line of every correspondence report, proving the query ran to completion (restore.sh's report_terminator, #678). */
export const REPORT_TERMINATOR = "ORBIT_REPORT_END";

const DEFAULT_PASSWORD_FILE = "/run/secrets/orbit-postgres-password";
const DEFAULT_DOCUMENTS_ROOT = "/var/lib/orbit/documents";
/** A correspondence report is one row per document; see PSQL_REPORT_MAX_BUFFER's history in restore-engine (#383). */
const REPORT_MAX_BUFFER = 1024 * 1024 * 1024;
const STAGE_DATABASE_NAME = /^[A-Za-z0-9_]+$/;
const RECORD_RECOVERY_BUNDLE_EXPORTED_SQL =
  "insert into audit_log (entity_type, entity_id, action, changes) values ('recovery_bundle', gen_random_uuid(), 'recovery_bundle_exported', '{}'::jsonb)";

export interface InContainerAdapterOptions {
  /** Environment the connection settings are read from and children inherit (defaults to process.env; tests put fakes on its PATH). */
  env?: NodeJS.ProcessEnv;
  /** The mounted document volume (defaults to DOCUMENTS_ROOT, then /var/lib/orbit/documents, as docker-compose.yml mounts it). */
  documentsRoot?: string;
  /** The compose secret holding the database password. */
  passwordFile?: string;
  /** Where the one "the shell owns the app lifecycle" event line goes (defaults to stderr: stdout carries the command's result). */
  emitEvent?: (line: string) => void;
}

interface Connection {
  host: string;
  port: string;
  user: string;
  database: string;
}

function connectionFrom(env: NodeJS.ProcessEnv): Connection {
  return {
    host: env.POSTGRES_HOST || "orbit-db",
    port: env.POSTGRES_PORT || "5432",
    user: env.POSTGRES_USER || "orbit",
    database: env.POSTGRES_DB || "orbit",
  };
}

function connectionArgs(connection: Connection): string[] {
  return [`--host=${connection.host}`, `--port=${connection.port}`, `--username=${connection.user}`, "--no-password"];
}

function refuseDatabase(message: string): never {
  throw new RestoreEngineRefusal(message, "database-connection-failed");
}

function readPassword(passwordFile: string): string {
  let content: string;
  try {
    const descriptor = openSync(passwordFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      content = readFileSync(descriptor, "utf8");
    } finally {
      closeSync(descriptor);
    }
  } catch {
    refuseDatabase("preflight/database failed; the PostgreSQL password secret could not be read.");
  }
  const password = content.replace(/[\r\n]+$/, "");
  if (password === "") refuseDatabase("preflight/database failed; the PostgreSQL password secret is empty.");
  return password;
}

/** A private output file, owned by the host operator when it lands under a host mount (a checkpoint's dump and document tar, #1211 E6). */
function openPrivateOutput(path: string): number {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, SECURE_FILE_MODE);
  fchmodSync(descriptor, SECURE_FILE_MODE);
  applyHostOwnership(path);
  return descriptor;
}

function openInput(path: string): number {
  return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
}

/** Runs `fn` with `path` open read-only (O_NOFOLLOW) as a descriptor, closing it afterwards. */
function withInput<T>(path: string, fn: (descriptor: number) => T): T {
  const descriptor = openInput(path);
  try {
    return fn(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

class PostgresTools {
  private password: string | undefined;
  readonly connection: Connection;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly passwordFile: string,
  ) {
    this.connection = connectionFrom(env);
  }

  /** The child environment for a connecting tool: the caller's, plus PGPASSWORD. */
  private connectingEnv(): NodeJS.ProcessEnv {
    this.password ??= readPassword(this.passwordFile);
    return { ...this.env, PGPASSWORD: this.password };
  }

  run(tool: "pg_dump" | "pg_restore" | "psql", args: string[], options: SpawnSyncOptions & { connect: boolean }) {
    const { connect, ...spawnOptions } = options;
    const env = connect ? this.connectingEnv() : this.env;
    return spawnSync(tool, args, { ...spawnOptions, env });
  }

  psql(database: string, args: string[], options: SpawnSyncOptions = {}) {
    return this.run("psql", [...connectionArgs(this.connection), `--dbname=${database}`, ...args], {
      stdio: ["ignore", "pipe", "inherit"],
      encoding: "utf8",
      ...options,
      connect: true,
    });
  }
}

/**
 * Strips the terminator from a report, or refuses when it is missing: an
 * empty or truncated report is indistinguishable from "no rows" without it
 * (restore.sh's accept_report, #678). The caller turns the refusal into the
 * check-naming `<stage>/correspondence-incomplete` message.
 */
function acceptReport(status: number | null, stdout: string): string {
  const lines = stdout.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (status !== 0 || lines.at(-1) !== REPORT_TERMINATOR) {
    throw new RestoreEngineRefusal("A correspondence report did not run to completion.", "query-report-failed");
  }
  lines.pop();
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function requireStageDatabaseName(name: string): void {
  if (!STAGE_DATABASE_NAME.test(name)) {
    throw new RestoreEngineRefusal("preflight/database-stage failed; a private staging database name was not a plain identifier.", "stage-database-failed");
  }
}

function removeChildren(directory: string): void {
  for (const entry of readdirSync(directory)) rmSync(join(directory, entry), { recursive: true, force: true });
}

export type InContainerAdapter = BackupDockerAdapter & RestoreDockerAdapter;

export function createInContainerAdapter(options: InContainerAdapterOptions = {}): InContainerAdapter {
  const env = options.env ?? process.env;
  const documentsRoot = options.documentsRoot ?? (env.DOCUMENTS_ROOT || DEFAULT_DOCUMENTS_ROOT);
  const tools = new PostgresTools(env, options.passwordFile ?? DEFAULT_PASSWORD_FILE);
  const database = tools.connection.database;
  const emitEvent = options.emitEvent ?? ((line: string) => process.stderr.write(`${line}\n`));
  let lifecycleReported = false;

  /** stopApp/startApp/waitForHealth: the shell stops orbit-app before the engine runs and starts it afterwards (#1211 E3). */
  const shellOwnsLifecycle = (): true => {
    if (!lifecycleReported) {
      lifecycleReported = true;
      emitEvent(formatEngineEventLine({ phase: "application", component: "application", state: "skipped", reason: "application-startup", action: "skip" }, 0));
    }
    return true;
  };

  const report = (databaseName: string, query: string): string => {
    const result = tools.psql(
      databaseName,
      ["--tuples-only", "--no-align", "--field-separator=|", "--set=ON_ERROR_STOP=1", `--command=${query}`, `--command=SELECT '${REPORT_TERMINATOR}';`],
      { maxBuffer: REPORT_MAX_BUFFER, stdio: ["ignore", "pipe", "ignore"] },
    );
    return acceptReport(result.status, typeof result.stdout === "string" ? result.stdout : "");
  };

  const restore = (args: string[], databaseName: string, dumpPath: string): boolean =>
    withInput(dumpPath, (descriptor) =>
      tools.run("pg_restore", [...args, ...connectionArgs(tools.connection), `--dbname=${databaseName}`], { stdio: [descriptor, "ignore", "inherit"], connect: true }),
    ).status === 0;

  const measure = (measurement: () => number, message: string): number => {
    try {
      return measurement();
    } catch {
      throw new RestoreEngineRefusal(message, "capacity-measurement-invalid");
    }
  };

  return {
    stopApp: shellOwnsLifecycle,
    startApp: shellOwnsLifecycle,
    waitForHealth: shellOwnsLifecycle,

    dumpDatabase(outputPath: string): void {
      const descriptor = openPrivateOutput(outputPath);
      try {
        const result = tools.run(
          "pg_dump",
          ["--format=custom", "--compress=6", "--no-owner", "--no-acl", ...connectionArgs(tools.connection), `--dbname=${database}`],
          { stdio: ["ignore", descriptor, "inherit"], connect: true },
        );
        if (result.status !== 0) throw new RecoveryBundleRefusal("PostgreSQL could not be dumped.", "database-dump-failed");
        if (fstatSync(descriptor).size === 0) throw new RecoveryBundleRefusal("PostgreSQL produced an empty backup.", "empty-database-dump");
      } finally {
        closeSync(descriptor);
      }
    },

    pgRestoreListOk(dumpPath: string): boolean {
      return withInput(dumpPath, (descriptor) => tools.run("pg_restore", ["--list"], { stdio: [descriptor, "ignore", "ignore"], connect: false })).status === 0;
    },

    collectDocumentsArchive(outputPath: string): void {
      const descriptor = openPrivateOutput(outputPath);
      try {
        // SS2-S1: the household portable-archive export is not part of a backup.
        const result = spawnSync("tar", ["-C", documentsRoot, "--exclude=./portable-archives", "-cf", "-", "."], { env, stdio: ["ignore", descriptor, "inherit"] });
        if (result.status !== 0) throw new RecoveryBundleRefusal("The document archive could not be collected.", "document-archive-collection-failed");
      } finally {
        closeSync(descriptor);
      }
    },

    recordRecoveryBundleExported(): void {
      const result = tools.psql(database, ["--set=ON_ERROR_STOP=1", `--command=${RECORD_RECOVERY_BUNDLE_EXPORTED_SQL}`], { stdio: ["ignore", "ignore", "inherit"] });
      if (result.status !== 0) {
        throw new RecoveryBundleRefusal(
          "The recovery bundle was created but could not be recorded; the administration card will not clear.",
          "recovery-bundle-record-failed",
        );
      }
    },

    createStageDatabase(name: string): void {
      requireStageDatabaseName(name);
      const result = tools.psql("postgres", ["--set=ON_ERROR_STOP=1", `--command=CREATE DATABASE "${name}";`], { stdio: ["ignore", "ignore", "inherit"] });
      if (result.status !== 0) {
        throw new RestoreEngineRefusal("preflight/database-stage failed; a private staging database could not be created.", "stage-database-failed");
      }
    },

    dropStageDatabase(name: string): void {
      if (!STAGE_DATABASE_NAME.test(name)) return;
      try {
        tools.psql("postgres", ["--set=ON_ERROR_STOP=1", `--command=DROP DATABASE IF EXISTS "${name}";`], { stdio: ["ignore", "ignore", "ignore"] });
      } catch {
        // Best-effort, like restore.sh's `|| true`.
      }
    },

    restoreDumpToDatabase(name: string, dumpPath: string): boolean {
      requireStageDatabaseName(name);
      return restore(["--single-transaction", "--exit-on-error", "--no-owner", "--no-acl"], name, dumpPath);
    },

    restoreActiveDatabase(dumpPath: string): boolean {
      return restore(["--single-transaction", "--clean", "--if-exists", "--no-owner", "--no-acl", "--exit-on-error"], database, dumpPath);
    },

    replaceDocumentsFromArchive(archivePath: string): boolean {
      return withInput(archivePath, (descriptor) => {
        try {
          removeChildren(documentsRoot);
        } catch {
          return false;
        }
        // Flags identical to restore.sh's replace_documents_from_archive: as
        // root, tar keeps each entry's owner from the archive.
        return spawnSync("tar", ["-C", documentsRoot, "-xf", "-"], { env, stdio: [descriptor, "ignore", "inherit"] }).status === 0;
      });
    },

    resetScanRecoveryLeases(): boolean {
      return tools.psql(database, ["--set=ON_ERROR_STOP=1", `--command=${SCAN_RECOVERY_LEASES_STATEMENT}`], { stdio: ["ignore", "ignore", "inherit"] }).status === 0;
    },

    queryReport(name: string, query: string): string {
      return report(name, query);
    },

    queryActiveReport(query: string): string {
      return report(database, query);
    },

    measureLiveDatabaseSizeBytes(): number {
      const result = tools.psql(database, ["--tuples-only", "--no-align", "--command=select pg_database_size(current_database());"]);
      const value = (typeof result.stdout === "string" ? result.stdout : "").trim();
      if (result.status !== 0 || !/^[0-9]+$/.test(value)) {
        throw new RestoreEngineRefusal("preflight/capacity failed; current database size could not be measured.", "capacity-measurement-invalid");
      }
      return Number(value);
    },

    measureLiveDocumentTreeKib(): number {
      return measure(() => directoryUsageKib(documentsRoot), "preflight/capacity failed; current document usage could not be measured.");
    },

    measureDocumentVolumeAvailableKib(): number {
      return measure(() => filesystemAvailableKib(documentsRoot), "preflight/capacity failed; document-volume capacity could not be checked.");
    },
  };
}

export interface PreflightPostgresClientOptions {
  env?: NodeJS.ProcessEnv;
  passwordFile?: string;
}

/**
 * #1211 build note E2: refuses before any dump when the image's pg_dump is a
 * different major from the server it would dump. pg_dump refuses a newer
 * server outright, and a dump from a newer client may not restore into an
 * older one; src/lib/postgres-client-major.test.ts keeps the image and
 * docker-compose.yml in step, and this catches a deployment that pinned its
 * own server image.
 */
export function preflightPostgresClient(options: PreflightPostgresClientOptions = {}): void {
  const env = options.env ?? process.env;
  const tools = new PostgresTools(env, options.passwordFile ?? DEFAULT_PASSWORD_FILE);
  const version = tools.run("pg_dump", ["--version"], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", connect: false });
  const clientMajor = /\(PostgreSQL\) (\d+)/.exec(typeof version.stdout === "string" ? version.stdout : "")?.[1];
  if (version.status !== 0 || clientMajor === undefined) {
    throw new RestoreEngineRefusal("preflight/tools failed; pg_dump is not available in this image.", "postgres-client-mismatch");
  }
  const server = tools.psql(tools.connection.database, ["--tuples-only", "--no-align", "--command=SELECT current_setting('server_version_num');"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const serverVersion = (typeof server.stdout === "string" ? server.stdout : "").trim();
  if (server.status !== 0 || !/^[0-9]+$/.test(serverVersion)) {
    refuseDatabase("preflight/database failed; the PostgreSQL server could not be reached to check its version.");
  }
  const serverMajor = String(Math.floor(Number(serverVersion) / 10_000));
  if (serverMajor !== clientMajor) {
    throw new RestoreEngineRefusal(
      `preflight/tools failed; this image's pg_dump is PostgreSQL ${clientMajor} but the database server is PostgreSQL ${serverMajor}. Run the Orbit image built for this server.`,
      "postgres-client-mismatch",
    );
  }
}
