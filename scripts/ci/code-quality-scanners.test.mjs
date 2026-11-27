/**
 * #1596: report-only knip (unused files, exports, dependencies) and jscpd
 * (duplication) checks, built like #1592's scanners. Written before the code;
 * everything here fails until the builder provides the seams below.
 *
 * SEAMS THE BUILDER MUST PROVIDE
 *
 *  Scripts (bash, run from any cwd, resolve the repo root themselves):
 *    scripts/ci/ensure-jscpd.sh   pinned, verified jscpd; prints its executable path on stdout.
 *                                 Constants in the file: JSCPD_VERSION="5.x.y" (exact) and
 *                                 JSCPD_SHA256="<64 hex>". Refuses (non-zero, nothing printed,
 *                                 message mentions the SHA-256 / checksum) when the download does not match.
 *    scripts/ci/scan-jscpd.sh     runs jscpd over src, web/src, scripts; report-only.
 *    scripts/ci/ensure-knip.sh    installs tools/knip (lockfile, --ignore-scripts) and the app's own
 *                                 dependencies (--ignore-scripts); prints the directory holding the
 *                                 installed tool on stdout.
 *    scripts/ci/scan-knip.sh      builds the nested `docker run` and copies the report out; report-only.
 *
 *  Environment variables (all optional; defaults are the real thing in CI):
 *    ORBIT_TOOL_CACHE         cache root for the ensure scripts (same name as ensure-opengrep.sh).
 *    ORBIT_JSCPD_URL          URL of the pinned jscpd artifact; ensure-jscpd.sh downloads from it
 *                             (file:// must work). The pin is NOT overridable: a wrong file is refused.
 *    ORBIT_JSCPD_ENSURE       path of the script scan-jscpd.sh runs instead of scripts/ci/ensure-jscpd.sh.
 *    ORBIT_KNIP_ENSURE        same, for scan-knip.sh and scripts/ci/ensure-knip.sh.
 *                             Both: the scan uses the script's stdout as the tool and exits non-zero,
 *                             without running the tool, if the script fails.
 *    ORBIT_CODE_SCAN_DIR      report directory (default ".orbit-code-scan", relative to the repo root);
 *                             reports are <dir>/jscpd.json and <dir>/knip.json.
 *
 *  Calling conventions the fakes rely on:
 *    jscpd:  scan-jscpd.sh calls `<jscpd> ... --output <dir> ...` (jscpd's documented flag; also
 *            --output=<dir> or -o) with a json reporter, then copies <dir>/jscpd-report.json to
 *            <report dir>/jscpd.json. argv names the targets src, web/src, scripts, the formats
 *            typescript/javascript/svelte, and ignores for tests, drizzle and tmp.
 *    docker: scan-knip.sh calls `docker` found on PATH (no absolute path). The container is made by
 *            `docker run` or `docker create` (the hardening flags go on that call). The report leaves
 *            on STDOUT, never by `docker cp` (which would need an uncapped volume): knip writes its
 *            JSON to stdout and scan-knip.sh reads it from `docker run` (no -d), `docker start
 *            --attach`, or `docker logs`, with a size cap, and writes <report dir>/knip.json.
 *            The fake refuses `docker cp` out of a container (copying in is allowed). A non-zero knip exit with a valid JSON report is
 *            "findings" (scan exits 0); no valid report on stdout means scan exits non-zero.
 *            Writable space is a --tmpfs (or --mount type=tmpfs) with a size cap; no -v/--volume
 *            and no --mount type=volume.
 *
 *  Files: tools/knip/package.json + a lockfile (pnpm-lock.yaml or package-lock.json) with integrity
 *  hashes, outside the pnpm workspace; knip.json at the repo root; renovate.json ignorePaths names
 *  tools/knip; .gitlab-ci.yml has job knip_scan and code_scanners runs jscpd.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../process-budget.mjs";
import { jobBlock } from "../test-support/gitlab-ci.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const repo = new URL("../../", import.meta.url).pathname;
const at = (p) => join(repo, p);
const read = (p) => readFileSync(at(p), "utf8");
const scriptText = (p) => (existsSync(at(p)) ? read(p) : "");

function scratch(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}
function executable(path, body) {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function run(script, env, label) {
  // A missing script must fail the test, not read as "exited non-zero".
  expect(existsSync(at(script)), `${script} does not exist`).toBe(true);
  return failOnProcessDeadline(
    spawnSync("bash", [at(script)], {
      encoding: "utf8",
      cwd: tmpdir(),
      env: { PATH: process.env.PATH, HOME: process.env.HOME ?? tmpdir(), ...env },
      ...processGuard(),
    }),
    { label },
  );
}

// ---------------------------------------------------------------- manifest
describe("tools/knip manifest", () => {
  const manifestPath = "tools/knip/package.json";
  const manifest = () => JSON.parse(read(manifestPath));

  it("pins knip to an exact version and every dependency without a range", () => {
    const m = manifest();
    expect(m.dependencies?.knip ?? m.devDependencies?.knip).toMatch(/^\d+\.\d+\.\d+$/);
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, version] of Object.entries(m[section] ?? {})) {
        expect(version, `${name} in ${section}`).toMatch(/^\d+\.\d+\.\d+$/);
      }
    }
  });

  it("has a lockfile with an integrity hash for every package", () => {
    const pnpmLock = at("tools/knip/pnpm-lock.yaml");
    const npmLock = at("tools/knip/package-lock.json");
    expect(existsSync(pnpmLock) || existsSync(npmLock)).toBe(true);
    const knipVersion = manifest().dependencies?.knip ?? manifest().devDependencies?.knip;
    if (existsSync(pnpmLock)) {
      const text = readFileSync(pnpmLock, "utf8");
      const section = text.split(/^packages:\s*$/m)[1]?.split(/^snapshots:\s*$/m)[0] ?? "";
      const entries = section.split(/^ {2}(?=\S)/m).filter((e) => e.trim());
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry, entry.split("\n")[0]).toMatch(/integrity: sha(256|512)-/);
      }
      expect(text).toContain(`knip@${knipVersion}`);
    } else {
      const lock = JSON.parse(readFileSync(npmLock, "utf8"));
      const pkgs = Object.entries(lock.packages ?? {}).filter(([path]) => path !== "");
      expect(pkgs.length).toBeGreaterThan(0);
      for (const [path, pkg] of pkgs) expect(pkg.integrity, path).toMatch(/^sha(256|512)-/);
    }
  });

  it("is not part of Orbit's pnpm workspace or root package.json", () => {
    const workspace = read("pnpm-workspace.yaml");
    const packages = workspace.match(/^packages:\n((?: {2}- .*\n)+)/m)?.[1] ?? "";
    expect(packages).not.toMatch(/tools/);
    expect(packages).not.toMatch(/\*/);
    const root = JSON.parse(read("package.json"));
    expect(root.workspaces).toBeUndefined();
    for (const section of ["dependencies", "devDependencies"]) expect(root[section]?.knip).toBeUndefined();
    expect(existsSync(at(manifestPath))).toBe(true);
  });

  it("is ignored by Renovate", () => {
    const renovate = JSON.parse(read("renovate.json"));
    expect((renovate.ignorePaths ?? []).some((p) => p.startsWith("tools/knip"))).toBe(true);
  });

  it("has a knip.json at the repo root naming the app, web and scripts entry points", () => {
    const text = read("knip.json");
    JSON.parse(text);
    for (const dir of ["src", "web", "scripts"]) expect(text).toContain(dir);
  });
});

