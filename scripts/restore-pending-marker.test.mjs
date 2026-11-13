import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

// #1823 (note 57995) O-S1 and O-S2, restore.sh side. Written from the
// specification alone. restore.sh writes `<deployment folder>/.orbit-restore-pending`
// (the absolute journal path) before it stops Orbit and removes it only together
// with the journal. `restore.sh --finish`'s "Start Orbit" failure names the exact
// compose start command, the one repair's lock message names.

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const dirs = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});
const scratch = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

// Fake docker. `stop` records whether the marker existed (and its content) at
// that moment. The engine (`compose run`): --preflight does nothing; --recover
// and --finish remove FAKE_JOURNAL; a full restore writes FAKE_JOURNAL with
// state=FAKE_JOURNAL_STATE when that is set. Exit FAKE_ENGINE_STATUS.
const FAKE_DOCKER = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
if (argv[0] === "info") { process.stdout.write("[name=seccomp,profile=builtin name=cgroupns]\\n"); process.exit(0); }
if (argv[0] === "wait") { process.stdout.write("0\\n"); process.exit(0); }
if (argv[0] !== "compose") process.exit(1);
if (argv[1] === "version") process.exit(0);
let i = 1;
while (argv[i] === "--project-name" || argv[i] === "--env-file") i += 2;
const verb = argv[i];
const marker = process.env.FAKE_MARKER;
if (verb === "stop") {
  let seen = "absent";
  try { seen = fs.readFileSync(marker, "utf8"); } catch {}
  fs.appendFileSync(process.env.FAKE_LOG, "stop-saw-marker=" + JSON.stringify(seen) + "\\n");
  process.exit(0);
}
if (verb === "start") { fs.appendFileSync(process.env.FAKE_LOG, "start\\n"); process.exit(0); }
if (verb === "run") {
  if (argv.includes("--preflight")) process.exit(0);
  const journal = process.env.FAKE_JOURNAL;
  if (argv.includes("--recover") || argv.includes("--finish")) {
    fs.rmSync(journal, { force: true });
    process.exit(Number(process.env.FAKE_ENGINE_STATUS || 0));
  }
  if (process.env.FAKE_JOURNAL_STATE) {
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(journal, "format_version=1\\nstate=" + process.env.FAKE_JOURNAL_STATE + "\\n");
  }
  process.exit(Number(process.env.FAKE_ENGINE_STATUS || 0));
}
process.exit(1);
`;

function makeDeployment({ customBackups = false } = {}) {
  const deployDir = scratch("orbit-restore-marker-");
  mkdirSync(join(deployDir, "scripts"));
  writeFileSync(join(deployDir, "scripts", "restore.sh"), readFileSync(join(scriptsDir, "restore.sh")));
  writeFileSync(join(deployDir, ".env-orbit"), "ORBIT_IMAGE=orbit-local:abcdef123456\n", { mode: 0o600 });
  mkdirSync(join(deployDir, ".orbit-secrets"), { mode: 0o700 });
  writeFileSync(join(deployDir, ".orbit-secrets", "document-kek"), `${"a".repeat(64)}\n`, { mode: 0o600 });
  const binDir = join(deployDir, "fakebin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "docker"), FAKE_DOCKER);
  writeFileSync(join(binDir, "curl"), `#!/usr/bin/env bash\nexit "\${FAKE_CURL_STATUS:-0}"\n`);
  chmodSync(join(binDir, "docker"), 0o755);
  chmodSync(join(binDir, "curl"), 0o755);
  const backups = customBackups ? scratch("orbit-restore-backups-") : join(deployDir, "backups");
  return {
    deployDir,
    binDir,
    backups,
    customBackups,
    journal: join(backups, ".orbit-restore", "restore.journal"),
    marker: join(deployDir, ".orbit-restore-pending"),
    log: join(binDir, "log"),
  };
}

function run(d, args, env = {}) {
  rmSync(d.log, { force: true });
  const result = failOnProcessDeadline(
    spawnSync("bash", [join(d.deployDir, "scripts", "restore.sh"), ...args], {
      cwd: d.deployDir,
      encoding: "utf8",
      input: "",
      env: {
        PATH: `${d.binDir}:${process.env.PATH}`,
        HOME: process.env.HOME ?? tmpdir(),
        FAKE_LOG: d.log,
        FAKE_MARKER: d.marker,
        FAKE_JOURNAL: d.journal,
        ORBIT_RESTORE_HEALTH_SECONDS: "1",
        ...(d.customBackups ? { ORBIT_BACKUP_DIR: d.backups } : {}),
        ...env,
      },
      ...processGuard(),
    }),
    { label: `restore.sh ${args.join(" ")}` },
  );
  return { ...result, log: existsSync(d.log) ? readFileSync(d.log, "utf8") : "" };
}

function bundleIn(d) {
  const bundle = join(d.deployDir, "b.tar");
  writeFileSync(bundle, "bundle");
  return bundle;
}
const UNATTENDED = { ORBIT_NONINTERACTIVE_RESTORE: "true" };

