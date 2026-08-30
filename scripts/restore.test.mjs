import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Regression coverage for issue #383 finding 3: scripts/restore.sh's health
// probe used to hardcode `http://127.0.0.1:3000/api/health`, so any
// deployment with a non-default ORBIT_PORT/ORBIT_BIND_ADDRESS (both
// first-class operator knobs — configure.sh writes them into .env-orbit,
// docker-compose.yml publishes orbit-app as
// `${ORBIT_BIND_ADDRESS:-0.0.0.0}:${ORBIT_PORT:-3000}:3000`, and
// scripts/test-install-acceptance.sh exercises ORBIT_PORT=3210 for exactly
// this reason) could never complete a restore: cutover health-wait fails,
// rollback's own health-wait fails identically, and `--recover` fails at the
// same probe, leaving Orbit deliberately stopped with no supported command
// to clear the resulting journal.
//
// This suite tests the real `health_probe_url`/`wait_for_health` functions
// extracted verbatim out of the live scripts/restore.sh (never a hand-typed
// duplicate), so a regression in the actual fix is caught here rather than
// only in a copy.

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const restoreScriptSource = readFileSync(join(scriptsDir, "restore.sh"), "utf8");

// The exact literal scripts/restore.sh's health probe was hardcoded to
// before this fix (issue #383 finding 3's own repro target). Kept here as a
// pinned value, not derived from git history, so this test suite has no
// dependency on repository history being preserved.
const preFixHardcodedProbeUrl = "http://127.0.0.1:3000/api/health";