// ------------------------------------------------------------ ensure-jscpd
describe("ensure-jscpd.sh", () => {
  it("pins an exact 5.x version and a SHA-256", () => {
    const text = scriptText("scripts/ci/ensure-jscpd.sh");
    expect(text).toMatch(/JSCPD_VERSION="5\.\d+\.\d+"/);
    expect(text).toMatch(/JSCPD_SHA256="[0-9a-f]{64}"/);
  });

  it("refuses an artifact whose checksum does not match the pin", () => {
    const dir = scratch("jscpd-ensure");
    const fake = join(dir, "jscpd-artifact");
    writeFileSync(fake, "not the pinned jscpd\n");
    const cache = join(dir, "cache");
    const r = run("scripts/ci/ensure-jscpd.sh", { ORBIT_TOOL_CACHE: cache, ORBIT_JSCPD_URL: `file://${fake}` }, "ensure-jscpd");
    expect(r.status).not.toBe(0);
    expect(r.stdout.trim()).toBe("");
    expect(r.stderr).toMatch(/sha-?256|checksum/i);
    // Nothing from the refused download was left where a later run would take it for verified.
    const left = existsSync(cache) ? readdirSync(cache, { recursive: true }).filter((f) => /jscpd$/.test(String(f))) : [];
    expect(left).toEqual([]);
  });
});

