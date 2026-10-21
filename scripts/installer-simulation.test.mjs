import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PTY_TEST_TIMEOUT_MS, ptyWatchdog } from "./pty-deadline.mjs";
import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

// Tests here run scripts/installer-simulation.sh under bash, some through a
// pty; a spawn that takes tens of milliseconds quiet takes seconds on a
// starved core (#698). Budget and reasoning: scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const simulationScript = fileURLToPath(new URL("./installer-simulation.sh", import.meta.url));
const uiScript = fileURLToPath(new URL("./installer-ui.sh", import.meta.url));

const scratchDirs = [];

function scratchDir() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-installer-simulation-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop(), { recursive: true, force: true });
  }
});

function fakeBinDir() {
  // Fails loudly if the simulation ever invokes docker, curl or timeout: the
  // simulation must never reach an external tool.
  //
  // These are tripwires, not fakes of the tools, so they are strictly less
  // permissive than the real thing: every subcommand and every flag is
  // refused, which is the one shape a real tool never has. 99 is chosen
  // deliberately -- docker refuses with 125/1, curl with 2/6/22 and timeout
  // with 124/125/126/127, so a status no real tool produces cannot be read as
  // one of theirs if a caller ever swallowed it (#616).
  const binDir = scratchDir();
  for (const name of ["docker", "curl", "timeout"]) {
    const path = join(binDir, name);
    writeFileSync(path, `#!/usr/bin/env bash\nprintf 'unexpected %s invocation\\n' "${name}" >&2\nexit 99\n`);
    chmodSync(path, 0o755);
  }
  return binDir;
}

function runPlain(args, cwd, envOverrides = {}) {
  return failOnProcessDeadline(spawnSync("bash", [simulationScript, ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: `${fakeBinDir()}:${process.env.PATH}`, TERM: "xterm", ...envOverrides },
    ...processGuard(),
  }), { label: "runPlain" });
}

/*
 * Driving the pty: why runPty holds stdin open.
 *
 * This helper used to pass `input` to spawnSync, which closes stdin as soon
 * as the string is written. Under `script` that closes the pty master, so the
 * widget's next read returns EOF instead of blocking. #512 diagnosed the same
 * defect in installer-ui.test.mjs; this file was never brought across, and it
 * failed intermittently on CI ever since.
 *
 * It matters most where the *absence* of a byte carries meaning.
 * installer_ui_read_key reads the first byte, then does a short second read to
 * tell a lone Escape from an arrow sequence. Its failure path recognises only
 * a timeout (installer-ui.sh:174); a genuine EOF is a read error and leaves
 * through installer_ui_select's status=1 branch rather than the Escape branch
 * that yields 130. Whether the pty tore down before `script` forwarded the
 * byte decided which happened, so the lone-Escape test raced.
 *
 * Holding stdin open for the life of the child makes silence read as idleness
 * rather than end-of-input, which is what a real terminal does. The widget
 * then leaves through its own logic in every case, so no test depends on EOF
 * to terminate. The timeout below is a backstop for a genuine hang, and says
 * so rather than surfacing as a bare null status.
 */
function runPty(cwd, input, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "script",
      ["-qeE", "never", "-c", `bash '${simulationScript}' ${args.join(" ")}`, "/dev/null"],
      {
        cwd,
        env: { PATH: `${fakeBinDir()}:${process.env.PATH}`, TERM: "xterm" },
      },
    );

    let stdout = "";
    child.stdout.setEncoding("utf8");
    const watchdog = ptyWatchdog({ label: "runPty", kill: () => child.kill("SIGKILL") });
    child.stdout.on("data", (chunk) => { stdout += chunk; watchdog.touch(); });
    child.on("error", reject);

    // Written once, then left open: never child.stdin.end().
    child.stdin.on("error", () => { /* child exited first; nothing to write to */ });
    child.stdin.write(input);

    child.on("close", (status) => {
      watchdog.stop();
      if (watchdog.reason) {
        reject(watchdog.error({ stdout }));
        return;
      }
      resolve({ status, stdout });
    });
  });
}

// Plain mode prints `phase=<p> component=<c> state=<s> reason=<r> action=<a> ...`.
// Interactive mode renders the same event as
// `[SIMULATION] [<n>s] <phase> <component> <state> <reason> / <action>`.
// PTY output carries carriage returns and escape sequences, so strip both
// before parsing either shape into {phase, component, state, reason, action}.
const RENDERED_EVENT = /\[SIMULATION\]\s+\[\d+s\]\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+\/\s+(\S+)/u;

