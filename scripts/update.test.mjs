import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";

/*
 * Issue #1770 (rewritten spec): update.sh in the Orbit directory first
 * updates itself from one fixed address, then runs the installer whose
 * address lives only in update.sh. curl is stubbed on PATH; no real network.
 * The stub serves the fixed update.sh address from published-update.body (or
 * fails it, or serves a body that differs on every fetch) and any other
 * address from installer.body, so the tests control the two separately.
 * Marker line of a valid update.sh: `# orbit-update-sh`. Loop guard:
 * ORBIT_UPDATE_SELF_REPLACED=1, which makes update.sh skip self-update.
 */
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const updateSource = new URL("./update.sh", import.meta.url).pathname;
const repoRoot = new URL("..", import.meta.url).pathname;
const GET_ORBIT_URL = "https://raw.githubusercontent.com/tomlawesome/orbit/main/scripts/get-orbit.sh";
const FIXED_UPDATE_URL = "https://raw.githubusercontent.com/tomlawesome/orbit/main/scripts/update.sh";
const MOVED_INSTALLER_URL = "https://installer.example.invalid/moved/install-orbit.sh";
const MARKER = "# orbit-update-sh";

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
  'if [ "$url" = "' + FIXED_UPDATE_URL + '" ]; then',
  '  if [ -e "$STUB_DIR/published-update.fail" ]; then exit 22; fi',
  '  src="$STUB_DIR/published-update.body"',
  '  if [ -e "$STUB_DIR/published-update.dynamic" ]; then',
  '    n=$(( $(cat "$STUB_DIR/dynamic.count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STUB_DIR/dynamic.count"',
  '    { cat "$src"; printf "# fetch %s\\n" "$n"; } > "$STUB_DIR/dynamic.out"; src="$STUB_DIR/dynamic.out"',
  "  fi",
  "else",
  '  if [ -e "$STUB_DIR/installer.fail" ]; then exit 22; fi',
  '  src="$STUB_DIR/installer.body"',
  "fi",
  'if [ -n "$out" ]; then cat "$src" > "$out"; else cat "$src"; fi',
  "",
].join("\n");

function installerBody(exitCode) {
  return [
    "#!/usr/bin/env bash",
    '{ printf "cwd=%s\\n" "$(pwd -P)"; if [ "${ORBIT_VERSION+set}" = set ]; then printf "version=%s\\n" "$ORBIT_VERSION"; else printf "version-unset\\n"; fi; } >> "$STUB_DIR/installer.log"',
    `exit ${exitCode}`,
    "",
  ].join("\n");
}

/* A valid update.sh whose installer address differs from today's. */
const NEW_COPY = [
  "#!/usr/bin/env bash",
  MARKER,
  'here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd -P)"',
  'cd "$here" || exit 1',
  'printf "newcopy args=" >> "$STUB_DIR/newcopy.log"; printf "[%s]" "$@" >> "$STUB_DIR/newcopy.log"; printf "\\n" >> "$STUB_DIR/newcopy.log"',
  `curl -fsSL ${MOVED_INSTALLER_URL} | bash`,
  "",
].join("\n");

function setup({ installerExit = 0, published = "same", publishedFails = false, dynamic = false } = {}) {
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
  writeFileSync(join(stubDir, "installer.body"), installerBody(installerExit));
  writeFileSync(join(stubDir, "published-update.body"), published === "same" ? readFileSync(updateSource, "utf8") : published);
  if (publishedFails) writeFileSync(join(stubDir, "published-update.fail"), "");
  if (dynamic) writeFileSync(join(stubDir, "published-update.dynamic"), "");
  return { stubDir, orbitDir, elsewhere, installed, bin, before: readFileSync(installed, "utf8") };
}

function readLines(path) {
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
}