// -------------------------------------------------------------- scan-jscpd
function jscpdWorld({ exit = 0, writeReport = true } = {}) {
  const dir = scratch("scan-jscpd");
  const argvLog = join(dir, "argv.json");
  const fakeJscpd = join(dir, "jscpd");
  executable(
    fakeJscpd,
    `node -e 'require("fs").writeFileSync(process.env.FAKE_ARGV_LOG, JSON.stringify(process.argv.slice(1)))' -- "$@"
out=""
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  case "\${args[i]}" in
    --output|-o) out="\${args[i+1]}" ;;
    --output=*) out="\${args[i]#--output=}" ;;
  esac
done
if [[ "$FAKE_WRITE_REPORT" == 1 && -n "$out" ]]; then
  mkdir -p "$out"
  echo '{"statistics":{"total":{"clones":3}},"duplicates":[{"format":"typescript"}]}' > "$out/jscpd-report.json"
fi
exit ${exit}`,
  );
  const fakeEnsure = join(dir, "ensure.sh");
  executable(fakeEnsure, `echo ${fakeJscpd}`);
  const failingEnsure = join(dir, "ensure-fail.sh");
  executable(failingEnsure, `echo "ensure: checksum mismatch" >&2\nexit 1`);
  const reports = join(dir, "reports");
  const env = (ensure = fakeEnsure) => ({
    ORBIT_JSCPD_ENSURE: ensure,
    ORBIT_CODE_SCAN_DIR: reports,
    FAKE_ARGV_LOG: argvLog,
    FAKE_WRITE_REPORT: writeReport ? "1" : "0",
  });
  return { dir, argvLog, reports, env, failingEnsure };
}

describe("scan-jscpd.sh", () => {
  it("exits 0 with findings, writes jscpd.json and scans the right targets", () => {
    const w = jscpdWorld();
    const r = run("scripts/ci/scan-jscpd.sh", w.env(), "scan-jscpd");
    expect(r.status, r.stderr).toBe(0);
    const report = JSON.parse(readFileSync(join(w.reports, "jscpd.json"), "utf8"));
    expect(report.duplicates.length).toBe(1);
    const argv = JSON.parse(readFileSync(w.argvLog, "utf8"));
    const joined = argv.join(" ");
    for (const t of ["src", "web/src", "scripts"]) expect(argv).toContain(t);
    for (const f of ["typescript", "javascript", "svelte"]) expect(joined).toContain(f);
    // Assert on the --ignore value itself: the argv as a whole always holds
    // "tmp", because --output is a mktemp path under /tmp.
    const ignoreAt = argv.indexOf("--ignore");
    expect(ignoreAt).toBeGreaterThanOrEqual(0);
    const ignores = argv[ignoreAt + 1].split(",");
    for (const ignored of ["**/*.test.*", "**/*.spec.*", "**/tests/**", "**/drizzle/**", "**/tmp/**"]) {
      expect(ignores).toContain(ignored);
    }
  });

  it("exits non-zero, without running jscpd, when the tool cannot be fetched or verified", () => {
    const w = jscpdWorld();
    const r = run("scripts/ci/scan-jscpd.sh", w.env(w.failingEnsure), "scan-jscpd");
    expect(r.status).not.toBe(0);
    expect(existsSync(w.argvLog)).toBe(false);
  });

  it("exits non-zero when jscpd runs but fails and leaves no report", () => {
    const w = jscpdWorld({ exit: 2, writeReport: false });
    const r = run("scripts/ci/scan-jscpd.sh", w.env(), "scan-jscpd");
    expect(r.status).not.toBe(0);
  });

  it("defaults its report to .orbit-code-scan/jscpd.json", () => {
    expect(scriptText("scripts/ci/scan-jscpd.sh")).toContain(".orbit-code-scan");
    expect(scriptText("scripts/ci/scan-jscpd.sh")).toContain("jscpd.json");
  });
});

