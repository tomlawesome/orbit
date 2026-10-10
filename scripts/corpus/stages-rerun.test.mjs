import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// #1374: scripts/corpus/stages-rerun.sh runs one shell command inside a
// throwaway Node container on the document-processing network:
//   stages-rerun.sh [--dry-run] '<shell command>'
// Written from the specification alone. A stub `docker` first on PATH records
// its argv (one JSON array per line) so no real container is ever started.
//
// Run standalone (like scripts/compose-project-name-resolution.test.mjs):
//   node --test scripts/corpus/stages-rerun.test.mjs

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "stages-rerun.sh");
const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: HERE, encoding: "utf8" }).trim();
const DEFAULT_NET = "orbit_orbit-document-processing";
const DEFAULT_IMAGE = "node:22";

const STUB = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "network" && args[1] === "inspect") process.exit(process.env.STUB_NET_FAIL ? 1 : 0);
if (args[0] === "run") process.exit(Number(process.env.STUB_RUN_EXIT || 0));
process.exit(0);
`;

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stages-rerun-"));
  writeFileSync(join(dir, "docker"), STUB);
  chmodSync(join(dir, "docker"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args, env = {}, cwd = dir) {
  const base = { ...process.env };
  delete base.ORBIT_STAGES_NETWORK;
  delete base.ORBIT_STAGES_IMAGE;
  delete base.STUB_NET_FAIL;
  delete base.STUB_RUN_EXIT;
  const r = spawnSync(SCRIPT, args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
    env: { ...base, PATH: `${dir}:${process.env.PATH}`, STUB_LOG: join(dir, "calls.log"), ...env },
  });
  assert.notEqual(r.error?.code, "ETIMEDOUT", "script killed on its deadline");
  return r;
}

function calls() {
  const log = join(dir, "calls.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const runCalls = () => calls().filter((c) => c[0] === "run");
const inspectCalls = () => calls().filter((c) => c[0] === "network" && c[1] === "inspect");
const after = (argv, flag) => argv[argv.indexOf(flag) + 1];

describe("stages-rerun.sh", () => {
  it("runs the command in a throwaway container with the default network and image", () => {
    const r = run(["echo hi"]);
    assert.equal(r.status, 0, r.stderr);
    const rc = runCalls();
    assert.equal(rc.length, 1);
    const argv = rc[0];
    assert.ok(argv.includes("--rm"));
    assert.equal(after(argv, "--network"), DEFAULT_NET);
    assert.equal(after(argv, "-w"), "/app");
    assert.equal(after(argv, "--entrypoint"), "sh");
    assert.ok(argv.includes(DEFAULT_IMAGE));
    assert.equal(after(argv, "-c"), "echo hi");
  });

  it("puts the image before the sh -c command and the command last", () => {
    run(["echo hi"]);
    const argv = runCalls()[0];
    assert.ok(argv.indexOf(DEFAULT_IMAGE) < argv.indexOf("-c"));
    assert.equal(argv.at(-1), "echo hi");
    assert.equal(argv.at(-2), "-c");
  });

  it("honours ORBIT_STAGES_NETWORK for both the inspect check and the run", () => {
    const r = run(["true"], { ORBIT_STAGES_NETWORK: "custom_net" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(after(runCalls()[0], "--network"), "custom_net");
    assert.ok(inspectCalls().every((c) => c.includes("custom_net")));
    assert.ok(inspectCalls().length >= 1);
  });

  it("honours ORBIT_STAGES_IMAGE", () => {
    const r = run(["true"], { ORBIT_STAGES_IMAGE: "node:24-slim" });
    assert.equal(r.status, 0, r.stderr);
    const argv = runCalls()[0];
    assert.ok(argv.includes("node:24-slim"));
    assert.ok(!argv.includes(DEFAULT_IMAGE));
  });

  it("honours both overrides together", () => {
    run(["true"], { ORBIT_STAGES_NETWORK: "n2", ORBIT_STAGES_IMAGE: "img:2" });
    const argv = runCalls()[0];
    assert.equal(after(argv, "--network"), "n2");
    assert.ok(argv.includes("img:2"));
  });

  it("mounts the git top level of its own checkout, from any current directory", () => {
    const r = run(["true"], {}, dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(after(runCalls()[0], "-v"), `${REPO_ROOT}:/app`);
  });

  it("mounts the same root when run from inside the repository", () => {
    run(["true"], {}, join(REPO_ROOT, "scripts"));
    assert.equal(after(runCalls()[0], "-v"), `${REPO_ROOT}:/app`);
  });

  it("checks the network exists before running anything", () => {
    run(["true"]);
    const all = calls();
    const firstInspect = all.findIndex((c) => c[0] === "network" && c[1] === "inspect");
    const firstRun = all.findIndex((c) => c[0] === "run");
    assert.ok(firstInspect >= 0 && firstInspect < firstRun);
    assert.ok(inspectCalls()[0].includes(DEFAULT_NET));
  });

  it("exits 2 naming the missing network and runs nothing when the network is absent", () => {
    const r = run(["echo hi"], { STUB_NET_FAIL: "1" });
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes(DEFAULT_NET), r.stderr);
    assert.match(r.stderr, /network/i);
    assert.match(r.stderr, /document-processing/i);
    assert.equal(runCalls().length, 0);
  });

  it("names a custom network in the missing-network message", () => {
    const r = run(["echo hi"], { STUB_NET_FAIL: "1", ORBIT_STAGES_NETWORK: "gone_net" });
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes("gone_net"), r.stderr);
    assert.equal(runCalls().length, 0);
  });

  it("exits 64 with usage on stderr when given no command", () => {
    const r = run([]);
    assert.equal(r.status, 64);
    assert.match(r.stderr, /usage/i);
    assert.equal(runCalls().length, 0);
  });

  it("exits 64 when the command is an empty string", () => {
    const r = run([""]);
    assert.equal(r.status, 64);
    assert.match(r.stderr, /usage/i);
    assert.equal(runCalls().length, 0);
  });

  it("exits 64 when --dry-run is given without a command", () => {
    const r = run(["--dry-run"]);
    assert.equal(r.status, 64);
    assert.match(r.stderr, /usage/i);
  });

  it("exits 64 when given two arguments", () => {
    const r = run(["echo", "hi"]);
    assert.equal(r.status, 64);
    assert.match(r.stderr, /usage/i);
    assert.equal(runCalls().length, 0);
  });

  it("exits 64 when given two arguments after --dry-run", () => {
    const r = run(["--dry-run", "echo", "hi"]);
    assert.equal(r.status, 64);
    assert.match(r.stderr, /usage/i);
  });

  it("--dry-run prints the docker run command on one line and calls no docker at all", () => {
    const r = run(["--dry-run", "echo hi"]);
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.trim();
    assert.equal(out.split("\n").length, 1, out);
    assert.match(out, /docker run/);
    assert.match(out, /--rm/);
    assert.ok(out.includes(DEFAULT_NET), out);
    assert.ok(out.includes(`${REPO_ROOT}:/app`), out);
    assert.ok(out.includes(DEFAULT_IMAGE), out);
    assert.ok(out.includes("echo hi"), out);
    assert.deepEqual(calls(), []);
  });

  it("--dry-run reflects the environment overrides and needs no network", () => {
    const r = run(["--dry-run", "true"], { ORBIT_STAGES_NETWORK: "n3", ORBIT_STAGES_IMAGE: "img:3", STUB_NET_FAIL: "1" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("n3") && r.stdout.includes("img:3"), r.stdout);
    assert.deepEqual(calls(), []);
  });

  it("passes the container's exit status through", () => {
    const r = run(["exit 7"], { STUB_RUN_EXIT: "7" });
    assert.equal(r.status, 7);
    assert.equal(runCalls().length, 1);
  });

  it("returns 0 when the container succeeds", () => {
    assert.equal(run(["true"], { STUB_RUN_EXIT: "0" }).status, 0);
  });

  it("delivers the command string to -c intact, with quotes, spaces and metacharacters", () => {
    const cmd = `node scripts/x.mjs --name "a b" 'c  d' && echo "$HOME" | wc -l; printf '%s\\n' "it's"`;
    const r = run([cmd]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(after(runCalls()[0], "-c"), cmd);
  });

  it("delivers a multi-line command string intact", () => {
    const cmd = "cd /app\n  ls  -l\n";
    run([cmd]);
    assert.equal(after(runCalls()[0], "-c"), cmd);
  });
});