function run(ctx, { env = {}, args = [], script = ctx.installed } = {}) {
  const base = { ...process.env, STUB_DIR: ctx.stubDir, PATH: `${ctx.bin}:${process.env.PATH}` };
  delete base.ORBIT_VERSION;
  delete base.ORBIT_UPDATE_SELF_REPLACED;
  const result = spawnSync(script, args, { cwd: ctx.elsewhere, env: { ...base, ...env }, encoding: "utf8", timeout: 20000 });
  const runs = readLines(join(ctx.stubDir, "installer.log"));
  const curlLog = existsSync(join(ctx.stubDir, "curl.log")) ? readFileSync(join(ctx.stubDir, "curl.log"), "utf8") : "";
  const curlLines = curlLog.split("\n").filter(Boolean);
  const output = `${result.stdout}${result.stderr}`;
  return {
    result,
    runs,
    installerRuns: runs.filter((l) => l.startsWith("cwd=")),
    curlLog,
    fixedFetches: curlLines.filter((l) => l.includes(FIXED_UPDATE_URL)).length,
    installerFetches: curlLines.filter((l) => !l.includes(FIXED_UPDATE_URL)),
    newCopyRuns: readLines(join(ctx.stubDir, "newcopy.log")),
    output,
  };
}

function modeOf(path) {
  return statSync(path).mode & 0o777;
}

function expectNoLeftovers(ctx) {
  expect(readdirSync(ctx.orbitDir)).toEqual(["update.sh"]);
}