// --------------------------------------------------------------- scan-knip
const KNIP_REPORT = JSON.stringify({ files: ["src/unused.ts"], issues: [{ file: "src/a.ts", exports: [{ name: "x" }] }] });

function knipWorld({ dockerExit = 0, report = true, ensureOk = true } = {}) {
  const dir = scratch("scan-knip");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "docker.log");
  executable(
    join(bin, "docker"),
    `node -e 'require("fs").appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(process.argv.slice(1)) + "\\n")' -- "$@"
report() { [[ "$FAKE_DOCKER_REPORT" == 1 ]] && printf '%s' '${KNIP_REPORT}'; }
detached=0
for a in "$@"; do case "$a" in -d|--detach) detached=1 ;; esac; done
case "$1" in
  cp)
    # Copying IN (destination is container:path) is fine; copying OUT is refused.
    case "\${@: -1}" in *:*) exit 0 ;; esac
    echo "docker cp out is not available: the report must come out on stdout" >&2; exit 1 ;;
  create) echo fakecontainer ;;
  start)
    if [[ "$FAKE_DOCKER_FLOOD" == 1 ]]; then exec yes '{"files":[]}'; fi
    report; exit "\${FAKE_DOCKER_RUN_EXIT:-0}" ;;
  logs) report ;;
  kill|stop|rm) touch "$FAKE_DOCKER_LOG.stopped"; exit 0 ;;
  wait)
    if [[ "$FAKE_DOCKER_HANG" == 1 && ! -e "$FAKE_DOCKER_LOG.stopped" ]]; then sleep 60; fi
    echo "\${FAKE_DOCKER_RUN_EXIT:-0}" ;;
  run)
    if [[ "$detached" == 1 ]]; then echo fakecontainer; exit 0; fi
    report; exit "\${FAKE_DOCKER_RUN_EXIT:-0}" ;;
  *) exit 0 ;;
esac`,
  );
  const ensure = join(dir, "ensure.sh");
  executable(ensure, ensureOk ? `echo ${dir}/tools` : `echo "ensure: lockfile integrity mismatch" >&2\nexit 1`);
  const reports = join(dir, "reports");
  const env = (extra = {}) => ({
    PATH: `${bin}:${process.env.PATH}`,
    ORBIT_KNIP_ENSURE: ensure,
    ORBIT_CODE_SCAN_DIR: reports,
    FAKE_DOCKER_LOG: log,
    FAKE_DOCKER_REPORT: report ? "1" : "0",
    FAKE_DOCKER_RUN_EXIT: String(dockerExit),
    ...extra,
  });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, reports, env, calls };
}

const flagValue = (argv, flag) => {
  const i = argv.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
  if (i < 0) return undefined;
  return argv[i].includes("=") ? argv[i].split("=").slice(1).join("=") : argv[i + 1];
};

