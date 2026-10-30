import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// #1557: scripts/test-backend.sh builds the web app unless
// `node scripts/web-build-stamp.mjs check` says a build of these exact sources
// exists. Without pnpm it runs vite directly; in an agent worktree
// `node_modules` is a symlink to the main checkout's, which pnpm refuses, so
// the direct-node path must be used there even when pnpm is installed.
// Written from the specification alone. Stub `node` and `pnpm` programs first
// on PATH append `<name>\t<cwd>\t<args>` to a log, so nothing real runs.
//
// Run standalone: node --test scripts/test-backend-build-path.test.mjs

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "test-backend.sh");

const STUB_NODE = `#!/bin/sh
printf 'node\\t%s\\t%s\\n' "$PWD" "$*" >> "$STUB_LOG"
if [ "$*" = "scripts/web-build-stamp.mjs check" ] && [ -n "$STUB_BUILD_NEEDED" ]; then exit 1; fi
exit 0
`;
const STUB_PNPM = `#!/bin/sh
printf 'pnpm\\t%s\\t%s\\n' "$PWD" "$*" >> "$STUB_LOG"
exit 0
`;

let root;
let repo;
let stubs;
let log;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "test-backend-path-")));
  repo = join(root, "repo");
  stubs = join(root, "stubs");
  log = join(root, "calls.log");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "web"), { recursive: true });
  mkdirSync(stubs);
  copyFileSync(SCRIPT, join(repo, "scripts", "test-backend.sh"));
  writeFileSync(join(repo, "pnpm-lock.yaml"), "");
  const git = (...a) => {
    const r = spawnSync("git", a, { cwd: repo, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  git("init", "-q");
  git("add", "pnpm-lock.yaml");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
  writeFileSync(join(stubs, "node"), STUB_NODE);
  chmodSync(join(stubs, "node"), 0o755);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Create <repo>/<rel> as a real directory or as a symlink to one elsewhere. */
function modules(rel, symlinked) {
  const target = symlinked ? join(root, "shared", rel) : join(repo, rel);
  mkdirSync(target, { recursive: true });
  if (symlinked) symlinkSync(target, join(repo, rel));
}

function run({ pnpm, buildNeeded }) {
  if (pnpm) {
    writeFileSync(join(stubs, "pnpm"), STUB_PNPM);
    chmodSync(join(stubs, "pnpm"), 0o755);
  }
  const env = { ...process.env, PATH: `${stubs}:/usr/bin:/bin`, STUB_LOG: log };
  delete env.CI;
  delete env.STUB_BUILD_NEEDED;
  delete env.ORBIT_TEST_COVERAGE;
  if (buildNeeded) env.STUB_BUILD_NEEDED = "1";
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

function calls() {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [name, cwd, args] = l.split("\t");
      return { name, cwd: cwd === repo ? "." : cwd.replace(`${repo}/`, ""), args };
    });
}

const pnpmCalls = () => calls().filter((c) => c.name === "pnpm");
const nodeCalls = () => calls().filter((c) => c.name === "node");

function assertDirectNodeBuild() {
  const nc = nodeCalls();
  const idx = (cwd, args) => nc.findIndex((c) => c.cwd === cwd && c.args === args);
  const lic = idx("web", "scripts/collect-font-licences.mjs");
  const vite = idx("web", "node_modules/vite/bin/vite.js build");
  const stamp = idx("web", "../scripts/web-build-stamp.mjs write");
  assert.ok(lic >= 0, `licence collector in web/: ${JSON.stringify(nc)}`);
  assert.ok(vite > lic, `vite from web/node_modules after the collector: ${JSON.stringify(nc)}`);
  assert.ok(stamp > vite, `stamp write in web/ after vite: ${JSON.stringify(nc)}`);
  assert.equal(
    nc.filter((c) => c.args.includes("../node_modules/vite")).length,
    0,
    "vite is never run from ../node_modules",
  );
}

describe("test-backend.sh web build path", () => {
  it("(a) no pnpm: runs vite from web/node_modules with the licence collector and stamp write", () => {
    modules("node_modules", false);
    modules("web/node_modules", false);
    const r = run({ pnpm: false, buildNeeded: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(pnpmCalls().length, 0);
    assertDirectNodeBuild();
  });

  it("(b) pnpm present but node_modules symlinked: no pnpm call at all, direct-node build", () => {
    modules("node_modules", true);
    modules("web/node_modules", false);
    const r = run({ pnpm: true, buildNeeded: true });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(pnpmCalls(), []);
    assertDirectNodeBuild();
  });

  it("(c) pnpm present but only web/node_modules symlinked: no pnpm call at all, direct-node build", () => {
    modules("node_modules", false);
    modules("web/node_modules", true);
    const r = run({ pnpm: true, buildNeeded: true });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(pnpmCalls(), []);
    assertDirectNodeBuild();
  });

  it("(d) pnpm present and real directories: builds with pnpm --filter orbit-web build", () => {
    modules("node_modules", false);
    modules("web/node_modules", false);
    const r = run({ pnpm: true, buildNeeded: true });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(
      pnpmCalls().some((c) => c.args === "--filter orbit-web build"),
      JSON.stringify(pnpmCalls()),
    );
    assert.equal(nodeCalls().filter((c) => c.args.includes("vite")).length, 0, "no direct vite run");
  });

  it("(e) no pnpm, build skipped: still runs svelte-kit sync for web/ with node", () => {
    modules("node_modules", false);
    modules("web/node_modules", false);
    const r = run({ pnpm: false, buildNeeded: false });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(pnpmCalls(), []);
    assert.ok(
      nodeCalls().some((c) => c.args.includes("svelte-kit") && c.args.includes("sync")),
      JSON.stringify(nodeCalls()),
    );
    assert.equal(nodeCalls().filter((c) => c.args.includes("vite.js build")).length, 0, "no build");
  });
});