function eventLines(stdout) {
  const events = [];
  for (const raw of stdout.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, "").replace(/\r/gu, "").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("phase=")) {
      events.push(Object.fromEntries(
        line.split(/\s+/u).filter((t) => t.includes("=")).map((t) => {
          const i = t.indexOf("=");
          return [t.slice(0, i), t.slice(i + 1)];
        }),
      ));
      continue;
    }
    const m = RENDERED_EVENT.exec(line);
    if (m) {
      events.push({ phase: m[1], component: m[2], state: m[3], reason: m[4], action: m[5] });
    }
  }
  return events;
}

function indexOfEvent(events, match, from = 0) {
  return events.findIndex((e, i) => i >= from && Object.entries(match).every(([k, v]) => e[k] === v));
}

const START_RUNNING = { phase: "preparation", component: "compose", state: "starting", reason: "service-start", action: "start" };
const START_DONE = { phase: "preparation", component: "compose", state: "completed", reason: "service-start", action: "start" };
const ROLLBACK_RUNNING = { phase: "rollback", component: "installer", state: "running", reason: "rollback", action: "rollback" };
const ROLLBACK_DONE = { phase: "rollback", component: "installer", state: "completed", reason: "rollback", action: "rollback" };

function expectStartStepBeforeDatabase(events) {
  const starting = indexOfEvent(events, START_RUNNING);
  expect(starting).toBeGreaterThanOrEqual(0);
  const completed = indexOfEvent(events, START_DONE);
  expect(completed).toBeGreaterThan(starting);
  const validation = events.findIndex((e) => e.phase === "compose" && e.component === "compose" && e.reason === "compose-validation");
  if (validation >= 0) {
    expect(starting).toBeGreaterThan(validation);
  }
  const firstDatabase = events.findIndex((e) => e.phase === "database");
  expect(firstDatabase).toBeGreaterThanOrEqual(0);
  expect(completed).toBeLessThan(firstDatabase);
}

const FAILURE_SCENARIOS = [
  { name: "database-failure", presses: 1, phase: "database", component: "database", reason: "database-auth-migration" },
  { name: "health-timeout", presses: 2, phase: "application", component: "application", reason: "health-timeout" },
  { name: "optional-failure", presses: 3, phase: "optional", component: "clamav", reason: "optional-unavailable" },
];

function failureInput(mode, presses) {
  const first = mode === "update" ? "\x1b[B\r" : "\r";
  return `${first}\rnote\rsecret\r\r${"\x1b[B".repeat(presses)}\r`;
}