describe("scan-knip.sh", () => {
  it("exits 0 when knip reports findings (non-zero knip exit), and writes knip.json", () => {
    const w = knipWorld({ dockerExit: 1 });
    const r = run("scripts/ci/scan-knip.sh", w.env(), "scan-knip");
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(w.reports, "knip.json"), "utf8")).files).toEqual(["src/unused.ts"]);
    expect(w.calls().some((c) => c[0] === "cp" && !/:/.test(c[c.length - 1]))).toBe(false);
  });

  it("exits 0 and writes knip.json when knip finds nothing", () => {
    const w = knipWorld({ dockerExit: 0 });
    const r = run("scripts/ci/scan-knip.sh", w.env(), "scan-knip");
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(w.reports, "knip.json"))).toBe(true);
  });

  it("exits non-zero when the tools cannot be installed or verified, and never starts a container", () => {
    const w = knipWorld({ ensureOk: false });
    const r = run("scripts/ci/scan-knip.sh", w.env(), "scan-knip");
    expect(r.status).not.toBe(0);
    expect(w.calls().filter((c) => ["run", "create"].includes(c[0]))).toEqual([]);
  });

  it("exits non-zero when the container fails and no report is on stdout", () => {
    const w = knipWorld({ dockerExit: 125, report: false });
    const r = run("scripts/ci/scan-knip.sh", w.env(), "scan-knip");
    expect(r.status).not.toBe(0);
    expect(existsSync(join(w.reports, "knip.json"))).toBe(false);
  });

  it("bounds the wait for a container that floods stdout and then never exits", () => {
    const w = knipWorld({ dockerExit: 0 });
    const started = Date.now();
    const r = spawnSync("bash", [at("scripts/ci/scan-knip.sh")], {
      encoding: "utf8",
      cwd: tmpdir(),
      timeout: 30_000,
      killSignal: "SIGKILL",
      env: { PATH: `${join(w.dir, "bin")}:${process.env.PATH}`, HOME: process.env.HOME ?? tmpdir(), ...w.env({ FAKE_DOCKER_FLOOD: "1", FAKE_DOCKER_HANG: "1" }) },
    });
    // Not a hung wait: the script ended by itself, well inside the fake's 60 s hang, and failed.
    expect(r.error?.code, "scan-knip waited on the container without a bound").not.toBe("ETIMEDOUT");
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(r.status).not.toBe(0);
  });

  describe("the container it builds", () => {
    const secrets = {
      CI_JOB_TOKEN: "job-token-value-1f3a",
      CI_REGISTRY_PASSWORD: "registry-pass-value-77b",
      GITLAB_TOKEN: "gitlab-token-value-9c2",
      SOME_API_KEY: "api-key-value-5d1",
      CI_COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567",
    };
    let world;
    let r;
    let launch;
    beforeAll(() => {
      world = knipWorld({ dockerExit: 1 });
      r = run("scripts/ci/scan-knip.sh", world.env(secrets), "scan-knip");
      launch = world.calls().find((c) => c[0] === "run" || c[0] === "create");
    });

    it("starts a container with docker run or docker create", () => {
      expect(r.status, r.stderr).toBe(0);
      expect(launch).toBeDefined();
    });
    it("has no network, a read-only root, all capabilities dropped and a non-root user", () => {
      expect(launch).toBeDefined();
      expect(flagValue(launch, "--network") ?? flagValue(launch, "--net")).toBe("none");
      expect(launch).toContain("--read-only");
      expect(flagValue(launch, "--cap-drop")).toBe("ALL");
      const user = flagValue(launch, "--user") ?? flagValue(launch, "-u");
      expect(user).toBeTruthy();
      expect(user).not.toMatch(/^(0|root)(:|$)/);
      expect(launch.some((a) => a === "--tmpfs" || a.startsWith("--tmpfs="))).toBe(true);
    });
    it("has only capped tmpfs writable space and no volumes", () => {
      expect(launch).toBeDefined();
      const tmpfs = [];
      const mounts = [];
      launch.forEach((a, i) => {
        if (a === "--tmpfs") tmpfs.push(launch[i + 1]);
        else if (a.startsWith("--tmpfs=")) tmpfs.push(a.slice(8));
        else if (a === "--mount") mounts.push(launch[i + 1]);
        else if (a.startsWith("--mount=")) mounts.push(a.slice(8));
      });
      expect(tmpfs.length + mounts.length).toBeGreaterThan(0);
      for (const t of tmpfs) expect(t, t).toMatch(/(^|[:,])size=\d+[kKmMgG]?\b/);
      for (const m of mounts) {
        expect(m, m).toMatch(/type=tmpfs/);
        expect(m, m).toMatch(/(tmpfs-size|size)=\d+/);
      }
      expect(launch.some((a) => a === "-v" || a === "--volume" || a.startsWith("--volume=") || /^-v./.test(a))).toBe(false);
      expect(launch.some((a) => a === "--volumes-from" || a.startsWith("--volumes-from="))).toBe(false);
      expect(launch.some((a) => /type=(volume|bind)/.test(a))).toBe(false);
    });
    it("keeps nothing knip prints in the daemon's log (--log-driver none)", () => {
      expect(launch).toBeDefined();
      expect(flagValue(launch, "--log-driver")).toBe("none");
    });
    it("is not privileged and has no docker socket", () => {
      expect(launch).toBeDefined();
      expect(launch.some((a) => /^--privileged/.test(a))).toBe(false);
      expect(launch.some((a) => a.includes("docker.sock"))).toBe(false);
      for (const c of world.calls()) expect(c.some((a) => a.includes("docker.sock"))).toBe(false);
    });
    it("passes only PATH, HOME and NODE_OPTIONS as environment, and no CI or secret value", () => {
      expect(launch).toBeDefined();
      const names = [];
      launch.forEach((a, i) => {
        if (a === "-e" || a === "--env") names.push(launch[i + 1]);
        else if (a.startsWith("--env=")) names.push(a.slice(6));
        else if (/^-e./.test(a)) names.push(a.slice(2));
      });
      expect(launch.some((a) => a === "--env-file" || a.startsWith("--env-file="))).toBe(false);
      for (const n of names) expect(n.split("=")[0]).toMatch(/^(PATH|HOME|NODE_OPTIONS)$/);
      const all = world.calls().flat().join("\n");
      for (const v of Object.values(secrets)) expect(all).not.toContain(v);
    });
  });
});

