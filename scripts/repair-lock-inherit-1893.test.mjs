import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_DEADLINE_MS, PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import { makeFixture, prepareRepair, runRepair, scratchDir } from "./repair-test-harness.mjs";

// #1893 (spec note 63796): only the repair run itself holds the #1849
// one-run-per-folder lock (a read-only descriptor of the folder). No child it
// starts may keep it: a killed run frees the lock at once, even while a child
// lives on (K1, K2); two live runs still refuse the second (K3).
//
// The child is a `docker` call that sleeps: a BASH_ENV hook in the fake docker
// wrapper (the only bash with $S set) turns the first `compose ... up` into
// `sleep`, recording its pid, and lets later calls run as usual.

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const STOPPED = { db: "stopped", app: "stopped" };
const SAFE = ["--execute", "--safe-only"];
const REFUSED = "reason=repair-running";

const started = [];
afterEach(() => {
  // Every child this file starts dies here, whether the test passed or not.
  while (started.length > 0) {
    const { pid, group } = started.pop();
    for (const target of [pid, group ? -group : null]) {
      if (target === null) continue;
      try {
        process.kill(target, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
});

function sleepHook(pidFile) {
  const dir = scratchDir("orbit-lock-inherit-");
  const rc = join(dir, "hook.sh");
  writeFileSync(
    rc,
    `printf() {
  if [[ -n "\${S:-}" && "\${1:-}" == '%s\\n' && "\${2:-}" == compose* && " \${2} " == *" up "* && ! -e '${pidFile}' ]]; then
    builtin printf '%s\\n' "$$" > '${pidFile}'
    exec sleep 120
  fi
  builtin printf "$@"
}
`,
  );
  return { BASH_ENV: rc };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0] !== "Z";
  } catch {
    return false;
  }
};

async function until(check, what) {
  const deadline = Date.now() + PROCESS_DEADLINE_MS;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Starts a --execute run whose docker call sleeps; resolves once the sleeping child exists.
async function startRunWithChild(targetDir) {
  const pidFile = join(scratchDir("orbit-lock-inherit-pid-"), "child.pid");
  const { merged } = prepareRepair(targetDir, { ...STOPPED, env: sleepHook(pidFile) });
  const run = spawn("bash", [join(targetDir, "scripts", "repair.sh"), ...SAFE], { cwd: targetDir, env: merged, stdio: "ignore", detached: true });
  started.push({ pid: run.pid, group: run.pid });
  const exited = new Promise((resolve) => run.once("close", resolve));
  const childPid = await until(() => existsSync(pidFile) && Number(readFileSync(pidFile, "utf8").trim()) > 0 && Number(readFileSync(pidFile, "utf8").trim()), "the sleeping docker child");
  started.push({ pid: childPid, group: null });
  return { run, childPid, exited };
}

const fdTargets = (pid) =>
  readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
    try {
      return [readlinkSync(`/proc/${pid}/fd/${fd}`)];
    } catch {
      return [];
    }
  });

describe("#1893 K2: a killed run frees the folder lock while its child lives on", () => {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    it(`${signal}: a second run started at once is not refused with repair-running`, async () => {
      const targetDir = makeFixture();
      const { run, childPid, exited } = await startRunWithChild(targetDir);
      run.kill(signal);
      await exited;
      expect(alive(childPid), "the docker child should outlive the killed run").toBe(true);
      const second = runRepair(targetDir, SAFE, STOPPED);
      expect(alive(childPid), "the docker child should still be alive when the second run started").toBe(true);
      expect(second.stdout).not.toContain(REFUSED);
      expect(second.stderr).not.toMatch(/another Repair run is working on this folder/iu);
      expect(second.status).not.toBe(6);
    });
  }
});

describe("#1893 K1: a child holds no descriptor of the folder lock", () => {
  it("/proc/<pid>/fd of the running docker child does not link to the deployment folder", async () => {
    const targetDir = makeFixture();
    const { childPid } = await startRunWithChild(targetDir);
    const folder = realpathSync(targetDir);
    const links = fdTargets(childPid);
    expect(links.length, "the child's descriptors could not be read").toBeGreaterThan(0);
    expect(links.filter((link) => link === folder || link === targetDir)).toEqual([]);
  });
});

describe("#1893 K3: pin, two live runs refuse the second", () => {
  it("while the first run is alive, a second is refused with repair-running", async () => {
    const targetDir = makeFixture();
    const { run, childPid } = await startRunWithChild(targetDir);
    expect(alive(run.pid)).toBe(true);
    const second = spawnSync("bash", [join(targetDir, "scripts", "repair.sh"), ...SAFE], {
      cwd: targetDir,
      encoding: "utf8",
      env: prepareRepair(targetDir, STOPPED).merged,
      timeout: PROCESS_DEADLINE_MS,
      killSignal: "SIGKILL",
    });
    expect(alive(childPid)).toBe(true);
    expect(second.stdout).toContain(`execution result=refused done=0 failed=0 ${REFUSED}`);
    expect(second.status).toBe(6);
  });
});