describe("update.sh (#1770)", () => {
  it("exists as a valid shell script in the source tree and carries the marker line", () => {
    expect(existsSync(updateSource)).toBe(true);
    expect(spawnSync("bash", ["-n", updateSource]).status).toBe(0);
    expect(readFileSync(updateSource, "utf8").split("\n")).toContain(MARKER);
  });

  describe("same copy published", () => {
    it("checks the fixed address, does not replace itself, and runs the installer from the Orbit directory", () => {
      const ctx = setup();
      const r = run(ctx);
      expect(r.result.status).toBe(0);
      expect(r.fixedFetches).toBeGreaterThanOrEqual(1);
      expect(readFileSync(ctx.installed, "utf8")).toBe(ctx.before);
      expect(r.installerRuns).toEqual([`cwd=${ctx.orbitDir}`]);
      expect(r.curlLog).toContain(GET_ORBIT_URL);
      expectNoLeftovers(ctx);
    });

    it("passes ORBIT_VERSION through when set", () => {
      const ctx = setup();
      expect(run(ctx, { env: { ORBIT_VERSION: "v9.8.7" } }).runs).toContain("version=v9.8.7");
    });

    it("leaves ORBIT_VERSION unset when it was unset", () => {
      const ctx = setup();
      expect(run(ctx).runs).toContain("version-unset");
    });

    it("passes a failing installer's exit code through", () => {
      const ctx = setup({ installerExit: 7 });
      expect(run(ctx).result.status).toBe(7);
    });
  });

  describe("changed copy published", () => {
    it("replaces itself with the new content, keeps mode 0755, and leaves no temporary files", () => {
      const ctx = setup({ published: NEW_COPY });
      const r = run(ctx);
      expect(r.result.status).toBe(0);
      expect(readFileSync(ctx.installed, "utf8")).toBe(NEW_COPY);
      expect(modeOf(ctx.installed)).toBe(0o755);
      expectNoLeftovers(ctx);
    });

    it("runs the new copy with the same arguments, so the new installer address is used and the old one is not", () => {
      const ctx = setup({ published: NEW_COPY });
      const r = run(ctx, { args: ["--flag", "two words"] });
      expect(r.result.status).toBe(0);
      expect(r.newCopyRuns).toEqual(["newcopy args=[--flag][two words]"]);
      expect(r.curlLog).toContain(MOVED_INSTALLER_URL);
      expect(r.curlLog).not.toContain(GET_ORBIT_URL);
      expect(r.installerRuns).toEqual([`cwd=${ctx.orbitDir}`]);
    });

    it("passes the new copy's installer exit code through", () => {
      const ctx = setup({ published: NEW_COPY, installerExit: 4 });
      expect(run(ctx).result.status).toBe(4);
    });

    it("replaces the real file, not the symlink, when started through a symlink", () => {
      const ctx = setup({ published: NEW_COPY });
      const link = join(ctx.elsewhere, "update.sh");
      symlinkSync(ctx.installed, link);
      const r = run(ctx, { script: link });
      expect(r.result.status).toBe(0);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(ctx.installed, "utf8")).toBe(NEW_COPY);
      expect(readdirSync(ctx.elsewhere)).toEqual(["update.sh"]);
      expectNoLeftovers(ctx);
    });
  });

  describe("loop guard", () => {
    it("replaces itself at most once when the published copy differs on every fetch, and does not loop", () => {
      const ctx = setup({ dynamic: true });
      const r = run(ctx);
      expect(r.result.status).toBe(0);
      expect(r.fixedFetches).toBe(1);
      expect(readFileSync(ctx.installed, "utf8")).toContain("# fetch 1");
      expect(readFileSync(ctx.installed, "utf8")).not.toContain("# fetch 2");
      expect(r.installerRuns).toHaveLength(1);
      expectNoLeftovers(ctx);
    });

    it("skips self-update entirely when ORBIT_UPDATE_SELF_REPLACED=1 is set", () => {
      const ctx = setup({ published: NEW_COPY });
      const r = run(ctx, { env: { ORBIT_UPDATE_SELF_REPLACED: "1" } });
      expect(r.result.status).toBe(0);
      expect(r.fixedFetches).toBe(0);
      expect(readFileSync(ctx.installed, "utf8")).toBe(ctx.before);
      expect(r.installerRuns).toEqual([`cwd=${ctx.orbitDir}`]);
      expect(r.curlLog).toContain(GET_ORBIT_URL);
    });
  });

  describe("invalid download", () => {
    const cases = {
      empty: "",
      "a shell script without the marker line": "#!/usr/bin/env bash\necho hello\n",
      "not a shell script (an HTML page carrying the marker)": `<html><body>404 Not Found</body></html>\n${MARKER}\n`,
    };
    for (const [name, body] of Object.entries(cases)) {
      it(`stops without replacing itself or running anything: ${name}`, () => {
        const ctx = setup({ published: body });
        const r = run(ctx);
        expect(r.result.status).not.toBe(0);
        expect(r.result.status).not.toBeNull();
        expect(r.output.trim()).not.toBe("");
        expect(readFileSync(ctx.installed, "utf8")).toBe(ctx.before);
        expect(r.installerFetches).toEqual([]);
        expect(r.runs).toEqual([]);
        expect(r.newCopyRuns).toEqual([]);
        expectNoLeftovers(ctx);
      });
    }
  });

  describe("self-update download fails", () => {
    it("says so, exits non-zero, and fetches and runs no installer", () => {
      const ctx = setup({ publishedFails: true });
      const r = run(ctx);
      expect(r.result.status).not.toBe(0);
      expect(r.result.status).not.toBeNull();
      expect(r.output.trim()).not.toBe("");
      expect(r.installerFetches).toEqual([]);
      expect(r.runs).toEqual([]);
      expect(readFileSync(ctx.installed, "utf8")).toBe(ctx.before);
      expectNoLeftovers(ctx);
    });
  });

  describe("where it runs", () => {
    it("run from another directory, acts on its own directory", () => {
      const ctx = setup();
      const r = run(ctx);
      expect(r.result.status).toBe(0);
      expect(r.installerRuns).toEqual([`cwd=${ctx.orbitDir}`]);
    });

    it("run through a symlink, acts on the real Orbit directory", () => {
      const ctx = setup();
      const link = join(ctx.elsewhere, "update-link.sh");
      symlinkSync(ctx.installed, link);
      const r = run(ctx, { script: link });
      expect(r.result.status).toBe(0);
      expect(r.installerRuns).toEqual([`cwd=${ctx.orbitDir}`]);
      expectNoLeftovers(ctx);
    });
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

  it("installer-guarantees.md records the fixed update.sh address as a promise", () => {
    const guarantees = readFileSync(join(repoRoot, "docs", "installer-guarantees.md"), "utf8");
    expect(guarantees).toContain(FIXED_UPDATE_URL);
  });
});