function extractFunction(name) {
  const pattern = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}`, "m");
  const match = restoreScriptSource.match(pattern);
  if (!match) {
    throw new Error(`Could not find function ${name}() in scripts/restore.sh`);
  }
  return match[0];
}

const healthProbeUrlSource = extractFunction("health_probe_url");
const waitForHealthSource = extractFunction("wait_for_health");

// Issue #678: the same two constants and four functions the live script uses,
// extracted rather than retyped, so this suite cannot pass against a copy that
// has drifted from scripts/restore.sh.
function extractReadonly(name) {
  const pattern = new RegExp(`^readonly ${name}=.*$`, "m");
  const match = restoreScriptSource.match(pattern);
  if (!match) {
    throw new Error(`Could not find "readonly ${name}=" in scripts/restore.sh`);
  }
  return match[0];
}

const reportTerminatorSource = extractReadonly("report_terminator");
const reportTerminatorQuerySource = extractReadonly("report_terminator_query");
const acceptReportSource = extractFunction("accept_report");
const queryReportSource = extractFunction("query_report");
const queryActiveReportSource = extractFunction("query_active_report");
const failCorrespondenceSource = extractFunction("fail_correspondence");

// The operator-facing verdict this fix exists to stop emitting for a query
// that never ran. Pinned as a literal so the test states the exact sentence an
// operator would otherwise be sent away with.
const corruptBackupMessage =
  "preflight/correspondence failed; the staged database and document tree do not correspond; use a complete backup and retry.";

const scratchDirs = [];
const servers = [];

afterEach(async () => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop(), { recursive: true, force: true });
  }
  while (servers.length > 0) {
    const server = servers.pop();
    await new Promise((resolve) => server.close(resolve));
  }
});

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-restore-health-"));
  scratchDirs.push(dir);
  return dir;
}

function writeEnvironmentFile(dir, lines) {
  const path = join(dir, ".env-orbit");
  writeFileSync(path, lines.map((line) => `${line}\n`).join(""));
  chmodSync(path, 0o600);
  return path;
}

// Runs `health_probe_url` (extracted from the real script, never a
// hand-typed duplicate) against a given .env-orbit fixture and returns its
// stdout. health_probe_url reads the shell variable $environment_file, not
// an environment variable, so it must be assigned inside the harness itself
// rather than passed through spawnSync's `env`.
function runHealthProbeUrl(environmentFile) {
  const harness = [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    `environment_file=${JSON.stringify(environmentFile)}`,
    healthProbeUrlSource,
    "health_probe_url",
  ].join("\n");
  return spawnSync("bash", ["-c", harness], { encoding: "utf8" });
}

// Async, non-blocking bash runner — required (not spawnSync) whenever the
// bash child needs to talk to an HTTP server running in-process: spawnSync
// blocks this process's event loop for its whole duration, so an in-process
// http.Server can never actually service the child's request until the
// child already gave up, timed out, and spawnSync returned. Using `spawn`
// keeps the event loop free to drive the server while bash runs.
function runBashAsync(script, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", script]);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

describe("scripts/restore.sh health_probe_url (issue #383 finding 3)", () => {
  it.each([
    [
      "no ORBIT_BIND_ADDRESS/ORBIT_PORT set (default deployment)",
      ["APP_URL=https://orbit.internal"],
      "http://127.0.0.1:3000/api/health",
    ],
    [
      "ORBIT_BIND_ADDRESS=0.0.0.0 explicit, default port",
      ["APP_URL=https://orbit.internal", "ORBIT_BIND_ADDRESS=0.0.0.0"],
      "http://127.0.0.1:3000/api/health",
    ],
    [
      "ORBIT_PORT only, bind address defaults to 0.0.0.0 -> loopback",
      ["APP_URL=https://orbit.internal", "ORBIT_PORT=8443"],
      "http://127.0.0.1:8443/api/health",
    ],
    [
      "ORBIT_BIND_ADDRESS=127.0.0.1 and non-default ORBIT_PORT (mirrors test-install-acceptance.sh's ORBIT_PORT=3210 deployment)",
      ["APP_URL=https://orbit.internal", "ORBIT_BIND_ADDRESS=127.0.0.1", "ORBIT_PORT=3210"],
      "http://127.0.0.1:3210/api/health",
    ],
    [
      "a non-loopback ORBIT_BIND_ADDRESS is passed through unchanged, not remapped to loopback",
      ["APP_URL=https://orbit.internal", "ORBIT_BIND_ADDRESS=192.168.1.50", "ORBIT_PORT=3000"],
      "http://192.168.1.50:3000/api/health",
    ],
  ])("%s", (_label, envLines, expectedUrl) => {
    const dir = makeFixture();
    const environmentFile = writeEnvironmentFile(dir, envLines);
    const result = runHealthProbeUrl(environmentFile);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(expectedUrl);
  });

  it("pins the exact pre-fix hardcoded literal this fix replaced, and shows the fixed output now differs for a non-default port", () => {
    const dir = makeFixture();
    const environmentFile = writeEnvironmentFile(dir, ["APP_URL=https://orbit.internal", "ORBIT_PORT=9443"]);
    const result = runHealthProbeUrl(environmentFile);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toBe(preFixHardcodedProbeUrl);
    expect(result.stdout).toBe("http://127.0.0.1:9443/api/health");
  });
});

describe("scripts/restore.sh wait_for_health (issue #383 finding 3)", () => {
  it("reaches a deployment's health endpoint on a non-default ORBIT_PORT, which a hardcoded 127.0.0.1:3000 probe would have missed", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/api/health") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    servers.push(server);
    const port = await new Promise((resolve, reject) => {
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
    // Sanity-guard against the (extremely unlikely) case of colliding with
    // the literal port this script used to hardcode: the whole point of this
    // test is to exercise a NON-default port.
    expect(port).not.toBe(3000);

    const dir = makeFixture();
    const environmentFile = writeEnvironmentFile(dir, [
      "APP_URL=https://orbit.internal",
      `ORBIT_PORT=${port}`,
    ]);
    const scopedHarness = [
      "#!/usr/bin/env bash",
      "set -Eeuo pipefail",
      `environment_file=${JSON.stringify(environmentFile)}`,
      healthProbeUrlSource,
      waitForHealthSource,
      "wait_for_health",
    ].join("\n");
    const result = await runBashAsync(scopedHarness, 10000);
    expect(result.status).toBe(0);
  });

  it("does not reach a health endpoint bound on a different port than the one .env-orbit configures (probe target must match, not guess)", async () => {
    const server = createServer((req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    servers.push(server);
    const realPort = await new Promise((resolve, reject) => {
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });

    // A second, unbound port standing in for "the wrong target" (e.g. what a
    // hardcoded/stale probe would hit instead of the deployment's actual
    // configured port).
    const probe = createServer(() => {});
    const wrongPort = await new Promise((resolve, reject) => {
      probe.on("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });
    expect(wrongPort).not.toBe(realPort);

    const dir = makeFixture();
    const environmentFile = writeEnvironmentFile(dir, [
      "APP_URL=https://orbit.internal",
      `ORBIT_PORT=${wrongPort}`,
    ]);
    // Shorten the 45s retry deadline to keep this negative case fast; the
    // retried command itself (curl --max-time 2) is untouched, so this only
    // trims how many times a doomed probe retries before giving up.
    const shortenedWaitForHealthSource = waitForHealthSource.replace("SECONDS + 45", "SECONDS + 1");
    expect(shortenedWaitForHealthSource).not.toBe(waitForHealthSource);
    const scopedHarness = [
      "#!/usr/bin/env bash",
      "set -Eeuo pipefail",
      `environment_file=${JSON.stringify(environmentFile)}`,
      healthProbeUrlSource,
      shortenedWaitForHealthSource,
      "wait_for_health",
    ].join("\n");
    const result = await runBashAsync(scopedHarness, 10000);
    expect(result.status).not.toBe(0);
  });
});

// Issue #678: a correspondence report that never ran was reported to the
// operator as a verdict on their backup. An empty report is ambiguous on its
// own -- "no rows, all good" or "the query never executed" -- so execution is
// now proven positively by a terminator the database emits as the last line,
// independently of psql's exit code. That independence is the point: a report
// truncated mid-stream by a killed process or a full disk exits 0 and parses
// as "fewer referenced objects", which is the direction that could wrongly
// pass validation.
//
// The stub below stands in for `compose exec ... psql`, reproducing the four
// behaviours confirmed against a real PostgreSQL 17 on the issue, and echoes
// the terminator it was actually handed rather than a hardcoded string, so a
// script that stopped passing the terminator command fails these tests.
function composeStub(mode, scriptCapturePath) {
  return [
    "compose() {",
    `  printf '%s' "$6" > ${JSON.stringify(scriptCapturePath)}`,
    '  local terminator_command="${!#}"',
    "  local emitted",
    '  emitted="$(sed -E "s/^SELECT .(.*).;/\\1/" <<< "$terminator_command")"',
    `  case ${JSON.stringify(mode)} in`,
    "    rows) printf 'aaa|1\\nbbb|2\\n'; printf '%s\\n' \"$emitted\" ;;",
    "    zero-rows) printf '%s\\n' \"$emitted\" ;;",
    "    failed) return 1 ;;",
    "    truncated) printf 'aaa|1\\n' ;;",
    "    silent-success) : ;;",
    `    *) printf 'unknown stub mode\\n' >&2; return 99 ;;`,
    "  esac",
    "}",
  ].join("\n");
}

function runQueryReport({ mode, variant = "stage", checkName = "crypto" }) {
  const dir = makeFixture();
  const reportPath = join(dir, "report.tsv");
  const scriptCapturePath = join(dir, "psql-script");
  const call =
    variant === "stage"
      ? `query_report stage-db 'SELECT 1;' ${JSON.stringify(reportPath)} ${checkName}`
      : `query_active_report 'SELECT 1;' ${JSON.stringify(reportPath)} ${checkName}`;
  const harness = [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    reportTerminatorSource,
    reportTerminatorQuerySource,
    'incomplete_check=""',
    composeStub(mode, scriptCapturePath),
    acceptReportSource,
    queryReportSource,
    queryActiveReportSource,
    "status=0",
    `${call} || status=$?`,
    'printf "status=%s check=%s\\n" "$status" "$incomplete_check"',
  ].join("\n");
  const result = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
  return {
    result,
    status: /status=(\d+)/.exec(result.stdout)?.[1],
    incompleteCheck: /check=(\S*)/.exec(result.stdout)?.[1] ?? "",
    report: existsSync(reportPath) ? readFileSync(reportPath, "utf8") : null,
    psqlScript: existsSync(scriptCapturePath) ? readFileSync(scriptCapturePath, "utf8") : "",
  };
}

describe.each([
  ["query_report (staged bundle)", "stage"],
  ["query_active_report (live database)", "active"],
])("scripts/restore.sh %s proves its report ran (issue #678)", (_label, variant) => {
  it("accepts a report that ends with the terminator, and strips it before parsing", () => {
    const { status, report } = runQueryReport({ mode: "rows", variant });
    expect(status).toBe("0");
    expect(report).toBe("aaa|1\nbbb|2\n");
    expect(report).not.toContain("ORBIT_REPORT_END");
  });

  it("accepts a legitimate zero-row report, leaving the parsed report empty", () => {
    const { status, report } = runQueryReport({ mode: "zero-rows", variant });
    expect(status).toBe("0");
    expect(report).toBe("");
  });

  it("refuses a failed query as an incomplete check, not a correspondence violation", () => {
    const { status, incompleteCheck } = runQueryReport({ mode: "failed", variant, checkName: "attachments" });
    expect(status).toBe("2");
    expect(incompleteCheck).toBe("attachments");
  });

  it("refuses a report truncated mid-stream even though psql exited 0 -- the case an exit code cannot see", () => {
    const { status, incompleteCheck } = runQueryReport({ mode: "truncated", variant, checkName: "staging" });
    expect(status).toBe("2");
    expect(incompleteCheck).toBe("staging");
  });

  it("refuses an empty report that exited 0, which is otherwise indistinguishable from no rows", () => {
    const { status, incompleteCheck } = runQueryReport({ mode: "silent-success", variant, checkName: "visible" });
    expect(status).toBe("2");
    expect(incompleteCheck).toBe("visible");
  });

  it("asks psql to stop on error and to run the report and the terminator as two separate commands", () => {
    const { psqlScript } = runQueryReport({ mode: "rows", variant });
    expect(psqlScript).toContain("--set=ON_ERROR_STOP=1");
    expect(psqlScript.match(/--command=/g)).toHaveLength(2);
  });
});

describe("scripts/restore.sh report acceptance, against the pre-fix query (issue #678)", () => {
  // The exact body scripts/restore.sh's query_report had before this fix,
  // pinned here rather than read from git history, following the same
  // discipline as preFixHardcodedProbeUrl above. Running it against the same
  // stub the tests above use is what makes the two defects concrete: a query
  // that failed is indistinguishable from a correspondence violation, and a
  // query that never ran at all is accepted as "no rows".
  const preFixQueryReportSource = [
    "pre_fix_query_report() {",
    '  local database_name="$1" query="$2" report_path="$3"',
    "  if ! compose exec -T orbit-db sh -c \\",
    "    'exec psql --username=\"$POSTGRES_USER\" --dbname=\"$1\" --tuples-only --no-align --field-separator=\"|\" --command=\"$2\"' \\",
    '    sh "$database_name" "$query" > "$report_path" 2>/dev/null; then',
    "    return 1",
    "  fi",
    "}",
  ].join("\n");

  function runPreFix(mode) {
    const dir = makeFixture();
    const reportPath = join(dir, "report.tsv");
    const harness = [
      "#!/usr/bin/env bash",
      "set -Eeuo pipefail",
      composeStub(mode, join(dir, "psql-script")),
      preFixQueryReportSource,
      "status=0",
      `pre_fix_query_report db 'SELECT 1;' ${JSON.stringify(reportPath)} || status=$?`,
      'printf "status=%s\\n" "$status"',
    ].join("\n");
    const result = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
    return { status: /status=(\d+)/.exec(result.stdout)?.[1], report: readFileSync(reportPath, "utf8") };
  }

  it("pre-fix, a failed query returned 1 -- the same status a correspondence violation returns, which is how the operator came to be told their backup was corrupt", () => {
    expect(runPreFix("failed").status).toBe("1");
    expect(runQueryReport({ mode: "failed" }).status).toBe("2");
  });

  it("pre-fix, a query that produced nothing and exited 0 was accepted as an empty report; it is now refused", () => {
    const preFix = runPreFix("silent-success");
    expect(preFix.status).toBe("0");
    expect(preFix.report).toBe("");
    expect(runQueryReport({ mode: "silent-success" }).status).toBe("2");
  });
});

describe("scripts/restore.sh fail_correspondence (issue #678)", () => {
  function runFailCorrespondence(status) {
    const harness = [
      "#!/usr/bin/env bash",
      "set -Eeuo pipefail",
      'incomplete_check="attachments"',
      extractFunction("fail"),
      failCorrespondenceSource,
      `fail_correspondence ${status} preflight ${JSON.stringify(corruptBackupMessage)}`,
      'printf "returned-cleanly\\n"',
    ].join("\n");
    return spawnSync("bash", ["-c", harness], { encoding: "utf8" });
  }

  it("tells the operator which check could not be completed, and does not call their backup corrupt", () => {
    const result = runFailCorrespondence(2);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("preflight/correspondence-incomplete failed");
    expect(result.stderr).toContain("the attachments check did not run to completion");
    expect(result.stderr).not.toContain("do not correspond");
    expect(result.stderr).not.toContain("use a complete backup and retry");
  });

  it("still reports a genuine correspondence violation with its original message", () => {
    const result = runFailCorrespondence(1);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(corruptBackupMessage);
  });

  it("fails closed: an incomplete check refuses the restore rather than proceeding", () => {
    expect(runFailCorrespondence(2).stdout).not.toContain("returned-cleanly");
  });

  it("passes a healthy correspondence check through without failing", () => {
    const result = runFailCorrespondence(0);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("returned-cleanly");
  });
});

describe("scripts/restore.sh correspondence call sites (issue #678)", () => {
  // Guards the fix's completeness rather than one function's behaviour: a
  // report query added later without a check name, or one that collapses the
  // incomplete status back to 1, would restore the original defect silently.
  const callLines = restoreScriptSource
    .split("\n")
    .filter((line) => /^\s+"\$\w+_report"\s/.test(line));

  it("covers every report query in both the staged and the live path", () => {
    expect(callLines).toHaveLength(12);
  });

  it("names a check and propagates the incomplete status at every call site", () => {
    for (const line of callLines) {
      expect(line).toMatch(/"\$\w+_report" [a-z-]+ \|\| return \$\?$/);
    }
  });
});
