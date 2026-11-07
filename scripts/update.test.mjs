import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";

/*
 * Issue #1770: update.sh in the Orbit directory fetches the current
 * get-orbit.sh and runs it. curl is stubbed on PATH; no real network.
 * The stub serves get-orbit.sh for any URL naming get-orbit.sh and the
 * "published update.sh" for any other URL.
 */
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const updateSource = new URL("./update.sh", import.meta.url).pathname;
const repoRoot = new URL("..", import.meta.url).pathname;
const GET_ORBIT_URL = "https://raw.githubusercontent.com/tomlawesome/orbit/main/scripts/get-orbit.sh";
const PUBLISHED_UPDATE_URL = "https://raw.githubusercontent.com/tomlawesome/orbit/main/scripts/update.sh";

const directories = [];
afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop(), { recursive: true, force: true });
});

function makeDir(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  directories.push(dir);
  return dir;
}

const CURL_STUB = [
  "#!/usr/bin/env bash",
  'printf "%s\\n" "$*" >> "$STUB_DIR/curl.log"',
  'url=""; out=""; prev=""',
  'for a in "$@"; do',
  '  case "$a" in https://*|http://*|file://*) url="$a" ;; esac',
  '  if [ "$prev" = "-o" ] || [ "$prev" = "--output" ]; then out="$a"; fi',
  '  prev="$a"',
  "done",
  'case "$url" in',
  '  *get-orbit.sh*) src="$STUB_DIR/get-orbit.body" ;;',
  '  *) if [ -e "$STUB_DIR/published-update.fail" ]; then exit 22; fi; src="$STUB_DIR/published-update.body" ;;',
  "esac",
  'if [ -n "$out" ]; then cat "$src" > "$out"; else cat "$src"; fi',
  "",
].join("\n");

function getOrbitBody(exitCode) {
  return [
    "#!/usr/bin/env bash",
    '{ printf "cwd=%s\\n" "$(pwd -P)"; if [ "${ORBIT_VERSION+set}" = set ]; then printf "version=%s\\n" "$ORBIT_VERSION"; else printf "version-unset\\n"; fi; } >> "$STUB_DIR/get-orbit.log"',
    `exit ${exitCode}`,
    "",
  ].join("\n");
}

function setup({ getOrbitExit = 0, publishedSame = true, publishedFails = false } = {}) {
  const stubDir = makeDir("orbit-update-stub-");
  const orbitDir = makeDir("orbit-update-dir-");
  const elsewhere = makeDir("orbit-update-elsewhere-");
  const bin = join(stubDir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "curl"), CURL_STUB);
  chmodSync(join(bin, "curl"), 0o755);
  const installed = join(orbitDir, "update.sh");
  copyFileSync(updateSource, installed);
  chmodSync(installed, 0o755);
  writeFileSync(join(stubDir, "get-orbit.body"), getOrbitBody(getOrbitExit));
  writeFileSync(
    join(stubDir, "published-update.body"),
    publishedSame ? readFileSync(updateSource, "utf8") : "#!/usr/bin/env bash\n# a newer update.sh\n",
  );
  if (publishedFails) writeFileSync(join(stubDir, "published-update.fail"), "");
  return { stubDir, orbitDir, elsewhere, installed, bin };
}

function run(ctx, env = {}) {
  const base = { ...process.env, STUB_DIR: ctx.stubDir, PATH: `${ctx.bin}:${process.env.PATH}` };
  delete base.ORBIT_VERSION;
  const result = spawnSync(ctx.installed, [], { cwd: ctx.elsewhere, env: { ...base, ...env }, encoding: "utf8", timeout: 20000 });
  const logPath = join(ctx.stubDir, "get-orbit.log");
  const runs = existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean) : [];
  const curlLog = existsSync(join(ctx.stubDir, "curl.log")) ? readFileSync(join(ctx.stubDir, "curl.log"), "utf8") : "";
  const output = `${result.stdout}${result.stderr}`;
  return { result, runs, curlLog, output, lines: output.split("\n").filter((l) => l.trim() !== "") };
}

describe("update.sh (#1770)", () => {
  it("exists as an executable script in the source tree", () => {
    expect(existsSync(updateSource)).toBe(true);
    expect(spawnSync("bash", ["-n", updateSource]).status).toBe(0);
  });

  it("run from another directory, acts on its own directory", () => {
    const ctx = setup();
    const { result, runs } = run(ctx);
    expect(result.status).toBe(0);
    expect(runs).toContain(`cwd=${ctx.orbitDir}`);
  });

  it("fetches get-orbit.sh from the documented URL and runs it exactly once", () => {
    const ctx = setup();
    const { curlLog, runs } = run(ctx);
    expect(curlLog).toContain(GET_ORBIT_URL);
    expect(runs.filter((l) => l.startsWith("cwd="))).toHaveLength(1);
  });

  it("compares itself with the published scripts/update.sh on main", () => {
    const ctx = setup();
    const { curlLog } = run(ctx);
    expect(curlLog).toContain(PUBLISHED_UPDATE_URL);
  });

  it("passes ORBIT_VERSION through when set", () => {
    const ctx = setup();
    const { runs } = run(ctx, { ORBIT_VERSION: "v9.8.7" });
    expect(runs).toContain("version=v9.8.7");
  });

  it("leaves ORBIT_VERSION unset when it was unset", () => {
    const ctx = setup();
    const { runs } = run(ctx);
    expect(runs).toContain("version-unset");
  });

  it("prints exactly one line and still runs get-orbit.sh when the published update.sh differs", () => {
    const ctx = setup({ publishedSame: false });
    const { result, lines, runs } = run(ctx);
    expect(result.status).toBe(0);
    expect(lines).toHaveLength(1);
    expect(runs.filter((l) => l.startsWith("cwd="))).toHaveLength(1);
  });

  it("prints nothing about it when the published update.sh is the same", () => {
    const ctx = setup({ publishedSame: true });
    const { result, lines, runs } = run(ctx);
    expect(result.status).toBe(0);
    expect(lines).toHaveLength(0);
    expect(runs.filter((l) => l.startsWith("cwd="))).toHaveLength(1);
  });

  it("passes a failing get-orbit.sh exit code through", () => {
    const ctx = setup({ getOrbitExit: 7 });
    const { result } = run(ctx);
    expect(result.status).toBe(7);
  });

  it("still runs get-orbit.sh when the self-check fetch fails", () => {
    const ctx = setup({ publishedFails: true });
    const { result, runs } = run(ctx);
    expect(result.status).toBe(0);
    expect(runs.filter((l) => l.startsWith("cwd="))).toHaveLength(1);
  });

  it("passes the exit code through when the self-check fetch fails and get-orbit.sh fails", () => {
    const ctx = setup({ publishedFails: true, getOrbitExit: 5 });
    const { result, runs } = run(ctx);
    expect(result.status).toBe(5);
    expect(runs.filter((l) => l.startsWith("cwd="))).toHaveLength(1);
  });
});

describe("docs name ./update.sh as the way to update (#1770)", () => {
  const curlLine = `curl -fsSL ${GET_ORBIT_URL} | bash`;
  const installing = readFileSync(join(repoRoot, "docs", "installing.md"), "utf8");
  const upgrades = readFileSync(join(repoRoot, "docs", "upgrades-and-backups.md"), "utf8");

  it("installing.md names ./update.sh and keeps the curl line for installing", () => {
    expect(installing).toContain("./update.sh");
    expect(installing).toContain(curlLine);
  });

  it("upgrades-and-backups.md names ./update.sh", () => {
    expect(upgrades).toContain("./update.sh");
  });
});
