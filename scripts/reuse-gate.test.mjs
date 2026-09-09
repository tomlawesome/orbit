import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

/*
 * The job-side half of #898: the gate that lets a job stop, and the evidence
 * that lets the next pipeline believe it.
 *
 * Run against a copy of the two scripts in a temporary directory, because both
 * resolve their own repository root from where they sit and write into it --
 * pointing them at this checkout would leave ci-evidence/ behind. `curl` is a
 * stub on PATH, the way scripts/promote-stable.test.mjs stubs docker and git.
 *
 * The behaviour that matters most is the refusal: every fault a fetch can meet
 * must fall through to the real work, because a job that runs when it need not
 * costs minutes and a job that is skipped when it should not have been ships
 * something nobody checked.
 */
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const TOKEN = "TEST-GATE-TOKEN-NOT-REAL";
const HASH = "c".repeat(64);
const RUN_FOR_REAL = 10;

// Answers any artefact request with `<path> from job <id>`, unless
// STUB_CURL_FAIL is set. Records its whole argument list and the config file it
// was handed, so the test can prove the token never reached a command line.
const CURL_STUB = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  'printf "%s\\n" "$*" >> "$STUB_LOG"',
  'output=""; config=""; url=""',
  "while [[ $# -gt 0 ]]; do",
  '  case "$1" in',
  '    --output) output="$2"; shift 2 ;;',
  '    --config) config="$2"; shift 2 ;;',
  '    -*) shift ;;',
  '    *) url="$1"; shift ;;',
  "  esac",
  "done",
  '[[ -n "$config" ]] && cat "$config" >> "$STUB_CONFIG_LOG"',
  '[[ -n "${STUB_CURL_FAIL:-}" ]] && exit 22',
  'printf "%s from job %s\\n" "$(basename "$output")" "$(sed -n "s#.*/jobs/\\([0-9]*\\)/.*#\\1#p" <<< "$url")" > "$output"',
  "exit 0",
].join("\n");

let root;
let binDirectory;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orbit-gate-"));
  mkdirSync(join(root, "scripts/ci"), { recursive: true });
  for (const script of ["reuse-gate.sh", "reuse-evidence.sh"]) {
    cpSync(new URL(`./ci/${script}`, import.meta.url).pathname, join(root, "scripts/ci", script));
  }
  binDirectory = join(root, "stub-bin");
  mkdirSync(binDirectory);
  writeFileSync(join(binDirectory, "curl"), CURL_STUB);
  chmodSync(join(binDirectory, "curl"), 0o755);
  mkdirSync(join(root, ".orbit-reuse"));
});

function writeVerdict(lines) {
  writeFileSync(join(root, ".orbit-reuse/reuse.env"), `${lines.join("\n")}\n`);
}

function run(script, args, environment = {}) {
  const result = spawnSync("bash", [join(root, "scripts/ci", script), ...args], {
    ...processGuard(),
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: `${binDirectory}:${process.env.PATH}`,
      HOME: root,
      CI_PIPELINE_ID: "300",
      CI_JOB_ID: "9500",
      CI_PROJECT_ID: "49",
      ORBIT_REUSE_API_URL: "https://gitlab.example/api/v4",
      BASE_REPIN_TOKEN: TOKEN,
      STUB_LOG: join(root, "curl.log"),
      STUB_CONFIG_LOG: join(root, "curl-config.log"),
      ...environment,
    },
  });
  return failOnProcessDeadline(result, { label: script });
}

const evidence = (job) => JSON.parse(readFileSync(join(root, "ci-evidence", `${job}.json`), "utf8"));

