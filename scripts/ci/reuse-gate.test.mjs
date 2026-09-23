import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../process-budget.mjs";

/*
 * The job-side half of the reuse economy under ADR-0028 (#1060 slice 3): the
 * gate that lets a job stop, and the evidence that lets a later pipeline
 * believe it.
 *
 * Run against a copy of the three scripts in a temporary directory, because
 * they resolve their own repository root from where they sit and write into it
 * -- pointing them at this checkout would leave ci-evidence/ behind.
 *
 * What changed from #898 is mostly what is gone. The gate used to fetch
 * image.tar and build.env back for a reused `build_image`, with a token and a
 * curl to do it; ADR-0028 makes `build_image` always build, so the fetch, the
 * token and the network are all out. The test keeps a curl stub on PATH purely
 * to prove nothing calls it.
 *
 * The behaviour that matters most is still the refusal: every fault must fall
 * through to the real work, because a job that runs when it need not costs
 * minutes and a job that is skipped when it should not have been ships
 * something nobody checked.
 */
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const KEY = "c".repeat(64);
const OTHER_KEY = "d".repeat(64);
const RUN_FOR_REAL = 10;

// Records every call and fails, so any surviving fetch shows up twice over.
const CURL_STUB = [
  "#!/usr/bin/env bash",
  'printf "%s\\n" "$*" >> "$STUB_LOG"',
  "exit 22",
].join("\n");

let root;
let binDirectory;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orbit-gate-"));
  mkdirSync(join(root, "scripts/ci"), { recursive: true });
  for (const script of ["reuse-gate.sh", "reuse-evidence.sh", "reuse-env.sh"]) {
    cpSync(new URL(`./${script}`, import.meta.url).pathname, join(root, "scripts/ci", script));
  }
  binDirectory = join(root, "stub-bin");
  mkdirSync(binDirectory);
  writeFileSync(join(binDirectory, "curl"), CURL_STUB);
  chmodSync(join(binDirectory, "curl"), 0o755);
  mkdirSync(join(root, ".orbit-reuse"));
});

/* classify's file: source keys, and finished keys for the source-keyed jobs. */
function writeClassify(lines) {
  writeFileSync(join(root, ".orbit-reuse/reuse.env"), `${lines.join("\n")}\n`);
}

/* build_image's file: the finished keys and verdicts for the six image jobs. */
function writeImage(lines) {
  writeFileSync(join(root, ".orbit-reuse/image.env"), `${lines.join("\n")}\n`);
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
      STUB_LOG: join(root, "curl.log"),
      ...environment,
    },
  });
  return failOnProcessDeadline(result, { label: script });
}

const evidence = (job) => JSON.parse(readFileSync(join(root, "ci-evidence", `${job}.json`), "utf8"));

describe("reuse-evidence.sh", () => {
  it("records the key the run stood on, and that it did the work itself", () => {
    writeClassify([`ORBIT_INPUTS_FAST=${KEY}`]);

    const result = run("reuse-evidence.sh", ["fast"]);

    expect(result.status).toBe(0);
    expect(evidence("fast")).toEqual({
      job: "fast", inputs: KEY, pipeline: 300, job_id: 9500, stands_on: null, stands_on_pipeline: null,
    });
  });

  // Without a key the evidence would claim a state it never checked, so the
  // next pipeline must repeat the job rather than believe it.
  it("records nothing, and still succeeds, when no key was published", () => {
    writeClassify(["ORBIT_LANE=full"]);

    const result = run("reuse-evidence.sh", ["smoke"]);

    expect(result.status).toBe(0);
    expect(existsSync(join(root, "ci-evidence/smoke.json"))).toBe(false);
  });

  // An image job's key exists only once build_image has the content ID, so it
  // arrives in the second file rather than classify's.
  it("takes an image job's key from build_image's file", () => {
    writeClassify([`ORBIT_SOURCE_SMOKE=${OTHER_KEY}`]);
    writeImage([`ORBIT_INPUTS_SMOKE=${KEY}`]);

    const result = run("reuse-evidence.sh", ["smoke"]);

    expect(result.status).toBe(0);
    expect(evidence("smoke")).toMatchObject({ inputs: KEY });
  });
});