describe("scripts/installer-simulation.sh", () => {
  it("rejects unsupported arguments", () => {
    const cwd = scratchDir();
    const result = runPlain(["--unsupported"], cwd);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });

  it("refuses a missing sibling installer-ui.sh", () => {
    const dir = scratchDir();
    const localScript = join(dir, "installer-simulation.sh");
    copyFileSync(simulationScript, localScript);
    chmodSync(localScript, 0o755);

    const result = failOnProcessDeadline(spawnSync("bash", [localScript, "--plain"], {
      encoding: "utf8",
      env: { PATH: `${fakeBinDir()}:${process.env.PATH}`, TERM: "xterm" },
      ...processGuard(),
    }), { label: "refuses a missing sibling installer-ui.sh" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing or unsafe");
  });

  it("refuses a symlinked sibling installer-ui.sh", () => {
    const dir = scratchDir();
    const localScript = join(dir, "installer-simulation.sh");
    copyFileSync(simulationScript, localScript);
    chmodSync(localScript, 0o755);
    symlinkSync(uiScript, join(dir, "installer-ui.sh"));

    const result = failOnProcessDeadline(spawnSync("bash", [localScript, "--plain"], {
      encoding: "utf8",
      env: { PATH: `${fakeBinDir()}:${process.env.PATH}`, TERM: "xterm" },
      ...processGuard(),
    }), { label: "refuses a symlinked sibling installer-ui.sh" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing or unsafe");
  });

  it("refuses a non-regular sibling installer-ui.sh", () => {
    const dir = scratchDir();
    const localScript = join(dir, "installer-simulation.sh");
    copyFileSync(simulationScript, localScript);
    chmodSync(localScript, 0o755);
    mkdirSync(join(dir, "installer-ui.sh"));

    const result = failOnProcessDeadline(spawnSync("bash", [localScript, "--plain"], {
      encoding: "utf8",
      env: { PATH: `${fakeBinDir()}:${process.env.PATH}`, TERM: "xterm" },
      ...processGuard(),
    }), { label: "refuses a non-regular sibling installer-ui.sh" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing or unsafe");
  });

  it("runs a deterministic, ANSI-free plain success scenario with no side effects", () => {
    const cwd = scratchDir();
    const before = readdirSync(cwd);

    const result = runPlain(["--plain"], cwd);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("simulation=true");
    expect(result.stdout).toContain("state=healthy");
    expect(result.stdout).toContain("state=completed");
    expect(result.stdout).toContain("No deployment occurred.");
    expect(result.stdout).not.toMatch(/\x1b\[/u);
    expect(result.stdout).not.toMatch(/sha256:[0-9a-f]{64}/u);
    expect(readdirSync(cwd)).toEqual(before);
  });

  it("runs the same deterministic plain scenario when there is no controlling terminal", () => {
    const cwd = scratchDir();

    const result = runPlain([], cwd);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No deployment occurred.");
  });

  it("cancels with a lone Escape at the top-level menu and restores the terminal", async () => {
    const cwd = scratchDir();
    const before = readdirSync(cwd);

    const result = await runPty(cwd, "\x1b");

    expect(result.status).toBe(130);
    expect(result.stdout).toContain("Simulation: Greetings");
    expect(readdirSync(cwd)).toEqual(before);
  }, PTY_TEST_TIMEOUT_MS);

  it("exits cleanly from the top-level Exit choice", async () => {
    const cwd = scratchDir();

    const result = await runPty(cwd, "\x1b[B\x1b[B\x1b[B\r");

    expect(result.status).toBe(130);
  }, PTY_TEST_TIMEOUT_MS);

  it("keeps Repair presentation-only", async () => {
    const cwd = scratchDir();
    const before = readdirSync(cwd);

    const result = await runPty(cwd, "\x1b[B\x1b[B\r");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("repair_unavailable");
    expect(result.stdout).toContain("No deployment occurred.");
    expect(readdirSync(cwd)).toEqual(before);
  }, PTY_TEST_TIMEOUT_MS);

  it("never echoes or persists the synthetic hidden-input exercise", async () => {
    const cwd = scratchDir();
    const secret = "discard-me-please";
    const before = readdirSync(cwd);

    const result = await runPty(cwd, `\r\rnote-value\r${secret}\r\r\r`);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("note-value");
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).toContain("discarded");
    expect(readdirSync(cwd)).toEqual(before);
  }, PTY_TEST_TIMEOUT_MS);

  it("rejects a hostile bracketed-paste payload during the text exercise without any side effect", async () => {
    const cwd = scratchDir();
    const before = readdirSync(cwd);

    const result = await runPty(cwd, "\r\r\x1b[200~first\r\nsecond\x1b[201~\r");

    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain("first");
    expect(readdirSync(cwd)).toEqual(before);
  }, PTY_TEST_TIMEOUT_MS);

  it("presents every fixed representative failure scenario without a real error", async () => {
    const cwd = scratchDir();
    const scenarios = [
      ["\r\rnote\rsecret\r\r\x1b[B\r", "database-auth-migration"],
      ["\r\rnote\rsecret\r\r\x1b[B\x1b[B\r", "health-timeout"],
      ["\r\rnote\rsecret\r\r\x1b[B\x1b[B\x1b[B\r", "optional-status"],
    ];

    for (const [input, expectedReason] of scenarios) {
      const result = await runPty(cwd, input);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(expectedReason);
      expect(result.stdout).toContain("No deployment occurred.");
    }
  }, PTY_TEST_TIMEOUT_MS);

  it("plain success starts services as its own preparation step before the database", () => {
    const result = runPlain(["--plain"], scratchDir());

    expect(result.status).toBe(0);
    expectStartStepBeforeDatabase(eventLines(result.stdout));
  });

  it("interactive Install success starts services before the database", async () => {
    const result = await runPty(scratchDir(), "\r\rnote\rsecret\r\r\r");

    expect(result.status).toBe(0);
    expectStartStepBeforeDatabase(eventLines(result.stdout));
  }, PTY_TEST_TIMEOUT_MS);

  for (const scenario of FAILURE_SCENARIOS) {
    // Only a stopped required service rolls a fresh Install back (#1456 decision).
    if (scenario.name === "database-failure") it(`rolls back a failed Install (${scenario.name}) before the terminal retry failure`, async () => {
      const result = await runPty(scratchDir(), failureInput("install", scenario.presses));
      const events = eventLines(result.stdout);

      expect(result.status).toBe(0);
      const starting = indexOfEvent(events, START_RUNNING);
      const completed = indexOfEvent(events, START_DONE);
      expect(starting).toBeGreaterThanOrEqual(0);
      expect(completed).toBeGreaterThan(starting);
      const firstDatabase = events.findIndex((e) => e.phase === "database");
      expect(firstDatabase).toBeGreaterThan(completed);

      const running = indexOfEvent(events, ROLLBACK_RUNNING);
      expect(running).toBeGreaterThan(completed);
      const done = indexOfEvent(events, ROLLBACK_DONE);
      expect(done).toBeGreaterThan(running);

      const failedIndex = events.findIndex((e) => e.state === "failed");
      expect(failedIndex).toBeGreaterThan(done);
      expect(failedIndex).toBe(events.length - 1);
      const failed = events[failedIndex];
      expect(failed.phase).toBe(scenario.phase);
      expect(failed.component).toBe(scenario.component);
      expect(failed.reason).toBe(scenario.reason);
      expect(failed.action).toBe("retry");
      expect(result.stdout).toContain("No deployment occurred.");
    }, PTY_TEST_TIMEOUT_MS);

    it(`never rolls back a failed Update (${scenario.name}) and keeps the repair action`, async () => {
      const result = await runPty(scratchDir(), failureInput("update", scenario.presses));
      const events = eventLines(result.stdout);

      expect(result.status).toBe(0);
      expect(events.some((e) => e.phase === "rollback")).toBe(false);
      const failed = events.filter((e) => e.state === "failed");
      expect(failed).toHaveLength(1);
      expect(failed[0].phase).toBe(scenario.phase);
      expect(failed[0].component).toBe(scenario.component);
      expect(failed[0].reason).toBe(scenario.reason);
      expect(failed[0].action).toBe("repair");
      expect(result.stdout).toContain("No deployment occurred.");
    }, PTY_TEST_TIMEOUT_MS);
  }
  // The decided behaviour of a failed readiness wait (#1456, note 40388), as the
  // rehearsal must play it for a fresh Install. The menu's three fixed failure
  // choices (arrow presses 1-3, as above) are the selectors: 1 is a required
  // service that stopped, 2 a required service still starting at the deadline,
  // 3 the optional scanner still starting.
  describe("the decided readiness behaviour (#1456)", () => {
    it("(a) a required service that stopped: rollback events, then a failed event advising retry", async () => {
      const result = await runPty(scratchDir(), failureInput("install", 1));
      const events = eventLines(result.stdout);

      expect(result.status).toBe(0);
      const running = indexOfEvent(events, ROLLBACK_RUNNING);
      const done = indexOfEvent(events, ROLLBACK_DONE);
      expect(running).toBeGreaterThan(-1);
      expect(done).toBeGreaterThan(running);
      const failed = events.filter((e) => e.state === "failed");
      expect(failed).toHaveLength(1);
      expect(events.indexOf(failed[0])).toBeGreaterThan(done);
      expect(failed[0]).toMatchObject({ phase: "database", component: "database", action: "retry" });
    }, PTY_TEST_TIMEOUT_MS);

    it("(b) a required service still starting at the deadline: no rollback events, failed with repair, and says it was left running", async () => {
      const result = await runPty(scratchDir(), failureInput("install", 2));
      const events = eventLines(result.stdout);

      expect(result.status).toBe(0);
      expect(events.some((e) => e.phase === "rollback")).toBe(false);
      const failed = events.filter((e) => e.state === "failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ phase: "application", component: "application", action: "repair" });
      expect(events.at(-1)).toEqual(failed[0]);
      expect(result.stdout).toMatch(/left running/u);
    }, PTY_TEST_TIMEOUT_MS);

    it("(c) the optional scanner still starting: the install completes, the scanner's last event is waiting/optional-status/continue, and a completion line names it", async () => {
      const result = await runPty(scratchDir(), failureInput("install", 3));
      const events = eventLines(result.stdout);

      expect(result.status).toBe(0);
      expect(events.some((e) => e.phase === "rollback")).toBe(false);
      expect(events.some((e) => e.state === "failed")).toBe(false);
      const scanner = events.filter((e) => e.component === "clamav");
      expect(scanner.at(-1)).toMatchObject({ state: "waiting", reason: "optional-status", action: "continue" });
      expect(events.at(-1)).toMatchObject({ phase: "complete", state: "completed" });
      expect(result.stdout).toMatch(/Scanner: still starting/u);
      expect(result.stdout).toContain("No deployment occurred.");
    }, PTY_TEST_TIMEOUT_MS);

    it.each([
      ["a required service that stopped", 1, { phase: "database", component: "database" }],
      ["a required service still starting", 2, { phase: "application", component: "application" }],
    ])("(d) an Update with %s keeps `repair` and never rolls back", async (_name, presses, where) => {
      const result = await runPty(scratchDir(), failureInput("update", presses));
      const events = eventLines(result.stdout);

      expect(result.status).toBe(0);
      expect(events.some((e) => e.phase === "rollback")).toBe(false);
      const failed = events.filter((e) => e.state === "failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ ...where, action: "repair" });
    }, PTY_TEST_TIMEOUT_MS);
  });
});
