import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// #1793: scripts/test-backend.sh checks, before any work, that pdfinfo and
// pdftoppm (poppler) are installed, and stops at once with one stderr line if
// either is missing. Written from the specification alone. Stub `node` and
// `pnpm` first on PATH log every call, so nothing real runs.
//
// Run standalone: node --test scripts/test-backend-poppler-precheck.test.mjs

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "test-backend.sh");

const MESSAGE =
  "test-backend: pdfinfo and pdftoppm (poppler) are not installed; the document tests need them. Install poppler-utils and fonts-liberation, then run again.";

const STUB_NODE = `#!/bin/sh
printf 'node\\t%s\\n' "$*" >> "$STUB_LOG"
exit 0
`;
const STUB_PNPM = `#!/bin/sh
printf 'pnpm\\t%s\\n' "$*" >> "$STUB_LOG"
exit 0
`;
const STUB_POPPLER = `#!/bin/sh
exit 0
`;

let root;
let repo;
let stubs;
let sysbin;
let log;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "test-backend-poppler-")));
  repo = join(root, "repo");
  stubs = join(root, "stubs");
  sysbin = join(root, "sysbin");
  log = join(root, "calls.log");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "node_modules"), { recursive: true });
  mkdirSync(join(repo, "web", "node_modules"), { recursive: true });
  mkdirSync(stubs);
  mkdirSync(sysbin);
  copyFileSync(SCRIPT, join(repo, "scripts", "test-backend.sh"));
  writeFileSync(join(repo, "pnpm-lock.yaml"), "");
  const git = (...a) => {
    const r = spawnSync("git", a, { cwd: repo, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  git("init", "-q");
  git("add", "pnpm-lock.yaml");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
  stub("node", STUB_NODE);
  stub("pnpm", STUB_PNPM);
  // System tools, minus any real poppler, so the PATH is deterministic.
  for (const dir of ["/usr/bin", "/bin"]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name === "pdfinfo" || name === "pdftoppm" || name === "node" || name === "pnpm") continue;
      const dest = join(sysbin, name);
      if (!existsSync(dest)) {
        try {
          symlinkSync(join(dir, name), dest);
        } catch {
          // ignore unreadable entries
        }
      }
    }
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function stub(name, body) {
  writeFileSync(join(stubs, name), body);
  chmodSync(join(stubs, name), 0o755);
}

function run() {
  const env = { ...process.env, PATH: `${stubs}:${sysbin}`, STUB_LOG: log };
  delete env.CI;
  delete env.STUB_BUILD_NEEDED;
  delete env.ORBIT_TEST_COVERAGE;
  const r = spawnSync("bash", [join(repo, "scripts", "test-backend.sh")], {
    cwd: repo,
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
    env,
  });
  assert.notEqual(r.error?.code, "ETIMEDOUT", "script killed on its deadline");
  return r;
}

const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);

describe("test-backend.sh poppler preflight", () => {
  it("P1: pdftoppm missing: exit 1, the exact stderr line, no tool called", () => {
    stub("pdfinfo", STUB_POPPLER);
    const r = run();
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.equal(r.stderr.trim(), MESSAGE);
    assert.deepEqual(calls(), []);
  });

  it("P2: pdfinfo missing: exit 1, the exact stderr line, no tool called", () => {
    stub("pdftoppm", STUB_POPPLER);
    const r = run();
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.equal(r.stderr.trim(), MESSAGE);
    assert.deepEqual(calls(), []);
  });

  it("P3: both present: no preflight message and the script goes on", () => {
    stub("pdfinfo", STUB_POPPLER);
    stub("pdftoppm", STUB_POPPLER);
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stderr.includes("poppler"), r.stderr);
    assert.ok(calls().length > 0, "stub tools were called");
  });
});