// ------------------------------------------------------------ installs, CI
describe("installs and pipeline", () => {
  const installLine = /\b(pnpm|npm|yarn)\s+(install|i|ci|add)\b/;

  it("every knip-related install uses --ignore-scripts, and the knip scripts install at all", () => {
    const files = ["scripts/ci/ensure-knip.sh", "scripts/ci/scan-knip.sh", "scripts/ci/ensure-jscpd.sh"];
    const installs = files.flatMap((f) => scriptText(f).split("\n").filter((l) => !l.trim().startsWith("#") && installLine.test(l)));
    const ci = existsSync(at(".gitlab-ci.yml")) ? jobBlock("knip_scan").split("\n").filter((l) => installLine.test(l)) : [];
    const all = [...installs, ...ci];
    expect(scriptText("scripts/ci/ensure-knip.sh")).toMatch(installLine);
    for (const line of all) expect(line, line).toContain("--ignore-scripts");
  });

  it("knip_scan extends .dind, is allow_failure, and carries no environment or secret variables", () => {
    const block = jobBlock("knip_scan");
    expect(block).toMatch(/^ {2}extends:\s*\.dind\s*$/m);
    expect(block).toMatch(/^ {2}allow_failure:\s*true\s*$/m);
    expect(block).not.toMatch(/^ {2}environment:/m);
    expect(block).not.toMatch(/\$\{?[A-Z_]*(SECRET|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z_]*\}?/);
    expect(block).not.toMatch(/\$\{?(?!CI_JOB_TOKEN\b)[A-Z_]*TOKEN\b/);
    expect(block).toContain("scan-knip.sh");
    expect(block).toContain(".orbit-code-scan");
  });

  it("code_scanners runs jscpd", () => {
    expect(jobBlock("code_scanners")).toMatch(/for tool in [^;\n]*\bjscpd\b/);
  });
});
