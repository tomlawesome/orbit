import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

// Tests here run scripts/ci/sidecar-freshness-issue.sh under bash against a
// stub `curl`; budget and reasoning: scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const script = new URL("./ci/sidecar-freshness-issue.sh", import.meta.url).pathname;

/**
 * A fake `curl` on PATH that records every invocation and returns canned
 * JSON keyed on the request shape: PUT, POST, a milestones lookup, or the
 * default issue search.
 *
 * A call's arguments are joined with \x1f and calls are separated by \x1e
 * (not \n): the description argument this script sends is itself a
 * multi-line file, so a newline cannot be the record separator without
 * splitting one call into several.
 */
function makeCurlStub({ searchResponse, milestoneResponse, milestoneFails, putResponse, postResponse }) {
  const dir = mkdtempSync(join(tmpdir(), "sidecar-freshness-curl-"));
  const logFile = join(dir, "calls.log");
  writeFileSync(logFile, "");
  const stub = join(dir, "curl");
  writeFileSync(
    stub,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `log=${JSON.stringify(logFile)}`,
      // Record argv, and inline the contents of any --header @file or
      // --data-urlencode ...@file so the test can see what was sent without
      // the file surviving the script's own cleanup trap.
      "recorded=()",
      'while [ "$#" -gt 0 ]; do',
      '  arg="$1"',
      '  case "$arg" in',
      "    @*|*'@'/*)",
      "      path=\"${arg#*@}\"",
      '      if [ -f "$path" ]; then',
      '        recorded+=("${arg%%@*}@<$(cat "$path")>")',
      "      else",
      '        recorded+=("$arg")',
      "      fi",
      "      ;;",
      "    *)",
      '      recorded+=("$arg")',
      "      ;;",
      "  esac",
      "  shift",
      "done",
      'printf \'%s\\x1f\' "${recorded[@]}" >> "$log"',
      'printf \'\\x1e\' >> "$log"',
      'args="${recorded[*]}"',
      'case "$args" in',
      "  *'-X PUT'*)",
      `    printf '%s' ${JSON.stringify(JSON.stringify(putResponse ?? {}))}`,
      "    ;;",
      "  *'-X POST'*)",
      `    printf '%s' ${JSON.stringify(JSON.stringify(postResponse ?? {}))}`,
      "    ;;",
      "  */milestones*)",
      ...(milestoneFails
        ? ["    echo 'curl: (22) The requested URL returned error: 500' >&2", "    exit 22"]
        : [`    printf '%s' ${JSON.stringify(JSON.stringify(milestoneResponse ?? []))}`]),
      "    ;;",
      "  *)",
      `    printf '%s' ${JSON.stringify(JSON.stringify(searchResponse ?? []))}`,
      "    ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);
  return {
    dir,
    calls: () =>
      readFileSync(logFile, "utf8")
        .split("\x1e")
        .filter(Boolean)
        .map((call) => call.split("\x1f").filter((part) => part.length > 0)),
  };
}

function run({ stubDir, reportBody, env = {} }) {
  const reportDir = mkdtempSync(join(tmpdir(), "sidecar-freshness-report-"));
  const reportFile = join(reportDir, "report.md");
  writeFileSync(reportFile, reportBody ?? "# Sidecar pin freshness\n\nollama moved.\n");
  const result = failOnProcessDeadline(
    spawnSync("bash", [script, reportFile], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${stubDir}:${process.env.PATH}`,
        CI_API_V4_URL: "https://gitlab.tomlawson.io/api/v4",
        CI_PROJECT_ID: "49",
        CI_PIPELINE_URL: "https://gitlab.tomlawson.io/ai/orbit/-/pipelines/123",
        SIDECAR_ISSUE_TOKEN: "TEST-SIDECAR-TOKEN-NOT-REAL",
        ...env,
      },
      ...processGuard(),
    }),
    { label: "run" },
  );
  return result;
}

describe("scripts/ci/sidecar-freshness-issue.sh", () => {
  it("refuses clearly when SIDECAR_ISSUE_TOKEN is unset, without calling curl", () => {
    const { dir, calls } = makeCurlStub({});
    const result = run({ stubDir: dir, env: { SIDECAR_ISSUE_TOKEN: "" } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SIDECAR_ISSUE_TOKEN");
    expect(calls().length).toBe(0);
  });

  it("creates a new issue in the nearest open version milestone", () => {
    const { dir, calls } = makeCurlStub({
      searchResponse: [],
      milestoneResponse: [
        { id: 17, title: "v0.4.0" },
        { id: 18, title: "M5 — Supply chain and CI baseline" },
      ],
      postResponse: { iid: 42 },
    });
    const result = run({ stubDir: dir });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("created issue #42");

    const recordedCalls = calls();
    // search, milestone lookup, create -- in that order.
    expect(recordedCalls.length).toBe(3);
    const [search, milestone, create] = recordedCalls;
    expect(search.join(" ")).toContain("search=Sidecar pins are behind");
    expect(milestone.join(" ")).toContain("state=active");
    expect(milestone.join(" ")).toContain("per_page=100");
    expect(milestone.join(" ")).not.toContain("title=");
    const createArgs = create.join(" ");
    expect(createArgs).toContain("-X POST");
    expect(createArgs).toContain("title=Sidecar pins are behind");
    expect(createArgs).toContain("milestone_id=17");
    expect(createArgs).toContain("description@<");
    expect(createArgs).toContain("ollama moved.");
    expect(createArgs).toContain("Run: https://gitlab.tomlawson.io/ai/orbit/-/pipelines/123");
    // The stub inlines file contents (tagged "name@<...>") so the test can
    // see what was sent through --header/--data-urlencode files; the token
    // only ever shows up there, never as a bare argv word of its own -- which
    // is what proves the real script kept it out of the process's argv.
    expect(createArgs).toContain("PRIVATE-TOKEN: TEST-SIDECAR-TOKEN-NOT-REAL");
    for (const part of create) {
      expect(part).not.toBe("TEST-SIDECAR-TOKEN-NOT-REAL");
      if (!part.includes("<")) {
        expect(part).not.toContain("TEST-SIDECAR-TOKEN-NOT-REAL");
      }
    }
  });

  const created = (recordedCalls) => recordedCalls[recordedCalls.length - 1].join(" ");

  it("picks the numerically lowest version milestone, v0.3.10 over v0.4.0", () => {
    const { dir, calls } = makeCurlStub({
      milestoneResponse: [
        { id: 1, title: "v0.4.0" },
        { id: 2, title: "v0.3.10" },
      ],
      postResponse: { iid: 42 },
    });
    const result = run({ stubDir: dir });
    expect(result.status, result.stderr).toBe(0);
    expect(created(calls())).toContain("milestone_id=2");
  });

  it("compares numerically, v0.3.9 over v0.3.10", () => {
    const { dir, calls } = makeCurlStub({
      milestoneResponse: [
        { id: 1, title: "v0.3.10" },
        { id: 2, title: "v0.3.9" },
      ],
      postResponse: { iid: 42 },
    });
    const result = run({ stubDir: dir });
    expect(result.status, result.stderr).toBe(0);
    expect(created(calls())).toContain("milestone_id=2");
  });

  it("ignores M5, Parked, v0.3.x and v0.4 titles", () => {
    const { dir, calls } = makeCurlStub({
      milestoneResponse: [
        { id: 1, title: "M5 — Supply chain and CI baseline" },
        { id: 2, title: "Parked" },
        { id: 3, title: "v0.3.x" },
        { id: 4, title: "v0.4" },
        { id: 5, title: "v1.0.0" },
      ],
      postResponse: { iid: 42 },
    });
    const result = run({ stubDir: dir });
    expect(result.status, result.stderr).toBe(0);
    expect(created(calls())).toContain("milestone_id=5");
  });

  it("creates without milestone_id and notes it on stderr when no version milestone is open", () => {
    const { dir, calls } = makeCurlStub({
      milestoneResponse: [
        { id: 1, title: "M5 — Supply chain and CI baseline" },
        { id: 2, title: "Parked" },
      ],
      postResponse: { iid: 42 },
    });
    const result = run({ stubDir: dir });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("created issue #42");
    expect(result.stderr.trim().length).toBeGreaterThan(0);
    const createArgs = created(calls());
    expect(createArgs).toContain("-X POST");
    expect(createArgs).not.toContain("milestone_id");
  });

  it("still creates the issue, exit 0, when the milestones read fails", () => {
    const { dir, calls } = makeCurlStub({ milestoneFails: true, postResponse: { iid: 42 } });
    const result = run({ stubDir: dir });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("created issue #42");
    const createArgs = created(calls());
    expect(createArgs).toContain("-X POST");
    expect(createArgs).not.toContain("milestone_id");
  });

  it("updates the existing issue's description instead of creating a second one", () => {
    const { dir, calls } = makeCurlStub({
      searchResponse: [{ iid: 7, title: "Sidecar pins are behind" }],
    });
    const result = run({ stubDir: dir });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("updated issue #7");

    const recordedCalls = calls();
    // search, then update -- no milestone lookup, no create.
    expect(recordedCalls.length).toBe(2);
    expect(recordedCalls.some((c) => c.join(" ").includes("/milestones"))).toBe(false);
    const [, update] = recordedCalls;
    const updateArgs = update.join(" ");
    expect(updateArgs).toContain("-X PUT");
    expect(updateArgs).toContain("/issues/7");
    expect(updateArgs).toContain("description@<");
  });
});
