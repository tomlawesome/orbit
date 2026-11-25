import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/*
 * #1933 (103a section 3): scripts/ci/fast-coverage-blobs.sh <count> makes sure
 * .vitest/blob/blob-<i>-<count>.json exists for every shard i, from this
 * pipeline or, when a shard stood on an earlier run, downloaded by that run's
 * job id (ORBIT_REUSE_FAST_<i>_<count>) with the job token. Anything missing is
 * a loud failure. Written from the ruling alone; curl is a stub on PATH.
 * Run: pnpm exec vitest run scripts/ci/fast-coverage-blobs.test.mjs
 */
const HERE = new URL(".", import.meta.url).pathname;
const API = "https://gitlab.example.test/api/v4";
const STUB_CURL = `#!/bin/sh
printf 'curl' >> "$STUB_LOG"
for a in "$@"; do printf '\\037%s' "$a" >> "$STUB_LOG"; done
printf '\\n' >> "$STUB_LOG"
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o|--output) out="$2"; shift ;;
    http*) url="$1" ;;
  esac
  shift
done
for gone in $STUB_GONE; do
  case "$url" in */jobs/$gone/*) echo "curl: (22) The requested URL returned error: 404" >&2; exit 22 ;; esac
done
[ -n "$out" ] && printf '{"stub":"%s"}' "$url" > "$out"
exit 0
`;

let root;
let log;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "fast-coverage-blobs-")));
  log = join(root, "curl.log");
  mkdirSync(join(root, "scripts", "ci"), { recursive: true });
  mkdirSync(join(root, "bin"));
  for (const f of ["fast-coverage-blobs.sh", "reuse-env.sh"]) {
    if (existsSync(join(HERE, f))) copyFileSync(join(HERE, f), join(root, "scripts", "ci", f));
  }
  writeFileSync(join(root, "bin", "curl"), STUB_CURL);
  chmodSync(join(root, "bin", "curl"), 0o755);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function present(...ids) {
  mkdirSync(join(root, ".vitest", "blob"), { recursive: true });
  for (const i of ids) writeFileSync(join(root, ".vitest", "blob", `blob-${i}-2.json`), `{"local":${i}}`);
}
function run(env = {}, args = ["2"]) {
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) if (/^ORBIT_REUSE/u.test(k)) delete clean[k];
  const r = spawnSync("bash", ["scripts/ci/fast-coverage-blobs.sh", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...clean,
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      STUB_LOG: log,
      CI_JOB_TOKEN: "job-token-not-real",
      CI_API_V4_URL: API,
      CI_PROJECT_ID: "42",
      STUB_GONE: "",
      ...env,
    },
  });
  return r;
}
const curlLog = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
const blobs = () => (existsSync(join(root, ".vitest", "blob")) ? readdirSync(join(root, ".vitest", "blob")).sort() : []);

describe("fast-coverage-blobs.sh (#1933)", () => {
  it("succeeds without fetching when both shards left their blob here", () => {
    present(1, 2);
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(curlLog()).toBe("");
    expect(blobs()).toEqual(["blob-1-2.json", "blob-2-2.json"]);
  });

  it("fetches a reused shard's blob by job id with the job token, keeping the local one", () => {
    present(1);
    const r = run({ ORBIT_REUSE_FAST_2_2: "777" });
    expect(r.status, r.stderr).toBe(0);
    const calls = curlLog();
    expect(calls).toContain(`${API}/projects/42/jobs/777/artifacts/.vitest/blob/blob-2-2.json`);
    expect(calls).toContain("JOB-TOKEN: job-token-not-real");
    expect(calls).not.toContain("jobs/1");
    expect(blobs()).toEqual(["blob-1-2.json", "blob-2-2.json"]);
    expect(readFileSync(join(root, ".vitest", "blob", "blob-1-2.json"), "utf8")).toBe('{"local":1}');
    expect(readFileSync(join(root, ".vitest", "blob", "blob-2-2.json"), "utf8")).toContain("jobs/777/");
  });

  it("fetches both blobs when both shards stood on earlier runs, each by its own job id", () => {
    const r = run({ ORBIT_REUSE_FAST_1_2: "101", ORBIT_REUSE_FAST_2_2: "202" });
    expect(r.status, r.stderr).toBe(0);
    expect(curlLog()).toContain("jobs/101/artifacts/.vitest/blob/blob-1-2.json");
    expect(curlLog()).toContain("jobs/202/artifacts/.vitest/blob/blob-2-2.json");
    expect(blobs()).toEqual(["blob-1-2.json", "blob-2-2.json"]);
  });

  it("reads the stood-on job id from .orbit-reuse/reuse.env as well as the environment", () => {
    present(1);
    mkdirSync(join(root, ".orbit-reuse"));
    writeFileSync(join(root, ".orbit-reuse", "reuse.env"), "ORBIT_REUSE_FAST_2_2=555\n");
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(curlLog()).toContain("jobs/555/artifacts/.vitest/blob/blob-2-2.json");
  });

  it("fails clearly when a shard left no blob and stood on no earlier run", () => {
    present(1);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/2\/2/u);
    expect(r.stderr).toMatch(/no blob/iu);
    expect(r.stderr).toContain("ORBIT_REUSE=off");
    expect(r.stderr).toContain("ci: rerun");
  });

  it("fails when no blob exists at all", () => {
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/1\/2/u);
  });

  it("fails, naming the shard, when the stood-on job's artefact is gone", () => {
    present(1);
    const r = run({ ORBIT_REUSE_FAST_2_2: "777", STUB_GONE: "777" });
    expect(r.stderr).not.toContain("No such file");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/2\/2/u);
    expect(blobs()).not.toContain("blob-2-2.json");
  });

  it("never sends the reuse token", () => {
    present(1);
    const r = run({ ORBIT_REUSE_FAST_2_2: "777", ORBIT_REUSE_TOKEN: "reuse-token-not-real" });
    expect(r.status, r.stderr).toBe(0);
    expect(curlLog()).not.toContain("reuse-token-not-real");
    expect(r.stdout + r.stderr).not.toContain("reuse-token-not-real");
  });

  it("fails when the blob count differs from the shard count (a stray extra copy)", () => {
    present(1, 2);
    writeFileSync(join(root, ".vitest", "blob", "blob-1-3.json"), "{}");
    const r = run();
    expect(r.stderr).not.toContain("No such file");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/blob/iu);
  });

  it("takes the shard count from its argument", () => {
    mkdirSync(join(root, ".vitest", "blob"), { recursive: true });
    for (const i of [1, 2, 3]) writeFileSync(join(root, ".vitest", "blob", `blob-${i}-3.json`), "{}");
    const r = run({}, ["3"]);
    expect(r.status, r.stderr).toBe(0);
  });
});
