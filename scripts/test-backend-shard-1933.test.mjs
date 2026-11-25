import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/*
 * #1933 (103a section 1): scripts/test-backend.sh honours ORBIT_TEST_SHARD in
 * the `tests` phase. The node --test guards run only in shard 1 (or unsharded);
 * vitest gets --shard; the coverage branch of a shard runs vitest with
 * --coverage and does not run the floor check (the merge job does). Same stub
 * method as test-backend-build-path.test.mjs: `node` and `pnpm` log their args.
 * Run: pnpm exec vitest run scripts/test-backend-shard-1933.test.mjs
 */
const HERE = new URL(".", import.meta.url).pathname;
const STUB = (name) => `#!/bin/sh\nprintf '${name}\\t%s\\n' "$*" >> "$STUB_LOG"\nexit 0\n`;

let root;
let log;
function setup({ symlinkedModules = false } = {}) {
  root = realpathSync(mkdtempSync(join(tmpdir(), "test-backend-shard-")));
  log = join(root, "calls.log");
  const repo = join(root, "repo");
  const stubs = join(root, "stubs");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "web"), { recursive: true });
  mkdirSync(stubs);
  copyFileSync(join(HERE, "test-backend.sh"), join(repo, "scripts", "test-backend.sh"));
  copyFileSync(join(HERE, "test-load-warning.sh"), join(repo, "scripts", "test-load-warning.sh"));
  writeFileSync(join(repo, "pnpm-lock.yaml"), "");
  const git = (...a) => spawnSync("git", a, { cwd: repo, encoding: "utf8" });
  git("init", "-q");
  git("add", "pnpm-lock.yaml");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
  if (symlinkedModules) {
    mkdirSync(join(root, "shared"));
    mkdirSync(join(root, "shared", "web"));
    mkdirSync(join(repo, "web"), { recursive: true });
    spawnSync("ln", ["-s", join(root, "shared"), join(repo, "node_modules")]);
  } else {
    mkdirSync(join(repo, "node_modules"));
    mkdirSync(join(repo, "web", "node_modules"));
  }
  for (const n of ["node", "pnpm", "pdfinfo", "pdftoppm"]) {
    writeFileSync(join(stubs, n), n === "pdfinfo" || n === "pdftoppm" ? "#!/bin/sh\nexit 0\n" : STUB(n));
    chmodSync(join(stubs, n), 0o755);
  }
  return { repo, stubs };
}
afterEach(() => root && rmSync(root, { recursive: true, force: true }));

function run(options, env = {}) {
  const { repo, stubs } = options;
  const clean = { ...process.env, PATH: `${stubs}:/usr/bin:/bin`, STUB_LOG: log, ORBIT_TEST_PHASE: "tests" };
  for (const k of ["CI", "ORBIT_TEST_COVERAGE", "ORBIT_TEST_CHANGED_BASE", "ORBIT_TEST_SHARD"]) delete clean[k];
  const r = spawnSync("bash", [join(repo, "scripts", "test-backend.sh")], { cwd: repo, encoding: "utf8", timeout: 60_000, env: { ...clean, ...env } });
  expect(r.status, r.stderr).toBe(0);
  const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return {
    guards: lines.filter((l) => /^node\t--test scripts\/(compose-project-name-resolution|scratch-dir-ignored|ci\/coverage-floor-check|ci\/check-cosign-calls)/u.test(l)),
    vitest: lines.filter((l) => /vitest/u.test(l)),
    floor: lines.filter((l) => /coverage-floor-check\.mjs/u.test(l) && !/--test/u.test(l)),
    lines,
  };
}

let ctx;
beforeEach(() => {
  ctx = setup();
});

describe("test-backend.sh with ORBIT_TEST_SHARD (#1933)", () => {
  it("shard 1/2 runs the node --test guards", () => {
    const r = run(ctx, { ORBIT_TEST_SHARD: "1/2" });
    expect(r.guards.length).toBeGreaterThanOrEqual(4);
    expect(r.lines.join("\n")).toContain("--shard=1/2");
    // unsharded: same guards, no --shard
    const plain = run(setup());
    expect(plain.guards.length).toBeGreaterThanOrEqual(4);
    expect(plain.lines.join("\n")).not.toContain("--shard");
  });

  it("shard 2/2 runs none of the node --test guards", () => {
    const r = run(ctx, { ORBIT_TEST_SHARD: "2/2" });
    expect(r.guards).toEqual([]);
    expect(r.lines.filter((l) => /^node\t--test /u.test(l) && !/lockfile-no-pnpm-exe/u.test(l))).toEqual([]);
  });

  it("a plain shard run gives vitest --shard=<index>/<count>", () => {
    const r = run(ctx, { ORBIT_TEST_SHARD: "2/2" });
    expect(r.lines.join("\n")).toContain("--shard=2/2");
  });

  it("a coverage shard run is `vitest run --coverage --shard=...` and runs no floor check", () => {
    const r = run(ctx, { ORBIT_TEST_SHARD: "1/2", ORBIT_TEST_COVERAGE: "true" });
    expect(r.lines).toContain("pnpm\texec vitest run --coverage --shard=1/2");
    expect(r.floor).toEqual([]);
    expect(r.lines.join("\n")).not.toContain("test:coverage");
    // unsharded coverage (local runs) is unchanged: test:coverage, then the floor check
    const local = run(setup(), { ORBIT_TEST_COVERAGE: "true" });
    expect(local.lines).toContain("pnpm\ttest:coverage");
    expect(local.floor).toHaveLength(1);
  });

  it("a narrowed shard run is `--changed <base> --shard=... --passWithNoTests`", () => {
    const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ctx.repo, encoding: "utf8" }).stdout.trim();
    const r = run(ctx, { ORBIT_TEST_SHARD: "2/2", ORBIT_TEST_CHANGED_BASE: base });
    expect(r.lines).toContain(`pnpm\texec vitest run --changed ${base} --shard=2/2 --passWithNoTests`);
    expect(r.floor).toEqual([]);
  });

  it("the direct-node fallback mirrors the three branches", () => {
    const fallback = setup({ symlinkedModules: true });
    // pnpm is on PATH but node_modules is a symlink, so the script takes the direct-node path
    const coverage = run(fallback, { ORBIT_TEST_SHARD: "1/2", ORBIT_TEST_COVERAGE: "true" });
    expect(coverage.lines).toContain("node\tnode_modules/vitest/vitest.mjs run --coverage --shard=1/2");
    expect(coverage.floor).toEqual([]);
    const plain = run(fallback, { ORBIT_TEST_SHARD: "2/2" });
    expect(plain.lines).toContain("node\tnode_modules/vitest/vitest.mjs run --shard=2/2");
    const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: fallback.repo, encoding: "utf8" }).stdout.trim();
    const narrowed = run(fallback, { ORBIT_TEST_SHARD: "2/2", ORBIT_TEST_CHANGED_BASE: base });
    expect(narrowed.lines).toContain(`node\tnode_modules/vitest/vitest.mjs run --changed ${base} --shard=2/2 --passWithNoTests`);
  });
});