describe("reuse-evidence.sh", () => {
  it("records the inputs the run stood on, and that it did the work itself", () => {
    writeVerdict([`ORBIT_INPUTS_SMOKE=${HASH}`]);

    const result = run("reuse-evidence.sh", ["smoke"]);

    expect(result.status).toBe(0);
    expect(evidence("smoke")).toEqual({
      job: "smoke", inputs: HASH, pipeline: 300, job_id: 9500, stands_on: null, stands_on_pipeline: null,
    });
  });

  // Without a hash the evidence would claim inputs it never checked, so the
  // next pipeline must repeat the job rather than believe it.
  it("records nothing, and still succeeds, when classify left no hash", () => {
    writeVerdict(["ORBIT_LANE=full"]);

    const result = run("reuse-evidence.sh", ["smoke"]);

    expect(result.status).toBe(0);
    expect(existsSync(join(root, "ci-evidence/smoke.json"))).toBe(false);
  });
});

describe("reuse-gate.sh", () => {
  it("tells a job with no verdict to do the work", () => {
    writeVerdict([`ORBIT_INPUTS_SMOKE=${HASH}`]);

    const result = run("reuse-gate.sh", ["smoke"]);

    expect(result.status).toBe(RUN_FOR_REAL);
    expect(result.stdout).toContain("no earlier run to stand on");
  });

  it("stops a job that has an earlier run, naming what it stands on", () => {
    writeVerdict([`ORBIT_INPUTS_SMOKE=${HASH}`, "ORBIT_REUSE_SMOKE=8000", "ORBIT_REUSE_SMOKE_PIPELINE=250"]);

    const result = run("reuse-gate.sh", ["smoke"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Standing on job 8000 from pipeline 250");
    expect(evidence("smoke")).toMatchObject({ inputs: HASH, stands_on: 8000, stands_on_pipeline: 250, job_id: 9500 });
  });

  // build_image is the one job whose artefacts the jobs after it read, so a
  // reused build has to leave the same two files a real one does.
  it("fetches the image and its identity back for a reused build", () => {
    writeVerdict([
      `ORBIT_INPUTS_BUILD_IMAGE=${HASH}`, "ORBIT_REUSE_BUILD_IMAGE=8000", "ORBIT_REUSE_BUILD_IMAGE_PIPELINE=250",
    ]);

    const result = run("reuse-gate.sh", ["build_image"]);

    expect(result.status).toBe(0);
    expect(readFileSync(join(root, "image.tar"), "utf8").trim()).toBe("image.tar from job 8000");
    expect(readFileSync(join(root, "build.env"), "utf8").trim()).toBe("build.env from job 8000");
    expect(evidence("build_image")).toMatchObject({ stands_on: 8000 });
  });

  it("keeps the token off every command line and in a file only it can read", () => {
    writeVerdict([`ORBIT_INPUTS_BUILD_IMAGE=${HASH}`, "ORBIT_REUSE_BUILD_IMAGE=8000"]);

    run("reuse-gate.sh", ["build_image"]);

    expect(readFileSync(join(root, "curl.log"), "utf8")).not.toContain(TOKEN);
    expect(readFileSync(join(root, "curl-config.log"), "utf8")).toContain(`PRIVATE-TOKEN: ${TOKEN}`);
  });

  // Four hours is all image.tar lives for, so an expired artefact is the
  // ordinary case rather than an error: build it again.
  it("builds for real when the artefacts it wanted are gone", () => {
    writeVerdict([`ORBIT_INPUTS_BUILD_IMAGE=${HASH}`, "ORBIT_REUSE_BUILD_IMAGE=8000"]);

    const result = run("reuse-gate.sh", ["build_image"], { STUB_CURL_FAIL: "1" });

    expect(result.status).toBe(RUN_FOR_REAL);
    expect(result.stdout).toContain("building instead");
    expect(existsSync(join(root, "image.tar"))).toBe(false);
    expect(existsSync(join(root, "ci-evidence/build_image.json"))).toBe(false);
  });

  it("builds for real when there is no token to fetch the artefacts with", () => {
    writeVerdict([`ORBIT_INPUTS_BUILD_IMAGE=${HASH}`, "ORBIT_REUSE_BUILD_IMAGE=8000"]);

    const result = run("reuse-gate.sh", ["build_image"], { BASE_REPIN_TOKEN: "" });

    expect(result.status).toBe(RUN_FOR_REAL);
    expect(existsSync(join(root, "image.tar"))).toBe(false);
  });
});