describe("reuse-gate.sh", () => {
  it("tells a job with no verdict to do the work", () => {
    writeClassify([`ORBIT_INPUTS_FAST=${KEY}`]);

    const result = run("reuse-gate.sh", ["fast"]);

    expect(result.status).toBe(RUN_FOR_REAL);
    expect(result.stdout).toContain("no earlier run to stand on");
  });

  it("stops a job that has an earlier run, naming what it stands on", () => {
    writeClassify([`ORBIT_INPUTS_FAST=${KEY}`, "ORBIT_REUSE_FAST=8000", "ORBIT_REUSE_FAST_PIPELINE=250"]);

    const result = run("reuse-gate.sh", ["fast"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Standing on job 8000 from pipeline 250");
    expect(evidence("fast")).toMatchObject({ inputs: KEY, stands_on: 8000, stands_on_pipeline: 250, job_id: 9500 });
  });

  it("reads an image job's verdict from build_image's file", () => {
    writeClassify([`ORBIT_SOURCE_SMOKE=${OTHER_KEY}`]);
    writeImage([`ORBIT_INPUTS_SMOKE=${KEY}`, "ORBIT_REUSE_SMOKE=8100", "ORBIT_REUSE_SMOKE_PIPELINE=251"]);

    const result = run("reuse-gate.sh", ["smoke"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Standing on job 8100 from pipeline 251");
    expect(evidence("smoke")).toMatchObject({ inputs: KEY, stands_on: 8100 });
  });

  // build_image's file is written second and is the one that knows the content
  // ID, so where both name a key, it wins.
  it("prefers build_image's key to classify's when both name one", () => {
    writeClassify([`ORBIT_INPUTS_SMOKE=${OTHER_KEY}`, "ORBIT_REUSE_SMOKE=8100"]);
    writeImage([`ORBIT_INPUTS_SMOKE=${KEY}`]);

    run("reuse-gate.sh", ["smoke"]);

    expect(evidence("smoke")).toMatchObject({ inputs: KEY });
  });

  // A verdict this job could record no evidence for would have the next
  // pipeline repeat it anyway, so there is nothing to buy by stopping.
  it("runs when a verdict arrives with no key beside it", () => {
    writeClassify(["ORBIT_REUSE_FAST=8000"]);

    const result = run("reuse-gate.sh", ["fast"]);

    expect(result.status).toBe(RUN_FOR_REAL);
    expect(result.stdout).toContain("no key beside it");
    expect(existsSync(join(root, "ci-evidence/fast.json"))).toBe(false);
  });

  it("falls through to the work when neither file was ever delivered", () => {
    const result = run("reuse-gate.sh", ["smoke"]);

    expect(result.status).toBe(RUN_FOR_REAL);
  });

  // ADR-0028 took the image.tar fetch out with build_image's skip. Nothing the
  // gate does reaches the network now, which is why it needs no credential.
  it("fetches nothing and needs no token", () => {
    writeClassify([`ORBIT_INPUTS_FAST=${KEY}`, "ORBIT_REUSE_FAST=8000"]);

    const result = run("reuse-gate.sh", ["fast"]);

    expect(result.status).toBe(0);
    expect(existsSync(join(root, "curl.log"))).toBe(false);
    // And no line of it invokes one, which the stub above could only catch on
    // the one path this test happens to take.
    const source = readFileSync(new URL("./reuse-gate.sh", import.meta.url).pathname, "utf8");
    expect(source.split("\n").filter((line) => /^\s*curl\b/u.test(line))).toEqual([]);
    expect(source).not.toContain("BASE_REPIN_TOKEN");
  });
});
