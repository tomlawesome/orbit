import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const docker = process.platform === "win32" ? "docker.exe" : "docker";
const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const runId = randomUUID();
const safeId = runId.replaceAll("-", "");
const containerName = `orbit-integration-${safeId.slice(0, 20)}`;
const databaseName = `orbit_integration_${safeId.slice(0, 12)}`;
const databaseUser = `orbit_test_${safeId.slice(0, 8)}`;
const databasePassword = `test-only-${randomUUID()}`;
let containerStarted = false;
let cleanupStarted = false;

function capture(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
  return result.stdout.trim();
}

function run(command, args, env, label) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
}

function cleanup() {
  if (!containerStarted || cleanupStarted) return;
  cleanupStarted = true;
  const result = spawnSync(docker, ["rm", "--force", containerName], { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    console.error(`Could not remove disposable container ${containerName}`);
    process.exitCode = 1;
  }
}

function handleSignal(signal) {
  cleanup();
  process.exit(signal === "SIGINT" ? 130 : 143);
}

process.once("SIGINT", () => handleSignal("SIGINT"));
process.once("SIGTERM", () => handleSignal("SIGTERM"));

try {
  capture(docker, ["info", "--format", "{{.ServerVersion}}"], "Docker is unavailable");
  capture(docker, [
    "run",
    "--detach",
    "--rm",
    "--name",
    containerName,
    "--publish",
    "127.0.0.1::5432",
    "--env",
    `POSTGRES_DB=${databaseName}`,
    "--env",
    `POSTGRES_USER=${databaseUser}`,
    "--env",
    `POSTGRES_PASSWORD=${databasePassword}`,
    "postgres:17-alpine",
  ], "Could not start the disposable PostgreSQL container");
  containerStarted = true;

  const portOutput = capture(docker, ["port", containerName, "5432/tcp"], "Could not determine the PostgreSQL port");
  const portMatch = portOutput.match(/:(\d+)\s*$/mu);
  if (!portMatch) throw new Error("Could not determine the disposable PostgreSQL port");
  const hostPort = portMatch[1];

  const readinessDeadline = Date.now() + 60_000;
  let databaseReady = false;
  while (Date.now() < readinessDeadline) {
    const readiness = spawnSync(docker, ["exec", containerName, "pg_isready", "-U", databaseUser, "-d", databaseName], {
      stdio: "ignore",
    });
    if (readiness.status === 0) {
      databaseReady = true;
      break;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  if (!databaseReady) throw new Error("PostgreSQL did not become ready within 60 seconds");

  const integrationEnvironment = {
    ...process.env,
    APP_URL: "http://127.0.0.1:3000",
    DATABASE_URL: `postgres://${encodeURIComponent(databaseUser)}:${encodeURIComponent(databasePassword)}@127.0.0.1:${hostPort}/${encodeURIComponent(databaseName)}`,
    SESSION_SECRET: `integration-session-secret-${runId}`,
    SESSION_TTL_SECONDS: "3600",
    OIDC_ISSUER: "https://oidc.invalid.example",
    OIDC_CLIENT_ID: "orbit-integration",
    OIDC_CLIENT_SECRET: "integration-only-secret",
    ORBIT_INTEGRATION_RUN_ID: runId,
  };
  delete integrationEnvironment.DATABASE_URL_FILE;
  delete integrationEnvironment.SESSION_SECRET_FILE;
  delete integrationEnvironment.OIDC_CLIENT_SECRET_FILE;

  run(packageManager, ["exec", "tsx", "src/db/migrate.ts"], integrationEnvironment, "Database migrations");
  run(packageManager, ["exec", "vitest", "run", "--config", "vitest.integration.config.ts"], integrationEnvironment, "Integration tests");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Integration tests failed");
  process.exitCode = 1;
} finally {
  cleanup();
}