describe.each([
  ["the default backups folder", false],
  ["ORBIT_BACKUP_DIR", true],
])("#1823 O-S1 restore.sh marker (%s)", (_name, custom) => {
  it("writes the marker, holding the absolute journal path, before it stops Orbit", () => {
    const d = makeDeployment({ customBackups: custom });
    run(d, ["--yes", bundleIn(d)], { ...UNATTENDED, FAKE_JOURNAL_STATE: "checkpointed", FAKE_ENGINE_STATUS: "1" });
    // The marker was already there, with the journal path, when `compose stop` ran.
    const expected = JSON.stringify(`${d.journal}\n`);
    const loose = JSON.stringify(d.journal);
    const line = readFileSync(d.log, "utf8").split("\n").find((l) => l.startsWith("stop-saw-marker="));
    expect(line, "compose stop should have been called").toBeDefined();
    const seen = JSON.parse(line.slice("stop-saw-marker=".length));
    expect(seen).not.toBe("absent");
    expect(seen.trim()).toBe(JSON.parse(loose));
    expect(expected).toContain(JSON.parse(loose));
  });

  it("keeps the marker while the journal is left (a failed restore)", () => {
    const d = makeDeployment({ customBackups: custom });
    const result = run(d, ["--yes", bundleIn(d)], { ...UNATTENDED, FAKE_JOURNAL_STATE: "checkpointed", FAKE_ENGINE_STATUS: "1" });
    expect(result.status).not.toBe(0);
    expect(existsSync(d.journal)).toBe(true);
    expect(lstatSync(d.marker).isFile()).toBe(true);
    expect(readFileSync(d.marker, "utf8").trim()).toBe(d.journal);
  });

  it("removes the marker together with the journal when the restore finishes (healthy, --finish by the shell)", () => {
    const d = makeDeployment({ customBackups: custom });
    const result = run(d, ["--yes", bundleIn(d)], { ...UNATTENDED, FAKE_JOURNAL_STATE: "database-restored", FAKE_CURL_STATUS: "0" });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(d.journal)).toBe(false);
    expect(existsSync(d.marker)).toBe(false);
  });

  it("restore.sh --finish keeps the marker when Orbit is not healthy (the journal stays)", () => {
    const d = makeDeployment({ customBackups: custom });
    mkdirSync(dirname(d.journal), { recursive: true });
    writeFileSync(d.journal, "format_version=1\nstate=database-restored\n");
    writeFileSync(d.marker, `${d.journal}\n`);
    const result = run(d, ["--finish"], { FAKE_CURL_STATUS: "7" });
    expect(result.status).not.toBe(0);
    expect(existsSync(d.journal)).toBe(true);
    expect(existsSync(d.marker)).toBe(true);
  });

  it("restore.sh --finish removes the marker together with the journal on success", () => {
    const d = makeDeployment({ customBackups: custom });
    mkdirSync(dirname(d.journal), { recursive: true });
    writeFileSync(d.journal, "format_version=1\nstate=database-restored\n");
    writeFileSync(d.marker, `${d.journal}\n`);
    const result = run(d, ["--finish"], { FAKE_CURL_STATUS: "0" });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(d.journal)).toBe(false);
    expect(existsSync(d.marker)).toBe(false);
  });

  it("restore.sh --recover removes the marker together with the journal", () => {
    const d = makeDeployment({ customBackups: custom });
    mkdirSync(dirname(d.journal), { recursive: true });
    writeFileSync(d.journal, "format_version=1\nstate=checkpointed\n");
    writeFileSync(d.marker, `${d.journal}\n`);
    const result = run(d, ["--recover"], { FAKE_CURL_STATUS: "0" });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(d.journal)).toBe(false);
    expect(existsSync(d.marker)).toBe(false);
  });

  it("restore.sh --recover also writes the marker before it stops Orbit", () => {
    const d = makeDeployment({ customBackups: custom });
    mkdirSync(dirname(d.journal), { recursive: true });
    writeFileSync(d.journal, "format_version=1\nstate=checkpointed\n");
    run(d, ["--recover"], { FAKE_CURL_STATUS: "0" });
    const line = readFileSync(d.log, "utf8").split("\n").find((l) => l.startsWith("stop-saw-marker="));
    expect(line).toBeDefined();
    expect(JSON.parse(line.slice("stop-saw-marker=".length)).trim()).toBe(d.journal);
  });
});

describe("#1823 O-S2: restore.sh --finish's Start Orbit failure gives the exact start command", () => {
  it("names `docker compose up -d` when Orbit is not healthy", () => {
    const d = makeDeployment();
    mkdirSync(dirname(d.journal), { recursive: true });
    writeFileSync(d.journal, "format_version=1\nstate=database-restored\n");
    const result = run(d, ["--finish"], { FAKE_CURL_STATUS: "7" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Start Orbit");
    expect(result.stderr).toContain("docker compose up -d");
  });
});
